/* Where a frame's CPU time actually goes, in the real desktop host.
 *
 *     node tools/profile.js                 route 0, 8 seconds of racing
 *     node tools/profile.js --route 6 --seconds 12
 *
 * WHY THIS EXISTS
 * ---------------
 * "Rewrite the scripting in a faster language" is a claim about where the time
 * is, and nothing in this tree was measuring that. `tools/smoke.js` runs on a
 * software rasteriser, where the GPU is so slow that every profile is a
 * picture of SwiftShader and nothing else - so it cannot answer the question
 * even in principle.
 *
 * This drives the release binary, which uses the real GPU, and takes a CPU
 * profile through the DevTools protocol while the car is driving. What comes
 * back is the only thing that decides whether a language change could help:
 * how much of a frame is spent in the game's own JavaScript, and which
 * functions those are.
 *
 * WHAT THE NUMBERS MEAN
 * ---------------------
 * `self` time is time in a function's own body, excluding its callees. A
 * WebGL entry point shows up as self time in `(program)` or in the binding
 * rather than in the caller, so the split between "our code" and "the driver"
 * is visible rather than assumed.
 */
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release',
  process.platform === 'win32' ? 'synx.exe' : 'synx');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ROUTE = parseInt(arg('route', '0'), 10);
const SECONDS = parseFloat(arg('seconds', '8'));
/* A port per harness, and not one a previous run may still be holding.
   A stale child keeps the endpoint open long enough that the next run finds
   it occupied and skips - which reads as 'the webview did not open a debug
   port' and is not that at all. */
const PORT = parseInt(arg('port', '9341'), 10);

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

function attach(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    sock.addEventListener('open', () => resolve({
      send(method, params) {
        const mid = ++id;
        sock.send(JSON.stringify({ id: mid, method, params: params || {} }));
        return new Promise((res, rej) => waiting.set(mid, { res, rej }));
      },
      close() { try { sock.close(); } catch (e) { /* gone */ } },
    }));
    sock.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      const w = msg.id && waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.rej(new Error(msg.error.message)); else w.res(msg.result);
    });
    sock.addEventListener('error', () => reject(new Error('could not attach')));
    setTimeout(() => reject(new Error('attach timed out')), 12000);
  });
}

/** Roll a CPU profile up into self time per function, and per source file. */
function summarise(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  // timeDeltas[i] is the time spent before samples[i] was taken
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    const dt = profile.timeDeltas[i] || 0;
    if (dt <= 0) continue;
    self.set(id, (self.get(id) || 0) + dt);
  }
  const rows = [];
  let total = 0;
  for (const [id, us] of self) {
    const n = byId.get(id);
    if (!n) continue;
    total += us;
    const f = n.callFrame || {};
    const file = (f.url || '').split('/').pop() || '(vm)';
    rows.push({
      name: f.functionName || '(anonymous)',
      file,
      line: (f.lineNumber || 0) + 1,
      us,
    });
  }
  rows.sort((a, b) => b.us - a.us);
  const byFile = new Map();
  for (const r of rows) byFile.set(r.file, (byFile.get(r.file) || 0) + r.us);
  return { rows, byFile, total };
}

