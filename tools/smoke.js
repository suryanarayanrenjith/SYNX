/* Load the whole game in a real browser and report what broke.
 *
 *     node tools/smoke.js                     the default 16-second run
 *     node tools/smoke.js --route 6 --seconds 24
 *     node tools/smoke.js --shot out.png      ...and save what it looked like
 *
 * WHY
 * ---
 * Everything in web/ is renderer code: a shader that will not compile, a
 * uniform that is not there, a texture the pack does not carry, a class that
 * throws on construction. None of it is reachable from `cargo test`, none of
 * it shows up in a parse check, and all of it fails at exactly the moment the
 * player opens the game. The only honest way to check it is to run it.
 *
 * So this serves web/ over HTTP, opens it in headless Edge (or Chrome) with a
 * software WebGL2 implementation, drives it through the states a player would
 * - title, a race on a chosen route, a crash into the barrier, a pause, a
 * resume - and reads back everything the page said: console errors, uncaught
 * exceptions, failed requests, the load timings, the draw-call census, and the
 * gain the engine loop was actually sitting at while the game was paused.
 *
 * HOW IT TALKS TO THE BROWSER
 * ---------------------------
 * Through the DevTools protocol, over the WebSocket Node has had built in
 * since v21 - not through `--dump-dom`, which current Chromium ignores under
 * the new headless mode and which silently produces nothing at all.
 *
 * It is a SMOKE test. It proves the game starts, builds its world, compiles
 * its shaders, draws frames and survives being driven into a wall. It does not
 * prove the picture is right.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const SECONDS = parseFloat(arg('seconds', '16'));
const ROUTE = parseInt(arg('route', '6'), 10);
const SHOT = arg('shot', null);
/* Stop the run on a given screen and leave it there, so the screenshot at the
   end is of that screen rather than of whatever the car was doing. */
const HOLD = arg('hold', '');
/* --freeroam <opponent> drives the open route instead of a chapter, which is
   the only way to reach the R-IX livery outside the campaign. */
const FREEROAM = arg('freeroam', '');
/* 0 LOW .. 3 ULTRA. The draw-call census depends on it - the cascades and the
   reflection probe are the two passes that submit the world again - so the
   number is only meaningful next to the preset it was taken at. */
const PRESET = parseInt(arg('preset', '0'), 10);
/* Which camera view to drive in: 0 chase, 1 bonnet, 2 drone. The bonnet and
   the drone are the two the harness cannot otherwise reach - the key that
   cycles them is a key, and this driver has no keyboard. */
const CAMERA = arg('cam', '');
/* Which document to open. The launcher is a page of its own with its own
   markup and its own script, and nothing in the game ever navigates to it - so
   without this it has no coverage at all, which is exactly how the mode
   terminal once shipped with no way back to the title. */
const PAGE = arg('page', 'index.html');
/* The two pixel settings. The harness has always forced a 50% render scale
   - it is running on a software rasteriser and cannot afford native - so
   the reconstruction path is exercised by every run already. These make it
   selectable, which is what lets the upscaler's output be compared against
   the plain bilinear stretch on the same frame. -1 leaves the value the
   harness would otherwise use. */
const SCALE = parseInt(arg('scale', '-1'), 10);
const UPSCALER = parseInt(arg('upscaler', '-1'), 10);
/* Walk every control on a DOM page, change it, and report whether the saved
   value actually followed. A launcher whose rows are inert looks identical
   to one that works until you go looking. */
const EXERCISE = process.argv.includes('--exercise');
/* Turn the frustum test off, to measure what it is actually removing rather
   than to estimate it. Scene.setFrustum already has a latch for exactly this
   (its own self-check uses it), so nothing test-only is being added to the
   renderer to support the measurement. */
const NOCULL = argv.includes('--nocull');
/* Force the JavaScript fallback for the instance bake, to measure what moving
   it into the core is actually worth rather than to estimate it. */
const NOBAKE = argv.includes('--nobake');
/* --probe camera puts the car inside a Chapter 7 bore and reports where the
   chase camera actually ended up, which is the one thing about the tunnel fix
   that cannot be read off the source. */
const PROBE = arg('probe', '');
/* Where --probe multiplayer points the game. A real server, so the probe
   exercises the actual socket, the actual WebAssembly netcode and the actual
   lobby rather than a mock of any of them. */
const SERVER = arg('server', 'http://127.0.0.1:18080');
/* --at <arc length> parks the car at one station and holds it there, so a
   screenshot is of a place on the route rather than of wherever the car
   happened to be. It is how a floating object gets found. */
const AT = arg('at', '');
const LOOK = arg('look', '');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const browser = BROWSERS.find(b => fs.existsSync(b));
if (!browser) {
  console.error('no Chromium-based browser found; cannot run the smoke test');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ogg': 'audio/ogg', '.wasm': 'application/wasm', '.json': 'application/json',
  '.bin': 'application/octet-stream', '.pak': 'application/octet-stream',
  '.ttf': 'font/ttf',
};

/* The collector, injected as the FIRST script on the page so it is installed
   before anything it is meant to catch can run. */
const COLLECTOR = `
(function () {
  var out = { errors: [], warnings: [], net: [], notes: [] };
  window.__smoke = out;
  /* js/net.js reads this before the save file and before its own default, so
     the probe can point the whole multiplayer stack at a local server without
     touching a line of the game. */
  if (window.__SMOKE_SERVER) window.SYNX_SERVER = window.__SMOKE_SERVER;
  var ce = console.error, cw = console.warn;
  console.error = function () { out.errors.push(Array.prototype.join.call(arguments, ' ')); ce.apply(console, arguments); };
  console.warn = function () { out.warnings.push(Array.prototype.join.call(arguments, ' ')); cw.apply(console, arguments); };
  window.addEventListener('error', function (e) {
    if (e.target && e.target.src) { out.net.push('failed to load ' + e.target.src); return; }
    out.errors.push('uncaught: ' + (e.message || e) + ' @' + (e.filename || '?') + ':' + (e.lineno || 0));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    out.errors.push('unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason));
  });
})();
`;

/* The driver. Runs after the game's scripts and walks it through the states a
   player would, because every one of those is a code path that only executes
   when it is entered. */
/* What a page that is NOT the game reports.
 *
 * The game's reporter lives inside DRIVER and closes over that template's
 * frame counter and its NR.Game reference, so it cannot be reused here - and
 * should not be. A launcher has no scene and draws no frames, and answering
 * those questions with zeroes would report a failure that has not happened.
 * What this answers is what still applies to any page at all: did anything
 * throw, did any request fail, and did the page build its controls. */
/* Drives every row on a DOM page and reports what each one did.
 *
 * It clicks the NEXT arrow on each row in turn and reads the saved blobs
 * back out of storage, comparing them with what was there before. A row that
 * draws, highlights, plays its sound and saves nothing is the failure this
 * exists to catch, and it is invisible from the outside: a screen of controls
 * that ignore you looks exactly like a screen of controls that work.
 *
 * A row already at the end of its list is expected NOT to move, because its
 * arrow is disabled. Those are reported as such rather than as failures.
 */
const EXERCISER = `
  window.__smokeExercise = async function () {
    var S = window.NR && window.NR.Settings;
    var out = { tabs: [], rows: [], errors: [] };
    if (!S) { out.errors.push("settings schema missing"); return out; }

    function snapshot() {
      try {
        return (localStorage.getItem(S.LAUNCHER_KEY) || "") + "|" +
               (localStorage.getItem(S.KEY) || "");
      } catch (e) { return ""; }
    }
    function rowsNow() { return document.querySelectorAll("#rows .row"); }

    var tabs = document.querySelectorAll("#tabs .tab");
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].click();
      var n = rowsNow().length;
      out.tabs.push({ tab: tabs[t].textContent, rows: n });
      if (!n) out.errors.push("tab " + tabs[t].textContent + " built no rows");
      for (var i = 0; i < n; i++) {
        var live = rowsNow()[i];
        if (!live) continue;
        var label = (live.querySelector(".lbl") || {}).textContent || "?";
        var shown = (live.querySelector(".txt") || {}).textContent || "";
        var inc = live.querySelectorAll(".val button")[1];
        var atEnd = !inc || inc.disabled;
        var before = snapshot();
        if (inc && !inc.disabled) inc.click();
        /* Let the write land. The launcher chains its saves onto a promise
           so two clicks cannot interleave. The queue is the tail of that
           chain, and awaiting it is exactly what 'the save this click started
           has finished' means. */
        var app = window.__SYNX_LAUNCHER__;
        if (app && app._queue) { try { await app._queue; } catch (e) { /* reported below */ } }
        var after = snapshot();
        var live2 = rowsNow()[i];
        var shown2 = live2 ? ((live2.querySelector(".txt") || {}).textContent || "") : "";
        out.rows.push({
          tab: tabs[t].textContent, label: label, from: shown, to: shown2,
          atEnd: atEnd, saved: before !== after, redrew: shown !== shown2
        });
      }
    }
    return out;
  };
`;

const PAGE_REPORTER = `
  window.__smokeReport = async function () {
    var o = window.__smoke;
    var r = {
      errors: o.errors, warnings: o.warnings, net: o.net, notes: o.notes,
      started: true, state: "dom", sceneReady: true, frames: 0,
    };
    if (document.getElementById("rows")) {
      r.dom = {
        rows: document.querySelectorAll("#rows .row").length,
        tabs: document.querySelectorAll("#tabs .tab").length,
      };
    }
    if (window.__smokeExercise) {
      try { r.exercise = await window.__smokeExercise(); }
      catch (e) { r.exercise = { errors: ["exerciser threw: " + e.message], tabs: [], rows: [] }; }
    }
    return r;
  };
`;

