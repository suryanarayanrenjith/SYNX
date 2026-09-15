/* SYNX // THE BOOT BUS.
 *
 * One number, one caption, and a way to let the screen breathe.
 *
 * WHY IT EXISTS
 * -------------
 * The game takes several seconds to come up and four different files know
 * something about how far it has got: js/pak.js is reading forty-two megabytes
 * of archive, js/wasm.js is compiling the simulation core, js/game.js is
 * linking nineteen shader programs, and js/scene.js is unpacking, repairing
 * and dressing a hundred and seventy-five kilometres of course. None of them
 * can see the others, so none of them could ever say "sixty per cent" and mean
 * it - and a loading bar that is one file's guess about the whole boot is a
 * loading bar that hangs at a number for four seconds and then jumps.
 *
 * So the phases are declared HERE, once, with the share of the wait each one
 * is worth, and every file reports only its own fraction of its own phase.
 * The bar is then the truth: it moves whenever anything is happening, at a
 * rate that matches what is actually left, and it never goes backwards.
 *
 * THE WEIGHTS ARE MEASURED, NOT INVENTED. They are roughly the share of a cold
 * start each phase took on the machine this was tuned on. They do not have to
 * be exact - nothing depends on them being right - but a phase whose weight is
 * wildly wrong is a bar that crawls and then leaps, which is the one thing a
 * progress bar must not do.
 *
 * `breathe` IS THE OTHER HALF OF THIS FILE, and it is the more important one.
 *
 * Everything above happens on the only thread the page has, and so does the
 * cold open drawing the tachometer in front of it - so for the whole of a
 * four-hundred-millisecond geometry pass the needle is FROZEN. That is the
 * stutter on the loading screen, and no amount of work on the loading screen
 * fixes it, because the loading screen is not what is slow.
 *
 * `breathe` is a yield: it waits for a frame to be REQUESTED and then for the
 * task after it, which is the point at which the browser has actually painted.
 * A caller that awaits it between two heavy passes gives the cold open a frame
 * to draw in, and the needle keeps moving through a load that is doing exactly
 * as much work as it did before.
 *
 * It is capped rather than patient. On a machine where frames are a second
 * apart - a software rasteriser, a headless capture - waiting for one would
 * add that second to the load for every call, so whichever of the frame and a
 * thirty-two millisecond timer arrives first releases it. The worst case is a
 * load that is no smoother than it used to be, which is where it started.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});

  /* Each phase is a share of the whole wait and the caption shown while it is
     the one being worked on. `at` is how far through that phase we are. */
  const PHASES = [
    { key: 'archive',  label: 'READING ASSET ARCHIVE',   weight: 0.30, at: 0 },
    { key: 'core',     label: 'COMPILING SIMULATION CORE', weight: 0.07, at: 0 },
    { key: 'pipeline', label: 'LINKING RENDER PIPELINE', weight: 0.09, at: 0 },
    { key: 'geometry', label: 'BUILDING COURSE GEOMETRY', weight: 0.14, at: 0 },
    { key: 'textures', label: 'UPLOADING SURFACES',      weight: 0.17, at: 0 },
    { key: 'world',    label: 'DRESSING THE WORLD',      weight: 0.21, at: 0 },
    { key: 'ignition', label: 'SYSTEMS NOMINAL',         weight: 0.02, at: 0 },
  ];
  const BY_KEY = Object.create(null);
  for (const p of PHASES) BY_KEY[p.key] = p;

  const clamp01 = (v) => (v > 1 ? 1 : v < 0 ? 0 : (v || 0));

  const Boot = {
    /** 0..1, monotonic. The only number the loading screen draws. */
    progress: 0,
    /** The caption for whatever is being worked on right now. */
    label: PHASES[0].label,
    /** A second line, when the phase has something concrete to say. */
    detail: '',
    /** True once `finish` has been called - the whole boot, not one phase. */
    done: false,

    /**
     * How far through one phase we are.
     *
     * `frac` is clamped and the total is held monotonic, so a phase that
     * reports 0 after something else has already moved the bar cannot drag it
     * back. `detail` is optional and is shown under the caption.
     */
    set(key, frac, detail) {
      const p = BY_KEY[key];
      if (!p) return;
      const v = clamp01(frac);
      if (v > p.at) p.at = v;
      if (detail !== undefined) Boot.detail = detail === null ? '' : String(detail);
      recompute();
    },

    /** This phase is finished, whatever it last reported. */
    complete(key, detail) { Boot.set(key, 1, detail); },

    /** Every phase is finished. Called once, from the end of the boot chain. */
    finish() {
      for (const p of PHASES) p.at = 1;
      Boot.done = true;
      Boot.detail = '';
      recompute();
      Boot.label = 'SYSTEMS NOMINAL';
    },

    /** Let the compositor have a frame. See the note at the top of the file. */
    breathe() {
      return new Promise((resolve) => {
        let fired = false;
        /* The frame is only half of it. A promise resolved inside a
           requestAnimationFrame callback continues as a MICROTASK, which runs
           before the browser has painted anything - so the caller would go
           straight back to blocking the thread with the frame still only
           queued. The timer is what puts the continuation in the task after
           the paint. */
        const release = () => { if (!fired) { fired = true; global.setTimeout(resolve, 0); } };
        try { global.requestAnimationFrame(release); } catch (e) { /* no rAF here */ }
        /* ...and the cap. A hidden window or a software rasteriser may not
           produce a frame for a long time, and a load that waits for one is a
           load that is slower for being prettier. */
        global.setTimeout(release, 32);
      });
    },

    /** Everything the loading screen needs, in one read. */
    read() {
      return { progress: Boot.progress, label: Boot.label, detail: Boot.detail, done: Boot.done };
    },
  };

  function recompute() {
    let sum = 0, live = null;
    for (const p of PHASES) {
      sum += p.weight * p.at;
      if (!live && p.at < 1) live = p;
    }
    if (sum > Boot.progress) Boot.progress = sum > 1 ? 1 : sum;
    if (live) Boot.label = live.label;
  }

  NR.Boot = Boot;
})(window);
