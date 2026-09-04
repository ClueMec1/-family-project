// Newman Phone Line — app.js
// Everything here is a plain ES module, no build step. Wires up:
//   - onboarding (pick a name/color, claim a 10-digit "Newman number")
//   - contacts, recents, profile (all localStorage — never touches Firebase)
//   - keypad + call screens
//   - WebRTC calling, signaled peer-to-peer via Firestore (see firebase-config.js)

/* ============================================================
   0. Firebase handle
   ============================================================ */
async function getFB() {
  if (window.NPL_FIREBASE) return window.NPL_FIREBASE;
  await new Promise((resolve) => window.addEventListener("npl-firebase-ready", resolve, { once: true }));
  return window.NPL_FIREBASE;
}

/* ============================================================
   1. Small helpers
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function digitsOnly(str) {
  return (str || "").replace(/\D/g, "");
}

function formatNumber(num) {
  const d = digitsOnly(num);
  if (d.length !== 10) return num || "";
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTimer(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

const SWATCHES = ["#C9A227", "#2A6357", "#7A3B2E", "#4A5FA3", "#8A4B8C", "#3D8C6C"];

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

function paintAvatar(el, name, color) {
  el.textContent = initials(name);
  el.style.background = color || SWATCHES[0];
}

function buildSwatchRow(container, selectedColor, onPick) {
  container.innerHTML = "";
  SWATCHES.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (c === selectedColor ? " selected" : "");
    b.style.background = c;
    b.addEventListener("click", () => {
      $$(".swatch", container).forEach((s) => s.classList.remove("selected"));
      b.classList.add("selected");
      onPick(c);
    });
    container.appendChild(b);
  });
}

function showScreen(id) {
  $$(".screen").forEach((s) => s.classList.add("hidden"));
  $(`#${id}`).classList.remove("hidden");
}

/* ============================================================
   2. Local storage (profile / contacts / recents)
   ============================================================ */
const LS_PROFILE = "npl_profile_v1";
const LS_CONTACTS = "npl_contacts_v1";
const LS_RECENTS = "npl_recents_v1";

const Store = {
  getProfile() {
    try { return JSON.parse(localStorage.getItem(LS_PROFILE)); } catch { return null; }
  },
  setProfile(p) { localStorage.setItem(LS_PROFILE, JSON.stringify(p)); },
  clearProfile() { localStorage.removeItem(LS_PROFILE); },

  getContacts() {
    try { return JSON.parse(localStorage.getItem(LS_CONTACTS)) || []; } catch { return []; }
  },
  setContacts(list) { localStorage.setItem(LS_CONTACTS, JSON.stringify(list)); },

  getRecents() {
    try { return JSON.parse(localStorage.getItem(LS_RECENTS)) || []; } catch { return []; }
  },
  setRecents(list) { localStorage.setItem(LS_RECENTS, JSON.stringify(list)); },
  addRecent(entry) {
    const list = Store.getRecents();
    list.unshift({ id: uid(), ts: Date.now(), ...entry });
    Store.setRecents(list.slice(0, 200));
    Recents.render();
  },
};

/* ============================================================
   3. Ring tones (Web Audio, no audio files needed)
   ============================================================ */
const Tone = {
  ctx: null,
  timer: null,
  ensureCtx() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  beep(freq, startTime, duration, peak = 0.07) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(peak, startTime + 0.03);
    gain.gain.setValueAtTime(peak, Math.max(startTime + 0.03, startTime + duration - 0.04));
    gain.gain.linearRampToValueAtTime(0, startTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  },
  startRingback() {
    this.stop();
    const ctx = this.ensureCtx();
    const cycle = () => {
      const t = ctx.currentTime + 0.05;
      this.beep(440, t, 1.8, 0.05);
      this.beep(480, t, 1.8, 0.05);
      this.timer = setTimeout(cycle, 5800);
    };
    cycle();
  },
  startRingtone() {
    this.stop();
    const ctx = this.ensureCtx();
    const cycle = () => {
      const t = ctx.currentTime + 0.05;
      this.beep(659, t, 0.32, 0.09);
      this.beep(880, t + 0.38, 0.32, 0.09);
      this.timer = setTimeout(cycle, 2600);
    };
    cycle();
  },
  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  },
};

