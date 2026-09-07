/* SYNX Synthwave eXtreme racing
 * Audio, using the game's own Ogg clips from assets/audio/.
 * Engine pitch follows the shipped range (VehicleParent minPitch 0.5 / max 1.53).
 */
(function (global) {
  'use strict';

  const DIR = 'assets/audio/';
  const MIN_PITCH = 0.5;
  const MAX_PITCH = 1.53;

  const ONESHOT = {
    select: 'Game - Select Item.ogg',
    rollover: 'subtle-tech_rollover_01.ogg',
    counter: 'DigitalDataCounter_06_Single.ogg',
    boost: 'boost.ogg',
    whoosh: 'spinwhoosh.ogg',
    crash0: 'carhit0.ogg',
    crash1: 'carhit1.ogg',
    crash2: 'carhit2.ogg',
    crash3: 'carhit3.ogg',
    crash4: 'carhit4.ogg',
  };
  const LOOPS = {
    engine: 'engine.ogg',
    open: 'open.ogg',
    idle: 'Cyber Engine Loop.ogg',
    screech: 'tirescreech.ogg',
    boostLoop: 'boostloop.ogg',
  };

  /* The title keeps its own looping theme. On the road, four full-length Ogg
     songs form an environment-aware radio. Each environment has a primary
     song and one compatible alternate so a long route can continue without
     immediately repeating the track that just finished. */
  const MENU_TRACK = {
    key: 'menu', file: 'theme.ogg', gain: 1.0, loop: true,
  };
  const CUTSCENE_TRACK = {
    key: 'cutscene', file: 'cutscene.ogg', gain: 1.0, loop: true,
  };
  const FACTORY_TRACK = {
    key: 'factory', file: 'factory.ogg', gain: 1.0, loop: true,
  };
  const FINAL_TRACK = {
    key: 'final', file: 'final.ogg', gain: 1.0, loop: true,
  };
  const RADIO_TRACKS = [
    {
      key: 'coastline_drive', file: 'radio/coastline_drive.ogg', gain: 1.25,
      primary: 'coast', environments: ['coast', 'mesa'],
    },
    {
      key: 'canyon_velocity', file: 'radio/canyon_velocity.ogg', gain: 1.25,
      primary: 'canyon', environments: ['canyon', 'city'],
    },
    {
      key: 'electric_horizon', file: 'radio/electric_horizon.ogg', gain: 1.25,
      primary: 'mesa', environments: ['mesa', 'coast'],
    },
    {
      key: 'midnight_circuit', file: 'radio/midnight_circuit.ogg', gain: 1.25,
      primary: 'city', environments: ['city', 'canyon'],
    },
  ];
  const MUSIC_TRACKS = [MENU_TRACK, CUTSCENE_TRACK, FACTORY_TRACK, FINAL_TRACK].concat(RADIO_TRACKS);
  const ENVIRONMENTS = new Set(['coast', 'canyon', 'mesa', 'city']);
  const FADE = 1.6;              // seconds; long enough to sound intentional

  class Audio {
    constructor() {
      this.ctx = null;
      this.ready = false;
      this.buffers = {};
      this.loops = {};
      this.tracks = {};          // key -> HTMLAudioElement
      this.current = null;       // concrete menu/radio key being mixed in
      this.intent = null;        // 'menu', 'radio', or null
      this.environment = 'coast';
      this.lastRadio = null;
      this.musicVol = undefined;
    }

    init() {
      if (this.ctx) return;
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const ctx = this.ctx;

      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(ctx.destination);

      this.sfx = ctx.createGain();
      this.sfx.gain.value = 0.7 * (this.sfxVol === undefined ? 1 : this.sfxVol);
      this.sfx.connect(this.master);

      /* THE DRIVING BUS.
       *
       * The engine, the idle, the intake, the tyres, the reheat and the wind
       * are the car, and a cutscene needs to be able to pull all six of them
       * down together without touching the dialogue blips, the UI clicks or a
       * crash that is part of the shot - all of which also live on `sfx`.
       *
       * It sits under `sfx` rather than beside it so the Sound FX slider still
       * governs everything, and so ducking is one gain rather than six. */
      this.drive = ctx.createGain();
      this.drive.gain.value = 1;
      this.drive.connect(this.sfx);

      this.music = ctx.createGain();
      this.music.gain.value = 0.5;
      this.music.connect(this.master);

      /* Procedural air pressure: a filtered, looping noise bed that only rises
         above highway speed. It costs no shipped asset and follows the actual
         speedometer, so 100 MPH has audible wind and reheat has a harder,
         brighter stream without drowning the engine or radio. */
      try {
        const seconds = 2, buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        let brown = 0;
        for (let i = 0; i < data.length; i++) {
          brown = brown * .94 + (Math.random() * 2 - 1) * .06;
          data[i] = brown * 2.5;
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer; src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass'; filter.frequency.value = 900; filter.Q.value = .42;
        const gain = ctx.createGain(); gain.gain.value = 0;
        src.connect(filter); filter.connect(gain); gain.connect(this.drive); src.start();
        this.wind = { src, filter, gain };
      } catch (e) { this.wind = null; }

      this.ready = true;
      this.loadAll();
      this.loadMusic();
    }

    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
    /** Is the graph actually making sound, as opposed to merely existing? */
    get running() { return !!(this.ctx && this.ctx.state === 'running'); }

    /* Pull the car down under something that is more important than it.
     *
     * `amount` is how much to REMOVE: 0 is the car at full, 1 is the car gone.
     * A cutscene sets it near the top of that range, because the thing a
     * cutscene is is somebody talking, and a car that will not stop revving
     * over the dialogue is the single most obvious way for a game to sound
     * unfinished.
     *
     * It ramps rather than jumps. A gain that steps to zero on the frame a cut
     * lands is a click, and a click at the start of every cutscene is worse
     * than the problem it was solving. */
    setDuck(amount, seconds) {
      this.duckTarget = Math.max(0, Math.min(1, amount || 0));
      if (!this.ctx || !this.drive) return;
      const t = this.ctx.currentTime;
      const g = this.drive.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(1 - this.duckTarget, t + (seconds === undefined ? 0.22 : seconds));
    }

    /* Silence everything, for quitting.

       A process that exits with an engine loop and a menu theme mid-buffer
       clicks on the way out, and on some drivers it leaves the device held for
       a moment after the window has gone. Ramping the master down over eighty
       milliseconds and then suspending the context ends it cleanly - and the
       ramp is scheduled rather than set, so it is smooth even though nothing
       is going to poll it again. */
    stopAll() {
      if (!this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        if (this.master) {
          this.master.gain.cancelScheduledValues(now);
          this.master.gain.setValueAtTime(this.master.gain.value, now);
          this.master.gain.linearRampToValueAtTime(0.0001, now + 0.08);
        }
        for (const el of Object.values(this.tracks || {})) {
          if (el && el.el && typeof el.el.pause === 'function') el.el.pause();
        }
        setTimeout(() => { try { this.ctx.suspend(); } catch (e) { /* closing */ } }, 100);
      } catch (e) { /* the graph is already gone */ }
    }

    /* Mixer levels from the Options screen, 0..1 each. Stored even when the
       context has not been created yet, because init() happens on the first
       user gesture and the settings are read before that. */
    setVolumes(music, sfx) {
      this.musicVol = music;
      this.sfxVol = sfx;
      if (this.sfx) this.sfx.gain.value = 0.7 * sfx;
      // ...through whatever duck is currently in force, or a pause screen open
      // while the slider moves would come back at full volume
      if (this.music) this.music.gain.value = 0.55 * music * (1 - (this.musicDuck || 0));
      // Re-apply the current mix so an Options change is heard at once without
      // restarting a song that is already in progress.
      if (music <= 0) this._mixTo(null, false);
      else if (this.intent === 'menu') this._mixTo('menu', false);
      else if (this.intent === 'radio') {
        if (this._radioDef(this.current)) this._mixTo(this.current, false);
        else this._startRadio(false);
      } else if (this.intent === 'factory' || this.intent === 'final') {
        this._mixTo(this.intent, false);
      }
    }

    decode(file) {
      return fetch(global.NR.Pak.url(DIR + file))
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('missing'))))
        .then(b => new Promise((res, rej) => this.ctx.decodeAudioData(b, res, rej)));
    }

    loadAll() {
      for (const k of Object.keys(ONESHOT)) {
        this.decode(ONESHOT[k]).then(b => { this.buffers[k] = b; }).catch(() => {});
      }
      for (const k of Object.keys(LOOPS)) {
        this.decode(LOOPS[k]).then(b => {
          const src = this.ctx.createBufferSource();
          src.buffer = b;
          src.loop = true;
          const g = this.ctx.createGain();
          g.gain.value = 0;
          src.connect(g); g.connect(this.drive);
          try { src.start(); } catch (e) { /* already started */ }
          this.loops[k] = { src, gain: g };
        }).catch(() => {});
      }
    }

    /* Music is streamed from <audio> elements rather than decoded whole into
       memory. Every element has its own gain node, which is what lets an
       environment boundary cross-fade cleanly in the middle of a song. */
    loadMusic() {
      for (const def of MUSIC_TRACKS) {
        const el = new global.Audio();
        el.src = global.NR.Pak.url(DIR + def.file);
        el.loop = !!def.loop;
        el.preload = 'auto';
        el.volume = 0;
        const entry = { el, gain: null, ready: false, broken: false, def, stopToken: 0 };
        this.tracks[def.key] = entry;
        el.addEventListener('canplay', () => {
          if (!this.ctx || entry.ready) return;
          try {
            const g = this.ctx.createGain();
            g.gain.value = 0;
            this.ctx.createMediaElementSource(el).connect(g);
            g.connect(this.music);
            entry.gain = g;
            entry.ready = true;
            el.volume = 1;
            if (this.current === def.key) this._mixTo(def.key, false);
          } catch (e) { /* a second source on one element is not allowed */ }
        }, { once: true });
        el.addEventListener('ended', () => {
          if (this.intent === 'radio' && this.current === def.key) this._startRadio(false);
        });
        el.addEventListener('error', () => {
          entry.broken = true;
          if (this.intent === 'radio' && this.current === def.key) this._startRadio(false);
        }, { once: true });
        el.load();
      }
    }

    _radioDef(key) { return RADIO_TRACKS.find(t => t.key === key) || null; }

    /** Pick an environment-compatible song without immediately repeating. */
    _pickRadio(environmentChange) {
      const usable = (d) => {
        const t = this.tracks[d.key];
        return !t || !t.broken;
      };
      let pool;
      if (environmentChange) {
        pool = RADIO_TRACKS.filter(d => d.primary === this.environment && usable(d));
      } else {
        pool = RADIO_TRACKS.filter(d => d.environments.indexOf(this.environment) >= 0 && usable(d));
      }
      if (!pool.length) pool = RADIO_TRACKS.filter(usable);

      // Avoid both the track still on the fader and the last radio song heard.
      // If an environment has only one usable file, broaden to its compatible
      // alternate before ever allowing an immediate repeat.
      let fresh = pool.filter(d => d.key !== this.current && d.key !== this.lastRadio);
      if (!fresh.length) {
        fresh = RADIO_TRACKS.filter(d => usable(d) &&
          d.environments.indexOf(this.environment) >= 0 &&
          d.key !== this.current && d.key !== this.lastRadio);
      }
      if (!fresh.length) {
        fresh = RADIO_TRACKS.filter(d => usable(d) && d.key !== this.current && d.key !== this.lastRadio);
      }
      if (!fresh.length) fresh = pool.filter(d => d.key !== this.current);
      if (!fresh.length) fresh = pool;
      return fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : null;
    }

    _startRadio(environmentChange) {
      const next = this._pickRadio(!!environmentChange);
      if (!next) { this._mixTo(null, false); return; }
      this.lastRadio = next.key;
      this._mixTo(next.key, true);
    }

    /** Set the scenery family. Crossing a boundary mid-song starts a fade. */
    setEnvironment(name) {
      const next = ENVIRONMENTS.has(name) ? name : 'coast';
      if (next === this.environment) return;
      this.environment = next;
      if (this.intent === 'radio') this._startRadio(true);
    }

    /**
     * Compatibility entry point used by Game: 'menu' selects the title theme;
     * 'race' selects the environment radio; null fades all music out.
     */
    playTrack(key) {
      if (key === 'menu') {
        this.intent = 'menu';
        this._mixTo('menu', this.current !== 'menu');
        return;
      }
      if (key === 'cutscene') {
        this.intent = 'cutscene';
        this._mixTo('cutscene', this.current !== 'cutscene');
        return;
      }
      if (key === 'factory') {
        this.intent = 'factory';
        this._mixTo('factory', this.current !== 'factory');
        return;
      }
      if (key === 'final') {
        this.intent = 'final';
        this._mixTo('final', this.current !== 'final');
        return;
      }
      if (key === 'race' || key === 'radio') {
        const alreadyOnAir = this.intent === 'radio' && !!this._radioDef(this.current);
        this.intent = 'radio';
        if (alreadyOnAir) this._mixTo(this.current, false);
        else this._startRadio(true);
        return;
      }
      this.intent = null;
      this._mixTo(null, false);
    }

    _mixTo(key, restart) {
      this.current = key;
      const silent = this.musicVol !== undefined && this.musicVol <= 0;
      for (const k of Object.keys(this.tracks)) {
        const t = this.tracks[k];
        const want = !silent && k === key;
        if (!t.ready || !t.gain) {
          if (!want && t.el) t.el.pause();
          continue;
        }
        const now = this.ctx.currentTime;
        t.gain.gain.cancelScheduledValues(now);
        t.gain.gain.setValueAtTime(t.gain.gain.value, now);
        const target = want ? (t.def.gain || 1) : 0;
        t.gain.gain.linearRampToValueAtTime(target, now + FADE);
        if (want) {
          t.stopToken++;
          if (restart) {
            try { t.el.currentTime = 0; } catch (e) { /* not seekable yet */ }
          }
          if (t.el.paused) t.el.play().catch(() => {});
        } else if (!t.el.paused) {
          // let the fade finish before the element stops
          const token = ++t.stopToken;
          global.setTimeout(() => {
            if (t.stopToken === token && this.current !== k && !t.el.paused) t.el.pause();
          }, FADE * 1000 + 60);
        }
      }
    }

    stopMusic() { this.playTrack(null); }

    play(key, gain, rate) {
      if (!this.ready || !this.buffers[key]) return false;
      const s = this.ctx.createBufferSource();
      s.buffer = this.buffers[key];
      s.playbackRate.value = rate || 1;
      const g = this.ctx.createGain();
      g.gain.value = gain === undefined ? 1 : gain;
      s.connect(g); g.connect(this.sfx);
      s.start();
      return true;
    }

    /* Everything the car makes, off, now.
       update() ramps these down over about a tenth of a second and is the
       right thing while something is still driving. Nothing is: the screen has
       changed, and a menu that inherits the engine note of the lap you just
       left is a bug you can hear. */
    silenceCar() {
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      /* EVERY loop the car owns, by the key it is actually registered under.
         This list used to say 'boost', and the reheat loop is registered as
         'boostLoop' - so the one sound that is loudest at the moment a race is
         left was the one sound this never touched. The wind bed is procedural
         rather than a decoded clip and lives outside `loops` entirely, so it
         has to be named too. */
      for (const k of ['engine', 'idle', 'open', 'screech', 'boostLoop']) {
        const l = this.loops[k];
        if (!l || !l.gain) continue;
        l.gain.gain.cancelScheduledValues(t);
        l.gain.gain.setValueAtTime(l.gain.gain.value, t);
        l.gain.gain.linearRampToValueAtTime(0, t + 0.06);
      }
      if (this.wind && this.wind.gain) {
        const g = this.wind.gain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0, t + 0.06);
      }
    }

    /* Step the RADIO back, without touching the car or the interface.
     *
     * `setDuck` pulls the driving bus down under a cutscene; this is the other
     * direction - the pause screen wants the song quieter and the menu blips
     * clear, and those live on two different buses. `amount` is how much to
     * remove: 0 is the music at full, 1 is the music gone.
     *
     * It multiplies whatever the Options slider set rather than replacing it,
     * so pausing at 25% music does not come back at 100%. */
    setMusicDuck(amount, seconds) {
      this.musicDuck = Math.max(0, Math.min(1, amount || 0));
      if (!this.ctx || !this.music) return;
      const base = 0.55 * (this.musicVol === undefined ? 1 : this.musicVol);
      const t = this.ctx.currentTime;
      const g = this.music.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(Math.max(0.0001, base * (1 - this.musicDuck)),
        t + (seconds === undefined ? 0.25 : seconds));
    }

    update(car, dt, active) {
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      /* THE ENGINE NOTE HAS TO WIND DOWN ON ITS OWN.
       *
       * `car.rpm` and `car.engineLoad` are produced by Vehicle.update, and a
       * cutscene does not run one - the story owns the frame instead. So both
       * FREEZE at whatever the last driven frame left them at, and if that
       * frame had the throttle buried, the note sits there wide open for the
       * length of the scene. That is the bug where holding the accelerator
       * into a cut left the engine roaring over the dialogue.
       *
       * The mixer therefore keeps its own copy and decays it whenever nothing
       * is driving, so a lifted throttle sounds like a lifted throttle whoever
       * is running the frame. */
      const step = Math.min(1, (dt || 0.016) * 2.6);
      if (active) {
        this.noteRpm = car.rpm;
        this.noteLoad = car.engineLoad;
      } else {
        this.noteRpm = (this.noteRpm === undefined ? car.rpm : this.noteRpm) * (1 - step);
        this.noteLoad = (this.noteLoad === undefined ? car.engineLoad : this.noteLoad) * (1 - step);
      }
      const rpm = this.noteRpm || 0;
      const load = this.noteLoad || 0;
      const pitch = MIN_PITCH + (MAX_PITCH - MIN_PITCH) * rpm;
      const moving = active && car.speed > 1.5;

      const eng = this.loops.engine;
      if (eng) {
        eng.src.playbackRate.setTargetAtTime(pitch, t, 0.05);
        eng.gain.gain.setTargetAtTime(
          active ? (0.18 + load * 0.42) * (moving ? 1 : 0.35) : 0, t, 0.08);
      }
      const idle = this.loops.idle;
      if (idle) {
        idle.src.playbackRate.setTargetAtTime(0.85 + rpm * 0.5, t, 0.08);
        idle.gain.gain.setTargetAtTime(active ? (moving ? 0.16 : 0.40) : 0.0, t, 0.1);
      }
      const open = this.loops.open;
      if (open) {
        open.src.playbackRate.setTargetAtTime(pitch, t, 0.05);
        open.gain.gain.setTargetAtTime(active ? load * 0.30 : 0, t, 0.08);
      }
      /* Tyres. A drift squeals; a barrier SCREAMS. They were the same sound at
         the same level, which is why braking felt like crashing - and why the
         thing the barrier does had nothing of its own. Stopping the car makes
         neither: driftAmount is the body slip angle and scrape only exists
         while there is a wall against the flank. */
      const scr = this.loops.screech;
      if (scr) {
        const squeal = Math.max((car.driftAmount || 0) * 0.42, (car.scrape || 0) * 0.85);
        scr.src.playbackRate.setTargetAtTime(
          0.82 + (car.scrape || 0) * 0.55, t, 0.08);
        scr.gain.gain.setTargetAtTime(active ? squeal : 0, t, 0.05);
      }
      const bl = this.loops.boostLoop;
      if (bl) {
        // gated on `active` like everything else: a cut that lands mid-boost
        // used to carry the reheat into the next scene, because `car.boosting`
        // stays true until a frame of physics clears it and a cutscene runs none
        bl.src.playbackRate.setTargetAtTime(car.boosting ? 1.12 : 1.0, t, .05);
        bl.gain.gain.setTargetAtTime(active && car.boosting ? 0.62 : 0, t, 0.055);
      }
      if (this.wind) {
        const mph = car.speedMph || 0;
        const q = Math.max(0, Math.min(1, (mph - 82) / 50));
        const high = Math.max(0, Math.min(1, (mph - 100) / 32));
        const boost = car.boosting ? 1 : 0;
        const gain = active ? q * .045 + high * .16 + boost * .13 : 0;
        this.wind.gain.gain.setTargetAtTime(gain, t, .09);
        this.wind.filter.frequency.setTargetAtTime(720 + q * 1200 + high * 1800 + boost * 950, t, .08);
        this.wind.filter.Q.setTargetAtTime(.38 + high * .24 + boost * .16, t, .10);
      }
    }

    /* Short procedural cues keep Chapter 7 readable without adding another
       decoded asset pack. They travel through the normal SFX bus, so mute and
       volume settings remain authoritative. */
    _toneSweep(f0, f1, seconds, gain, type, delay) {
      if (!this.ready || !this.ctx || !this.sfx) return false;
      const now = this.ctx.currentTime + (delay || 0);
      try {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type || 'sine';
        o.frequency.setValueAtTime(Math.max(20, f0), now);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + seconds);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + Math.min(.035, seconds * .2));
        g.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
        o.connect(g); g.connect(this.sfx); o.start(now); o.stop(now + seconds + .02);
        return true;
      } catch (e) { return false; }
    }

    predatorScan(intensity) {
      const q = Math.max(.2, Math.min(1, intensity === undefined ? 1 : intensity));
      this._toneSweep(310, 1240, .34, .10 * q, 'sawtooth');
      this._toneSweep(930, 210, .46, .065 * q, 'sine', .12);
      this.play('counter', .24 * q, .82 + q * .18);
    }

    hazardCue(kind, intensity) {
      const q = Math.max(.2, Math.min(1, intensity === undefined ? 1 : intensity));
      const k = String(kind || 'warning');
      if (/metal_ball/.test(k)) {
        this._toneSweep(115, 42, .62, .16 * q, 'square');
        this._toneSweep(680, 180, .22, .07 * q, 'sawtooth', .08);
      } else if (/oil/.test(k)) {
        this._toneSweep(430, 860, .38, .065 * q, 'triangle');
        this._toneSweep(720, 290, .44, .045 * q, 'sine', .07);
      } else if (/spike/.test(k)) {
        for (let i = 0; i < 3; i++) this._toneSweep(1320 - i * 180, 480, .10, .055 * q, 'square', i * .075);
      } else if (/barrier|failure/.test(k)) {
        this._toneSweep(180, 48, .48, .14 * q, 'sawtooth');
        this.play('crash2', .20 * q, .72);
      } else if (/false_route/.test(k)) {
        this._toneSweep(520, 260, .30, .075 * q, 'square');
        this._toneSweep(554, 277, .30, .060 * q, 'sawtooth', .04);
      } else if (/sky_panel/.test(k)) {
        this._toneSweep(240, 980, .42, .075 * q, 'sawtooth');
        this._toneSweep(90, 62, .55, .10 * q, 'triangle', .08);
      } else if (/prediction/.test(k)) {
        this.predatorScan(q);
      } else {
        this._toneSweep(380, 760, .22, .06 * q, 'square');
      }
    }

    coin() { this.play('rollover', 0.8); }
    countBeep() { this.play('counter', 0.9); }
    goBeep() { this.play('boost', 0.8); }
    crash(force) {
      const f = force === undefined ? 1 : Math.max(0.2, Math.min(1, force));
      // a heavier hit picks a lower pitch as well as a louder one
      this.play('crash' + Math.floor(Math.random() * 5), 0.35 + f * 0.6,
        1.18 - f * 0.3);
    }
    checkpoint() { this.play('whoosh', 0.8); }
    boostHit() { this.play('boost', 0.9); }
    select() { this.play('select', 0.8); }
    uiMove() { this.play('rollover', 0.55); }
  }

  global.NR.Audio = Audio;
})(window);
