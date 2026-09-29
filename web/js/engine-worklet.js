/* SYNX // THE ENGINE, ON THE AUDIO THREAD.
 *
 * A carburetted, cross-plane American V8 of the late sixties - big cam, dual
 * exhaust, glasspacks - synthesised sample by sample for the cold open in
 * front of the photosensitivity notice. See js/ignition.js, which drives it.
 *
 * ======================================================== WHY IT CRACKLED
 *
 * The version this replaces struck a bank of two-pole resonators with a unit
 * IMPULSE on every firing. A resonator seventy hertz wide at seventy hertz
 * rings at about a hundred times the size of what hits it, and those rings
 * piled up faster than they decayed - so what reached the output stage was a
 * signal a hundred and fifty times louder than the stage was built for, and
 * `tanh` turned it into a square wave. Every zero crossing was a step from
 * one rail to the other inside a single sample: a click, forty times a
 * second at idle and six hundred at the limiter, with the aliases of every
 * one of them folded back across the spectrum. That is the crackle. It was
 * not a filter setting and no filter setting fixes it; the engine was being
 * clipped by forty-five decibels.
 *
 * So nothing in here is an impulse any more, nothing rings at more than a
 * few times its input, and the level is set BEFORE the one nonlinearity,
 * where it belongs.
 *
 * ======================================================= WHAT AN ENGINE IS
 *
 * A PULSE TRAIN THROUGH A PIPE. Each cylinder fires, its exhaust valve cracks
 * open, and a slug of hot gas leaves into a pipe that rings. Three things
 * about that are the whole character:
 *
 *   THE PULSES ARE SHAPES, NOT CLICKS. A blowdown rises in about a
 *   millisecond - the gas goes sonic at the valve - and then empties over a
 *   hundred-odd degrees of crank. Built that way, the pulse is band-limited
 *   by construction: it gets sharper and brighter as the revs climb, because
 *   a hundred degrees of crank IS less time at seven thousand, and it never
 *   gets sharp enough to click.
 *
 *   THEY ARE UNEVEN. A cross-plane crank fires the eight cylinders every
 *   ninety degrees, but it alternates between the banks unevenly - 1-8-4-3-
 *   6-5-7-2, odd cylinders on the left - so each bank's own exhaust sees two
 *   pulses back to back and then a wait. Two lopsided trains, one per pipe,
 *   is the rumble. Sum them into one pipe and they interleave into a perfectly
 *   even one, which is a motorcycle: so they get different pipes, and they
 *   come out of different ends of the car.
 *
 *   THE PIPE HAS RESONANCES THAT DO NOT MOVE. Header, pipe and tailpipe are a
 *   tube closed at the valve and open at the back, and a tube like that rings
 *   at fixed frequencies - here a waveguide per bank, 1.75 and 2.05 metres of
 *   hot gas. The firing rate climbs THROUGH those, so a rev changes character
 *   as it rises instead of just going up in pitch; pitch-shifting a sound
 *   moves its resonances with it, which is the chipmunk the old oscillator
 *   stack was.
 *
 * ========================================= AND WHAT MAKES IT A SIXTIES V8
 *
 *   THE CAM. A long-duration cam idles badly on purpose - a lot of overlap,
 *   so each cylinder burns a slightly different charge every cycle. That
 *   cycle-to-cycle wobble, plus each cylinder's own fixed personality, is the
 *   lope: the lumpy "blub-blub-BLUB" at nine hundred. It fades out with revs
 *   and with throttle, exactly as it does on a car.
 *
 *   THE CARBURETTOR. Four barrels open to the air: a hoarse induction roar
 *   that tracks the throttle rather than the revs.
 *
 *   SOLID LIFTERS. A faint tick, one per firing, well under everything.
 *
 *   OVERRUN. Lift off at high revs and a little fuel goes on burning in a
 *   hot pipe: the burble and the occasional pop on the way down.
 *
 *   THE STARTER. The solenoid's clunk, the ring gear's whine, and the engine
 *   chuffing through its compression strokes before it catches.
 *
 * ============================================== WHY IT IS A WORKLET AT ALL
 *
 * Because the pulses have to land in the right places. A firing event at nine
 * thousand rpm is one every 1.6 milliseconds; scheduling those from the main
 * thread means scheduling them in blocks, in advance, against a clock a busy
 * main thread does not get to read. On the audio thread the crank advances
 * one sample at a time and cannot drift, whatever the page is doing - and
 * because everything, starter and intake included, is generated here, the
 * main graph is one node and one gain, with nothing on it that can glitch.
 *
 * NOTHING IN process() ALLOCATES. It runs three hundred and seventy-five
 * times a second on a thread whose deadline is absolute; a garbage
 * collection on it is a gap in the sound. Every piece of state is a number
 * or a preallocated typed array, and every loop is indexed.
 */