// Unlock audio on first tap anywhere, so an incoming ringtone (which has no
// click behind it) is allowed to play by the browser's autoplay policy.
document.addEventListener("pointerdown", () => Tone.ensureCtx(), { once: true, passive: true });

/* ============================================================
   4. App state
   ============================================================ */
const App = {
  profile: null,   // {name, bio, number, color}
  uid: null,
  onboardingColor: SWATCHES[0],
};

/* ============================================================
   5. Onboarding
   ============================================================ */
const Onboarding = {
  color: SWATCHES[0],

  init() {
    buildSwatchRow($("#ob-swatches"), this.color, (c) => (this.color = c));

    $("#ob-start").addEventListener("click", () => this.goto("name"));

    $$("[data-back]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const steps = ["welcome", "name", "number", "review"];
        const current = $(".ob-step:not(.hidden)").dataset.step;
        const idx = steps.indexOf(current);
        if (idx > 0) this.goto(steps[idx - 1]);
      });
    });

    $("#ob-name-next").addEventListener("click", () => {
      const name = $("#ob-name").value.trim();
      if (!name) { $("#ob-name").classList.add("invalid"); toast("Add your name to continue", true); return; }
      $("#ob-name").classList.remove("invalid");
      this.goto("number");
      $("#ob-number").focus();
    });

    $("#ob-number").addEventListener("input", (e) => {
      const d = digitsOnly(e.target.value).slice(0, 10);
      e.target.value = formatNumber(d);
      $("#ob-number-hint").textContent = "\u00a0";
      $("#ob-number-hint").classList.remove("error");
    });

    $("#ob-number-next").addEventListener("click", () => this.claimNumber());
    $("#ob-finish").addEventListener("click", () => this.finish());
  },

  goto(step) {
    $$(".ob-step").forEach((s) => s.classList.add("hidden"));
    $(`.ob-step[data-step="${step}"]`).classList.remove("hidden");
  },

  async claimNumber() {
    const number = digitsOnly($("#ob-number").value);
    const hint = $("#ob-number-hint");
    if (number.length !== 10) {
      hint.textContent = "Enter all 10 digits.";
      hint.classList.add("error");
      return;
    }
    const btn = $("#ob-number-next");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const { db, doc, getDoc } = await getFB();
      const snap = await getDoc(doc(db, "numbers", number));
      if (snap.exists() && snap.data().uid !== App.uid) {
        hint.textContent = "That number is already taken — try another.";
        hint.classList.add("error");
        return;
      }
      const name = $("#ob-name").value.trim();
      const bio = $("#ob-bio").value.trim();
      App.profile = { name, bio, number, color: this.color };
      const card = $("#ob-review-card");
      card.innerHTML = "";
      const av = document.createElement("div");
      av.className = "avatar avatar-sm";
      paintAvatar(av, name, this.color);
      const text = document.createElement("div");
      text.className = "review-text";
      text.innerHTML = `<span class="review-name"></span><span class="review-bio"></span><span class="review-number"></span>`;
      text.querySelector(".review-name").textContent = name;
      text.querySelector(".review-bio").textContent = bio || "";
      text.querySelector(".review-number").textContent = formatNumber(number);
      card.appendChild(av);
      card.appendChild(text);
      this.goto("review");
    } catch (err) {
      console.error(err);
      hint.textContent = "Couldn't check that number — check your connection.";
      hint.classList.add("error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Claim this number";
    }
  },

  async finish() {
    const btn = $("#ob-finish");
    btn.disabled = true;
    btn.textContent = "Setting up…";
    try {
      const { db, doc, setDoc, serverTimestamp } = await getFB();
      const { name, bio, number, color } = App.profile;
      await setDoc(doc(db, "numbers", number), {
        uid: App.uid,
        name, bio: bio || "", color,
        updatedAt: serverTimestamp(),
      });
      Store.setProfile(App.profile);
      Main.boot();
    } catch (err) {
      console.error(err);
      toast("Couldn't finish setup — check your connection and try again.", true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Enter Newman Phone Line";
    }
  },
};

