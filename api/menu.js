// ─────────────────────────────────────────────
//  FAMILY HOTLINE — Render / Firebase
//  Start command: node api/menu.js
// ─────────────────────────────────────────────

const https  = require('https');
const http   = require('http');
const url    = require('url');

const FB_DB  = 'ai-1-46a29-default-rtdb.firebaseio.com';
const PORT   = process.env.PORT || 3000;

// ── Firebase helpers ──────────────────────────

function fbGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: FB_DB, path: path + '.json', method: 'GET' },
      res => {
        let b = '';
        res.on('data', d => (b += d));
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch (e) { resolve(null); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function fbSet(path, value) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = https.request(
      {
        hostname: FB_DB,
        path: path + '.json',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => { res.on('data', () => {}); res.on('end', resolve); }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fbIncrement(path) {
  return fbGet(path).then(v => fbSet(path, (parseInt(v) || 0) + 1));
}

// ── Parse form body from Telnyx ───────────────

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      try {
        const params = {};
        new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });
        resolve(params);
      } catch (e) { resolve({}); }
    });
  });
}

// ── TeXML menu builder ────────────────────────

function buildMenuTeXML(baseUrl, menuId, menuAudio) {
  const actionUrl = `${baseUrl}?menuId=${menuId}`;
  const greeting  = menuAudio?.greeting
    ? `<Play>${menuAudio.greeting}</Play>`
    : `<Say>Welcome. Please press or say a number to continue. Press 0 at any time to return to the main menu.</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf speech" numDigits="2" timeout="10" speechTimeout="auto" action="${actionUrl}" method="POST">
    ${greeting}
  </Gather>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
}

// ── XML shortcut ──────────────────────────────

function say(text, redirect) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${text}</Say>
  ${redirect ? `<Redirect method="POST">${redirect}</Redirect>` : '<Hangup/>'}
</Response>`;
}