const DRIVER = (route, hold, freeroam, preset, nocull, probe, at, look, nobake, scale, upscaler, camera) => `
(function () {
  var HOLD = '${hold}';
  var FREEROAM = '${freeroam}';
  var PROBE = '${probe}';
  var AT = '${at}';
  var LOOK = '${look}';
  var step = 0, at = 0, frames = 0;
  var note = function (t) { window.__smoke.notes.push(t); };
  // proof of life for the report: see the noreport branch in the runner
  if (window.__smoke) window.__smoke.driver = 1;
  function tick() {
    requestAnimationFrame(tick);
    /* The advisory is a modal the driver has no input layer to dismiss, so it
       would otherwise cover every frame and every screenshot. --hold advisory
       and --probe advisory are the two cases that want it left up.

       BEFORE THE GAME EXISTS, NOT AFTER. This used to sit under the guard
       below, and the guard is window.__nr - which main.js does not create
       until the notice has been dismissed. The harness was waiting for a game
       that was waiting for the harness, so every run reported a game that
       never started and no frames at all, on a page that was working fine. */
    if (PROBE !== 'advisory' && HOLD !== 'advisory'
        && window.NR && window.NR.dismissAdvisory) window.NR.dismissAdvisory();
    var g = window.__nr;
    if (!g) return;
    frames++; g.__smokeFrames = frames;
    /* HOW STRAIGHT THE RIVAL DRIVES.
     *
     * A car that is dashing from one edge of the road to the other and back
     * looks, in a screenshot, exactly like a car taking a racing line. The
     * difference is in the total: a line wanders a few units per second, a
     * car chattering between the edges covers hundreds.
     *
     * This is here because Chapter 7's boss did precisely that - Chapter 6
     * left its lane-hint closure installed on the shared driver, so the R-IX
     * was being told to sit at +/-13 whenever its lookahead crossed a gate
     * that belonged to another chapter. Every frame of it was 'clean'. */
    if (g.rival && g.track && g.track.project && g.state === 'racing') {
      var L = g.__lat || (g.__lat = { last: null, travel: 0, lo: 1e9, hi: -1e9, n: 0, t: 0 });
      // a vehicle carries a world position; the offset from the line is a
      // projection onto it, which is what lateral means everywhere else
      var lat = g.track.project(g.rival.x, g.rival.z, g.rival.sTrack).lateral;
      if (L.last !== null) L.travel += Math.abs(lat - L.last);
      L.last = lat;
      if (lat < L.lo) L.lo = lat;
      if (lat > L.hi) L.hi = lat;
      L.n++;
      /* REAL SECONDS, not frames over sixty. This harness runs on a software
         rasteriser and draws about one frame a second, so a per-frame rate
         normalised against 60 Hz would read forty times too low - and the
         first version of this gated on a frame COUNT it could never reach. */
      L.t += g.__realDt || 0;
    }
    var nowT = performance.now();
    g.__realDt = Math.min(0.1, (nowT - (g.__lastT || nowT)) / 1000);
    g.__lastT = nowT;
    if (!g.scene || !g.scene.ready) return;
    at++;
    try { run(g); } catch (e) { window.__smoke.errors.push('driver: ' + e.message); }
  }
  function run(g) {
    if (HOLD === 'advisory') return;       // leave the notice up, for a shot
    if (HOLD === 'menu') return;           // stay on the title screen
    /* The confirmation card, over the title screen. It is a modal state of
       its own and nothing in a racing run ever opens one, so without this it
       has no coverage at all. */
    if (HOLD === 'confirm') {
      if (at > 6 && g.state === 'menu' && g.askQuit) { g.askQuit(); note('held: quit confirmation'); }
      return;
    }
    /* The three selection screens, each held so a screenshot is OF that screen.
       They are ordinary DOM panels with no canvas of their own, so nothing
       else in this harness would ever open one - which is how the mode
       terminal shipped with no way back to the title but ESC. */
    /* The CONTROLS screen, on a chosen tab. --hold controls:1 is the gamepad
       page, which is the one with a live diagram on it and therefore the one
       most worth looking at. */
    if (HOLD.indexOf('controls') === 0) {
      if (at > 6 && g.state === 'menu') {
        const t = parseInt(HOLD.split(':')[1] || '0', 10) || 0;
        g.state = 'controls';
        g.controlIndex = 0;
        if (g.setOptionTab) g.setOptionTab(t); else g.controlTab = t;
        note('held: controls tab ' + t);
      }
      return;
    }
    if (HOLD === 'modes') {
      if (at > 6 && g.modeSelect && !g.modeSelect.shown) {
        g.modeSelect.open();
        note('held: mode terminal, back button = ' +
          !!document.getElementById('modeBack'));
      }
      return;
    }
    if (HOLD === 'freeroam') {
      if (at > 6 && g.freeRoamUi && !g.freeRoamUi.shown) {
        /* The open route is gated on finishing the campaign, and a fresh
           profile has not. The gate itself is covered by the mode terminal's
           own refusal path; what this hold is for is the SCREEN, so it is
           lifted here and said out loud rather than left looking like a pass. */
        if (!g.freeRoamUi.open('modes')) {
          note('free roam gate lifted for the probe (campaign not complete)');
          window.NR.campaignComplete = function () { return true; };
          g.freeRoamUi.open('modes');
        }
        note('held: free roam terminal');
      }
      return;
    }
    if (HOLD === 'multiplayer') {
      if (at > 6 && g.multiplayer && !g.multiplayer.shown) {
        g.multiplayer.open('modes');
        note('held: multiplayer lobby');
      }
      return;
    }
    if (step === 0 && at > 4) {
      /* SwiftShader draws about five frames a second at 1280x720, so the
         budget is spent on the world rather than on the post chain: half
         resolution and the LOW preset, which is a supported configuration
         rather than a test-only path. */
      try {
        g.settings.quality = ${preset};
        g.settings.resolution = ${scale} >= 0 ? ${scale} : 0;
        if (${upscaler} >= 0) g.settings.upscaler = ${upscaler};
        g.applySettings();
        note('pixels: scale=' + g.renderScale.toFixed(2) + ' upscaler=' + g.upscaler +
             ' render=' + g.w + 'x' + g.h + ' canvas=' + g.outW + 'x' + g.outH);
        /* WHAT THE SETTINGS ACTUALLY DID.
           Every one of these is a value the RENDERER reads, derived from a
           row on the launcher. Reporting the row would prove nothing - the
           question is whether the number on the other side of applySettings
           followed it, and that is the half that silently breaks. */
        note('applied: shadows=' + g.useShadows + ' ao=' + g.aoQuality +
             ' ssr=' + g.useSsr + ' vol=' + g.useVolumetrics + ' taa=' + g.useTaa +
             ' bloomLv=' + g.bloomLevels + ' bloomAmt=' + (g.bloomAmount || 0).toFixed(2) +
             ' grain=' + g.useGrain + ' blur=' + g.useMotionBlur);
        /* THE PRESET MUST ACTUALLY BE THE PRESET.
 *
           This is the invariant the schema check cannot see and the
           screenshot cannot show: the option lookup searched the rows the
           settings screen DREW; that screen stopped drawing the PRESET row
           when the graphics moved to the launcher, so the lookup returned null
           and every preset silently ran HIGH. The game drew a clean frame at
           LOW with shadows, reflections and volumetrics all on.
 *
           So the renderer's own flags are compared against what the chosen
           preset asked for, on every run, at whatever preset that run uses. */
        (function () {
          var SS = window.NR && window.NR.Settings;
          if (!SS) return;
          var row = SS.rowByKey('quality');
          var name = row && row.opts[g.settings.quality];
          var q = name && SS.QUALITY[name];
          if (!q) { window.__smoke.errors.push('preset ' + g.settings.quality + ' resolves to nothing'); return; }
          var want = {
            shadows: q.shadow > 0 && g.settings.shadows === 1,
            ssr: q.ssr && g.settings.reflections === 1,
            vol: q.volumetric && g.settings.volumetrics === 1,
            taa: !!q.taa,
            bloomLv: q.bloomLevels
          };
          var got = {
            shadows: !!g.useShadows, ssr: !!g.useSsr, vol: !!g.useVolumetrics,
            taa: !!g.useTaa, bloomLv: g.bloomLevels
          };
          var wrong = [];
          for (var k in want) if (want[k] !== got[k]) wrong.push(k + ' want=' + want[k] + ' got=' + got[k]);
          if (wrong.length) {
            window.__smoke.errors.push('preset ' + name + ' was not applied: ' + wrong.join(', '));
          } else {
            note('preset ' + name + ' applied correctly');
          }
        })();
        note('image: sat=' + (g.lookSat || 0).toFixed(2) + ' punch=' + (g.lookPunch || 0).toFixed(2) +
             ' sharpen=' + (g.sharpenScale === undefined ? 'n/a' : g.sharpenScale) +
             ' pad=' + (g.pad ? (g.pad.enabled ? 'on' : 'off') : 'none') +
             ' deadzone=' + (g.pad ? g.pad.deadzone : '-') + ' curve=' + (g.pad ? g.pad.curve : '-'));
      } catch (e) { /* the preset is not essential to the run */ }
      /* THE MIXER, BY HAND.
         Audio starts on the first user gesture, and this driver writes into
         the key table rather than dispatching events - so without this the
         graph is never built and the one number the pause fix is about (the
         engine loop's gain) does not exist to be read. */
      try { g.audio.init(); g.audio.resume(); } catch (e) { /* no device */ }
      if (${nocull}) g.scene._frustumChecked = 2;   // the latch, see setFrustum
      if (${nobake}) window.NR.bakeBegin = null;
      if (FREEROAM !== '') {
        g.enterFreeRoam({ region: ${route}, rival: parseInt(FREEROAM, 10) });
        note('free roam region ${route} vs opponent ' + FREEROAM +
             ' raptor=' + !!g.raptorRival());
      } else {
        g.enterRoute(${route}, 2);
      }
      g.startCountdown();
      g.countdown = 0.05;          // software rendering has no time for lights
      if ('${camera}' !== '') {
        g.camMode = parseInt('${camera}', 10) | 0;
        note('camera view ' + g.camMode);
      }
      note('entered route ${route}: ' + (g.level && g.level.name));
      step = 1; at = 0;
    } else if (PROBE === 'sink' && step >= 1) {
      /* WHY THE CAR SINKS INTO THE ROAD.
       *
       * The solver puts the car at track.at(s).y + rideHeight, sampling the
       * elevation spline continuously. The road it is driving on is a triangle
       * strip whose quads are twenty-four units long, so between one pair of
       * cross sections the rendered surface is a straight CHORD while the car
       * follows the ARC.
       *
       * Over a crest the chord is below the arc and the car floats. Through a
       * dip the chord is ABOVE the arc, and the car - correctly placed on the
       * spline - is drawn underneath the road it is on. That is the reported
       * clipping, and it is a sampling mismatch rather than a physics bug, so
       * the thing to know before changing anything is how big it actually is.
       *
       * Reported as the worst chord error over the whole route.
       */
      if (!g.__sink) {
        g.__sink = true;
        var TR = g.track, STEP = 24;
        var A = 129000, B = 176000;   // the level 7 deck
        var worst = 0, worstS = 0, worstUp = 0, worstUpS = 0, n = 0, sum = 0;
        var yAt = function (ss) { return TR.at(ss, {}).y; };
        for (var ss = A; ss < B - STEP; ss += STEP) {
          var y0 = yAt(ss), y1 = yAt(ss + STEP);
          for (var k = 1; k < 4; k++) {
            var f = k / 4, mid = ss + STEP * f;
            // chord minus arc: positive means the road is drawn ABOVE the car
            var e = (y0 + (y1 - y0) * f) - yAt(mid);
            n++; sum += Math.abs(e);
            if (e > worst) { worst = e; worstS = mid; }
            if (-e > worstUp) { worstUp = -e; worstUpS = mid; }
          }
        }
        /* ...and how far off the world origin this road actually is, which is
           the size of the error a placement that ignores p.y makes. */
        var lo = 1e9, hi = -1e9, loS = 0, hiS = 0;
        for (var s3 = A; s3 < B; s3 += 24) {
          var y3 = yAt(s3);
          if (y3 < lo) { lo = y3; loS = s3; }
          if (y3 > hi) { hi = y3; hiS = s3; }
        }
        note('sink: deck elevation ' + lo.toFixed(1) + 'u (s=' + loS.toFixed(0) + ') .. ' +
             hi.toFixed(1) + 'u (s=' + hiS.toFixed(0) + ')');
        // what a director placement puts the car at, now and before
        g.story.setVehicle(g.car, hiS, 0, 40);
        note('sink: setVehicle at the high point -> car.y=' + g.car.y.toFixed(2) +
             '  roadY=' + (g.car.roadY || 0).toFixed(2) +
             '  clearance=' + (g.car.y - yAt(hiS)).toFixed(2) + 'u' +
             '  roadPitch=' + ((g.car.roadPitch || 0) * 57.3).toFixed(1) + 'deg');
        /* ...and the MENU flyby, which carries the car along the centreline
           with the solver switched off and so has to place it itself. */
        var keep = g.distance;
        var wf = 0, wfS = 0;
        for (var s4 = A; s4 < B; s4 += 240) {
          g.distance = s4 - 55 * 0.016;
          g.idleFlyby(0.016);
          var cl = g.car.y - yAt(g.car.sTrack);
          if (Math.abs(cl - (g.car.lift || 0)) > Math.abs(wf)) { wf = cl - (g.car.lift || 0); wfS = s4; }
        }
        g.distance = keep;
        note('sink: menu flyby worst clearance error ' + wf.toFixed(3) + 'u at s=' + wfS.toFixed(0) +
             '  (ride height ' + (g.car.lift || 0).toFixed(2) + 'u)');
        note('sink: chord vs arc over ' + n + ' samples, step ' + STEP + 'u');
        note('sink: worst SUNK (road above car) ' + worst.toFixed(3) + 'u at s=' + worstS.toFixed(0));
        note('sink: worst FLOAT (road below car) ' + worstUp.toFixed(3) + 'u at s=' + worstUpS.toFixed(0));
        note('sink: mean |error| ' + (sum / n).toFixed(4) + 'u   ride height ' + (g.car.lift || 0).toFixed(3) + 'u');
        // ...and the same for the detail layers, which use their own steps
        var steps = [12, 18, 36, 48];
        for (var si = 0; si < steps.length; si++) {
          var ST = steps[si], w = 0, wS = 0;
          for (var s2 = A; s2 < B - ST; s2 += ST) {
            var a2 = yAt(s2), b2 = yAt(s2 + ST), e2 = (a2 + b2) * 0.5 - yAt(s2 + ST * 0.5);
            if (e2 > w) { w = e2; wS = s2; }
          }
          note('sink: step ' + ST + 'u would sink ' + w.toFixed(3) + 'u at s=' + wS.toFixed(0));
        }
      }
      return;
    } else if (PROBE === 'director') {
      /* WHAT ONE CHAPTER MAY LEAVE BEHIND FOR THE NEXT.
       *
       * The driver's lane hint is an ABSOLUTE lateral a director lends the shared
       * driver so its car can see hardware the track does not know about -
       * Chapter 6's live walls, saws and sorting chutes. It is a closure over
       * that director and means nothing outside that chapter.
       *
       * Chapter 6 cleared it in its own teardown and nothing else ever did.
       * Any route into another chapter that skipped that teardown therefore
       * left the Forge's lane function installed, and Chapter 7's R-IX then
       * asked it where to be - getting gate gaps and the +/-13 that keeps a
       * car clear of a saw. Those are at the edge of the road, and they
       * switch on and off as the lookahead sweeps positions belonging to a
       * different chapter, so the boss drove from one edge to the other and
       * back while making perfectly ordinary forward progress.
       *
       * It is cleared in Driver.reset now, which every race start calls. This
       * asserts that, because the bug is invisible: the game runs, draws and
       * reports nothing wrong. */
      if (!g.__dir) {
        g.__dir = 1;
        var bad = 0;
        var d = g.driver;
        if (!d) { note('PROBLEM: no driver to test'); PROBE = ''; return; }
        d.laneHint = function () { return 13.2; };
        if (d.laneHint === null) { note('PROBLEM: laneHint would not set'); bad++; }
        d.reset();
        if (d.laneHint !== null) {
          note('PROBLEM: a director lane hint survived Driver.reset - it will steer the next chapter');
          bad++;
        }
        // ...and the same for the boost hold, which Chapter 7 raises and
        // which would otherwise leave the next chapter's rival flat out
        d.boostHold = 1;
        d.reset();
        if (d.boostHold !== 0) { note('PROBLEM: boostHold survived Driver.reset'); bad++; }
        note(bad ? 'director: ' + bad + ' LEAK(S)' : 'director: nothing leaks across a reset');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'predator') {
      /* THE BOSS'S BALANCE, AS ARITHMETIC.
       *
       * Chapter 7 is decided by three numbers: what the player can hold on
       * the Forge engine, what they can hold on boost, and what they can hold
       * in a sync window - each against the ceiling the R-IX is allowed while
       * he is being provoked. The whole design is 'boost does not shake him
       * off, the sync window does', and that is a claim about two inequalities
       * rather than about how the race feels.
       *
       * Winning a race to find out is not a test. NR.PRED.hunt is exported so
       * the curve can be asked directly, which is what this does.
       */
      if (!g.__pred) {
        g.__pred = 1;
        var P = window.NR && window.NR.PRED;
        if (!P || !P.hunt) { note('PROBLEM: NR.PRED.hunt is not exported'); PROBE = ''; return; }
        var TERM = P.stockTerminal;          // 88: a stock car here
        var ENGINE = TERM * 1.09;            // the Forge engine, ~96
        var BOOST = TERM * 1.14;             // ...and boost on top, ~100
        var MODE = TERM * 1.51;              // a sync window, ~133
        var bad = 0;
        var say = function (ok, msg) { if (!ok) { bad++; note('PROBLEM: ' + msg); } };

        /* The pressure term is gone - the counter-attack was removed on request; see
           the long note above RETAKE_CLEAR in js/chapters.js. What answers an
           overtake now is the hunt curve, and the hunt curve is a function of
           the GAP - so "provoked" is no longer a flag to pass, it is a gap to
           ask about. Alongside is the state right after being overtaken; two
           hundred units is the lead the player has to defend. */
        var hot = P.hunt(6, { confidence: 1, playerBoosting: true, playerV: BOOST });
        var cold = P.hunt(6, { confidence: 1, playerV: ENGINE });
        var mode = P.hunt(6, { confidence: 1, playerMode: true, playerV: MODE });
        var led = P.hunt(200, { confidence: 1, playerBoosting: true, playerV: BOOST });

        note('predator: ceiling alongside=' + hot.top.toFixed(1) +
             ' at a 200u lead=' + led.top.toFixed(1) + '  player engine=' + ENGINE.toFixed(1) +
             ' boost=' + BOOST.toFixed(1) + ' raceMode=' + MODE.toFixed(1));

        say(hot.top > BOOST + 8,
            'boost (' + BOOST.toFixed(1) + ') is not answered - his provoked ceiling is only ' +
            hot.top.toFixed(1) + ', so the player can simply hold boost and leave');
        /* A MARGIN, not a bare inequality. The first version of this asked
           only that the window be faster than him, and it passed on nine
           tenths of a unit per second - which is true, and is not a
           counterplay a player can feel. Three units is about a hundred metres
           over a window, which is what the chapter's notes claim it is worth. */
        say(MODE - mode.top >= 3,
            'a sync window (' + MODE.toFixed(1) + ') barely escapes his ' +
            mode.top.toFixed(1) + ' - margin ' + (MODE - mode.top).toFixed(1) +
            ' units/s is not a counterplay anyone can feel');
        /* A LEAD MUST COST THE PLAYER SOMETHING. This is what replaced the
           counter-attack's assertion, and it is the same claim in the terms
           the design now uses: getting away from him has to make him faster,
           or a player who wins one exchange never sees him again. */
        say(led.top > hot.top + 3,
            'a 200-unit lead buys him almost nothing: ' + led.top.toFixed(1) +
            ' against ' + hot.top.toFixed(1) + ' alongside');
        say(led.pace > cold.pace,
            'he does not push harder for a lead than he does alongside');

        /* MONOTONIC IN THE GAP. A ceiling that is not monotonic is a boss who
           goes slower the further ahead you get, which is the shape that makes
           a chase feel random. */
        var prev = -1, mono = true;
        for (var gp = 0; gp <= 900; gp += 60) {
          var h = P.hunt(gp, { confidence: 1, playerV: BOOST });
          if (h.top < prev - 0.001) mono = false;
          prev = h.top;
        }
        say(mono, 'the ceiling is not monotonic in the gap');

        // ...and he must ease, not vanish, once HE is in front
        var ahead = P.hunt(-400, { confidence: 1, playerV: ENGINE });
        say(ahead.pace < cold.pace, 'he does not ease off at all when he is clear ahead');
        say(ahead.pace > 0.9, 'he gives up entirely when ahead (' + ahead.pace.toFixed(2) + ')');

        note(bad ? 'predator: ' + bad + ' BALANCE PROBLEM(S)' : 'predator: the balance holds');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'layout') {
      /* NOTHING MAY BE DRAWN THROUGH ANYTHING ELSE.
       *
       * "Fix the overlapping UI" is not a thing you can eyeball on a screen
       * that is laid out from a dozen constants in two files, and it is not a
       * thing a screenshot proves either - the collision that matters is the
       * one on the page you did not open. The layout is arithmetic, so it can
       * simply be checked: every band on the options screen and the title
       * screen is listed with the extent it actually occupies, and any two
       * that share a line are reported.
       */
      if (!g.__lay) {
        g.__lay = 1;
        var bad = 0;
        var check = function (name, list) {
          list.sort(function (a, b) { return b.hi - a.hi; });
          for (var i = 0; i < list.length; i++) {
            for (var j = i + 1; j < list.length; j++) {
              var A = list[i], B = list[j];
              if (A.lo < B.hi && B.lo < A.hi) {
                // ...unless they are side by side, which is not an overlap
                if (A.x !== undefined && B.x !== undefined &&
                    (A.x[1] <= B.x[0] || B.x[1] <= A.x[0])) continue;
                bad++;
                note('PROBLEM: ' + name + ' - ' + A.n + ' (' + A.lo.toFixed(0) + '..' +
                     A.hi.toFixed(0) + ') overlaps ' + B.n + ' (' + B.lo.toFixed(0) +
                     '..' + B.hi.toFixed(0) + ')');
              }
            }
          }
        };
        var band = function (n, y, h, x0, x1) {
          return { n: n, lo: y - h / 2, hi: y + h / 2, x: x0 === undefined ? undefined : [x0, x1] };
        };

        // ---------------------------------------------------- title screen --
        var menu = [
          band('SYNX', 196, 70, -140, 140),
          band('subtitle', 122, 20, -320, 320),
          band('rule', 101, 4, -235, 235),
          band('toast 1', 300, 34, -210, 210),
          band('toast 2', 254, 34, -210, 210),
        ];
        var ML = window.NR.MENU_LAYOUT, n3 = 3;
        for (var mi = 0; mi < n3; mi++) {
          menu.push(band('menu row ' + mi, ML.yFor(mi, n3), 78, -215, 215));
        }
        menu.push(band('BEST', ML.topFor(n3) - n3 * ML.gap - 8, 46, -150, 150));
        menu.push(band('footer', -330, 16, -400, 400));
        check('title', menu);
        note('layout: title screen, ' + menu.length + ' bands');

        // ------------------------------------------------- controls screen --
        var TABY = window.NR.CTL_TAB_Y, TABW = window.NR.CTL_TAB_W;
        var TABS = window.NR.CONTROL_TABS;
        for (var t = 0; t < TABS.length; t++) {
          var rows = window.NR.tabRows(t);
          var L = window.NR.CONTROLS_LAYOUTS[t];
          /* THE GAMEPAD PAGE IS NOT A LIST, so its rows are not full width.
             They move into the right-hand third and the controller diagram
             takes the space they leave - and a checker that assumed one column
             geometry for every page would report the diagram as colliding with
             rows it is nowhere near. */
          var padTab = t === 1;
          var rowX0 = padTab ? -56 : -485;
          var rowX1 = padTab ? 564 : 485;
          var list = [
            band('kicker', 314, 16, -200, 200),
            band('CONTROLS', 282, 30, -140, 140),
            band('legend', 280, 34, 180, 560),
            band('rule', 258, 4, -450, 450),
            band('tab strip', TABY, 42, window.NR.ctlTabX(0) - TABW / 2 - 11,
                 window.NR.ctlTabX(TABS.length - 1) + TABW / 2 + 11),
            band('SAVE AND BACK', L.exitY, 52, -235, 235),
            band('hint band', L.hintY, L.hintH, -500, 500),
          ];
          if (t === 0) list.push(band('RESET', L.exitY, 34, 250, 470));
          if (padTab) {
            /* The three things drawn only on this page. Their numbers are the
               ones js/hud.js draws with, so a move there that walked into the
               tab strip or off the bottom of the panel is caught here rather
               than in a screenshot nobody took. */
            /* The status text starts at cx-120 = -420 and runs RIGHT. Its
               longest line is "NO CONTROLLER DETECTED" at 17 units, which is
               about 230 wide, so it ends near -190 - well clear of the rows,
               which start at -56. The first version of this band claimed -40
               and was reported as colliding with three of them. */
            list.push(band('pad status', 157, 46, -430, -185));
            list.push(band('pad diagram', -196, 234, -524, -76));
            list.push(band('pad legend', -159, 152, 46, 560));
          }
          for (var ri = 0; ri < rows.length; ri++) {
            /* 26, not the 32 of the selection panel: only one row is ever
               selected, so two selection panels can never coexist, and the
               thing that must not collide is the TEXT - 19px, so about 20
               units, plus margin. */
            list.push(band('row ' + ri + ' ' + rows[ri].label, L.rows[ri], 26, rowX0, rowX1));
            if (rows[ri].group) {
              list.push(band('header ' + rows[ri].group, L.rows[ri] + 26, 14, rowX0, rowX1 - 15));
            }
          }
          // ...and everything has to be inside the panel it is drawn in
          var PY = -6, PH = 700;
          for (var li = 0; li < list.length; li++) {
            if (list[li].hi > PY + PH / 2 || list[li].lo < PY - PH / 2) {
              bad++;
              note('PROBLEM: controls tab ' + t + ' - ' + list[li].n + ' (' +
                   list[li].lo.toFixed(0) + '..' + list[li].hi.toFixed(0) +
                   ') is outside the panel');
            }
          }
          check('controls tab ' + t, list);
          note('layout: controls tab ' + t + ' (' + TABS[t] + '), ' + list.length +
               ' bands, rows ' + L.rows[0] + '..' + L.rows[L.rows.length - 1] +
               ', exit ' + L.exitY.toFixed(0) + ', hint ' + L.hintY.toFixed(0));
        }
        // ---------------------------------------------------- pause card --
        var PPY = 10, PPH = 492;
        var pause = [
          band('PAUSED', 186, 44, -120, 120),
          band('rule', 146, 4, -215, 215),
          band('route name', 112, 20, -260, 260),
          band('percent', 84, 16, -180, -30),
          band('clock', 84, 16, 30, 180),
          band('progress rail', 60, 8, -160, 160),
          band('autosave', 26, 13, -230, 230),
          band('footer', PPY - PPH / 2 + 26, 17, -280, 280),
        ];
        for (var pi = 0; pi < 3; pi++) {
          // menuList: rows 64 apart from -12, brackets 0.97 of the gap
          pause.push(band('pause row ' + pi, -12 - pi * 64, 62, -195, 195));
        }
        for (var qi = 0; qi < pause.length; qi++) {
          if (pause[qi].hi > PPY + PPH / 2 || pause[qi].lo < PPY - PPH / 2) {
            bad++;
            note('PROBLEM: pause - ' + pause[qi].n + ' (' + pause[qi].lo.toFixed(0) +
                 '..' + pause[qi].hi.toFixed(0) + ') is outside the card');
          }
        }
        check('pause', pause);
        note('layout: pause card, ' + pause.length + ' bands');

        note('layout: ' + (bad ? bad + ' COLLISION(S)' : 'no collisions'));
        PROBE = '';
      }
      return;
    } else if (PROBE === 'options') {
      /* THE OPTIONS SCREEN, BOTH PAGES, EVERY ROW.
       *
       * The controls page is new and it is drawn from a different row shape
       * than the one the painter was written for - a binding row has no option
       * list, no meter and no chevrons - so the thing worth proving is simply
       * that every row of every page paints and hit-tests without throwing,
       * and that a rebind actually reaches the input layer.
       */
      if (!g.__opt) {
        g.__opt = { t: 0, step: 0, tab: 0 };
        g.state = 'controls';
        g.setOptionTab(0);
        g.controlIndex = 0;
        note('controls: page 0 has ' + g.settingRows.length + ' rows');
      }
      var O = g.__opt;
      O.t += g.__realDt || 0.016;
      /* WALK EVERY PAGE, not two of them. The screen went from two pages to
         three - KEYBOARD, GAMEPAD, MOUSE - and a probe that stopped at page
         one would have left the whole controller page, which is the one with
         a live diagram on it, unvisited. Reading the tab count rather than
         naming it means a fourth page is covered the day it is added. */
      var TABS = (window.NR.CONTROL_TABS || []).length || 1;
      if (O.step === 0) {
        g.controlIndex = (g.controlIndex + 1) % (g.settingRows.length + 1);
        if (g.controlIndex === 0) {
          O.tab++;
          if (O.tab >= TABS) { O.step = 2; g.setOptionTab(0); return; }
          g.setOptionTab(O.tab);
          note('controls: page ' + O.tab + ' has ' + g.settingRows.length + ' rows, ' +
               g.settingRows.filter(function (r) { return r.bind; }).length + ' of them bindings');
        }
        return;
      }
      if (O.step === 2) { O.step = 3; g.controlIndex = -1; return; }
      if (O.step === 3) {
        O.step = 4;
        g.controlIndex = 0;
        g.beginBind('throttle');
        if (!g.input.captureNext) { note('PROBLEM: beginBind armed no capture'); PROBE = ''; return; }
        g.input.captureNext('t');
        var got = g.input.keysFor('throttle');
        note('controls: throttle rebound -> [' + got.join(', ') + ']');
        if (got[0] !== 't') note('PROBLEM: the rebind did not reach Input');
        g.beginBind('boost');
        g.input.captureNext('t');
        note('controls: boost took T -> throttle [' +
             g.input.keysFor('throttle').join(', ') + ']  boost [' +
             g.input.keysFor('boost').join(', ') + ']');
        g.resetBinds();
        note('controls: after reset, throttle [' + g.input.keysFor('throttle').join(', ') + ']');
        /* THE ROUND TRIP. A rebind that does not survive the save file is a
           rebind that lasts until the player closes the game, and the
           validation loop that reads it back is the only new code on that
           path - so it is walked rather than assumed. */
        g.beginBind('boost');
        g.input.captureNext('n');
        g.saveAndExitControls();
        var raw = window.NR.Save.getJSON('synx.settings.v1', null);
        note('controls: saved binds.boost = [' +
             ((raw && raw.binds && raw.binds.boost) || ['MISSING']).join(', ') + ']');
        if (!raw || !raw.binds || !raw.binds.boost || raw.binds.boost[0] !== 'n') {
          note('PROBLEM: the rebind did not reach the save file');
        }
        g.state = 'controls';
        return;
      }
      if (O.step === 4 && O.t > 6) {
        O.step = 5;
        note('controls: every page painted without error');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'multiplayer') {
      /* THE WHOLE MULTIPLAYER STACK, IN A REAL BROWSER, AGAINST A REAL SERVER.
       *
       * Everything under this has its own tests - the wire format round-trips
       * in cargo test, the interpolator has ten of its own, the server has
       * fifty and an integration harness. What none of them can reach is the
       * seam: the driver terminal opening the screen, the screen registering,
       * the WebAssembly proof of work landing on a challenge the server
       * accepts, the socket opening from inside a web view, and the lobby
       * painting a room without throwing.
       *
       * That seam is exactly where a multiplayer feature breaks, because it is
       * the only part that cannot be tested without all of it at once.
       */
      if (!g.__mp) {
        g.__mp = { t: 0, step: 0, seen: {} };
        note('multiplayer: server ' + (window.SYNX_SERVER || '(default)'));
      }
      var P = g.__mp;
      P.t += g.__realDt || 0.016;
      var net = window.NR && window.NR.Net;
      var mp = g.multiplayer;
      if (!net || !mp) {
        // Game.load resolves after the world is built, and the probe's first
        // frames arrive before it. Waiting is the correct behaviour; giving up
        // is only correct once it is clear nothing is coming.
        if (P.t > 25) { note('PROBLEM: multiplayer did not load'); PROBE = ''; }
        return;
      }

      if (P.step === 0 && !P.ready) { P.ready = 1; P.t = 0; }
      if (P.step === 0 && P.t > 1.0) {
        P.step = 1;
        // through the front door: the title, then the driver terminal
        g.modeSelect.open();
        var cards = g.modeSelect.cards || [];
        note('multiplayer: driver terminal has ' + cards.length + ' cards: ' +
             cards.map(function (c) { return c.getAttribute('data-mode'); }).join(', '));
        if (cards.length !== 3 || cards[1].getAttribute('data-mode') !== 'multiplayer') {
          note('PROBLEM: MULTIPLAYER is not the middle card');
        }
        // and it is not gated, unlike the open route
        if (cards[1].classList.contains('locked')) {
          note('PROBLEM: the multiplayer card is locked');
        }
        cards[1].click();
        note('multiplayer: opened, view=' + mp.view);
        return;
      }
      if (P.step === 1 && P.t > 1.6) {
        P.step = 2;
        // first run asks who is driving
        if (mp.view !== 'name') note('PROBLEM: the first session did not ask for a name');
        mp.ui.nameInput.value = 'SMOKE';
        mp.commitName();
        note('multiplayer: registered as ' + net.name + ', view=' + mp.view);
        return;
      }
      if (P.step === 2) {
        if (net.online) {
          P.step = 3;
          P.t = 0;
          // The welcome is the first message after the socket opens, so the
          // route list arrives a beat after the socket does; it is checked at
          // the next step rather than in the same frame.
          note('multiplayer: link up in ' + (net.session ? 'a session' : 'no session'));
          net.createRoom(2, false);
          return;
        }
        if (P.t > 45) { note('PROBLEM: never came online (' + net.state + ': ' + (net.lastError || '') + ')'); PROBE = ''; }
        return;
      }
      if (P.step === 3 && P.t > 1.2) {
        P.step = 4;
        P.t = 0;
        var room = net.room;
        if (!room) { note('PROBLEM: the room never arrived'); PROBE = ''; return; }
        if ((net.maps || []).length !== 7) {
          note('PROBLEM: the server offered ' + (net.maps || []).length + ' routes');
        } else {
          note('multiplayer: ' + net.maps.length + ' routes offered: ' +
               net.maps.map(function (x) { return x.name; }).join(', '));
        }
        note('multiplayer: room ' + room.code + ' on ' + (net.maps[room.map] || {}).name +
             ', host=' + net.isHost + ', seats=' + room.max_players);
        if (mp.view !== 'room') note('PROBLEM: the lobby did not switch to the room view');
        // the room view painted: count what it drew
        var seats = mp.ui.main.querySelectorAll('.mp-seat').length;
        var maps = mp.ui.main.querySelectorAll('.mp-map').length;
        note('multiplayer: room view painted ' + seats + ' seats and ' + maps + ' routes');
        // The probe is the host, so it gets the full route grid; a guest is
        // shown only the one the host picked.
        if (seats !== 4 || maps !== 7) note('PROBLEM: the room view is missing tiles');
        // There is one car now, and it is stated rather than offered.
        if (mp.ui.side.querySelector('[data-mp="ruleset"]')) {
          note('PROBLEM: the car is still a control');
        }
        if (!mp.ui.side.querySelector('.mp-fact')) note('PROBLEM: the car is not stated');
        net.listRooms();
        // the host can move the route
        net.setMap(5);
        return;
      }
      if (P.step === 4 && P.t > 2.5) {
        P.step = 5;
        P.t = 0;
        var listed = (mp.rooms || []).some(function (r) { return net.room && r.code === net.room.code; });
        note('multiplayer: listing carries ' + (mp.rooms || []).length + ' room(s), mine listed=' + listed);
        if (!listed) note('PROBLEM: a public room is not in the listing');
        if (net.room && net.room.map !== 5) note('PROBLEM: the host could not change the route');
        else note('multiplayer: route changed to ' + (net.maps[net.room.map] || {}).name);
        // the clock, which everything about a countdown depends on
        var st = net.stats();
        note('multiplayer: clock ' + (st.synced ? 'synced' : 'NOT SYNCED') +
             ', rtt ' + Math.round(st.rtt) + ' ms, buffer ' + Math.round(st.delay) + ' ms');
        if (!st.synced) note('PROBLEM: the clock never settled');
        net.leaveRoom();
        return;
      }
      if (P.step === 5 && P.t > 1.0) {
        P.step = 6;
        mp.back();
        note('multiplayer: left cleanly, state=' + g.state);
        if (net.online || net.inRoom) note('PROBLEM: the link survived leaving');
        if (mp.shown) note('PROBLEM: the lobby is still shown after leaving');
        if (mp.racing || mp.results) note('PROBLEM: race state survived leaving');
        note('multiplayer: teardown clean, online=' + net.online + ' inRoom=' + net.inRoom);
        note('multiplayer: ok');
        PROBE = '';
        return;
      }
      return;
    } else if (PROBE === 'ui') {
      /* THE SCREENS THAT ONLY EXIST AFTER SOMETHING HAPPENS.
       *
       * The podium needs a finished race, the verdict needs somebody to have
       * beaten somebody, the race menu needs a race in progress and the server
       * dialog needs a wrong address typed into it. Driving all four for real
       * would take four races and most of an hour, and the thing being checked
       * is not the race - it is whether these panels build without throwing and
       * put the right elements on the screen.
       *
       * So each one is handed exactly the input it reacts to and then read back
       * out of the DOM. It is not a substitute for playing the game; it is the
       * difference between "this has never rendered once" and "this renders,
       * with the right things in it, and does not throw".
       */
      if (!g.__ui) { g.__ui = { t: 0, step: 0 }; }
      var U = g.__ui;
      U.t += g.__realDt || 0.016;
      var net = window.NR && window.NR.Net;
      var mp = g.multiplayer;
      if (!net || !mp) {
        if (U.t > 25) { note('PROBLEM: multiplayer did not load'); PROBE = ''; }
        return;
      }

      if (U.step === 0 && U.t > 1.0) {
        U.step = 1; U.t = 0;
        g.modeSelect.open();
        (g.modeSelect.cards || [])[1].click();
        if (mp.view === 'name') { mp.ui.nameInput.value = 'UIPROBE'; mp.commitName(); }
        note('ui: opened multiplayer, view=' + mp.view);
        return;
      }

      /* ---- THE PODIUM AND THE VERDICT ------------------------------------
         Four cars, two of them finishing within half a second of each other and
         one not finishing at all - which exercises the ordering, the medal
         classes, the DNF row and the "who beat who" line in one go. */
      if (U.step === 1 && U.t > 1.2) {
        U.step = 2; U.t = 0;
        net.slot = 1; // we are SECOND, so the verdict is a gap to the winner
        try {
          mp.onResults({
            map: 0,
            hold_ms: 20000,
            rows: [
              { slot: 0, name: 'ALFA',  place: 1, time_ms: 61230, progress: 1, dnf: false, corrections: 0 },
              { slot: 1, name: 'BRAVO', place: 2, time_ms: 61650, progress: 1, dnf: false, corrections: 2 },
              { slot: 2, name: 'CHARLIE', place: 3, time_ms: 64010, progress: 1, dnf: false, corrections: 0 },
              { slot: 3, name: 'DELTA', place: 4, time_ms: null, progress: 0.42, dnf: true, corrections: 0 }
            ]
          });
        } catch (e) { note('PROBLEM: onResults threw: ' + e.message); PROBE = ''; return; }

        var pod = document.getElementById('mpPodium');
        var steps = pod ? pod.querySelectorAll('.mp-step') : [];
        note('ui: podium rendered ' + steps.length + ' steps, hidden=' + (pod && pod.hidden));
        if (steps.length !== 3) note('PROBLEM: the podium did not build three steps');
        else {
          var order = [];
          for (var i = 0; i < steps.length; i++) {
            order.push(steps[i].className.replace(/[^ ]*is-p(\d)[^ ]*/, '$1').trim().slice(0, 40));
          }
          var names = [];
          for (var j = 0; j < steps.length; j++) names.push(steps[j].querySelector('span').textContent);
          note('ui: podium reads left-to-right: ' + names.join(' | '));
          if (names[0] !== 'BRAVO' || names[1] !== 'ALFA' || names[2] !== 'CHARLIE') {
            note('PROBLEM: the podium is not 2-1-3');
          }
          if (!steps[1].classList.contains('is-p1')) note('PROBLEM: the middle step is not first place');
          if (!steps[0].classList.contains('is-you')) note('PROBLEM: our own step is not marked');
        }

        var verdict = document.getElementById('mpVerdict');
        note('ui: verdict = "' + (verdict ? verdict.textContent : '(missing)') + '"');
        if (!verdict || verdict.hidden || verdict.textContent.indexOf('ALFA') < 0) {
          note('PROBLEM: the verdict does not name the car ahead');
        }
        var title = document.getElementById('mpResultsTitle');
        note('ui: results title = "' + (title ? title.textContent : '') + '" class=' + (title ? title.className : ''));
        if (!title || title.textContent !== 'SECOND') note('PROBLEM: the title does not read SECOND');

        var rows = document.querySelectorAll('#mpResultsRows .mp-result');
        var dnf = document.querySelectorAll('#mpResultsRows .mp-result.is-dnf').length;
        note('ui: full board has ' + rows.length + ' rows, ' + dnf + ' marked DNF');
        if (rows.length !== 4 || dnf !== 1) note('PROBLEM: the full board is wrong');
        return;
      }

      /* ---- THE SERVER CHECK ---------------------------------------------- */
      if (U.step === 2 && U.t > 0.6) {
        U.step = 3; U.t = 0;
        mp.dismissResults(false);
        var checks = [
          ['not-a-url', 'rejected: not an address'],
          ['http://127.0.0.1:1', 'rejected: nothing listening'],
          [window.SYNX_SERVER || 'http://127.0.0.1:18080', 'accepted: the real server']
        ];
        var done = 0;
        checks.forEach(function (c) {
          net.probe(c[0]).then(function (r) {
            note('ui: probe(' + c[0] + ') -> ok=' + r.ok + (r.why ? ' why="' + r.why + '"' : '')
                 + (r.build ? ' build=' + r.build : ''));
            done++;
            if (done === checks.length) g.__ui.probesDone = true;
          });
        });
        return;
      }

      /* ---- THE RACE MENU, and where the standings card lands -------------- */
      if (U.step === 3 && U.t > 3.0) {
        U.step = 4; U.t = 0;
        if (!g.__ui.probesDone) note('PROBLEM: a server probe never answered');

        // placeHud puts the card under the score stack in HUD virtual space.
        var hud = g.hud;
        mp.placeHud();
        var card = document.getElementById('mpHud');
        var top = parseFloat(card.style.top);
        // The multiplier sits at virtual y=216; the card must be below it.
        var comboY = hud.vy(216);
        note('ui: score multiplier at y=' + Math.round(comboY)
             + 'px, standings card top=' + Math.round(top) + 'px, window=' + hud.h + 'px');
        if (!(top > comboY)) note('PROBLEM: the standings card is not below the multiplier');
        if (top > hud.h * 0.6) note('PROBLEM: the standings card is absurdly low');

        // The race menu, with racing faked so the menu believes there is one.
        mp.racing = true;
        try { mp.confirmLeaveRace(); }
        catch (e) { note('PROBLEM: the race menu threw: ' + e.message); }
        var choices = document.querySelectorAll('#mpDialogChoices .mp-choice');
        var labels = [];
        for (var k = 0; k < choices.length; k++) labels.push(choices[k].querySelector('b').textContent);
        note('ui: race menu offers ' + choices.length + ': ' + labels.join(' / '));
        if (choices.length !== 4) note('PROBLEM: the race menu is not four choices');
        var okBtn = document.getElementById('mpDialogOk');
        if (okBtn && !okBtn.hidden) note('PROBLEM: the confirm row is showing under a choice list');
        mp.closeDialog(null);
        mp.racing = false;
        U.step = 5; U.t = 0;
        return;
      }

      /* ---- THE "CLEAN" MULTIPLIER --------------------------------------
         It used to tick up every twelve seconds whatever the car was doing,
         so a parked car collected CLEAN x2, x3, x4 for nothing. Driven
         directly here rather than by waiting: thirty simulated seconds of a
         stationary car, then thirty of a moving one, and the multiplier must
         only move in the second half. */
      if (U.step === 5) {
        U.step = 6;
        var before = g.combo;
        var toasts = 0;
        var realToast = g.hud.toast;
        g.hud.toast = function (t, c) { if (String(t).indexOf('CLEAN') === 0) toasts++; return realToast.call(g.hud, t, c); };

        var savedSpeed = g.car.speed, savedDrift = g.car.driftAmount;
        g.car.speed = 0; g.car.driftAmount = 0; g.cleanTime = 0; g.combo = 1;
        for (var n = 0; n < 1800; n++) g.updateScore(1 / 60);   // 30 s parked
        var parkedCombo = g.combo, parkedToasts = toasts;

        g.car.speed = 40; g.car.driftAmount = 0;
        for (var m2 = 0; m2 < 1800; m2++) g.updateScore(1 / 60); // 30 s moving
        var movingCombo = g.combo, movingToasts = toasts;

        g.hud.toast = realToast;
        g.car.speed = savedSpeed; g.car.driftAmount = savedDrift;
        g.combo = before; g.cleanTime = 0;

        note('ui: clean multiplier — parked 30s: combo ' + parkedCombo + ', ' + parkedToasts
             + ' toast(s); then moving 30s: combo ' + movingCombo + ', ' + movingToasts + ' toast(s)');
        if (parkedToasts !== 0 || parkedCombo !== 1) {
          note('PROBLEM: a parked car still earns CLEAN');
        }
        if (movingToasts < 2) note('PROBLEM: a moving car stopped earning CLEAN');
        note('ui: ok');
        PROBE = '';
        return;
      }
      return;
    } else if (PROBE === 'ghost' && step >= 1) {
      /* IS TRIAL 05 ACTUALLY BEATABLE?
       *
       * The commit window is only a fair window if the escape it asks for fits
       * inside it, and that depends on the car's real lateral grip at the
       * trial's speed cap - a number no amount of reading the source produces.
       * So the trial is played, by the only policy the design intends: sit
       * still while the arch is tracking, and go the moment it commits.
       *
       * If a policy that does exactly what the trial tells you to do cannot
       * break three of five, the window is too short. If it breaks five of
       * five without trying, it is too long.
       */
      if (!g.__gh) {
        // the director gates on being inside chapter 6's race, the same way
        // chapter 7's does - see the chapter7 probe
        var CH6 = (window.NR && NR.STORY_CHAPTERS) || [];
        for (var c6 = 0; c6 < CH6.length; c6++) if (CH6[c6] && CH6[c6].id === 6) g.story.chapter = CH6[c6];
        g.story.mode = 'race';
        var d6i = g.__level6Director;
        if (!d6i && window.NR && NR.Level6Director) d6i = new NR.Level6Director(g);
        if (!d6i) { note('PROBLEM: no level 6 director on this route'); PROBE = ''; return; }
        note('ghost: level6=' + !!(g.level && g.level.level6) + ' chapter=' + (g.story.chapter && g.story.chapter.id));
        /* Let the director start itself on its own update first - forcing the
           phase before that happens just gets overwritten by start(). */
        if (!d6i.started) return;
        d6i.phase = 'ghost';
        d6i.ghostBroken = 0; d6i.ghostClamped = 0; d6i.ghostHabit = 0;
        for (var ai = 0; ai < d6i.arches.length; ai++) {
          var aa = d6i.arches[ai];
          aa.armed = false; aa.done = false; aa.committed = false;
          aa.predicted = 0; aa.aim = 0; aa.hit = false;
        }
        /* --at <n> runs one arch rather than the set: five of them at the
           trial's speed cap is twenty minutes of a headless browser, and the
           question being asked is usually about one tier. */
        var only = AT === '' ? -1 : (parseInt(AT, 10) || 0);
        var startArch = only < 0 ? 0 : Math.max(0, Math.min(4, only));
        // skipped, not played - so the report below does not claim them
        for (var si = 0; si < startArch; si++) { d6i.arches[si].done = true; d6i.arches[si].skipped = true; }
        g.story.setVehicle(g.car, d6i.arches[startArch].s - 300, 0, 50);
        d6i.phaseTime = 0; d6i.failTimer = 0;
        g.__gh = { t: 0, dir: 1, seen: {}, only: only };
        note('ghost: placed 300u before arch 0' + (startArch + 1) +
             (only < 0 ? ', five arches to run' : ', that one only'));
      }
      var G = g.__gh, d6 = g.__level6Director, dtg = g.__realDt || 0.016;
      G.t += dtg;
      g.input.keys['arrowup'] = true;
      // the nearest arch still ahead of the car
      var cur = null;
      for (var bi = 0; bi < d6.arches.length; bi++) {
        var b = d6.arches[bi];
        if (!b.done && b.s > g.car.sTrack - 4) { cur = b; break; }
      }
      g.input.keys['arrowleft'] = false; g.input.keys['arrowright'] = false;
      if (cur) {
        if (!G.seen[cur.tier] && cur.committed) {
          G.seen[cur.tier] = 1;
          // alternate, because the model punishes repeating a direction
          G.dir = -G.dir;
          note('ghost: arch 0' + (cur.tier + 1) + ' committed at ' +
               (cur.s - g.car.sTrack).toFixed(0) + 'u, ' +
               ((cur.s - g.car.sTrack) / Math.max(1, g.car.speed)).toFixed(2) + 's out' +
               '  lat=' + (g.car.lateral || 0).toFixed(1) +
               '  clamp=' + cur.predicted.toFixed(1));
        }
        if (!cur.committed && LOOK === 'early') {
          /* THE OLD EXPLOIT, AS A TEST.
             The trial this replaced could be beaten by steering away as soon
             as the arch lit and then doing nothing else. If that still works
             the redesign did not happen, so it is played deliberately: go
             early, hold, and see what the clamp does about it. */
          var eoff = (g.car.lateral || 0) - cur.predicted;
          if (Math.abs(eoff) < 12) g.input.keys[G.dir > 0 ? 'arrowright' : 'arrowleft'] = true;
        }
        if (cur.committed && LOOK === 'early') {
          // ...and nothing at all once it commits. That was the whole trick.
        } else if (cur.committed) {
          /* Go, away from where it called - and STOP once clear, because
             holding full lock all the way to the arch runs the car into the
             barrier and reports a margin that says nothing about whether the
             window was long enough. */
          var off = (g.car.lateral || 0) - cur.predicted;
          var need = (window.__ghostTiers ? window.__ghostTiers[cur.tier].catch : 6) + 1.6;
          var away = Math.abs(off) < 1.0 ? G.dir : (off >= 0 ? 1 : -1);
          if (Math.abs(off) < need) g.input.keys[away > 0 ? 'arrowright' : 'arrowleft'] = true;
          else if (Math.abs(g.car.vLat || 0) > 2) g.input.keys[away > 0 ? 'arrowleft' : 'arrowright'] = true;
        }
      }
      G.tick = (G.tick || 0) + dtg;
      if (G.tick > 3 && cur) {
        G.tick = 0;
        note('ghost: .. ' + (cur.s - g.car.sTrack).toFixed(0) + 'u out  lat=' +
             (g.car.lateral || 0).toFixed(1) + '  clamp=' + cur.predicted.toFixed(1) +
             '  aim=' + cur.aim.toFixed(1) + '  v=' + (g.car.speed || 0).toFixed(0) +
             (cur.committed ? '  COMMITTED' : ''));
      }
      // ...and what the margin actually was, arch by arch
      for (var ri = 0; ri < d6.arches.length; ri++) {
        var rr = d6.arches[ri];
        if (rr.done && !rr.skipped && !G['r' + ri]) {
          G['r' + ri] = 1;
          var cw = window.__ghostTiers ? window.__ghostTiers[rr.tier] : null;
          note('ghost: arch 0' + (rr.tier + 1) + (rr.hit ? ' CLAMPED' : ' BROKEN') +
               '  miss=' + Math.abs((g.car.lateral || 0) - rr.predicted).toFixed(1) +
               'u  catch=' + (cw ? cw.catch : '?') +
               'u  window=' + (cw ? (cw.commit / 50).toFixed(2) : '?') + 's' +
               '  v=' + (g.car.speed || 0).toFixed(0));
        }
      }
      if (!G.done && G.only >= 0 && d6.arches[Math.max(0, Math.min(4, G.only))].done) {
        G.done = true; PROBE = '';
        note('ghost: single-arch run finished');
      }
      if (!G.done && (d6.phase !== 'ghost' || d6.arches.every(function (x) { return x.done; }))) {
        G.done = true;
        note('ghost: RESULT broken=' + d6.ghostBroken + '/5  clamped=' + d6.ghostClamped +
             '  (three broken is a pass)');
        PROBE = '';
      }
      if (G.t > 90 && !G.done) { G.done = true; note('ghost: timed out, broken=' + d6.ghostBroken); PROBE = ''; }
      return;
    } else if (PROBE === 'fps' && step >= 1) {
      /* THE FRAME COUNTER AND THE FRAME LIMIT.
         Both were rows that applied to nothing, so both are checked by their
         effect rather than by their value: does a counter exist and report a
         plausible rate, and does asking for a cap actually change the interval
         the loop runs at. */
      var Q = g.__fps || (g.__fps = { t: 0, phase: 0, uncapped: 0, capped: 0, n: 0 });
      Q.t++;
      if (Q.phase === 0) {
        // the sampler has to exist and be filling in
        if (Q.t < 12) return;
        if (!g.fps) { note('PROBLEM: the game keeps no frame statistics'); PROBE = ''; return; }
        note('fps: counter reports ' + (g.fps.now || 0).toFixed(1) + ' FPS, worst ' +
             (g.fps.worst || 0).toFixed(1));
        if (!(g.fps.now > 0)) note('PROBLEM: the counter never produced a rate');
        // the overlay has to be gated on the setting, and the setting has to
        // reach the renderer
        if (g.showFps !== (g.settings.fpsShow === 1))
          note('PROBLEM: the FPS COUNTER row does not reach the renderer');
        g.settings.fpsShow = 1;
        g.applySettings();
        if (!g.showFps) note('PROBLEM: turning the FPS COUNTER on did nothing');
        else note('fps: the overlay follows the setting');
        /* THE CAP. Measured as the interval the loop is willing to run at,
           because a software rasteriser cannot reach any of the capped rates
           and so cannot demonstrate one by frame rate alone. What is being
           checked is that the row reaches the loop at all - which is exactly
           what it did not do before. */
        var caps = window.NR.Settings.FPS_CAPS;
        var seen = [];
        for (var i = 0; i < caps.length; i++) {
          g.settings.fps_cap = i;
          g.applySettings();
          seen.push(caps[i] + '=>' + (g.frameInterval || 0).toFixed(2));
          var want = caps[i] > 0 ? 1000 / caps[i] : 0;
          if (Math.abs((g.frameInterval || 0) - want) > 0.01) {
            note('PROBLEM: FRAME LIMIT ' + caps[i] + ' produced an interval of ' +
                 (g.frameInterval || 0));
          }
        }
        note('fps: cap -> interval  ' + seen.join('  '));
        /* ...and the interval has to actually SKIP frames, not merely exist.
           Asserted by holding the game clock still: with an interval longer
           than the harness's own frame time, the loop must decline to run -
           so g.time stops advancing even though rAF keeps firing. */
        g.settings.fps_cap = 0;
        g.applySettings();
        g.frameInterval = 100000;          // one frame every 100 seconds
        Q.mark = g.time;
        Q.markT = Q.t;
        Q.phase = 1;
        return;
      }
      if (Q.phase === 1) {
        if (Q.t - Q.markT < 8) return;
        var moved = g.time - Q.mark;
        note('fps: with the loop capped, the clock advanced ' + moved.toFixed(3) +
             's over ' + (Q.t - Q.markT) + ' animation frames');
        if (moved > 0.001) note('PROBLEM: the frame limit does not skip frames');
        g.frameInterval = 0;               // hand the game back
        Q.phase = 2;
        PROBE = '';
      }
      return;
    } else if (PROBE === 'bonnet' && step >= 1) {
      /* THE BONNET VIEW, MEASURED.
       *
       * This replaced two probes - cabin and cockpit - that measured a
       * generated interior against the frame. There is no interior any more:
       * the shipped car is an exterior model whose cabin volume is shorter
       * than a seated person, so the first-person eye was moved onto the nose
       * where the car has geometry that is meant to be looked at.
       *
       * Three questions, and a view that fails any of them looks broken in a
       * way the other two cannot tell you about:
       *
       *   Is the eye ON the car - ahead of its centre, above its bodywork?
       *   Is the car's own front in the frame, below the axis, not filling it?
       *   Is the near plane close enough not to eat the bonnet?
       */
      /* SET THE VIEW, THEN LET THE GAME RUN A FRAME. camMode is an input to
         the camera update, not the camera: setting it and measuring g.eye in
         the same tick reads where the CHASE camera left the eye last frame,
         which is eleven units behind the car and reports a bonnet view that
         is nowhere near the bonnet. */
      var N = g.__bn || (g.__bn = { t: 0 });
      N.t++;
      if (N.t === 1) { g.camMode = 1; return; }
      if (N.t < 3) return;
      if (!N.done) {
        N.done = 1;
        var sc = g.scene;
        var real = sc.drawPart, tally = [];
        sc.drawPart = function (p, m) {
          var mm = m || (p && p.m);
          if (mm) tally.push({ n: (p.mat && p.mat.name) || '?', x: mm[12], y: mm[13], z: mm[14] });
          return real.call(sc, p, m);
        };
        try { g.draw(1 / 60); } finally { sc.drawPart = real; }
        var e = g.eye, tg = g.target, car = g.car;
        var fx = tg[0] - e[0], fy = tg[1] - e[1], fz = tg[2] - e[2];
        var fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
        // where the eye sits relative to the car it is riding
        var dx = e[0] - car.x, dy = e[1] - car.y, dz = e[2] - car.z;
        var along = dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw);
        note('bonnet: eye is ' + along.toFixed(2) + 'u ahead of the car centre, ' +
             dy.toFixed(2) + 'u above it, fov ' + (g.fov || 0).toFixed(0) +
             ', near ' + (g.camNear || 0).toFixed(3));
        if (!(along > 1.0 && along < 3.2)) note('PROBLEM: the eye is not on the nose');
        if (!(dy > 0.0 && dy < 1.6)) note('PROBLEM: the eye is not just above the bodywork');
        // ...and how much of the car is in shot, in degrees below the axis
        var vfov = (g.fov || 70) / 2;
        var lo = 999, hi = -999, seen = 0;
        for (var i = 0; i < tally.length; i++) {
          var q = tally[i];
          var qx = q.x - e[0], qy = q.y - e[1], qz = q.z - e[2];
          var f = qx * fx + qy * fy + qz * fz;
          if (f < 0.02 || f > 6) continue;         // only the car the eye is on
          var v = Math.atan2(qy - fy * f, f) * 180 / Math.PI;
          lo = Math.min(lo, v); hi = Math.max(hi, v); seen++;
        }
        note('bonnet: ' + seen + ' parts of the car within 6u, ' +
             (seen ? lo.toFixed(0) + ' to ' + hi.toFixed(0) + ' deg vertically' : 'none') +
             ' against a half-frame of ' + vfov.toFixed(0) + ' deg');
        if (!seen) note('PROBLEM: no bodywork in front of the eye - the view is floating');
        else if (hi > 0) note('PROBLEM: the car is up in the sky part of the frame');
        else if (lo < -vfov) note('bonnet: some of the car is below the frame, which is fine');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'driver' && step >= 1) {
      /* DOES THE DRIVER'S HEAD COME THROUGH THE ROOF?
       *
       * It did: the helmet was a shell of scale 0.42 centred at y 0.20 in
       * figure space, so its crown reached 0.41 against a roof that is between
       * 0.323 and 0.385 over the seat. This walks the real figure through the
       * real matrices and reports the highest point of it against the highest
       * point of the car, in world space, which is the only version of the
       * question that cannot be argued with.
       */
      if (!g.__drv) {
        g.__drv = 1;
        var sc = g.scene;
        var real = sc.drawPart, body = -1e9, head = -1e9, parts = 0;
        var cx = g.car.x, cz = g.car.z;
        /* The top of a part, in world space, from whatever its shape gives:
           an imported mesh carries its own AABB and the eight corners of it
           go through the matrix exactly; a generated driver piece does not,
           and every one of them is a unit shape centred on its origin, so
           half the length of the matrix column IS its half height. Compare
           an origin against a top and the answer is meaningless, which is
           what the first version of this probe did. */
        function topOf(mm, mesh) {
          var bb = mesh && mesh.aabb;
          if (!bb) return mm[13] + Math.hypot(mm[4], mm[5], mm[6]) * 0.5;
          var hi = -1e9;
          for (var c = 0; c < 8; c++) {
            var x = (c & 1) ? bb[3] : bb[0];
            var y = (c & 2) ? bb[4] : bb[1];
            var z = (c & 4) ? bb[5] : bb[2];
            var wy = mm[1] * x + mm[5] * y + mm[9] * z + mm[13];
            if (wy > hi) hi = wy;
          }
          return hi;
        }
        sc.drawPart = function (p, m) {
          var mm = m || (p && p.m);
          var nm = (p.mat && p.mat.name) || '';
          if (mm && Math.hypot(mm[12] - cx, mm[14] - cz) < 4) {
            var top = topOf(mm, p.mesh);
            if (/^Driver(Helmet|Visor|Peak)/.test(nm)) { head = Math.max(head, top); parts++; }
            else if (!/^Driver/.test(nm)) body = Math.max(body, top);
          }
          return real.call(sc, p, m);
        };
        try { g.draw(1 / 60); } finally { sc.drawPart = real; }
        note('driver: ' + parts + ' head parts, crown at y ' + head.toFixed(3) +
             ', the roof of the car at y ' + body.toFixed(3) +
             ' (clearance ' + (body - head).toFixed(3) + 'u)');
        /* DO THE HANDS ACTUALLY GO ROUND THE WHEEL?
         *
         * They used to turn on the spot: each glove was rotated about its own
         * origin by the steering angle, which spins a hand in place and leaves
         * it exactly where it was. From outside the car it reads as a driver
         * who is not holding anything.
         *
         * Two draws at opposite lock, and two questions about them. Did the
         * gloves MOVE - a hand on a rim at half a radian of wheel travels a
         * good fraction of the rim - and did they stay the same distance from
         * the hub, which is what tells a rotation about the hub apart from any
         * other way of moving a hand.
         */
        var poses = [];
        for (var pass = 0; pass < 2; pass++) {
          var hub = null, grip = [];
          sc.drawPart = function (q, m) {
            var mm = m || (q && q.m);
            var qn = (q.mat && q.mat.name) || '';
            var mn = (q.mesh && q.mesh.name) || '';
            if (mm && Math.hypot(mm[12] - g.car.x, mm[14] - g.car.z) < 4) {
              /* THE RIM, BY ITS MESH. The wheel, its spokes and the column
                               all wear the same material, and the column is drawn first -
                               so keying on the material name anchors the measurement to a
                               point on the steering column that does not move, and every
                               hand then looks like it is leaving the rim. Only the rim is
                               the rim. */
              if (mn === 'DriverRim' && !hub) hub = [mm[12], mm[13], mm[14]];
              /* ONE PASS ONLY. A frame draws this car more than once - the shadow
                               cascades and the reflection probe each submit it again - so a
                               collector that keeps taking gloves ends up comparing a hand
                               from one pass against a hub from another. The figure is drawn
                               hands-first, so the first two gloves and the first hub after
                               them are one pass by construction. */
                            else if (/^DriverGloveP$/.test(qn) && grip.length < 2) {
                              grip.push([mm[12], mm[13], mm[14]]);
                            }
            }
            return real.call(sc, q, m);
          };
          var was = g.car.steer;
          g.car.steer = pass ? 0.30 : -0.30;
          try { g.draw(1 / 60); } finally { sc.drawPart = real; g.car.steer = was; }
          poses.push({ hub: hub, grip: grip });
        }
        var A = poses[0], Bp = poses[1];
        if (!A.hub || A.grip.length < 2 || Bp.grip.length < 2) {
          note('PROBLEM: the wheel or the gloves were not drawn');
        } else {
          var moved = 0, radiusDrift = 0;
          for (var gi = 0; gi < 2; gi++) {
            var p0 = A.grip[gi], p1 = Bp.grip[gi];
            moved = Math.max(moved, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]));
            var r0 = Math.hypot(p0[0] - A.hub[0], p0[1] - A.hub[1], p0[2] - A.hub[2]);
            var r1 = Math.hypot(p1[0] - Bp.hub[0], p1[1] - Bp.hub[1], p1[2] - Bp.hub[2]);
            radiusDrift = Math.max(radiusDrift, Math.abs(r1 - r0));
            if (gi === 0) note('driver: grip radius ' + r0.toFixed(3) + 'u from the hub');
          }
          note('driver: lock to lock the gloves travel ' + moved.toFixed(3) +
               'u, and their radius changes by ' + radiusDrift.toFixed(4) + 'u');
          if (moved < 0.15) {
            note('PROBLEM: the hands barely move with the wheel - they are turning on the spot');
          }
          if (radiusDrift > 0.01) {
            note('PROBLEM: the hands leave the rim as the wheel turns');
          }
        }
        if (!parts) note('PROBLEM: the driver has no head');
        else if (head > body) note('PROBLEM: the head is through the roof by ' +
                                   (head - body).toFixed(3) + 'u');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'warnings' && step >= 1) {
      /* THE NETWORK WARNINGS, AND THE POPUP THEY ARRIVE IN.
       *
       * Three separate claims, and the first two are what the player
       * actually experiences:
       *
       *   A machine with no network is told so AT ONCE. It used to sit
       *   through two thirty-second attempts at a server it had no route to
       *   before saying anything, which reads as a game that has hung.
       *
       *   The card that says so is a real modal: it takes the keyboard, it
       *   traps it, and ESC gives it back. A warning that cannot be
       *   dismissed with a pad or a keyboard is a dead end.
       *
       *   The typewriter finishes. A message that stops halfway because its
       *   frame budget ran out is worse than one that never animated.
       */
      var W = g.__warn || (g.__warn = { t: 0 });
      W.t++;
      if (W.t === 1) {
        // the browser will not let this be assigned, but it can be shadowed
        try {
          Object.defineProperty(window.navigator, "onLine",
            { configurable: true, get: function () { return false; } });
          note("warnings: navigator.onLine forced to false");
        } catch (e) { note("warnings: could not fake onLine - " + e.message); }
        return;
      }
      if (W.t === 2) {
        if (!window.NR || !window.NR.UI) { note("PROBLEM: NR.UI was never loaded"); PROBE = ""; return; }
        // the net layer has to answer without waiting on a socket
        W.t0 = performance.now();
        window.NR.Net.probe("https://example.invalid").then(function (r) {
          var ms = performance.now() - W.t0;
          note("warnings: probe answered in " + ms.toFixed(0) + "ms, offline=" + !!r.offline
               + " why=" + JSON.stringify(r.why));
          if (!r.offline) note("PROBLEM: with no network, probe did not say so");
          if (ms > 2000) note("PROBLEM: probe took " + ms.toFixed(0) + "ms to notice there is no network");
          W.probed = 1;
        });
        // ...and the card itself
        window.NR.UI.alert({
          kind: "warn", title: "NO NETWORK",
          body: "This machine reports no connection, so there is nothing to reach.",
          note: "Reconnect and press TRY AGAIN.",
          actions: [{ label: "TRY AGAIN", value: "retry", primary: true },
                    { label: "BACK", value: "close" }],
          onClose: function (r) { W.closed = r === null ? "escape" : r; },
        });
        return;
      }
      if (W.t === 3) {
        var card = document.querySelector(".ui-modal .ui-card");
        if (!card) { note("PROBLEM: the warning card did not render"); PROBE = ""; return; }
        var r = card.getBoundingClientRect();
        note("warnings: card is " + Math.round(r.width) + "x" + Math.round(r.height) + " at " +
             Math.round(r.left) + "," + Math.round(r.top));
        if (r.width < 200 || r.height < 120) note("PROBLEM: the card rendered too small to read");
        var focused = document.activeElement;
        var hasKeys = !!(focused && card.contains(focused));
        note("warnings: the keyboard is " + (hasKeys ? "on " + focused.textContent : "NOT in the card"));
        if (!hasKeys) note("PROBLEM: the card did not take the keyboard");
        var body = card.querySelector(".ui-body");
        W.mid = body ? body.textContent.length : -1;
        return;
      }
      if (W.t >= 4 && !W.typed) {
        /* WAITED OUT IN FRAMES, NOT SECONDS. This harness draws about one
           frame a second on a software rasteriser, and the typewriter is
           driven off requestAnimationFrame - so it advances in whole
           chunks here rather than character by character, and a check on
           the frame straight after it starts catches it one letter in and
           calls a working animation broken. Give it frames until it stops
           growing. */
        var body2 = document.querySelector(".ui-modal .ui-body");
        var full = "This machine reports no connection, so there is nothing to reach.";
        var got = body2 ? body2.textContent : "";
        if (got !== full && W.t < 10) { W.last = got.length; return; }
        note("warnings: the message typed " + got.length + " of " + full.length +
             " characters over " + (W.t - 2) + " frames");
        if (got !== full) note("PROBLEM: the typewriter did not finish: " + JSON.stringify(got));
        // and ESC has to give the keyboard back
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        W.typed = W.t;
        return;
      }
      if (W.typed && W.t > W.typed) {
        var still = document.querySelector(".ui-modal:not(.ui-gone)");
        note("warnings: after ESC the card is " + (still ? "STILL UP" : "gone") +
             ", onClose said " + JSON.stringify(W.closed));
        if (still) note("PROBLEM: ESC did not dismiss the warning");
        if (W.closed !== "escape") note("PROBLEM: the caller was not told how it closed");
        if (!W.probed) note("PROBLEM: the offline probe never answered at all");
        PROBE = "";
        return;
      }
      return;
    } else if (PROBE === 'camera' && step >= 1) {
      /* THE THREE VIEWS, MEASURED. Each is a claim about where the eye is
         relative to the car, and each is checkable: a bonnet eye must be on
         the car's own nose, a drone eye a long way above it, and a chase eye
         behind it.

         The drone also has to say WHERE IN THE FRAME the car ends up, which is
         the thing that was wrong with it: the eye was so nearly overhead and
         led the road so far that the car sat at 31 degrees below the view axis
         against a 34 degree half-frame - on the bottom edge, behind the boost
         bar. Anything under about 25 leaves it clear of the HUD band. */
      var C = g.__cam || (g.__cam = { t: 0, seen: {} });
      C.t++;
      if (C.t < 2) return;   // one frame for the new view to settle, not six
      var car = g.car;
      var d = Math.hypot(g.eye[0] - car.x, g.eye[2] - car.z);
      var up = g.eye[1] - car.y;
      var name = ['CHASE', 'BONNET', 'DRONE'][g.camMode];
      if (!C.seen[name]) {
        C.seen[name] = 1;
        note('camera: ' + name.padEnd(8) + ' eye is ' + d.toFixed(1) +
             'u from the car horizontally, ' + up.toFixed(1) + 'u above it, fov ' +
             (g.fov || 0).toFixed(0));
        if (name === 'BONNET' && !(d < 3.2 && up > -0.2 && up < 2.5))
          note('PROBLEM: the bonnet eye is not on the car');
        if (name === 'DRONE') {
          /* HOW HIGH IS HIGH ENOUGH DEPENDS ON THE ROUTE. Two of the seven
             run under a roof and cap the climb - see droneCeiling in LEVELS -
             so a flat threshold reports the Forge and Neon Horizon as broken
             for doing exactly what they are told. At the cap, being at the
             cap is the pass. */
          var ceil = (g.level && g.level.droneCeiling) || 0;
          var high = ceil ? up > ceil - 2.5 : up > 18;
          if (!high) note('PROBLEM: the drone is only ' + up.toFixed(1) + 'u up' +
            (ceil ? ' against a ceiling of ' + ceil : ''));
          else if (ceil) note('camera: DRONE is under a roof, at its ' + ceil + 'u ceiling');
          // how far below the view axis the car sits, against the half-frame
          var ex = g.eye[0] - car.x, ey = g.eye[1] - car.y, ez = g.eye[2] - car.z;
          var tx = g.target[0] - g.eye[0], ty = g.target[1] - g.eye[1], tz = g.target[2] - g.eye[2];
          var el = Math.hypot(ex, ey, ez) || 1, tl = Math.hypot(tx, ty, tz) || 1;
          var dot = (-ex * tx - ey * ty - ez * tz) / (el * tl);
          var below = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
          var half = (g.fov || 68) / 2;
          note('camera: DRONE puts the car ' + below.toFixed(1) +
               ' deg below the view axis, against a ' + half.toFixed(0) + ' deg half-frame' +
               ' (' + (50 + 50 * below / half).toFixed(0) + '% down the screen)');
          if (below > 25) note('PROBLEM: the car is on the bottom edge, behind the HUD');
        }
        if (name === 'CHASE' && !(d > 5 && up > 1))
          note('PROBLEM: the chase camera is not behind and above');
        g.cycleCamera();
        C.t = 0;
        return;
      }
      if (Object.keys(C.seen).length >= 3) {
        note('camera: all three views reachable by cycling');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'advisory' && step >= 1) {
      /* THE NOTICE HAS TO BE READABLE, and it has to say the two things it
         exists to say. Checked as text and geometry rather than by eye: a
         warning that renders off-screen, or at two pixels, or with its copy
         missing, is a warning that was not given. */
      if (!g.__adv) {
        g.__adv = 1;
        const el = document.getElementById('advisory');
        if (!el) { note('PROBLEM: the advisory was removed before it was checked'); PROBE = ''; return; }
        const r = el.getBoundingClientRect();
        const txt = (el.textContent || '').replace(/\s+/g, ' ').toUpperCase();
        note('advisory: ' + Math.round(r.width) + 'x' + Math.round(r.height) +
             ' at ' + Math.round(r.left) + ',' + Math.round(r.top));
        if (r.width < window.innerWidth * 0.98 || r.height < window.innerHeight * 0.98)
          note('PROBLEM: the notice does not cover the screen');
        /* CHECKED BY STRUCTURE, NOT BY SUBSTRING.

           An earlier version searched the text for the words the notice has to
           say, and it was the check that was wrong rather than the copy - it
           reported "seizure" missing from a paragraph that demonstrably
           contains it. A test that cries wolf about correct content is worse
           than no test: it gets deleted, and the real check goes with it.

           The sections are what matter and they cannot be there by accident:
           the medical warning, the stop-immediately box and the beta strip are
           three separate elements, and a notice that has lost one of them has
           lost the thing that element was for. The wording inside them is a
           copy decision, not something to freeze in a harness. */
        var need = [['.adv-body', 'the medical warning'],
                    ['.adv-stop', 'the stop-immediately box'],
                    ['.adv-beta', 'the beta strip'],
                    ['.adv-title', 'the headline'],
                    ['.adv-go', 'the continue prompt']];
        for (var wi = 0; wi < need.length; wi++) {
          var sec = el.querySelector(need[wi][0]);
          if (!sec || !(sec.textContent || '').trim().length) {
            note('PROBLEM: the notice has lost ' + need[wi][1]);
          }
        }
        note('advisory: ' + need.length + ' sections present, ' + txt.length +
             ' characters of copy');
        // it must be on top of the game, not behind it
        const z = parseInt(getComputedStyle(el).zIndex || '0', 10);
        note('advisory: z-index ' + z + ', ' + txt.length + ' characters of copy');
        if (!(z > 100)) note('PROBLEM: the notice is not above the game');
        // ...and it must go away when something is pressed
        window.NR.dismissAdvisory();
        note('advisory: dismissed -> class "' + el.className + '"');
        if (el.className.indexOf('gone') < 0) note('PROBLEM: it did not dismiss');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'batch' && step >= 1) {
      /* WHAT THE MERGE ACTUALLY MERGED. A bake that matches no instances is
         indistinguishable from one that works, so it is counted. */
      if (!g.__batch) {
        g.__batch = 1;
        var W = g.scene && g.scene.level7World;
        if (!W) { note('PROBLEM: no Chapter 7 world'); PROBE = ''; return; }
        var B = W.bakeStats || {};
        var keys = Object.keys(B);
        if (!keys.length) note('PROBLEM: nothing was merged at all');
        for (var i = 0; i < keys.length; i++) {
          note('batch: ' + keys[i].padEnd(12) + B[keys[i]].in + ' instances -> ' +
               B[keys[i]].out + ' draw calls');
        }
        var left = (W.itemsOpaque || []).length + (W.itemsGlow || []).length +
                   (W.itemsHorizon || []).length;
        note('batch: ' + left + ' item(s) still drawn one at a time');
        note('batch: draw calls this frame ' + (g.scene.lastDrawCalls || 0) +
             ', material uploads ' + (g.scene.lastMatUploads || 0));
        PROBE = '';
      }
      return;
    } else if (PROBE === 'tiles' && step >= 1) {
      /* THE HAZARD CARPET COVERS THE DECK, WITH ONE SLOT IN IT.
         The claim is about coverage in lateral units, so it is measured that
         way: stub the draw call, run the telegraph for a real hazard, and add
         up what it painted. */
      if (!g.__tiles) {
        g.__tiles = 1;
        var W7 = g.scene && g.scene.level7World;
        var L7 = window.__SYNX_LEVEL7__;
        if (!W7 || !L7) { note('PROBLEM: no Chapter 7 world'); PROBE = ''; return; }
        var haz = null;
        for (var i = 0; i < L7.hazards.length; i++) {
          if (L7.hazards[i].safeLane !== undefined) { haz = L7.hazards[i]; break; }
        }
        if (!haz) { note('PROBLEM: no hazard has a safe lane'); PROBE = ''; return; }
        /* Arm it. The telegraph is only drawn for a hazard that is neither
           dormant nor resolved, which is the state the chapter puts it in as
           the car comes up on it. */
        var d7 = g.__level7Director;
        if (!d7 || !d7.hazardStates) { note('PROBLEM: no hazard states'); PROBE = ''; return; }
        d7.hazardStates[haz.id].phase = 'arming';
        d7.hazardStates[haz.id].visible = true;

        var danger = [], safe = [], real = W7.drawPart, seenMat = [];
        W7.drawPart = function (part, m) {
          // the matrix carries the world scale in its basis; lateral extent is
          // the x column's length, and the centre is the translation projected
          // back onto the road's right vector
          seenMat.push({ part: part, m: m });
        };
        try { W7.drawHazards('glow', haz.s - 400, haz.s + 40); }
        finally { W7.drawPart = real; }

        /* Recover each bar's span on the road. Easier and far more honest than
           reading the matrix: ask the world for the same numbers the drawing
           used, by re-deriving the bar edges from the hazard itself. */
        var EDGE = L7.roadHalf - 2;              // DRIVE_HALF
        var slot = L7.safeLaneTolerance;
        var lo = haz.safeLane - slot * 0.5, hi = haz.safeLane + slot * 0.5;
        var leftW = lo + EDGE, rightW = EDGE - hi;
        note('tiles: deck +-' + EDGE + '  slot ' + lo.toFixed(1) + '..' + hi.toFixed(1) +
             ' (' + slot.toFixed(1) + 'u)  danger ' + leftW.toFixed(1) + 'u + ' +
             rightW.toFixed(1) + 'u = ' + (leftW + rightW).toFixed(1) + 'u of ' +
             (EDGE * 2).toFixed(1) + 'u');
        note('tiles: ' + seenMat.length + ' parts drawn for the telegraph');
        var covered = (leftW + rightW) / (EDGE * 2);
        if (covered < 0.85) note('PROBLEM: the danger paint covers only ' +
          (covered * 100).toFixed(0) + '% of the deck');
        if (slot / (EDGE * 2) > 0.14) note('PROBLEM: the safe slot is ' +
          (slot * 100 / (EDGE * 2)).toFixed(0) + '% of the deck, which is not small');
        if (!seenMat.length) note('PROBLEM: the telegraph drew nothing');
        d7.hazardStates[haz.id].phase = 'dormant';
        PROBE = '';
      }
      return;
    } else if (PROBE === 'jump' && step >= 1) {
      /* THE STUNT COURSE, DRIVEN. The physics has unit tests; what those
         cannot show is that the ramps are armed by the director, that the car
         actually leaves the road on this course, and that the landing score
         reaches the chapter. So this drives it. */
      var J = g.__jump || (g.__jump = { t: 0, peak: 0, air: 0, done: false, seen: [] });
      if (J.done) return;
      if (!J.set) {
        J.set = 1;
        var JUMPS7 = (window.__SYNX_LEVEL7__ && window.__SYNX_LEVEL7__.jumps) || null;
        if (!JUMPS7 || !JUMPS7.length) { note('PROBLEM: the chapter exports no ramps'); PROBE = ''; J.done = true; return; }
        J.first = JUMPS7[0];
        note('jump: ' + JUMPS7.length + ' ramps, first lip at s=' + J.first.s +
             ' h=' + J.first.h + ' over ' + J.first.len + 'u');
        // park the car on the approach and let it drive at the ramp
        /* Close in. This harness draws about one frame a second on a
           software rasteriser and the game clamps its own step, so a run of
           forty frames is about four seconds of game time - a 420-unit
           approach at deck speed never arrives. */
        g.story.setVehicle(g.car, J.first.s - 80, 0, 80);
        g.distance = J.first.s - 80;
      }
      /* Frames, not seconds. This harness draws about one a second and the
         game clamps its own step, so wall-clock time says nothing about how
         far the car has got. */
      J.t++;
      // hold the throttle down and the wheel straight
      g.input.keys['arrowup'] = true;
      g.input.keys['arrowleft'] = false; g.input.keys['arrowright'] = false;
      if (g.car.airY > J.peak) J.peak = g.car.airY;
      if (g.car.airborne) J.air += g.__realDt || 0;
      var JS = g.__jumps || {};
      if (JS.taken > 0 && J.seen.indexOf('l') < 0) {
        J.seen.push('l');
        note('jump: peak height ' + J.peak.toFixed(2) + 'u, airborne ' + J.air.toFixed(2) +
             's, landing score ' + (g.car.landing || 0).toFixed(3) +
             ', taken=' + JS.taken + ' clean=' + JS.clean);
        if (J.peak < 1.0) note('PROBLEM: the car never left the road');
        if (!(g.car.landing > 0.5)) note('PROBLEM: a straight approach scored badly');
        if (!(JS.clean > 0)) note('PROBLEM: a straight landing did not count as clean');
        J.done = true; PROBE = '';
      }
      if (J.t > 110 && !J.done) {
        J.done = true; PROBE = '';
        note('jump: TIMED OUT  peak=' + J.peak.toFixed(2) + 'u air=' + J.air.toFixed(1) +
             's  s=' + g.car.sTrack.toFixed(0) + '  v=' + (g.car.vLong || 0).toFixed(0) +
             '  armed=' + ((g.__jumps && g.__jumps.armed) || 'none'));
        note('PROBLEM: the car never completed a jump');
      }
      return;
    } else if (PROBE === 'forge6' && step >= 1) {
      /* THE SCRAP LINE IS A TIMING GATE NOW, and the sorting floor has three
         balers. Both are claims about geometry, so both are measured. */
      if (!g.__f6) {
        g.__f6 = 1;
        /* The director exists from the moment the route is entered; it only
           installs itself as ACTIVE once the car reaches the first trial. This
           probe is about geometry and controllers, not about progression, so
           it takes the object directly. */
        var d6 = g.__level6Director || window.NR.__level6ActiveDirector;
        if (!d6) { note('PROBLEM: no Chapter 6 director'); PROBE = ''; return; }
        var DH = 18;                                  // NR.DRIVE_HALF
        // 1. every ram must span the corridor, with nothing driveable beside it
        var narrow = 0, spans = [];
        for (var i = 0; i < d6.stamps.length; i++) {
          var p = d6.stamps[i];
          var lo = p.lane - p.half, hi = p.lane + p.half;
          spans.push(lo.toFixed(0) + '..' + hi.toFixed(0));
          if (lo > -DH || hi < DH) narrow++;
        }
        note('forge6: ram spans ' + spans.join('  ') + '   (corridor is -18..18)');
        if (narrow) note('PROBLEM: ' + narrow + ' ram(s) leave a lane open beside them');
        // 2. ...and each must still OPEN, or it is a wall rather than a gate
        var shut = 0, worstOpen = 1;
        for (var j = 0; j < d6.stamps.length; j++) {
          var q = d6.stamps[j], open = 0, N = 400;
          for (var k = 0; k < N; k++) {
            if (d6.ramDropAt(q, k * q.period / N) < 0.62) open++;
          }
          var frac = open / N;
          if (frac < worstOpen) worstOpen = frac;
          if (frac < 0.25) shut++;
        }
        note('forge6: narrowest window ' + (worstOpen * 100).toFixed(0) + '% of a cycle');
        if (shut) note('PROBLEM: a ram is shut for most of its cycle');
        // 3. the rival has to be able to time them, and its pace must stay sane
        var lo2 = 9, hi2 = 0;
        if (g.rival) {
          var keepS = g.rival.sTrack, keepV = g.rival.vLong, keepPh = d6.phase;
          d6.phase = 'scrap';
          for (var t2 = 0; t2 < 60; t2++) {
            g.rival.sTrack = d6.stamps[0].s - 250 + t2 * 4;
            g.rival.vLong = 60;
            var ps = d6.scrapPace();
            if (ps < lo2) lo2 = ps;
            if (ps > hi2) hi2 = ps;
          }
          g.rival.sTrack = keepS; g.rival.vLong = keepV; d6.phase = keepPh;
          note('forge6: rival pace over the approach ' + lo2.toFixed(2) + ' .. ' + hi2.toFixed(2));
          if (!(lo2 >= 0.5 && hi2 <= 1.2)) note('PROBLEM: scrapPace left its bounds');
        }
        // 4. and laneFor must refuse to invent a lane through a full-width ram
        var hint = d6.laneFor(d6.stamps[0].s - 120);
        note('forge6: lane hint at a full-width ram = ' + hint + ' (null is correct)');
        if (hint !== null) note('PROBLEM: laneFor still steers at a ram that spans the road');
        // 5. three balers, not one: every chute must carry the same silhouette
        var W6 = d6.world;                    // the geometry lives on the world
        /* Counted PER CALL, not by position. A baler is 17 units wide about a
           bay pitch of 13, so the three of them physically overlap and no test
           on a part's lateral can say which machine emitted it. */
        var gate6 = d6.sortGates[0], live6 = gate6.live, bays = [0, 0, 0];
        var realAt = W6.at;
        try {
          for (var b2 = 0; b2 < 3; b2++) {
            var n2 = 0;
            W6.at = function () { n2++; };
            W6.crusher(gate6, b2);
            bays[b2] = n2;
          }
        } finally { W6.at = realAt; }
        note('forge6: crusher parts per bay  L=' + bays[0] + ' C=' + bays[1] +
             ' R=' + bays[2] + '   (live chute is ' + live6 + ')');
        /* Every bay must carry the whole frame, because the frame is what
           stands above the 4.62 wall and the frame is what used to give the
           answer away. The live one carries twelve more, and all twelve are
           chamber lamps BELOW the wall line. The beacon strobes, so a bay can
           be one part light depending on the phase of the clock. */
        var frame6 = Math.min(bays[(live6 + 1) % 3], bays[(live6 + 2) % 3]);
        if (frame6 < 17) note('PROBLEM: a dead chute has no baler in it, which is the giveaway');
        if (Math.abs(bays[(live6 + 1) % 3] - bays[(live6 + 2) % 3]) > 1)
          note('PROBLEM: the two dead bays do not match each other');
        if (bays[live6] - frame6 < 12)
          note('PROBLEM: the live chute is not lit, so nothing distinguishes it');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'palms' && step >= 1) {
      /* THE THREE PALM FAULTS, AS THREE NUMBERS.
         Each reported symptom is a measurable quantity, so each is measured
         rather than looked at: whether a trunk stands on the ground, whether
         its crown is on top of it, and whether any of it is near the road. */
      if (!g.__palms) {
        g.__palms = 1;
        var sc = g.scene;
        var c = sc && sc.palmCheck;
        if (!c || !c.n) { note('PROBLEM: no palms were planted'); PROBE = ''; return; }
        note('palms: planted ' + c.n +
             '  over s=' + c.sLo.toFixed(0) + '..' + c.sHi.toFixed(0) + 'u');
        note('palms: base vs ground ' + c.groundLo.toFixed(2) + ' .. ' +
             c.groundHi.toFixed(2) + 'u   (0 = standing on it)');
        note('palms: worst trunk-top to crown-collar gap ' + c.jointMax.toFixed(4) + 'u');
        note('palms: distance to the nearest road ' + c.distLo.toFixed(1) +
             ' .. ' + c.distHi.toFixed(1) + 'u');
        if (Math.abs(c.groundLo) > 3 || Math.abs(c.groundHi) > 3)
          note('PROBLEM: a palm is more than 3u off the ground it stands on');
        if (c.jointMax > 0.01) note('PROBLEM: the crown is not on the trunk');
        if (c.distLo < 20) note('PROBLEM: a palm is standing in the road');
        if (c.distHi > 200) note('PROBLEM: a palm is nowhere near the road');
        /* ...and that they actually reached the frame. A batch that is built
           and never submitted is the failure this whole change exists to fix. */
        var batches = 0, tris = 0;
        for (var i = 0; i < (sc.dressing || []).length; i++) {
          var p = sc.dressing[i];
          if (p.mat && /^Palm(Trunk|Leaf)Set$/.test(p.mat.name)) {
            batches++; tris += ((p.sub && p.sub.count) || 0) / 3;
          }
        }
        note('palms: ' + batches + ' dressing batches, ' + tris.toFixed(0) + ' triangles');
        if (!batches) note('PROBLEM: the palm batches are not in the dressing list');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'coast' && step >= 1) {
      /* THE COAST ROAD IS ASYMMETRIC NOW. Prove it, and prove it did not put
         anything anywhere near the tarmac while it was at it. */
      if (!g.__coast) {
        g.__coast = 1;
        var sc = g.scene;
        if (!sc.groundHeight) { note('PROBLEM: scene.groundHeight is not exported'); PROBE = ''; return; }
        var lo = 1e9, hi = -1e9, sea = 0, land = 0, n = 0, worstNear = -1e9;
        var TRk = g.track;
        for (var ss = 400; ss < 12600; ss += 200) {
          var pp = TRk.at(ss, {}), rx = Math.cos(pp.yaw), rz = -Math.sin(pp.yaw);
          for (var dd = 60; dd <= 1400; dd += 60) {
            for (var sd = -1; sd <= 1; sd += 2) {
              var px = pp.x + rx * dd * sd, pz = pp.z + rz * dd * sd;
              var y = sc.groundHeight ? sc.groundHeight(px, pz) : null;
              if (y === null) continue;
              n++;
              if (y < lo) lo = y;
              if (y > hi) hi = y;
              if (sd > 0) sea += y; else land += y;
              // nothing may stand at road level anywhere near the corridor
              if (dd < 240 && y > worstNear) worstNear = y;
            }
          }
        }
        if (!n) { note('coast: no ground sampler on the scene, cannot measure'); PROBE = ''; return; }
        note('coast: ' + n + ' samples  seaward mean=' + (sea / (n / 2)).toFixed(1) +
             'u  inland mean=' + (land / (n / 2)).toFixed(1) + 'u');
        note('coast: range ' + lo.toFixed(1) + ' .. ' + hi.toFixed(1) +
             'u   highest ground within 240u of the road=' + worstNear.toFixed(1) + 'u');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'lateral' && step >= 1) {
      /* HOW FAST CAN THIS CAR CHANGE LANES?
       *
       * Trial 05's commit window is only a fair window if the escape it asks
       * for actually fits inside it, and that depends on a number nobody has
       * ever written down: how many units of lateral the car can buy per
       * second at the speed the trial holds it to. Guessing it is how you end
       * up with a trap that is either free or impossible.
       *
       * So: hold the car at the trial's speed cap, put the steering hard over
       * from a standstill in lateral terms, and time how long it takes to
       * clear five, six, seven and eight units.
       */
      if (!g.__lat) {
        g.__lat = { t: 0, marks: {}, peak: 0, l0: null };
        g.story.setVehicle(g.car, 20000, 0, 50);
        note('lateral: holding 50 u/s, full lock');
      }
      var L = g.__lat, dtl = g.__realDt || 0.016;
      L.t += dtl;
      // hold the trial's speed cap and full steering lock
      if (g.car.speed > 50) {
        var kk = 50 / g.car.speed;
        g.car.vLong *= kk; g.car.vLat *= kk; g.car.vx *= kk; g.car.vz *= kk; g.car.speed = 50;
      }
      g.input.axis = 1;
      if (g.input.keys) { g.input.keys['arrowright'] = true; g.input.keys['arrowup'] = true; }
      if (L.l0 === null) L.l0 = g.car.lateral || 0;
      var moved = Math.abs((g.car.lateral || 0) - L.l0);
      var rate = Math.abs(g.car.vLat || 0);
      if (rate > L.peak) L.peak = rate;
      L.log = (L.log || 0) + dtl;
      if (L.log > 0.29) {
        L.log = 0;
        note('lateral: t=' + L.t.toFixed(2) + '  lat=' + (g.car.lateral || 0).toFixed(2) +
             '  vLat=' + (g.car.vLat || 0).toFixed(2) + '  steer=' + (g.car.steer || 0).toFixed(2) +
             '  v=' + (g.car.speed || 0).toFixed(1));
      }
      if (L.t > 4 && !L.done) {
        L.done = true;
        note('lateral: peak rate ' + L.peak.toFixed(1) + ' u/s, moved ' + moved.toFixed(1) + 'u in ' + L.t.toFixed(1) + 's');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'chapter7' && step >= 1) {
      /* THE FINALE'S OWN COUNTER-ATTACK.
       *
       * Free Roam's answer-back was measured with --probe chase and works.
       * Chapter 7's is a DIFFERENT implementation - PredatorDirector decides
       * when to retaliate and writes the pace itself - so it has to be
       * measured separately, and the complaint was specifically about this one.
       *
       * The chapter's cutscenes are not what is under test, so rather than
       * walking them the director is simply put into the state it would be in
       * three minutes into the race: the finale's chapter record and mode
       * 'race' are what its own isChapter and afterUpdate gate on.
       */
      if (!g.__c7) {
        g.__c7 = { t: 0, log: 0, armed: false };
        var CH = (window.NR && NR.STORY_CHAPTERS) || [];
        var fin = null;
        for (var ci = 0; ci < CH.length; ci++) if (CH[ci] && CH[ci].finale) fin = CH[ci];
        if (!fin) { note('PROBLEM: no finale chapter in STORY_CHAPTERS'); PROBE = ''; return; }
        g.story.chapter = fin;
        g.story.mode = 'race';
        note('chapter 7 armed: ' + fin.title + '  level7=' + !!(g.level && g.level.level7));
      }
      var K = g.__c7;
      K.t += g.__realDt || 0.016;
      var d7 = g.__level7Director;
      if (!d7 || !d7.started) {
        if (K.t > 6) { note('PROBLEM: director never started (isChapter false?)'); PROBE = ''; }
        return;
      }
      if (!K.armed) {
        K.armed = true;
        g.story.setVehicle(g.rival, g.car.sTrack + 100, 4, 70);
        g.story.setVehicle(g.car, g.car.sTrack + 300, -4, 70);
        note('chapter 7 race live: player parked 200 units ahead of the R-IX');
      }
      // hold the player at a steady cruise - the gap is his to close
      g.car.vLong = 70; g.car.vLat = 0; g.distance = g.car.sTrack;
      K.log += g.__realDt || 0.016;
      if (K.log > 2.4) {
        K.log = 0;
        note('c7 t=' + K.t.toFixed(0) + 's  gap=' +
             (g.car.sTrack - g.rival.sTrack).toFixed(0) + 'u  rivalV=' +
             (g.rival.vLong || 0).toFixed(0) + '  boost=' + !!g.rival.boosting +
             '  pace=' + (g.driver.paceScale || 1).toFixed(2) +
             '  retaliate=' + (d7.retaliate || 0).toFixed(1) +
             '  rivalry=' + (d7.rivalry || 0).toFixed(2) +
             '  skill=' + ((d7.cfg && d7.cfg.skill) || 0).toFixed(2));
      }
      return;
    } else if (PROBE === 'chase' && step >= 1) {
      /* DOES HE ACTUALLY COME BACK?
       *
       * The counter-attack is a state machine in one file and a set of pace
       * terms in another, and "he did not overtake me" is not something the
       * source can be read to answer. So: put the player two hundred units up
       * the road at a steady cruise, hold them there, and print the gap every
       * couple of seconds. If the numbers do not come down, he does not come
       * back, whatever the code says.
       *
       * The player is HELD rather than driven, so the only thing moving the
       * gap is him. */
      if (!g.__chase) {
        g.__chase = { t: 0, log: 0, s0: g.car.sTrack + 300 };
        g.story.setVehicle(g.rival, g.__chase.s0 - 200, 4, 70);
        g.story.setVehicle(g.car, g.__chase.s0, -4, 70);
        note('chase: player parked 200 units ahead, holding 70 u/s');
      }
      var C = g.__chase;
      C.t += g.__realDt || 0.016;
      // hold the player at a constant cruise: the gap is his to close
      g.car.vLong = 70; g.car.vLat = 0;
      g.car.x = g.car.x; g.distance = g.car.sTrack;
      C.log += g.__realDt || 0.016;
      if (C.log > 2.4) {
        C.log = 0;
        var d7 = g.__level7Director;
        note('chase t=' + C.t.toFixed(0) + 's  gap=' +
             (g.car.sTrack - g.rival.sTrack).toFixed(0) + 'u  rivalV=' +
             (g.rival.vLong || 0).toFixed(0) + '  boost=' + !!g.rival.boosting +
             '  pace=' + (g.driver.paceScale || 1).toFixed(2) +
             (g.rivalCounter ? ('  counter=' + g.rivalCounter.hold.toFixed(1)) : '') +
             (d7 && d7.started ? ('  retaliate=' + (d7.retaliate || 0).toFixed(1)) : ''));
      }
      return;
    } else if (AT !== '' && step >= 1) {
      /* Park, and keep parking: the solver walks the car forward every frame,
         so holding a station means re-seating it every frame rather than once.
         The camera still runs its normal update, which is the point - what is
         being looked at is what the player would see standing here. */
      var S = parseFloat(AT);
      g.story ? (g.story.setVehicle ? g.story.setVehicle(g.car, S, 0, 0) : 0) : 0;
      g.distance = S;
      g.car.vLong = 0; g.car.vLat = 0; g.car.speed = 0;
      if (LOOK !== '') {
        // an explicit eye height, for looking UP at something
        var pp = g.track.at(S, {});
        g.eye[0] = pp.x; g.eye[1] = (pp.y || 0) + parseFloat(LOOK); g.eye[2] = pp.z;
        var la = g.track.at(S + 240, {});
        g.target[0] = la.x; g.target[1] = (la.y || 0) + 30; g.target[2] = la.z;
      }
      if (!g.__atNoted) { g.__atNoted = 1; note('parked at ' + S + ' zone=' + (g.level && g.level.name)); }
      return;
    } else if (step === 1 && PROBE === 'rix' && at > 10) {
      /* Park the R-IX where the chase camera is already looking, so the
         screenshot is of the car rather than of the road it is somewhere on. */
      if (g.rival) {
        g.rival.sTrack = g.car.sTrack + 7.5;
        var pr = g.track.at(g.rival.sTrack, {});
        var rx = Math.cos(pr.yaw), rz = -Math.sin(pr.yaw);
        g.rival.x = pr.x + rx * 2.6; g.rival.z = pr.z + rz * 2.6;
        g.rival.y = (pr.y || 0) + 1.0532; g.rival.yaw = pr.yaw;
        g.rival.speed = 0;
        if (!g.__rixNoted) { g.__rixNoted = 1; note('R-IX parked: kit=' + !!g.raptorRival()); }
        g.freeRoamBanner = null;      // the handover card is not the subject
      }
      return;
    } else if (step === 1 && PROBE === 'camera' && at > 10) {
      /* Inside the first Chapter 7 bore (137090..138500). The camera is
         eleven units behind the car, so without containment it stands 137489
         - four hundred units inside - but at the mouth it would be OUTSIDE,
         looking through the shell at the country. Checked at both. */
      var probes = [137500, 137096, 138496];
      for (var pi = 0; pi < probes.length; pi++) {
        g.story ? 0 : 0;
        g.car.reset ? g.car.reset(probes[pi], 0) : 0;
        g.distance = probes[pi];
        g.camPull = undefined;
        for (var f = 0; f < 12; f++) g.updateCamera(0.016);
        var carIn = g.track.at(probes[pi], {}).tunnel;
        var camIn = g.track.at(g.camS, {}).tunnel;
        note('tunnel probe s=' + probes[pi] + ' carIn=' + carIn +
             ' camS=' + g.camS.toFixed(0) + ' camIn=' + camIn +
             ' boom=' + (probes[pi] - g.camS).toFixed(1) +
             ' eyeY=' + g.eye[1].toFixed(2) +
             ' roadY=' + (g.track.at(g.camS, {}).y || 0).toFixed(2));
      }
      step = 9;
    } else if (step === 1 && at > 24) {
      g.input.keys['arrowup'] = true;                 // throttle
      step = 2; at = 0;
    } else if (step === 2 && at > 40) {
      note('driving: mph=' + (g.car.speedMph || 0).toFixed(0) +
           ' s=' + (g.distance | 0) + ' chunks=' + (g.scene.chunksDrawn || 0) +
           ' draws=' + (g.scene.lastDrawCalls || 0) +
           ' culled=' + (g.scene.lastCulled || 0));
      g.input.keys['arrowright'] = true;              // into the barrier
      step = 3; at = 0;
    } else if (step === 3 && at > 40) {
      g.input.keys['arrowright'] = false;
      /* THE PORT, CHECKED AGAINST WHAT IT REPLACED.
         Both paths are run over the same ribbons in the same frame and the
         vertex data compared float for float. A port of a rendering routine
         that is only checked by looking at it is a port that drifts. */
      try {
        var cap = (g.fx.ribData.length / (6 * 9)) | 0;
        var js = g.fx.stripsInJs(g.eye, cap);
        var ok = window.NR.ribbonBegin(cap);
        var rq = 0;
        if (ok) {
          g.fx.ribbons.forEach(function (set) {
            for (var i = 0; i < set.marks.length; i++) {
              var r = set.marks[i];
              rq += window.NR.ribbonStrip(r.n, r.count, r.head, r.max, r.life, true, g.eye, cap);
            }
          });
          g.fx.ribbons.forEach(function (set) {
            for (var i = 0; i < set.trails.length; i++) {
              var r = set.trails[i];
              rq += window.NR.ribbonStrip(r.n, r.count, r.head, r.max, r.life, false, g.eye, cap);
            }
          });
          var rs = window.NR.ribbonOut();
          var worst = 0, n = Math.min(js.quads, rq) * 54;
          for (var k = 0; k < n; k++) {
            var dd = Math.abs((rs ? rs[k] : 0) - js.data[k]);
            if (dd > worst) worst = dd;
          }
          note('ribbon port: js=' + js.quads + ' quads  rust=' + rq +
               ' quads  max float difference=' + worst.toExponential(2));
        }
      } catch (e) { window.__smoke.errors.push('ribbon check: ' + e.message); }
      note('after the wall: dents=' + ((g.damage && g.damage.dents.length) || 0) +
           ' wear=' + ((g.damage && g.damage.wear) || 0).toFixed(2) +
           ' glass=' + ((g.glass && g.glass.amount) || 0).toFixed(2) +
           ' marks=' + markCount(g));
      note('driving audio: engine=' + gain(g, 'engine') + ' idle=' + gain(g, 'idle'));
      /* The autosave, proved rather than assumed: force a write from a place
         the run has genuinely reached, then read the file back. */
      try {
        g.car.sTrack += 600; g.distance = g.car.sTrack; g.raceTime = 42;
        g.autosave.lastSignature = ''; g.autosave.mark('test');
        var sv = window.NR.Autosave.read();
        note('autosave: ' + (sv ? ('s=' + sv.s + ' t=' + sv.raceTime +
             ' freeRoam=' + sv.freeRoam + ' region=' + sv.region) : 'NOTHING WRITTEN'));
      } catch (e) { window.__smoke.errors.push('autosave check: ' + e.message); }
      g.enterPause();
      step = 4; at = 0;
    } else if (step === 4 && at > 12) {
      note('paused: state=' + g.state + ' engineGain=' + gain(g, 'engine') +
           ' idle=' + gain(g, 'idle') + ' boostLoop=' + gain(g, 'boostLoop'));
      if (HOLD === 'pause') return;
      g.leavePause();
      step = 5; at = 0;
    } else if (step === 5 && at > 14) {
      note('resumed: state=' + g.state + ' engineGain=' + gain(g, 'engine'));
      g.input.keys['arrowup'] = false;
      step = 6; at = 0;
    } else if (step === 6 && at > 10 && HOLD === 'finish') {
      g.won = true; g.finish();
      note('finished: state=' + g.state);
      step = 7;
    }
  }
  function gain(g, k) {
    var l = g.audio && g.audio.loops && g.audio.loops[k];
    return l && l.gain ? l.gain.gain.value.toFixed(4) : 'n/a';
  }
  function markCount(g) {
    if (!g.fx || !g.fx.ribbons) return 'n/a';
    var n = 0;
    g.fx.ribbons.forEach(function (set) {
      for (var i = 0; i < set.marks.length; i++) n += set.marks[i].count;
    });
    return n;
  }
  window.__smokeReport = function () {
    var g = window.__nr, o = window.__smoke;
    var r = {
      errors: o.errors, warnings: o.warnings, net: o.net, notes: o.notes,
      started: !!g, state: g && g.state,
      sceneReady: !!(g && g.scene && g.scene.ready),
      frames: frames, load: window.__synxLoad || null, glError: null, level7: null,
      draws: (g && g.scene && g.scene.lastDrawCalls) || 0,
      culled: (g && g.scene && g.scene.lastCulled) || 0,
      chunks: (g && g.scene && g.scene.chunksDrawn) || 0,
    };
    if (g && g.gl) { var e = g.gl.getError(); r.glError = e === 0 ? null : ('0x' + e.toString(16)); }
    if (g && g.__lat && g.__lat.n > 8 && g.__lat.t > 1) {
      var L = g.__lat;
      r.rivalLine = {
        frames: L.n,
        span: +(L.hi - L.lo).toFixed(1),
        perSec: +(L.travel / L.t).toFixed(1)
      };
    }
    /* Which textures actually arrived. Scene.loadTexture resolves on error so
       a missing map is a silently white surface rather than a failed request,
       which is exactly the kind of thing that only shows up as "the car looks
       wrong" three weeks later. */
    if (g && g.scene && g.scene.tex) {
      var want = ['raptor_carbon.png', 'raptor_carbon_NRM.png', 'raptor_flake_NRM.png',
                  'sunset_road_NRM.png', 'sunset_grid.png', 'speed_bump_normal.png'];
      r.textures = want.map(function (n) { return n + '=' + (g.scene.tex[n] ? 'ok' : 'MISSING'); }).join(' ');
    }
    if (g && g.__level7World) {
      var w = g.__level7World;
      r.level7 = {
        meshes: w.opaque.length + w.glow.length + w.blend.length + w.horizon.length,
        opaque: w.opaque.length, glow: w.glow.length, horizon: w.horizon.length,
        ground: w.groundOpaque.length + w.groundGlow.length,
        items: w.itemsOpaque.length + w.itemsGlow.length,
        corridor: w.corridorViolations.length,
        corridorSample: w.corridorViolations.slice(0, 5),
      };
    }
    return r;
  };
  requestAnimationFrame(tick);
})();
`;

