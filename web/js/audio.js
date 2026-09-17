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
    /* COMING BACK DOWN OFF A JUMP. Three takes of the same car so a
       jump-heavy route does not play one sample a dozen times - see
       tools/mksfx.py, which generates them. */
    land0: 'carland0.ogg',
    land1: 'carland1.ogg',
    land2: 'carland2.ogg',
  };
  const LOOPS = {
    engine: 'engine.ogg',
    open: 'open.ogg',
    idle: 'Cyber Engine Loop.ogg',
    screech: 'tirescreech.ogg',
    boostLoop: 'boostloop.ogg',
  };

  /* THE SOUNDTRACK, AND WHAT EACH PIECE OF IT IS CALLED.
   *
   * Every title below was chosen from the RECORDING rather than from the
   * filename, because the filenames were somebody's shorthand and two of them
   * were not true. Each track was measured - key by chroma against the
   * Krumhansl-Kessler profiles, tempo by autocorrelating a spectral-flux onset
   * envelope under a log-normal prior, brightness by spectral centroid, and
   * how alike its first and last six seconds are - and the notes beside each
   * one are those numbers, so a title can be argued with rather than believed.
   *
   * The title keeps its own looping theme. On the road, FIVE full-length songs
   * form an environment-aware radio: each environment has a primary song and
   * at least one compatible alternate, so a long route can continue without
   * immediately repeating the track that just finished.
   *
   * `station` and `freq` are what the tuner in the HUD reads off. A fixed
   * score has no frequency because it is not on the air - it is the building
   * you are driving through - and the readout says so rather than inventing a
   * number for it. See Hud.radio.
   */
  const MENU_TRACK = {
    key: 'menu', file: 'theme.ogg', gain: 1.0, loop: true,
    /* A minor, 98 BPM, centroid 3536 Hz - by a wide margin the brightest thing
       in the pack, with half its energy above 2.5 kHz. It is the opening and
       it sounds like one. */
    title: 'NEON OVERTURE', station: 'SYNX GRID',
  };
  const CUTSCENE_TRACK = {
    key: 'cutscene', file: 'cutscene.ogg', gain: 1.0, loop: true,
    /* D major, 145 BPM, the second-widest image in the pack and the only music
       here that never returns to where it started - 0.22 against the radio's
       0.4 to 0.8. It is written to be talked over and then stop. */
    title: 'BETWEEN LIGHTS', station: 'SYNX GRID',
  };
  const FACTORY_TRACK = {
    key: 'factory', file: 'factory.ogg', gain: 1.0, loop: true,
    /* A minor at 174 BPM - a machine tempo, double-time over an 87 BPM pulse -
       and the widest stereo image of anything in the game. Chapter 6 is a
       production hall and this is the hall running. */
    title: 'FORGE CYCLE', station: 'AURORA FORGE',
  };
  const FINAL_TRACK = {
    key: 'final', file: 'final.ogg', gain: 1.0, loop: true,
    /* A minor, 97 BPM, and the NARROWEST image in the pack at 0.36 with the
       most weight in the mids: music mixed to sit in front of you rather than
       around you. Chapter 7's event is called HUNT//REDLINE. */
    title: 'REDLINE', station: 'NEON HORIZON',
  };
  const RADIO_TRACKS = [
    {
      key: 'coastline_drive', file: 'radio/coastline_drive.ogg', gain: 1.25,
      primary: 'coast', environments: ['coast', 'mesa'],
      /* D major, 97 BPM, and it builds - the first thirty seconds sit at half
         the level of the rest. A major-key cruise, which is what VECTOR RUN
         is. It also loops well (0.82), the best of the four originals. */
      title: 'COASTLINE DRIVE', station: 'SYNX FM', freq: 90.1,
    },
    {
      key: 'canyon_velocity', file: 'radio/canyon_velocity.ogg', gain: 1.25,
      primary: 'canyon', environments: ['canyon', 'city'],
      /* A minor at 148 BPM: the fastest thing in the pack by fifty beats, and
         the only radio track in a minor key. THE SPINE is the fast route. */
      title: 'CANYON VELOCITY', station: 'SYNX FM', freq: 94.5,
    },
    {
      key: 'electric_horizon', file: 'radio/electric_horizon.ogg', gain: 1.25,
      primary: 'mesa', environments: ['mesa', 'coast'],
      /* C major, 97 BPM, centroid 2646 Hz and 19% of its energy above 6 kHz -
         the airiest of the five, which is the open country of MIRAGE CIRCUIT. */
      title: 'ELECTRIC HORIZON', station: 'SYNX FM', freq: 101.7,
    },
    {
      key: 'midnight_circuit', file: 'radio/midnight_circuit.ogg', gain: 1.25,
      primary: 'city', environments: ['city', 'canyon'],
      /* F major, 92 BPM - the slowest radio track - and the most dynamic thing
         in the pack at 17.5 dB of crest. It has room in it, which is what a
         city at night has. */
      title: 'MIDNIGHT CIRCUIT', station: 'SYNX FM', freq: 104.3,
    },
    {
      key: 'neon_pursuit', file: 'radio/neon_pursuit.ogg', gain: 1.05,
      primary: 'city', environments: ['city', 'canyon'],
      /* THE NEW ONE, and it is filed here on two measurements rather than on
         its name - which is two words like every other station's, because the
         dial is a lineup and one entry twice as long as the rest reads as a
         mistake. It is in F major, which is MIDNIGHT CIRCUIT's key, and at 97
         BPM, which is the tempo the coast and the mesa share - so it belongs
         to the night family and still mixes with everything else on the dial.
         It carries more bass than any other track here (21% below 150 Hz) and
         it is the best loop in the pack at 0.84, which matters: a Free Roam
         tour is a hundred and twenty-seven kilometres and can outlast the
         playlist.

         Its fader sits lower than the rest because its MASTER is hotter: -16.1
         dBFS RMS against the other four's -17.8 average. 1.25 down to 1.05 is
         1.5 dB back, which is most of that 1.7 - the remaining fifth of a
         decibel is inside the spread the four originals already have between
         them, and a station that is audibly louder than the one before it is
         the one thing a radio must not be. */
      title: 'NEON PURSUIT', station: 'SYNX FM', freq: 107.9,
    },
  ];
  const MUSIC_TRACKS = [MENU_TRACK, CUTSCENE_TRACK, FACTORY_TRACK, FINAL_TRACK].concat(RADIO_TRACKS);
  /* By key, for the one question the interface asks: what is this? */
  const TRACK_BY_KEY = {};
  for (const t of MUSIC_TRACKS) TRACK_BY_KEY[t.key] = t;
  /* Where the needle can sit, low to high, so the tuner has a scale even
     before a station is chosen. Derived from the table rather than written
     down twice. */
  const BAND = RADIO_TRACKS.map((t) => t.freq).sort((a, b) => a - b);
  const ENVIRONMENTS = new Set(['coast', 'canyon', 'mesa', 'city']);
  const FADE = 1.6;              // seconds; long enough to sound intentional
  /* ...AND A SHORTER ONE FOR A CUE.
   *
   * A cross-fade and a cue are two different events and they were the same
   * number. A cross-fade happens in the middle of a drive when the scenery
   * changes family, and 1.6 seconds is right for it: nobody should be able to
   * say where one song ended. A CUE is the title theme arriving on the frame
   * the veil lifts and the opening shot starts moving - and fading that in
   * over a second and a half means the first bar and a half of the track, the
   * part written to be the beginning, happens under a fader on its way up.
   *
   * The whole point of holding the music back through the cold open and the
   * safety notice - see onMusic in js/game.js - is that it lands WITH the
   * picture. It cannot land if it is still arriving when the shot is over. */
  const CUE_FADE = 0.42;

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

      /* A TAP ON THE MUSIC, so the radio panel shows the song rather than an
         animation of one.
       *
       * It hangs off `music` as a DEAD END: an AnalyserNode with nothing
       * connected to its output still analyses everything that reaches it, so
       * this costs one extra FFT a frame and cannot put a second copy of the
       * music into the mix. Connecting it onward to `master` is the mistake
       * that would, and it would be inaudible as anything but +6 dB.
       *
       * 256 points is 128 bins at 172 Hz each, which is enough to tell a kick
       * from a hi-hat and far less than enough to read a note - which is the
       * right resolution for something eleven bars wide. The smoothing is the
       * node's own one-pole, set high enough that the bars move with the music
       * instead of flickering at the frame rate. */
      try {
        this.scope = ctx.createAnalyser();
        this.scope.fftSize = 256;
        this.scope.smoothingTimeConstant = 0.74;
        this.scope.minDecibels = -78;
        this.scope.maxDecibels = -14;
        this.music.connect(this.scope);
        this.scopeBins = new Uint8Array(this.scope.frequencyBinCount);
      } catch (e) { this.scope = null; }

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
        /* `pending` is a mix that was asked for before this element could
           serve it; see the canplay handler below for why it has to survive. */
        const entry = { el, gain: null, ready: false, broken: false, def, stopToken: 0, pending: null };
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
            /* THE INTENT THAT ARRIVED BEFORE THE ELEMENT DID.
             *
             * This is the music-sync bug, and it is a one-word one: the
             * replay used to be `_mixTo(def.key, false)`, so a track that was
             * asked to START FROM THE TOP while it was still buffering came
             * back as a track asked to carry on from wherever it was.
             *
             * It matters because of exactly when it happens. The title theme
             * is deliberately held through the cold open and the
             * photosensitivity notice and then cued on the frame the veil
             * lifts - and on a cold cache that frame is very often before
             * `canplay`. So the one moment in the game where the music is
             * supposed to hit a picture was the one moment the restart was
             * dropped, and the theme came in late, from the middle, under a
             * one-and-a-half-second fade.
             *
             * The request is remembered instead and replayed in full. */
            if (this.current === def.key) {
              const want = entry.pending;
              entry.pending = null;
              this._mixTo(def.key, want ? !!want.restart : false, want ? want.fade : undefined);
            } else {
              entry.pending = null;
            }
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

    /* WHAT IS ON, for anything that has to show it.
     *
     * One object, built fresh, with everything the interface could want and no
     * way for it to reach into the mixer and find out some other way. `live`
     * is the distinction that matters: a radio track is a station with a
     * frequency, and a chapter's fixed score is the building you are inside.
     *
     * Returns null when there is nothing to say - music turned off in the
     * options, or a track that failed to load - because a radio panel with
     * nothing in it is worse than no radio panel. */
    nowPlaying() {
      if (!this.ready || !this.current) return null;
      if (this.musicVol !== undefined && this.musicVol <= 0) return null;
      const def = TRACK_BY_KEY[this.current];
      if (!def) return null;
      const t = this.tracks[this.current];
      if (!t || t.broken) return null;
      const el = t.el;
      const dur = el && isFinite(el.duration) ? el.duration : 0;
      return {
        key: def.key,
        title: def.title || def.key,
        station: def.station || 'SYNX FM',
        freq: def.freq || 0,
        onAir: !!def.freq,
        band: BAND,
        environment: this.environment,
        time: el ? (el.currentTime || 0) : 0,
        duration: dur,
        progress: dur > 0 ? Math.min(1, (el.currentTime || 0) / dur) : 0,
        playing: !!(el && !el.paused),
      };
    }

    /* The music's own spectrum, folded into `out.length` bars.
     *
     * Log-spaced, because an octave is a ratio: linear bins would give eleven
     * bars of which nine are cymbals. Each bar is the loudest bin in its
     * range rather than the average - a peak reads as an event and an average
     * reads as a level, and this is meant to look like the song. */
    musicLevels(out) {
      const n = out.length;
      if (!this.scope || !this.scopeBins) {
        for (let i = 0; i < n; i++) out[i] = 0;
        return false;
      }
      this.scope.getByteFrequencyData(this.scopeBins);
      const bins = this.scopeBins;
      /* Bins above about 12 kHz hold almost nothing on a 128 kbps Vorbis file
         - the encoder has thrown them away - so the scale stops short of the
         top rather than ending in two dead bars. */
      const top = Math.min(bins.length, 72);
      /* WALKED, NOT COMPUTED TWICE.
       *
       * The obvious form takes each band's start and end from the same power
       * curve independently, and at eleven bands over seventy-two bins that
       * gives the first two bands the SAME bin and never reads bin 0 at all -
       * so the meter had a duplicated bar at one end and no kick drum at the
       * other. Found by feeding a 220 Hz tone into the music bus and watching
       * which bars moved.
       *
       * Carrying the previous band's end forward and forcing at least one bin
       * of width makes the bands contiguous, distinct and complete by
       * construction, whatever the band count is. */
      let a = 0;
      for (let i = 0; i < n; i++) {
        const b = Math.max(a + 1, Math.round(Math.pow(top, (i + 1) / n)));
        let peak = 0;
        for (let k = a; k < b && k < bins.length; k++) if (bins[k] > peak) peak = bins[k];
        out[i] = peak / 255;
        a = b;
      }
      return true;
    }

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
     *
     * `opts.cue` marks a track that is being STARTED TO A PICTURE rather than
     * merely selected: it restarts from the top whether or not it is already
     * the current track, and it arrives on the short fade instead of the
     * cross-fade. The title theme landing on the frame the opening shot begins
     * is the only caller, and it is the only one that should be - everything
     * else is a transition between two pieces of music, where being unable to
     * hear the join is the whole point. See startIntro in js/game.js.
     */
    playTrack(key, opts) {
      const cue = !!(opts && opts.cue);
      const fade = cue ? CUE_FADE : (opts && opts.fade);
      if (key === 'menu') {
        this.intent = 'menu';
        this._mixTo('menu', cue || this.current !== 'menu', fade);
        return;
      }
      if (key === 'cutscene') {
        this.intent = 'cutscene';
        this._mixTo('cutscene', cue || this.current !== 'cutscene', fade);
        return;
      }
      if (key === 'factory') {
        this.intent = 'factory';
        this._mixTo('factory', cue || this.current !== 'factory', fade);
        return;
      }
      if (key === 'final') {
        this.intent = 'final';
        this._mixTo('final', cue || this.current !== 'final', fade);
        return;
      }
      if (key === 'race' || key === 'radio') {
        const alreadyOnAir = this.intent === 'radio' && !!this._radioDef(this.current);
        this.intent = 'radio';
        if (alreadyOnAir && !cue) this._mixTo(this.current, false, fade);
        else this._startRadio(true);
        return;
      }
      this.intent = null;
      this._mixTo(null, false, fade);
    }

    /* Can this track start on the frame it is asked to?
     *
     * A media element is not playable until it has buffered, and the title
     * theme is cued at an exact moment - the frame the veil lifts. Asked
     * before that, so the opening can wait a beat rather than start a shot the
     * music then arrives late over. See js/intro.js.
     *
     * A track that has FAILED reports ready, deliberately: there is nothing to
     * wait for, and a caller that waits for a file which is never coming has
     * turned a missing song into a hang. */
    trackReady(key) {
      const t = this.tracks && this.tracks[key];
      if (!t) return false;
      return !!(t.ready || t.broken);
    }

    /** True when there is no music at all, so nothing can be waited for. */
    get muted() {
      return !this.ready || (this.musicVol !== undefined && this.musicVol <= 0);
    }

    _mixTo(key, restart, fade) {
      this.current = key;
      const silent = this.musicVol !== undefined && this.musicVol <= 0;
      const span = fade === undefined ? FADE : Math.max(0.02, fade);
      for (const k of Object.keys(this.tracks)) {
        const t = this.tracks[k];
        const want = !silent && k === key;
        if (!t.ready || !t.gain) {
          /* Not ready to be mixed yet. Remember what was asked for rather than
             dropping it - the canplay handler replays this, restart and all. */
          if (want) t.pending = { restart: !!restart, fade };
          else { t.pending = null; if (t.el) t.el.pause(); }
          continue;
        }
        const now = this.ctx.currentTime;
        t.gain.gain.cancelScheduledValues(now);
        t.gain.gain.setValueAtTime(t.gain.gain.value, now);
        const target = want ? (t.def.gain || 1) : 0;
        t.gain.gain.linearRampToValueAtTime(target, now + span);
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
          }, span * 1000 + 60);
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
    /* A LANDING, AND HOW HARD IT WAS.
     *
     * `drop` is how far the car fell, in units, and `quality` is the
     * solver's own measure of how square it came down - the same number
     * the boost award and the replay mark read, so the sound agrees with
     * what the rest of the game thought of the landing rather than having
     * a second opinion.
     *
     * A big drop is louder and pitched DOWN, because a heavier arrival
     * loads the springs further and everything about it gets lower. A
     * scruffy one is pitched up a little and gets more of the sample's
     * scrub, which is the tyres fighting for grip: landing sideways is
     * supposed to sound worse than landing straight.
     */
    land(drop, quality) {
      const d = Math.max(0, Math.min(1, (drop === undefined ? 1 : drop) / 6));
      const q = Math.max(0, Math.min(1, quality === undefined ? 1 : quality));
      const take = Math.floor(Math.random() * 3);
      this.play('land' + take, 0.30 + d * 0.62, 1.10 - d * 0.22 + (1 - q) * 0.06);
    }
    checkpoint() { this.play('whoosh', 0.8); }
    boostHit() { this.play('boost', 0.9); }
    select() { this.play('select', 0.8); }
    uiMove() { this.play('rollover', 0.55); }
  }

  global.NR.Audio = Audio;
  /* THE SOUNDTRACK TABLE, PUBLISHED.
   *
   * Nothing in the game reads this - the interface asks `nowPlaying()`, which
   * is the right question - but four things about the table go wrong silently
   * and none of them is visible in a screenshot: a file that is not in the
   * pack (the station simply never plays), two stations on one frequency, a
   * frequency outside the dial the HUD draws, and an environment left with one
   * usable song, which makes the no-immediate-repeat rule unsatisfiable.
   *
   * So it is exported for `python tools/check.py radio` to read, the same way
   * the chapter directors publish their worlds. A checker that carried its own
   * copy of this would pass while the real one was wrong. */
  global.NR.MUSIC_TRACKS = MUSIC_TRACKS;
})(window);
