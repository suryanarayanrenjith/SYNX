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
 * It ends when its own script ends, which is about six seconds.
 *
 * ===================== IT IS NOT THE LOADING SCREEN ANY MORE =============
 *
 * It was, and that was the problem.
 *
 * Everything above is drawn with canvas 2D from requestAnimationFrame - a
 * ground gradient, a floor, an instrument, a ring, a wordmark, a vignette,
 * and a dozen shadow-blurred passes among them - on the one thread that
 * spends the opening seconds of every launch inflating a forty-two megabyte
 * archive, compiling a WebAssembly core, linking nineteen shader programs and
 * building a hundred and seventy-five kilometres of course. So the needle
 * stuck. Not now and then: at the start, every launch, because that is where
 * the heaviest passes are. The one screen whose job was to prove the machine
 * had not died was the screen that looked like it had.
 *
 * Nothing that could be done to this file would have fixed it. The canvas was
 * never what was slow.
 *
 * So the wait is covered by #preload instead - markup, styled inline, moving
 * only on `transform` and `opacity`, which the compositor advances off the
 * main thread and which therefore cannot stutter however busy that thread is.
 * See js/preload.js.
 *
 * WHICH LEAVES THIS FREE TO BE WHAT IT WAS FOR. It is started only once the
 * load has finished AND the frame times have proved steady, so it plays on an
 * idle machine at full rate. Its length is its own: the script runs, the last
 * pull is held for a beat, the outro lands the stamp and it is gone. Nothing
 * about it waits for anything any more.
 *
 * THE RING ARMS WITH THE ENGINE. It used to be the boot's progress; there is
 * no boot left to report by the time this is on screen, so it fills across
 * the crank and the catch and is full as the first blip fires - systems
 * coming up behind the needle.
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
  /* When the script first reached its hold. The outro starts HOLD_BEAT after
     that, which is the only clock this screen runs on now. */
  let holdAt = 0, began = 0;
  /* HOW LONG THE LAST NOTE IS HELD, and the ceiling on the whole thing.
   *
   * These were a floor and a ceiling on a WAIT: the screen could not end
   * before 4.7 seconds and could not go past 26, because it was the loading
   * screen and it had to cover a load of unknown length. It is not the
   * loading screen any more - js/preload.js is, and the game has finished
   * loading before a single frame of this is drawn - so what is left is a
   * performance with a known length.
   *
   * HOLD_BEAT is the pause on the limiter at the top of the last pull: long
   * enough to read as a car being held against its stop, short enough that
   * nobody is waiting for it. MAX_MS is now only a dead man's switch - if
   * anything in the script ever failed to reach its hold, the screen still
   * ends. */
  const HOLD_BEAT = 620, MAX_MS = 12000;

  let rpm = 0, shownRpm = 0, shake = 0, flash = 0;
  let audio = null;

  /* ------------------------------------------------------------- audio --
   *
   * A SIXTIES CROSS-PLANE V8, and it is not made of oscillators.
   *
   * The first version of this was: two detuned sawtooths at the firing
   * frequency, a square an octave down, a lowpass that opened with the revs.
   * It was reported as sounding like a motorcycle, and it was one - a smooth
   * even harmonic series rising in pitch is a small single with an open pipe.
   * The second modelled the engine properly and then drove its output stage
   * forty-five decibels too hot, which turned the whole thing into a clipped
   * square wave: the CRACKLE in the report. See js/engine-worklet.js for both
   * stories and for what the engine now is.
   *
   * EVERYTHING IS ON THE AUDIO THREAD NOW - the starter, the induction, the
   * exhaust, the limiter - so the graph on this side is the worklet and one
   * gain. It used to carry a looped two-second noise buffer (whose seam was a
   * click every two seconds), a free-running blower sine, a starter triangle
   * and a DynamicsCompressor that added ten decibels of make-up gain to a
   * signal that was already clipped. None of them is needed and every one of
   * them was something else that could go wrong on a machine that was
   * struggling.
   *
   * AND A FALLBACK. AudioWorklet has been in every shipping browser for
   * years, but a context can still refuse to load a module - a file: origin,
   * a policy, an old embedded webview - and a cold open with no sound is a
   * worse failure than a cold open with an approximate one. The fallback is
   * an oscillator stack: not right, but recognisably a car, and nobody should
   * ever hear it.
   */

  /* THE VOICE: what the audio thread is told, as one function of the moment
     in the script and of where the needle is. One function so that the page
     and the offline render in the test harness cannot disagree about what the
     engine was asked to do. The object is reused; it is read at once.

     THE NEEDLE READS A RACING TACH AND THE NOTE IS A MUSCLE CAR'S. The dial
     runs to ten thousand with the limiter at 9,200 - it is an instrument in a
     racing game - but a big-block V8 at nine thousand is a scream, not a
     roar. So the revs the ENGINE is given ease away from the needle's above
     fifteen hundred and arrive at four fifths of it at the stop: 9,200 on the
     dial is about 7,400 in the pipes, which is where a hot sixties V8 lives.
     Idle, the catch and the lope are untouched. */
  const VOICE_MASTER = 0.9;
  const VOICE_TAU = { rpm: 0.02, load: 0.03, gain: 0.03, cut: 0, fire: 0, crank: 0.05 };
  const VOICE = { rpm: 0, load: 0, gain: 0, fire: 0, crank: 0, cut: 0 };
  function voice(s, needle, outro) {
    const k = Math.max(0, Math.min(1, (needle - 1500) / 7500));
    const running = !!s.live;
    VOICE.rpm = needle * (1 - 0.2 * k * k * (3 - 2 * k));
    VOICE.load = s.load || 0;
    // silent through the dial's self-test; on from the moment the key turns
    VOICE.gain = (running || s.crank) ? 1 : 0;
    VOICE.fire = running ? 1 : 0;
    VOICE.crank = running ? 0 : Math.min(1, s.crank || 0);
    /* ...and the limiter, which is a FUEL CUT rather than a ceiling on the
       revs. The script bounces the needle off it; this makes that audible
       by throwing away three firings in five while it is happening. */
    VOICE.cut = (running && !outro && needle >= REDLINE + 700) ? 0.6 : 0;
    return VOICE;
  }

  function makeAudio() {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    let ctx;
    /* 'interactive' is the default everywhere; asking for it out loud stops
       an embedded engine picking a power-saving buffer that underruns while
       the page is still busy settling after the load. */
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) {
      try { ctx = new AC(); } catch (e2) { return null; }
    }

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

    const rig = {
      ctx, master, level,
      node: null,          // the worklet, once it has loaded
      fallback: null,      // ...or the oscillator stack, if it never does
      set(v) {
        const now = ctx.currentTime;
        if (this.node) {
          const p = this.node.parameters;
          for (const key in VOICE_TAU) {
            const prm = p.get(key);
            if (!prm) continue;
            const tau = VOICE_TAU[key];
            if (tau > 0) prm.setTargetAtTime(v[key], now, tau);
            else prm.value = v[key];
          }
        } else if (this.fallback) {
          this.fallback(v);
        }
        master.gain.setTargetAtTime(level * VOICE_MASTER, now, 0.04);
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
       self-test, before there is an engine to hear.

       The query string is the module's version. A webview caches worklet
       modules as hard as it caches anything, and a new engine behind an old
       URL is the old engine. */
    rig.fallback = makeFallback(ctx, master);
    global.__ignRig = 0;
    if (ctx.audioWorklet && ctx.audioWorklet.addModule) {
      ctx.audioWorklet.addModule('js/engine-worklet.js?v=v8-2').then(() => {
        if (!rig.ctx || rig.ctx.state === 'closed') return;
        const node = new global.AudioWorkletNode(ctx, 'synx-engine', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
          parameterData: { fire: 0, crank: 0, gain: 0 },
        });
        node.connect(master);
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

     Deliberately modest. The first oscillator engine's two faults were a
     filter that opened to nine kilohertz - which is what made it scream - and
     a perfectly even pulse rate, which is what made it a single. Here the
     filter tops out at eighteen hundred, the shaper is driven gently, and a
     tremolo at half the firing rate stands in for the uneven banks. Not
     right. Recognisably a car. */
  function makeFallback(ctx, out) {
    const shaper = ctx.createWaveShaper();
    {
      const n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
      }
      shaper.curve = curve;
      shaper.oversample = '4x';
    }
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 300;
    tone.Q.value = 0.9;
    const lump = ctx.createGain();          // the tremolo the banks would give
    lump.gain.value = 1;
    const bark = ctx.createBiquadFilter();
    bark.type = 'peaking';
    bark.frequency.value = 110;
    bark.Q.value = 1.0;
    bark.gain.value = 6;
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
    const a = mk('sawtooth', 0, 0.26);
    const b = mk('sawtooth', 11, 0.20);
    const c = mk('triangle', -5, 0.30);
    // the rumble, such as it is: a half-order wobble under the whole thing
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.3;
    lfo.connect(lfoGain); lfoGain.connect(lump.gain); lfo.start();

    const fn = (v) => {
      const now = ctx.currentTime, k = 0.02;
      const hz = Math.max(12, (v.rpm / 60) * 4);
      a.frequency.setTargetAtTime(hz, now, k);
      b.frequency.setTargetAtTime(hz, now, k);
      c.frequency.setTargetAtTime(hz * 0.5, now, k);
      lfo.frequency.setTargetAtTime(hz * 0.5, now, k);
      tone.frequency.setTargetAtTime(Math.min(1800, 180 + hz * 1.1 + v.load * 520), now, 0.03);
      const open = v.gain * (v.fire ? 1 : 0.3);
      level.gain.setTargetAtTime(open * 0.45, now, 0.04);
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
      /* ...and the first few firings are the loudest thing the engine does
         until the limiter: a cold V8 catches on a rich charge and barks. */
      const bark = Math.max(0, 1 - k * 1.15);
      return { rpm: 900 + flare * (1 - k * 0.55), load: 0.95 * Math.pow(bark, 1.4), crank: 0, live: true };
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

    /* THE PULL. The last movement, and it is on a clock now.
     *
     * It used to be the one part of this that was NOT: the engine went to the
     * limiter and stayed there, bouncing, until the game said it had finished
     * loading. That was the right shape for a loading screen and it is the
     * wrong shape for a cold open - a machine that had already loaded sat on
     * the limiter anyway waiting for a floor to pass, and a slow one sat on it
     * for twenty seconds, which is not a performance, it is a wait with a
     * noise over it.
     *
     * The load is finished before this screen is ever shown now (see
     * js/preload.js), so the last movement can do what it was always trying
     * to: one hard pull to the stop, a beat of it bouncing off the cut, and
     * then the outro takes it. `holding` is what tells the frame loop the
     * script has arrived; HOLD_BEAT is how long it is allowed to sit there. */
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
  /* ONE COORDINATE SYSTEM, AND EVERYTHING HUNG OFF THE DIAL.
   *
   * This screen was laid out twice. The dial, its ring and the outro stamp
   * were positioned off the INSTRUMENT - `cy + r * 1.60` and the like - while
   * the wordmark, the caption, the rail and the count were positioned off the
   * FRAME, as fractions of its height. Those two agree at exactly one aspect
   * ratio and drift apart everywhere else.
   *
   * On a 2:1 window they collided outright: `r` is clamped by height, so the
   * stamp landed at y = 564 and the rail sat at y = 565, and the last thing
   * the player saw before the game opened was SYSTEMS NOMINAL printed straight
   * through the progress bar with the caption of the same name a row above it.
   *
   * So the block under the instrument is now stacked from the bottom of the
   * BEZEL downward, in units of the dial's own radius. The gaps are fixed
   * proportions of the thing they sit under, which is what keeps them apart at
   * any shape of window - and `stampY` is in the table with the rest of them
   * rather than being computed at the point of use.
   */
  function layout(w, h) {
    /* Height-limited at 0.265 rather than 0.30. The progress RING reaches
       1.34 radii, so at 0.30 the instrument owned down to 82% of a 2:1 window
       and the four lines under it had a tenth of the screen to share - which
       is how they ended up on top of each other. */
    const r = Math.min(w * 0.30, h * 0.265);
    const cy = h * 0.42;
    const ring = r * 1.34;
    /* The first line clears the progress ring, not just the bezel - the ring
       is the outermost thing the instrument draws and the wordmark used to be
       laid over the bottom of it. */
    const top = cy + ring + Math.max(14, r * 0.10);
    const step = Math.max(13, r * 0.115);
    /* THE STACK IS MEASURED OFF THE NAME, not off a step the name ignores.
       The wordmark is sized by the frame and every line under it was placed in
       steps of the dial, so at 1920x1080 the caption's line ran two pixels
       inside the bottom of the letters: SYSTEMS NOMINAL printed on the SYNX
       it is supposed to sit under. Each line now starts where the thing above
       it ENDS.
       ...and in the preloader's order, which this screen dissolves out of:
       the name, the rail, and under the rail one row with what is happening
       on the left and how far along on the right. The two screens used to
       set the same four things in two different arrangements. */
    const size = markSize(w, r);
    const markY = top + size * 0.5;
    const railY = markY + size * 0.5 + step * 1.05;
    const capY = railY + Math.max(12, step * 0.58);
    const detailY = capY + Math.max(12, step * 0.58);
    /* ...and if the window is short enough that the stack would run off the
       bottom, the whole block slides up rather than falling off the screen. */
    const lastY = detailY + step * 0.4;
    const lift = Math.max(0, lastY - h * 0.965);
    return {
      w, h, r,
      cx: w * 0.5,
      cy,
      ring,                    // the progress arc, outside the bezel
      markSize: size,
      markY: markY - lift,     // the wordmark
      railY: railY - lift,     // the bar
      railW: Math.min(w * 0.74, 560),
      capY: capY - lift,       // what is being worked on, and how far along
      detailY: detailY - lift, // the count, when a phase has one
      /* The outro stamp REPLACES the rail and the row under it - by the time
         it lands the bar is at a hundred per cent and has nothing left to say
         - so it sits across the two rather than looking for a line of its own.
         See the fade in `progress`. */
      stampY: (railY + capY) * 0.5 - lift,
    };
  }

  /** How big the name is under the dial: a tenth-ish of the frame, and never
      bigger than the dial can carry. One function, because the layout has to
      know it to stack the lines under it. */
  function markSize(w, r) { return Math.max(16, Math.min(w * 0.042, r * 0.30)); }

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
    /* THE PRELOADER'S ROOM, because this screen is what the preloader
       dissolves INTO: the same base, the same violet wash high in the middle
       and the same magenta coming up off the horizon (see #preload::before in
       index.html, which is where these numbers come from). It used to have a
       palette of its own - a lighter centre and a magenta and a cyan pooled
       in the two top corners - so the dissolve crossed from one room into a
       different one, and the opening read as two programs in a row. */
    c.fillStyle = '#04010c';
    c.fillRect(0, 0, w, h);
    const ellipse = (x, y, rx, ry, stops) => {
      c.save();
      c.translate(x, y);
      c.scale(rx, ry);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (const [k, col] of stops) g.addColorStop(k, col);
      c.fillStyle = g;
      c.fillRect(-x / rx, -y / ry, w / rx, h / ry);
      c.restore();
    };
    /* magenta up off the horizon, then violet high in the middle - the CSS's
       `ellipse 120% 70% at 50% 108%` and `ellipse 90% 60% at 50% 34%`, whose
       sizes are the two RADII as fractions of the frame */
    ellipse(w * 0.5, h * 1.08, w * 1.2, h * 0.7,
      [[0, 'rgba(255,46,136,0.30)'], [0.6, 'rgba(255,46,136,0)'], [1, 'rgba(255,46,136,0)']]);
    ellipse(w * 0.5, h * 0.34, w * 0.9, h * 0.6,
      [[0, 'rgba(90,40,190,0.28)'], [0.7, 'rgba(90,40,190,0)'], [1, 'rgba(90,40,190,0)']]);

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

    /* The unit, under the readout, and it is the READOUT's unit.
       It said "x1000 r/min" directly beneath a four-digit number showing the
       actual crank speed, so the face read 8974 x1000 r/min - nine million
       revs a minute. The x1000 belongs to the NUMERALS on the scale, which
       run 0 to 10; the readout is already in r/min and needs no multiplier.
       The scale carries its own legend now, next to the numbers it applies to.

       Under the readout because the needle sweeps the whole dial and the one
       place it can never reach is the gap at the bottom, which is where the
       scale starts and ends - anything written anywhere else on the face gets
       a needle through it twice a second. */
    c.save();
    c.globalAlpha = 0.5;
    c.fillStyle = '#9fb6d8';
    c.font = font(r * 0.095, 600);
    c.textAlign = 'center';
    c.fillText('r/min', 0, r * 0.60);
    /* ...and the scale's multiplier, UP ON THE SCALE, where a tachometer
       prints it: over the hub, under the 5. It was moved to "level with the 0
       and the 10" and landed directly under r/min instead, so the face still
       read 5980 / r/min / x1000 - the same nine million revs a minute, one line
       lower. The needle crosses it on every sweep, which is exactly what it
       does on a real one. Short, because the two warning lamps stand either
       side of it at a third of a radius out. */
    c.globalAlpha = 0.38;
    c.font = font(r * 0.074, 600);
    c.fillText('×1000', 0, -r * 0.30);
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
  /* THE HOUSE CHROME, the same seven stops as hud.chrome() and .synx-chrome:
     white into lavender down to a hard horizon at the middle, then gold off
     the break into magenta. This screen had a five-stop cousin of it with no
     break and no cut lines, and set the name as 'S Y N X' in spaces - a third
     treatment of the one word, between the loader's and the title's. */
  const CHROME = [
    [0.00, '#ffffff'], [0.30, '#c8b8ff'], [0.47, '#5b3fb8'],
    [0.50, '#2a1650'], [0.53, '#ffd977'], [0.72, '#ff5fb0'], [1.00, '#7a1f6b'],
  ];
  let markCv = null, markKey = '', markW = 0, markH = 0;

  /* Built once per size into a canvas of its own, because the airbrush's cut
     lines are cut OUT of the glyphs - and on this screen, unlike the HUD's
     overlay, there is a picture under the name that a cut on the live canvas
     would punch straight through. */
  function buildMark(size) {
    const d = dpr();
    const key = size.toFixed(2) + '|' + d;
    if (markCv && markKey === key) return markCv;
    if (!markCv) markCv = doc.createElement('canvas');
    const probe = markCv.getContext('2d');
    if (!probe) return null;
    probe.font = font(size, 900);
    track(probe, size * 0.06);
    const tw = probe.measureText(tracked(probe, 'SYNX')).width;
    markW = tw + size * 0.8;
    markH = size * 1.6;
    markCv.width = Math.max(1, Math.ceil(markW * d));
    markCv.height = Math.max(1, Math.ceil(markH * d));
    const m = markCv.getContext('2d');
    m.setTransform(d, 0, 0, d, 0, 0);
    m.clearRect(0, 0, markW, markH);
    m.font = font(size, 900);
    track(m, size * 0.06);
    m.textAlign = 'center';
    m.textBaseline = 'middle';
    const X = markW / 2, Y = markH / 2, t = tracked(m, 'SYNX');
    const g = m.createLinearGradient(0, Y - size * 0.62, 0, Y + size * 0.62);
    for (const [k, col] of CHROME) g.addColorStop(k, col);
    m.fillStyle = g;
    m.fillText(t, X, Y);
    m.lineWidth = Math.max(1, size * 0.028);
    m.strokeStyle = 'rgba(255,255,255,0.65)';
    m.strokeText(t, X, Y);
    // the cut lines, the way the era's airbrushed logos were done
    m.globalCompositeOperation = 'destination-out';
    m.fillStyle = 'rgba(0,0,0,0.5)';
    const step = Math.max(2, size * 0.11);
    for (let ly = Y - size * 0.55; ly < Y + size * 0.55; ly += step) {
      m.fillRect(0, ly, markW, Math.max(1, size * 0.022));
    }
    m.globalCompositeOperation = 'source-over';
    markKey = key;
    return markCv;
  }

  function wordmark(c, L, k) {
    const rise = k === undefined ? 1 : k;
    if (rise <= 0.002) return;
    const size = L.markSize;
    const im = buildMark(size);
    c.save();
    /* THE HALO, AND ONLY THE HALO. The shadow of a copy drawn off the edge of
       the canvas lands under the chrome with no solid glyphs of its own, so
       the airbrush cuts show the dark room through them - as they do on every
       other chrome headline - rather than a second, pink copy of the name. */
    c.font = font(size, 900);
    track(c, size * 0.06);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const OFF = 10000;
    /* A shadow's offset is in DEVICE pixels - the transform does not apply
       to it - while the text is placed through the pixel-ratio scale, so the
       offset has to be scaled by the same amount or on a HiDPI screen the
       halo lands off the canvas with its text. */
    const T = c.getTransform ? c.getTransform() : null;
    c.shadowOffsetX = OFF * (T ? Math.hypot(T.a, T.b) : dpr());
    c.shadowColor = 'rgba(255,46,136,0.55)';
    c.shadowBlur = size * 0.7;
    c.fillStyle = '#000';
    c.globalAlpha = rise;
    c.fillText(tracked(c, 'SYNX'), L.cx - OFF, L.markY);
    c.shadowOffsetX = 0;
    c.shadowBlur = 0;
    if (im) c.drawImage(im, L.cx - markW / 2, L.markY - markH / 2, markW, markH);
    c.restore();
  }

  /* Corner ticks around the whole frame. The same language the rest of the
     interface is built out of, so the first screen belongs to the game. */
  function edging(c, L, k) {
    const rise = k === undefined ? 1 : k;
    if (rise <= 0.002) return;
    const m = Math.max(18, Math.min(L.w, L.h) * 0.045);
    const len = Math.max(24, Math.min(L.w, L.h) * 0.065);
    const x0 = m, y0 = m, x1 = L.w - m, y1 = L.h - m;
    c.save();
    c.globalAlpha = 0.42 * rise;
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
   * The ring, the caption, the rail and the count. All four used to read
   * NR.Boot; all four are the script's own clock now, because the load is
   * over before this screen exists. See the note at the top of the file.
   */
  function progress(c, L, p, label, detail, stamp, k) {
    const r = L.ring;
    /* The caption, the rail and the count all belong to WAITING. Once the
       outro stamp is landing there is nothing left to wait for, so they go -
       which is also what stops the stamp being printed through them. */
    const waitK = (1 - Math.min(1, Math.max(0, (stamp || 0) * 1.6)))
      * (k === undefined ? 1 : k);
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
      /* The head of it, so the eye can find where it has got to - while it
         is still GOING somewhere. A full ring has no head: left on at a
         hundred per cent it was one bright dot on one end of a symmetrical
         gauge, which read as a fault in the ring rather than as its end. */
      const head = Math.max(0, Math.min(1, (1 - p) * 10));
      if (head > 0.01) {
        c.save();
        c.globalAlpha = head;
        c.fillStyle = '#eaffff';
        c.shadowColor = CYAN;
        c.shadowBlur = 20;
        c.beginPath();
        c.arc(Math.cos(end) * r, Math.sin(end) * r, Math.max(2.4, L.r * 0.020), 0, Math.PI * 2);
        c.fill();
        c.restore();
      }
      c.restore();
    }

    /* THE RAIL AND THE ROW UNDER IT, set exactly as the preloader sets them -
       the same measure, a two-pixel bar, and one row beneath it with the
       phase on the left and the count on the right - because this screen
       takes over from that one mid-dissolve and the eye should not see the
       furniture rearrange itself. */
    const rw = L.railW, rh = 2;
    const x = L.cx - rw / 2, y = L.railY - rh / 2;
    c.save();
    c.globalAlpha = waitK;
    c.fillStyle = 'rgba(122,158,210,0.16)';
    c.fillRect(x, y, rw, rh);
    if (p > 0.001) {
      const g = c.createLinearGradient(x, 0, x + rw, 0);
      g.addColorStop(0, CYAN);
      g.addColorStop(0.58, '#b46cff');
      g.addColorStop(1, MAG);
      c.fillStyle = g;
      c.shadowColor = 'rgba(57,230,255,0.7)';
      c.shadowBlur = 16;
      c.fillRect(x, y, rw * p, rh);
    }
    c.restore();

    // what is being worked on right now, from the rail's left end
    c.save();
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.font = font(10, 600);
    track(c, 10 * 0.24);
    c.globalAlpha = 0.66 * waitK;
    c.fillStyle = 'rgb(150,184,220)';
    c.fillText(tracked(c, label || ''), x, L.capY);
    c.restore();

    // ...and how far along, on the same row, to the rail's right end
    c.save();
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    c.font = font(13, 900);
    track(c, 13 * 0.12);
    c.fillStyle = CYAN;
    c.shadowColor = 'rgba(57,230,255,0.6)';
    c.shadowBlur = 14;
    c.globalAlpha = waitK;
    c.fillText(tracked(c, Math.round(p * 100) + '%'), x + rw, L.capY);
    c.restore();

    if (detail) {
      c.save();
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.font = font(9, 600);
      track(c, 9 * 0.24);
      c.globalAlpha = 0.46 * waitK;
      c.fillStyle = 'rgb(130,160,196)';
      c.fillText(tracked(c, detail), x, L.detailY);
      c.restore();
    }
  }

  /* LETTER-SPACING. The context has it natively now (`letterSpacing`), and
     where it does not the old spaced-out string stands in. `tracked` returns
     the string to draw for whichever of the two is in force, so a caller
     never has to know. */
  function track(c, px) {
    if ('letterSpacing' in c) { c.letterSpacing = px.toFixed(2) + 'px'; c.__tracked = true; }
    else c.__tracked = false;
  }
  function tracked(c, s) { return c.__tracked ? String(s) : spaced(s); }

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
    c.translate(L.cx, L.stampY);
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

    /* THE RING IS PART OF THE PERFORMANCE NOW, not a progress bar.
     *
     * It used to draw NR.Boot.progress, because this screen was the loading
     * screen. It is not: the load has finished before a frame of this is
     * drawn (see js/preload.js), so Boot.progress is 1 on the first frame and
     * a ring that is already full says nothing at all.
     *
     * So it arms with the engine. Nothing while the dial is sweeping itself,
     * then it fills across the crank and the catch, and it is full at the
     * moment the first blip fires - which reads as systems coming up behind
     * the needle rather than as a bar that was finished before you looked.
     * It is a function of the script's own clock and of nothing else. */
    const p = Math.max(0, Math.min(1, (t - 0.95) / 1.45));
    const capLine = t < 0.95 ? 'DIAL SELF TEST'
      : t < 1.78 ? 'CRANKING'
      : t < 2.40 ? 'IGNITION'
      : t < 4.30 ? 'THROTTLE RESPONSE'
      : 'SYSTEMS NOMINAL';

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
    /* ================= THE HANDOVER OFF THE PRELOADER ==================
     *
     * This screen and the preloader say the SAME FOUR THINGS - a SYNX
     * wordmark, a caption, a percentage and a rail under them - and for the
     * half second they overlap, both were saying them at once, in two places,
     * with two different answers: the loader reading SYSTEMS NOMINAL at 100%
     * while the dial underneath it read DIAL SELF TEST at 0%.
     *
     * That is the worst half second in the game to look unconsidered, and it
     * is the first one the player sees.
     *
     * So the instrument arrives on its own. The ground, the floor and the
     * dial are up from the first frame - they are what the loader dissolves
     * to REVEAL - and everything that repeats the loader's furniture rises
     * over the same 520 ms the loader spends leaving (see Preload.finish).
     * At no instant are there two wordmarks, two rails or two percentages on
     * the screen, and the read is one continuous movement rather than a cut
     * between two screens that happen to be about the same thing.
     *
     * STAGGERED, NOT CROSS-FADED. Rising over the same 520 ms the loader
     * spends leaving puts both sets at half strength in the middle of it,
     * which is two ghosts rather than two captions - better, and still not
     * one screen. So the rise WAITS until the loader is all but gone and then
     * takes its own half second. The instrument holds the frame ALONE in
     * between, and that beat is what makes this read as a dial coming up
     * rather than as a slide changing. */
    const riseT = Math.max(0, Math.min(1, (t - 0.42) / 0.55));
    const rise = riseT * riseT * (3 - 2 * riseT);
    progress(cx, L, p, capLine, '', stamp, rise);
    wordmark(cx, L, rise);
    edging(cx, L, rise);
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
         crosses the boundary is what the needle is showing, voiced: see
         voice() for the one liberty it takes. */
      audio.set(voice(s, shownRpm, !!outroAt));
    }

    /* WHEN IT IS ALLOWED TO END, which is now a property of the performance
       and not of the machine. The script reaches the top of its last pull,
       it is held there for a beat, and then the outro takes it. The ceiling
       is a dead man's switch and nothing legitimate reaches it.

       And what this starts is the OUTRO, not the close. */
    if (s.holding && !holdAt) holdAt = now;
    if (!outroAt && ((holdAt && now - holdAt >= HOLD_BEAT) || now - began > MAX_MS)) {
      outroAt = now;
    }
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

  /* THE GAME IS UP - which by the time this screen exists it always is.
   *
   * Kept because js/bench.js and the capture harness both call it, and
   * because the reduced-motion path reaches `begin` and returns without ever
   * starting a frame loop. It is a no-op on the ordinary path. */
  function ready() {
    if (NR.Boot) NR.Boot.finish();
    if (!running && !finished) close();
  }

  NR.Ignition = {
    begin,
    ready,
    /* THE ONLY WAY PAST IT, AND IT IS NOT A PLAYER'S.
       tools/smoke.py drives the game with no input layer at all and has to be
       able to reach the thing it is testing; NR.dismissAdvisory in js/main.js
       is what calls this. Nothing a player can press reaches it. */
    skip: () => { skipped = true; flash = 1; close(); },
    get running() { return running; },
    get skipped() { return skipped; },
  };
})(window);
