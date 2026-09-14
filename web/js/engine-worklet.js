/* SYNX // THE ENGINE, ON THE AUDIO THREAD.
 *
 * A cross-plane V8, synthesised sample by sample, for the cold open in front
 * of the photosensitivity notice. See js/ignition.js, which drives it.
 *
 * ============================================================ WHY A REWRITE
 *
 * The first version of this was three oscillators on the main graph: two
 * detuned sawtooths at the firing frequency, a square an octave under them,
 * and a lowpass that opened with the revs. It was reported as sounding like a
 * motorcycle, and that is exactly what it was.
 *
 * A sawtooth is a perfectly even harmonic series. Run one at the firing rate,
 * open a filter over it and you get a smooth, bright, evenly-spaced tone that
 * rises in pitch - which is a small, high-revving single or twin with an open
 * pipe. Every part of the description is wrong for a large V8, and none of it
 * can be fixed by tuning the filter, because the problem is not the spectrum.
 * It is that an engine is not a waveform at all.
 *
 * ======================================================= WHAT AN ENGINE IS
 *
 * It is a PULSE TRAIN THROUGH A PIPE. Each cylinder fires, an exhaust valve
 * opens, and a pressure pulse leaves into an exhaust system that rings. What
 * the ear gets is the rate of those pulses, and the resonances they excite.
 * Three consequences, and they are the whole of the difference:
 *
 *   THE PULSES ARE DISCRETE. At idle a V8 fires about thirty times a second,
 *   which is slow enough to hear as separate events - the lumpiness of an
 *   idling engine IS the individual pulses. A continuous oscillator has no
 *   such thing at any rpm, which is why it reads as a machine spinning rather
 *   than an engine running.
 *
 *   AND THEY ARE UNEVEN. This is the single most identifiable thing about an
 *   American V8 and the reason it is a rumble rather than a drone. A
 *   CROSS-PLANE crank puts its throws at ninety degrees to each other, and
 *   with two cylinder banks that means each bank's own exhaust sees an uneven
 *   pattern - on one bank, two cylinders fire back to back and then it waits.
 *   The two banks are separate pipes, so what arrives is two lopsided trains
 *   beating against each other. A flat-plane V8 (a Ferrari) is even, and
 *   sounds like a pair of four-cylinder engines: much higher, much flatter,
 *   much more like the thing this used to sound like.
 *
 *   AND THE PIPE COLOURS THEM. The exhaust is a resonator with fixed
 *   frequencies that do NOT move with the revs. That is what makes a rev
 *   sound like effort: the pulse rate climbs through a set of standing
 *   formants, so the timbre changes as it goes. Pitch-shifting a whole
 *   waveform moves the formants with it, which is the chipmunk effect, and is
 *   the other half of why the old one sounded small.
 *
 * ========================================================== WHAT IS IN HERE
 *
 *   a crank angle, advanced sample by sample from the rpm;
 *   eight firing events per two revolutions, at the cross-plane offsets, split
 *   across two banks;
 *   a bank of damped two-pole resonators per side, struck by each pulse -
 *   this is the exhaust, and it is where the bark comes from;
 *   a short noise burst on each pulse, which is the chuff of the valve;
 *   a low resonator pair for the chest of it;
 *   a light mechanical layer, high and quiet, so it is not purely tonal;
 *   a soft clip, and a one-pole lowpass that opens with the throttle rather
 *   than with the revs.
 *
 * ============================================== WHY IT IS A WORKLET AT ALL
 *
 * Because the pulses have to land in the right places. A firing event at nine
 * thousand rpm is one every 1.6 milliseconds; scheduling those from the main
 * thread means scheduling them in blocks, in advance, against a clock that a
 * busy main thread does not get to read - and this runs WHILE THE GAME IS
 * LOADING, which is the busiest the main thread ever gets. On the audio
 * thread the crank angle advances one sample at a time and cannot drift,
 * whatever the page is doing.
 *
 * It is also the reason the cold open can cover a load at all: the picture may
 * stutter while a texture is being inflated, and the engine will not.
 */

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
         rev limiter does not hold a needle still, it stops lighting cylinders,
         and the stutter of that is unmistakable. */
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;

    /* THE FIRING PATTERN, in degrees of crank over one full 720-degree cycle.
     *
     * A cross-plane V8 in the usual 1-8-4-3-6-5-7-2 order fires evenly every
     * ninety degrees at the crank - but the cylinders alternate between the
     * banks UNEVENLY, and each bank has its own exhaust. Split out, one bank
     * gets 0, 270, 450, 540 and the other 90, 180, 360, 630.
     *
     * Look at the gaps rather than the numbers, because the gaps are what is
     * audible. Bank one: 270, 180, 90, 180. Bank two: 90, 180, 270, 180. Two
     * lopsided patterns, mirror images of each other, running at the same
     * time. That is the rumble - and setting both banks to an even 180 here,
     * which is what a flat-plane crank does, turns this into a European V8
     * and is a good way to hear exactly how much of the character is in these
     * eight numbers.
     */
    this.banks = [
      { fire: [0, 270, 450, 540], res: null, lp: 0 },
      { fire: [90, 180, 360, 630], res: null, lp: 0 },
    ];

    /* THE EXHAUST, as damped resonators.
     *
     * Struck by a pulse, a two-pole resonator rings at its own frequency and
     * dies away - which is what a length of pipe does. These frequencies do
     * not move with the revs, and that is the entire point: the pulse rate
     * climbs through them, so the note changes character as it rises instead
     * of merely getting higher.
     *
     * Chosen low and close together. A big V8's exhaust note lives under 400
     * Hz; everything above that is the valvetrain and the induction, and both
     * of those are quieter than people expect.
     *
     * THE TWO BANKS GET DIFFERENT PIPES, AND THAT IS NOT A DETAIL.
     *
     * Measured, with both banks on identical pipes summed to mono: energy at
     * half the firing rate was eighteen per cent of the energy at the firing
     * rate, where a cross-plane V8 should be at least a third. The reason is
     * arithmetic rather than taste. The two banks fire at 0, 270, 450, 540 and
     * at 90, 180, 360, 630 - and INTERLEAVED those are 0, 90, 180, 270, 360,
     * 450, 540, 630, which is perfectly even every ninety degrees. Add two
     * identical uneven trains together and the unevenness cancels exactly;
     * what is left is a smooth pulse train at four per revolution, which is
     * the motorcycle this whole file exists to stop being.
     *
     * A real engine does not cancel because the two banks do not share a pipe.
     * They are different lengths, they ring at different frequencies, and they
     * come out of the back of the car in different places - so each ear hears
     * one lopsided train more than the other and the pattern never closes up.
     * Hence: a bank detuned thirteen per cent against its partner, different
     * damping on each, and the two panned apart. Put them back on the same
     * pipe and the rumble goes, which is the check in --probe engine.
     */
    const PIPE = [
      // f     bandwidth  level
      [72, 26, 1.00],   // the chest of it, felt more than heard
      [118, 34, 0.86],  // the fundamental bark
      [196, 62, 0.52],
      [318, 120, 0.30],
      [505, 210, 0.16],
    ];
    const mkres = (list, detune, damp) => list.map(([f, bw, g]) => {
      const w = 2 * Math.PI * (f * detune) / sr;
      const r = Math.exp(-Math.PI * (bw * (damp || 1)) / sr);
      return { a1: 2 * r * Math.cos(w), a2: -r * r, g, y1: 0, y2: 0 };
    });
    /* The left bank is the shorter pipe: higher, harder, and it decays
       quicker. The right is longer and rounder. Thirteen per cent apart is
       about what a real pair of headers differ by once the collectors are
       included, and it is well past the point where the two stop cancelling. */
    this.banks[0].res = mkres(PIPE, 1.0, 1.0);
    this.banks[1].res = mkres(PIPE, 0.87, 0.78);
    /* ...and they are not the same loudness either. Nothing is symmetrical on
       a car: the exhaust runs down one side, the listener is on the other. */
    this.banks[0].level = 0.56;
    this.banks[1].level = 0.44;

    /* The valvetrain: high, short, quiet. Without something up here the engine
       is a pure tone stack and reads as a synthesiser doing an impression;
       with too much of it, it reads as a diesel. */
    this.mech = mkres([[1650, 700, 0.09], [2950, 1300, 0.05]], 1.0);

    // crank angle in degrees, and where each bank's pattern has got to
    this.deg = 0;
    this.idx = [0, 0];
    // how many samples of noise burst each bank still owes
    this.burst = [0, 0];
    this.burstAmp = [0, 0];

    // one-pole lowpass state, and a DC blocker so the pulses cannot walk off
    this.lp = 0;
    this.lpR = 0;
    this.dcx = 0;
    this.dcy = 0;
    this.dcxR = 0;
    this.dcyR = 0;

    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.alive = false;
    };
  }

  process(_inputs, outputs, params) {
    const out = outputs[0];
    if (!out || !out.length) return this.alive;
    const L = out[0];
    const R = out.length > 1 ? out[1] : null;
    const n = L.length;
    const sr = sampleRate;

    const rpmP = params.rpm, loadP = params.load, gainP = params.gain;
    const cut = params.cut[0];

    for (let i = 0; i < n; i++) {
      const rpm = (rpmP.length > 1 ? rpmP[i] : rpmP[0]);
      const load = (loadP.length > 1 ? loadP[i] : loadP[0]);
      const gain = (gainP.length > 1 ? gainP[i] : gainP[0]);

      /* THE CRANK. Degrees per sample: rpm revolutions a minute is rpm/60 a
         second, times 360 degrees, divided by the sample rate. */
      const step = (rpm * 6) / sr;
      this.deg += step;
      let wrapped = false;
      if (this.deg >= 720) { this.deg -= 720; wrapped = true; }

      let left = 0, right = 0;

      for (let b = 0; b < 2; b++) {
        const bank = this.banks[b];
        /* A new cycle: the pattern starts again. Each bank walks its own
           sorted list once per 720 degrees and never looks back, so an event
           cannot fire twice however small the step gets, and cannot be
           missed however large - at nine thousand rpm the crank moves about
           a degree a sample and the closest pair of events is ninety apart. */
        if (wrapped) this.idx[b] = 0;
        while (this.idx[b] < bank.fire.length && this.deg >= bank.fire[this.idx[b]]) {
          this.idx[b]++;
          /* THE FIRING ITSELF. Skipped outright when the limiter is cutting
             fuel - a rev limiter does not hold the revs, it stops lighting
             cylinders - and never quite the same size twice, because real
             combustion varies a few per cent cylinder to cylinder and a
             train of identical pulses is what reads as synthetic. */
          if (cut > 0 && Math.random() < cut) continue;
          const vary = 0.86 + Math.random() * 0.28;
          const amp = (0.30 + load * 0.70) * vary;
          for (const r of bank.res) r.y1 += amp * r.g;
          for (const r of this.mech) r.y1 += amp * r.g * 0.7;
          // ...and the chuff of the valve, a couple of milliseconds of air
          this.burst[b] = (sr * 0.0022) | 0;
          this.burstAmp[b] = amp * (0.18 + load * 0.34);
        }

        // the pipes ringing
        let bankSig = 0;
        for (const r of bank.res) {
          const y = r.a1 * r.y1 + r.a2 * r.y2;
          r.y2 = r.y1;
          r.y1 = y;
          bankSig += y;
        }
        // ...and the air still leaving
        if (this.burst[b] > 0) {
          this.burst[b]--;
          bankSig += (Math.random() * 2 - 1) * this.burstAmp[b]
            * (this.burst[b] / (sr * 0.0022));
        }
        /* PANNED, because that is the only place the unevenness survives. Two
           uneven trains that interleave to an even one cancel when they are
           summed; kept apart, each side keeps its own lopsided pattern and
           the ear gets the rumble from both. Seventy-thirty rather than hard
           left and right - the two pipes are a metre apart on a car, not in
           different rooms - and it still reads on a mono speaker because the
           banks are not the same loudness or the same pipe. */
        const lvl = bankSig * bank.level;
        if (b === 0) { left += lvl * 0.72; right += lvl * 0.28; }
        else { left += lvl * 0.28; right += lvl * 0.72; }
      }

      // the valvetrain, well under everything else, and up the middle
      let mech = 0;
      for (const r of this.mech) {
        const y = r.a1 * r.y1 + r.a2 * r.y2;
        r.y2 = r.y1;
        r.y1 = y;
        mech += y * 0.35;
      }
      left += mech;
      right += mech;

      /* THE THROTTLE, as a filter rather than as a volume. Closed, the pipe is
         muffled and only the low resonators get out; open, the top of the
         pulse comes with it. Tied to load and only weakly to rpm, which is
         what stops a rev sounding like a pitch bend. */
      const fc = 260 + load * 2600 + rpm * 0.06;
      const k = 1 - Math.exp(-2 * Math.PI * Math.min(fc, sr * 0.45) / sr);
      this.lp += (left - this.lp) * k;
      this.lpR += (right - this.lpR) * k;

      // compression, not distortion: an engine is squashed, not fuzzy
      const yl = Math.tanh(this.lp * 1.9) * 0.86;
      const yr = Math.tanh(this.lpR * 1.9) * 0.86;

      // and nothing may walk away from zero over a long hold
      const dl = yl - this.dcx + 0.9985 * this.dcy;
      this.dcx = yl; this.dcy = dl;
      const dr = yr - this.dcxR + 0.9985 * this.dcyR;
      this.dcxR = yr; this.dcyR = dr;

      L[i] = dl * gain;
      if (R) R[i] = dr * gain;
    }

    for (let c = 2; c < out.length; c++) out[c].set(L);
    return this.alive;
  }
}

registerProcessor('synx-engine', SynxEngine);