/* ============================================================
   6. Main app shell — tabs
   ============================================================ */
const Tabs = {
  init() {
    $$(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.activate(btn.dataset.tab));
    });
  },
  activate(name) {
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  },
};

/* ============================================================
   7. Keypad
   ============================================================ */
const Keypad = {
  value: "",
  init() {
    $$(".key").forEach((key) => {
      key.addEventListener("click", () => {
        const k = key.dataset.key;
        if (k === "back") {
          this.value = this.value.slice(0, -1);
        } else if (k === "add") {
          if (this.value) { ContactSheet.openNew(this.value); }
          return;
        } else {
          if (this.value.length < 10) this.value += k;
        }
        this.render();
      });
    });
    $("#dial-call-btn").addEventListener("click", () => {
      if (this.value.length === 10) CallManager.startCall(this.value);
    });
    this.render();
  },
  setValue(v) {
    this.value = digitsOnly(v).slice(0, 10);
    this.render();
    Tabs.activate("keypad");
  },
  render() {
    $("#dial-entry").value = this.value ? formatNumber(this.value) : "";
    $("#dial-call-btn").disabled = this.value.length !== 10;
  },
};

/* ============================================================
   8. Contacts
   ============================================================ */
const Contacts = {
  editingId: null,

  init() {
    $("#add-contact-btn").addEventListener("click", () => ContactSheet.openNew());
    $("#contact-search").addEventListener("input", () => this.render());
    this.render();
  },

  render() {
    const list = Store.getContacts().sort((a, b) => a.name.localeCompare(b.name));
    const q = $("#contact-search").value.trim().toLowerCase();
    const filtered = q
      ? list.filter((c) => c.name.toLowerCase().includes(q) || digitsOnly(c.number).includes(digitsOnly(q)))
      : list;

    const container = $("#contact-list");
    container.innerHTML = "";
    $("#contact-empty").classList.toggle("hidden", list.length !== 0);

    if (list.length && filtered.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-sub";
      p.style.textAlign = "center";
      p.style.padding = "24px";
      p.textContent = "No matches.";
      container.appendChild(p);
      return;
    }

    filtered.forEach((c) => container.appendChild(this.row(c)));
  },

  row(c) {
    const row = document.createElement("div");
    row.className = "list-row";

    const av = document.createElement("div");
    av.className = "avatar avatar-sm";
    paintAvatar(av, c.name, c.color || SWATCHES[0]);

    const text = document.createElement("div");
    text.className = "row-text";
    text.innerHTML = `<div class="row-name"></div><div class="row-sub"></div>`;
    text.querySelector(".row-name").textContent = c.name;
    text.querySelector(".row-sub").textContent = formatNumber(c.number);

    const callBtn = document.createElement("button");
    callBtn.className = "row-call";
    callBtn.setAttribute("aria-label", `Call ${c.name}`);
    callBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.3 1L6.6 10.8z"/></svg>`;
    callBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      CallManager.startCall(c.number, c.name);
    });

    row.appendChild(av);
    row.appendChild(text);
    row.appendChild(callBtn);
    row.addEventListener("click", () => ContactSheet.openEdit(c));
    return row;
  },

  save(contact) {
    const list = Store.getContacts();
    const idx = list.findIndex((c) => c.id === contact.id);
    if (idx >= 0) list[idx] = contact; else list.push(contact);
    Store.setContacts(list);
    this.render();
  },

  remove(id) {
    Store.setContacts(Store.getContacts().filter((c) => c.id !== id));
    this.render();
  },

  findByNumber(number) {
    return Store.getContacts().find((c) => c.number === digitsOnly(number));
  },
};

