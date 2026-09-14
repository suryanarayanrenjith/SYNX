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
 * SKIPPABLE FROM THE FIRST FRAME, like everything else in this game's opening:
 * anything at all takes it down. The load is not skipped by that, obviously -
 * the advisory then covers the rest of it, exactly as it used to.
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
  /* How far the load has got, and whether it has finished. The needle is not
     driven by these - a gauge that tracks a progress bar is a progress bar with
     a needle on it - but the SEQUENCE is: the hold does not end until `loaded`. */
  let loaded = false, began = 0;
  /* A floor and a ceiling on the whole thing. The floor is so a machine that
     loads instantly still gets the cold open rather than a flash; the ceiling
     is so a machine that never finishes still gets a game. */
  const MIN_MS = 5200, MAX_MS = 26000;

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
    const BLIP = [
      { at: 2.55, up: 0.30, down: 0.46, peak: 4300 },
      { at: 3.45, up: 0.26, down: 0.50, peak: 6400 },
      { at: 4.35, up: 0.30, down: 0.62, peak: LIMITER },
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
    const k = Math.min(1, (t - 5.30) / 0.55);
    const held = 2200 + (LIMITER - 2200) * ease(Math.max(0, k));
    const bounce = k >= 1 ? Math.abs(Math.sin(t * 78)) * 380 : 0;
    return { rpm: held - bounce, load: 1, crank: 0, live: true, holding: k >= 1 };
  }

  function ease(k) {
    k = Math.max(0, Math.min(1, k));
    return k * k * (3 - 2 * k);
  }

  /* --------------------------------------------------------- the drawing */

  function resize() {
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    const w = doc.documentElement.clientWidth, h = doc.documentElement.clientHeight;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** A stroked path drawn three times, wide and faint to thin and bright.
      Canvas has no bloom; three passes and a shadow is what it has instead,
      and it is the difference between a neon line and a coloured one. */
  function glow(colour, width, alpha, path) {
    const passes = [[width * 3.4, alpha * 0.12], [width * 1.9, alpha * 0.22], [width, alpha]];
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    for (const [w, a] of passes) {
      cx.save();
      cx.globalAlpha = a;
      cx.strokeStyle = colour;
      cx.lineWidth = w;
      cx.shadowColor = colour;
      cx.shadowBlur = w * 2.2;
      path();
      cx.stroke();
      cx.restore();
    }
  }

  function arc(r, from, to) {
    return () => { cx.beginPath(); cx.arc(0, 0, r, from, to); };
  }

  function background(w, h, t) {
    const g = cx.createRadialGradient(w * 0.5, h * 0.48, 0, w * 0.5, h * 0.48, Math.max(w, h) * 0.7);
    g.addColorStop(0, '#150d2e');
    g.addColorStop(0.55, '#0a0620');
    g.addColorStop(1, '#03010a');
    cx.fillStyle = g;
    cx.fillRect(0, 0, w, h);

    /* A horizon and a grid running away from it. No logo, nothing named -
       this screen is deliberately anonymous - but a flat black rectangle is
       not a place, and the grid is the cheapest possible way to make it one. */
    const hz = h * 0.72;
    cx.save();
    cx.globalAlpha = 0.30;
    cx.strokeStyle = '#6a2bff';
    cx.lineWidth = 1;
    cx.beginPath();
    for (let i = -14; i <= 14; i++) {
      cx.moveTo(w * 0.5 + i * w * 0.055, hz);
      cx.lineTo(w * 0.5 + i * w * 0.42, h + 2);
    }
    /* The transverse lines scroll towards the viewer, and the spacing is
       exponential so they crowd at the horizon the way perspective does. */
    const scroll = (t * 0.45) % 1;
    for (let i = 0; i < 16; i++) {
      const k = (i + scroll) / 16;
      const y = hz + (h - hz) * (k * k * k);
      cx.moveTo(0, y);
      cx.lineTo(w, y);
    }
    cx.stroke();
    cx.restore();
  }

  function dial(w, h, value, live, t) {
    const r = Math.min(w, h) * 0.34;
    cx.save();
    cx.translate(w * 0.5, h * 0.46);

    // the face, and the ring that holds it
    cx.save();
    const face = cx.createRadialGradient(0, -r * 0.3, r * 0.1, 0, 0, r * 1.15);
    face.addColorStop(0, 'rgba(26,16,54,0.92)');
    face.addColorStop(1, 'rgba(6,3,18,0.96)');
    cx.fillStyle = face;
    cx.beginPath();
    cx.arc(0, 0, r * 1.16, 0, Math.PI * 2);
    cx.fill();
    cx.restore();

    glow('#2a1b52', 10, 0.9, arc(r * 1.16, 0, Math.PI * 2));
    glow(CYAN, 2, 0.55, arc(r * 1.04, A0, A1));

    // the redline, which is a band on the scale rather than a number on it
    const aOf = (v) => A0 + (A1 - A0) * Math.max(0, Math.min(1, v / RPM_MAX));
    glow(RED, 7, 0.75, arc(r * 1.00, aOf(REDLINE), aOf(RPM_MAX)));

    /* THE SWEPT ARC. Everything the needle has already passed is lit, so the
       dial reads at a glance even at the speed the needle moves here - and it
       turns from cyan through amber to red as the engine runs out of room. */
    const lit = value >= REDLINE ? RED : (value >= REDLINE * 0.72 ? AMBER : CYAN);
    if (value > 40) glow(lit, 9, 0.85, arc(r * 0.80, A0, aOf(value)));

    // ticks: one per thousand, four minors between, numerals on the majors
    cx.save();
    for (let i = 0; i <= RPM_MAX; i += 250) {
      const major = i % 1000 === 0;
      const a = aOf(i);
      const inner = major ? r * 0.86 : r * 0.91;
      const col = i >= REDLINE ? RED : '#cfe6ff';
      cx.save();
      cx.globalAlpha = major ? 0.95 : 0.42;
      cx.strokeStyle = col;
      cx.lineWidth = major ? 3 : 1.4;
      cx.shadowColor = col;
      cx.shadowBlur = major ? 10 : 0;
      cx.beginPath();
      cx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      cx.lineTo(Math.cos(a) * r * 0.99, Math.sin(a) * r * 0.99);
      cx.stroke();
      cx.restore();
      if (major) {
        const a2 = aOf(i), rr = r * 0.72;
        cx.save();
        cx.globalAlpha = 0.92;
        cx.fillStyle = i >= REDLINE ? RED : '#eaf6ff';
        cx.font = '600 ' + Math.round(r * 0.15) + 'px Orbitron, "Segoe UI", sans-serif';
        cx.textAlign = 'center';
        cx.textBaseline = 'middle';
        cx.shadowColor = i >= REDLINE ? RED : CYAN;
        cx.shadowBlur = 12;
        cx.fillText(String(i / 1000), Math.cos(a2) * rr, Math.sin(a2) * rr);
        cx.restore();
      }
    }
    cx.restore();

    // the unit, which is the only word on this screen
    cx.save();
    cx.globalAlpha = 0.55;
    cx.fillStyle = '#9fb6d8';
    cx.font = '600 ' + Math.round(r * 0.10) + 'px Orbitron, "Segoe UI", sans-serif';
    cx.textAlign = 'center';
    /* Under the readout, not above the hub: the needle sweeps the whole dial
       and the one place it can never reach is the gap at the bottom, which is
       where the scale starts and ends. Anything written anywhere else gets a
       needle through it twice a second. */
    cx.fillText('x1000 r/min', 0, r * 0.60);
    cx.restore();

    /* THE READOUT. Four digits under the hub, in the same seven-segment idiom
       the car's own instruments use, with the actual number - a dial with a
       fake number under it is a dial nobody believes. */
    cx.save();
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.font = '700 ' + Math.round(r * 0.19) + 'px Orbitron, "Segoe UI", monospace';
    const txt = String(Math.max(0, Math.round(value))).padStart(4, '0');
    cx.globalAlpha = 0.16;
    cx.fillStyle = '#20304a';
    cx.fillText('8888', 0, r * 0.40);
    cx.globalAlpha = 1;
    cx.fillStyle = value >= REDLINE ? RED : AMBER;
    cx.shadowColor = value >= REDLINE ? RED : AMBER;
    cx.shadowBlur = 16;
    cx.fillText(txt, 0, r * 0.40);
    cx.restore();

    /* THE NEEDLE. Tapered, counterweighted, and with its own light: the
       glowing tip is what the eye actually tracks at these speeds, and a
       needle drawn as a plain line reads as a clock hand. */
    const a = aOf(value);
    cx.save();
    cx.rotate(a);
    cx.shadowColor = value >= REDLINE ? RED : MAG;
    cx.shadowBlur = 26;
    cx.fillStyle = value >= REDLINE ? RED : MAG;
    cx.beginPath();
    cx.moveTo(-r * 0.20, -r * 0.028);
    cx.lineTo(r * 0.985, -r * 0.009);
    cx.lineTo(r * 0.985, r * 0.009);
    cx.lineTo(-r * 0.20, r * 0.028);
    cx.closePath();
    cx.fill();
    cx.globalAlpha = 0.9;
    cx.fillStyle = '#ffffff';
    cx.beginPath();
    cx.moveTo(r * 0.80, -r * 0.010);
    cx.lineTo(r * 0.985, -r * 0.006);
    cx.lineTo(r * 0.985, r * 0.006);
    cx.lineTo(r * 0.80, r * 0.010);
    cx.closePath();
    cx.fill();
    cx.restore();

    // the hub, over the tail of the needle
    cx.save();
    const hub = cx.createRadialGradient(0, -r * 0.03, 0, 0, 0, r * 0.13);
    hub.addColorStop(0, '#4a3a78');
    hub.addColorStop(1, '#120a24');
    cx.fillStyle = hub;
    cx.beginPath();
    cx.arc(0, 0, r * 0.125, 0, Math.PI * 2);
    cx.fill();
    cx.strokeStyle = live ? MAG : '#2a1b52';
    cx.lineWidth = 2;
    cx.shadowColor = MAG;
    cx.shadowBlur = live ? 14 : 0;
    cx.stroke();
    cx.restore();

    /* A pair of warning lamps either side of the hub, because a rev counter
       on its own is an instrument and a rev counter with lamps is a CAR. They
       are real: one is on while the starter is turning and goes out when the
       engine catches, the other comes on at the limiter. */
    const lamp = (x, on, colour) => {
      cx.save();
      cx.globalAlpha = on ? 1 : 0.18;
      cx.fillStyle = on ? colour : '#26304a';
      cx.shadowColor = colour;
      cx.shadowBlur = on ? 18 : 0;
      cx.beginPath();
      cx.arc(x, -r * 0.42, r * 0.035, 0, Math.PI * 2);
      cx.fill();
      cx.restore();
    };
    lamp(-r * 0.30, !live && t > 0.95, AMBER);
    lamp(r * 0.30, value >= REDLINE, RED);

    cx.restore();
  }

  /** Scanlines, a vignette and a little chromatic smear over the lot. */
  function grade(w, h, level) {
    cx.save();
    cx.globalAlpha = 0.16;
    cx.fillStyle = '#000';
    for (let y = 0; y < h; y += 3) cx.fillRect(0, y, w, 1);
    cx.restore();

    const v = cx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.25,
      w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.82)');
    cx.fillStyle = v;
    cx.fillRect(0, 0, w, h);

    if (level > 0.002) {
      cx.save();
      cx.globalAlpha = Math.min(1, level);
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, w, h);
      cx.restore();
    }
  }

  /* ----------------------------------------------------------- the loop -- */

  function frame() {
    if (finished) return;
    raf = global.requestAnimationFrame(frame);
    const now = global.performance ? global.performance.now() : Date.now();
    const t = (now - t0) / 1000;
    const vw = parseFloat(cv.style.width), vh = parseFloat(cv.style.height);

    const s = script(t);
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

    cx.save();
    cx.clearRect(0, 0, vw, vh);
    cx.translate(sx, sy);
    background(vw, vh, t);
    dial(vw, vh, shownRpm, s.live, t);
    cx.restore();

    /* The cut. A frame of white over everything, which is the oldest trick
       there is for hiding a transition and still the best one. */
    if (flash > 0) flash = Math.max(0, flash - 0.055);
    grade(vw, vh, flash);

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
      const cut = (s.live && shownRpm >= REDLINE + 700) ? 0.6 : 0;
      audio.set(shownRpm, s.load, live, cut);
      audio.starter(!!s.crank, s.crank || 0);
    }

    /* WHEN IT IS ALLOWED TO END. Three conditions, and all of them have to be
       true: the script has reached its hold, the floor has passed, and the
       game has actually loaded. The ceiling overrides the last of those,
       because a screen that waits forever is a hang however good it looks. */
    const old = now - began;
    if ((s.holding && loaded && old > MIN_MS) || old > MAX_MS) close();
  }

  /* --------------------------------------------------------- the outside */

  function close() {
    if (finished) return;
    finished = true;
    running = false;
    global.cancelAnimationFrame(raf);
    global.removeEventListener('resize', resize);
    doc.removeEventListener('keydown', onAny, true);
    doc.removeEventListener('pointerdown', onAny, true);
    if (audio) { audio.stop(); audio = null; }
    if (veil) {
      veil.classList.add('ign-out');
      const el = veil;
      global.setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 620);
      veil = null;
    }
    doc.body.classList.remove('ign-on');
    const fn = onDone;
    onDone = null;
    if (fn) fn();
  }

  function onAny(e) {
    if (e && e.type === 'keydown' && e.key === 'Tab') return;
    if (e) { e.preventDefault(); e.stopImmediatePropagation(); }
    skipped = true;
    flash = 1;
    /* Skipping does not skip the LOAD - nothing can - so the advisory takes
       over covering it, exactly as it did before this screen existed. */
    close();
  }

  /**
   * Put the cold open up, and call `done` when it comes down.
   *
   * It always calls back, on every path: no canvas, reduced motion, an
   * exception inside the first frame, a player who skips it, a machine that
   * never finishes loading. The screen after this one is a safety notice and
   * it is not allowed to depend on any of that going right.
   */
  function begin(done) {
    onDone = done || null;
    if (running || finished) { close(); return; }
    /* Somebody who has asked for reduced motion has asked not to be shown a
       shaking screen with a needle on it. They get the advisory immediately,
       and the loading carries on behind it the way it always has. */
    if (!doc || !doc.body || (NR.UI && NR.UI.reduced && NR.UI.reduced())) {
      finished = true;
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
      doc.body.appendChild(veil);
      doc.body.classList.add('ign-on');
      cx = cv.getContext('2d');
      if (!cx) throw new Error('no 2d context');
      resize();
      global.addEventListener('resize', resize);
      doc.addEventListener('keydown', onAny, true);
      doc.addEventListener('pointerdown', onAny, true);
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
    if (!running && !finished) close();
  }

  NR.Ignition = {
    begin,
    ready,
    skip: () => { if (running) onAny(null); else close(); },
    get running() { return running; },
    get skipped() { return skipped; },
  };
})(window);