const PI = Math.PI;

/* The firing order, 1-8-4-3-6-5-7-2, as crank degree, bank, and each
   cylinder's own personality: a fixed difference in how hard it burns and a
   degree or so of where, because no two cylinders on a real engine are the
   same and eight identical pulses is exactly what reads as synthetic. Odd
   cylinders are the left bank. Offsets are small and keep the order. */
const FIRE_DEG = [0, 90, 180, 270, 360, 450, 540, 630];
const FIRE_BANK = [0, 1, 1, 0, 1, 0, 0, 1];
const FIRE_AMP = [1.00, 0.92, 1.07, 0.95, 1.03, 0.89, 1.09, 0.96];
const FIRE_LAG = [0.0, 1.6, -1.1, 0.9, 0.2, -1.5, 0.7, -0.6];

/* The exhaust. Round-trip time of each bank's pipe, in milliseconds - a tube
   closed at the valve and open at the tail rings at odd multiples of one over
   twice this: 63, 190, 316 Hz on the left and 54, 161, 269 Hz on the right.
   The reflection at the open end is inverted and lossy. */
const PIPE_MS = [7.9, 9.3];
const PIPE_REFLECT = -0.5;
const PIPE_LOSS_HZ = 1400;
// The tailpipes, shorter and after the mufflers: a second, fainter set of rings.
const TAIL_MS = [3.4, 3.9];
const TAIL_REFLECT = -0.35;

// Most pulses that can be in flight on one bank at once; eight is generous.
const SLOTS = 8;