const ContactSheet = {
  editingId: null,

  init() {
    $("#sheet-cancel").addEventListener("click", () => this.close());
    $("#contact-sheet-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "contact-sheet-backdrop") this.close();
    });
    $("#sheet-contact-number").addEventListener("input", (e) => {
      e.target.value = formatNumber(digitsOnly(e.target.value).slice(0, 10));
      $("#sheet-hint").textContent = "\u00a0";
    });
    $("#sheet-save").addEventListener("click", () => this.save());
    $("#sheet-delete").addEventListener("click", () => this.remove());
  },

  openNew(prefillNumber = "") {
    this.editingId = null;
    $("#sheet-title").textContent = "Add family member";
    $("#sheet-contact-name").value = "";
    $("#sheet-contact-number").value = prefillNumber ? formatNumber(prefillNumber) : "";
    $("#sheet-hint").textContent = "\u00a0";
    $("#sheet-delete").classList.add("hidden");
    this.open();
  },

  openEdit(contact) {
    this.editingId = contact.id;
    $("#sheet-title").textContent = "Edit family member";
    $("#sheet-contact-name").value = contact.name;
    $("#sheet-contact-number").value = formatNumber(contact.number);
    $("#sheet-hint").textContent = "\u00a0";
    $("#sheet-delete").classList.remove("hidden");
    this.open();
  },

  open() { $("#contact-sheet-backdrop").classList.remove("hidden"); },
  close() { $("#contact-sheet-backdrop").classList.add("hidden"); },

  save() {
    const name = $("#sheet-contact-name").value.trim();
    const number = digitsOnly($("#sheet-contact-number").value);
    const hint = $("#sheet-hint");
    if (!name) { hint.textContent = "Give them a name."; return; }
    if (number.length !== 10) { hint.textContent = "Enter all 10 digits."; return; }
    if (number === App.profile?.number) { hint.textContent = "That's your own number."; return; }
    Contacts.save({
      id: this.editingId || uid(),
      name, number,
      color: SWATCHES[(name.charCodeAt(0) || 0) % SWATCHES.length],
    });
    this.close();
  },

  remove() {
    if (this.editingId) Contacts.remove(this.editingId);
    this.close();
  },
};

/* ============================================================
   9. Recents
   ============================================================ */
const Recents = {
  init() {
    $("#clear-recents-btn").addEventListener("click", () => {
      Store.setRecents([]);
      this.render();
    });
    this.render();
  },

  render() {
    const list = Store.getRecents();
    const container = $("#recents-list");
    container.innerHTML = "";
    $("#recents-empty").classList.toggle("hidden", list.length !== 0);
    list.forEach((r) => container.appendChild(this.row(r)));
  },

  row(r) {
    const row = document.createElement("div");
    row.className = "list-row";

    const av = document.createElement("div");
    av.className = "avatar avatar-sm";
    paintAvatar(av, r.name || formatNumber(r.number), r.color || SWATCHES[0]);

    const arrow = r.direction === "outgoing" ? "↗" : "↙";
    const label =
      r.status === "missed" ? "Missed" :
      r.status === "declined" ? "Declined" :
      r.status === "no-answer" ? "No answer" :
      r.direction === "outgoing" ? "Outgoing" : "Incoming";

    const text = document.createElement("div");
    text.className = "row-text";
    text.innerHTML = `<div class="row-name"></div><div class="row-sub"></div>`;
    text.querySelector(".row-name").textContent = r.name || formatNumber(r.number);
    const sub = text.querySelector(".row-sub");
    sub.textContent = `${arrow} ${label} · ${timeAgo(r.ts)}`;
    if (r.status === "missed" || r.status === "declined") sub.classList.add("missed");

    const callBtn = document.createElement("button");
    callBtn.className = "row-call";
    callBtn.setAttribute("aria-label", `Call ${r.name || formatNumber(r.number)}`);
    callBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.3 1L6.6 10.8z"/></svg>`;
    callBtn.addEventListener("click", () => CallManager.startCall(r.number, r.name));

    row.appendChild(av);
    row.appendChild(text);
    row.appendChild(callBtn);
    row.addEventListener("click", () => CallManager.startCall(r.number, r.name));
    return row;
  },
};

/* ============================================================
   10. Profile tab
   ============================================================ */
