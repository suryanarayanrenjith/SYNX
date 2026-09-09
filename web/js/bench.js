/* SYNX // the benchmark.
 *
 * WHAT IT IS FOR.
 *
 * The launcher has eleven graphics rows and a preset above them. Nobody who
 * has not read the renderer knows what ambient occlusion costs on their own
 * card, and the honest answer to "which of these should I use" is not an
 * opinion - it is a number, measured on this machine, with this game, at this
 * resolution. So this measures it and then says so.
 *
 * HOW IT WORKS, AND WHY IT IS SHAPED LIKE THIS.
 *
 * It drives the real renderer over a fixed stretch of road at each preset in
 * turn and reports the frame time it actually held. Three things about that
 * matter more than they look:
 *
 *   IT COUNTS FRAMES, NOT SECONDS. "Two seconds per preset" measures two
 *   seconds of a fast machine and two seconds of a slow one - a different
 *   number of samples and a different amount of warm-up in each. A fixed
 *   number of frames is the same experiment everywhere.
 *
 *   IT THROWS THE FIRST ONES AWAY. The frames after a preset change are shader
 *   compiles, render-target reallocation and a cold pipeline. Including them
 *   measures the change rather than the setting.
 *
 *   IT REPORTS THE 95th PERCENTILE, NOT THE MEAN. Nobody notices the average
 *   frame. What they notice is the slow one, and a mean hides those behind a
 *   long tail of fast frames - which is exactly how a setting that stutters
 *   once a second ends up being recommended.
 *
 * IT IS VISIBLE THE WHOLE TIME. A benchmark that runs silently and then
 * changes your settings is indistinguishable from a bug. Every frame it is
 * running, the panel shows which preset is under test, how far through it is,
 * and the frame rate as it happens - and it ends on a table of what each
 * preset held, with the choice and the reason for it.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});
  const doc = global.document;

  /* Cheapest first: the sweep walks this in order and keeps the last one that
     held the target, so a machine that fails at MEDIUM still has LOW measured
     and chosen rather than falling through to nothing. */
  const LADDER = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'];

  /* Frames per preset, and how many of those are discarded. 90 is about a
     second and a half on a machine holding sixty - enough samples for a 95th
     percentile to mean something - and 20 covers the compiles. */
  const FRAMES = 90;
  const WARMUP = 20;
  /* Frames to let a preset change settle before even the warm-up starts.
     Changing quality reallocates every render target in the pipeline. */
  const SETTLE = 8;

  /* The frame time to hold: 16.7ms is sixty a second, which is what the
     simulation is tuned around. */
  const TARGET_MS = 16.7;

  /* Where the camera is put. Far enough into the course to have dressing,
     signage and barriers in shot: a benchmark that samples an empty straight
     recommends settings that fall over the moment anything happens. */
  const AT = 9000;

  let run = null;
  let ui = null;

  function percentile(list, q) {
    if (!list.length) return 0;
    const a = list.slice().sort((x, y) => x - y);
    const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)));
    return a[i];
  }

  /* ------------------------------------------------------------- the panel -- */

  function build() {
    const root = doc.createElement('div');
    root.className = 'bench';
    root.setAttribute('aria-hidden', 'true');

    const card = doc.createElement('div');
    card.className = 'bench-card';

    const rule = doc.createElement('div');
    rule.className = 'bench-rule';
    rule.appendChild(doc.createElement('i'));
    const tag = doc.createElement('span');
    tag.textContent = 'SYNX // BENCHMARK';
    rule.appendChild(tag);
    rule.appendChild(doc.createElement('i'));
    card.appendChild(rule);

    const now = doc.createElement('div');
    now.className = 'bench-now';
    card.appendChild(now);

    const bar = doc.createElement('div');
    bar.className = 'bench-bar';
    const fill = doc.createElement('i');
    bar.appendChild(fill);
    card.appendChild(bar);

    const live = doc.createElement('div');
    live.className = 'bench-live';
    card.appendChild(live);

    const table = doc.createElement('div');
    table.className = 'bench-table';
    card.appendChild(table);

    const foot = doc.createElement('p');
    foot.className = 'bench-foot';
    foot.textContent = 'MEASURING - the game is driving itself. This takes a few seconds.';
    card.appendChild(foot);

    root.appendChild(card);
    doc.body.appendChild(root);
    return { root, card, now, fill, live, table, foot };
  }

  function paint(g) {
    if (!ui || !run) return;
    const preset = LADDER[run.step];
    ui.now.textContent = preset + '   //   ' + (run.step + 1) + ' of ' + LADDER.length;

    const done = run.phase === 'settle' ? 0 : run.n / FRAMES;
    const pct = ((run.step + Math.min(1, done)) / LADDER.length) * 100;
    ui.fill.style.width = pct.toFixed(1) + '%';

    /* The live number is the last second of frames rather than the whole run:
       an average over the whole preset stops moving after a few hundred
       samples, and a readout that does not move looks broken. */
    const recent = run.samples.slice(-45);
    const ms = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    ui.live.textContent = run.phase === 'settle'
      ? 'settling...'
      : (ms ? Math.round(1000 / ms) + ' FPS      ' + ms.toFixed(1) + ' ms/frame      '
        + (run.n > WARMUP ? run.samples.length : 0) + ' samples' : 'warming up...');

    let rows = '';
    for (const r of run.results) {
      rows += r.preset.padEnd(7) + '  ' + String(Math.round(r.fps)).padStart(4) + ' FPS'
        + '   ' + r.p95.toFixed(1) + ' ms\n';
    }
    ui.table.textContent = rows;
  }

  function report(rec) {
    if (!ui) return;
    ui.now.textContent = 'RESULT   //   ' + rec.preset;
    ui.fill.style.width = '100%';
    ui.live.textContent = rec.held
      ? 'holds ' + Math.round(1000 / TARGET_MS) + ' FPS at ' + rec.preset
      : 'nothing here held ' + Math.round(1000 / TARGET_MS) + ' FPS - ' + rec.preset + ' is the closest';
    let rows = '';
    for (const r of rec.results) {
      const mark = r.preset === rec.preset ? ' <-' : '';
      rows += r.preset.padEnd(7) + '  ' + String(Math.round(r.fps)).padStart(4) + ' FPS'
        + '   ' + r.p95.toFixed(1) + ' ms' + mark + '\n';
    }
    ui.table.textContent = rows;
    ui.foot.textContent = 'APPLIED. The launcher will open on these settings.';
    ui.card.classList.add('is-done');
  }

  function teardown() {
    if (ui && ui.root && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
    ui = null;
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

  /**
   * Step the benchmark. Called once per frame from the game loop with the real
   * frame time in milliseconds; returns true while it still wants frames.
   */
  function tick(g, ms) {
    if (!run) return false;
    if (run.phase === 'settle') {
      if (++run.n < SETTLE) { paint(g); return true; }
      run.phase = 'measure';
      run.n = 0;
      run.samples = [];
      paint(g);
      return true;
    }
    run.n++;
    if (run.n > WARMUP && isFinite(ms) && ms > 0) run.samples.push(ms);
    paint(g);
    if (run.n < FRAMES) return true;

    const p50 = percentile(run.samples, 0.5);
    const p95 = percentile(run.samples, 0.95);
    run.results.push({
      preset: LADDER[run.step], p50, p95, fps: p95 > 0 ? 1000 / p95 : 0,
    });

    run.step++;
    if (run.step >= LADDER.length) { finish(g); return false; }
    apply(g, LADDER[run.step]);
    run.phase = 'settle';
    run.n = 0;
    return true;
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

  function finish(g) {
    const pick = choose(run.results);
    const rec = {
      when: Date.now(),
      pending: false,
      target: TARGET_MS,
      results: run.results,
      preset: pick.preset,
      held: pick.held,
    };
    apply(g, pick.preset);
    try {
      /* setJSON, not set: set() coerces with String(), which stores an object
         as the four words [object Object] and loses the whole report. */
      if (NR.Save && NR.Save.setJSON) NR.Save.setJSON(NR.Settings.BENCH_KEY, rec);
      if (NR.Save && NR.Save.flush) NR.Save.flush();
    } catch (e) { /* a save that will not write is not worth failing over */ }
    report(rec);
    const done = run.onDone;
    run = null;
    /* Left on screen to be read. A benchmark whose result vanishes before it
       can be looked at has not reported anything. */
    global.setTimeout(teardown, 9000);
    if (done) done(rec);
  }

  /** Begin a sweep. `onDone` gets the record. Returns why, if it will not. */
  function start(g, onDone) {
    if (run) return 'already running';
    if (!g || !g.scene || !g.scene.ready) return 'the world is not built yet';
    if (!stage(g)) return 'the car could not be placed';
    ui = build();
    run = {
      step: 0, phase: 'settle', n: 0, samples: [], results: [], onDone,
    };
    apply(g, LADDER[0]);
    paint(g);
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
      const why = start(g, (report) => {
        const at = report.results.filter((r) => r.preset === report.preset)[0];
        tell("BENCHMARK // " + report.preset + "  " + (at ? Math.round(at.fps) : 0) + " FPS");
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
    start, tick, choose, percentile, teardown, autorun,
    get running() { return !!run; },
    LADDER, FRAMES, TARGET_MS,
  };
})(window);
