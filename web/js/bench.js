/* SYNX // the benchmark.
 *
 * ============================================================ WHAT IT IS FOR
 *
 * Two questions, and they are not the same question.
 *
 *   WHICH SETTINGS SHOULD THIS MACHINE USE? The launcher has eleven graphics
 *   rows and a preset above them, and nobody who has not read the renderer
 *   knows what ambient occlusion costs on their own card. The honest answer is
 *   not an opinion, it is a number measured here.
 *
 *   AND WHAT DOES IT ACTUALLY RUN LIKE? Which is a different thing, and the
 *   thing a player who presses BENCHMARK is usually asking. A preset
 *   recommendation is a single word; what they want is the frame rate, the
 *   worst of it, and which end of their machine is the limit.
 *
 * So it does both, in that order, and shows the second one properly.
 *
 * ===================================================== HOW IT IS PUT TOGETHER
 *
 *   CALIBRATE   the preset ladder, cheapest first, over a fixed stretch. Short
 *               - about a second each - because all this has to do is rank
 *               four settings, and it ends by choosing one.
 *
 *   RUN         THREE SCENES OF THE GAME ACTUALLY BEING PLAYED, at the preset
 *               that was just chosen, with the title screen's own cinematic
 *               camera. A tunnel, a city and a coast road: fill rate, geometry
 *               and draw distance, which are the three different ways this
 *               renderer can be made to hurt. This is what is reported.
 *
 *   REPORT      on the same screen, without going anywhere.
 *
 * ============================================== WHY THE SCENES ARE LIKE THIS
 *
 * The version this replaces parked the car at one spot with a fake speed and
 * measured four presets there. Three things were wrong with that, and they are
 * the reasons for every choice below:
 *
 *   ONE PLACE IS NOT THE GAME. A straight with the dressing behind you
 *   recommends settings that fall over the moment anything happens. The three
 *   scenes here are chosen to load the renderer in three different ways, and
 *   they are the same stretches the title screen flies, so they cannot drift
 *   away from what the game actually looks like.
 *
 *   A PARKED CAR IS NOT A FRAME. No motion blur, no tyre spray, a temporal
 *   resolve with nothing to resolve, and a shadow cascade that never
 *   re-fits - none of which are free once anything moves.
 *
 *   AND IT HAS TO BE THE SAME WORK EVERYWHERE. This is the one that makes the
 *   numbers mean anything. The camera is stepped at a FIXED sixtieth of a
 *   second per frame rather than by the real frame time, so a fast machine and
 *   a slow one drive exactly the same road, frame for frame, and the only
 *   thing that differs between them is how long each frame took. Advance a
 *   flyby by the real delta instead and the slow machine renders a different,
 *   longer stretch of world - which is not a comparison at all.
 *
 * ================================================ WHAT THE NUMBERS ACTUALLY ARE
 *
 *   AVERAGE     the mean frame time over the three scenes, as a rate.
 *   MINIMUM     the slowest single frame. Not a percentile - the actual worst
 *               one - because a hitch is a thing that happened.
 *   1% LOW      the mean of the slowest hundredth of frames. This is the
 *               number that correlates with "it feels smooth", and it is the
 *               one a mean hides behind a long tail of fast frames.
 *   CPU GAME    time inside `update`: physics, drivers, director, audio.
 *   CPU RENDER  time inside `draw`: culling, matrices, uniforms, draw calls.
 *   GPU         whatever is left of the frame, because nothing else is running.
 *
 * The last three are measured in js/game.js and are the split that says which
 * end of the machine to spend money on: a game bound by CPU GAME does not get
 * faster with a smaller window, and one bound by GPU does.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});
  const doc = global.document;

  /* Cheapest first: the sweep walks this in order and keeps the last one that
     held the target, so a machine that fails at MEDIUM still has LOW measured
     and chosen rather than falling through to nothing. */
  const LADDER = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'];

  /* THE CALIBRATION, which only has to RANK four settings. 54 frames is under
     a second on anything that can hold sixty, and the 16 discarded at the
     front cover the shader compiles and render-target reallocation that a
     preset change causes. */
  const CAL_FRAMES = 54;
  const CAL_WARMUP = 16;
  const CAL_SETTLE = 8;

  /* THE RUN, which has to MEASURE one. Longer, because this is the number that
     gets reported and a 1% low over ninety samples is one frame. */
  const SCENE_FRAMES = 170;
  const SCENE_WARMUP = 22;

  /* The frame time to hold: 16.7ms is sixty a second, which is what the
     simulation is tuned around. */
  const TARGET_MS = 16.7;

  /* Where the calibration is done. Far enough into the course to have
     dressing, signage and barriers in shot. */
  const AT = 9000;

  /* The camera step. Fixed, and the reason is in the note at the top. */
  const STEP = 1 / 60;

  /* THE THREE SCENES, picked by what they DO to the renderer rather than by
     where they are - so re-cutting the title reel moves the benchmark with it
     instead of quietly changing what is being measured.

       jump   the sealed bore at MIRAGE CIRCUIT: a tunnel, which is fill rate,
              overlapping glow and a volumetric pass with something to scatter
              in it.
       flat   the city at midnight: the densest geometry and the most lights
              on the course, taken at speed.
       drift  the seawall: open sky, the longest draw distance in the game,
              and a car sideways in front of it.
  */
  const SCENE_KINDS = [
    { kind: 'jump', note: 'tunnel - fill rate and volumetrics' },
    { kind: 'flat', note: 'city - geometry and lights' },
    { kind: 'drift', note: 'coast - draw distance' },
  ];

  let run = null;
  let ui = null;
  /* Which game the run belongs to, so `teardown` can put its title screen
     back without being handed it. There is only ever one. */
  let benchGame = null;

  function percentile(list, q) {
    if (!list.length) return 0;
    const a = list.slice().sort((x, y) => x - y);
    const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)));
    return a[i];
  }

  /* THE 1% LOW, properly: the MEAN of the slowest hundredth, not the single
     frame at the 99th percentile. The distinction matters on a run with one
     enormous hitch in it - a percentile reports the hitch and a mean of the
     tail reports how the run felt, which is the question. */
  function onePercentLow(list) {
    if (!list.length) return 0;
    const a = list.slice().sort((x, y) => y - x);
    const n = Math.max(1, Math.round(a.length / 100));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a[i];
    return sum / n;
  }

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const fps = (ms) => (ms > 0 ? 1000 / ms : 0);

  /* ------------------------------------------------------------- the panel --
   *
   * ONE ELEMENT, TWO SHAPES. While the run is on it is a strip along the
   * bottom of the screen, because the thing worth looking at is the game
   * behind it; when the run ends the strip becomes the report. Two separate
   * screens would mean the result arriving somewhere the scene was not, and
   * the request was explicitly for the report to land on the same screen.
   */

  function build() {
    const root = doc.createElement('div');
    root.className = 'bench is-run';
    root.setAttribute('aria-hidden', 'true');
    /* Static skeleton, no interpolation: every number below is written with
       textContent, and nothing on this screen comes from outside the process. */
    root.innerHTML =
      '<div class="bench-strip">'
      + '<div class="bench-title"><i></i><span>SYNX // BENCHMARK</span><i></i></div>'
      + '<div class="bench-strip-head">'
      + '<b class="bench-scene"></b><span class="bench-note"></span>'
      + '</div>'
      + '<div class="bench-bar"><i></i></div>'
      + '<div class="bench-strip-foot">'
      + '<span class="bench-live"></span>'
      + '<canvas class="bench-graph" width="520" height="58"></canvas>'
      + '</div>'
      + '<p class="bench-hint">MEASURING - the game is driving itself. ESC to stop.</p>'
      + '</div>'
      + '<div class="bench-card">'
      + '<div class="bench-rule"><i></i><span>SYNX // BENCHMARK</span><i></i></div>'
      + '<div class="bench-head"></div>'
      + '<canvas class="bench-plot" width="920" height="150"></canvas>'
      + '<div class="bench-grid"></div>'
      + '<div class="bench-split"></div>'
      + '<div class="bench-sys"></div>'
      + '<p class="bench-foot"></p>'
      + '</div>';
    doc.body.appendChild(root);
    return {
      root,
      strip: root.querySelector('.bench-strip'),
      scene: root.querySelector('.bench-scene'),
      note: root.querySelector('.bench-note'),
      fill: root.querySelector('.bench-bar > i'),
      live: root.querySelector('.bench-live'),
      graph: root.querySelector('.bench-graph'),
      card: root.querySelector('.bench-card'),
      head: root.querySelector('.bench-head'),
      plot: root.querySelector('.bench-plot'),
      grid: root.querySelector('.bench-grid'),
      split: root.querySelector('.bench-split'),
      sys: root.querySelector('.bench-sys'),
      foot: root.querySelector('.bench-foot'),
    };
  }

  /** The rolling frame-time trace during a run: the last 130 frames, as bars. */
  function trace(canvas, list, targetMs) {
    if (!canvas) return;
    const cx = canvas.getContext('2d');
    if (!cx) return;
    const w = canvas.width, h = canvas.height;
    cx.clearRect(0, 0, w, h);
    const recent = list.slice(-130);
    if (!recent.length) return;
    /* Scaled to twice the target or the worst frame, whichever is larger, so
       a smooth run does not draw a flat line at the bottom of the box and a
       rough one is not clipped off the top of it. */
    const top = Math.max(targetMs * 2, Math.max.apply(null, recent) * 1.05);
    const bw = w / recent.length;
    for (let i = 0; i < recent.length; i++) {
      const v = Math.min(1, recent[i] / top);
      const bh = Math.max(1, v * h);
      // over budget is the only thing on this graph that is a different colour
      cx.fillStyle = recent[i] > targetMs ? 'rgba(255,60,90,0.92)' : 'rgba(63,240,255,0.80)';
      cx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh);
    }
    // the budget line, which is the only thing worth comparing a bar against
    const y = h - (targetMs / top) * h;
    cx.strokeStyle = 'rgba(255,190,46,0.75)';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(0, y + 0.5);
    cx.lineTo(w, y + 0.5);
    cx.stroke();
  }

  /** The whole run, in the report: every frame of every scene, end to end. */
  function plot(canvas, scenes, targetMs) {
    if (!canvas) return;
    const cx = canvas.getContext('2d');
    if (!cx) return;
    const w = canvas.width, h = canvas.height;
    cx.clearRect(0, 0, w, h);
    const all = [];
    for (const sc of scenes) for (const v of sc.ms) all.push(v);
    if (!all.length) return;
    const top = Math.max(targetMs * 2, percentile(all, 0.998) * 1.1);
    const bw = w / all.length;
    let x = 0;
    for (const sc of scenes) {
      // a band behind each scene, so the three are readable as three
      cx.fillStyle = 'rgba(120,90,255,0.07)';
      cx.fillRect(x, 0, bw * sc.ms.length, h);
      for (let i = 0; i < sc.ms.length; i++) {
        const v = Math.min(1, sc.ms[i] / top);
        const bh = Math.max(1, v * h);
        cx.fillStyle = sc.ms[i] > targetMs ? 'rgba(255,60,90,0.90)' : 'rgba(63,240,255,0.72)';
        cx.fillRect(x + i * bw, h - bh, Math.max(0.6, bw), bh);
      }
      x += bw * sc.ms.length;
      cx.fillStyle = 'rgba(255,255,255,0.14)';
      cx.fillRect(x - 0.5, 0, 1, h);
    }
    const y = h - (targetMs / top) * h;
    cx.strokeStyle = 'rgba(255,190,46,0.8)';
    cx.setLineDash([4, 4]);
    cx.beginPath();
    cx.moveTo(0, y + 0.5);
    cx.lineTo(w, y + 0.5);
    cx.stroke();
    cx.setLineDash([]);
    /* The budget, labelled - and on a plate, because a caption drawn over a
       hundred bars is a caption nobody can read. Boxed and placed above the
       line rather than on it, at the right where the trace has finished. */
    cx.font = '600 10px Orbitron, "Segoe UI", sans-serif';
    const label = Math.round(1000 / targetMs) + ' FPS';
    const tw = cx.measureText(label).width + 10;
    const ly = Math.max(0, Math.min(h - 15, y - 15));
    cx.fillStyle = 'rgba(6,2,18,0.88)';
    cx.fillRect(w - tw - 6, ly, tw, 14);
    cx.fillStyle = 'rgba(255,190,46,0.95)';
    cx.fillText(label, w - tw - 1, ly + 10);
  }

  /* ----------------------------------------------------------- the display -- */

  function paintRun(g) {
    if (!ui || !run) return;
    if (run.phase === 'calibrate') {
      const preset = LADDER[run.step];
      ui.scene.textContent = 'CALIBRATING // ' + preset;
      ui.note.textContent = 'ranking presets  ' + (run.step + 1) + ' of ' + LADDER.length;
      const done = run.n / (CAL_SETTLE + CAL_FRAMES);
      ui.fill.style.transform = 'scaleX('
        + (((run.step + Math.min(1, done)) / LADDER.length) * 0.35).toFixed(4) + ')';
    } else {
      const sc = run.scenes[run.step];
      ui.scene.textContent = 'SCENE ' + (run.step + 1) + ' OF ' + run.scenes.length
        + ' // ' + sc.name;
      ui.note.textContent = sc.note;
      const done = run.n / SCENE_FRAMES;
      ui.fill.style.transform = 'scaleX('
        + (0.35 + ((run.step + Math.min(1, done)) / run.scenes.length) * 0.65).toFixed(4) + ')';
    }

    /* The live number is the last second of frames rather than the whole run:
       an average over the whole thing stops moving after a few hundred samples,
       and a readout that does not move looks broken. */
    const recent = run.live.slice(-50);
    const ms = mean(recent);
    ui.live.textContent = ms
      ? Math.round(fps(ms)) + ' FPS' + ' ' + ms.toFixed(1) + ' ms'
      : 'warming up';
    trace(ui.graph, run.live, TARGET_MS);
  }

  /** Both halves of the graphics story, in one line each. */
  function systemLines(g) {
    const out = [];
    try {
      const gl = g && g.gl;
      let renderer = 'WebGL2';
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || renderer);
        else renderer = String(gl.getParameter(gl.RENDERER) || renderer);
      }
      out.push(['RENDERER', renderer]);
    } catch (e) { /* a context that will not answer is not a failure */ }
    try {
      const c = g && g.canvas;
      const dpr = global.devicePixelRatio || 1;
      const scale = (g && g.settings && g.settings.renderScale !== undefined)
        ? g.settings.renderScale : null;
      out.push(['DISPLAY', (c ? c.width + ' x ' + c.height : '?')
        + '  backbuffer, ' + Math.round(global.innerWidth * dpr) + ' x '
        + Math.round(global.innerHeight * dpr) + ' window'
        + (scale === null ? '' : '  (render scale ' + scale + ')')]);
    } catch (e) { /* ditto */ }
    out.push(['CORES', String((global.navigator && global.navigator.hardwareConcurrency) || '?')]);
    return out;
  }

  function report(g, rec) {
    if (!ui) return;
    ui.root.classList.remove('is-run');
    ui.root.classList.add('is-done');

    const s = rec.summary;
    const stat = (label, value, unit) => {
      const el = doc.createElement('div');
      el.className = 'bench-stat';
      const b = doc.createElement('b');
      b.textContent = value;
      const small = doc.createElement('small');
      small.textContent = label;
      const u = doc.createElement('i');
      u.textContent = unit || '';
      el.appendChild(small);
      el.appendChild(b);
      el.appendChild(u);
      return el;
    };
    ui.head.textContent = '';
    ui.head.appendChild(stat('AVERAGE', String(Math.round(s.avg)), 'FPS'));
    ui.head.appendChild(stat('1% LOW', String(Math.round(s.low1)), 'FPS'));
    ui.head.appendChild(stat('MINIMUM', String(Math.round(s.min)), 'FPS'));
    ui.head.appendChild(stat('MAXIMUM', String(Math.round(s.max)), 'FPS'));

    plot(ui.plot, rec.scenes, TARGET_MS);

    /* The per-scene table. Three rows and four columns; the interesting column
       is the 1% low, because that is where a scene that is fine on average and
       horrible in one corner shows up. */
    ui.grid.textContent = '';
    const row = (cells, cls) => {
      const r = doc.createElement('div');
      r.className = 'bench-row' + (cls ? ' ' + cls : '');
      for (const c of cells) {
        const d = doc.createElement('span');
        d.textContent = c;
        r.appendChild(d);
      }
      ui.grid.appendChild(r);
    };
    row(['SCENE', 'AVG', '1% LOW', 'MIN', 'MAX'], 'is-head');
    for (const sc of rec.scenes) {
      row([sc.name, Math.round(sc.avg) + '', Math.round(sc.low1) + '',
        Math.round(sc.min) + '', Math.round(sc.max) + '']);
    }

    /* WHERE THE FRAME GOES. One bar, three parts, to scale, with the numbers
       on it - and a sentence saying what it means, because a stacked bar that
       needs a manual is not a report. */
    ui.split.textContent = '';
    const title = doc.createElement('small');
    title.textContent = 'WHERE THE FRAME GOES  -  '
      + s.frameMs.toFixed(1) + ' ms on average';
    ui.split.appendChild(title);
    const bar = doc.createElement('div');
    bar.className = 'bench-split-bar';
    const parts = [
      ['CPU GAME', s.sim, 'is-sim'],
      ['CPU RENDER', s.sub, 'is-sub'],
      ['GPU', s.gpu, 'is-gpu'],
    ];
    const total = Math.max(0.001, s.sim + s.sub + s.gpu);
    for (const [label, ms, cls] of parts) {
      const seg = doc.createElement('i');
      seg.className = cls;
      seg.style.flexGrow = String(Math.max(0.0001, ms));
      seg.textContent = ms >= total * 0.12 ? label + '  ' + ms.toFixed(1) + 'ms' : '';
      seg.title = label + ' ' + ms.toFixed(2) + ' ms';
      bar.appendChild(seg);
    }
    ui.split.appendChild(bar);
    const verdict = doc.createElement('p');
    verdict.className = 'bench-verdict';
    verdict.textContent = s.bound === 'gpu'
      ? 'GPU-BOUND for ' + Math.round(s.gpuBoundPct) + '% of the run. Lowering the '
        + 'render scale or the preset will raise the frame rate.'
      : 'CPU-BOUND for ' + Math.round(100 - s.gpuBoundPct) + '% of the run. A smaller '
        + 'window or a cheaper preset will not help much here.';
    ui.split.appendChild(verdict);

    /* The calibration, kept but demoted: it is how the preset was chosen and
       it is worth being able to see, but it is not the headline. */
    const cal = doc.createElement('div');
    cal.className = 'bench-cal';
    const calTitle = doc.createElement('small');
    calTitle.textContent = 'CALIBRATION  -  what each preset held';
    cal.appendChild(calTitle);
    const calRow = doc.createElement('div');
    calRow.className = 'bench-cal-row';
    for (const r of rec.calibration) {
      const c = doc.createElement('span');
      if (r.preset === rec.preset) c.className = 'is-pick';
      c.textContent = r.preset + '  ' + Math.round(fps(r.p95));
      calRow.appendChild(c);
    }
    cal.appendChild(calRow);
    ui.split.appendChild(cal);

    ui.sys.textContent = '';
    for (const [k, v] of systemLines(g)) {
      const r = doc.createElement('div');
      const a = doc.createElement('b');
      a.textContent = k;
      const b = doc.createElement('span');
      b.textContent = v;
      r.appendChild(a);
      r.appendChild(b);
      ui.sys.appendChild(r);
    }

    ui.foot.textContent = (rec.held
      ? 'APPLIED - ' + rec.preset + ' holds ' + Math.round(fps(TARGET_MS)) + ' FPS here.'
      : 'APPLIED - nothing held ' + Math.round(fps(TARGET_MS)) + ' FPS, so '
        + rec.preset + ' is the closest.')
      + '   PRESS ANY KEY TO QUIT - the launcher will open on these settings.';
  }

  function teardown() {
    if (ui && ui.root && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
    ui = null;
    // ...and the title screen comes back, whatever took the panel away
    if (benchGame) {
      benchGame.benchActive = false;
      benchGame.benchDriving = false;
      benchGame = null;
    }
    if (keyHandler) {
      doc.removeEventListener('keydown', keyHandler, true);
      doc.removeEventListener('pointerdown', keyHandler, true);
      keyHandler = null;
    }
  }

  /* --------------------------------------------------------------- the run -- */

  /** Put the game somewhere fixed and busy, with nothing driving. */
  function stage(g) {
    if (!g || !g.car) return false;
    try {
      /* The same call the game uses to put a car on a route's own line, so
         this cannot drift away from how a race actually starts. */
      if (g.car.reset) g.car.reset(AT, -5.5);
      g.distance = AT;
      /* Rolling rather than parked: a still frame has no motion blur, no tyre
         spray and a temporal resolve with nothing to resolve, and none of
         those are free once the car is moving. */
      g.car.v_long = 55;
      g.car.vLong = 55;
      g.car.speed = 55;
    } catch (e) { return false; }
    return true;
  }

  function apply(g, preset) {
    const idx = LADDER.indexOf(preset);
    if (idx < 0) return;
    g.settings = Object.assign({}, g.settings || {}, { quality: idx });
    /* applySettings is the one place that knows how a preset becomes renderer
       state, so it is asked rather than reimplemented here. */
    if (g.applySettings) g.applySettings();
  }

  /** Which reel entries the three scenes are, resolved by kind. */
  function pickScenes() {
    const reel = NR.ATTRACT_REEL || [];
    const out = [];
    for (const want of SCENE_KINDS) {
      let at = -1;
      for (let i = 0; i < reel.length; i++) {
        if (reel[i].kind === want.kind && out.every((o) => o.reel !== i)) { at = i; break; }
      }
      if (at < 0) at = out.length % Math.max(1, reel.length);
      out.push({
        reel: at,
        name: (reel[at] && reel[at].name) || ('SECTION ' + (at + 1)),
        note: want.note,
        ms: [], sim: [], sub: [],
        avg: 0, min: 0, max: 0, low1: 0,
      });
    }
    return out;
  }

  /** Hand the camera to a scene, from its first frame. */
  function enterScene(g, sc) {
    const reel = NR.ATTRACT_REEL || [];
    const entry = reel[sc.reel];
    g.attractReel = { i: sc.reel, s: entry ? entry.from : 0, air: null };
    g.attractLine = null;
    g.attractCut = true;
    /* The flyby is ours now - see the note on benchDriving in js/game.js. It
       is stepped from `tick` at a fixed rate so every machine drives the same
       road, and the game's own update leaves it alone while this is set. */
    g.benchDriving = true;
    if (g.track && entry) g.camYaw = g.track.at(entry.from, {}).yaw;
  }

  /**
   * Step the benchmark. Called once per frame from the game loop with the real
   * frame time in milliseconds; returns true while it still wants frames.
   */
  function tick(g, ms) {
    if (!run) return false;
    const P = g.phase || { sim: 0, sub: 0 };

    /* ------------------------------------------------------- calibration -- */
    if (run.phase === 'calibrate') {
      if (run.n < CAL_SETTLE) { run.n++; paintRun(g); return true; }
      const k = run.n - CAL_SETTLE;
      run.n++;
      if (k >= CAL_WARMUP && isFinite(ms) && ms > 0) {
        run.samples.push(ms);
        run.live.push(ms);
      }
      paintRun(g);
      if (k < CAL_FRAMES) return true;

      run.calibration.push({
        preset: LADDER[run.step],
        p50: percentile(run.samples, 0.5),
        p95: percentile(run.samples, 0.95),
      });
      run.step++;
      run.samples = [];
      run.n = 0;
      if (run.step < LADDER.length) {
        apply(g, LADDER[run.step]);
        return true;
      }

      /* The ladder is done: choose, apply, and go and actually play. */
      const pick = choose(run.calibration);
      run.preset = pick.preset;
      run.held = pick.held;
      apply(g, pick.preset);
      run.phase = 'scene';
      run.step = 0;
      run.n = 0;
      run.live = [];
      enterScene(g, run.scenes[0]);
      return true;
    }

    /* ------------------------------------------------------------ a scene -- */
    const sc = run.scenes[run.step];
    /* THE CAMERA, STEPPED BY US AND AT A FIXED RATE. This is the line that
       makes two machines comparable; see the note at the top of the file. */
    try { if (g.idleFlyby) g.idleFlyby(STEP); } catch (e) { /* mid-load */ }

    run.n++;
    if (run.n > SCENE_WARMUP && isFinite(ms) && ms > 0) {
      sc.ms.push(ms);
      sc.sim.push(P.sim || 0);
      sc.sub.push(P.sub || 0);
      run.live.push(ms);
    }
    paintRun(g);
    if (run.n < SCENE_FRAMES) return true;

    sc.avg = fps(mean(sc.ms));
    sc.min = fps(Math.max.apply(null, sc.ms.length ? sc.ms : [0]));
    sc.max = fps(Math.min.apply(null, sc.ms.length ? sc.ms : [0]));
    sc.low1 = fps(onePercentLow(sc.ms));

    run.step++;
    run.n = 0;
    run.live = [];
    if (run.step < run.scenes.length) {
      enterScene(g, run.scenes[run.step]);
      return true;
    }
    finish(g);
    return false;
  }

  /* WHAT IT RECOMMENDS.
   *
   * The dearest preset whose 95th percentile still fits in the budget. If none
   * of them do - an old laptop, a software rasteriser - it recommends the
   * cheapest and SAYS it could not hit the target, because "we could not hold
   * sixty" is a useful thing to be told and quietly picking ULTRA is not.
   */
  function choose(results) {
    let best = null;
    for (const r of results) if (r.p95 > 0 && r.p95 <= TARGET_MS) best = r;
    if (best) return { preset: best.preset, held: true };
    return { preset: LADDER[0], held: false };
  }

  /** Everything the three scenes measured, rolled into one answer. */
  function summarise(scenes) {
    const all = [], sim = [], sub = [];
    for (const sc of scenes) {
      for (const v of sc.ms) all.push(v);
      for (const v of sc.sim) sim.push(v);
      for (const v of sc.sub) sub.push(v);
    }
    const frameMs = mean(all);
    const mSim = mean(sim), mSub = mean(sub);
    /* WHATEVER IS LEFT IS THE GPU. Nothing else runs between the end of draw
       and the start of the next frame except the browser presenting, and on a
       machine that is keeping up that wait IS the graphics card. Floored at
       zero because a frame that was scheduled late can measure shorter than
       the work inside it. */
    const gpu = Math.max(0, frameMs - mSim - mSub);
    let bound = 0;
    for (let i = 0; i < all.length; i++) {
      const cpu = (sim[i] || 0) + (sub[i] || 0);
      if (all[i] - cpu > cpu) bound++;
    }
    const gpuBoundPct = all.length ? (bound / all.length) * 100 : 0;
    return {
      frameMs,
      avg: fps(frameMs),
      min: fps(all.length ? Math.max.apply(null, all) : 0),
      max: fps(all.length ? Math.min.apply(null, all) : 0),
      low1: fps(onePercentLow(all)),
      sim: mSim, sub: mSub, gpu,
      gpuBoundPct,
      bound: gpuBoundPct >= 50 ? 'gpu' : 'cpu',
    };
  }

  function finish(g) {
    g.benchDriving = false;
    const rec = {
      when: Date.now(),
      pending: false,
      target: TARGET_MS,
      preset: run.preset,
      held: run.held,
      calibration: run.calibration,
      /* The per-frame arrays are for the report on screen and are not worth
         carrying into a save file - a thousand floats per launch, read by
         nothing. The save keeps the summary and the ladder. */
      scenes: run.scenes,
      summary: summarise(run.scenes),
    };
    /* The old shape, kept so anything that read the previous record still
       finds what it expects: the launcher reads `results` to show the ladder. */
    rec.results = run.calibration.map((r) => ({
      preset: r.preset, p50: r.p50, p95: r.p95, fps: fps(r.p95),
    }));
    apply(g, rec.preset);
    try {
      /* setJSON, not set: set() coerces with String(), which stores an object
         as the four words [object Object] and loses the whole report. */
      if (NR.Save && NR.Save.setJSON) {
        NR.Save.setJSON(NR.Settings.BENCH_KEY, {
          when: rec.when, pending: false, target: rec.target,
          preset: rec.preset, held: rec.held, results: rec.results,
          summary: rec.summary,
        });
      }
      if (NR.Save && NR.Save.flush) NR.Save.flush();
    } catch (e) { /* a save that will not write is not worth failing over */ }
    report(g, rec);
    const done = run.onDone;
    run = null;
    /* AND IT STAYS UP UNTIL IT IS DISMISSED. There used to be a thirty-second
       timer here that tore the card down on its own, from back when dismissing
       it returned to the title screen. Now that any key QUITS, a timer would
       be a benchmark that silently decides you did not want to read it and
       puts you back somewhere you never asked to be. */
    if (done) done(rec);
  }

  /* NOTHING BEHIND THIS SEES A KEY, AND AFTERWARDS ANY KEY LEAVES.
   *
   * The panel sits over a title screen that is still running, so every press
   * is consumed here - a player pressing something to get rid of the report
   * would otherwise confirm a menu row with the same press, which is the
   * defect the opening had and is worth not repeating.
   *
   * WHAT A PRESS DOES DEPENDS ON WHEN IT ARRIVES:
   *
   *   DURING THE RUN, only ESC does anything, and it abandons the run and
   *   puts the title screen back. Any other key is swallowed, because a
   *   measurement that can be ended by leaning on the keyboard is not a
   *   measurement.
   *
   *   ON THE REPORT, anything at all QUITS. The benchmark is reached from
   *   the launcher and the preset it chose has already been written to the
   *   save - both to the game's own settings, through applySettings, and to
   *   the record the launcher reads - so there is nothing left for this
   *   process to do. Going back to a title screen the player never asked for
   *   and making them find QUIT is three extra steps to get to the place the
   *   settings take effect.
   */
  let keyHandler = null;
  function arm() {
    keyHandler = (e) => {
      if (e.type === 'keydown' && e.key === 'Tab') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keyup' || e.type === 'pointerup') return;
      if (run) {
        if (e.key === 'Escape') abort();
        return;
      }
      leave();
    };
    doc.addEventListener('keydown', keyHandler, true);
    doc.addEventListener('pointerdown', keyHandler, true);
  }

  /* The report has been read. The settings are already saved, so this is a
     real exit - the same one the title screen's own QUIT row performs, which
     flushes the save, fades the audio out and asks the host to end the
     process. Under a plain browser there is no process to end and quitGame
     says so rather than pretending; the panel comes down either way so the
     player is not left looking at a report over a game they cannot reach. */
  function leave() {
    const g = benchGame || global.__nr;
    const host = NR.Host;
    if (g && g.quitGame) {
      /* THE CARD STAYS UP WHILE IT GOES. quitGame fades to black over about a
         quarter of a second before asking the host to end the process, and
         tearing the panel down first meant the title screen reappeared for
         exactly that long underneath it - three controls flashing back on
         their way out, which is the thing this change exists to stop. The
         last thing on screen is the result, fading. */
      g.quitGame();
      /* ...unless there is nothing to quit. A browser tab cannot close itself
         unless it opened itself, so under a plain browser the process is
         still here a moment later and the player has to be given the game
         back rather than a frozen report. */
      if (!(host && host.native)) global.setTimeout(teardown, 400);
      return;
    }
    teardown();
    if (host && host.quit) host.quit();
  }

  function abort() {
    const g = global.__nr;
    if (g) g.benchDriving = false;
    run = null;
    teardown();
    if (NR.Gate) NR.Gate.lock(320);
  }

  /** Begin a sweep. `onDone` gets the record. Returns why, if it will not. */
  function start(g, onDone) {
    if (run) return 'already running';
    if (!g || !g.scene || !g.scene.ready) return 'the world is not built yet';
    /* FROM THE TITLE SCREEN, AND NOWHERE ELSE.

       The run takes the camera over and drives it down three stretches of the
       course at a fixed step - which is a fine thing to do to a title screen
       and a ruinous thing to do to a race somebody is in the middle of. The
       handover itself only happens in the menu branch of update (see
       benchDriving in js/game.js), so started from anywhere else this would
       measure three scenes it never actually drove. */
    if (g.state !== 'menu' && g.state !== 'loading') {
      return 'the benchmark runs from the title screen, not from ' + g.state;
    }
    if (!(NR.ATTRACT_REEL && NR.ATTRACT_REEL.length)) return 'there are no scenes to drive';
    if (!stage(g)) return 'the car could not be placed';
    /* THE TITLE SCREEN GOES AWAY FOR THE WHOLE OF THIS.

       Not just for the three scenes - for the calibration in front of them
       and for the report behind them too. START, OPTIONS and QUIT sat on
       screen underneath the panel through the entire run, which is wrong
       twice over: they are three controls that do nothing while a benchmark
       is measuring (every key and click is consumed by the handler in `arm`
       below), and a row of dead buttons behind a live readout reads as a
       screen that has half hung.

       One flag, read by the HUD and by the menu's own input branch, set here
       and cleared in `teardown` - so it covers the report as well, and there
       is exactly one place that can forget to put the menu back. */
    g.benchActive = true;
    benchGame = g;
    ui = build();
    arm();
    run = {
      phase: 'calibrate', step: 0, n: 0,
      samples: [], live: [],
      calibration: [],
      scenes: pickScenes(),
      preset: LADDER[0], held: false,
      onDone,
    };
    apply(g, LADDER[0]);
    paintRun(g);
    return null;
  }

  /* ------------------------------------------------------- the autorun --
   *
   * WHAT THE LAUNCHER ASKED FOR, AND WHY THIS IS NOT THREE LINES.
   *
   * The request is a flag in the save: the host navigates to index.html
   * itself, so there is no query string to put one in, and the answer has to
   * come back the same way it went out because that is the only channel the
   * two screens share.
   *
   * THE BUG THIS REPLACES was not the benchmark failing. It was the benchmark
   * failing SILENTLY, and doing damage on the way past:
   *
   *   `start` returns a reason when it will not run, and the caller threw it
   *   away - so a machine where it could not start showed nothing at all.
   *
   *   The advisory was dismissed and the opening cutscene skipped BEFORE the
   *   attempt, so a failed attempt still took both of them away.
   *
   *   And `pending` was only cleared on success, so once it had failed once
   *   it failed on every launch afterwards - a player who pressed BENCHMARK
   *   once lost their warning screen and their intro permanently, with no
   *   way back short of deleting the save.
   *
   * So: nothing is touched until the sweep is actually running, the flag is
   * cleared whatever happens, and a refusal is said out loud.
   */
  function autorun(g, say) {
    const tell = say || ((m) => { if (g && g.hud && g.hud.toast) g.hud.toast(m, "#ffb400"); });
    let rec = null;
    try {
      rec = NR.Save && NR.Save.getJSON ? NR.Save.getJSON(NR.Settings.BENCH_KEY, null) : null;
    } catch (e) { rec = null; }
    if (!rec || !rec.pending) return false;

    /* CLEARED FIRST, NOT LAST. Whatever happens from here - a refusal, an
       exception, the window being closed halfway through - this must not be
       a launch that benchmarks itself again. The result is written back over
       it when there is one. */
    const clear = () => {
      try {
        if (NR.Save && NR.Save.setJSON) {
          NR.Save.setJSON(NR.Settings.BENCH_KEY, Object.assign({}, rec, { pending: false }));
        }
        if (NR.Save && NR.Save.flush) NR.Save.flush();
      } catch (e) { /* a save that will not write is not worth failing over */ }
    };
    clear();

    let tries = 0;
    const attempt = () => {
      const why = start(g, (out) => {
        tell("BENCHMARK // " + out.preset + "  "
          + Math.round(out.summary.avg) + " FPS average");
      });
      if (!why) {
        /* Only now. The sweep is running, so the notice and the opening move
           would be sitting on top of a measurement. */
        if (NR.Intro && NR.Intro.skip) NR.Intro.skip();
        if (NR.dismissAdvisory) NR.dismissAdvisory();
        return;
      }
      /* "the world is not built yet" is a wait, not a refusal: the dressing
         is still going up. Anything else is a real answer. */
      if (tries++ < 40 && /not built/.test(why)) {
        global.setTimeout(attempt, 250);
        return;
      }
      tell("BENCHMARK COULD NOT START // " + why);
      if (global.console) global.console.warn("SYNX: benchmark refused - " + why);
    };
    attempt();
    return true;
  }

  NR.Bench = {
    start, tick, choose, percentile, onePercentLow, summarise, teardown, autorun,
    get running() { return !!run; },
    /* Which phase it is in, and how many ticks each part takes. Published
       because the only way to test a benchmark is to supply its frame times
       - a real sweep is seven hundred frames and the harness draws about
       one a second - and a test that has to guess where the phase boundary
       is tests its own guess. See --probe bench. */
    get phase() { return run ? run.phase : null; },
    LADDER, TARGET_MS,
    CAL_TICKS: CAL_SETTLE + CAL_FRAMES + 1,
    SCENE_TICKS: SCENE_FRAMES + 1,
    SCENES: SCENE_KINDS.length,
    FRAMES: SCENE_FRAMES,
  };
})(window);
