/* SYNX // IGNITION.
 *
 * The first thing on the screen, before the advisory and before anything else
 * exists: an analogue tachometer, a starter motor, and an engine being revved
 * hard by somebody who is not being careful with it.
 *
 * WHY IT IS HERE AT ALL, which is two reasons that happen to want the same
 * thing.
 *
 *   IT IS THE COLD OPEN. A racing game should announce itself as one before
 *   it announces anything else, and the oldest, plainest way to do that is a
 *   needle and a noise. There is no wordmark on this screen and no title:
 *   what it says is "this is a car", and it says it in about five seconds.
 *
 *   AND IT IS THE LOADING SCREEN. It has to be. The pack is forty-five
 *   megabytes, the core is WebAssembly that has to be compiled, the course is
 *   a hundred and seventy-five kilometres of geometry, and all of it used to
 *   be decoded UNDERNEATH the photosensitivity notice - which is why the
 *   notice's typewriter stuttered: a safety warning animating one character at
 *   a time on a main thread that was busy inflating textures. That is the lag
 *   in the report, and no amount of tuning the typewriter fixes it, because
 *   the typewriter was never the problem.
 *
 *   So the load happens HERE, under a needle, where a stall reads as an engine
 *   holding a gear. The advisory is not shown until this screen is finished
 *   and the main thread has nothing left to do, and it then types on an idle
 *   machine, which is the whole of the fix.
 *
 * NOTHING ON IT IS FROM THE PACK. Every pixel is drawn with canvas 2D and
 * every sound is synthesised from oscillators and noise - no texture, no audio
 * file, no font beyond the two the stylesheet already has. It cannot be
 * waiting for the thing it is covering the wait for.
 *
 * THE REV IS A SCRIPT, NOT A LOOP.
 *
 *   sweep     the needle goes to the stop and comes back, the way a dial
 *             self-tests when the ignition is turned on
 *   crank     the starter, and the engine catching
 *   idle      about nine hundred, with the flutter a big engine has
 *   blips     three of them, each one harder than the last, the third off
 *             the limiter
 *   hold      the final pull, which is where the loading actually lives: it
 *             sits on the limiter bouncing off it for as long as it takes,
 *             and a machine that is still decoding textures is a machine
 *             holding an engine at nine thousand. The one thing this screen
 *             may never do is end before the game is ready.
 *   cut       a flash, and it is gone
 *
 * IT CANNOT BE SKIPPED, and that is deliberate.
 *
 * It used to come down on the first key, click or pad button. Two things were
 * wrong with that. The first is that it is the loading screen: skipping it did
 * not skip a single byte of the load, it only took away the one thing on
 * screen that was telling the player the machine was working, and handed the
 * rest of the wait to a safety notice that then had to type over a busy
 * thread - which is the stutter this screen exists to have fixed. The second
 * is that it is the game's opening title: a cold open that a stray click
 * during window focus can delete is not an opening, it is a thing that
 * sometimes happens.
 *
 * So it runs. Input is still TAKEN - swallowed at the capture phase so that
 * nothing behind it, the advisory's CONTINUE button included, can be pressed
 * through a screen the player cannot see past - it simply does not end it.
 * The only way out is the one that was always the real one: the game being
 * ready, or the ceiling being reached.
 *
 * THE BAR IS REAL. NR.Boot carries one number for the whole boot and every
 * file that does any of the work reports into it - see js/boot.js. The ring
 * around the dial is that number and nothing else: it does not creep on a
 * timer, it does not jump to a hundred before the world exists, and it stops
 * moving when the thread is genuinely blocked, which is honest.
 *
 * AND THE WINDOW OPENS ON IT. The desktop host creates its window hidden and
 * reveals it when the page says it has drawn, and that call used to be at the
 * END of the load - so on a direct launch the player got several seconds of no
 * window at all and then a game, and every frame of this screen was drawn
 * where nobody could see it. It is called from the first frame here instead.
 * That is the whole of the "it takes ages to start" report: it did not, it was
 * invisible while it did it.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});
  const doc = global.document;

  /* ----------------------------------------------------------- the dial --
   *
   * A rev counter, and the numbers on it are a rev counter's. Ten thousand,
   * because the car this game is about is not a road car; the redline at 7800
   * because the limiter has to be somewhere the needle can be HELD, which is
   * the whole point of the last movement.
   */
  const RPM_MAX = 10000;
  const REDLINE = 7800;
  const LIMITER = 9200;
  /* Where the sweep starts and ends, in radians. A car's dial is not a circle:
     it is about two hundred and forty degrees with a gap at the bottom, and the
     gap is what makes the ends of the scale read as ends. */
  const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;

  /* The palette. One cyan, one magenta, one amber - the same three the rest of
     the game is lit with, so this does not look like it came from a different
     program even though it shares no code with one. */
  const CYAN = '#3ff0ff', MAG = '#ff2d9b', AMBER = '#ffbe2e', RED = '#ff2a3c';

  let cv = null, cx = null, veil = null;
  let raf = 0, t0 = 0, running = false, finished = false;
  let onDone = null, skipped = false;
  /* THE INSTRUMENT, DRAWN ONCE.
   *
   * The bezel, the dish, the glass, forty-one ticks, eleven numerals and the
   * empty progress track do not change between frames, and drawing them again
   * sixty times a second - every tick through `glow`, which is three stroked
   * passes with a shadow blur on each - was most of what this screen cost the
   * CPU it is sharing with the load. Blitting one bitmap is one draw.
   *
   * IT IS A SQUARE ROUND THE DIAL, NOT THE WHOLE SCREEN, and that is not a
   * detail. A full-screen cache at a two-times device ratio is another
   * thirty-odd megabytes held at the exact moment the process is already
   * holding the archive, the blobs cut out of it and the canvas this would be
   * a second copy of. The ground is three gradient fills and two stroked
   * paths - it was drawn live before this cache existed and it is drawn live
   * now - so what is worth keeping is the expensive part, and the expensive
   * part is a circle. */
  let dialFace = null, dialR = 0;
  /* How much wider than the dial the cache has to be: the bezel reaches 1.235
     and the progress track sits at 1.34 with a stroke either side of it. */
  const DIAL_PAD = 1.46;
  /* The outro: the beat between the game being ready and the screen leaving.
     A cut straight off the limiter has no ending; this drops the revs, lands
     the stamp and then flashes. */
  let outroAt = 0;
  const OUTRO_MS = 780;
  let shown = false;      // has the host been told there is something to show
  let stamp = 0;          // how far the READY stamp has arrived, 0..1
  /* How far the load has got, and whether it has finished. The needle is not
     driven by these - a gauge that tracks a progress bar is a progress bar with
     a needle on it - but the SEQUENCE is: the hold does not end until `loaded`. */
  let loaded = false, began = 0;
  /* A floor and a ceiling on the whole thing. The floor is so a machine that
     loads instantly still gets the cold open rather than a flash; the ceiling
     is so a machine that never finishes still gets a game. */
  /* The floor is below the length of the script on purpose: what actually
     decides when this ends is the script reaching its hold, which is at 5.32
     seconds. The floor only matters on a path where the script is not running
     - it is the guarantee that a machine which loads instantly still gets a
     cold open rather than a flash. */
  const MIN_MS = 4700, MAX_MS = 26000;

  let rpm = 0, shownRpm = 0, shake = 0, flash = 0;
  let audio = null;

  /* ------------------------------------------------------------- audio --
   *
   * A CROSS-PLANE V8, and it is not made of oscillators.
   *
   * The first version of this was: two detuned sawtooths at the firing
   * frequency, a square an octave down, a lowpass that opened with the revs.
   * It was reported as sounding like a motorcycle, and it was one - a smooth
   * even harmonic series rising in pitch is a small single with an open pipe,
   * and no amount of filtering turns that into a large V8, because the
   * problem was never the spectrum. An engine is a train of discrete,
   * UNEVENLY SPACED pressure pulses ringing a pipe that has its own fixed
   * resonances. None of those three things is something an oscillator does.
   *
   * So the engine proper now lives in js/engine-worklet.js, on the audio
   * thread, where a crank angle can be advanced one sample at a time and the
   * firing events land exactly where the crank puts them. Read that file for
   * what it models and why. This side is the three layers around it that are
   * genuinely continuous and belong on the main graph:
   *
   *   the INDUCTION - air being pulled in, a broad filtered roar that tracks
   *   the throttle more than the revs;
   *   the BLOWER - a supercharger whine, a quiet sine at a high multiple of
   *   the crank speed, which is the one part of a car that IS a pure tone;
   *   the STARTER - a geared whine and the chug of a cold engine turning
   *   over, which stops the moment it catches.
   *
   * AND A FALLBACK. AudioWorklet has been in every shipping browser for
   * years, but a context can still refuse to load a module - a file: origin,
   * a policy, an old embedded webview - and a cold open with no sound is a
   * worse failure than a cold open with an approximate one. The fallback is
   * the old oscillator stack with its filter pulled down two octaves and a
   * tremolo at the half-order standing in for the rumble: not right, but
   * recognisably a car, and nobody should ever hear it.
   */
  function makeAudio() {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    let ctx;
    try { ctx = new AC(); } catch (e) { return null; }

    /* THE PLAYER'S OWN LEVEL, BEFORE ANY OF THIS IS AUDIBLE.
       The launcher's SOUND FX row is five steps from silent to full and it is
       stored before this page ever opens, so somebody who has turned sound off
       does not get an engine in their face as the first thing the game does.
       Read defensively: a corrupt or absent setting is full volume, which is
       what a first launch should be. */
    let level = 1;
    try {
      const raw = global.localStorage.getItem('synx.launcher.v1');
      if (raw) {
        const j = JSON.parse(raw);
        const step = (j && typeof j.sfx === 'number') ? j.sfx : 4;
        level = Math.max(0, Math.min(4, step)) / 4;
      }
    } catch (e) { /* no storage, or nothing stored: full */ }
    if (level <= 0) { try { ctx.close(); } catch (e) { /* already gone */ } return null; }

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    /* A gentle bus compressor over the lot. The exhaust is a pulse train and
       pulse trains have a crest factor a long way above their average, so
       without this the peaks set the level and the engine sits too quietly
       between them - which is the difference between a recording of an engine
       and an engine. */
    let bus = master;
    if (ctx.createDynamicsCompressor) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.12;
      comp.connect(master);
      bus = comp;
    }

    /* ---------------------------------------------------- the induction -- */
    const noise = ctx.createBufferSource();
    {
      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      /* Brown-ish rather than white: an air intake is a low roar, and white
         noise under an engine reads as tape hiss. */
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.035 * w) / 1.035;
        d[i] = last * 3.2;
      }
      noise.buffer = buf;
      noise.loop = true;
    }
    const air = ctx.createBiquadFilter();
    air.type = 'bandpass';
    air.frequency.value = 300;
    air.Q.value = 0.7;
    const airGain = ctx.createGain();
    airGain.gain.value = 0;
    noise.connect(air);
    air.connect(airGain);
    airGain.connect(bus);
    noise.start();

    /* ------------------------------------------------------- the blower -- */
    const blower = ctx.createOscillator();
    blower.type = 'sine';
    blower.frequency.value = 200;
    const blowerGain = ctx.createGain();
    blowerGain.gain.value = 0;
    blower.connect(blowerGain);
    blowerGain.connect(bus);
    blower.start();

    /* ------------------------------------------------------ the starter -- */
    const crank = ctx.createOscillator();
    crank.type = 'triangle';
    crank.frequency.value = 30;
    const crankGain = ctx.createGain();
    crankGain.gain.value = 0;
    crank.connect(crankGain);
    crankGain.connect(bus);
    crank.start();

    /* ------------------------------------------------------ the engine --- */
    const rig = {
      ctx, master, level,
      node: null,          // the worklet, once it has loaded
      fallback: null,      // ...or the oscillator stack, if it never does
      set(rpm, load, open, cut) {
        const now = ctx.currentTime, k = 0.02;
        if (this.node) {
          const p = this.node.parameters;
          p.get('rpm').setTargetAtTime(rpm, now, k);
          p.get('load').setTargetAtTime(load, now, k);
          p.get('gain').setTargetAtTime(open * 0.9, now, 0.03);
          p.get('cut').value = cut || 0;
        } else if (this.fallback) {
          this.fallback(rpm, load, open);
        }
        /* The layers on this side. The firing frequency of an eight-cylinder
           four-stroke is four events a revolution, and the induction and the
           blower are both tied to it rather than to the rpm directly so that
           everything on this screen is describing the same engine. */
        const hz = Math.max(12, (rpm / 60) * 4);
        air.frequency.setTargetAtTime(Math.min(1800, 140 + hz * 1.5), now, 0.04);
        airGain.gain.setTargetAtTime(open * (0.02 + load * 0.16), now, 0.05);
        // a blower turns two and a half times for every turn of the crank
        blower.frequency.setTargetAtTime((rpm / 60) * 2.6 * 3, now, 0.03);
        blowerGain.gain.setTargetAtTime(open * load * 0.020, now, 0.06);
        master.gain.setTargetAtTime(open * level * 0.62, now, 0.04);
      },
      starter(on, speed) {
        const now = ctx.currentTime;
        crankGain.gain.setTargetAtTime(on ? 0.09 * level : 0, now, 0.05);
        crank.frequency.setTargetAtTime(28 + speed * 120, now, 0.06);
      },
      stop() {
        try {
          master.gain.cancelScheduledValues(ctx.currentTime);
          master.gain.setTargetAtTime(0, ctx.currentTime, 0.06);
          if (this.node) this.node.port.postMessage('stop');
          setTimeout(() => { try { ctx.close(); } catch (e) { /* gone */ } }, 400);
        } catch (e) { /* the context went away under us; nothing to do */ }
      },
    };

    /* THE WORKLET, ASKED FOR ASYNCHRONOUSLY AND NEVER WAITED FOR.

       addModule is a fetch and a compile. The cold open is on screen inside
       one frame and cannot block on either, so the fallback is wired up NOW
       and the worklet replaces it if and when it arrives - which on any
       modern machine is well inside the first half second, during the dial
       self-test, before there is an engine to hear. */
    rig.fallback = makeFallback(ctx, bus);
    global.__ignRig = 0;
    if (ctx.audioWorklet && ctx.audioWorklet.addModule) {
      ctx.audioWorklet.addModule('js/engine-worklet.js?v=rust-1').then(() => {
        if (!rig.ctx || rig.ctx.state === 'closed') return;
        const node = new global.AudioWorkletNode(ctx, 'synx-engine', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        });
        node.connect(bus);
        // ...and the approximation stands down without a seam
        if (rig.fallback && rig.fallback.mute) rig.fallback.mute();
        rig.node = node;
        // so the harness can tell a worklet run from a fallback one
        global.__ignRig = 1;
      }).catch(() => { /* the fallback is already playing; leave it alone */ });
    }
    return rig;
  }

  /* THE APPROXIMATION, for a context that will not load a worklet.

     Deliberately not the thing it replaces. The old stack's two faults were a
     filter that opened to nine kilohertz - which is what made it scream - and
     a perfectly even pulse rate, which is what made it a single. Here the
     filter tops out at eighteen hundred, and a tremolo at half the firing
     rate stands in for the uneven banks, which gets some of the rumble
     without any of the machinery. Not right. Recognisably a car. */
  function makeFallback(ctx, out) {
    const shaper = ctx.createWaveShaper();
    {
      const n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 2.6) * 0.9;
      }
      shaper.curve = curve;
      shaper.oversample = '2x';
    }
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 300;
    tone.Q.value = 1.4;
    const lump = ctx.createGain();          // the tremolo the banks would give
    lump.gain.value = 1;
    const bark = ctx.createBiquadFilter();
    bark.type = 'peaking';
    bark.frequency.value = 118;
    bark.Q.value = 1.2;
    bark.gain.value = 9;
    const level = ctx.createGain();
    level.gain.value = 0;
    shaper.connect(tone); tone.connect(bark); bark.connect(lump);
    lump.connect(level); level.connect(out);

    const mk = (type, detune, gain) => {
      const o = ctx.createOscillator();
      o.type = type; o.detune.value = detune;
      const g = ctx.createGain(); g.gain.value = gain;
      o.connect(g); g.connect(shaper); o.start();
      return o;
    };
    const a = mk('sawtooth', 0, 0.30);
    const b = mk('sawtooth', 11, 0.24);
    const c = mk('square', -5, 0.20);
    // the rumble, such as it is: a half-order wobble under the whole thing
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.34;
    lfo.connect(lfoGain); lfoGain.connect(lump.gain); lfo.start();

    const fn = (rpm, load, open) => {
      const now = ctx.currentTime, k = 0.02;
      const hz = Math.max(12, (rpm / 60) * 4);
      a.frequency.setTargetAtTime(hz, now, k);
      b.frequency.setTargetAtTime(hz, now, k);
      c.frequency.setTargetAtTime(hz * 0.5, now, k);
      lfo.frequency.setTargetAtTime(hz * 0.5, now, k);
      tone.frequency.setTargetAtTime(Math.min(1800, 180 + hz * 1.1 + load * 520), now, 0.03);
      level.gain.setTargetAtTime(open * 0.55, now, 0.04);
    };
    fn.mute = () => {
      try { level.gain.setTargetAtTime(0, ctx.currentTime, 0.05); } catch (e) { /* gone */ }
    };
    return fn;
  }
  /* ------------------------------------------------------- the sequence --
   *
   * One function of time, returning the revs and how hard the throttle is
   * being asked for. Written as a table of moments rather than as a state
   * machine because that is what it is: a performance, with a beginning and
   * an end, and the only branch in it is the hold at the end that waits for
   * the loading.
   */
  function script(t) {
    // [0.00 .. 0.90]  the sweep: needle to the stop and back, dial self-test
    if (t < 0.45) return { rpm: RPM_MAX * ease(t / 0.45), load: 0, crank: 0, live: false };
    if (t < 0.95) return { rpm: RPM_MAX * (1 - ease((t - 0.45) / 0.5)), load: 0, crank: 0, live: false };
    // [0.95 .. 1.75]  the starter turning it over
    if (t < 1.75) {
      const k = (t - 0.95) / 0.8;
      const chug = Math.sin(t * 44) * 0.5 + 0.5;
      return { rpm: 180 + chug * 190 * k, load: 0, crank: 0.3 + k * 0.7, live: false };
    }
    // [1.75 .. 2.35]  it catches, overshoots, and settles
    if (t < 2.35) {
      const k = (t - 1.75) / 0.6;
      const flare = Math.sin(Math.PI * Math.min(1, k * 1.4)) * 1750;
      return { rpm: 900 + flare * (1 - k * 0.55), load: 0.45 * (1 - k), crank: 0, live: true };
    }
    // ...and from here on it is idling unless something says otherwise
    const idle = () => 900 + Math.sin(t * 9.3) * 32 + Math.sin(t * 23.7) * 14;

    /* THE THREE BLIPS. Each is a rise and a fall, and the fall is slower than
       the rise - an engine accelerates against its own inertia and decelerates
       against nothing but friction, and getting that backwards is the single
       most obvious way to make a rev sound synthetic. */
    /* TIGHTENED, because it can no longer be skipped.
       Every one of these is a third of a second earlier than it was and the
       falls are a little quicker. It is the same performance - three blips,
       each harder than the last, the third off the limiter - and it reaches
       its hold half a second sooner, which on a machine that has already
       finished loading is half a second of a screen nobody can leave. */
    const BLIP = [
      { at: 2.35, up: 0.30, down: 0.44, peak: 4300 },
      { at: 3.15, up: 0.26, down: 0.48, peak: 6400 },
      { at: 3.95, up: 0.30, down: 0.52, peak: LIMITER },
    ];
    for (const b of BLIP) {
      if (t < b.at) break;
      if (t < b.at + b.up + b.down) {
        const base = idle();
        if (t < b.at + b.up) {
          const k = (t - b.at) / b.up;
          return { rpm: base + (b.peak - base) * ease(k), load: 1, crank: 0, live: true };
        }
        const k = (t - b.at - b.up) / b.down;
        /* ...and off the limiter on the way. A limiter does not hold a needle
           still, it cuts the ignition and lets it fall a hundred revs and
           catches it again, twelve or fifteen times a second. */
        const bounce = (b.peak >= LIMITER && k < 0.22) ? Math.abs(Math.sin(t * 82)) * 340 : 0;
        return {
          rpm: b.peak - bounce - (b.peak - base) * ease(k),
          load: k < 0.22 ? 1 : 0,
          crank: 0, live: true,
        };
      }
    }

    /* THE HOLD. The last movement, and the one that is not on a clock: the
       engine goes to the limiter and STAYS there, bouncing, until the game
       says it is ready. Everything above takes five and a bit seconds; a slow
       machine spends the rest of its loading here, and what that looks like is
       a car being held against its limiter, which is a thing that happens. */
    const k = Math.min(1, (t - 4.80) / 0.52);
    const held = 2200 + (LIMITER - 2200) * ease(Math.max(0, k));
    const bounce = k >= 1 ? Math.abs(Math.sin(t * 78)) * 380 : 0;
    return { rpm: held - bounce, load: 1, crank: 0, live: true, holding: k >= 1 };
  }

  function ease(k) {
    k = Math.max(0, Math.min(1, k));
    return k * k * (3 - 2 * k);
  }

  /* --------------------------------------------------------- the drawing --
   *
   * WHAT IS CACHED AND WHAT IS NOT, which is the whole performance story.
   *
   * The INSTRUMENT is drawn once into a square offscreen canvas and blitted:
   * the bezel, the dish, the glass, forty-one ticks, eleven numerals and the
   * empty progress track. It matters here more than anywhere else in the game,
   * because this screen shares its thread with the thing it is covering the
   * wait for - every millisecond spent re-rasterising a numeral that has not
   * changed is a millisecond the course is not being built in, and the tick
   * loop alone was forty-one passes through `glow`, which is three stroked
   * paths with a shadow blur on each, sixty times a second.
   *
   * Everything else is live, and deliberately: the ground is three gradient
   * fills, the floor is two stroked paths, the wordmark is two fillTexts and
   * the frame is one. None of them is worth a second full-screen bitmap held
   * at the moment the process is already holding the archive, the blobs cut
   * out of it and the canvas that bitmap would be a copy of. See dialFace.
   */

  /** Device pixels per CSS pixel, capped - a 4K loading screen is not worth it. */
  function dpr() { return Math.min(2, global.devicePixelRatio || 1); }

  function resize() {
    const d = dpr();
    const w = doc.documentElement.clientWidth, h = doc.documentElement.clientHeight;
    cv.width = Math.max(1, Math.round(w * d));
    cv.height = Math.max(1, Math.round(h * d));
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    cx.setTransform(d, 0, 0, d, 0, 0);
    // the cached instrument is sized off the dial's radius, which just moved
    dialFace = null;
  }

  /* ------------------------------------------------------- the geometry --
   *
   * One function, so the live layer and the cached layer cannot disagree about
   * where the dial is. Everything on this screen is placed off `L`.
   */
  function layout(w, h) {
    const r = Math.min(w * 0.30, h * 0.30);
    return {
      w, h, r,
      cx: w * 0.5,
      cy: h * 0.42,
      ring: r * 1.34,          // the progress arc, outside the bezel
      markY: h * 0.795,        // the wordmark
      capY: h * 0.862,         // what is being worked on
      railY: h * 0.902,        // the bar
      railW: Math.min(w * 0.44, 520),
      detailY: h * 0.944,      // the count, when a phase has one
    };
  }

  /** A stroked path drawn three times, wide and faint to thin and bright.
      Canvas has no bloom; three passes and a shadow is what it has instead,
      and it is the difference between a neon line and a coloured one. */
  function glow(c, colour, width, alpha, path) {
    const passes = [[width * 3.4, alpha * 0.12], [width * 1.9, alpha * 0.22], [width, alpha]];
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const [w, a] of passes) {
      c.save();
      c.globalAlpha = a;
      c.strokeStyle = colour;
      c.lineWidth = w;
      c.shadowColor = colour;
      c.shadowBlur = w * 2.2;
      path(c);
      c.stroke();
      c.restore();
    }
  }

  function arcPath(r, from, to) {
    return (c) => { c.beginPath(); c.arc(0, 0, r, from, to); };
  }

  /** Where a rev value sits on the scale, in radians. */
  function aOf(v) {
    return A0 + (A1 - A0) * Math.max(0, Math.min(1, v / RPM_MAX));
  }

  const font = (px, weight) =>
    (weight || 600) + ' ' + Math.round(px) + 'px Orbitron, "Segoe UI", sans-serif';

  /* ------------------------------------------------------ the cached half */

  /** The side of the cached square, in CSS pixels. */
  function dialSide(L) { return L.r * 2 * DIAL_PAD; }

  function buildDial(L) {
    const d = dpr();
    const side = dialSide(L);
    if (!dialFace) dialFace = doc.createElement('canvas');
    dialFace.width = Math.max(1, Math.round(side * d));
    dialFace.height = Math.max(1, Math.round(side * d));
    const c = dialFace.getContext('2d');
    if (!c) { dialFace = null; return; }
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, side, side);
    c.translate(side / 2, side / 2);
    bezel(c, L);
    scale(c, L);
    dialR = L.r;
  }

  /* The place the dial is standing in. A flat black rectangle is not a place;
     a horizon with a grid running off it is, and it is four strokes. */
  function ground(c, L) {
    const w = L.w, h = L.h;
    const g = c.createRadialGradient(w * 0.5, h * 0.44, 0, w * 0.5, h * 0.44, Math.max(w, h) * 0.72);
    g.addColorStop(0, '#170e32');
    g.addColorStop(0.5, '#0a0620');
    g.addColorStop(1, '#02010a');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    /* A wash of the two house colours into the top corners, so the frame has a
       light in it rather than being an even field with a dial on it. */
    const washes = [
      [w * 0.14, h * 0.10, 'rgba(255,45,155,0.16)', Math.max(w, h) * 0.46],
      [w * 0.88, h * 0.16, 'rgba(63,240,255,0.13)', Math.max(w, h) * 0.42],
    ];
    for (const [x, y, col, rad] of washes) {
      const s = c.createRadialGradient(x, y, 0, x, y, rad);
      s.addColorStop(0, col);
      s.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = s;
      c.fillRect(0, 0, w, h);
    }

    // the verticals of the floor, which never move
    const hz = h * 0.74;
    c.save();
    c.globalAlpha = 0.26;
    c.strokeStyle = '#6a2bff';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = -14; i <= 14; i++) {
      c.moveTo(w * 0.5 + i * w * 0.055, hz);
      c.lineTo(w * 0.5 + i * w * 0.42, h + 2);
    }
    c.stroke();
    c.restore();
  }

  /* The instrument's body: a machined ring, a glass face and a highlight
     across it. Three gradients, and they are what stop this reading as a
     circle with lines in it. */
  /* Both of these draw about the origin: the cache translates to the middle
     of its own square before calling them, and nothing else does. */
  function bezel(c, L) {
    const r = L.r;
    c.save();

    // the outer ring, lit from above like a turned metal bezel
    const metal = c.createLinearGradient(0, -r * 1.3, 0, r * 1.3);
    metal.addColorStop(0.00, '#6b5ca8');
    metal.addColorStop(0.18, '#2a1f4e');
    metal.addColorStop(0.50, '#150d2c');
    metal.addColorStop(0.84, '#392c66');
    metal.addColorStop(1.00, '#0d0720');
    c.fillStyle = metal;
    c.beginPath();
    c.arc(0, 0, r * 1.235, 0, Math.PI * 2);
    c.fill();

    // the face itself, darker at the rim than at the centre
    const dish = c.createRadialGradient(0, -r * 0.34, r * 0.08, 0, 0, r * 1.18);
    dish.addColorStop(0, 'rgba(34,22,68,0.96)');
    dish.addColorStop(0.62, 'rgba(14,8,34,0.97)');
    dish.addColorStop(1, 'rgba(4,2,14,0.99)');
    c.fillStyle = dish;
    c.beginPath();
    c.arc(0, 0, r * 1.16, 0, Math.PI * 2);
    c.fill();

    glow(c, '#3a2a70', 8, 0.85, arcPath(r * 1.195, 0, Math.PI * 2));
    glow(c, CYAN, 2, 0.5, arcPath(r * 1.05, A0, A1));

    // the redline, which is a band on the scale rather than a number on it
    glow(c, RED, 7, 0.72, arcPath(r * 1.00, aOf(REDLINE), aOf(RPM_MAX)));

    /* The glass. One soft ellipse across the upper left, clipped to the face -
       the single cheapest thing that turns a drawn circle into an object with
       a cover on it. */
    c.save();
    c.beginPath();
    c.arc(0, 0, r * 1.15, 0, Math.PI * 2);
    c.clip();
    const sheen = c.createLinearGradient(-r, -r * 1.1, r * 0.4, r * 0.5);
    sheen.addColorStop(0, 'rgba(255,255,255,0.085)');
    sheen.addColorStop(0.45, 'rgba(255,255,255,0.018)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = sheen;
    c.beginPath();
    c.ellipse(-r * 0.24, -r * 0.52, r * 1.05, r * 0.62, -0.38, 0, Math.PI * 2);
    c.fill();
    c.restore();

    c.restore();
  }

  /* Ticks and numerals: one major per thousand, three minors between. */
  function scale(c, L) {
    const r = L.r;
    c.save();
    for (let i = 0; i <= RPM_MAX; i += 250) {
      const major = i % 1000 === 0;
      const a = aOf(i);
      const inner = major ? r * 0.85 : r * 0.915;
      const col = i >= REDLINE ? RED : '#cfe6ff';
      c.save();
      c.globalAlpha = major ? 0.95 : 0.38;
      c.strokeStyle = col;
      c.lineWidth = major ? Math.max(2, r * 0.016) : Math.max(1, r * 0.007);
      c.lineCap = major ? 'butt' : 'round';
      c.shadowColor = col;
      c.shadowBlur = major ? 10 : 0;
      c.beginPath();
      c.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      c.lineTo(Math.cos(a) * r * 0.99, Math.sin(a) * r * 0.99);
      c.stroke();
      c.restore();
      if (!major) continue;
      const rr = r * 0.70;
      c.save();
      c.globalAlpha = 0.94;
      c.fillStyle = i >= REDLINE ? RED : '#eaf6ff';
      c.font = font(r * 0.15, 600);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.shadowColor = i >= REDLINE ? RED : CYAN;
      c.shadowBlur = 12;
      c.fillText(String(i / 1000), Math.cos(a) * rr, Math.sin(a) * rr);
      c.restore();
    }

    /* The unit, under the readout. The needle sweeps the whole dial and the
       one place it can never reach is the gap at the bottom, which is where
       the scale starts and ends - anything written anywhere else on the face
       gets a needle through it twice a second. */
    c.save();
    c.globalAlpha = 0.5;
    c.fillStyle = '#9fb6d8';
    c.font = font(r * 0.095, 600);
    c.textAlign = 'center';
    c.fillText('x1000  r/min', 0, r * 0.60);
    c.restore();

    /* The track the progress arc fills, so the ring reads as an empty gauge
       before anything has loaded rather than as nothing at all. */
    c.save();
    c.strokeStyle = 'rgba(126,152,208,0.20)';
    c.lineWidth = Math.max(2, r * 0.026);
    c.lineCap = 'round';
    c.beginPath();
    c.arc(0, 0, L.ring, A0, A1);
    c.stroke();
    c.restore();

    c.restore();
  }

  /* The name, once, small, under the instrument. The first version of this
     screen had no wordmark on it at all, on the grounds that it should say
     "this is a car" rather than "this is SYNX". It can do both: the dial is
     three quarters of the frame and says the first, and four letters at a
     tenth of its size say the second without arguing with it. */
  function wordmark(c, L) {
    const size = Math.max(16, Math.min(L.w * 0.042, L.r * 0.30));
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = font(size, 900);
    const t = 'S Y N X';
    c.globalAlpha = 0.9;
    c.shadowColor = MAG;
    c.shadowBlur = size * 1.1;
    c.fillStyle = 'rgba(255,45,155,0.55)';
    c.fillText(t, L.cx, L.markY);
    c.shadowBlur = 0;
    // the chrome ramp the rest of the game's headlines use
    const ramp = c.createLinearGradient(0, L.markY - size * 0.6, 0, L.markY + size * 0.6);
    ramp.addColorStop(0.00, '#ffffff');
    ramp.addColorStop(0.42, '#c9baff');
    ramp.addColorStop(0.52, '#4a3390');
    ramp.addColorStop(0.62, '#ffd977');
    ramp.addColorStop(1.00, '#ff5fb0');
    c.globalAlpha = 1;
    c.fillStyle = ramp;
    c.fillText(t, L.cx, L.markY);
    c.restore();
  }

  /* Corner ticks around the whole frame. The same language the rest of the
     interface is built out of, so the first screen belongs to the game. */
  function edging(c, L) {
    const m = Math.max(18, Math.min(L.w, L.h) * 0.045);
    const len = Math.max(24, Math.min(L.w, L.h) * 0.065);
    const x0 = m, y0 = m, x1 = L.w - m, y1 = L.h - m;
    c.save();
    c.globalAlpha = 0.42;
    c.strokeStyle = 'rgba(139,92,246,0.85)';
    c.lineWidth = 2;
    c.beginPath();
    const corners = [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]];
    for (const [x, y, sx, sy] of corners) {
      c.moveTo(x, y + sy * len); c.lineTo(x, y); c.lineTo(x + sx * len, y);
    }
    c.stroke();
    c.restore();
  }

  /* --------------------------------------------------------- the live half */

  /** The floor lines, which are the only part of the ground that moves. */
  function floorLines(c, L, t) {
    const hz = L.h * 0.74;
    c.save();
    c.globalAlpha = 0.28;
    c.strokeStyle = '#7a3bff';
    c.lineWidth = 1;
    c.beginPath();
    /* Exponential spacing, so they crowd at the horizon the way perspective
       does, and they scroll towards the viewer. */
    const scroll = (t * 0.45) % 1;
    for (let i = 0; i < 16; i++) {
      const k = (i + scroll) / 16;
      const y = hz + (L.h - hz) * (k * k * k);
      c.moveTo(0, y);
      c.lineTo(L.w, y);
    }
    c.stroke();
    c.restore();
  }

  /** Everything on the dial that changes: the sweep, the needle, the lamps. */
  function dial(c, L, value, live, t) {
    const r = L.r;
    c.save();
    c.translate(L.cx, L.cy);

    /* THE SWEPT ARC. Everything the needle has already passed is lit, so the
       dial reads at a glance even at the speed the needle moves here - and it
       turns from cyan through amber to red as the engine runs out of room. */
    const lit = value >= REDLINE ? RED : (value >= REDLINE * 0.72 ? AMBER : CYAN);
    if (value > 40) glow(c, lit, 9, 0.85, arcPath(r * 0.79, A0, aOf(value)));

    /* THE READOUT. Four digits under the hub, with the actual number - a dial
       with a fake number under it is a dial nobody believes. */
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = font(r * 0.19, 700);
    const txt = String(Math.max(0, Math.round(value))).padStart(4, '0');
    c.globalAlpha = 0.16;
    c.fillStyle = '#20304a';
    c.fillText('8888', 0, r * 0.40);
    c.globalAlpha = 1;
    c.fillStyle = value >= REDLINE ? RED : AMBER;
    c.shadowColor = value >= REDLINE ? RED : AMBER;
    c.shadowBlur = 16;
    c.fillText(txt, 0, r * 0.40);
    c.restore();

    /* THE NEEDLE. Tapered, counterweighted, and with its own light: the
       glowing tip is what the eye actually tracks at these speeds, and a
       needle drawn as a plain line reads as a clock hand. */
    const a = aOf(value);
    c.save();
    c.rotate(a);
    /* Its shadow on the face, a touch off-axis, which is what puts the needle
       ABOVE the dial rather than printed on it. */
    c.save();
    c.globalAlpha = 0.45;
    c.fillStyle = '#05020f';
    c.beginPath();
    c.moveTo(-r * 0.20, -r * 0.026 + r * 0.02);
    c.lineTo(r * 0.98, -r * 0.008 + r * 0.02);
    c.lineTo(r * 0.98, r * 0.010 + r * 0.02);
    c.lineTo(-r * 0.20, r * 0.030 + r * 0.02);
    c.closePath();
    c.fill();
    c.restore();
    c.shadowColor = value >= REDLINE ? RED : MAG;
    c.shadowBlur = 26;
    c.fillStyle = value >= REDLINE ? RED : MAG;
    c.beginPath();
    c.moveTo(-r * 0.20, -r * 0.028);
    c.lineTo(r * 0.985, -r * 0.009);
    c.lineTo(r * 0.985, r * 0.009);
    c.lineTo(-r * 0.20, r * 0.028);
    c.closePath();
    c.fill();
    c.globalAlpha = 0.9;
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.moveTo(r * 0.80, -r * 0.010);
    c.lineTo(r * 0.985, -r * 0.006);
    c.lineTo(r * 0.985, r * 0.006);
    c.lineTo(r * 0.80, r * 0.010);
    c.closePath();
    c.fill();
    c.restore();

    // the hub, over the tail of the needle
    c.save();
    const hub = c.createRadialGradient(0, -r * 0.05, 0, 0, 0, r * 0.14);
    hub.addColorStop(0, '#5a4898');
    hub.addColorStop(1, '#100920');
    c.fillStyle = hub;
    c.beginPath();
    c.arc(0, 0, r * 0.125, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = live ? MAG : '#2a1b52';
    c.lineWidth = 2;
    c.shadowColor = MAG;
    c.shadowBlur = live ? 14 : 0;
    c.stroke();
    c.restore();

    /* A pair of warning lamps either side of the hub, because a rev counter
       on its own is an instrument and a rev counter with lamps is a CAR. They
       are real: one is on while the starter is turning and goes out when the
       engine catches, the other comes on at the limiter. */
    const lamp = (x, on, colour) => {
      c.save();
      c.globalAlpha = on ? 1 : 0.16;
      c.fillStyle = on ? colour : '#26304a';
      c.shadowColor = colour;
      c.shadowBlur = on ? 18 : 0;
      c.beginPath();
      c.arc(x, -r * 0.42, r * 0.035, 0, Math.PI * 2);
      c.fill();
      c.restore();
    };
    lamp(-r * 0.30, !live && t > 0.95, AMBER);
    lamp(r * 0.30, value >= REDLINE, RED);

    c.restore();
  }

  /* -------------------------------------------------------- the progress --
   *
   * The ring, the caption, the rail and the count, and every one of them is
   * reading NR.Boot rather than a clock. See the note at the top of the file.
   */
  function progress(c, L, p, label, detail) {
    const r = L.ring;
    if (p > 0.0015) {
      c.save();
      c.translate(L.cx, L.cy);
      const end = A0 + (A1 - A0) * p;
      /* Violet into cyan, which is neither of the colours the dial itself uses
         at any point in its sweep - so the ring can never be mistaken for a
         second reading off the instrument. */
      const g = c.createLinearGradient(-r, -r, r, r);
      g.addColorStop(0, '#8b5cf6');
      g.addColorStop(1, CYAN);
      c.save();
      c.strokeStyle = g;
      c.lineWidth = Math.max(2, L.r * 0.026);
      c.lineCap = 'round';
      c.shadowColor = CYAN;
      c.shadowBlur = 18;
      c.globalAlpha = 0.95;
      c.beginPath();
      c.arc(0, 0, r, A0, end);
      c.stroke();
      c.restore();
      // the head of it, so the eye can find where it has got to
      c.save();
      c.fillStyle = '#eaffff';
      c.shadowColor = CYAN;
      c.shadowBlur = 20;
      c.beginPath();
      c.arc(Math.cos(end) * r, Math.sin(end) * r, Math.max(2.4, L.r * 0.020), 0, Math.PI * 2);
      c.fill();
      c.restore();
      c.restore();
    }

    // the caption: what is being worked on right now
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const cap = Math.max(9, Math.min(L.w * 0.0125, 15));
    c.font = font(cap, 600);
    c.globalAlpha = 0.86;
    c.fillStyle = '#9fc4e8';
    c.shadowColor = 'rgba(63,240,255,0.5)';
    c.shadowBlur = 12;
    c.fillText(spaced(label || ''), L.cx, L.capY);
    c.restore();

    // the rail, which is the same number the ring is
    const rw = L.railW, rh = Math.max(3, L.h * 0.0055);
    const x = L.cx - rw / 2, y = L.railY - rh / 2;
    c.save();
    c.fillStyle = 'rgba(126,152,208,0.16)';
    c.fillRect(x, y, rw, rh);
    if (p > 0.001) {
      const g = c.createLinearGradient(x, 0, x + rw, 0);
      g.addColorStop(0, MAG);
      g.addColorStop(1, CYAN);
      c.fillStyle = g;
      c.shadowColor = CYAN;
      c.shadowBlur = 14;
      c.fillRect(x, y, rw * p, rh);
    }
    c.restore();

    // ...and the number, above the rail's right-hand end
    c.save();
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    c.font = font(Math.max(10, Math.min(L.w * 0.0125, 15)), 700);
    c.fillStyle = '#eaf6ff';
    c.globalAlpha = 0.92;
    c.fillText(Math.round(p * 100) + '%', x + rw, L.railY - rh * 3.4);
    c.restore();

    if (detail) {
      c.save();
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = font(Math.max(8, Math.min(L.w * 0.0098, 12)), 600);
      c.globalAlpha = 0.5;
      c.fillStyle = '#7f9dc4';
      c.fillText(spaced(detail), L.cx, L.detailY);
      c.restore();
    }
  }

  /** Letter-spacing, which a 2D context does not have on every engine yet. */
  function spaced(s) {
    s = String(s);
    let out = '';
    for (let i = 0; i < s.length; i++) out += (i ? ' ' : '') + s.charAt(i);
    return out;
  }

  /* The stamp on the end: the one line that says the wait is over. It lands in
     the outro, over the dial, and the flash takes it. It arrives wide and
     closes up, which reads as something landing rather than appearing. */
  function stampOut(c, L, k) {
    if (k <= 0) return;
    const e = ease(k);
    const size = Math.max(14, Math.min(L.w * 0.026, L.r * 0.22));
    const text = 'SYSTEMS NOMINAL';
    const gap = (1 - e) * size * 0.55;
    c.save();
    c.globalAlpha = Math.min(1, e * 1.4);
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.font = font(size, 900);
    c.translate(L.cx, L.cy + L.r * 1.60);
    let total = 0;
    for (let i = 0; i < text.length; i++) total += c.measureText(text.charAt(i)).width + gap;
    total -= gap;
    let x = -total / 2;
    c.shadowColor = CYAN;
    c.shadowBlur = 24;
    c.fillStyle = '#d9fbff';
    for (let i = 0; i < text.length; i++) {
      c.fillText(text.charAt(i), x, 0);
      x += c.measureText(text.charAt(i)).width + gap;
    }
    c.restore();
  }

  /** Scanlines, a vignette and the cut. */
  function grade(c, L, level) {
    const w = L.w, h = L.h;
    c.save();
    c.globalAlpha = 0.15;
    c.fillStyle = '#000';
    for (let y = 0; y < h; y += 3) c.fillRect(0, y, w, 1);
    c.restore();

    const v = c.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.26,
      w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.82)');
    c.fillStyle = v;
    c.fillRect(0, 0, w, h);

    if (level > 0.002) {
      c.save();
      c.globalAlpha = Math.min(1, level);
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, w, h);
      c.restore();
    }
  }

  /* ----------------------------------------------------------- the loop -- */

  function frame() {
    if (finished) return;
    raf = global.requestAnimationFrame(frame);
    const now = global.performance ? global.performance.now() : Date.now();
    const t = (now - t0) / 1000;
    const vw = parseFloat(cv.style.width), vh = parseFloat(cv.style.height);
    const L = layout(vw, vh);
    if (!dialFace || dialR !== L.r) buildDial(L);

    /* THE SCRIPT, OR THE OUTRO IF THE WAIT IS OVER.
       Once the game is ready the performance stops being a loop on a limiter
       and becomes an ending: the throttle is released, the revs fall away, the
       stamp lands and the flash takes the screen. A cut straight off the
       limiter is the one thing a sequence with this much build-up must not
       have, because it reads as the screen having been interrupted. */
    let s;
    if (outroAt) {
      const k = Math.min(1, (now - outroAt) / OUTRO_MS);
      const fall = ease(Math.min(1, k / 0.62));
      s = { rpm: LIMITER - (LIMITER - 820) * fall, load: 0, crank: 0, live: true, holding: false };
      stamp = Math.min(1, k / 0.30);
      /* The cut, late. The flash decays about a twentieth per frame and the
         veil behind it takes half a second to fade, so firing it early means
         handing over to a frame that is mostly grey - and grey is what a fade
         looks like, which is the thing this exists instead of. */
      if (k >= 0.86 && flash < 0.2) flash = 1;
      if (k >= 1) { close(); return; }
    } else {
      s = script(t);
    }
    rpm = s.rpm;
    /* The needle has mass. Not much - a tachometer needle is deliberately
       light - but enough that it overshoots a step and settles, which is the
       difference between a gauge and a graph. Driven towards the script rather
       than set to it, and the strength is high enough that a frame the loader
       stole does not leave the needle behind. */
    const lag = 1 - Math.exp(-18 * Math.min(0.05, 1 / 60));
    shownRpm += (rpm - shownRpm) * lag;

    // the whole screen shakes with the engine, and hard at the limiter
    const heat = Math.max(0, (shownRpm - 2000) / (RPM_MAX - 2000));
    shake = heat * heat * 7;
    const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;

    const B = NR.Boot;
    const p = B ? B.progress : (loaded ? 1 : 0);

    cx.save();
    cx.clearRect(0, 0, vw, vh);
    cx.translate(sx, sy);
    /* THE ORDER IS THE DEPTH. The ground, then the floor running away from
       it, then the instrument standing on both, then everything the
       instrument is saying, then the name under it and the frame around the
       lot. */
    ground(cx, L);
    floorLines(cx, L, t);
    if (dialFace) {
      const side = dialSide(L);
      cx.drawImage(dialFace, L.cx - side / 2, L.cy - side / 2, side, side);
    }
    dial(cx, L, shownRpm, s.live, t);
    progress(cx, L, p, B ? B.label : 'LOADING', B ? B.detail : '');
    wordmark(cx, L);
    edging(cx, L);
    stampOut(cx, L, stamp);
    cx.restore();

    /* The cut. A frame of white over everything, which is the oldest trick
       there is for hiding a transition and still the best one. */
    if (flash > 0) flash = Math.max(0, flash - 0.055);
    grade(cx, L, flash);

    /* THE WINDOW MAY OPEN NOW.
       There is a finished frame on the canvas, which is the only thing the
       host was ever waiting for. This call used to be at the END of the load,
       so on a direct launch the player got several seconds of no window and
       then a game - and every frame of this screen was drawn where nobody
       could see it. See the note at the top of this file. */
    if (!shown) {
      shown = true;
      try { if (NR.Host && NR.Host.ready) NR.Host.ready(); } catch (e) { /* a browser */ }
    }

    if (audio) {
      /* THE REVS THEMSELVES, not a frequency derived from them. The engine
         keeps its own crank angle on the audio thread and works out where
         its eight cylinders are from it - see js/engine-worklet.js - so what
         crosses the boundary is the same number the needle is showing. */
      const live = s.live ? 1 : (s.crank ? 0.35 : 0);
      /* ...and the limiter, which is a FUEL CUT rather than a ceiling on the
         revs. The script already bounces the needle off it; this is what
         makes that audible, by throwing away three firings in five while it
         is happening. It is the sound of a car being held against its stop
         and it is the loudest thing on this screen. */
      const cut = (s.live && !outroAt && shownRpm >= REDLINE + 700) ? 0.6 : 0;
      audio.set(shownRpm, s.load, live, cut);
      audio.starter(!!s.crank, s.crank || 0);
    }

    /* WHEN IT IS ALLOWED TO END. Three conditions, and all of them have to be
       true: the script has reached its hold, the floor has passed, and the
       game has actually loaded. The ceiling overrides the last of those,
       because a screen that waits forever is a hang however good it looks.

       And what they start is the OUTRO, not the close. */
    const old = now - began;
    if (!outroAt && ((s.holding && loaded && old > MIN_MS) || old > MAX_MS)) outroAt = now;
  }

  /* --------------------------------------------------------- the outside */

  function close() {
    if (finished) return;
    finished = true;
    running = false;
    global.cancelAnimationFrame(raf);
    global.removeEventListener('resize', resize);
    for (const type of EVENTS) doc.removeEventListener(type, swallow, true);
    if (audio) { audio.stop(); audio = null; }
    dialFace = null;
    if (veil) {
      veil.classList.add('ign-out');
      const el = veil;
      global.setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 620);
      veil = null;
    }
    doc.body.classList.remove('ign-on');
    /* Nothing behind this may act on a key that was being held while it was
       up. The advisory's CONTINUE is one frame away and it is a real focused
       button, so without this the release lands on it and the safety notice
       is gone before it has been read. See NR.Gate. */
    if (NR.Gate) NR.Gate.lock(320);
    const fn = onDone;
    onDone = null;
    if (fn) fn();
  }

  /* NOTHING BEHIND THIS SCREEN MAY SEE AN EVENT - AND NOTHING ENDS IT.
   *
   * It is modal, it is the loading screen, and it is the title sequence, and
   * the advisory behind it is already on the page with a focused button on it.
   * An unconsumed ENTER presses CONTINUE through a screen the player cannot
   * see past, which is how a key held down at launch used to walk straight
   * through a safety notice.
   *
   * TAB is the one exception, because focus still has to be able to move for
   * anything assistive that is reading the document. */
  const EVENTS = ['keydown', 'keyup', 'pointerdown', 'pointerup'];

  function swallow(e) {
    if (!e) return;
    if (e.type === 'keydown' && e.key === 'Tab') return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /**
   * Put the cold open up, and call `done` when it comes down.
   *
   * It always calls back, on every path: no canvas, reduced motion, an
   * exception inside the first frame, a machine that never finishes loading.
   * The screen after this one is a safety notice and it is not allowed to
   * depend on any of that going right.
   */
  function begin(done) {
    onDone = done || null;
    if (running || finished) { close(); return; }
    /* Somebody who has asked for reduced motion has asked not to be shown a
       shaking screen with a needle on it. They get the advisory immediately,
       and the loading carries on behind it the way it always has - and the
       window has to be shown here, because the frame that would otherwise
       have done it is never drawn. */
    if (!doc || !doc.body || (NR.UI && NR.UI.reduced && NR.UI.reduced())) {
      finished = true;
      try { if (NR.Host && NR.Host.ready) NR.Host.ready(); } catch (e) { /* a browser */ }
      const fn = onDone; onDone = null;
      if (fn) fn();
      return;
    }
    try {
      veil = doc.createElement('div');
      veil.className = 'ign-veil';
      veil.setAttribute('aria-hidden', 'true');
      cv = doc.createElement('canvas');
      veil.appendChild(cv);
      /* THE HEARTBEAT, and it is the one thing on this screen that is not
         drawn by script.

         Everything else here is a canvas driven by requestAnimationFrame, and
         requestAnimationFrame runs on exactly the thread the load is blocking
         - so through a long synchronous pass the needle is frozen. The yields
         in js/scene.js are most of the answer; this is the backstop for
         whatever is left, because a CSS animation on `transform` is advanced
         by the COMPOSITOR and keeps moving at sixty while script is not
         running at all. Same reasoning as js/staging.js. */
      const beat = doc.createElement('i');
      beat.className = 'ign-beat';
      veil.appendChild(beat);
      doc.body.appendChild(veil);
      doc.body.classList.add('ign-on');
      cx = cv.getContext('2d');
      if (!cx) throw new Error('no 2d context');
      resize();
      global.addEventListener('resize', resize);
      for (const type of EVENTS) doc.addEventListener(type, swallow, true);
      audio = makeAudio();
      /* A context created before any gesture may be born suspended - the
         desktop host passes --autoplay-policy=no-user-gesture-required so it
         is not, but a browser will - so it is resumed on the first thing that
         happens, and the screen is silent until then rather than broken. */
      if (audio && audio.ctx.state === 'suspended') {
        const wake = () => {
          if (audio) audio.ctx.resume().catch(() => {});
          doc.removeEventListener('pointerdown', wake, true);
          doc.removeEventListener('keydown', wake, true);
        };
        doc.addEventListener('pointerdown', wake, true);
        doc.addEventListener('keydown', wake, true);
      }
      running = true;
      began = t0 = global.performance ? global.performance.now() : Date.now();
      raf = global.requestAnimationFrame(frame);
    } catch (e) {
      /* Anything at all wrong here and the notice goes up instead. This is
         decoration in front of a safety warning; it does not get to break it. */
      close();
    }
  }

  /** The game is up. Lets the hold end - it does not end it immediately. */
  function ready() {
    loaded = true;
    if (NR.Boot) NR.Boot.finish();
    if (!running && !finished) close();
  }

  NR.Ignition = {
    begin,
    ready,
    /* THE ONLY WAY PAST IT, AND IT IS NOT A PLAYER'S.
       tools/smoke.js drives the game with no input layer at all and has to be
       able to reach the thing it is testing; NR.dismissAdvisory in js/main.js
       is what calls this. Nothing a player can press reaches it. */
    skip: () => { skipped = true; flash = 1; close(); },
    get running() { return running; },
    get skipped() { return skipped; },
  };
})(window);