// ── PIN entry prompt builder ───────────────────
// Used for both the whole-hotline entry PIN and locked sub-menu PINs.
function buildPinPrompt(baseUrl, actionTarget, attemptsLeft, promptText) {
  const actionUrl = `${baseUrl}?pinCheck=1&target=${encodeURIComponent(actionTarget)}&attemptsLeft=${attemptsLeft}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="4" timeout="10" action="${actionUrl}" method="POST">
    <Say>${promptText}</Say>
  </Gather>
  <Say>We did not receive any input.</Say>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
}

// ── HTTP Server ───────────────────────────────

const server = http.createServer(async (req, res) => {

  // Health check — lets Render know the service is alive
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200);
    return res.end('Family Hotline is running!');
  }

  // Only handle /menu
  if (!req.url.startsWith('/menu') && !req.url.startsWith('/api/menu')) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const parsed  = url.parse(req.url, true);
  const query   = parsed.query || {};
  const body    = await parseBody(req);
  const params  = { ...query, ...body };

  const menuId  = params.menuId  || 'main';
  const digits  = (params.Digits || params.digits || '').trim();
  const speech  = (params.SpeechResult || params.speech_result || '').trim().toLowerCase();
  const input   = digits || speech;
  const fromNum = params.From || params.from || 'Unknown';

  // Build base URL from the incoming request
  const proto   = req.headers['x-forwarded-proto'] || 'https';
  const host    = req.headers['x-forwarded-host']  || req.headers.host;
  const baseUrl = `${proto}://${host}/menu`;

  res.setHeader('Content-Type', 'text/xml');

  try {
    const hotline  = await fbGet('/hotline');
    const menus    = hotline?.menus    || {};
    const settings = hotline?.settings || {};
    const audio    = hotline?.audio    || {};
    const boards   = hotline?.messageBoards || {};
    const COMING   = settings.comingSoon || 'This option is coming soon. Please try another option.';

    // ──────────────────────────────────────────
    // PIN CHECK HANDLER (shared by entry PIN + locked sub-menus)
    // ──────────────────────────────────────────
    if (params.pinCheck === '1') {
      const target       = params.target || 'main';       // where to go if correct
      const attemptsLeft = parseInt(params.attemptsLeft || '3', 10);
      const enteredPin   = digits;

      // Figure out which PIN we're checking against
      let correctPin = null;
      if (target === 'ENTRY') {
        correctPin = settings.callPin || '';
      } else {
        // target is a locked menu id — find the button that points to it to get its PIN
        const lockedMenu = menus[target];
        correctPin = lockedMenu?._lockPin || null;
        // fallback: search all buttons for one pointing at this menuId with a lockPin
        if (correctPin === null) {
          for (const mId in menus) {
            const btns = menus[mId].buttons || {};
            for (const k in btns) {
              if (btns[k].type === 'lockedmenu' && btns[k].menuId === target) {
                correctPin = btns[k].lockPin;
              }
            }
          }
        }
      }

      if (!enteredPin || enteredPin !== correctPin) {
        const remaining = attemptsLeft - 1;
        if (remaining <= 0) {
          return res.end(say('Incorrect PIN entered too many times. Goodbye.'));
        }
        return res.end(buildPinPrompt(
          baseUrl, target, remaining,
          `Incorrect PIN. You have ${remaining} ${remaining === 1 ? 'try' : 'tries'} left. Please enter the 4 digit PIN.`
        ));
      }

      // Correct PIN — go to the target menu
      const destMenuId = target === 'ENTRY' ? 'main' : target;
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}?menuId=${destMenuId}</Redirect>
</Response>`);
    }

    // ──────────────────────────────────────────
    // WHOLE-HOTLINE ENTRY PIN GATE
    // Fires on the very first hit to /menu (no menuId param at all means fresh call)
    // ──────────────────────────────────────────
    const isFreshCall = !query.menuId && !body.menuId && !input && !params.vm && !params.whisper && !params.pinCheck;
    if (isFreshCall && settings.callPin) {
      fbIncrement('/hotline/analytics/_calls').catch(() => {});
      return res.end(buildPinPrompt(baseUrl, 'ENTRY', 3, 'Welcome. Please enter the 4 digit PIN to continue.'));
    }

    const menu = menus[menuId];

    // Menu not found
    if (!menu) {
      return res.end(say('Sorry, that menu could not be found. Returning to the main menu.', `${baseUrl}?menuId=main`));
    }

    // Track new call (only if no entry PIN was required, since that path tracks above)
    if (!input && menuId === 'main' && !params.vm && !settings.callPin) {
      fbIncrement('/hotline/analytics/_calls').catch(() => {});
    }

    // Whisper callback
    if (params.whisper === '1') {
      const whisperAudio = audio[params.menuId || 'main']?.['whisper_' + params.digit];
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${whisperAudio ? `<Play>${whisperAudio}</Play>` : '<Say>Connecting you now.</Say>'}
</Response>`);
    }

    // ──────────────────────────────────────────
    // PRIVATE VOICEMAIL — save recording (only host hears these)
    // ──────────────────────────────────────────
    const recUrl = params.RecordingUrl || params.recording_url || params.recordingUrl;
    if (params.vm === '1' && recUrl) {
      const id = Date.now().toString();
      const playableUrl = recUrl.includes('telnyx.com') && !recUrl.endsWith('.mp3')
        ? recUrl + '.mp3'
        : recUrl;
      await fbSet('/hotline/voicemails/' + id, {
        id,
        url:      playableUrl,
        duration: params.RecordingDuration || params.recording_duration || '0',
        from:     fromNum,
        date:     new Date().toISOString(),
        heard:    false,
      });
      return res.end(say('Your message has been saved. Thank you for calling.', `${baseUrl}?menuId=main`));
    }

    // ──────────────────────────────────────────
    // MESSAGE BOARD — save a new message (everyone can hear these)
    // ──────────────────────────────────────────
    if (params.boardmsg === '1' && recUrl) {
      const boardId = params.boardId;
      const id = Date.now().toString();
      const playableUrl = recUrl.includes('telnyx.com') && !recUrl.endsWith('.mp3')
        ? recUrl + '.mp3'
        : recUrl;
      await fbSet(`/hotline/messageBoards/${boardId}/${id}`, {
        id,
        url:      playableUrl,
        duration: params.RecordingDuration || params.recording_duration || '0',
        from:     fromNum,
        date:     new Date().toISOString(),
      });
      return res.end(say('Your message has been added to the board. Thank you!', `${baseUrl}?menuId=${params.menuId || 'main'}`));
    }

    // ──────────────────────────────────────────
    // MESSAGE BOARD — play messages with skip controls
    // 2 = skip ahead, 1 = go back, 0 = main menu
    // ──────────────────────────────────────────
    if (params.boardplay === '1') {
      const boardId = params.boardId;
      const boardMsgs = boards[boardId] || {};
      let msgList = Object.values(boardMsgs).sort((a, b) => b.date.localeCompare(a.date)); // newest first

      let idx = parseInt(params.idx || '0', 10);

      // Handle navigation input
      if (digits === '2') idx = idx + 1;        // skip ahead (older)
      else if (digits === '1') idx = Math.max(0, idx - 1); // go back (newer)
      else if (digits === '0') {
        return res.end(say('Returning to the main menu.', `${baseUrl}?menuId=main`));
      }

      if (!msgList.length) {
        return res.end(say('There are no messages on this board yet.', `${baseUrl}?menuId=${params.menuId || 'main'}`));
      }

      if (idx >= msgList.length) {
        return res.end(say('That was the last message.', `${baseUrl}?boardplay=1&boardId=${boardId}&idx=0&menuId=${params.menuId || 'main'}`));
      }

      const msg = msgList[idx];
      const actionUrl = `${baseUrl}?boardplay=1&boardId=${boardId}&idx=${idx}&menuId=${params.menuId || 'main'}`;
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="8" action="${actionUrl}" method="POST">
    <Say>Message ${idx + 1} of ${msgList.length}, from ${msg.from}.</Say>
    <Play>${msg.url}</Play>
    <Say>Press 2 for the next message. Press 1 to go back. Press 0 for the main menu.</Say>
  </Gather>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`);
    }

    // ──────────────────────────────────────────
    // Handle digit/speech input on a normal menu
    // ──────────────────────────────────────────
    if (input) {

      // 0 or * = back to main menu from anywhere
      if (digits === '0' || digits === '*' || speech.includes('main menu') || speech.includes('go back') || speech.includes('zero')) {
        return res.end(say('Returning to the main menu.', `${baseUrl}?menuId=main`));
      }

      // Extract key number
      let key = digits.replace(/[^0-9]/g, '').slice(0, 2);
      if (!key) {
        const m = speech.match(/\b(\d{1,2})\b/);
        if (m) key = m[1];
      }

      if (!key) {
        return res.end(say('Sorry, I did not catch that. Please try again.', `${baseUrl}?menuId=${menuId}`));
      }

      const button = menu.buttons?.[key];

      if (!button) {
        return res.end(say(COMING, `${baseUrl}?menuId=${menuId}`));
      }

      // Track analytics
      fbIncrement(
        '/hotline/analytics/' + menuId + '_btn' + key + '_' +
        (button.label || key).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)
      ).catch(() => {});

      switch (button.type) {

        case 'recording': {
          const rec = audio[menuId]?.['btn_' + key];
          if (rec) {
            return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf speech" numDigits="2" timeout="8" speechTimeout="auto" action="${baseUrl}?menuId=${menuId}" method="POST">
    <Play>${rec}</Play>
    <Say>Press 0 to return to the main menu.</Say>
  </Gather>
  <Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect>
</Response>`);
          }
          return res.end(say(COMING, `${baseUrl}?menuId=${menuId}`));
        }

        case 'submenu': {
          if (button.menuId && menus[button.menuId]) {
            return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}?menuId=${button.menuId}</Redirect>
</Response>`);
          }
          return res.end(say(COMING, `${baseUrl}?menuId=${menuId}`));
        }

        // PIN-protected sub-menu — ask for the PIN before entering
        case 'lockedmenu': {
          if (button.menuId && menus[button.menuId] && button.lockPin) {
            return res.end(buildPinPrompt(
              baseUrl, button.menuId, 3,
              'This menu is protected. Please enter the 4 digit PIN.'
            ));
          }
          return res.end(say(COMING, `${baseUrl}?menuId=${menuId}`));
        }

        case 'forward': {
          if (button.forwardTo) {
            return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold while we connect you.</Say>
  <Dial timeout="30" answerOnBridge="true">
    <Number>${button.forwardTo}</Number>
  </Dial>
</Response>`);
          }
          return res.end(say(COMING, `${baseUrl}?menuId=${menuId}`));
        }

        case 'transfer': {
          if (button.forwardTo) {
            const whisperAudio = audio[menuId]?.['whisper_' + key];
            const whisperUrl   = `${baseUrl}?whisper=1&menuId=${menuId}&digit=${key}`;
            const numberTag    = button.whisper && whisperAudio
              ? `<Number url="${whisperUrl}">${button.forwardTo}</Number>`
              : `<Number>${button.forwardTo}</Number>`;
            return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold while we transfer your call.</Say>
  <Dial timeout="30" answerOnBridge="true">${numberTag}</Dial>
</Response>`);
          }
          return res.end(say(COMING, `${baseUrl}?menuId=${menuId}`));
        }

        // Private voicemail — only the host hears these in the dashboard
        case 'voicemail': {
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please leave your message after the beep. Press pound when you are done.</Say>
  <Record action="${baseUrl}?menuId=${menuId}&amp;vm=1&amp;from=${encodeURIComponent(fromNum)}" method="POST" finishOnKey="#" maxLength="180" playBeep="true"/>
</Response>`);
        }

        // Message board — everyone can leave AND hear messages
        case 'messageboard': {
          const boardId = button.boardId;
          const actionUrl = `${baseUrl}?menuId=${menuId}`;
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="8" action="${actionUrl}&amp;boardChoice=1&amp;boardId=${boardId}" method="POST">
    <Say>To leave a message, press 1. To hear messages, press 2.</Say>
  </Gather>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`);
        }

        case 'announcement': {
          const text = button.text || button.label || COMING;
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf speech" numDigits="2" timeout="8" speechTimeout="auto" action="${baseUrl}?menuId=${menuId}" method="POST">
    <Say>${text}</Say>
    <Say>Press 0 to return to the main menu.</Say>
  </Gather>
  <Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect>
</Response>`);
        }

        case 'datetime': {
          const now = new Date().toLocaleString('en-US', {
            timeZone: settings.timezone || 'America/New_York',
            weekday: 'long', year: 'numeric', month: 'long',
            day: 'numeric', hour: 'numeric', minute: '2-digit',
          });
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf speech" numDigits="2" timeout="8" speechTimeout="auto" action="${baseUrl}?menuId=${menuId}" method="POST">
    <Say>The current date and time is ${now}.</Say>
    <Say>Press 0 to return to the main menu.</Say>
  </Gather>
  <Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect>
</Response>`);
        }

        case 'repeat': {
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect>
</Response>`);
        }

        case 'hangup': {
          const goodbye = audio[menuId]?.['btn_' + key];
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${goodbye ? `<Play>${goodbye}</Play>` : '<Say>Thank you for calling. Goodbye!</Say>'}
  <Hangup/>
</Response>`);
        }

        default:
          return res.end(say(COMING, `${baseUrl}?menuId=${menuId}`));
      }
    }

    // ──────────────────────────────────────────
    // Message board sub-choice handler (1 = leave, 2 = hear)
    // ──────────────────────────────────────────
    if (params.boardChoice === '1') {
      const boardId = params.boardId;
      if (digits === '1') {
        // Leave a message
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please leave your message after the beep. Press pound when you are done.</Say>
  <Record action="${baseUrl}?menuId=${menuId}&amp;boardmsg=1&amp;boardId=${boardId}&amp;from=${encodeURIComponent(fromNum)}" method="POST" finishOnKey="#" maxLength="180" playBeep="true"/>
</Response>`);
      } else if (digits === '2') {
        // Hear messages, newest first, starting at index 0
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}?boardplay=1&amp;boardId=${boardId}&amp;idx=0&amp;menuId=${menuId}</Redirect>
</Response>`);
      }
      return res.end(say('Sorry, I did not catch that.', `${baseUrl}?menuId=${menuId}`));
    }

    // No input — play the menu
    return res.end(buildMenuTeXML(baseUrl, menuId, audio[menuId]));

  } catch (err) {
    console.error('Hotline error:', err);
    return res.end(say('Sorry, there was a technical problem. Please call back in a moment.'));
  }
});

server.listen(PORT, () => {
  console.log(`Family Hotline running on port ${PORT}`);
});