class SynxEngine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      /* Where the crank is, in revolutions per minute. a-rate so a rev that
         happens inside one 128-sample block is still smooth. */
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 14000, automationRate: 'a-rate' },
      /* How hard the throttle is being asked for, 0..1. This is NOT the same
         as the revs and the difference is most of the realism: an engine held
         at four thousand on a closed throttle is muffled and hollow, and the
         same four thousand on the way up is open and hard. */
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'gain', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      /* Fuel cut, 0..1: the share of firing events that are thrown away. A
         rev limiter does not hold a needle still, it stops lighting
         cylinders, and the stutter of that is unmistakable. */
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      /* Is it running on its own. Zero while the starter is turning it over:
         the cylinders still pump air through the pipes, they just do not
         burn anything. Defaults to running, so a caller that only knows
         about rpm and load gets an engine. */
      { name: 'fire', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // the starter motor, 0 (off) .. 1 (engaged and turning hard)
      { name: 'crank', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.sr = sr;

    // ---- the crank
    this.deg = 0;
    this.idx = 0;
    this.thr = new Float64Array(8);
    for (let i = 0; i < 8; i++) this.thr[i] = FIRE_DEG[i] + FIRE_LAG[i];

    // ---- pulses in flight, per bank (flattened [bank * SLOTS + slot])
    this.pT = new Float64Array(2 * SLOTS);     // samples since it started (may be < 0: delayed)
    this.pNa = new Float64Array(2 * SLOTS);    // attack length, samples
    this.pNd = new Float64Array(2 * SLOTS);    // decay length, samples
    this.pAmp = new Float64Array(2 * SLOTS);   // 0 = slot free
    this.pNz = new Float64Array(2 * SLOTS);    // how much of it is turbulent air

    // ---- the pipes: a delay line and a lossy inverted reflection per bank
    this.pipeLen = new Int32Array(2);
    this.tailLen = new Int32Array(2);
    this.pipeBuf = [];
    this.tailBuf = [];
    for (let b = 0; b < 2; b++) {
      this.pipeLen[b] = Math.max(8, Math.round(PIPE_MS[b] * sr / 1000));
      this.tailLen[b] = Math.max(8, Math.round(TAIL_MS[b] * sr / 1000));
      this.pipeBuf.push(new Float64Array(this.pipeLen[b]));
      this.tailBuf.push(new Float64Array(this.tailLen[b]));
    }
    this.pipeW = new Int32Array(2);
    this.tailW = new Int32Array(2);
    this.pipeLp = new Float64Array(2);
    this.tailLp = new Float64Array(2);
    this.lossK = 1 - Math.exp(-2 * PI * PIPE_LOSS_HZ / sr);

    // ---- mufflers: a state-variable low-pass per bank, opened by throttle
    this.mS1 = new Float64Array(2);
    this.mS2 = new Float64Array(2);
    // the chest: a fixed peaking bump at ~105 Hz per bank (RBJ, direct form 1)
    this.chest = this.peaking(105, 0.9, 5.5);
    this.cX1 = new Float64Array(2); this.cX2 = new Float64Array(2);
    this.cY1 = new Float64Array(2); this.cY2 = new Float64Array(2);

    // ---- air: white noise, lightly low-passed per bank
    this.seed = 0x9e3779b1 | 0;
    this.nLp = new Float64Array(2);
    this.nK = 1 - Math.exp(-2 * PI * 1900 / sr);

    // ---- induction: band-passed noise, pulsed by the intake strokes
    this.iS1 = 0; this.iS2 = 0;
    // ---- valvetrain tick: a short burst through a fixed band-pass
    this.tickT = 1e9; this.tickLen = Math.max(4, Math.round(0.0006 * sr));
    this.kS1 = 0; this.kS2 = 0;
    this.tickG = Math.tan(PI * 3200 / sr);

    // ---- starter: ring-gear whine, brush buzz, and the solenoid's clunk
    this.whPh = 0;
    this.bzS1 = 0; this.bzS2 = 0;
    this.bzG = Math.tan(PI * 1900 / sr);
    this.crankWas = 0;
    this.clunkT = 1e9;
    this.clunkLen = Math.round(0.07 * sr);
    this.clunkPh = 0;

    // ---- output: high-pass, a gentle saturation, a low-pass and a limiter
    this.hpX = new Float64Array(2); this.hpY = new Float64Array(2);
    this.hpA = Math.exp(-2 * PI * 32 / sr);
    this.oLp = new Float64Array(2);
    this.oK = 1 - Math.exp(-2 * PI * 9000 / sr);
    this.env = 0;
    this.envRel = Math.exp(-1 / (0.12 * sr));

    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.alive = false;
    };
  }

  /* An RBJ peaking filter, normalised. Used once, for a fixed bump. */
  peaking(f, q, db) {
    const A = Math.pow(10, db / 40), w = 2 * PI * f / this.sr;
    const al = Math.sin(w) / (2 * q), c = Math.cos(w);
    const a0 = 1 + al / A;
    return {
      b0: (1 + al * A) / a0, b1: (-2 * c) / a0, b2: (1 - al * A) / a0,
      a1: (-2 * c) / a0, a2: (1 - al / A) / a0,
    };
  }

  /** White noise, -1..1, from a xorshift - cheaper than Math.random and it
      never allocates. */
  noise() {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return (x | 0) / 2147483648;
  }

  /* Put a pulse in flight on one bank. `delay` in samples lets a pulse start
     a little later than the event that caused it - which is what an
     afterfire in the pipe is. */
  launch(bank, amp, nz, rise, fall, delay) {
    const o = bank * SLOTS;
    let slot = -1, oldest = -1, oldestT = -1e9;
    for (let k = 0; k < SLOTS; k++) {
      if (this.pAmp[o + k] <= 0) { slot = k; break; }
      if (this.pT[o + k] > oldestT) { oldestT = this.pT[o + k]; oldest = k; }
    }
    if (slot < 0) slot = oldest;
    this.pT[o + slot] = -delay;
    this.pNa[o + slot] = Math.max(2, rise);
    this.pNd[o + slot] = Math.max(4, fall);
    this.pAmp[o + slot] = amp;
    this.pNz[o + slot] = nz;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0];
    if (!out || !out.length) return this.alive;
    const L = out[0];
    const R = out.length > 1 ? out[1] : null;
    const n = L.length;
    const sr = this.sr;

    const rpmP = params.rpm, loadP = params.load, gainP = params.gain;
    const cut = params.cut[0];
    const fire = params.fire[0] >= 0.5;
    const crank = params.crank[0];

    /* Per-block values for the parts that do not need to move faster than
       every 2.7 ms: the muffler opening, the intake's pitch, the lope. */
    const rpm0 = rpmP[0], load0 = loadP[0];
    const rpmB = rpmP.length > 1 ? 0.5 * (rpmP[0] + rpmP[n - 1]) : rpm0;
    const loadB = loadP.length > 1 ? 0.5 * (loadP[0] + loadP[n - 1]) : load0;
    /* The muffler: closed, only the chest gets out; open, the top of the pulse
       comes with it. Tied to throttle first and revs second. */
    const mFc = Math.min(sr * 0.2, 520 + loadB * 2300 + rpmB * 0.16);
    const mG = Math.tan(PI * mFc / sr), mR = 1 / 0.72;   // SVF, Q 0.72
    const mA1 = 1 / (1 + mG * (mG + mR));
    // the induction's pitch: the plenum and runners, rising a little with revs
    const iFc = Math.min(sr * 0.2, 170 + rpmB * 0.055);
    const iG = Math.tan(PI * iFc / sr), iR = 1 / 1.35;
    const iA1 = 1 / (1 + iG * (iG + iR));
    // how hard it is breathing, which follows the throttle more than the revs
    const iLvl = Math.pow(loadB, 1.3) * (0.25 + 0.75 * Math.min(1, rpmB / 6000)) * 0.55;
    /* How much the cam shows: all of it at a closed-throttle idle, none of it
       by three thousand or with the throttle open. */
    const lope = Math.max(0, Math.min(1, 1 - (rpmB - 650) / 1700)) * (1 - 0.8 * loadB);
    // the starter's solenoid, on its rising edge
    if (crank > 0.05 && this.crankWas <= 0.05) { this.clunkT = 0; this.clunkPh = 0; }
    this.crankWas = crank;

    const C = this.chest;
    const tickG = this.tickG, tickA1 = 1 / (1 + tickG * (tickG + 1 / 2.2));
    const bzG = this.bzG, bzA1 = 1 / (1 + bzG * (bzG + 1 / 1.6));

    for (let i = 0; i < n; i++) {
      const rpm = rpmP.length > 1 ? rpmP[i] : rpm0;
      const load = loadP.length > 1 ? loadP[i] : load0;
      const gain = gainP.length > 1 ? gainP[i] : gainP[0];

      /* THE CRANK. Degrees per sample: rpm revolutions a minute is rpm/60 a
         second, times 360 degrees, over the sample rate. */
      const step = (rpm * 6) / sr;
      this.deg += step;
      /* Degrees in samples at this speed - every pulse length below is set
         in crank angle, so the engine's sound scales with it. */
      const perDeg = step > 1e-9 ? 1 / step : 1e9;

      while (this.idx < 8 && this.deg >= this.thr[this.idx]) {
        const c = this.idx;
        this.idx++;
        this.event(c, rpm, load, fire, cut, lope, perDeg);
      }
      if (this.deg >= 720) {
        this.deg -= 720;
        this.idx = 0;
      }

      // ---- the two banks: pulses, into their pipes
      let bank0 = 0, bank1 = 0;
      for (let b = 0; b < 2; b++) {
        const o = b * SLOTS;
        let s = 0, air = 0;
        for (let k = 0; k < SLOTS; k++) {
          const a = this.pAmp[o + k];
          if (a <= 0) continue;
          const t = this.pT[o + k];
          this.pT[o + k] = t + 1;
          if (t < 0) continue;
          const na = this.pNa[o + k];
          let e;
          if (t < na) {
            e = 0.5 - 0.5 * Math.cos(PI * t / na);
          } else {
            const x = (t - na) / this.pNd[o + k];
            if (x >= 1) { this.pAmp[o + k] = 0; continue; }
            e = 1 - x * x * (3 - 2 * x);
          }
          s += e * a;
          air += e * a * this.pNz[o + k];
        }
        // turbulent flow riding the pulse: noise, lightly softened
        this.nLp[b] += (this.noise() - this.nLp[b]) * this.nK;
        const x = s + air * this.nLp[b] * 1.8;

        // the pipe: a round trip, an inverted lossy reflection
        const pb = this.pipeBuf[b], pl = this.pipeLen[b];
        const w = this.pipeW[b];
        this.pipeLp[b] += (pb[w] - this.pipeLp[b]) * this.lossK;
        const y = x + PIPE_REFLECT * this.pipeLp[b];
        pb[w] = y;
        this.pipeW[b] = w + 1 >= pl ? 0 : w + 1;
        if (b === 0) bank0 = y; else bank1 = y;
      }

      // ---- an H-pipe between them, then the mufflers, the chest and the tails
      const h0 = bank0 + 0.07 * bank1, h1 = bank1 + 0.07 * bank0;
      let m0 = 0, m1 = 0;
      for (let b = 0; b < 2; b++) {
        const v = b === 0 ? h0 : h1;
        // TPT state-variable low-pass (Zavalishin): stable under modulation
        const hp = (v - (mR + mG) * this.mS1[b] - this.mS2[b]) * mA1;
        const bp = mG * hp + this.mS1[b];
        this.mS1[b] = mG * hp + bp;
        const lp = mG * bp + this.mS2[b];
        this.mS2[b] = mG * bp + lp;
        // the chest
        const cy = C.b0 * lp + C.b1 * this.cX1[b] + C.b2 * this.cX2[b]
          - C.a1 * this.cY1[b] - C.a2 * this.cY2[b];
        this.cX2[b] = this.cX1[b]; this.cX1[b] = lp;
        this.cY2[b] = this.cY1[b]; this.cY1[b] = cy;
        // the tailpipe
        const tb = this.tailBuf[b], tl = this.tailLen[b], tw = this.tailW[b];
        this.tailLp[b] += (tb[tw] - this.tailLp[b]) * this.lossK;
        const ty = cy + TAIL_REFLECT * this.tailLp[b];
        tb[tw] = ty;
        this.tailW[b] = tw + 1 >= tl ? 0 : tw + 1;
        if (b === 0) m0 = ty; else m1 = ty;
      }

      // ---- the carburettor, breathing on every intake stroke
      let mid = 0;
      if (load > 0.01 && rpm > 60) {
        const ph = (this.deg % 90) / 90;
        const breath = 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(2 * PI * ph));
        const v = this.noise();
        const hp = (v - (iR + iG) * this.iS1 - this.iS2) * iA1;
        const bp = iG * hp + this.iS1;
        this.iS1 = iG * hp + bp;
        this.iS2 = iG * bp + (iG * bp + this.iS2);
        mid += bp * breath * iLvl;
      }

      // ---- the lifters: one tiny tick per firing
      if (this.tickT < this.tickLen) {
        const e = 0.5 - 0.5 * Math.cos(2 * PI * this.tickT / this.tickLen);
        this.tickT++;
        const v = this.noise() * e;
        const hp = (v - (1 / 2.2 + tickG) * this.kS1 - this.kS2) * tickA1;
        const bp = tickG * hp + this.kS1;
        this.kS1 = tickG * hp + bp;
        this.kS2 = tickG * bp + (tickG * bp + this.kS2);
        mid += bp * Math.min(1, Math.sqrt(rpm / 3000)) * 0.05;
      }

      // ---- the starter
      if (crank > 0.001) {
        // ring gear: 168 teeth on the flywheel, so this whines at 168 x crank
        this.whPh += (rpm / 60) * 168 / sr;
        if (this.whPh > 1) this.whPh -= Math.floor(this.whPh);
        const p = 2 * PI * this.whPh;
        const whine = 0.55 * Math.sin(p) + 0.22 * Math.sin(2 * p + 0.4) + 0.1 * Math.sin(3 * p + 1.1);
        const v = this.noise();
        const hp = (v - (1 / 1.6 + bzG) * this.bzS1 - this.bzS2) * bzA1;
        const bp = bzG * hp + this.bzS1;
        this.bzS1 = bzG * hp + bp;
        this.bzS2 = bzG * bp + (bzG * bp + this.bzS2);
        mid += crank * (whine * 0.16 + bp * 0.09);
      }
      if (this.clunkT < this.clunkLen) {
        // the solenoid throwing the pinion in: a thud and a little rattle
        const x = this.clunkT / this.clunkLen;
        const e = (1 - x) * (1 - x) * Math.min(1, this.clunkT / (0.0015 * sr));
        this.clunkPh += 88 / sr;
        mid += e * (Math.sin(2 * PI * this.clunkPh) * 0.45 + this.noise() * 0.08);
        this.clunkT++;
      }

      // ---- out: left pipe mostly on the left, right mostly on the right
      let l = m0 * 0.78 + m1 * 0.22 + mid;
      let r = m0 * 0.22 + m1 * 0.78 + mid;

      // below the chest there is only rumble the speaker cannot make
      let y = l - this.hpX[0] + this.hpA * this.hpY[0];
      this.hpX[0] = l; this.hpY[0] = y; l = y;
      y = r - this.hpX[1] + this.hpA * this.hpY[1];
      this.hpX[1] = r; this.hpY[1] = y; r = y;

      /* ONE NONLINEARITY, AND IT IS GENTLE: a rational tanh, driven so that
         a wide-open pull sits at the knee rather than through it. Squashed,
         not fuzzy - the character of an exhaust is compression. */
      l *= 0.55; r *= 0.55;
      l = l < -3 ? -1 : l > 3 ? 1 : l * (27 + l * l) / (27 + 9 * l * l);
      r = r < -3 ? -1 : r > 3 ? 1 : r * (27 + r * r) / (27 + 9 * r * r);
      // the top octave is hash, not engine
      this.oLp[0] += (l - this.oLp[0]) * this.oK; l = this.oLp[0];
      this.oLp[1] += (r - this.oLp[1]) * this.oK; r = this.oLp[1];

      /* AND NOTHING LEAVES HERE HOTTER THAN IT SHOULD. A peak limiter with an
         instant attack and a slow release: in normal running it never acts,
         and if anything ever stacks up it is turned down, never clipped. */
      const pk = Math.max(Math.abs(l), Math.abs(r));
      this.env = pk > this.env ? pk : this.env * this.envRel + pk * (1 - this.envRel);
      const lim = this.env > 0.9 ? 0.9 / this.env : 1;

      L[i] = l * lim * gain;
      if (R) R[i] = r * lim * gain;
    }

    for (let c = 2; c < out.length; c++) out[c].set(L);
    return this.alive;
  }

  /* ONE CYLINDER'S TURN. Called from the crank loop as it passes the
     cylinder's mark. */
  event(c, rpm, load, fire, cut, lope, perDeg) {
    const bank = FIRE_BANK[c];
    const sr = this.sr;
    // the next time round, this cylinder lands a little differently
    const jitter = (Math.random() * 2 - 1) * (0.4 + 2.6 * lope);
    this.thr[c] = FIRE_DEG[c] + FIRE_LAG[c] + jitter;
    if (this.thr[c] < 0) this.thr[c] = 0;

    /* Pulse length in crank angle, held inside what the gas can actually do:
       a blowdown cannot rise faster than about 0.7 ms or empty slower than
       about 30 ms, whatever the crank is doing. */
    const rise = Math.min(0.006 * sr, Math.max(0.0007 * sr, 22 * perDeg));
    const fall = Math.min(0.030 * sr, Math.max(0.0025 * sr, 118 * perDeg));

    if (!fire) {
      /* Turning over on the starter: every cylinder still pumps its air out
         through the pipes - a soft chuff with nothing burning in it. */
      if (rpm > 30) this.launch(bank, 0.30, 0.9, rise * 1.4, fall * 0.8, 0);
      this.tickT = 0;
      return;
    }
    if (cut > 0 && Math.random() < cut) {
      /* The limiter has taken this one. Unburnt charge goes into a hot pipe,
         and now and then it lights there instead. */
      if (Math.random() < 0.18) {
        this.launch(bank, 0.35 + Math.random() * 0.3, 0.8, rise * 0.8, fall * 0.55,
          Math.round((25 + Math.random() * 40) * perDeg));
      }
      return;
    }
    /* How hard it burns: the throttle first, then this cylinder's own
       character, then this cycle's luck - which is large at a lumpy idle and
       small at full song. Now and then at idle a cylinder barely lights. */
    const vary = 1 + (Math.random() * 2 - 1) * (0.05 + 0.28 * lope);
    const weak = (lope > 0.5 && Math.random() < 0.06 * lope) ? 0.45 : 1;
    const amp = (0.40 + 0.60 * Math.pow(load, 0.8)) * FIRE_AMP[c] * vary * weak;
    const nz = 0.10 + 0.32 * load;
    this.launch(bank, amp, nz, rise, fall, 0);
    this.tickT = 0;

    /* OVERRUN. Off the throttle with the revs up, the odd charge finishes
       burning in the pipe a few degrees late: the burble on the way down. */
    if (load < 0.15 && rpm > 1900) {
      const p = 0.16 * (1 - load / 0.15) * Math.min(1, (rpm - 1900) / 2600);
      if (Math.random() < p) {
        this.launch(bank, 0.30 + Math.random() * 0.4, 0.75, rise * 0.8, fall * 0.6,
          Math.round((20 + Math.random() * 45) * perDeg));
      }
    }
  }
}

registerProcessor('synx-engine', SynxEngine);