(async () => {
  const child = spawn(EXE, ['--play'], {
    env: Object.assign({}, process.env, { SYNX_DEBUG_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const kill = () => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    } catch (e) { /* gone */ }
  };
  try {
    let page = null, sawPort = false, seen = [];
    for (let i = 0; i < 80 && !page; i++) {
      await sleep(500);
      let list;
      try { list = await getJson('http://127.0.0.1:' + PORT + '/json/list'); sawPort = true; }
      catch (e) { continue; }
      seen = list.map(function(x){return x.type + ' ' + (x.url||'');});
      /* The --play path serves the game at the ORIGIN, not at index.html: the
         window is built straight at the root rather than navigated to a page.
         Matching on the filename found nothing and skipped every run. */
      page = list.find((x) => x.type === 'page' && !/launcher[.]html/.test(x.url || ''));
    }
    if (!sawPort) { kill(); skip('the webview did not open a debug port'); }
    if (!page) { kill(); skip('the host never reached the game page; saw: ' + seen.join(' | ')); }

    const cdp = await attach(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const evalIn = async (expr) => {
      const r = await cdp.send('Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page threw: ' + expr.slice(0, 60));
      return r.result.value;
    };

    // wait for the scene, then start racing
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      if (await evalIn('!!(window.__nr && window.__nr.scene && window.__nr.scene.ready)')) break;
    }
    await evalIn('window.__nr.enterRoute(' + ROUTE + ', 2), window.__nr.startCountdown(), ' +
      'window.__nr.countdown = 0.05, "go"');
    await evalIn('window.__nr.input.keys["arrowup"] = true, "throttle"');
    await sleep(1500);                      // let it get up to speed

    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });   // microseconds
    await cdp.send('Profiler.start');
    await sleep(SECONDS * 1000);
    const fps = await evalIn('JSON.stringify(window.__nr.fps || {})');
    const stopped = await cdp.send('Profiler.stop');
    const draws = await evalIn('window.__nr.scene && window.__nr.scene.lastDrawCalls || 0');
    const ups = await evalIn('window.__nr.scene && window.__nr.scene.lastMatUploads || 0');
    cdp.close();

    /* A CENSUS OF ONE FRAME: which materials the draws are actually for, and
       how many of them re-uploaded. A profile says the uniforms are expensive;
       only this says which batch is issuing them. */
    const census = await evalIn('(function(){' +
      'var sc=window.__nr.scene, real=sc.drawPart, tally={}, order=[], last=null;' +
      'sc.drawPart=function(p,m){' +
      ' var k=(p&&p.mat&&p.mat.name)||"(none)";' +
      ' var t=tally[k]||(tally[k]={n:0,up:0}); t.n++;' +
      ' if(p.mat!==last){t.up++; order.push(k);} last=p.mat;' +
      ' return real.call(sc,p,m);};' +
      'return new Promise(function(res){requestAnimationFrame(function(){' +
      ' requestAnimationFrame(function(){ sc.drawPart=real;' +
      '  var rows=Object.keys(tally).map(function(k){return [k,tally[k].n,tally[k].up];});' +
      '  rows.sort(function(a,b){return b[1]-a[1];});' +
      '  res(JSON.stringify({rows:rows.slice(0,16),runs:order.length}));});});});})()');
    console.log('');
    console.log('ONE FRAME, BY MATERIAL   (draws / material switches)');
    var cen = JSON.parse(census || '{"rows":[]}');
    for (const r of cen.rows) {
      console.log('  ' + String(r[1]).padStart(5) + ' draws  ' + String(r[2]).padStart(4) +
        ' switches  ' + r[0]);
    }
    console.log('  total material switches in the frame: ' + cen.runs);

    const s = summarise(stopped.profile);
    const ms = (us) => (us / 1000).toFixed(0);
    const pct = (us) => (us * 100 / Math.max(1, s.total)).toFixed(1) + '%';

    const f = JSON.parse(fps || '{}');
    console.log('');
    console.log('route ' + ROUTE + ', ' + SECONDS + 's at ' + (f.now || 0).toFixed(1) +
      ' FPS (worst frame ' + (f.worst || 0).toFixed(1) + ' FPS), ' + draws + ' draw calls, ' +
      ups + ' of them restated their material (' +
      (100 - ups * 100 / Math.max(1, draws)).toFixed(0) + '% cached)');
    console.log('sampled ' + ms(s.total) + ' ms of CPU across ' + s.rows.length + ' functions');
    console.log('');
    console.log('BY FILE');
    const files = [...s.byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    for (const [file, us] of files) {
      console.log('  ' + pct(us).padStart(7) + '  ' + ms(us).padStart(6) + ' ms  ' + file);
    }
    console.log('');
    console.log('BY FUNCTION (self time)');
    for (const r of s.rows.slice(0, 18)) {
      console.log('  ' + pct(r.us).padStart(7) + '  ' + ms(r.us).padStart(6) + ' ms  ' +
        (r.name || '(anonymous)').slice(0, 34).padEnd(34) + r.file + ':' + r.line);
    }
    /* THE ONE NUMBER THE SCRIPTING QUESTION TURNS ON: how much of the profile
       is the game's own JavaScript, as opposed to the engine's internals, the
       GPU driver, the compositor and idle. Only the first of those could be
       rewritten in another language. */
    let ours = 0;
    /* The cache-buster is part of the URL, so a source file is named
       'scene.js?v=rust-1' and anchoring on '.js' at the END matched nothing -
       which reported the game's own code as 0% of its own profile. */
    let idle = 0;
    for (const [file, us] of s.byFile) if (/[.]js([?]|$)/.test(file)) ours += us;
    for (const r of s.rows) if (r.name === '(idle)') idle += r.us;
    const busy = Math.max(1, s.total - idle);
    console.log('');
    console.log('idle, waiting for the display: ' + pct(idle));
    console.log("the game's own JavaScript: " + pct(ours) + ' of all sampled CPU, ' +
      (ours * 100 / busy).toFixed(1) + '% of the CPU that was not idle (' +
      ms(ours) + ' ms of ' + ms(busy) + ' ms busy)');
  } catch (e) {
    console.error('  profile failed: ' + e.message);
  } finally {
    kill();
  }
})();
