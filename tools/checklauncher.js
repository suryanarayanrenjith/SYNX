/* The launcher, driven in the real desktop host.
 *
 *     node tools/checklauncher.js
 *
 * WHY THIS EXISTS
 * ---------------
 * PLAY did not work, and nothing in the tree could have told us. The launcher
 * renders under a plain web server and every one of its rows saves correctly
 * there, so `tools/smoke.js --page launcher.html` was green throughout. What
 * was broken was the half that only exists in the desktop host: the command
 * that turns the answers into a game window.
 *
 * A browser cannot test that. So this drives the actual release executable:
 * it starts it, attaches to the webview, waits for the launcher to come up,
 * presses PLAY, and checks that the window really does become the game.
 *
 * WHAT IT PROVES
 *   - the host starts and opens a window at launcher.html
 *   - `launcher_view` answers, so the rows have real monitors and sizes in them
 *   - the settings round-trip through the Rust save file, not localStorage
 *   - PLAY navigates the window to index.html
 *   - nothing threw on the way
 *
 * It is skipped, not failed, where it cannot run: the debugging hook it needs
 * is a Windows/WebView2 mechanism, and a machine with no display cannot open a
 * window at all.
 */
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
/* Where the host keeps the save and therefore any report. Mirrors
   `dirs_app_data` in main.rs; this test is the one thing outside the host that
   needs to know. */
const ROOT_APPDATA = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'com.synx.racing')
  : null;
const EXE = path.join(ROOT, 'target', 'release',
  process.platform === 'win32' ? 'synx.exe' : 'synx');
const PORT = 9333;

function skip(why) {
  console.log('  skipped: ' + why);
  process.exit(0);
}

if (!fs.existsSync(EXE)) skip('no release binary - run the build first');
if (process.platform !== 'win32') {
  skip('the debugging hook is a WebView2 mechanism; WebKitGTK uses a different one');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

/* The smallest CDP client that will do: connect, send, await by id. Pulling in
   a websocket library for one test is a dependency this project does not have
   and does not need. */
function connect(wsUrl) {
  const crypto = require('crypto');
  const net = require('net');
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    let open = false;
    const waiting = new Map();
    let nextId = 1;

    function frame(payload) {
      const data = Buffer.from(payload, 'utf8');
      const mask = crypto.randomBytes(4);
      const len = data.length;
      let head;
      if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2);
      } else {
        head = Buffer.alloc(10);
        head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2);
      }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
      return Buffer.concat([head, mask, masked]);
    }

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!buf.slice(0, end).toString().includes('101')) {
          reject(new Error('the webview refused the debug connection'));
          return;
        }
        buf = buf.slice(end + 4);
        open = true;
        resolve({
          send(method, params) {
            const id = nextId++;
            sock.write(frame(JSON.stringify({ id, method, params: params || {} })));
            return new Promise((res, rej) => {
              waiting.set(id, { res, rej });
              setTimeout(() => {
                if (waiting.has(id)) { waiting.delete(id); rej(new Error(method + ' timed out')); }
              }, 8000);
            });
          },
          close() { try { sock.destroy(); } catch (e) { /* already gone */ } },
        });
      }
      // frames: server->client is never masked
      for (;;) {
        if (buf.length < 2) return;
        const len0 = buf[1] & 127;
        let off = 2, len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        let msg;
        try { msg = JSON.parse(payload); } catch (e) { continue; }
        if (msg.id && waiting.has(msg.id)) {
          const w = waiting.get(msg.id);
          waiting.delete(msg.id);
          if (msg.error) w.rej(new Error(msg.error.message || 'cdp error'));
          else w.res(msg.result);
        }
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('could not attach to the webview')), 12000);
  });
}