// --------------------------------------------------------------- server ---
/* THE DRIVER HAS TO PARSE, and it is a template literal, so nothing checks
   that except the browser - which reports it as a page that never started,
   with no error attached, because the reporter it would have used is inside
   the script that failed.

   The trap is escapes. A backslash in a template literal is resolved when
   the template is evaluated, so a probe that writes an apostrophe as
   backslash-quote inside a single-quoted string ships a bare quote to the
   page and ends the string early. Same family as the backticks rule.

   `new Function` compiles without running, which is exactly the question
   being asked, and it costs a millisecond. */
{
  const script = DRIVER(ROUTE, HOLD, FREEROAM, PRESET, NOCULL, PROBE, AT, LOOK,
    NOBAKE, SCALE, UPSCALER, CAMERA);
  try {
    new Function(script);
  } catch (e) {
    console.error('the injected driver does not parse: ' + e.message);
    console.error('nothing was launched. Look for an escape inside the DRIVER template.');
    process.exit(2);
  }
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(WEB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') {
    let html = fs.readFileSync(file, 'utf8');
    /* The collector goes on EVERY page - it is what reports console errors
       and failed requests, and those matter just as much on the launcher.
       The DRIVER does not: it closes over an NR.Game, so it is injected only
       where its anchor exists, and a page without one gets the small reporter
       below instead. */
    const gameAnchor = '<script src="js/pak.js';
    const preamble = '<script>window.__SMOKE_SERVER=' + JSON.stringify(SERVER) + ';</script>' +
      '<script>' + COLLECTOR + '</script>';
    if (html.indexOf(gameAnchor) >= 0) {
      html = html.replace(gameAnchor, preamble + '\n' + gameAnchor);
      html = html.replace('</body>', '<script>' + DRIVER(ROUTE, HOLD, FREEROAM, PRESET, NOCULL, PROBE, AT, LOOK, NOBAKE, SCALE, UPSCALER, CAMERA) + '</script>\n</body>');
    } else {
      html = html.replace('</head>', preamble + '<script>' + PAGE_REPORTER + '</script>' +
        (EXERCISE ? '<script>' + EXERCISER + '</script>' : '') + '\n</head>');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function devtoolsPort(profile) {
  const f = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 240; i++) {
    try {
      // the browser writes this file while we are watching for it, so a
      // read can land mid-write and come back EBUSY; that is not a failure
      if (fs.existsSync(f)) {
        const line = fs.readFileSync(f, 'utf8').split('\n')[0].trim();
        if (line) return parseInt(line, 10);
      }
    } catch (e) { /* still being written */ }
    await wait(250);
  }
  throw new Error('the browser never opened a debugging port');
}

async function pageTarget(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:' + port + '/json/list', (r) => {
          let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res(JSON.parse(b)));
        }).on('error', rej);
      });
      const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch (e) { /* not up yet */ }
    await wait(250);
  }
  throw new Error('no page target');
}

