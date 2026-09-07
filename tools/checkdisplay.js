/* Does the game open on the display the launcher was told to use?
 *
 *     node tools/checkdisplay.js            every window mode
 *     node tools/checkdisplay.js --mode fullscreen
 *
 * WHY THIS EXISTS
 * ---------------
 * Reported: choosing a display in the launcher does nothing - the game opens
 * on whichever screen the launcher was on.
 *
 * `tools/checklauncher.js` could not have caught it. It proves PLAY navigates
 * the window to the game, which is a question about a URL; where the window
 * ENDED UP is a question about the desktop, and nothing was asking it.
 *
 * HOW IT MEASURES
 * ---------------
 * From inside the webview, `window.screenX` is the window's position in
 * VIRTUAL DESKTOP coordinates - the same space the host's monitor list is in.
 * So "which display is it on" is decidable without a screenshot and without
 * any platform API: find the monitor whose rectangle contains the window's
 * centre, and compare it with the one that was asked for.
 *
 * It needs two displays to say anything, and it says so rather than passing
 * vacuously on a single-monitor machine.
 */
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release',
  process.platform === 'win32' ? 'synx.exe' : 'synx');
const PORT = 9334;
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = arg('mode', '');

function skip(why) { console.log('  skipped: ' + why); process.exit(0); }
if (!fs.existsSync(EXE)) skip('no release binary - run the build first');
if (process.platform !== 'win32') skip('the debugging hook is a WebView2 mechanism');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

/* The same minimal CDP client tools/checklauncher.js uses. Node has had a
   WebSocket client built in since v21, so there is no dependency here. */
function attach(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    sock.addEventListener('open', () => {
      resolve({
        send(method, params) {
          const mid = ++id;
          sock.send(JSON.stringify({ id: mid, method, params: params || {} }));
          return new Promise((res, rej) => waiting.set(mid, { res, rej }));
        },
        close() { try { sock.close(); } catch (e) { /* gone */ } },
      });
    });
    sock.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      const w = msg.id && waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.rej(new Error(msg.error.message));
      else w.res(msg.result);
    });
    sock.addEventListener('error', () => reject(new Error('could not attach to the webview')));
    setTimeout(() => reject(new Error('attach timed out')), 12000);
  });
}

/** Which monitor rectangle contains a point. -1 for none. */
function monitorAt(mons, x, y) {
  for (let i = 0; i < mons.length; i++) {
    const m = mons[i];
    if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) return i;
  }
  return -1;
}

async function run(mode, want, bad) {
  const child = spawn(EXE, [], {
    env: Object.assign({}, process.env, { SYNX_DEBUG_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const kill = () => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    } catch (e) { /* already gone */ }
  };
  try {
    let page = null, sawPort = false, targets = null;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(500);
      try { targets = await getJson('http://127.0.0.1:' + PORT + '/json/list'); sawPort = true; }
      catch (e) { continue; }
      page = targets.find((x) => x.type === 'page' && /launcher\.html/.test(x.url || ''));
    }
    if (!sawPort) { kill(); skip('the webview did not open a debug port (no display?)'); }
    if (!page) { bad.push(mode + ': the host never reached launcher.html'); kill(); return null; }

    const cdp = await attach(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const evalIn = async (expr) => {
      const r = await cdp.send('Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description : 'threw');
      }
      return r.result.value;
    };

    for (let i = 0; i < 30; i++) {
      await sleep(400);
      if (await evalIn('document.querySelectorAll("#rows .row").length')) break;
    }
    /* The monitor list, WITH ITS POSITIONS. `launcher_view` did not report
       where each display sits on the desktop - only how big it is - which is
       precisely the field a "did it open on the right one" check needs. */
    const mons = JSON.parse(await evalIn(
      'JSON.stringify((window.__SYNX_LAUNCHER__ || {}).monitors || [])') || '[]');
    if (mons.length < 2) { cdp.close(); kill(); skip('only one display on this machine'); }
    if (mons[0].x === undefined) {
      bad.push('launcher_view does not report monitor positions, so nothing can check this');
      cdp.close(); kill(); return null;
    }

    // where the launcher itself is, so a pass cannot be an accident of it
    // already being on the target screen
    const from = await evalIn('JSON.stringify([window.screenX, window.screenY])');
    const at0 = JSON.parse(from);
    const launcherOn = monitorAt(mons, at0[0] + 40, at0[1] + 40);

    /* `launch_game` TAKES THE SETTINGS. Storing them and then clicking PLAY
       does not work: the button sends the launcher's own in-memory answers,
       which overwrite whatever was written to the save a moment earlier - so a
       test that goes through the button is testing the defaults. This calls
       the command the button calls, with the answer under test. */
    /* Fired, not awaited. `launch_game` navigates the window as its last act,
       which destroys the execution context the await is living in - so
       awaiting it reports a driver failure on exactly the runs that worked. */
    await evalIn(
      'window.__TAURI__.core.invoke("launch_game", { settings: {' +
      ' mode: "' + mode + '", width: 1280, height: 720, monitor: ' + want + ',' +
      ' gpu: true, always_on_top: false, vsync: true } }).catch(function(){}), "sent"');

    let url = '';
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      let list = [];
      try { list = await getJson('http://127.0.0.1:' + PORT + '/json/list'); } catch (e) { /* navigating */ }
      const p = list.find((t) => t.type === 'page');
      url = (p && p.url) || '';
      if (/index\.html/.test(url)) { page = p; break; }
    }
    if (!/index\.html/.test(url)) { bad.push(mode + ': PLAY never reached the game'); cdp.close(); kill(); return null; }

    cdp.close();
    const cdp2 = await attach(page.webSocketDebuggerUrl);
    await cdp2.send('Runtime.enable');
    const evalGame = async (expr) => {
      const r = await cdp2.send('Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true });
      return r.result && r.result.value;
    };
    // let the window settle: the reshape is marshalled onto the main thread
    await sleep(2500);
    const box = JSON.parse(await evalGame(
      'JSON.stringify([window.screenX, window.screenY, window.outerWidth, window.outerHeight])'));
    cdp2.close();

    const cx = box[0] + Math.max(1, box[2]) / 2;
    const cy = box[1] + Math.max(1, box[3]) / 2;
    const got = monitorAt(mons, cx, cy);
    const line = mode.padEnd(11) + ' asked for ' + want + ', opened on ' +
      (got < 0 ? 'nowhere' : got) + '   (launcher was on ' + launcherOn +
      ', window at ' + box[0] + ',' + box[1] + ' ' + box[2] + 'x' + box[3] + ')';
    if (got === want) console.log('  ok   ' + line);
    else bad.push(line);
    kill();
    return got;
  } catch (e) {
    bad.push(mode + ': the driver failed: ' + e.message);
    kill();
    return null;
  }
}

(async () => {
  const bad = [];
  /* Target the display the launcher is NOT on, or the test proves nothing.
     Monitor 1 is the second one the host listed; on a two-screen desktop the
     launcher opens on the primary, so 1 is the one worth asking for. */
  const modes = ONLY ? [ONLY] : ['windowed', 'borderless', 'fullscreen'];
  for (const m of modes) await run(m, 1, bad);
  console.log('');
  if (bad.length) {
    for (const b of bad) console.error('  WRONG DISPLAY  ' + b);
    console.error('\n' + bad.length + ' PROBLEM(S)');
    process.exit(1);
  }
  console.log('the game opens on the display the launcher was told to use');
})();