const Profile = {
  color: SWATCHES[0],

  init() {
    $("#profile-save").addEventListener("click", () => this.save());
    $("#leave-family-btn").addEventListener("click", () => this.leave());
  },

  render() {
    const p = App.profile;
    $("#me-name").textContent = p.name;
    $("#me-number").textContent = formatNumber(p.number);
    $("#profile-number").textContent = formatNumber(p.number);
    $("#profile-name").value = p.name;
    $("#profile-bio").value = p.bio || "";
    this.color = p.color || SWATCHES[0];
    paintAvatar($("#profile-avatar"), p.name, this.color);
    buildSwatchRow($("#profile-swatches"), this.color, (c) => {
      this.color = c;
      paintAvatar($("#profile-avatar"), $("#profile-name").value.trim() || p.name, c);
    });
    $("#profile-name").oninput = () => paintAvatar($("#profile-avatar"), $("#profile-name").value.trim() || p.name, this.color);
  },

  async save() {
    const name = $("#profile-name").value.trim();
    const bio = $("#profile-bio").value.trim();
    if (!name) { toast("Add a name first", true); return; }
    const btn = $("#profile-save");
    btn.disabled = true;
    try {
      const { db, doc, updateDoc, serverTimestamp } = await getFB();
      await updateDoc(doc(db, "numbers", App.profile.number), {
        name, bio, color: this.color, updatedAt: serverTimestamp(),
      });
      App.profile = { ...App.profile, name, bio, color: this.color };
      Store.setProfile(App.profile);
      this.render();
      $("#profile-saved").classList.remove("hidden");
      setTimeout(() => $("#profile-saved").classList.add("hidden"), 2000);
    } catch (err) {
      console.error(err);
      toast("Couldn't save — check your connection.", true);
    } finally {
      btn.disabled = false;
    }
  },

  async leave() {
    if (!confirm("Release your number and start over? This can't be undone.")) return;
    try {
      const { db, doc, deleteDoc } = await getFB();
      await deleteDoc(doc(db, "numbers", App.profile.number));
    } catch (err) {
      console.error(err);
    }
    Store.clearProfile();
    location.reload();
  },
};

/* ============================================================
   11. WebRTC call manager (Firestore-signaled)
   ============================================================ */
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
const RING_TIMEOUT_MS = 30000;

