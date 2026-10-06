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
  /* The selector's box: where it is drawn (a float, sliding between slots),
     the gear it last settled on, when that changed, and the last frame's
     clock so the slide is the same speed at any frame rate. */
  let gearPos = null, gearWas = -1, shiftAt = 0, lastFrame = 0;
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
    if ((global.NR || {}).DEV !== false) global.__ignRig = 0;
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
        if ((global.NR || {}).DEV !== false) global.__ignRig = 1;
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
  /* THE SELECTOR AND THE NEEDLE ARE ONE PERFORMANCE.
   *
   * The script used to return the revs alone, and the frame loop picked the
   * gear off a clock of its own: Park, then Neutral from the catch, then
   * first a beat into the outro. So the needle climbed and fell three times
   * and then pinned the limiter while the selector sat in N, and the box went
   * into gear as the revs were FALLING - the instrument saying one thing and
   * the gearbox beside it another, which is exactly what was reported.
   *
   * Now every moment of the script names its gear, so the two cannot drift.
   * Park for the self-test and the starter, Neutral when it catches, Drive as
   * the box takes up the load (the revs dip as it does), and then the needle
   * only ever climbs IN a gear and only ever drops BECAUSE of one: first,
   * second, third, each pull a little longer as a taller ratio would be, each
   * drop the step an upshift really is - down to where the next ratio picks
   * the engine up, not back to idle. The third pull ends on the limiter, and
   * the outro is one more upshift (see frame). Indices into GEARS. */
  const G_P = 0, G_N = 2, G_D = 3, G_1 = 4, G_2 = 5, G_3 = 6, G_4 = 7;
  /* Each pull: the gear it is in, when it starts, the revs it starts from and
     reaches, and how long it takes. A shift is SHIFT_S long and happens at the
     end of every pull but the last; the next pull starts where it lands. */
  const PULLS = [
    { gear: G_1, at: 2.80, from: 820, peak: 5900, up: 0.44 },
    { gear: G_2, at: 3.36, from: 3700, peak: 6900, up: 0.52 },
    { gear: G_3, at: 4.00, from: 4700, peak: LIMITER, up: 0.80 },
  ];
  const SHIFT_S = 0.12;
  /* An engine pulling in gear: quick off the bottom of a ratio, slowing as it
     nears the top of it - not the symmetric ease of a free-revving blip. */
  function pull(k) {
    k = Math.max(0, Math.min(1, k));
    return 1 - Math.pow(1 - k, 1.55);
  }

  function script(t) {
    // [0.00 .. 0.90]  the sweep: needle to the stop and back, dial self-test
    if (t < 0.45) return { rpm: RPM_MAX * ease(t / 0.45), load: 0, crank: 0, live: false, gear: G_P };
    if (t < 0.95) return { rpm: RPM_MAX * (1 - ease((t - 0.45) / 0.5)), load: 0, crank: 0, live: false, gear: G_P };
    // [0.95 .. 1.75]  the starter turning it over
    if (t < 1.75) {
      const k = (t - 0.95) / 0.8;
      const chug = Math.sin(t * 44) * 0.5 + 0.5;
      return { rpm: 180 + chug * 190 * k, load: 0, crank: 0.3 + k * 0.7, live: false, gear: G_P };
    }
    // [1.75 .. 2.35]  it catches, overshoots, and settles - out of Park
    if (t < 2.35) {
      const k = (t - 1.75) / 0.6;
      const flare = Math.sin(Math.PI * Math.min(1, k * 1.4)) * 1750;
      /* ...and the first few firings are the loudest thing the engine does
         until the limiter: a cold V8 catches on a rich charge and barks. */
      const bark = Math.max(0, 1 - k * 1.15);
      return { rpm: 900 + flare * (1 - k * 0.55), load: 0.95 * Math.pow(bark, 1.4), crank: 0, live: true, gear: G_N };
    }
    const idle = 900 + Math.sin(t * 9.3) * 32 + Math.sin(t * 23.7) * 14;
    // [2.35 .. 2.55]  idling in neutral
    if (t < 2.55) return { rpm: idle, load: 0, crank: 0, live: true, gear: G_N };
    /* [2.55 .. 2.80]  into Drive. The box takes up the load and the idle dips
       under it - the clunk every automatic makes - before the first pull. */
    if (t < PULLS[0].at) {
      const k = Math.min(1, (t - 2.55) / 0.08);
      return { rpm: idle - 90 * k, load: 0.18, crank: 0, live: true, gear: G_D };
    }

    for (let i = 0; i < PULLS.length; i++) {
      const p = PULLS[i];
      const last = i === PULLS.length - 1;
      const top = p.at + p.up;
      if (t < top || last) {
        const k = (t - p.at) / p.up;
        const rpm = p.from + (p.peak - p.from) * pull(k);
        if (!last) return { rpm, load: 1, crank: 0, live: true, gear: p.gear };
        /* THE LAST PULL ends on the limiter, and a limiter does not hold a
           needle still: it cuts the ignition and lets it fall a few hundred
           revs and catches it again, twelve or fifteen times a second.
           `holding` tells the frame loop the script has arrived; HOLD_BEAT is
           how long it may sit there before the outro takes it. */
        const on = k >= 1;
        const bounce = on ? Math.abs(Math.sin(t * 78)) * 380 : 0;
        return { rpm: rpm - bounce, load: 1, crank: 0, live: true, gear: p.gear, holding: on };
      }
      // the upshift: off the top of this ratio, down to where the next one lands
      if (t < top + SHIFT_S) {
        const k = (t - top) / SHIFT_S;
        const next = PULLS[i + 1];
        return {
          rpm: p.peak + (next.from - p.peak) * ease(k),
          load: 0.25, crank: 0, live: true, gear: next.gear,
        };
      }
    }
    return { rpm: idle, load: 0, crank: 0, live: true, gear: G_N };
  }

  function ease(k) {
    k = Math.max(0, Math.min(1, k));
    return k * k * (3 - 2 * k);
  }

  /* --------------------------------------------------------- the drawing --
   *
   * THE CLUSTER, AFTER THE REFERENCE.
   *
   * The art direction for this screen is an instrument cluster: a deep blue
   * glass dial in the middle with white figures and a red needle, a ring of
   * orange light round it that blooms where a low sun would catch it, and
   * cyan instrument arcs either side - a column of figures on the left, the
   * gear selector on the right. This used to be a single violet tachometer on
   * a dark floor, which said "a gauge"; the cluster says "a car, waking up".
   *
   * EVERY PART OF IT IS DOING SOMETHING, because a cold open that is only
   * decoration is a screen people wait through.
   *
   *   THE DIAL       the revs - the same script, the same needle with mass,
   *                  the same two warning lamps as before.
   *   THE RING       the engine. Cold and dim while the dial self-tests and
   *                  the starter turns, it LIGHTS on the frame the engine
   *                  catches and then breathes with the revs, white-hot at the
   *                  limiter. It is the brightest thing on the screen exactly
   *                  when the engine is the loudest.
   *   BOOST, LEFT    the reserve arming - it fills across the crank and the
   *                  catch the way the progress ring used to, and then rides
   *                  the throttle, so it reads as pressure building.
   *   GEAR, RIGHT    the selector: P through the self-test, N once the engine
   *                  is running, and it drops into first on the outro - the
   *                  last thing that happens before the cut is the car being
   *                  put in gear.
   *
   * WHAT IS CACHED AND WHAT IS NOT. Three layers are painted once per window
   * size - the ROOM (ground, glows, the floor's fixed rays), the CLUSTER (the
   * dial face, its ticks and figures, both side gauges and every line and
   * label on them) and the RING with all of its bloom - and each is one
   * drawImage a frame. What moves is drawn live and drawn cheaply: the needle
   * is a sprite rotated into place, the flares are sprites whose opacity
   * rides the revs, the boost column is sixteen short strokes and the gear is
   * one box. There is no shadow blur anywhere on the live path, which on the
   * integrated graphics this game is most often played on is the difference
   * between this screen running at the display's rate and not.
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
    // every cached layer is sized off the dial's radius, which just moved
    cache = null;
  }

  /* ------------------------------------------------------- the geometry --
   *
   * ONE COORDINATE SYSTEM, AND EVERYTHING HUNG OFF THE DIAL. Every part of
   * the cluster is placed in units of the dial's radius from its centre, and
   * the two lines under it - the name and what the machine is doing - are
   * stacked from the bottom of the ring downward, so nothing can collide with
   * anything at any shape of window. (It used to be laid out twice, once off
   * the instrument and once off the frame, and the two agreed at exactly one
   * aspect ratio.)
   */
  function layout(w, h) {
    /* The side gauges reach 1.70 radii either side and the ring's bloom 1.35
       above and below, so the dial is limited by both axes. */
    const R = Math.max(48, Math.min(w * 0.155, h * 0.235));
    const cy = h * 0.42;
    const size = markSize(w, R);
    const markY = cy + R * 1.52 + size * 0.5;
    const capY = markY + size * 0.5 + Math.max(16, R * 0.11);
    const lift = Math.max(0, capY + 14 - h * 0.965);
    return {
      w, h, R,
      r: R,                       // the old name, for anything that reads it
      cx: w * 0.5,
      cy: cy - lift * 0.5,
      markSize: size,
      markY: markY - lift,
      capY: capY - lift,
      stampY: capY - lift,
    };
  }

  /** How big the name is under the dial. */
  function markSize(w, R) { return Math.max(16, Math.min(w * 0.036, R * 0.26)); }

  /** Where a rev value sits on the scale, in radians. */
  function aOf(v) {
    return A0 + (A1 - A0) * Math.max(0, Math.min(1, v / RPM_MAX));
  }

  const font = (px, weight) =>
    (weight || 600) + ' ' + Math.round(px) + 'px Orbitron, "Segoe UI", sans-serif';
  /* The instrument face. The in-game cluster (js/hud.js, FACE) sets its
     figures in Orbitron's black and its legends in Orbitron's semibold,
     tracked - the site's display face at its two jobs - so the two
     instruments read as the same car. */
  const ORB = 'Orbitron, Rajdhani, "Segoe UI", sans-serif';
  const num = (px, w) => ((w || 800) >= 800 ? '900 ' : '600 ') + Math.round(px) + 'px ' + ORB;
  const lab = (px) => '600 ' + Math.round(px) + 'px ' + ORB;
  /* Orbitron's figures are proportional - a '1' is under half an '8' - so a
     readout that changes is set in cells as wide as the widest figure, each
     figure centred in its own: the tabular setting the face does not have. */
  function fillTabular(c, txt, cx, cy) {
    let cell = 0;
    for (let d = 0; d <= 9; d++) cell = Math.max(cell, c.measureText(String(d)).width);
    const align = c.textAlign;
    c.textAlign = 'center';
    const x0 = cx - (cell * txt.length) / 2 + cell / 2;
    for (let i = 0; i < txt.length; i++) c.fillText(txt.charAt(i), x0 + i * cell, cy);
    c.textAlign = align;
  }

  /* The side gauges, as angles in radians and radii in dial radii. Both run
     from their BOTTOM end to their TOP end. */
  const BOOST_A = [Math.PI * (139 / 180), Math.PI * (221 / 180)];
  const GEAR_A = [Math.PI * (41 / 180), Math.PI * (-41 / 180)];
  const GEARS = ['P', 'R', 'N', 'D', '1', '2', '3', '4', '5', '6'];
  const SIDE = { num: 1.40, arc: 1.52, dash: 1.585, outer: 1.68 };
  const RING_R = 1.18;
  /* Orange into red round the ring, hottest at the lower right where the
     flare sits - by angle, clockwise from the right. */
  const RING_RAMP = [
    [0 / 360, '#ff7a1c'], [40 / 360, '#ffd07a'], [95 / 360, '#ff4a1a'],
    [180 / 360, '#d4122e'], [230 / 360, '#a80c34'], [275 / 360, '#ff3a1e'],
    [320 / 360, '#ff6a1c'], [1, '#ff7a1c'],
  ];

  /* The layers, built on first use and thrown away on a resize. */
  let cache = null;

  function surface(wCss, hCss) {
    const d = dpr();
    const s = doc.createElement('canvas');
    s.width = Math.max(1, Math.ceil(wCss * d));
    s.height = Math.max(1, Math.ceil(hCss * d));
    const c = s.getContext('2d');
    if (!c) return null;
    c.setTransform(d, 0, 0, d, 0, 0);
    return { cv: s, c, w: wCss, h: hCss };
  }

  function ensureCache(L) {
    const key = L.w + 'x' + L.h + '@' + dpr();
    if (cache && cache.key === key) return cache;
    cache = { key };
    cache.room = buildRoom(L);
    cache.cluster = buildCluster(L);
    cache.ring = buildRing(L);
    cache.needle = buildNeedle(L);
    cache.flare = buildFlare(L, 'warm');
    cache.glint = buildFlare(L, 'cool');
    return cache;
  }

  /* THE ROOM - the preloader's, so the dissolve from it is one continuous
     picture: the same base, the same magenta coming up off the horizon, with
     a blue pool behind the dial (the dial's own light on the air) and the
     floor's rays, which never move. */
  function buildRoom(L) {
    const S = surface(L.w, L.h);
    if (!S) return null;
    const c = S.c, w = L.w, h = L.h;
    c.fillStyle = '#03010a';
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
    ellipse(w * 0.5, h * 1.08, w * 1.2, h * 0.7,
      [[0, 'rgba(255,46,136,0.24)'], [0.6, 'rgba(255,46,136,0)'], [1, 'rgba(255,46,136,0)']]);
    ellipse(L.cx, L.cy, L.R * 2.6, L.R * 2.0,
      [[0, 'rgba(40,70,235,0.30)'], [0.45, 'rgba(60,40,200,0.12)'], [1, 'rgba(60,40,200,0)']]);
    ellipse(L.cx + L.R * 1.1, L.cy + L.R * 0.9, L.R * 1.6, L.R * 1.1,
      [[0, 'rgba(255,90,30,0.10)'], [1, 'rgba(255,90,30,0)']]);
    const hz = h * 0.78;
    c.save();
    c.globalAlpha = 0.20;
    c.strokeStyle = '#6a2bff';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = -16; i <= 16; i++) {
      c.moveTo(w * 0.5 + i * w * 0.05, hz);
      c.lineTo(w * 0.5 + i * w * 0.40, h + 2);
    }
    c.stroke();
    // the horizon itself, one faint lit line
    const hl = c.createLinearGradient(0, 0, w, 0);
    hl.addColorStop(0, 'rgba(255,70,170,0)');
    hl.addColorStop(0.5, 'rgba(255,70,170,0.9)');
    hl.addColorStop(1, 'rgba(255,70,170,0)');
    c.globalAlpha = 0.5;
    c.fillStyle = hl;
    c.fillRect(0, hz - 0.5, w, 1);
    c.restore();
    return S;
  }

  /* THE CLUSTER: the dial's face and everything printed on it, and both
     side gauges with every line and figure that does not move. */
  function buildCluster(L) {
    const R = L.R;
    const side = R * 3.6;
    const S = surface(side, side);
    if (!S) return null;
    const c = S.c;
    c.translate(side / 2, side / 2);
    const TAU = Math.PI * 2;

    /* --- the glass ---------------------------------------------------- */
    const face = c.createRadialGradient(-R * 0.12, -R * 0.20, R * 0.05, 0, 0, R * 1.10);
    face.addColorStop(0, '#3f63ff');
    face.addColorStop(0.32, '#2c33d4');
    face.addColorStop(0.68, '#24147e');
    face.addColorStop(1, '#0a0526');
    c.save();
    c.shadowColor = 'rgba(30,60,255,0.55)';
    c.shadowBlur = R * 0.30;
    c.fillStyle = face;
    c.beginPath();
    c.arc(0, 0, R * 1.10, 0, TAU);
    c.fill();
    c.restore();
    // a darker band at the rim, so the figures stand on a ring of their own
    c.save();
    c.beginPath();
    c.arc(0, 0, R * 1.10, 0, TAU);
    c.arc(0, 0, R * 0.86, 0, TAU, true);
    c.fillStyle = 'rgba(6,4,30,0.42)';
    c.fill();
    c.restore();

    /* --- the scale ---------------------------------------------------- */
    for (let i = 0; i <= RPM_MAX; i += 250) {
      const major = i % 1000 === 0;
      const half = i % 500 === 0;
      const a = aOf(i);
      const red = i >= REDLINE;
      const r0 = major ? R * 0.885 : half ? R * 0.925 : R * 0.950;
      c.save();
      c.strokeStyle = red ? '#ff3a4e' : '#f2f4ff';
      c.globalAlpha = major ? 1 : half ? 0.75 : 0.45;
      c.lineWidth = major ? Math.max(2, R * 0.022) : Math.max(1, R * 0.010);
      c.shadowColor = red ? '#ff2a3c' : 'rgba(170,200,255,0.9)';
      c.shadowBlur = major ? R * 0.05 : 0;
      c.beginPath();
      c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      c.lineTo(Math.cos(a) * R * 1.035, Math.sin(a) * R * 1.035);
      c.stroke();
      c.restore();
      if (!major) continue;
      c.save();
      c.font = num(R * 0.155, 700);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = red ? '#ffb0bb' : '#ffffff';
      c.shadowColor = red ? 'rgba(255,40,60,0.9)' : 'rgba(120,170,255,0.95)';
      c.shadowBlur = R * 0.06;
      c.fillText(String(i / 1000), Math.cos(a) * R * 0.745, Math.sin(a) * R * 0.745);
      c.restore();
    }
    // the redline as a band outside the ticks
    c.save();
    c.strokeStyle = '#ff2a3c';
    c.lineWidth = Math.max(2, R * 0.030);
    c.shadowColor = '#ff2a3c';
    c.shadowBlur = R * 0.10;
    c.beginPath();
    c.arc(0, 0, R * 1.06, aOf(REDLINE), aOf(RPM_MAX));
    c.stroke();
    c.restore();

    /* The ring of light inside the figures - a dashed circle, white into
       blue, which is most of what makes the reference's dial read as lit
       glass rather than as a printed face. */
    c.save();
    c.strokeStyle = 'rgba(225,235,255,0.85)';
    c.lineWidth = Math.max(1.5, R * 0.016);
    c.shadowColor = 'rgba(140,190,255,1)';
    c.shadowBlur = R * 0.06;
    c.setLineDash([R * 0.040, R * 0.026]);
    c.beginPath();
    c.arc(0, 0, R * 0.585, A0, A1);
    c.stroke();
    c.setLineDash([]);
    c.strokeStyle = 'rgba(150,180,255,0.22)';
    c.lineWidth = Math.max(1, R * 0.008);
    c.shadowBlur = 0;
    c.beginPath();
    c.arc(0, 0, R * 0.36, 0, TAU);
    c.stroke();
    c.restore();

    // the scale's legend, up on the scale where a tachometer prints it
    c.save();
    c.font = lab(R * 0.068);
    if ('letterSpacing' in c) c.letterSpacing = (R * 0.068 * 0.2).toFixed(2) + 'px';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(200,215,255,0.55)';
    c.fillText('×1000 R/MIN', 0, -R * 0.24);
    c.restore();

    // the glass: a soft crescent of light across the upper left
    c.save();
    c.beginPath();
    c.arc(0, 0, R * 1.09, 0, TAU);
    c.clip();
    const sh = c.createLinearGradient(-R * 0.9, -R * 1.0, R * 0.3, R * 0.3);
    sh.addColorStop(0, 'rgba(255,255,255,0.16)');
    sh.addColorStop(0.5, 'rgba(255,255,255,0.03)');
    sh.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = sh;
    c.beginPath();
    c.ellipse(-R * 0.32, -R * 0.60, R * 1.05, R * 0.56, -0.45, 0, TAU);
    c.fill();
    c.restore();

    /* --- the side gauges ---------------------------------------------- */
    const CY = '#3fe6ff';
    const arc = (r, a0, a1, w, alpha, ccw) => {
      c.save();
      c.strokeStyle = CY;
      c.globalAlpha = alpha;
      c.lineWidth = w;
      c.shadowColor = CY;
      c.shadowBlur = R * 0.05;
      c.beginPath();
      c.arc(0, 0, r, a0, a1, !!ccw);
      c.stroke();
      c.restore();
    };
    const sideGauge = (A, labels, title, sub, mirror) => {
      const [a0, a1] = A;
      const ccw = a1 < a0;
      arc(R * SIDE.arc, a0, a1, Math.max(1.5, R * 0.014), 0.9, ccw);
      arc(R * SIDE.outer, a0 + (a1 - a0) * -0.10, a1 + (a1 - a0) * 0.10, Math.max(1, R * 0.007), 0.45, ccw);
      // the dashes' sockets
      for (let i = 0; i < 16; i++) {
        const a = a0 + (a1 - a0) * ((i + 0.5) / 16);
        c.save();
        c.strokeStyle = CY;
        c.globalAlpha = 0.16;
        c.lineWidth = Math.max(2, R * 0.022);
        c.beginPath();
        c.arc(0, 0, R * SIDE.dash, a - 0.012, a + 0.012);
        c.stroke();
        c.restore();
      }
      // ticks and figures
      const n = labels.length;
      for (let i = 0; i < n; i++) {
        const a = a0 + (a1 - a0) * (i / (n - 1));
        const hot = !mirror && i >= n - 2;
        c.save();
        c.strokeStyle = hot ? '#ff3a4e' : CY;
        c.lineWidth = Math.max(1.5, R * 0.014);
        c.shadowColor = hot ? '#ff2a3c' : CY;
        c.shadowBlur = R * 0.04;
        c.beginPath();
        c.moveTo(Math.cos(a) * R * (SIDE.arc - 0.06), Math.sin(a) * R * (SIDE.arc - 0.06));
        c.lineTo(Math.cos(a) * R * SIDE.arc, Math.sin(a) * R * SIDE.arc);
        c.stroke();
        c.restore();
        c.save();
        c.font = num(R * 0.120, 700);
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = hot ? '#ff9aa8' : 'rgba(235,245,255,0.62)';
        c.shadowColor = hot ? 'rgba(255,40,60,0.8)' : 'rgba(80,200,255,0.6)';
        c.shadowBlur = R * 0.04;
        c.fillText(labels[i], Math.cos(a) * R * SIDE.num, Math.sin(a) * R * SIDE.num);
        c.restore();
      }
      // the title, under the gauge's bottom end
      const ab = a0 + (a1 - a0) * -0.16;
      const tx = Math.cos(ab) * R * SIDE.arc, ty = Math.sin(ab) * R * SIDE.arc;
      c.save();
      c.font = lab(R * 0.072);
      if ('letterSpacing' in c) c.letterSpacing = (R * 0.072 * 0.22).toFixed(2) + 'px';
      c.textAlign = mirror ? 'right' : 'left';
      c.textBaseline = 'middle';
      c.fillStyle = 'rgba(120,230,255,0.85)';
      c.fillText(title, tx + (mirror ? R * 0.05 : -R * 0.05), ty + R * 0.05);
      c.fillStyle = 'rgba(160,190,230,0.45)';
      c.font = lab(R * 0.056);
      c.fillText(sub, tx + (mirror ? R * 0.05 : -R * 0.05), ty + R * 0.15);
      c.restore();
      // and three small points of light along the outer rail
      c.save();
      c.fillStyle = 'rgba(120,230,255,0.75)';
      for (const k of [0.2, 0.5, 0.8]) {
        const a = a0 + (a1 - a0) * k;
        c.beginPath();
        c.arc(Math.cos(a) * R * SIDE.outer, Math.sin(a) * R * SIDE.outer, R * 0.012, 0, TAU);
        c.fill();
      }
      c.restore();
    };
    sideGauge(BOOST_A, ['0', '1', '2', '3', '4', '5', '6', '7', '8'], 'BOOST', 'RESERVE ×12.5%', false);
    sideGauge(GEAR_A, GEARS, 'GEAR', 'SELECTOR', true);
    return S;
  }

  /* THE RING: an orange tube round the dial, its colour running round it
     and its bloom baked in. Drawn at an opacity that is the engine's. */
  function buildRing(L) {
    const R = L.R;
    const side = R * 3.2;
    const S = surface(side, side);
    if (!S) return null;
    const c = S.c;
    c.translate(side / 2, side / 2);
    let col;
    if (c.createConicGradient) {
      col = c.createConicGradient(0, 0, 0);
      for (const [k, v] of RING_RAMP) col.addColorStop(k, v);
    } else col = '#ff5a1a';
    const stroke = (w, alpha, blur) => {
      c.save();
      c.strokeStyle = col;
      c.globalAlpha = alpha;
      c.lineWidth = w;
      c.shadowColor = '#ff4a12';
      c.shadowBlur = blur;
      c.beginPath();
      c.arc(0, 0, R * RING_R, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    };
    stroke(R * 0.20, 0.16, R * 0.34);
    stroke(R * 0.085, 0.45, R * 0.18);
    stroke(R * 0.045, 1.0, R * 0.08);
    // the white-hot filament down its middle
    c.save();
    c.strokeStyle = '#fff1dc';
    c.globalAlpha = 0.55;
    c.lineWidth = Math.max(1, R * 0.012);
    c.beginPath();
    c.arc(0, 0, R * RING_R, 0, Math.PI * 2);
    c.stroke();
    c.restore();
    // and a second, thin red ring outside it
    c.save();
    c.strokeStyle = '#ff2a3c';
    c.globalAlpha = 0.40;
    c.lineWidth = Math.max(1, R * 0.008);
    c.shadowColor = '#ff2a3c';
    c.shadowBlur = R * 0.06;
    c.beginPath();
    c.arc(0, 0, R * 1.28, Math.PI * 0.62, Math.PI * 2.38);
    c.stroke();
    c.restore();
    return S;
  }

  /* The needle, along +x with its pivot `pivot` in from the left. */
  function buildNeedle(L) {
    const R = L.R;
    const len = R * 1.25, hgt = R * 0.32;
    const S = surface(len, hgt);
    if (!S) return null;
    const c = S.c;
    const pivot = R * 0.22;
    c.translate(pivot, hgt / 2);
    c.shadowColor = '#ff3a2a';
    c.shadowBlur = R * 0.10;
    const g = c.createLinearGradient(-R * 0.2, 0, R, 0);
    g.addColorStop(0, '#b0102a');
    g.addColorStop(0.5, '#ff2a3c');
    g.addColorStop(1, '#ff6a4a');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(-R * 0.18, -R * 0.030);
    c.lineTo(R * 1.00, -R * 0.008);
    c.lineTo(R * 1.00, R * 0.008);
    c.lineTo(-R * 0.18, R * 0.030);
    c.closePath();
    c.fill();
    c.shadowBlur = 0;
    c.fillStyle = '#fff3ee';
    c.beginPath();
    c.moveTo(R * 0.30, -R * 0.009);
    c.lineTo(R * 1.00, -R * 0.0045);
    c.lineTo(R * 1.00, R * 0.0045);
    c.lineTo(R * 0.30, R * 0.009);
    c.closePath();
    c.fill();
    S.pivot = pivot;
    return S;
  }

  /* A lens flare: a hot core, a coloured halo and a horizontal streak - the
     anamorphic signature the bloom in the game itself carries. */
  function buildFlare(L, kind) {
    const R = L.R;
    const sz = R * (kind === 'warm' ? 1.5 : 0.9);
    const S = surface(sz, sz);
    if (!S) return null;
    const c = S.c, m = sz / 2;
    const warm = kind === 'warm';
    const g = c.createRadialGradient(m, m, 0, m, m, m);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.06, warm ? 'rgba(255,236,200,0.95)' : 'rgba(220,250,255,0.95)');
    g.addColorStop(0.20, warm ? 'rgba(255,140,50,0.45)' : 'rgba(80,200,255,0.40)');
    g.addColorStop(0.55, warm ? 'rgba(255,60,20,0.10)' : 'rgba(60,120,255,0.08)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, sz, sz);
    const st = c.createLinearGradient(0, 0, sz, 0);
    st.addColorStop(0, 'rgba(255,255,255,0)');
    st.addColorStop(0.5, warm ? 'rgba(255,220,180,0.85)' : 'rgba(200,245,255,0.85)');
    st.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = st;
    c.fillRect(0, m - Math.max(1, R * 0.006), sz, Math.max(2, R * 0.012));
    c.globalAlpha = 0.5;
    c.fillRect(m - Math.max(1, R * 0.004), m - sz * 0.18, Math.max(2, R * 0.008), sz * 0.36);
    return S;
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
    const hz = L.h * 0.78;
    c.save();
    c.globalAlpha = 0.22;
    c.strokeStyle = '#7a3bff';
    c.lineWidth = 1;
    c.beginPath();
    /* Exponential spacing, so they crowd at the horizon the way perspective
       does, and they scroll towards the viewer. */
    const scroll = (t * 0.45) % 1;
    for (let i = 0; i < 14; i++) {
      const k = (i + scroll) / 14;
      const y = hz + (L.h - hz) * (k * k * k);
      c.moveTo(0, y);
      c.lineTo(L.w, y);
    }
    c.stroke();
    c.restore();
  }

  function blit(c, S, x, y, alpha) {
    if (!S) return;
    if (alpha !== undefined) {
      if (alpha <= 0.002) return;
      c.save();
      c.globalAlpha *= alpha;
      c.drawImage(S.cv, x - S.w / 2, y - S.h / 2, S.w, S.h);
      c.restore();
    } else {
      c.drawImage(S.cv, x - S.w / 2, y - S.h / 2, S.w, S.h);
    }
  }

  /**
   * Everything on the cluster that moves.
   *
   *   value   the needle's revs, already damped
   *   live    the engine is running
   *   ring    how lit the ring is, 0..1+ (see the frame loop)
   *   boost   how much of the boost column is lit, 0..1
   *   gear    index into GEARS
   *   intro   0..1, the side gauges drawing themselves on
   */
  function cluster(c, L, value, live, t, ring, boost, gear, intro, gearPos, kick) {
    const R = L.R;
    const K = ensureCache(L);
    const heat = Math.max(0, (value - 2000) / (RPM_MAX - 2000));

    // the ring, at the engine's own brightness, with a flicker at the cut
    blit(c, K.ring, L.cx, L.cy, Math.min(1.15, ring));

    /* The face and the side gauges. The gauges DRAW ON across the dial's
       self-test: a sweep from the bottom of each arc to the top, so the
       instruments come up with the needle rather than being there before
       it. A clip, not a redraw - it is the same cached layer. */
    if (K.cluster) {
      if (intro >= 0.999) {
        blit(c, K.cluster, L.cx, L.cy);
      } else {
        // the dial itself is up from the first frame...
        c.save();
        c.beginPath();
        c.arc(L.cx, L.cy, R * 1.25, 0, Math.PI * 2);
        c.clip();
        blit(c, K.cluster, L.cx, L.cy);
        c.restore();
        // ...and each side gauge sweeps on from its bottom end
        const sweep = (A) => {
          const [a0, a1] = A;
          const end = a0 + (a1 - a0) * Math.min(1, intro * 1.15);
          c.save();
          // the wedge swept so far - padded past both ends so the labels
          // under the arcs come with them...
          c.beginPath();
          c.moveTo(L.cx, L.cy);
          const pad = (a1 - a0) * 0.35;
          c.arc(L.cx, L.cy, R * 1.9, a0 - pad, end, a1 < a0);
          c.closePath();
          c.clip();
          // ...intersected with everything that is not the dial, which is
          // already drawn and must not be drawn twice
          c.beginPath();
          c.rect(0, 0, L.w, L.h);
          c.arc(L.cx, L.cy, R * 1.25, 0, Math.PI * 2);
          c.clip('evenodd');
          blit(c, K.cluster, L.cx, L.cy, Math.min(1, intro * 1.6));
          c.restore();
        };
        sweep(BOOST_A);
        sweep(GEAR_A);
      }
    }

    /* THE BOOST COLUMN: sixteen cells along the left arc, cyan into magenta,
       and the last two the warning colour. */
    {
      const [a0, a1] = BOOST_A;
      const lit = boost * 16;
      c.save();
      c.lineCap = 'butt';
      for (let i = 0; i < 16; i++) {
        const k = Math.max(0, Math.min(1, lit - i));
        if (k <= 0.001) continue;
        const a = a0 + (a1 - a0) * ((i + 0.5) / 16);
        const col = i >= 14 ? '#ff3a4e' : i >= 10 ? '#ff4fb8' : '#3fe6ff';
        c.globalAlpha = (0.35 + 0.65 * k) * Math.min(1, intro * 1.4);
        c.strokeStyle = col;
        c.lineWidth = Math.max(2, R * 0.030);
        c.beginPath();
        c.arc(L.cx, L.cy, R * SIDE.dash, a - 0.014, a + 0.014);
        c.stroke();
      }
      c.restore();
    }

    /* THE SELECTOR: the engaged gear boxed and lit, the rest printed dim on
       the cached layer underneath. */
    {
      const [a0, a1] = GEAR_A;
      /* Drawn where the lever IS on its way to the new slot, lit hard for the
         moment of the change and settling back - and its letter is always
         the gear it is going to, so it never shows a gear the box is not in. */
      const pos = gearPos === undefined || gearPos === null ? gear : gearPos;
      const kk = kick || 0;
      const a = a0 + (a1 - a0) * (pos / (GEARS.length - 1));
      const gx = L.cx + Math.cos(a) * R * SIDE.num, gy = L.cy + Math.sin(a) * R * SIDE.num;
      const bw = R * (0.19 + 0.03 * kk), bh = R * (0.15 + 0.02 * kk);
      c.save();
      c.globalAlpha *= Math.min(1, intro * 1.4);
      c.fillStyle = 'rgba(63,230,255,' + (0.22 + 0.38 * kk).toFixed(3) + ')';
      c.strokeStyle = kk > 0.02 ? '#e9fdff' : '#7ff4ff';
      c.lineWidth = Math.max(1.5, R * (0.010 + 0.006 * kk));
      c.beginPath();
      if (c.roundRect) c.roundRect(gx - bw / 2, gy - bh / 2, bw, bh, R * 0.03);
      else c.rect(gx - bw / 2, gy - bh / 2, bw, bh);
      c.fill();
      c.stroke();
      c.font = num(R * 0.125, 800);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#ffffff';
      c.fillText(GEARS[gear], gx, gy + R * 0.004);
      c.restore();
    }

    /* THE READOUT. Four digits under the hub, with the actual number - a dial
       with a fake number under it is a dial nobody believes. Cyan, in the
       instrument face, in the gap at the bottom where the needle never
       points. */
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = num(R * 0.22, 800);
    const txt = String(Math.max(0, Math.round(value))).padStart(4, '0');
    c.fillStyle = value >= REDLINE ? '#ff8a96' : '#86f6ff';
    fillTabular(c, txt, L.cx, L.cy + R * 0.40);
    c.font = lab(R * 0.060);
    if ('letterSpacing' in c) c.letterSpacing = (R * 0.06 * 0.24).toFixed(2) + 'px';
    c.fillStyle = 'rgba(180,215,255,0.60)';
    c.fillText('R/MIN', L.cx, L.cy + R * 0.585);
    c.restore();

    /* A pair of warning lamps either side of the legend, because a rev
       counter on its own is an instrument and a rev counter with lamps is a
       CAR. They are real: one is on while the starter is turning and goes
       out when the engine catches, the other comes on at the limiter. */
    const lamp = (x, on, colour) => {
      c.save();
      c.globalAlpha = on ? 1 : 0.22;
      c.fillStyle = on ? colour : '#2a3560';
      c.beginPath();
      c.arc(L.cx + x, L.cy - R * 0.40, R * 0.032, 0, Math.PI * 2);
      c.fill();
      if (on) {
        c.globalAlpha = 0.45;
        c.beginPath();
        c.arc(L.cx + x, L.cy - R * 0.40, R * 0.065, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    };
    lamp(-R * 0.30, !live && t > 0.95, AMBER);
    lamp(R * 0.30, value >= REDLINE, RED);

    // the needle, then the hub over its tail
    if (K.needle) {
      c.save();
      c.translate(L.cx, L.cy);
      c.rotate(aOf(value));
      c.drawImage(K.needle.cv, -K.needle.pivot, -K.needle.h / 2, K.needle.w, K.needle.h);
      c.restore();
    }
    c.save();
    const hub = c.createRadialGradient(L.cx, L.cy - R * 0.03, 0, L.cx, L.cy, R * 0.10);
    hub.addColorStop(0, '#4a5cff');
    hub.addColorStop(1, '#0b0828');
    c.fillStyle = hub;
    c.beginPath();
    c.arc(L.cx, L.cy, R * 0.085, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = live ? '#ff6a4a' : '#8fa2ff';
    c.lineWidth = Math.max(1.5, R * 0.018);
    c.stroke();
    c.restore();

    /* THE FLARES. A warm one on the ring at the lower right, which is the
       engine - it brightens with the revs and burns at the limiter - and a
       cool glint on the glass at the upper left, which is the lamp the
       instrument is lit by and does not care what the engine is doing. */
    c.save();
    c.globalCompositeOperation = 'lighter';
    const fa = Math.PI * (36 / 180);
    blit(c, K.flare, L.cx + Math.cos(fa) * R * RING_R, L.cy + Math.sin(fa) * R * RING_R,
      Math.min(1, ring) * (0.30 + 0.70 * heat));
    blit(c, K.glint, L.cx - R * 0.56, L.cy - R * 0.66, 0.40 + 0.10 * Math.sin(t * 2.3));
    c.restore();
  }

  /* WHAT THE MACHINE IS DOING, one line under the name - the phase of the
     script, in the face the in-game labels are set in. */
  function status(c, L, label, k) {
    if (k <= 0.002 || !label) return;
    c.save();
    c.globalAlpha = 0.78 * k;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = lab(Math.max(10, L.R * 0.058));
    track(c, Math.max(10, L.R * 0.058) * 0.42);
    c.fillStyle = 'rgb(150,200,240)';
    c.fillText(tracked(c, label), L.cx, L.capY);
    c.restore();
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
    /* In the instrument face, the size of the status line it replaces, and
       it arrives wide and closes up - a word landing rather than appearing.
       Its glow is two wide faint strokes, not a blur: this is the frame the
       cold open hands over on, and it must be the cheapest one it draws. */
    const size = Math.max(12, L.R * 0.085);
    const text = 'SYSTEMS NOMINAL';
    const gap = size * 0.42 + (1 - e) * size * 0.65;
    c.save();
    c.globalAlpha = Math.min(1, e * 1.4);
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.font = num(size, 800);
    c.lineJoin = 'round';
    c.translate(L.cx, L.stampY);
    let total = 0;
    for (let i = 0; i < text.length; i++) total += c.measureText(text.charAt(i)).width + gap;
    total -= gap;
    const draw = (stroke) => {
      let x = -total / 2;
      for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (stroke) c.strokeText(ch, x, 0); else c.fillText(ch, x, 0);
        x += c.measureText(ch).width + gap;
      }
    };
    const base = c.globalAlpha;
    c.strokeStyle = CYAN;
    c.globalAlpha = base * 0.14; c.lineWidth = size * 0.55; draw(true);
    c.globalAlpha = base * 0.30; c.lineWidth = size * 0.20; draw(true);
    c.globalAlpha = base;
    c.fillStyle = '#ecfdff';
    draw(false);
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

    /* THE SCRIPT, OR THE OUTRO IF THE WAIT IS OVER.
       Once the game is ready the performance stops being a loop on a limiter
       and becomes an ending: the throttle is released, the revs fall away, the
       stamp lands and the flash takes the screen. A cut straight off the
       limiter is the one thing a sequence with this much build-up must not
       have, because it reads as the screen having been interrupted. */
    let s;
    if (outroAt) {
      /* THE LAST SHIFT. Off the limiter the box goes up one more - the revs
         drop the step every shift before it dropped, into fourth - and the
         engine pulls again as the stamp lands and the flash takes the screen:
         the cut is to a car that is driving, in the gear the selector says. */
      const k = Math.min(1, (now - outroAt) / OUTRO_MS);
      const SH = 0.14;
      const rpmO = k < SH ? LIMITER - (LIMITER - 5600) * ease(k / SH)
        : 5600 + 800 * pull((k - SH) / (1 - SH));
      s = { rpm: rpmO, load: k < SH ? 0.25 : 1, crank: 0, live: true, holding: false, gear: G_4 };
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

    /* The whole screen shakes with the engine, and harder at the limiter -
       half what it was: a cluster this detailed reads as an instrument when
       it trembles and as a broken picture when it jumps. */
    const heat = Math.max(0, (shownRpm - 2000) / (RPM_MAX - 2000));
    shake = heat * heat * 3.4;
    const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;

    /* THE RING IS THE ENGINE. Dim and cold through the self-test and the
       crank; on the frame the engine catches it LIGHTS - a flare to full and
       a settle - and from then on it breathes with the revs, overdriven at the
       limiter where the fuel cut makes it flicker. On the outro it stays lit
       as the revs fall away, because the engine is still running. */
    const catchAt = 1.75;
    let ringLvl;
    if (t < catchAt && !outroAt) {
      ringLvl = 0.16 + 0.12 * Math.max(0, Math.min(1, (t - 0.95) / 0.8));
    } else {
      const since = outroAt ? 9 : t - catchAt;
      const ignite = since < 0.5 ? Math.max(0, 1 - since / 0.5) * 0.55 : 0;
      ringLvl = 0.55 + 0.45 * heat + ignite;
      if (s.live && !outroAt && shownRpm >= LIMITER - 400) ringLvl *= 0.86 + 0.14 * Math.abs(Math.sin(t * 61));
    }
    /* BOOST arms across the crank and the catch - the job the progress ring
       used to do - and once armed it reads the throttle, so a blip pushes it
       up the column and the limiter pins it in the red. */
    const arm = Math.max(0, Math.min(1, (t - 0.95) / 1.45));
    const boostLvl = outroAt ? arm * (0.45 + 0.55 * heat) : arm * (0.42 + 0.58 * Math.min(1, heat * 1.15));
    /* THE SELECTOR is whatever the script says the box is in - the same row
       of the table the revs came from (see script). The box SLIDES to a new
       gear over a few frames rather than jumping, and is lit hard for the
       moment of the change, so a shift reads as a movement of the lever that
       the needle's drop is the result of. */
    const gear = s.gear === undefined ? G_N : s.gear;
    const dtF = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 1 / 60;
    lastFrame = now;
    if (gear !== gearWas) { gearWas = gear; shiftAt = now; }
    gearPos = gearPos === null ? gear : gearPos + (gear - gearPos) * (1 - Math.exp(-30 * dtF));
    const kick = Math.max(0, 1 - (now - shiftAt) / 220);
    // the instruments either side draw themselves on across the self-test
    const intro = Math.max(0, Math.min(1, (t - 0.10) / 0.85));

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
    /* The caption reads the same table: what the box is doing is what the
       line says, so it cannot announce a pull the selector is not in. */
    const capLine = outroAt ? 'SYSTEMS NOMINAL'
      : t < 0.95 ? 'DIAL SELF TEST'
      : t < 1.78 ? 'CRANKING'
      : gear === G_N ? 'IGNITION'
      : gear === G_D ? 'DRIVE ENGAGED'
      : s.holding ? 'SYSTEMS NOMINAL'
      : 'GEAR ' + GEARS[gear] + '  //  PULLING';

    cx.save();
    cx.clearRect(0, 0, vw, vh);
    cx.translate(sx, sy);
    /* THE ORDER IS THE DEPTH. The ground, then the floor running away from
       it, then the instrument standing on both, then everything the
       instrument is saying, then the name under it and the frame around the
       lot. */
    const K = ensureCache(L);
    blit(cx, K.room, L.w / 2, L.h / 2);
    floorLines(cx, L, t);
    cluster(cx, L, shownRpm, s.live, t, ringLvl, boostLvl, gear, intro, gearPos, kick);
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
    void p;
    status(cx, L, capLine, rise * (1 - Math.min(1, stamp * 1.6)));
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
    cache = null;
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
