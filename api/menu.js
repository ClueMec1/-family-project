// ─────────────────────────────────────────────
//  FAMILY HOTLINE — Telnyx / Vercel Function
// ─────────────────────────────────────────────

const https = require('https');
const FB_DB = 'ai-1-46a29-default-rtdb.firebaseio.com';

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

// ── Parse request body from Telnyx (form-encoded) ──

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      try {
        const params = {};
        new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });
        resolve(params);
      } catch (e) {
        resolve({});
      }
    });
  });
}

// ── TeXML menu builder ────────────────────────

function buildMenuTeXML(baseUrl, menuId, menuAudio) {
  const actionUrl = `${baseUrl}?menuId=${menuId}`;
  const greeting = menuAudio?.greeting
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

// ── Main handler ──────────────────────────────

module.exports = async function handler(req, res) {
  // Parse body manually — Vercel doesn't auto-parse form data
  const params  = await parseBody(req);
  const query   = req.query || {};

  const menuId  = params.menuId  || query.menuId  || 'main';
  const digits  = (params.Digits || params.digits || '').trim();
  const speech  = (params.SpeechResult || params.speech_result || '').trim().toLowerCase();
  const input   = digits || speech;
  const fromNum = params.From || params.from || 'Unknown';
  const baseUrl = `https://${req.headers.host}/api/menu`;

  res.setHeader('Content-Type', 'text/xml');

  try {
    const hotline  = await fbGet('/hotline');
    const menus    = hotline?.menus    || {};
    const settings = hotline?.settings || {};
    const audio    = hotline?.audio    || {};
    const menu     = menus[menuId];
    const COMING   = settings.comingSoon || 'This option is coming soon. Please try another option.';

    // ── Menu not found ──
    if (!menu) {
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, that menu could not be found. Returning to the main menu.</Say>
  <Redirect method="POST">${baseUrl}?menuId=main</Redirect>
</Response>`);
    }

    // ── Track new call ──
    if (!input && menuId === 'main' && !params.vm) {
      fbIncrement('/hotline/analytics/_calls').catch(() => {});
    }

    // ── Whisper callback ──
    if (params.whisper === '1' || query.whisper === '1') {
      const digit = params.digit || query.digit;
      const mid   = params.menuId || query.menuId || 'main';
      const whisperAudio = audio[mid]?.['whisper_' + digit];
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${whisperAudio ? `<Play>${whisperAudio}</Play>` : '<Say>Connecting you now.</Say>'}
</Response>`);
    }

    // ── Save voicemail ──
    const isVm = params.vm === '1' || query.vm === '1';
    if (isVm && (params.RecordingUrl || params.recording_url)) {
      const recUrl = params.RecordingUrl || params.recording_url;
      const id = Date.now().toString();
      await fbSet('/hotline/voicemails/' + id, {
        id,
        url:      recUrl,
        duration: params.RecordingDuration || params.recording_duration || '0',
        from:     fromNum,
        date:     new Date().toISOString(),
        heard:    false,
      });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Your message has been saved. Thank you for calling.</Say>
  <Redirect method="POST">${baseUrl}?menuId=main</Redirect>
</Response>`);
    }

    // ── Handle input ──
    if (input) {

      // 0 = back to main menu from anywhere
      if (digits === '0' || speech.includes('main menu') || speech.includes('go back') || speech.includes('zero')) {
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Returning to the main menu.</Say>
  <Redirect method="POST">${baseUrl}?menuId=main</Redirect>
</Response>`);
      }

      // Extract key
      let key = digits.replace(/[^0-9]/g, '').slice(0, 2);
      if (!key) {
        const m = speech.match(/\b(\d{1,2})\b/);
        if (m) key = m[1];
      }

      if (!key) {
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, I did not catch that. Please try again.</Say>
  <Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect>
</Response>`);
      }

      const button = menu.buttons?.[key];

      if (!button) {
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${COMING}</Say>
  <Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect>
</Response>`);
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
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>${COMING}</Say><Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect></Response>`);
        }

        case 'submenu': {
          if (button.menuId && menus[button.menuId]) {
            return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}?menuId=${button.menuId}</Redirect>
</Response>`);
          }
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>${COMING}</Say><Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect></Response>`);
        }

        case 'forward': {
          if (button.forwardTo) {
            return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold while we connect you.</Say>
  <Dial>${button.forwardTo}</Dial>
</Response>`);
          }
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>${COMING}</Say><Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect></Response>`);
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
  <Dial>${numberTag}</Dial>
</Response>`);
          }
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>${COMING}</Say><Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect></Response>`);
        }

        case 'voicemail': {
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please leave your message after the beep. Press pound when you are done.</Say>
  <Record action="${baseUrl}?menuId=${menuId}&amp;vm=1&amp;from=${encodeURIComponent(fromNum)}" method="POST" finishOnKey="#" maxLength="180" playBeep="true"/>
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
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>${COMING}</Say><Redirect method="POST">${baseUrl}?menuId=${menuId}</Redirect></Response>`);
      }
    }

    // ── No input — play the menu ──
    return res.end(buildMenuTeXML(baseUrl, menuId, audio[menuId]));

  } catch (err) {
    console.error('Hotline error:', err);
    return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, there was a technical problem. Please call back in a moment.</Say>
  <Hangup/>
</Response>`);
  }
};