const CallManager = {
  pc: null,
  localStream: null,
  remoteAudio: null,
  callId: null,
  role: null, // 'caller' | 'callee'
  peer: { name: "", number: "", bio: "", color: SWATCHES[0] },
  unsubs: [],
  timerInterval: null,
  timerStart: null,
  ringTimeout: null,
  muted: false,
  speaker: false,
  incomingUnsub: null,
  busy: false,

  init() {
    this.remoteAudio = document.createElement("audio");
    this.remoteAudio.autoplay = true;
    this.remoteAudio.setAttribute("playsinline", "true");
    document.body.appendChild(this.remoteAudio);

    $("#accept-btn").addEventListener("click", () => this.accept());
    $("#decline-btn").addEventListener("click", () => this.decline());
    $("#end-call-btn").addEventListener("click", () => this.hangup("ended"));
    $("#mute-btn").addEventListener("click", () => this.toggleMute());
    $("#speaker-btn").addEventListener("click", () => this.toggleSpeaker());
  },

  cleanupSubs() {
    this.unsubs.forEach((fn) => { try { fn(); } catch {} });
    this.unsubs = [];
  },

  async listenForIncomingCalls() {
    const { db, collection, query, where, onSnapshot } = await getFB();
    const q = query(
      collection(db, "calls"),
      where("calleeNumber", "==", App.profile.number),
      where("status", "==", "ringing")
    );
    this.incomingUnsub = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== "added") return;
        this.handleIncoming(change.doc.id, change.doc.data());
      });
    }, (err) => console.error("incoming listener error", err));
  },

  async handleIncoming(callId, data) {
    if (this.busy || this.callId) {
      // Already on a call — auto-decline as busy.
      try {
        const { db, doc, updateDoc } = await getFB();
        await updateDoc(doc(db, "calls", callId), { status: "declined" });
      } catch {}
      return;
    }
    this.busy = true;
    this.callId = callId;
    this.role = "callee";
    this.peer = {
      name: data.callerName || "",
      number: data.callerNumber || "",
      bio: data.callerBio || "",
      color: data.callerColor || SWATCHES[0],
    };
    this.pendingOffer = data.offer;

    paintAvatar($("#incoming-avatar"), this.peer.name || formatNumber(this.peer.number), this.peer.color);
    $("#incoming-avatar").classList.add("pulsing");
    $("#incoming-name").textContent = this.peer.name || formatNumber(this.peer.number);
    $("#incoming-number").textContent = this.peer.name ? formatNumber(this.peer.number) : (this.peer.bio || "");
    showScreen("screen-incoming");
    Tone.startRingtone();

    // Watch the call doc so we notice if the caller hangs up before we answer.
    const { db, doc, onSnapshot } = await getFB();
    const unsub = onSnapshot(doc(db, "calls", callId), (snap) => {
      const d = snap.data();
      if (!d || d.status === "ended") {
        if (this.callId === callId && this.role === "callee" && !this.pc) {
          this.resetLocalState();
          Tone.stop();
          showScreen("screen-main");
          Store.addRecent({ direction: "incoming", number: this.peer.number, name: this.peer.name, status: "missed" });
        }
      }
    });
    this.unsubs.push(unsub);
  },

  async accept() {
    const callId = this.callId;
    Tone.stop();
    $("#incoming-avatar").classList.remove("pulsing");

    try {
      let offer = this.pendingOffer;
      const { db, doc, getDoc, updateDoc, collection, addDoc, onSnapshot } = await getFB();

      // Defensive: if the offer somehow wasn't attached yet, re-fetch the call
      // doc once before giving up, instead of failing silently.
      if (!offer || !offer.sdp) {
        const fresh = await getDoc(doc(db, "calls", callId));
        offer = fresh.exists() ? fresh.data().offer : null;
      }
      if (!offer || !offer.sdp) {
        throw new Error("No offer found on the call yet — the caller's connection may have dropped.");
      }

      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        toast("Microphone access is needed to answer.", true);
        this.decline();
        return;
      }

      this.pc = this.buildPeerConnection(callId, "calleeCandidates");
      this.pc._flushCandidates(); // the parent call doc already exists at this point
      this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream));

      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      await updateDoc(doc(db, "calls", callId), {
        answer: { type: answer.type, sdp: answer.sdp },
        status: "active",
      });

      const candUnsub = onSnapshot(collection(db, "calls", callId, "callerCandidates"), (snap) => {
        snap.docChanges().forEach((ch) => {
          if (ch.type === "added") this.pc.addIceCandidate(new RTCIceCandidate(ch.doc.data())).catch(() => {});
        });
      });
      this.unsubs.push(candUnsub);

      const docUnsub = onSnapshot(doc(db, "calls", callId), (snap) => {
        const d = snap.data();
        if (!d || d.status === "ended") this.hangup("ended-remote", false);
      });
      this.unsubs.push(docUnsub);

      this.showInCall("connected");
      this.startTimer();
    } catch (err) {
      console.error("accept() failed:", err);
      toast("Couldn't connect that call — please try again.", true);
      this.endCall();
    }
  },

  async decline() {
    Tone.stop();
    $("#incoming-avatar").classList.remove("pulsing");
    const callId = this.callId;
    try {
      const { db, doc, updateDoc } = await getFB();
      await updateDoc(doc(db, "calls", callId), { status: "declined" });
    } catch (err) { console.error(err); }
    Store.addRecent({ direction: "incoming", number: this.peer.number, name: this.peer.name, status: "declined" });
    this.resetLocalState();
    showScreen("screen-main");
  },

  async startCall(number, knownName) {
    if (this.callId) { toast("You're already on a call."); return; }
    number = digitsOnly(number);
    if (number.length !== 10) return;
    if (number === App.profile.number) { toast("That's your own number."); return; }

    // Establish the ring-back tone's AudioContext synchronously in this click
    // handler so mobile browsers allow it to play a moment later.
    Tone.ensureCtx();

    this.busy = true;
    this.role = "caller";

    const local = Contacts.findByNumber(number);
    this.peer = { name: knownName || local?.name || "", number, bio: "", color: local?.color || SWATCHES[0] };

    this.showInCall("calling…");
    showScreen("screen-incall");

    try {
      const { db, doc, getDoc, collection, setDoc, onSnapshot, serverTimestamp } = await getFB();

      // Look up the callee's registered name/color for a nicer display, if available.
      try {
        const snap = await getDoc(doc(db, "numbers", number));
        if (snap.exists()) {
          const d = snap.data();
          this.peer = { name: this.peer.name || d.name, number, bio: d.bio || "", color: d.color || this.peer.color };
          this.showInCall("calling…");
        }
      } catch {}

      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        toast("Microphone access is needed to place a call.", true);
        this.resetLocalState();
        showScreen("screen-main");
        return;
      }

      // Pre-generate the call document's ID (without writing anything yet) so
      // ICE candidates can be queued against it while we build the offer.
      const callDocRef = doc(collection(db, "calls"));
      this.callId = callDocRef.id;

      this.pc = this.buildPeerConnection(this.callId, "callerCandidates");
      this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream));

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Only now — with the offer already in hand — does the call document get
      // created, so the callee never sees a "ringing" call with no offer on it.
      await setDoc(callDocRef, {
        callerNumber: App.profile.number,
        callerName: App.profile.name,
        callerBio: App.profile.bio || "",
        callerColor: App.profile.color,
        calleeNumber: number,
        offer: { type: offer.type, sdp: offer.sdp },
        answer: null,
        status: "ringing",
        createdAt: serverTimestamp(),
      });
      this.pc._flushCandidates();

      Tone.startRingback();

      const candUnsub = onSnapshot(collection(db, "calls", this.callId, "calleeCandidates"), (snap) => {
        snap.docChanges().forEach((ch) => {
          if (ch.type === "added") this.pc.addIceCandidate(new RTCIceCandidate(ch.doc.data())).catch(() => {});
        });
      });
      this.unsubs.push(candUnsub);

      const docUnsub = onSnapshot(doc(db, "calls", this.callId), (snap) => {
        const d = snap.data();
        if (!d) return;
        if (d.status === "active" && d.answer && this.pc && !this.pc.currentRemoteDescription) {
          this.pc.setRemoteDescription(new RTCSessionDescription(d.answer));
          Tone.stop();
          clearTimeout(this.ringTimeout);
          this.showInCall("connected");
          this.startTimer();
        } else if (d.status === "declined") {
          Tone.stop();
          clearTimeout(this.ringTimeout);
          Store.addRecent({ direction: "outgoing", number, name: this.peer.name, status: "declined" });
          this.endCall();
        } else if (d.status === "ended") {
          this.hangup("ended-remote", false);
        }
      });
      this.unsubs.push(docUnsub);

      this.ringTimeout = setTimeout(async () => {
        if (this.callId && this.role === "caller" && !this.timerInterval) {
          try {
            const { updateDoc: upd } = await getFB();
            await upd(doc(db, "calls", this.callId), { status: "missed" });
          } catch {}
          Tone.stop();
          Store.addRecent({ direction: "outgoing", number, name: this.peer.name, status: "no-answer" });
          this.endCall();
        }
      }, RING_TIMEOUT_MS);
    } catch (err) {
      console.error(err);
      toast("Couldn't place the call — check your connection.", true);
      this.resetLocalState();
      showScreen("screen-main");
    }
  },

  buildPeerConnection(callId, candidateCollectionName) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const pending = [];
    let ready = false;

    const writeCandidate = async (json) => {
      try {
        const { db, collection, addDoc } = await getFB();
        await addDoc(collection(db, "calls", callId, candidateCollectionName), json);
      } catch (err) { console.error("candidate write failed:", err); }
    };

    // The call doc may not exist yet when the very first candidates arrive
    // (ICE gathering starts as soon as setLocalDescription runs, which can be
    // before the Firestore write finishes). Queue candidates until told the
    // parent document is safely written, then flush them in order.
    pc._flushCandidates = () => {
      ready = true;
      while (pending.length) writeCandidate(pending.shift());
    };

    pc.ontrack = (event) => {
      this.remoteAudio.srcObject = event.streams[0];
      this.remoteAudio.play().catch(() => {});
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const json = event.candidate.toJSON();
      if (ready) writeCandidate(json); else pending.push(json);
    };
    return pc;
  },

  showInCall(status) {
    paintAvatar($("#incall-avatar"), this.peer.name || formatNumber(this.peer.number), this.peer.color);
    $("#incall-name").textContent = this.peer.name || formatNumber(this.peer.number);
    $("#incall-number").textContent = this.peer.name ? formatNumber(this.peer.number) : (this.peer.bio || "");
    $("#incall-status").textContent = status;
    $("#call-timer").classList.toggle("hidden", status !== "connected");
    $("#mute-btn").classList.toggle("on", this.muted);
    $("#speaker-btn").classList.toggle("on", this.speaker);
    showScreen("screen-incall");
  },

  startTimer() {
    $("#incall-status").textContent = "connected";
    $("#call-timer").classList.remove("hidden");
    this.timerStart = Date.now();
    clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      $("#call-timer").textContent = fmtTimer((Date.now() - this.timerStart) / 1000);
    }, 500);
  },

  toggleMute() {
    if (!this.localStream) return;
    this.muted = !this.muted;
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    $("#mute-btn").classList.toggle("on", this.muted);
  },

  async toggleSpeaker() {
    this.speaker = !this.speaker;
    $("#speaker-btn").classList.toggle("on", this.speaker);
    if (typeof this.remoteAudio.setSinkId === "function") {
      try { await this.remoteAudio.setSinkId(this.speaker ? "default" : ""); } catch {}
    }
  },

  async hangup(reason, notifyRemote = true) {
    const wasConnected = !!this.timerInterval;
    const callId = this.callId;
    const role = this.role;
    const peer = this.peer;

    if (notifyRemote && callId) {
      try {
        const { db, doc, updateDoc } = await getFB();
        await updateDoc(doc(db, "calls", callId), { status: "ended" });
      } catch (err) { console.error(err); }
    }

    if (wasConnected && callId) {
      Store.addRecent({
        direction: role === "caller" ? "outgoing" : "incoming",
        number: peer.number, name: peer.name, status: "answered",
      });
    }

    this.endCall();
  },

  endCall() {
    Tone.stop();
    clearTimeout(this.ringTimeout);
    clearInterval(this.timerInterval);
    this.timerInterval = null;
    this.cleanupSubs();
    if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
    if (this.localStream) { this.localStream.getTracks().forEach((t) => t.stop()); this.localStream = null; }
    this.remoteAudio.srcObject = null;
    this.resetLocalState();
    showScreen("screen-main");
  },

  resetLocalState() {
    this.callId = null;
    this.role = null;
    this.busy = false;
    this.muted = false;
    this.speaker = false;
    this.pendingOffer = null;
  },
};

/* ============================================================
   12. Boot
   ============================================================ */
const Main = {
  boot() {
    App.profile = Store.getProfile();
    Profile.render();
    Contacts.render();
    Recents.render();
    Keypad.render();
    showScreen("screen-main");
    Tabs.activate("keypad");
    CallManager.listenForIncomingCalls();
  },
};

async function start() {
  Onboarding.init();
  Tabs.init();
  Keypad.init();
  Contacts.init();
  ContactSheet.init();
  Recents.init();
  Profile.init();
  CallManager.init();

  const { ensureSignedIn } = await getFB();
  const user = await ensureSignedIn();
  App.uid = user.uid;

  const saved = Store.getProfile();
  if (saved && saved.number) {
    App.profile = saved;
    Main.boot();
  } else {
    showScreen("screen-onboarding");
  }
}

start();