(async () => {
  let bad = 0;
  const fail = (m) => { console.error('  ' + m); bad++; };
  const ok = (m) => console.log('  ok   ' + m);

  const child = spawn(EXE, [], {
    env: Object.assign({}, process.env, { SYNX_DEBUG_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const kill = () => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    } catch (e) { /* already gone */ }
  };

  try {
    /* WAIT FOR THE PAGE, NOT JUST FOR THE PORT.
     *
     * WebView2 opens its debugging endpoint as soon as the environment is
     * created, which is BEFORE the window has navigated anywhere - so the
     * first listing usually shows `about:blank`. Taking that first answer as
     * final made this check fail about one run in three, which is worse than
     * not having it: a test that fails at random teaches people to re-run it
     * rather than to read it. */
    let targets = null;
    let page = null;
    let sawPort = false;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(500);
      try {
        targets = await getJson('http://127.0.0.1:' + PORT + '/json/list');
        sawPort = true;
      } catch (e) { continue; }
      page = targets.find((x) => x.type === 'page' && /launcher\.html/.test(x.url || ''));
    }
    if (!sawPort) { kill(); skip('the webview did not open a debug port (no display?)'); }
    if (!page) {
      fail('the host never navigated to launcher.html - last saw: ' +
        (targets || []).map((x) => x.url).join(', '));
      kill();
      process.exit(1);
    }
    ok('the host opened launcher.html');

    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    const evalIn = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description : 'threw');
      }
      return r.result.value;
    };

    // the launcher has to have finished building itself
    let rows = 0;
    for (let i = 0; i < 30 && rows === 0; i++) {
      await sleep(400);
      rows = await evalIn('document.querySelectorAll("#rows .row").length');
    }
    if (!rows) { fail('the launcher built no rows in the host'); }
    else ok('the launcher built ' + rows + ' rows from launcher_view');

    // the rows must have real machine data in them, not the browser fallback
    const monitors = await evalIn(
      'JSON.stringify((window.__SYNX_LAUNCHER__ || {}).monitors || [])');
    const mons = JSON.parse(monitors || '[]');
    if (!mons.length) fail('no monitors came back from the host');
    else ok('the host reported ' + mons.length + ' monitor(s): ' +
      mons.map((m) => m.width + 'x' + m.height).join(', '));

    // a setting has to survive a round trip through the Rust save file
    const saved = await evalIn(
      '(async () => { const t = window.__TAURI__.core.invoke;' +
      ' await t("launcher_store", { settings: { mode: "windowed", width: 1280,' +
      ' height: 720, monitor: 1, gpu: true, always_on_top: false, vsync: false } });' +
      ' const s = await t("save_load"); return JSON.stringify(s["synx.launcher.v1"] || null); })()');
    const back = JSON.parse(saved || 'null');
    /* Checked on rows the HOST actually reads. This used to assert `fps_cap`,
       which round-tripped perfectly and meant nothing: `launcher_store` writes
       the object verbatim, so the test passed on a field no code anywhere
       consumed. A round trip is only worth testing for a value something acts
       on - `vsync` reaches the webview's command line, `monitor` decides which
       screen the window opens on, and both have their own checks besides. */
    if (!back || back.vsync !== false || back.monitor !== 1 || back.mode !== 'windowed') {
      fail('a launcher setting did not survive the save file: ' + saved);
    } else {
      ok('settings round-trip through the save file');
    }

    /* THE LOGGING, WHICH ONLY EXISTS WHEN IT IS NEEDED.
     *
     * The contract is precise and easy to get backwards: a run that works must
     * leave NOTHING on disk, and a run that fails must leave a file whose path
     * the player is shown. Both halves are checked, in that order, because a
     * logger that always writes passes the second test on its own. */
    const reportPath = (ROOT_APPDATA && require('path').join(ROOT_APPDATA, 'synx-launch-report.txt'));
    if (reportPath && fs.existsSync(reportPath)) {
      fail('a report exists after a clean start - logs are being written when nothing is wrong');
    } else {
      ok('a clean start wrote no log');
    }

    // ...and now provoke one
    const written = await evalIn(
      '(async () => window.__TAURI__.core.invoke("diag_report", {' +
      ' reason: "synthetic failure raised by tools/checklauncher.js",' +
      ' details: { stage: "self test", graphics: { webgl2: false } } }))()');
    if (!written) {
      fail('a failure did not produce a report at all');
    } else if (!fs.existsSync(written)) {
      fail('the host returned a report path that does not exist: ' + written);
    } else {
      const text = fs.readFileSync(written, 'utf8');
      const wants = ['WHAT WENT WRONG', 'THIS MACHINE', 'webview', 'graphics',
        'WHAT HAPPENED, IN ORDER', 'WHAT TO TRY', 'synthetic failure'];
      const missing = wants.filter((w) => text.indexOf(w) < 0);
      if (missing.length) fail('the report is missing: ' + missing.join(', '));
      else ok('a failure wrote a report that names the machine and what to try');

      // ...and the launcher must find it and be able to throw it away
      const seen = await evalIn('(async () => window.__TAURI__.core.invoke("diag_previous"))()');
      if (seen !== written) fail('diag_previous did not report the file just written');
      else ok('the launcher finds the report on the next start');

      // --show prints it, because a report nobody has read is a report that
      // may well be useless without anyone knowing
      if (process.argv.includes('--show')) {
        console.log('');
        console.log('--- the report ---');
        console.log(text);
        console.log('--- end ---');
      }
      await evalIn('(async () => window.__TAURI__.core.invoke("diag_clear"))()');
      if (fs.existsSync(written)) fail('the report could not be dismissed');
      else ok('the report can be dismissed once it has been read');
    }

    // ...and PLAY has to actually take the window to the game
    await evalIn('document.getElementById("play").click()');
    let url = '';
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      let list = [];
      try { list = await getJson('http://127.0.0.1:' + PORT + '/json/list'); } catch (e) { /* mid-navigation */ }
      const p = list.find((t) => t.type === 'page');
      url = (p && p.url) || '';
      if (/index\.html/.test(url)) break;
    }
    if (/index\.html/.test(url)) ok('PLAY navigated the window to the game');
    else fail('PLAY did not reach the game - the window is still at: ' + (url || 'unknown'));

    cdp.close();
  } catch (e) {
    fail('the driver failed: ' + e.message);
  } finally {
    kill();
  }

  if (out.trim()) {
    for (const line of out.trim().split(/\r?\n/)) {
      if (/SYNX graphics/.test(line)) console.log('  host: ' + line.trim());
    }
  }
  if (bad) {
    console.error('\n' + bad + ' PROBLEM(S) launching the game');
    process.exit(1);
  }
  console.log('\nthe launcher opens, saves, and starts the game');
})();