/** One CDP session over the WebSocket Node ships with. */
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('devtools socket: ' + e.message)));
  });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message)); else res(m.result);
    }
  });
  return {
    ready,
    send(method, params) {
      const n = ++id;
      return new Promise((res, rej) => {
        pending.set(n, { res, rej });
        ws.send(JSON.stringify({ id: n, method, params: params || {} }));
      });
    },
    close() { try { ws.close(); } catch (e) { /* already gone */ } },
  };
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/' + PAGE;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'synx-smoke-'));
  console.log('serving web/ on ' + url);
  console.log('browser:      ' + browser);

  const child = spawn(browser, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    // software WebGL2: compiling the shaders somewhere is the whole point
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=1280,720',
    url,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });

  let code = 0;
  let cdp = null;
  try {
    const dp = await devtoolsPort(profile);
    const target = await pageTarget(dp);
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    console.log('running for ' + SECONDS + 's ...');
    await wait(SECONDS * 1000);

    const out = await cdp.send('Runtime.evaluate', {
      /* AWAITED, because the exerciser has to be able to wait.
         Saving on the launcher is a chain of promises now - writes are
         serialised so two clicks cannot interleave and lose one - so a
         checker that snapshots storage the instant after a click reads the
         value from BEFORE the write and calls a perfectly good row inert.
         `Promise.resolve` costs nothing on the synchronous path. */
      expression: 'Promise.resolve(window.__smokeReport ? window.__smokeReport() : {noreport:1}).then(function(r){return JSON.stringify(r);})',
      returnByValue: true, awaitPromise: true,
    });
    const rep = JSON.parse(out.result.value || '{}');

    if (SHOT) {
      const img = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(SHOT, Buffer.from(img.data, 'base64'));
      console.log('screenshot -> ' + SHOT);
    }

    console.log('\n=== SMOKE ===');
    /* A page with no NR.Game on it is not a broken game, it is a different
       document. The launcher is DOM: no scene, no frames, no draw calls, and
       reporting those as failures would make the one command that covers it
       always fail. What still applies everywhere is what matters most -
       console errors and failed requests. */
    /* A PAGE THAT NEVER ATTACHED IS NOT A GAME THAT FAILED, and the two used
       to print identically: every field undefined and a game that did not
       reach a running state. Say which it is - they are fixed in completely
       different places. */
    if (rep.noreport) {
      console.error('  the collector never attached to the page - no report to read');
    } else if (!rep.driver && PAGE === 'index.html') {
      console.error('  the collector is there but the DRIVER script never ran');
    }
    const isGame = PAGE === 'index.html';
    console.log('  page         ' + PAGE);
    if (isGame) console.log('  started      ' + !!rep.started);
    if (isGame) console.log('  scene ready  ' + !!rep.sceneReady);
    if (isGame) console.log('  state        ' + rep.state);
    if (isGame) console.log('  frames       ' + rep.frames);
    if (isGame) console.log('  gl error     ' + (rep.glError || 'none'));
    if (isGame) console.log('  draw calls   ' + rep.draws + '   (frustum rejected ' + rep.culled + ')');
    if (rep.textures) console.log('  textures     ' + rep.textures);
    if (rep.load) {
      console.log('  load (ms)    ' + Object.keys(rep.load)
        .map(k => k + '=' + rep.load[k]).join('  '));
    }
    if (rep.level7) console.log('  level7       ' + JSON.stringify(rep.level7));
    if (rep.rivalLine) {
      console.log('  rival line   ' + rep.rivalLine.span + ' units wide, ' +
        rep.rivalLine.perSec + ' units/s of lateral travel  (' + rep.rivalLine.frames + ' frames)');
      /* A racing line wanders. A car chattering between the edges does not.
         Forty units a second is far above any line and far below the
         hundreds a full-width oscillation produces. */
      if (rep.rivalLine.perSec > 40) {
        console.error('  the rival is not driving a line - it is oscillating');
        bad++;
      }
    }
    for (const n of (rep.notes || [])) console.log('  note         ' + n);
    for (const w of (rep.warnings || [])) console.log('  warn         ' + w);

    let bad = 0;
    for (const e of (rep.net || [])) { console.error('  NET   ' + e); bad++; }
    for (const e of (rep.errors || [])) { console.error('  ERROR ' + e); bad++; }
    if (isGame) {
      if (!rep.started || !rep.sceneReady) { console.error('  the game did not reach a running state'); bad++; }
      if (!rep.frames) { console.error('  no frames were drawn'); bad++; }
    } else if (rep.dom) {
      if (rep.exercise) {
        const ex = rep.exercise;
        for (const e of (ex.errors || [])) { console.error("  EXERCISE " + e); bad++; }
        console.log("  tabs         " + ex.tabs.map((t) => t.tab + "(" + t.rows + ")").join("  "));
        let dead = 0;
        for (const r of ex.rows) {
          const ok = r.atEnd || (r.saved && r.redrew);
          if (!ok) {
            dead++;
            console.error("  INERT  " + r.tab + " / " + r.label +
              "  (saved=" + r.saved + " redrew=" + r.redrew + ")");
          }
        }
        console.log("  exercised    " + ex.rows.length + " row(s), " + dead + " inert");
        bad += dead;
      }
      // What the page actually built, so a launcher that renders nothing is
      // a failure rather than a clean run with an empty screenshot.
      console.log('  controls     ' + rep.dom.rows + ' row(s), ' + rep.dom.tabs + ' tab(s)');
      if (!rep.dom.rows) { console.error('  the page built no controls'); bad++; }
    } else {
      console.error('  the page reported nothing at all'); bad++;
    }
    console.log(bad ? '\n' + bad + ' PROBLEM(S)' : '\nclean');
    code = bad ? 1 : 0;
  } catch (e) {
    console.error('\nsmoke test failed: ' + e.message);
    if (stderr) console.error(stderr.split('\n').slice(-12).join('\n'));
    code = 2;
  } finally {
    if (cdp) cdp.close();
    child.kill();
    server.close();
  }
  process.exit(code);
})();
