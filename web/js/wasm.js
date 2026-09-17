/* SYNX - the bridge to the Rust simulation core.
 *
 * Everything that costs real CPU now runs in WebAssembly: course generation,
 * the world's mesh, the four-wheel solver, the rival's racing line and driver,
 * and the particle systems. This file is the seam, and it has exactly one job -
 * to make that invisible to the rest of the game.
 *
 * So `NR.Track`, `NR.Vehicle`, `NR.Driver`, `NR.buildCourse` and
 * `NR.collideCars` are all still here, with the same names, the same shapes
 * and the same fields they had when they were JavaScript. `car.x` still reads
 * a number, `car.boost = 1` still sets one, and `js/level7.js` never learns
 * that the car it is nudging lives in linear memory.
 *
 * HOW THE FIELDS WORK
 * -------------------
 * Each car owns a fixed block of f64 in the module's memory. The proxy below
 * defines a getter and a setter per field straight onto its prototype, so
 * reading `car.sTrack` is one typed-array index rather than a call into WASM.
 * The field list is not written here: it is read out of the module at startup
 * (`synx_veh_layout`), so the two languages cannot drift apart.
 *
 * DETACHING VIEWS
 * ---------------
 * Growing WebAssembly memory detaches every existing typed-array view over it.
 * Two rules keep that from becoming a class of impossible bug:
 *
 *   1. The centreline is COPIED into ordinary typed arrays. js/scene.js holds
 *      a reference to it across the whole of world generation and reads it
 *      millions of times; a copy costs about a megabyte and one millisecond,
 *      and it makes those reads immune to anything the allocator does. It is
 *      also the faster of the two, because the reads need no revalidation.
 *   2. Everything else re-derives its view through `M()`, which rebuilds the
 *      whole set the moment `memory.buffer` changes identity.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};

  /** The ABI this file was written against. The module refuses to load if the
      .wasm disagrees, which turns "a stale build" from a mystery into a line
      of text. */
  const WANT_ABI = 18;

  let wasm = null;      // the instance's exports
  let buffer = null;    // the ArrayBuffer the current views were made over
  let F64 = null, F32 = null, U8 = null, U32 = null;

  /** Re-derive the views if the module has grown its memory under us. */
  function M() {
    if (wasm && wasm.memory.buffer !== buffer) {
      buffer = wasm.memory.buffer;
      F64 = new Float64Array(buffer);
      F32 = new Float32Array(buffer);
      U8 = new Uint8Array(buffer);
      U32 = new Uint32Array(buffer);
    }
    return wasm;
  }

  /** Read a NUL-separated, double-NUL-terminated string table. */
  function readTable(ptr) {
    M();
    const out = [];
    let s = ptr;
    for (;;) {
      let e = s;
      while (U8[e] !== 0) e++;
      if (e === s) break;               // empty entry ends the table
      let t = '';
      for (let i = s; i < e; i++) t += String.fromCharCode(U8[i]);
      out.push(t);
      s = e + 1;
    }
    return out;
  }

  // ------------------------------------------------------------- loading --

  let FIELDS = null;      // name -> index into a car's block
  let STRIDE = 0;
  let statePtr = 0;

  /**
   * Instantiate the core. Resolves once every wrapper below is usable.
   *
   * The .wasm is fetched rather than embedded as base64: inside the desktop
   * host it comes off Tauri's own protocol, which is a real origin, so
   * `instantiateStreaming` gets to compile it while it downloads.
   */
  NR.loadCore = function loadCore(url) {
    url = url || 'wasm/synx_core.wasm';
    const boot = (result) => {
      wasm = result.instance.exports;
      M();
      const got = wasm.synx_abi_version();
      if (got !== WANT_ABI) {
        throw new Error('synx_core.wasm is ABI v' + got + ', this build expects v' +
          WANT_ABI + '. Rebuild it: cargo build -p synx-core --release --target wasm32-unknown-unknown');
      }
      STRIDE = wasm.synx_veh_stride();
      const names = readTable(wasm.synx_veh_layout());
      FIELDS = Object.create(null);
      for (let i = 0; i < names.length; i++) FIELDS[names[i]] = i;
      if (names.length !== STRIDE) {
        throw new Error('vehicle layout is ' + names.length + ' names for a stride of ' + STRIDE);
      }
      defineVehicleFields(names);
      readLevels();
      readOverpasses();
      readAirConstants();
      NR.coreReady = true;
      return NR;
    };

    if (typeof WebAssembly.instantiateStreaming === 'function') {
      return WebAssembly.instantiateStreaming(fetch(url), {})
        .then(boot)
        .catch(() => fetch(url).then(r => r.arrayBuffer())
          .then(b => WebAssembly.instantiate(b, {})).then(boot));
    }
    return fetch(url).then(r => r.arrayBuffer())
      .then(b => WebAssembly.instantiate(b, {})).then(boot);
  };

  /* The difficulty ladder, read out of the core so the numbers live in exactly
     one place. Chapter 7 clones an entry and moves it; nothing else writes. */
  const LEVEL_NAMES = ['EASY', 'MEDIUM', 'HARD', 'IMPOSSIBLE'];
  const LEVEL_FIELDS = ['skill', 'assist', 'target', 'grip', 'react',
    'boostSkill', 'driftSkill', 'mistakes'];

  function readLevels() {
    const p = M().synx_levels() >> 3;
    NR.AI_LEVELS = {};
    for (let l = 0; l < LEVEL_NAMES.length; l++) {
      const o = { label: LEVEL_NAMES[l] };
      for (let f = 0; f < LEVEL_FIELDS.length; f++) {
        o[LEVEL_FIELDS[f]] = F64[p + l * LEVEL_FIELDS.length + f];
      }
      NR.AI_LEVELS[LEVEL_NAMES[l]] = o;
    }
  }

  /* THE BORE BYPASSES.
   *
   * Read from the core rather than declared here, because they are not
   * constants about the road the way its width is - they are the road. The
   * deck is the centreline's own elevation (see `OVERPASSES` in track.rs) and
   * three separate consumers have to agree with it exactly: js/scene.js builds
   * the structure under it and seals the bore, js/game.js keeps the tunnel's
   * fog off a car that is on the roof rather than inside, and the physics
   * simply drives it. Four arc lengths copied into JavaScript would be four
   * arc lengths that drift the first time one of them moves.
   *
   * Each entry is { from, deck0, deck1, to, h, bore0, bore1 }.
   */
  function readOverpasses() {
    const w = M();
    NR.OVERPASSES = [];
    if (!w.synx_overpass_count) return;
    const n = w.synx_overpass_count() | 0;
    if (!n) return;
    const stride = w.synx_overpass_stride() | 0;
    const p = w.synx_overpasses() >> 3;
    for (let i = 0; i < n; i++) {
      const o = p + i * stride;
      NR.OVERPASSES.push({
        from: F64[o], deck0: F64[o + 1], deck1: F64[o + 2], to: F64[o + 3],
        h: F64[o + 4], bore0: F64[o + 5], bore1: F64[o + 6],
      });
    }
  }

  /* WHAT A CAR IN THE AIR DOES.
     Read from the core for the same reason the bypasses are: the attract drive
     behind the menus is kinematic - it never touches the solver - and it has
     to put a car through the SAME arc the game does, or the title screen is
     showing something that only looks like this game. */
  function readAirConstants() {
    const w = M();
    NR.AIR = { g: 27, drag: 0.055, pitchAcc: 0.85, pitchMax: 0.85, landTol: 0.21 };
    if (!w.synx_air_constants) return;
    const p = w.synx_air_constants() >> 3;
    NR.AIR = {
      g: F64[p], drag: F64[p + 1], pitchAcc: F64[p + 2],
      pitchMax: F64[p + 3], landTol: F64[p + 4],
    };
  }

  /** The deck height at `s`, or 0 away from every bypass. Matches
   *  `overpass_height` in track.rs, including its smoothstep ends. */
  NR.overpassHeight = function (s) {
    const list = NR.OVERPASSES;
    if (!list || !list.length) return 0;
    let y = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (s <= o.from || s >= o.to) continue;
      if (s < o.deck0) { const t = (s - o.from) / (o.deck0 - o.from); y += t * t * (3 - 2 * t) * o.h; }
      else if (s <= o.deck1) y += o.h;
      else { const t = (s - o.deck1) / (o.to - o.deck1); y += (1 - t * t * (3 - 2 * t)) * o.h; }
    }
    return y;
  };

  /** True while the road is carried OVER a sealed bore rather than through it. */
  NR.onOverpass = function (s) {
    const list = NR.OVERPASSES;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      if (s > list[i].from && s < list[i].to) return true;
    }
    return false;
  };

  /** Copy a block of f64 out of the module into an ordinary array. */
  function copyF64(ptr, n) {
    M();
    return F64.slice(ptr >> 3, (ptr >> 3) + n);
  }

  // --------------------------------------------------------------- track --

  /* The course, and the two queries the whole game asks of it.
     `C` is a plain object of ordinary typed arrays - see the note at the top
     about why it is copied rather than mapped. */
  class Track {
    constructor(centre) {
      this.C = centre;
      this.length = centre.length;
      this.step = centre.step;
      this.count = centre.count;
      this._halfWidth = NR.DRIVE_HALF;
      this._outerHalf = NR.ROAD_HALF;
      this.shippedCount = centre.shippedCount || centre.count;
      this.setWidth(this._halfWidth, this._outerHalf);
    }

    /* The corridor is a property of the ROUTE, not of the course: Chapter 7's
       elevated deck is sixty-four units across where the rest of the road is
       forty. Game.applyLevel assigns these directly, so they are accessors -
       the collision resolver and the rival's racing line both read them from
       the core, and a width that only reached this wrapper would leave the
       finale's barriers in the wrong place. */
    setWidth(driveHalf, roadHalf) {
      this._halfWidth = driveHalf;
      this._outerHalf = roadHalf;
      M().synx_track_set_width(driveHalf, roadHalf);
    }
    get halfWidth() { return this._halfWidth; }
    set halfWidth(v) { this.setWidth(v, this._outerHalf); }
    get outerHalf() { return this._outerHalf; }
    set outerHalf(v) { this.setWidth(this._halfWidth, v); }

    /** Interpolated point + heading at arc length s. */
    at(s, out) {
      out = out || {};
      const p = M().synx_track_at(s) >> 3;
      out.x = F64[p]; out.y = F64[p + 1]; out.z = F64[p + 2];
      out.yaw = F64[p + 3]; out.curv = F64[p + 4]; out.tunnel = F64[p + 5] !== 0;
      return out;
    }

    /* Nearest centreline point, searched around `hint`.
     *
     * `out` is where the answer goes, the same way `at` takes one: this is
     * called per car per frame by the chapter collision resolver and again
     * inside its own hit loop, and a fresh six-field object for each of them
     * is litter for a struct that is read and dropped on the next line.
     *
     * It defaults to a scratch owned by the track, which is right for a
     * caller that reads the result immediately. A caller that holds one
     * ACROSS another project - or that projects twice and wants both - passes
     * its own, and the two then cannot alias however the reads are later
     * moved about. */
    project(x, z, hint, out) {
      const p = M().synx_track_project(x, z, hint) >> 3;
      const o = out || this._proj || (this._proj = {
        s: 0, sExact: 0, lateral: 0, index: 0, yaw: 0, curv: 0,
      });
      o.s = F64[p]; o.sExact = F64[p + 1]; o.lateral = F64[p + 2];
      o.index = F64[p + 3] | 0; o.yaw = F64[p + 4]; o.curv = F64[p + 5];
      return o;
    }
  }

  /**
   * Carry the shipped centreline on to a full course.
   *
   * The shipped samples arrive as ordinary JS arrays out of scene.json, so
   * they are marshalled into the module's memory once, here, and the finished
   * course is copied back out into typed arrays the renderer can index
   * directly.
   */
  function buildCourse(C, opts) {
    const w = M();
    if (!w) throw new Error('the simulation core is not loaded');
    const want = (opts && opts.length) || NR.COURSE_LENGTH;
    const n = C.count;
    const bytes = n * 8;

    // one scratch block, six arrays laid end to end
    const base = w.synx_alloc(bytes * 6);
    M();
    const put = (arr, slot) => {
      const off = (base + slot * bytes) >> 3;
      for (let i = 0; i < n; i++) F64[off + i] = arr ? arr[i] : 0;
    };
    put(C.x, 0); put(C.y, 1); put(C.z, 2); put(C.yaw, 3); put(C.curv, 4); put(C.tunnel, 5);

    const count = w.synx_track_build(
      base, base + bytes, base + bytes * 2, base + bytes * 3,
      base + bytes * 4, base + bytes * 5, n, C.step, want);
    w.synx_free(base);
    M();

    const out = {
      x: copyF64(w.synx_track_x(), count),
      y: copyF64(w.synx_track_y(), count),
      z: copyF64(w.synx_track_z(), count),
      yaw: copyF64(w.synx_track_yaw(), count),
      curv: copyF64(w.synx_track_curv(), count),
      tunnel: U8.slice(w.synx_track_tunnel(), w.synx_track_tunnel() + count),
      step: C.step,
      count,
      length: w.synx_track_length(),
      shippedCount: w.synx_track_shipped(),
    };
    return out;
  }

  // ------------------------------------------------------------- vehicle --

  /* A car, as the rest of the game still sees it.

     Every field named in the module's layout becomes a property on the
     prototype, backed by one slot of the car's block. The three fields that
     are logically booleans or strings in JavaScript - `boosting`, `offroad`,
     `lastHitType` and friends - are given accessors that convert, so a
     director can still write `car.lastHit = false` and read
     `car.lastHitType === 'wall'`. */
  const BOOL_FIELDS = new Set([
    'boosting', 'boostLocked', 'drifting', 'offroad', 'counterSteering', 'lastHit',
  ]);
  const HIT_NAMES = [null, 'wall', 'car'];

  class Vehicle {
    constructor(track) {
      this.track = track;
      this._id = M().synx_veh_create(0);
      M();
      statePtr = wasm.synx_veh_state();
      this._basePtr = statePtr;
      this._base = (statePtr >> 3) + this._id * STRIDE;
      // the four wheels, as the objects fx.js and hud.js already read
      this.w = [0, 1, 2, 3].map(i => new Wheel(this, i));
    }

    /** The car's block, re-derived whenever it could have moved.
     *
     * TWO things can move it, and for a long time this only guarded against
     * one of them.
     *
     * WebAssembly memory growing replaces `memory.buffer`, which is what the
     * identity check below catches. But the state table is a `Vec`, and a Vec
     * that grows REALLOCATES - it moves to a different address inside the same
     * linear memory, leaving `memory.buffer` untouched. Chapter 4 spawning
     * Nova and Kael did exactly that, and the player's and Ryker's proxies
     * went on reading the address the table used to be at: both reported the
     * correct arc length and a position of exactly (0, 0, 0), stacked on the
     * origin while the pack drove the course.
     *
     * The table is now allocated once at its full size and never moves (see
     * MAX_CARS in abi.rs), so the base is stable. `statePtr` is checked as
     * well, because a guarantee that is only asserted in the other language is
     * one that can quietly stop being true. */
    get _s() {
      if (wasm.memory.buffer !== buffer) {
        M();
        statePtr = wasm.synx_veh_state();
        this._base = (statePtr >> 3) + this._id * STRIDE;
      } else if (this._basePtr !== statePtr) {
        this._basePtr = statePtr;
        this._base = (statePtr >> 3) + this._id * STRIDE;
      }
      return F64;
    }

    reset(s, lateral) {
      M().synx_veh_reset(this._id, s || 0, lateral || 0);
      M();
      return this;
    }

    /* Which engine is in the car: 'swap' is the Forge rebuild, 'broken' is
       the wreck Chapter 6 opens on, anything else is the street block. The
       numbers match the ENGINE_ constants in crates/synx-core/src/vehicle.rs. */
    fitEngine(kind) {
      const k = kind === 'swap' ? 1 : (kind === 'broken' ? 2 : 0);
      M().synx_veh_fit_engine(this._id, k);
      return this;
    }

    /* Arm the next launch ramp, or clear it with no arguments.

       The solver holds ONE at a time on purpose - see synx_veh_arm_ramp - so a
       director arms each one as the car comes up on it. The height is the lip
       above the road; the two arc lengths are where the incline starts and
       where it ends. */
    armRamp(s0, s1, h) {
      M().synx_veh_arm_ramp(this._id, s0 || 0, s1 || 0, h || 0);
      return this;
    }

    /* ...and one with a CREST to drive along before it runs out.
       `s1` is where the climb levels off, `s2` where the structure ends and
       `lip` the height there. A wedge launches you; a thing you get OVER has a
       top, and the bypass at MIRAGE CIRCUIT's blocked bore is the second kind.
       See the note above `Ramp` in crates/synx-core/src/vehicle.rs. */
    armRampDeck(s0, s1, s2, h, lip) {
      M().synx_veh_arm_ramp_deck(this._id, s0 || 0, s1 || 0, s2 || 0, h || 0, lip || 0);
      return this;
    }
    /* ...and one that comes back DOWN, which is a different thing again.
       A wedge launches you and a crest gets you over something; this climbs to
       a deck, runs along it and then puts the car back on the road at the far
       end under its own wheels. Aurora Forge's broken roof is the only
       structure on the course that wants it - a car eighteen units up that is
       meant to end on the factory floor cannot get there by being thrown off
       the edge. `s3 <= s2` is exactly `armRampDeck`. */
    armRampRoad(s0, s1, s2, s3, h, lip) {
      M().synx_veh_arm_ramp_road(this._id, s0 || 0, s1 || 0, s2 || 0, s3 || 0, h || 0, lip || 0);
      return this;
    }
    clearRamp() { return this.armRamp(0, 0, 0); }

    /** Move onto a lateral without resetting: an arrival is already rolling. */
    placeLateral(s, lateral) {
      M().synx_veh_place_lateral(this._id, s, lateral || 0);
      return this;
    }

    update(dt, input, active) {
      input = input || {};
      M().synx_veh_update(this._id, dt,
        input.steer || 0, input.throttle || 0, input.brake || 0,
        input.boost ? 1 : 0, input.ebrake ? 1 : 0, active ? 1 : 0);
    }

    /** Speed over the ground, in world units per second. */
    get speedUnits() { return this.speed; }
    /** ...and in the units a driver would actually read. */
    get speedMs() { return this.speed * NR.UNIT_METRES; }
    get speedKmh() { return this.speedMs * 3.6; }
    get speedMph() { return this.speedMs * 2.23694; }

    /* THE FASTEST THIS CAR CAN GO, in the same units, whatever is under the
       bonnet right now.

       `engineTop` is what the engine will pull to on its own and `speedCap` is
       the hard ceiling the solver enforces above it - Infinity on the street
       block, and the Forge rebuild's 122 once the swap is fitted, which is the
       200 mph raceMode is allowed to reach. So the ceiling is the cap when
       there is one and the engine's own top when there is not, and it changes
       exactly when the car does.

       This exists because the speedometer needs it. A dial scaled to a
       constant is a dial that stops meaning anything the moment the car it is
       bolted to is rebuilt - see the note in js/hud.js. */
    get ceilingUnits() {
      const cap = this.speedCap;
      const top = this.engineTop || 0;
      return (cap !== undefined && isFinite(cap) && cap > 0) ? Math.max(top, cap) : top;
    }
    get ceilingMph() { return this.ceilingUnits * NR.UNIT_METRES * 2.23694; }
    get ceilingKmh() { return this.ceilingUnits * NR.UNIT_METRES * 3.6; }

    /* ...and what the block will pull on its own, without the reserve. The
       two are different numbers and the difference is the whole point of the
       Forge: 144 on the engine, 200 with raceMode in. Chapter 6 puts both on
       the card it hands the player, and it reads them from here so the card
       cannot end up quoting a figure the solver stopped producing. */
    get engineTopMph() { return (this.engineTop || 0) * NR.UNIT_METRES * 2.23694; }
    get engineTopKmh() { return (this.engineTop || 0) * NR.UNIT_METRES * 3.6; }
  }

  /** One wheel's slice of the same block. */
  class Wheel {
    constructor(car, i) { this._car = car; this._i = i; }
    get omega() { return this._car._s[this._car._base + FIELDS['w' + this._i + 'omega']]; }
    set omega(v) { this._car._s[this._car._base + FIELDS['w' + this._i + 'omega']] = v; }
    get load() { return this._car._s[this._car._base + FIELDS['w' + this._i + 'load']]; }
    get slipAngle() { return this._car._s[this._car._base + FIELDS['w' + this._i + 'slipAngle']]; }
    get slipRatio() { return this._car._s[this._car._base + FIELDS['w' + this._i + 'slipRatio']]; }
  }

  /** Build one accessor per field, from the layout the module reported. */
  function defineVehicleFields(names) {
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (/^w[0-3]/.test(name)) continue;            // the Wheel proxies own these
      const slot = i;
      let desc;
      if (name === 'lastHitType') {
        desc = {
          get() { return HIT_NAMES[this._s[this._base + slot] | 0] || null; },
          set(v) {
            const k = HIT_NAMES.indexOf(v);
            this._s[this._base + slot] = k < 0 ? 0 : k;
          },
        };
      } else if (BOOL_FIELDS.has(name)) {
        desc = {
          get() { return this._s[this._base + slot] !== 0; },
          set(v) { this._s[this._base + slot] = v ? 1 : 0; },
        };
      } else {
        desc = {
          get() { return this._s[this._base + slot]; },
          set(v) { this._s[this._base + slot] = v; },
        };
      }
      desc.configurable = true;
      Object.defineProperty(Vehicle.prototype, name, desc);
    }
  }

  /** Two cars touching. Returns the closing speed, as it always did. */
  function collideCars(a, b) {
    return M().synx_collide_cars(a._id, b._id);
  }

  // -------------------------------------------------------------- driver --

  const LEVEL_INDEX = { EASY: 0, MEDIUM: 1, HARD: 2, IMPOSSIBLE: 3 };
  const PERSONALITY_INDEX = { ryker: 1, kael: 2, nova: 3, predator: 4 };

  class Driver {
    constructor(track, level) {
      this.track = track;
      // one racing line per course, shared by every driver on it
      if (!track._lineBuilt) {
        M().synx_line_build();
        track._lineBuilt = true;
        M();
      }
      this.levelName = LEVEL_INDEX[level] === undefined ? 'MEDIUM' : level;
      this._id = M().synx_driver_create(LEVEL_INDEX[this.levelName], (Math.random() * 0xffffffff) >>> 0);
      this._personality = null;
      this._laneHint = null;
      this.paceScale = 1;
      this.gripScale = 1;
      this.lastTarget = 0;
      this.skill = 0;
      this._boostHold = 0;
      /* The difficulty profile stays a plain JavaScript object.

         Chapter 7 does not pick a difficulty, it MOVES one: it clones the HARD
         entry and walks `skill`, `react`, `grip` and `driftSkill` with the
         prediction model's confidence, writing the fields directly. Keeping
         `cfg` as an object it can mutate - and pushing whatever it says down
         to the core once a frame - is what lets that keep working unchanged. */
      this.cfg = Object.assign({}, NR.AI_LEVELS[this.levelName]);
      this._cfgSent = null;
      M();
    }

    setLevel(level) {
      this.levelName = LEVEL_INDEX[level] === undefined ? 'MEDIUM' : level;
      this.cfg = Object.assign({}, NR.AI_LEVELS[this.levelName]);
      this._cfgSent = null;
      M().synx_driver_set_level(this._id, LEVEL_INDEX[this.levelName]);
    }

    /* `reset` rebuilt the speed profile, because grip depends on skill. The
       core does that whenever the profile it is handed changes, so this only
       has to make sure the next frame sends one. */
    reset() {
      // Clear core passing/recovery state as well as the JS settings on restart.
      M().synx_driver_set_level(this._id, LEVEL_INDEX[this.levelName]);
      this._cfgSent = null;
      this.paceScale = 1;
      this.gripScale = 1;
      /* THE LANE HINT IS A LOAN, AND RESET IS WHEN IT COMES BACK.
       *
       * `laneHint` is an ABSOLUTE lateral a director hands the driver so its
       * car can see hardware the track does not know about - Chapter 6's live
       * walls, its saws, its sorting chutes. It is a closure over THAT
       * director and it is only meaningful inside THAT chapter.
       *
       * Chapter 6 cleared it in its own teardown and nothing else ever did, so
       * any route into another chapter that did not run that teardown left the
       * Forge's lane function installed. In Chapter 7 the R-IX then asked it
       * where to be, and got Chapter 6's answers: gate gaps and the +/-13 to
       * +/-14 that keeps a car clear of a saw. Those are near the edge of the
       * road, and they switch on and off as the lookahead sweeps past track
       * positions that belong to a different chapter - so the boss drove from
       * one edge of the circuit to the other and back, over and over, while
       * making perfectly normal forward progress.
       *
       * It is cleared here because this is the one function every race start
       * already calls, and because a director that wants a hint sets it when
       * it starts. A loan returned at the door cannot be left behind. */
      this._laneHint = null;
      this._boostHold = 0;
      M().synx_driver_set_boost_hold(this._id, 0);
      this.lastTarget = 0;
      this.lastInput = null;
    }

    get boostHold() { return this._boostHold; }
    set boostHold(v) {
      this._boostHold = v;
      M().synx_driver_set_boost_hold(this._id, v);
    }

    /** Send the profile down, but only when it has actually changed - it
        rebuilds a 28,900-sample speed profile on the other side. */
    _syncCfg() {
      const c = this.cfg;
      const key = c.skill + '|' + c.assist + '|' + c.target + '|' + c.grip + '|' +
        c.react + '|' + c.boostSkill + '|' + c.driftSkill + '|' + c.mistakes;
      if (key === this._cfgSent) return;
      this._cfgSent = key;
      M().synx_driver_set_cfg(this._id, c.skill, c.assist, c.target, c.grip,
        c.react, c.boostSkill, c.driftSkill, c.mistakes);
    }

    get personality() { return this._personality; }
    set personality(p) {
      this._personality = p;
      M().synx_driver_set_personality(this._id, PERSONALITY_INDEX[p] || 0);
    }

    /* The lane hint is a FUNCTION in the level directors - given an arc
       length, where to be. WebAssembly cannot call back into it cheaply, so
       the bridge evaluates it here, once a frame, at the point the driver is
       actually aiming at, and passes the answer down as a number. */
    get laneHint() { return this._laneHint; }
    set laneHint(fn) { this._laneHint = fn; }

    drive(dt, car, world) {
      world = world || {};
      let hint = NaN;
      if (this._laneHint) {
        // the same lookahead the driver uses, so the hint lands where it aims
        const look = Math.max(14, Math.min(68, 10 + Math.max(0, car.vLong) * 0.48));
        const v = this._laneHint(car.sTrack + look, car);
        if (v !== null && v !== undefined && isFinite(v)) hint = v;
      }
      this._syncCfg();
      const w = M();
      w.synx_driver_tune(this._id, this.paceScale, this.gripScale, hint);
      const hasRival = world.rivalS !== undefined && isFinite(world.rivalS);
      const p = w.synx_driver_drive(this._id, car._id, dt,
        world.raceOn ? 1 : 0, hasRival ? 1 : 0,
        hasRival ? world.rivalS : 0, world.rivalX || 0, world.rivalZ || 0,
        world.finishAt || 0) >> 3;
      this.lastTarget = F64[p + 5];
      this.skill = F64[p + 6];
      this.lastInput = {
        steer: F64[p], throttle: F64[p + 1], brake: F64[p + 2],
        boost: F64[p + 3] !== 0, ebrake: F64[p + 4] !== 0,
      };
      return this.lastInput;
    }
  }


  // ------------------------------------------------------- world geometry --

  /* The geometry arena.
   *
   * js/scene.js generates about two million vertices at load, and every one of
   * them used to be eight boxed appends into a growing JavaScript array - plus,
   * every so often, a reallocation and copy of a multi-megabyte one, and a
   * final conversion to a Float32Array before WebGL would look at it.
   *
   * The buffer lives in the core now. `Geo.vf` and `Geo.iu` are views straight
   * onto it, so appending a vertex is eight float stores and the GPU upload
   * reads the same memory with nothing in between.
   *
   * GROWTH DETACHES VIEWS. Asking the core for more room can move the
   * allocation and, separately, can grow WebAssembly memory - either detaches
   * every existing view over it. `need()` is therefore the only way to reserve
   * space, and it re-derives the views whenever it has to grow.
   */
  const Geo = {
    vf: null,       // Float32Array over the vertex arena
    iu: null,       // Uint32Array over the index arena
    vLen: 0,        // floats written
    iLen: 0,        // indices written
    vCap: 0,
    iCap: 0,

    /** Start a build, reserving a generous estimate. */
    reset(vertFloats, indices) {
      const w = M();
      w.synx_geo_reset(vertFloats, indices);
      this.vLen = 0;
      this.iLen = 0;
      this._views();
    },

    _views() {
      const w = M();
      this.vCap = w.synx_geo_vcap();
      this.iCap = w.synx_geo_icap();
      this.vf = new Float32Array(wasm.memory.buffer, w.synx_geo_vptr(), this.vCap);
      this.iu = new Uint32Array(wasm.memory.buffer, w.synx_geo_iptr(), this.iCap);
    },

    /** Make room for `nv` more vertex floats and `ni` more indices. */
    need(nv, ni) {
      let moved = false;
      if (this.vLen + nv > this.vCap) { M().synx_geo_grow_verts(nv + 65536); moved = true; }
      if (this.iLen + ni > this.iCap) { M().synx_geo_grow_idx(ni + 65536); moved = true; }
      if (moved) this._views();
    },

    /** The finished vertex data, as the exact subarray WebGL should upload. */
    verts() { return this.vf.subarray(0, this.vLen); },
    indices() { return this.iu.subarray(0, this.iLen); },
  };

  /* The landscape's distance field.
   *
   * A uniform grid of "which centreline sample is nearest", used to cut the
   * road corridor out of the terrain and to decide which country a point is
   * in. Stamping it is twenty-four million inner iterations at the shipped
   * reach and was most of the landscape's cost; the core does it now and hands
   * back a view of the answer. */
  /* ===================================== WHICH SAMPLE OF THE ROAD IS NEAREST
   *
   * The grid the core stamps, and the single most load-bearing number in the
   * whole world build: every clearance test there is - no tower within two
   * hundred units of the road, no prop within a hundred and ten, no rubble in
   * the lane - is a lookup in here.
   *
   * IT MUST NOT BE CACHED, AND IT WAS.
   *
   * `near` was built once, at stamp time, as a view onto WebAssembly linear
   * memory. Growing that memory REPLACES the buffer and DETACHES every view
   * onto the old one - and the world build grows it constantly afterwards, as
   * the dressing arena fills. From the first growth onward every read of this
   * array returned `undefined`, silently, because a detached typed array
   * throws nothing.
   *
   * What that does downstream is worse than a crash. `undefined` is not less
   * than zero, so it is not caught as "off the grid"; it becomes a seed of
   * NaN, an empty refine loop, and a distance of INFINITY. Scene.roadAt then
   * reports every point in the world as infinitely far from any road, and
   * every clearance test written against it - all of them - passes. That is
   * how buildings ended up in the middle of the carriageway on the routes
   * late enough in the build for the arena to have grown: the generators were
   * asking the right question and being told the road was not there.
   *
   * So the view is revalidated on every read. The check is one identity
   * comparison against the current buffer and the rebuild only happens on the
   * handful of frames where memory actually grew. js/scene.js has the same
   * rule for the geometry arena and says so in the same words - see the note
   * on `push` in buildDressing - which is where this should have been learned
   * the first time.
   */
  const Land = {
    gw: 0, gh: 0, x0: 0, z0: 0, cell: 120,
    _near: null, _buf: null, _ptr: 0, _len: 0,

    /** The live grid, or null before it has been stamped. */
    get near() {
      if (!this._len || !wasm || !wasm.memory) return null;
      const buf = wasm.memory.buffer;
      if (this._buf !== buf || !this._near || this._near.length !== this._len) {
        this._near = new Int32Array(buf, this._ptr, this._len);
        this._buf = buf;
      }
      return this._near;
    },

    stamp() {
      const w = M();
      const n = w.synx_land_stamp();
      const g = w.synx_land_grid() >> 3;
      this.gw = F64[g] | 0;
      this.gh = F64[g + 1] | 0;
      this.x0 = F64[g + 2];
      this.z0 = F64[g + 3];
      this.cell = F64[g + 4];
      /* Recorded, not materialised. The view is built on demand by the getter
         above, against whatever the buffer is at the time of the read. */
      this._ptr = w.synx_land_near();
      this._len = n;
      this._buf = null;
      return n;
    },
  };


  /* ------------------------------------------------------------ multiplayer --
   *
   * The netcode is in the core (crates/synx-core/src/net.rs); this is the
   * seam, and it is deliberately thin. Nothing here decodes a message, decides
   * where a car is, or knows what a snapshot looks like - those all live on
   * the other side of this boundary, where they can be tested with
   * `cargo test` and where they cost nothing per frame.
   *
   * What crosses:
   *   BYTES IN    a received frame, written into linear memory and handed over
   *               by address. No JavaScript object is ever built from a
   *               snapshot.
   *   BYTES OUT   a view on the core's own outbound buffer, handed straight to
   *               `WebSocket.send`. No copy, no allocation per frame.
   *   POSES       written by the core into the ordinary vehicle state blocks,
   *               so the renderer, the lights and the collision resolver see
   *               remote cars as normal cars and nothing above here changes.
   */
  /** Seats in a room. Mirrors MAX_PLAYERS in the wire protocol, and the
      stride `synx_net_peers` writes its block at. */
  const MAX_SEATS = 4;

  const Net = {
    /** True once the core has a netcode build in it. */
    get available() { return !!(wasm && wasm.synx_net_reset); },

    /* WHAT WIRE FORMAT THIS CORE SPEAKS.
     *
     * The game and the server are built from separate repositories and meet
     * only over a URL, so nothing but agreement makes them compatible. The
     * fingerprint is a compile-time digest of the format's shape - every
     * opcode, field width and quantisation scale - and it is read from the
     * core rather than from the host because the core is what actually
     * encodes and decodes cars. A mismatch here is caught at the handshake
     * and reported as "update the game", which is far better than the
     * alternative: a race that runs, and is wrong. */
    get fingerprint() {
      const w = M();
      return w && w.synx_wire_fingerprint ? w.synx_wire_fingerprint() >>> 0 : 0;
    },

    /** The protocol version this core speaks. */
    get protocol() {
      const w = M();
      return w && w.synx_wire_protocol ? w.synx_wire_protocol() >>> 0 : 0;
    },

    /** Forget every peer, the clock and the buffer. `slot` is our own seat. */
    reset(slot) {
      const w = M();
      if (w && w.synx_net_reset) w.synx_net_reset(slot === undefined || slot === null ? 255 : slot);
    },

    /** Which seat this client occupies. Safe to call whenever the room
        changes; unlike `reset`, it keeps the clock and the playout buffer. */
    self(slot) {
      const w = M();
      if (w && w.synx_net_self) w.synx_net_self(slot === undefined || slot === null ? 255 : slot);
    },

    /** Mark a seat occupied or empty. */
    peer(slot, on) {
      const w = M();
      if (w && w.synx_net_peer) w.synx_net_peer(slot, on ? 1 : 0);
    },

    /**
     * Hand one received frame to the netcode.
     *
     * Returns what it was: 0 nothing, 1 snapshot, 2 correction, 3 clock,
     * 4 a liveness probe whose answer is now waiting in `out()`, 5 malformed.
     *
     * The scratch buffer is reused and re-derived whenever the module could
     * have grown its memory under us, which is the same rule everything else
     * in this file follows.
     */
    ingest(bytes, nowMs) {
      const w = M();
      if (!w || !w.synx_net_ingest || !bytes || !bytes.length) return 0;
      const n = bytes.length;
      if (n > 8192) return 5;
      if (!inPtr || inCap < n) {
        if (inPtr) w.synx_free(inPtr);
        inCap = Math.max(1024, n * 2);
        inPtr = w.synx_alloc(inCap);
        M();
      }
      U8.set(bytes, inPtr);
      return M().synx_net_ingest(inPtr, n, nowMs);
    },

    /** Advance every remote car to the moment that should be drawn now. */
    sample(nowMs, dt) {
      const w = M();
      if (w && w.synx_net_sample) w.synx_net_sample(nowMs, dt);
    },

    /** Write seat `slot`'s pose into `car`. True when it should be drawn. */
    apply(slot, car) {
      const w = M();
      if (!w || !w.synx_net_apply || !car) return false;
      return w.synx_net_apply(slot, car._id) === 1;
    },

    /** Build this client's own state packet. Returns a view, or null. */
    packState(car, nowMs, flags, checkpoint) {
      const w = M();
      if (!w || !w.synx_net_pack_state || !car) return null;
      const n = w.synx_net_pack_state(car._id, nowMs, flags | 0, checkpoint | 0);
      return n ? Net.out(n) : null;
    },

    /** Build a clock-sync request. Returns a view, or null. */
    packTime(nowMs) {
      const w = M();
      if (!w || !w.synx_net_pack_time) return null;
      const n = w.synx_net_pack_time(nowMs);
      return n ? Net.out(n) : null;
    },

    /** A view on whatever the core last put in its outbound buffer.
     *
     * A SUBARRAY, not a copy: `WebSocket.send` reads it synchronously, so
     * there is no window in which the core could overwrite it. It is only
     * valid until the next call that writes the buffer, which is the same
     * rule as every other view this file hands out. */
    out(len) {
      const w = M();
      if (!w || !w.synx_net_out_ptr) return null;
      const n = len === undefined ? w.synx_net_out_len() : len;
      if (!n) return null;
      const p = w.synx_net_out_ptr();
      return U8.subarray(p, p + n);
    },

    /** Take a pending correction and apply it to `car`. Returns the reason
        code, or 0 for none. */
    takeCorrection(car) {
      const w = M();
      if (!w || !w.synx_net_take_correction || !car) return 0;
      return w.synx_net_take_correction(car._id);
    },

    /** Resolve the local car against a remote one. Returns closing speed. */
    collide(local, remote) {
      const w = M();
      if (!w || !w.synx_net_collide || !local || !remote) return 0;
      return w.synx_net_collide(local._id, remote._id);
    },

    /** Everything the interface reads, in one call rather than twelve. */
    stats(out) {
      const w = M();
      out = out || {};
      if (!w || !w.synx_net_stats) return out;
      const p = w.synx_net_stats() >> 3;
      out.offset = F64[p];
      out.rtt = F64[p + 1];
      out.delay = F64[p + 2];
      out.framesIn = F64[p + 3];
      out.bytesIn = F64[p + 4];
      out.framesOut = F64[p + 5];
      out.bytesOut = F64[p + 6];
      out.dropped = F64[p + 7];
      out.corrections = F64[p + 8];
      out.snapFlags = F64[p + 9] | 0;
      out.synced = F64[p + 10] !== 0;
      out.smoothing = F64[p + 11];
      return out;
    },

    /** Every seat's LIVE standing: place, ping and how far round the course.
     *
     * See `synx_net_peers` in crates/synx-core/src/abi.rs for the block layout
     * and for why the standings used to be wrong without it. Rows are reused
     * between calls rather than rebuilt: this is read on every repaint of the
     * card, and a fresh array of four objects five times a second is garbage
     * for nothing. */
    peers(out) {
      const w = M();
      out = out || { rows: [], place: 0, rtt: 0 };
      const rows = out.rows || (out.rows = []);
      while (rows.length < MAX_SEATS) rows.push({ slot: rows.length });
      if (!w || !w.synx_net_peers) return out;
      const p = w.synx_net_peers() >> 3;
      for (let i = 0; i < MAX_SEATS; i++) {
        const b = p + i * 8, r = rows[i];
        r.slot = i;
        r.known = F64[b] !== 0;
        r.place = F64[b + 1] | 0;
        r.rtt = F64[b + 2];
        r.s = F64[b + 3];
        r.flags = F64[b + 4] | 0;
        r.lagMs = F64[b + 5];
        r.extrapolated = F64[b + 6] !== 0;
        r.speed = F64[b + 7];
        // synx_net::flag::FINISHED and ::IDLE
        r.finished = (r.flags & (1 << 4)) !== 0;
        r.idle = (r.flags & (1 << 6)) !== 0;
      }
      out.place = F64[p + MAX_SEATS * 8] | 0;
      out.rtt = F64[p + MAX_SEATS * 8 + 1];
      return out;
    },

    // ------------------------------------------------------ proof of work --

    /* One slice of the registration proof of work.
     *
     * Sliced rather than solved outright so the connecting screen keeps
     * animating: sixteen bits is about sixty-five thousand hashes, which is
     * seventy milliseconds in one go and four comfortable frames in slices of
     * sixteen thousand. Returns the nonce, or -1 for "not yet, call again with
     * a later start". */
    powSolve(challenge, bits, start, limit) {
      const w = M();
      if (!w || !w.synx_pow_solve) return -1;
      const bytes = ENC.encode(challenge);
      if (bytes.length > 128) return -1;
      U8.set(bytes, w.synx_pow_buf());
      const n = M().synx_pow_solve(bytes.length, bits, start >>> 0, limit >>> 0);
      return n === 0xFFFFFFFF ? -1 : n;
    },

    /** SHA-256 of a short string, as lower-case hex. Used to fold the awkward
        halves of the device print into one field. */
    digest(text) {
      const w = M();
      if (!w || !w.synx_pow_digest) return '';
      const bytes = ENC.encode(text).subarray(0, 128);
      U8.set(bytes, w.synx_pow_buf());
      const p = M().synx_pow_digest(bytes.length) >> 3;
      let s = '';
      for (let i = 0; i < 32; i++) s += (F64[p + i] | 0).toString(16).padStart(2, '0');
      return s;
    },
  };

  const ENC = new TextEncoder();
  let inPtr = 0, inCap = 0;

  /* Named NetCore rather than Net: js/net.js owns NR.Net, which is the
     transport and the session. This is the seam to the core underneath it. */
  NR.NetCore = Net;

  // -------------------------------------------------------------- exports --

  /* THE RECORDER IS NOT WIRED THROUGH HERE ANY MORE.
     It had a seam in this file because this file owns the wasm instance -
     but the encoder is its own module now, loaded by its own thread, and the
     only code that touches it is web/js/recworker.js. Keeping a bridge here
     to a set of exports the core no longer has would be ninety lines that
     can only ever return null. See crates/synx-rec/src/abi.rs. */

  NR.Track = Track;
  NR.Vehicle = Vehicle;
  NR.Driver = Driver;
  NR.buildCourse = buildCourse;
  NR.collideCars = collideCars;
  NR.wasmMemory = M;
  NR.Geo = Geo;
  NR.Land = Land;
  NR.UNIT_METRES = 0.733;

  /* Course geometry the rest of the game reads as constants. These mirror the
     Rust in crates/synx-core/src/track.rs; they are declared rather than
     queried because they are compile-time facts about the road, and several
     files read them before the core has finished loading. */
  NR.ROAD_HALF = 20.0;
  NR.DRIVE_HALF = 18.0;
  /* BAKING INSTANCED BOXES, IN THE CORE.
   *
   * Chapter 7 merges about twenty thousand box instances into per-chunk,
   * per-material buffers so the route costs draw calls it can afford. That is
   * half a million vertex transforms and two million float appends.
   *
   * THE COPIES ARE THE WHOLE PROBLEM, and getting this wrong is instructive.
   * The obvious version - build the matrices in a JavaScript array, `set` them
   * into linear memory, bake, `slice` the result back out - was measured at
   * 105 ms against 95 ms for doing the arithmetic in JavaScript. The transform
   * is not what costs; moving five megabytes across the boundary twice is.
   *
   * So nothing crosses. `bakeBegin` hands back a view ON the core's own
   * matrix buffer for the caller to write instances straight into, and
   * `bakeRun` hands back views ON the arena for `gl.bufferData` to read
   * directly. The data is written once, by whoever produced it, and read once,
   * by the GPU upload.
   *
   * The views are valid until the next call that can grow a Vec, which is why
   * `bakeRun`'s result must be uploaded before the next `bakeBegin`.
   */
  function bakeBegin(srcV, srcI, instances) {
    const w = M();
    if (!w || !w.synx_bake_run || !instances || !srcV.length) return null;
    w.synx_bake_source(srcV.length, srcI.length);
    F32.set(srcV, M().synx_bake_src_v() >> 2);
    U32.set(srcI, M().synx_bake_src_i() >> 2);
    M().synx_bake_instances(instances);
    const p = M().synx_bake_mats() >> 2;
    bakeState = { instances, idx: srcI.length };
    return F32.subarray(p, p + instances * 16);
  }

  /** Bake, and return views on the arena. Upload them before baking again. */
  function bakeRun() {
    const w = M();
    if (!w || !bakeState) return null;
    const verts = w.synx_bake_run();
    const vp = M().synx_geo_vptr() >> 2, ip = M().synx_geo_iptr() >> 2;
    const out = {
      verts: F32.subarray(vp, vp + verts * 8),
      idx: U32.subarray(ip, ip + bakeState.idx * bakeState.instances),
    };
    bakeState = null;
    return out;
  }
  let bakeState = null;
  /* RIBBON STRIPS, IN THE CORE.
   *
   * Twelve ribbons a frame, each rebuilt from its ring buffer: gathered,
   * smoothed twice and turned into six vertices of nine floats per segment.
   * See crates/synx-core/src/ribbon.rs for why - the arithmetic was never the
   * problem, the hundred and eight ordinary arrays it allocated every frame
   * were.
   *
   * Nothing is copied out. `ribbonStrip` writes the ribbon's nodes into the
   * core's own scratch, and `ribbonOut` hands back a view on the finished
   * vertices for `gl.bufferSubData` to read directly. */
  function ribbonBegin(capQuads) {
    const w = M();
    if (!w || !w.synx_rib_begin) return false;
    w.synx_rib_begin(capQuads);
    return true;
  }

  /** One ribbon. `nodes` is its raw Float32Array, stride 10. */
  function ribbonStrip(nodes, count, head, max, life, ground, cam, capQuads) {
    const w = M();
    if (!w || !w.synx_rib_strip || count < 2) return 0;
    const p = w.synx_rib_nodes(count) >> 2;
    // one typed-array copy of at most 1,700 floats, straight into the core
    F32.set(nodes.subarray(0, count * 10), p);
    return M().synx_rib_strip(count, head, max, life, ground ? 1 : 0,
      cam[0], cam[1], cam[2], capQuads);
  }

  /** A view on the finished vertices. Valid until the next ribbonBegin. */
  function ribbonOut() {
    const w = M();
    if (!w || !w.synx_rib_out) return null;
    const q = w.synx_rib_quads();
    if (!q) return null;
    const p = M().synx_rib_out() >> 2;
    return F32.subarray(p, p + q * 6 * 9);
  }
  NR.ribbonBegin = ribbonBegin;
  NR.ribbonStrip = ribbonStrip;
  NR.ribbonOut = ribbonOut;


  /* ---------------------------------------------------------- particles --
   *
   * The sprite system's two hot loops live in the core; see
   * crates/synx-core/src/particles.rs for why. This is the whole of the
   * bridge: one buffer JavaScript writes when it spawns, and two calls a
   * frame.
   *
   * `fxParticles` hands back a live view rather than a copy. It is re-derived
   * on every call because `synx_fx_reset` reallocates and, more subtly,
   * because ANY core allocation can grow linear memory and replace
   * `memory.buffer` - a view cached across that boundary reads as zeroes and
   * throws nothing, which is a particle system that silently stops.
   */
  function fxReset(max) {
    const w = M();
    if (!w || !w.synx_fx_reset) return 0;
    w.synx_fx_reset(max);
    return w.synx_fx_stride();
  }
  /** The particle buffer, as a live Float32Array view. */
  function fxParticles(max) {
    const w = M();
    if (!w || !w.synx_fx_pptr) return null;
    M();          // the views are re-derived there; see the note on M
    const p = w.synx_fx_pptr() >> 2;
    return F32.subarray(p, p + max * w.synx_fx_stride());
  }
  /** One damped Euler step. Returns how many particles are still alive. */
  function fxIntegrate(dt) {
    const w = M();
    if (!w || !w.synx_fx_integrate) return -1;
    return w.synx_fx_integrate(dt);
  }
  /* One frame of every continuous emitter for one car.
   *
   * The four rate-driven emitters - tyre smoke, the afterburner, the shower
   * off a barrier and the grit past the lens - run on the core side now; see
   * the note at the head of crates/synx-core/src/particles.rs for what they
   * were costing in JavaScript object churn.
   *
   * `slot` is the index js/fx.js has assigned this car, and `next` is its own
   * round-robin spawn cursor, handed over and handed back so the one-off
   * effects the chapter directors still spawn share the same ring.
   *
   * Returns the new cursor, or -1 when there is no core - which is the signal
   * js/fx.js uses to run its own copy instead. */
  function fxEmit(slot, next, dt, density, car, surfY, isPlayer) {
    const w = M();
    if (!w || !w.synx_fx_emit) return -1;
    return w.synx_fx_emit(
      slot, next, dt, density,
      car.x, car.y === undefined ? 1 : car.y, car.z, car.yaw,
      car.speed || 0, car.vx || 0, car.vz || 0,
      car.driftAmount || 0, car.wheelSpinFx || 0,
      car.raceModeMultiplier || 1,
      car.scrape || 0, car.lateral || 0, surfY,
      (car.boosting ? 1 : 0) | (isPlayer ? 2 : 0));
  }

  /** Forget every emitter accumulator. A new race opens with nothing banked. */
  function fxEmitReset() {
    const w = M();
    if (w && w.synx_fx_emit_reset) w.synx_fx_emit_reset();
  }

  /** Expand to triangles and hand back the vertex data, or null. */
  function fxBuild(right, up, fwd) {
    const w = M();
    if (!w || !w.synx_fx_build) return null;
    const n = w.synx_fx_build(right[0], right[1], right[2],
      up[0], up[1], up[2], fwd[0], fwd[1], fwd[2]);
    if (!n) return null;
    M();          // the views are re-derived there; see the note on M
    const p = w.synx_fx_optr() >> 2;
    return F32.subarray(p, p + n * 9);
  }
  /* ------------------------------------------------------------ driver --
   *
   * The figure in the seat, posed on the core side. See
   * crates/synx-core/src/driver.rs for what it is doing and why it is worth
   * a call: seventeen parts a car, five cars, six passes, every frame.
   *
   * The table goes over once. After that the only things that cross are a
   * car transform and a steering angle, and the only thing that comes back
   * is a pointer into the core's own memory.
   */
  function drvLoad(hub, rake, table) {
    const w = M();
    if (!w || !w.synx_drv_load) return 0;
    w.synx_drv_hub(hub[0], hub[1], hub[2], rake);
    const stride = w.synx_drv_stride();
    const n = Math.floor(table.length / stride);
    /* The pointer is taken AFTER the resize inside it, and used immediately:
       any core allocation can grow linear memory and replace memory.buffer,
       and a view held across that reads as zeroes without throwing. */
    const at = w.synx_drv_tptr(n) >> 2;
    M();
    F32.set(table, at);
    return w.synx_drv_load();
  }
  /** Every part's world matrix for one figure, as a live view of n*16. */
  /* `spin` is the rim's angle and `hand` the hands' - the same number until
     the rim is past about seventy degrees, after which the wheel slides
     through the driver's grip instead of carrying their arms round with it.
     See GRIP in crates/synx-core/src/driver.rs. */
  function drvPose(model, spin, hand, press) {
    const w = M();
    if (!w || !w.synx_drv_pose) return null;
    /* The car transform has to be IN core memory to be read from there, so
       it goes into a slot of its own - see synx_drv_mptr. Sixteen floats,
       written in place, no allocation on either side per frame. */
    const at = w.synx_drv_mptr() >> 2;
    M();
    F32.set(model, at);
    const out = w.synx_drv_pose(spin, hand, press || 0) >> 2;
    M();
    return F32.subarray(out, out + drvPose.n * 16);
  }
  /** Where the head sits, which the first-person eye is measured from. */
  function drvHead(x, y, z) {
    const m = M();
    if (m && m.synx_drv_head) m.synx_drv_head(x, y, z);
  }
  /** The driver's eye and look-at, as six floats. See driver.rs. */
  function camPov(model, yaw, pitch) {
    const m = M();
    if (!m || !m.synx_cam_pov) return null;
    const at = m.synx_drv_mptr() >> 2;
    M();
    F32.set(model, at);
    const out = m.synx_cam_pov(yaw, pitch) >> 2;
    M();
    return F32.subarray(out, out + 9);
  }
  NR.drvHead = drvHead;
  NR.camPov = camPov;

  drvPose.n = 0;
  NR.drvLoad = (hub, rake, table) => { drvPose.n = drvLoad(hub, rake, table); return drvPose.n; };
  NR.drvPose = drvPose;

  NR.fxReset = fxReset;
  NR.fxParticles = fxParticles;
  NR.fxIntegrate = fxIntegrate;
  NR.fxBuild = fxBuild;
  NR.fxEmit = fxEmit;
  NR.fxEmitReset = fxEmitReset;

  NR.bakeBegin = bakeBegin;
  NR.bakeRun = bakeRun;

  NR.COURSE_LENGTH = 175800;   // see the note in crates/synx-core/src/track.rs
  NR.CHAPTER7_FROM = 132000;
  NR.CHAPTER7_GEOMETRY = {
    from: 132000, to: 175800,
    zones: [
      { id: 'ascension_gate', label: 'ASCENSION GATE', from: 132000, to: 136710 },
      { id: 'understack', label: 'THE UNDERSTACK', from: 136710, to: 141420 },
      { id: 'skybreak', label: 'SKYBREAK SPAN', from: 141420, to: 146130 },
      { id: 'data_cathedral', label: 'DATA CATHEDRAL', from: 146130, to: 150840 },
      { id: 'the_gauntlet', label: 'THE GAUNTLET', from: 150840, to: 155550 },
      { id: 'skyscraper_dive', label: 'SKYSCRAPER DIVE', from: 155550, to: 160260 },
      { id: 'rotation_yard', label: 'ROTATION YARD', from: 160260, to: 164960 },
      { id: 'tower_run', label: 'TOWER RUN', from: 164960, to: 169670 },
      { id: 'apex_recursion', label: 'APEX RECURSION', from: 169670, to: 175800 },
    ],
  };
})(window);
