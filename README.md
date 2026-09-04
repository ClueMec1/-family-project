# Newman Phone Line

A private, family-only "phone" that runs as an installable web app (PWA). Everyone
picks a 10-digit number, and calls are placed browser-to-browser over WebRTC. Firebase
is used only as a directory (so a number can be looked up) and as a signaling
relay (so two browsers can find each other and exchange call data) — the actual
call audio flows directly between devices, not through Firebase.

What's on-device only (never sent to Firebase): your saved contacts, your call
history, and the app's "am I onboarded" state. Those all live in `localStorage`.

## What was built

- `index.html` / `style.css` — your existing design, unchanged except one markup
  fix (`sheet-delete` had a broken `id` with a space in it, which made the button
  unaddressable — fixed).
- `app.js` — **new**. All app logic: onboarding, keypad, contacts, recents,
  profile, and the WebRTC call manager.
- `firebase-config.js` — your existing file, unchanged.
- `manifest.json` — **new**. PWA manifest so the app can be installed / added to
  the home screen.
- `icons/icon-32.png`, `icon-180.png`, `icon-192.png`, `icon-512.png` — generated
  from the icon you uploaded.

## How calling works

1. During onboarding you claim a number by writing `numbers/{number}` in
   Firestore with `{ uid, name, bio, color }`. That's the whole directory.
2. To call someone, the app creates a document in `calls/{callId}` containing a
   WebRTC **offer** and the two numbers involved, then listens on that document.
3. The callee's browser is always listening (while the app is open) for
   documents where `calleeNumber == myNumber && status == "ringing"`. When one
   shows up, it rings.
4. Accepting writes an **answer** back onto the same document. ICE candidates
   (the network-path info WebRTC needs) are exchanged through two subcollections,
   `callerCandidates` and `calleeCandidates`.
5. Once both sides have exchanged an offer/answer and enough candidates, audio
   connects directly, peer-to-peer.
6. Recents are written locally by whichever side notices the call end
   (answered / no-answer / declined / missed).

## Firestore setup you still need to do

1. In the Firebase console for `phone-2f357`, make sure **Firestore Database**
   is created (Native mode) and **Authentication → Anonymous** sign-in is
   enabled — the app signs everyone in anonymously so Firestore rules can tell
   "who" is writing.
2. Paste these into **Firestore → Rules**. They restrict the number directory
   so people can only edit the entry they own, and restrict each call document
   (and its candidates) so only the two numbers involved in that specific call
   can read or write it:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

       function isSignedIn() {
         return request.auth != null;
       }

       function ownsNumber(number) {
         return isSignedIn()
           && exists(/databases/$(database)/documents/numbers/$(number))
           && get(/databases/$(database)/documents/numbers/$(number)).data.uid == request.auth.uid;
       }

       match /numbers/{number} {
         allow read: if isSignedIn();
         allow create: if isSignedIn()
                       && request.resource.data.uid == request.auth.uid
                       && number.matches('^[0-9]{10}$');
         allow update, delete: if isSignedIn() && resource.data.uid == request.auth.uid;
       }

       match /calls/{callId} {
         allow create: if isSignedIn() && ownsNumber(request.resource.data.callerNumber);
         allow read, update: if isSignedIn()
                       && (ownsNumber(resource.data.callerNumber) || ownsNumber(resource.data.calleeNumber));
         allow delete: if isSignedIn() && ownsNumber(resource.data.callerNumber);

         match /callerCandidates/{docId} {
           allow read, create: if isSignedIn() && (
             ownsNumber(get(/databases/$(database)/documents/calls/$(callId)).data.callerNumber) ||
             ownsNumber(get(/databases/$(database)/documents/calls/$(callId)).data.calleeNumber)
           );
         }
         match /calleeCandidates/{docId} {
           allow read, create: if isSignedIn() && (
             ownsNumber(get(/databases/$(database)/documents/calls/$(callId)).data.callerNumber) ||
             ownsNumber(get(/databases/$(database)/documents/calls/$(callId)).data.calleeNumber)
           );
         }
       }
     }
   }
   ```

3. Optional but recommended: add a **TTL policy** (Firestore → TTL) on the
   `calls` collection keyed to the `createdAt` field, so old call documents
   (offers/answers/candidates are meaningless after the call ends) get purged
   automatically instead of accumulating forever. A day or two is plenty.

## Hosting it

Any static host works (Firebase Hosting, Netlify, GitHub Pages, etc.) — it's
plain HTML/CSS/JS, no build step. Serve the whole folder (keeping `icons/`
alongside `index.html`) over **HTTPS** — WebRTC's `getUserMedia` (microphone
access) will not work over plain HTTP except on `localhost`.

## Known limitations worth knowing about

- **No push notifications.** A device only "hears" a ring while the app/tab is
  open — there's no service-worker push wired up, so a phone with the app
  closed in the background won't ring. If you want true background ringing,
  that's a bigger addition (Web Push + a notification permission flow).
- **No TURN server.** Only public STUN servers are configured. Most home/
  cellular networks connect fine peer-to-peer, but some strict corporate or
  carrier NATs can block the direct connection entirely. If family members
  report calls that never connect, adding a TURN server (e.g. via Twilio's
  Network Traversal Service, Cloudflare Calls, or `coturn` on a small VPS) to
  the `ICE_SERVERS` list in `app.js` will fix it.
- **Speaker toggle** uses `HTMLMediaElement.setSinkId`, which Chrome/Edge on
  desktop and Android support but Safari/iOS does not — on iOS the button is
  present but won't actually change the output device.
- **Ringtone on incoming calls** uses the Web Audio API rather than the
  `<audio>` tags in the HTML (those are left in place but unused). Browsers
  block audio from playing before any user interaction with the page, so the
  app "unlocks" audio on the very first tap anywhere in the app.
