'use strict';
/* Every probe, and nothing that decides anything.
 *
 *     node tools/probes/probe.js <out-dir> <name> [args...]
 *
 * A probe MEASURES. Whether a measurement is acceptable is decided in
 * tools/check.py, on the other side of a JSON file - see tools/synx/jsprobe.py
 * for why the split is that way round. Nothing in here holds a threshold, a
 * pass or a failure, and nothing in here should ever start to.
 *
 * WHY THIS IS JAVASCRIPT AT ALL. Six of the thirteen checks are about what the
 * game's own code DOES: the story machine over thirty simulated minutes, the
 * ramp table against the solver it arms, the geometry a chapter director
 * builds, whether the recorder's worker gives its buffers back, how the rival
 * drives. A Python reimplementation of any of those would pass happily while
 * the real thing was broken, so the real thing is what runs.
 *
 * Each probe is a function with a scope of its own. That is not tidiness: two
 * of them define a `stubGL` and the two stubs are nothing alike.
 */
const B = require('./boot.js');

const MODES = Object.create(null);

/* The settings schema, as the game itself defines it.
 *
 * js/settings.js closes over `typeof window !== 'undefined' ? window : globalThis`
 * precisely so a tool can load it as well as a page - so it is loaded rather
 * than parsed, and what comes out is the schema the game will actually use.
 */
MODES.settings = function () {
  global.window = global.window || {};
  require(B.path.join(B.ROOT, 'web', 'js', 'settings.js'));
  const S = (global.NR && global.NR.Settings) || (global.window.NR && global.window.NR.Settings);
  if (!S) {
    console.error('settings.js did not define NR.Settings');
    process.exit(1);
  }

  B.report({
    rows: S.ROWS.map((r) => ({
      key: r.key, label: r.label, hint: r.hint, where: r.where, tab: r.tab,
      opts: Array.isArray(r.opts) ? r.opts.slice() : null,
      def: typeof r.def === 'number' ? r.def : null,
    })),
    quality: S.QUALITY,
    fpsCaps: S.FPS_CAPS,
    renderScales: S.RENDER_SCALES,
    hostKeys: S.HOST_KEYS,
  });
};

/* The soundtrack table, as js/audio.js actually defines it.
 *
 * Loaded rather than parsed: the table is a literal inside a closure, and a
 * checker that re-read it with a regular expression would be carrying its own
 * copy of the answer. js/audio.js publishes it as NR.MUSIC_TRACKS for exactly
 * this, and the mixer itself is never constructed - there is no AudioContext
 * here and none is needed to read a list.
 */
MODES.radio = function () {
  const ctx = B.context();
  ctx.NR = { Pak: { url: (u) => u } };
  B.load(ctx, ['audio']);

  const tracks = ctx.NR.MUSIC_TRACKS;
  if (!tracks) {
    console.error('js/audio.js does not publish NR.MUSIC_TRACKS');
    process.exit(1);
  }

  B.report({
    tracks: tracks.map((t) => ({
      key: t.key, file: t.file, gain: t.gain,
      title: t.title || null, station: t.station || null,
      freq: t.freq || null, loop: !!t.loop,
      primary: t.primary || null,
      environments: t.environments || null,
    })),
  });
};

/* Every ramp on the course, and what happens when a car is driven at it.
 *
 * A ramp exists three times over: as a row in COURSE_RAMPS, as a window armed
 * on the solver, and as geometry somebody builds. This measures all three and
 * then drives every region with the shipped driver and the shipped solver,
 * recording each launch. Whether any of it is acceptable is decided in
 * tools/check.py.
 */
MODES.ramps = async function () {
  /* The route boundaries, shared with the rival-driving probe. */
  const REGIONS = [[60, 13000], [13000, 32000], [32000, 54000], [54000, 79900],
    [79900, 111500], [112080, 131300], [132070, 173000]];

    const ctx = B.world();
    const NR = await ctx.NR.loadCore();
    const track = new NR.Track(NR.buildCourse(B.scene().centre));
    track.setWidth(NR.DRIVE_HALF, NR.ROAD_HALF);

    const RAMPS = ctx.NR.COURSE_RAMPS;
    const TELE = ctx.NR.RAMP_TELEGRAPH || 280;
    const PAST = -14;
    /* WHERE A RAMP ENDS, which is not always its lip. A ramp with a DESCENT is
       still the one the car is on all the way down the slope; letting the search
       step past it at the top would take the window off the solver with the car
       eighteen units up. Same rule as `rampEnd` in js/game.js. */
    const endOf = (r) => r.s + (r.drop || 0);

    /* ------------------------------------------------ who builds each one -- */
    const table = RAMPS.map((r) => {
      /* The window the solver is armed with - see updateRamps in js/game.js. A
         crest ramp climbs to `h` and then runs on to `lip` along a drivable top;
         everything else is the plain wedge. */
      const s0 = r.crest ? r.s - r.crest - r.len : r.s - r.len;
      const s1 = r.crest ? r.s - r.crest : r.s;
      return {
        id: r.id, level: r.level, s: r.s, len: r.len, h: r.h,
        crest: r.crest || 0, drop: r.drop || 0, lip: r.lip || r.h,
        foot: r.s - (r.crest || 0) - r.len, end: endOf(r),
        armFrom: s0, armTo: r.drop ? endOf(r) : (r.crest ? r.s : s1),
      };
    });

    /* ------------------------------------------------------- the title reel */
    const reel = (ctx.NR.ATTRACT_REEL || []).map((e) => ({
      from: e.from, to: e.to, kind: e.kind || 'drift', name: e.name,
      inside: RAMPS.filter((r) => (r.s - (r.crest || 0) - r.len) < e.to
        && endOf(r) > e.from - 40).map((r) => r.id),
    }));

    /* ------------------------------------------------------- and then drive */
    const dt = 1 / 60;
    const regions = [];
    for (let li = 0; li < REGIONS.length; li++) {
      const [from, to] = REGIONS[li];
      const car = new NR.Vehicle(track);
      const driver = new NR.Driver(track, 'HARD');
      driver.setLevel('HARD');
      driver.reset();
      car.reset(from, 0);
      let armed = null, wasAir = false, launchS = 0, peak = 0;
      const flights = [];
      const driven = {};
      const maxF = Math.round((to - from) / 30 / dt);
      for (let f = 0; f < maxF && car.sTrack < to; f++) {
        // the same arming the game does, from the same table
        let next = null;
        for (const r of RAMPS) {
          if (endOf(r) - car.sTrack < PAST) continue;
          if (!next || r.s < next.s) next = r;
        }
        const span = next ? next.len + (next.crest || 0) : 0;
        const arm = !!next && (next.s - car.sTrack) < TELE + span
          && (endOf(next) - car.sTrack) > PAST;
        if (arm) {
          if (armed !== next.id) {
            armed = next.id;
            if (next.drop) {
              car.armRampRoad(next.s - next.crest - next.len, next.s - next.crest,
                next.s, endOf(next), next.h, next.lip || next.h);
            } else if (next.crest) {
              car.armRampDeck(next.s - next.crest - next.len, next.s - next.crest,
                next.s, next.h, next.lip || next.h);
            } else car.armRamp(next.s - next.len, next.s, next.h);
          }
        } else if (armed) { armed = null; car.clearRamp(); }
        /* How high the car got WITHOUT leaving the ground, per ramp. A road ramp
           proves itself by climbing rather than by flying. */
        if (armed && !car.airborne && (car.airY || 0) > 0.05) {
          driven[armed] = Math.max(driven[armed] || 0, car.airY || 0);
        }

        car.update(dt, driver.drive(dt, car, { raceOn: true }), true);
        const air = !!car.airborne;
        if (air && !wasAir) { launchS = car.sTrack; peak = 0; }
        if (air) peak = Math.max(peak, car.airY || 0);
        if (!air && wasAir) flights.push({ a: launchS, b: car.sTrack, peak });
        wasAir = air;
      }
      regions.push({ level: li + 1, from, to, flights, driven });
    }

    /* ---------------------------------------- what else is on the deck ----- */
    const L7 = ctx.__SYNX_LEVEL7__;
    const level7 = L7 ? {
      to: L7.to,
      events: L7.events.map((e) => ({ id: e.id, from: e.from })),
      hazards: L7.hazards.map((h) => ({ id: h.id, s: h.s, eventId: h.eventId,
        telegraph: h.telegraph || 0 })),
    } : null;

    B.report({
      telegraph: TELE, past: PAST, regions_bounds: REGIONS,
      ramps: table, reel, regions, level7,
    });
};

/* What the Aurora Forge director actually builds.
 *
 * Chapter 6 is the one structure on the course the car drives OVER rather than
 * past, so "is the running surface where the solver puts the car" is a
 * question about geometry and nothing else in the tree asks it. The hall is
 * built for real - the shipped director, the shipped course, the shipped
 * solver constants - and the merged vertex and index buffers are handed over
 * as blobs for tools/check.py to drop rays through.
 *
 * The sample points come from the request rather than from here. Whether a
 * deck 0.3 units below where the solver expects it is acceptable is an opinion
 * and opinions live on the other side.
 */
MODES.forge = async function () {
  /** A GL stub that keeps the buffers instead of uploading them. */
  function stubGL(keep) {
    return {
      ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, FLOAT: 4,
      createVertexArray: () => ({}), bindVertexArray: () => {},
      createBuffer: () => ({}), bindBuffer: () => {},
      bufferData: (t, data) => { (t === 1 ? keep.verts : keep.idx).push(data); },
      enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    };
  }

    const req = B.request();
    const ctx = B.world({ performance });
    const NR = await ctx.NR.loadCore();
    const track = new NR.Track(NR.buildCourse(B.scene().centre));
    track.setWidth(NR.DRIVE_HALF, NR.ROAD_HALF);

    const keep = { verts: [], idx: [] };
    const game = { gl: stubGL(keep), scene: {}, track, time: 0, distance: 129000 };
    const World = ctx.__SYNX_FACTORY_WORLD__;
    if (!World) throw new Error('js/chapters.js does not publish __SYNX_FACTORY_WORLD__');
    const world = new World(game);
    world.build();

    const ROOF = ctx.NR.FORGE_ROOF;
    /* The BIGGEST buffer, not the first: makeCube and makeRing each hand over a
       mesh of their own in the constructor, long before the merged hall arrives. */
    const big = (a) => a.reduce((b, v) => (!b || v.length > b.length ? v : b), null);
    const V = big(keep.verts), I = big(keep.idx);
    if (!V || V.length < 1000) throw new Error('the hall built no vertices');

    /* Every point tools/check.py asked about: where it is in the world, and
       where the solver will put the car there. */
    const probes = (req.points || []).map((q) => {
      const p = track.at(q[0], {});
      const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      return [p.x + rx * q[1], p.z + rz * q[1], world.roofY(q[0])];
    });

    /* ONLY THE TRIANGLES ANYBODY IS GOING TO ASK ABOUT.
     *
     * The hall is half a million triangles and the ray casts touch a few
     * thousand of them. Handing the whole buffer over means the reader spends
     * several seconds bucketing geometry it will never look at, so the buckets
     * are computed here - which is arithmetic, not judgement - and only the
     * triangles sharing a cell with a requested point are written out.
     *
     * The rule is exactly the one the reader will apply: a triangle belongs to
     * every cell its x/z bounding box spans, and a query looks in the single
     * cell its point falls in. Anything that could have answered a query is
     * therefore here, and nothing else is. */
    const CELL = req.cell || 16;
    const want = new Set();
    for (const q of probes) {
      want.add(Math.floor(q[0] / CELL) + 'x' + Math.floor(q[1] / CELL));
    }
    const near = [];
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 8, b = I[t + 1] * 8, c = I[t + 2] * 8;
      const x0 = Math.min(V[a], V[b], V[c]), x1 = Math.max(V[a], V[b], V[c]);
      const z0 = Math.min(V[a + 2], V[b + 2], V[c + 2]);
      const z1 = Math.max(V[a + 2], V[b + 2], V[c + 2]);
      let keep2 = false;
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL) && !keep2; gx++) {
        for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
          if (want.has(gx + 'x' + gz)) { keep2 = true; break; }
        }
      }
      if (!keep2) continue;
      near.push(V[a], V[a + 1], V[a + 2], V[b], V[b + 1], V[b + 2],
        V[c], V[c + 1], V[c + 2]);
    }

    /* ------------------------------------------ the sorting floor's bores --
     * Different question, same failure. The balers are drawn in IMMEDIATE MODE -
     * one at() per box, every frame - so none of them is in the merged buffer
     * above and none of them has a collider either. Geometry with no collider
     * standing in the road is geometry the car goes through, and two of these
     * three bays are the RIGHT answer: the trial requires them to be driveable
     * end to end at speed. Sampled across a whole baler cycle, because
     * everything in here moves and a part is only clear if it is clear at every
     * point in its stroke. */
    const S = req.sortS || 120000;
    const steps = req.sortSteps || 40;
    const gate = [];
    for (let step = 0; step <= steps; step++) {
      const g6 = { gl: stubGL({ verts: [], idx: [] }), scene: {}, track,
        time: step / steps / 0.55, distance: S - 300, car: { sTrack: S - 300 } };
      const w = new World(g6);
      const out = [];
      w.at = (s, lat, y, sx, sy, sz, p) =>
        out.push([s, lat, y, sx, sy, sz, (p && p.mat && p.mat.name) || '?']);
      w.frame = (s) => ({ x: s, y: 0, z: 0, rx: 1, rz: 0, fx: 0, fz: 1 });
      w.sortGate({ s: S, live: 1, resolved: false, crush: false, crushT: 0, cleared: 0 });
      gate.push(out);
    }

    B.report({
      roof: {
        foot: ROOF.foot, floor: ROOF.floor, deck: ROOF.deck, edge: ROOF.edge,
        clearFrom: ROOF.clearFrom, clearTo: ROOF.clearTo,
      },
      cell: CELL,
      built: { vertices: V.length / 8, triangles: I.length / 3 },
      tris: B.blob('hall.tris', new Float32Array(near)),
      probes,
      gate,
      sortS: S,
    });
};

/* The recorder's two halves, driven and measured.
 *
 * `cargo test -p synx-rec` proves the encoder and the container. This is the
 * plumbing around them, which is the part that was actually broken and the
 * part no unit test can see: a worker protocol, a pixel-buffer pool, and a
 * capture loop that must never make the frame wait for the GPU.
 *
 * Everything here counts. What the counts have to be is in tools/check.py.
 */
MODES.rec = async function () {
  const fs = B.fs;
  const path = B.path;
  const ROOT = B.ROOT;

  /* ------------------------------------------------------------ the worker -- */

  /** Run js/recworker.js in a context that looks enough like a Worker. */
  function bootWorker() {
    const inbox = [];
    const ctx = B.vm.createContext({
      console, WebAssembly, URL, TextDecoder, TextEncoder, performance,
      Uint8Array, Float64Array, ArrayBuffer, Math, JSON, String, Number, Error,
      fetch: async (url) => {
        const file = path.join(ROOT, 'web/wasm', path.basename(String(url)));
        if (!fs.existsSync(file)) return { ok: false, status: 404 };
        const buf = fs.readFileSync(file);
        const res = {
          ok: true, status: 200,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
          clone: () => res,
        };
        return res;
      },
    });
    ctx.self = ctx;
    // No real location under Node, so give the worker the one it would have.
    ctx.self.location = { href: 'file:///synx/web/js/recworker.js' };
    ctx.self.postMessage = (m) => inbox.push(m);
    B.vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js/recworker.js'), 'utf8'), ctx);
    return {
      inbox,
      /* onmessage is async - it compiles the module on the first call - so the
         promise is awaited AND the loop is then given several turns. A test that
         reads the inbox one tick after posting reads an empty one and blames the
         code. */
      send: (m, transfer) => ctx.self.onmessage({ data: m, transfer }),
      settle: async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); },
    };
  }

  function riff(bytes) {
    const s = (i, n) => Buffer.from(bytes.slice(i, i + n)).toString('latin1');
    return s(0, 4) === 'RIFF' && s(8, 4) === 'AVI ';
  }

  async function measureWorker() {
    const W = bootWorker();
    const out = { began: null, handedOut: 0, handedBack: 0, stats: null, clips: [], afterEnd: null };

    W.send({ t: 'begin', w: 128, h: 72, fps: 20, quality: 70, windowMs: 20000, budgetMb: 16 });
    await W.settle();
    const ready = W.inbox.find((m) => m.t === 'ready');
    if (!ready) { out.beginReply = W.inbox.slice(); return out; }
    out.began = { ok: !!ready.ok, frameLen: ready.frameLen, step: ready.step };
    if (!ready.ok) return out;

    /* Feed it a run: dull, then two seconds of high scores in the middle. Every
       buffer is one the worker gave back, which is the point of the pool. */
    const bytes = ready.frameLen;
    let owned = [new Uint8Array(bytes)];
    for (let i = 0; i < 200; i++) {
      const px = owned.pop() || new Uint8Array(bytes);
      px.fill((i * 11) & 255);
      out.handedOut++;
      W.inbox.length = 0;
      W.send({ t: 'frame', px: px.buffer, ms: i * 50, fmt: 4, score: i >= 80 && i < 120 ? 700 : 30 });
      await W.settle();
      for (const m of W.inbox) {
        if (m.t === 'spent') { out.handedBack++; owned.push(new Uint8Array(m.px)); }
      }
      if (i === 100) W.send({ t: 'mark', label: 'OVERTAKE', ms: i * 50 });
    }

    W.inbox.length = 0;
    W.send({ t: 'stats', tag: 1 });
    await W.settle();
    const st = (W.inbox.find((m) => m.t === 'stats') || {}).stats;
    out.stats = st ? { frames: st.frames, bytes: st.bytes, marks: st.marks, spanMs: st.spanMs } : null;

    /* Every kind of save, including the automatic one. */
    for (const [kind, name, ms] of [[0, 'all', 0], [1, 'last 5 s', 5000],
      [2, 'highlight reel', 0], [3, 'AUTOMATIC', 6000]]) {
      W.inbox.length = 0;
      W.send({ t: 'save', kind, ms, tag: 'k' + kind });
      await W.settle();
      const clip = W.inbox.find((m) => m.t === 'clip');
      if (!clip) { out.clips.push({ kind, name, came: false }); continue; }
      const arr = new Uint8Array(clip.bytes);
      out.clips.push({ kind, name, came: true, frames: clip.frames || 0,
        length: arr.length, riff: riff(arr), label: clip.name || null });
    }

    /* ...and it gives the memory back. */
    W.send({ t: 'end' });
    await W.settle();
    W.inbox.length = 0;
    W.send({ t: 'stats', tag: 2 });
    await W.settle();
    const after = W.inbox.find((m) => m.t === 'stats');
    out.afterEnd = !!(after && after.stats);
    return out;
  }

  /* ------------------------------------------------------ the capture loop -- */

  /** A WebGL2 stub that records every way it could have been used synchronously. */
  function stubGL(report) {
    const E = {
      TEXTURE_2D: 1, RGBA8: 2, RGBA: 3, UNSIGNED_BYTE: 4, LINEAR: 5, CLAMP_TO_EDGE: 6,
      TEXTURE_MIN_FILTER: 7, TEXTURE_MAG_FILTER: 8, TEXTURE_WRAP_S: 9, TEXTURE_WRAP_T: 10,
      FRAMEBUFFER: 11, COLOR_ATTACHMENT0: 12, FRAMEBUFFER_COMPLETE: 13,
      READ_FRAMEBUFFER: 14, DRAW_FRAMEBUFFER: 15, COLOR_BUFFER_BIT: 16,
      PIXEL_PACK_BUFFER: 17, STREAM_READ: 18,
      SYNC_GPU_COMMANDS_COMPLETE: 19, ALREADY_SIGNALED: 20, TIMEOUT_EXPIRED: 21,
      CONDITION_SATISFIED: 22, WAIT_FAILED: 23,
    };
    let nextSync = 1;
    const gl = Object.assign({}, E, {
      createFramebuffer: () => ({}), createTexture: () => ({}), createBuffer: () => ({ id: 1 }),
      bindTexture() {}, texImage2D() {}, texParameteri() {},
      bindFramebuffer() {}, framebufferTexture2D() {},
      checkFramebufferStatus: () => E.FRAMEBUFFER_COMPLETE,
      deleteFramebuffer() {}, deleteTexture() {}, deleteBuffer() {},
      bindBuffer(target, buf) { gl._packBound = target === E.PIXEL_PACK_BUFFER ? buf : gl._packBound; },
      bufferData() {},
      blitFramebuffer() { report.blits++; },
      readPixels(x, y, w, h, fmt, type, dst) {
        report.reads++;
        /* THE WHOLE POINT. An offset into a bound PIXEL_PACK_BUFFER is the
           asynchronous form; a typed array here is the stall. */
        if (typeof dst !== 'number') {
          report.sync.push('readPixels into CPU memory - this is the synchronous stall');
        }
      },
      fenceSync() { report.fences++; return { id: nextSync++, age: 0 }; },
      clientWaitSync(sync, flags, timeout) {
        if (timeout !== 0) {
          report.sync.push('clientWaitSync with a ' + timeout + ' ns timeout - this blocks');
        }
        report.polls++;
        // the GPU takes `report.latency` polls to finish a readback
        return ++sync.age >= report.latency ? E.CONDITION_SATISFIED : E.TIMEOUT_EXPIRED;
      },
      deleteSync() {},
      getBufferSubData(target, offset, dst) {
        report.collected++;
        if (!(dst instanceof Uint8Array)) report.sync.push('getBufferSubData into a non-array');
      },
      flush() { report.flushes++; },
      finish() { report.sync.push('finish() - this waits for the whole pipeline'); },
    });
    return gl;
  }

  function measureCapture() {
    const report = { reads: 0, blits: 0, fences: 0, polls: 0, flushes: 0, collected: 0,
      latency: 2, sync: [], posted: 0, ms: 0, started: false, ready: false };

    /* js/record.js wants a window. Give it one, plus a fake Worker that answers
       `begin` at once and hands every buffer straight back. */
    const ctx = B.vm.createContext({
      console, performance, Math, JSON, String, Number, Error, Object,
      Uint8Array, ArrayBuffer, setTimeout, URL, Blob,
    });
    ctx.window = ctx;
    ctx.document = { createElement: () => ({ click() {} }) };
    ctx.Worker = function () {
      this.postMessage = (m, transfer) => {
        if (m.t === 'begin') {
          setImmediate(() => this.onmessage({ data: { t: 'ready', ok: true, step: 33 } }));
        } else if (m.t === 'frame') {
          report.posted++;
          if (!transfer || transfer[0] !== m.px) {
            report.sync.push('the frame was posted without transferring its buffer - it is copied');
          }
          setImmediate(() => this.onmessage({ data: { t: 'spent', px: m.px } }));
        }
      };
      this.onmessage = null;
    };
    B.vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js/record.js'), 'utf8'), ctx);
    const R = ctx.NR.Record;
    if (!R || !R.configure) return Object.assign(report, { noConfigure: true });

    const gl = stubGL(report);
    const car = {
      speedMph: 120, ceilingMph: 150, sTrack: 1000, airborne: false, airTime: 0,
      bodySlip: 0.1, boosting: false, impactSpeed: 0, lastHit: false,
      wrongWay: false, offroad: false,
    };
    R.attach({ gl, w: 1920, h: 1080, outW: 1920, outH: 1080, state: 'racing',
      car, rival: { sTrack: 1040 }, hud: { toast() {} } });
    R.configure({ on: true, width: 256, fps: 30, quality: 70, windowMs: 5000, budgetMb: 8 });
    report.started = !!R.on;
    if (!R.on) return report;

    return new Promise((done) => setImmediate(async () => {
      report.ready = !!R.ready;
      if (!R.ready) return done(report);

      /* Two hundred frames at 144 Hz against a 30 fps recorder. */
      const realNow = performance.now.bind(performance);
      let fake = realNow();
      performance.now = () => fake;
      for (let i = 0; i < 200; i++) {
        fake += 1000 / 144;
        report.ms += 1000 / 144;
        R.capture(1 / 144);
        /* THE EVENT LOOP TURNS BETWEEN FRAMES in a real game - each one is its
           own rAF callback - so the worker's replies are delivered and its pixel
           buffers come back. A loop that never yields starves the pool after
           three frames and measures the backpressure instead of the pacing. */
        await new Promise((r) => setImmediate(r));
      }
      performance.now = realNow;
      report.sync = [...new Set(report.sync)];
      done(report);
    }));
  }

  /* ------------------------------------------------------------------ run --- */

    const wasm = path.join(ROOT, 'web/wasm/synx_rec.wasm');
    if (!fs.existsSync(wasm)) {
      B.report({ built: false });
      return;
    }
    const worker = await measureWorker();
    const capture = await measureCapture();
    B.report({ built: true, worker, capture });
};

/* The whole campaign, resolved and then walked, without driving a metre of it.
 *
 * A scene in js/story.js is an array of lines, or a pure function of the run's
 * state that returns one - and the only state it may read is the context
 * object `storyCtx` builds. So every scene in the game can be resolved here,
 * for every value that context can take, and what comes out is exactly what a
 * player would see. There is no branch this cannot reach.
 *
 * Then the state machine is run: four campaigns to four endings, a replay on
 * the same save deciding the other way, and the prologue. Everything that
 * DRAWS is replaced with a no-op; everything that DECIDES is the shipped code.
 *
 * It measures. tools/check.py decides.
 */
MODES.story = function () {
  const fs = B.fs;
  const path = B.path;
  const ROOT = B.ROOT;
  const FLOW_DT = 1 / 60;

  // ------------------------------------------------------------------ stubs --

  function elementStub() {
    const cls = new Set();
    const el = {
      textContent: '', innerHTML: '', value: '', children: [],
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      classList: {
        add: (...n) => n.forEach((x) => cls.add(x)),
        remove: (...n) => n.forEach((x) => cls.delete(x)),
        toggle: (n, on) => { if (on === undefined ? cls.has(n) : !on) cls.delete(n); else cls.add(n); },
        contains: (n) => cls.has(n),
      },
      setAttribute(k, v) { el['a_' + k] = v; },
      getAttribute(k) { return el['a_' + k]; },
      addEventListener() {}, removeEventListener() {},
      appendChild(c) { el.children.push(c); return c; },
      append(...c) { c.forEach((x) => el.appendChild(x)); },
      querySelector() { return elementStub(); },
      querySelectorAll() { return []; },
      focus() {}, click() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; },
      offsetWidth: 10,
    };
    return el;
  }

  function documentStub() {
    const els = Object.create(null);
    return {
      body: elementStub(),
      getElementById(id) { return (els[id] = els[id] || elementStub()); },
      querySelector() { return elementStub(); },
      createElement() { return elementStub(); },
      addEventListener() {}, removeEventListener() {},
      activeElement: null,
    };
  }

  function carStub() {
    return {
      x: 0, y: 0, z: 0, yaw: 0, sTrack: 0, maxS: 0, minS: 0, lateral: 0,
      vLong: 60, vLat: 0, speed: 60, lift: 1, roadY: 0, pitch: 0, roll: 0,
      boosting: false, offroad: false, driftAmount: 0, bodySlip: 0, impact: 0,
      scrape: 0, lastHit: false, lastHitType: null, beached: 0, wrongWay: 0,
      boost: 1, engineLoad: 0, wheelSpinFx: 0, damage: 0, landed: 0, landing: 0,
      raceModeMultiplier: 1, gripScale: 1, powerScale: 1, speedCap: Infinity,
      reset(s, lat) { this.sTrack = s || 0; this.maxS = this.sTrack; this.lateral = lat || 0; },
      update() {}, placeLateral(s, lat) { this.sTrack = s; this.lateral = lat; },
      armRamp() {}, clearRamp() {}, fitEngine() {},
    };
  }

  function gameStub() {
    const track = {
      length: 175800,
      at(s, out) { out = out || {}; out.x = 0; out.y = 0; out.z = s; out.yaw = 0; out.curv = 0; out.tunnel = false; return out; },
      project(x, z) { return { s: z, sExact: z, lateral: x, index: 0, yaw: 0, curv: 0 }; },
    };
    const audioCalls = [];
    const audio = new Proxy({}, { get: () => (...a) => { audioCalls.push(a); } });
    return {
      car: carStub(), rival: carStub(), track, audio, audioCalls,
      state: 'menu', levelIndex: 0, diffIndex: 1, distance: 0, progress: 0, time: 0,
      fade: 0, fadeTarget: 0, flash: 0, shake: 0, eye: [0, 0, 0], target: [0, 0, 0], fov: 55,
      startAt: 60, finishAt: 13000, raceTime: 0, countdown: 0, lastBeep: -1,
      won: true, place: 1, rivalGap: 0, raceOver: false, simulating: true,
      cleared: [0, 0, 0, 0, 0, 0, 0],
      levels: [{ from: 60, to: 13000 }], level: { from: 60, to: 13000 },
      difficulties: ['EASY', 'MEDIUM', 'HARD', 'IMPOSSIBLE'],
      driver: { setLevel() {}, reset() {}, personality: null, paceScale: 1, gripScale: 1 },
      scene: { time: 0, wet: 0, sunColor: [1, 1, 1], ambInt: 1 },
      input: { sample: () => ({ throttle: 1, steer: 0, brake: 0, boost: false, ebrake: false }) },
      menuItems: [{}],
      applyLevel() { this.level = this.levels[0]; },
      resetCar() { this.car.reset(this.startAt, -5.5); this.rival.reset(this.startAt, 5.5); },
      updateCamera() {}, updateAtmosphere() {}, idleFlyby() {}, finish() {},
      hideCursorForRun() {}, syncCursorVisibility() {}, toMenu() { this.state = 'menu'; },
      dentBetween() {}, recordImpact() {},
    };
  }

  function load() {
    const ctx = B.vm.createContext({ console, performance: { now: () => Date.now() } });
    ctx.window = ctx;
    ctx.global = ctx;
    ctx.setTimeout = () => 0;
    ctx.document = documentStub();
    ctx.addEventListener = () => {};
    const noop = () => {};
    /* The smallest stub story.js will attach to: everything it reaches for at
       load time and nothing else. The flow phase fills in the rest. */
    ctx.NR = {
      Game: function Game() {}, Vehicle: carStub, Driver: function Driver() {},
      M: { clamp: (v, a, b) => Math.max(a, Math.min(b, v)), damp: (a, b) => b, angDiff: () => 0 },
      M4: { make: () => [], identity: (m) => m, mul: noop },
      Save: { getJSON: () => null, setJSON: noop },
      Pak: { url: (u) => u },
      Gate: { open: () => true, lock: noop, clear: noop },
      collideCars: () => 0,
    };
    ctx.NR.Game.prototype = {};
    B.vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js/story.js'), 'utf8'), ctx);
    if (!ctx.NR.STORY_CHAPTERS) throw new Error('story.js did not attach to the stub');
    return ctx;
  }

  // ----------------------------------------------------------- the script ---

  const lineOf = (l) => (l && typeof l === 'object'
    ? { speaker: l.speaker, text: l.text, expression: l.expression || null,
        shot: l.shot || null, wait: l.wait === undefined ? null : l.wait,
        hold: l.hold === undefined ? null : l.hold }
    : { bad: true });

  function script(NR) {
    const CH = NR.STORY_CHAPTERS;
    const scene = NR.STORY_SCENE;
    const pick = NR.STORY_PICK;
    const ctxs = [-3, -1, 0, 1, 3].map((resolve) =>
      ({ resolve, path: NR.STORY_PATH_OF(resolve), choices: {}, chapterId: 0 }));

    const chapters = [];
    for (let id = 1; id <= NR.STORY_LAST_CHAPTER; id++) {
      const c = CH[id];
      if (!c) { chapters.push({ id, missing: true }); continue; }
      const variants = [];
      for (const base of ctxs) {
        const cc = Object.assign({}, base, { chapterId: id });
        const parts = {};
        let arrays = true;
        for (const key of ['coldOpen', 'intro', 'win']) {
          const lines = scene(c[key], cc);
          if (!Array.isArray(lines)) { arrays = false; parts[key] = null; continue; }
          parts[key] = lines.map(lineOf);
        }
        variants.push({ path: cc.path, resolve: base.resolve, arrays, parts,
          diff: pick(c.diff, cc, 1), brief: pick(c.brief, cc, ''), rating: pick(c.rating, cc, '') });
      }
      /* A FORK HAS TO ACTUALLY FORK. Counting lines proves nothing - both sides
         are usually the same length - so the TEXT is read down each path and the
         difficulty with it. */
      const at = (p) => ({ resolve: p === 'edge' ? 3 : -3, path: p, choices: {}, chapterId: id });
      const say = (p) => ['coldOpen', 'intro', 'win']
        .map((k) => scene(c[k], at(p)).map((l) => l.speaker + ':' + l.text).join('|')).join('||');
      chapters.push({
        id, title: c.title,
        variants,
        textForks: say('edge') !== say('open'),
        diffOpen: pick(c.diff, at('open'), 1),
        diffEdge: pick(c.diff, at('edge'), 1),
        declared: ['coldOpen', 'intro', 'win', 'diff', 'brief', 'rating']
          .some((k) => typeof c[k] === 'function'),
      });
    }

    const choices = {};
    for (const k of Object.keys(NR.STORY_CHOICES)) {
      const d = NR.STORY_CHOICES[k];
      choices[k] = { after: d.after, chapterExists: !!CH[d.after] };
      for (const side of ['edge', 'open']) {
        const sd = d[side] || {};
        choices[k][side] = { label: sd.label || null, sub: sd.sub || null, tag: sd.tag || null,
          echo: (sd.echo || []).map(lineOf) };
      }
    }

    const endings = {};
    for (const key of Object.keys(NR.STORY_ENDINGS)) {
      const E = NR.STORY_ENDINGS[key];
      endings[key] = {
        title: E.title || null, subtitle: E.subtitle || null, kicker: E.kicker || null,
        lines: (E.lines || []).map(lineOf), coda: (E.coda || []).map(lineOf),
        cards: (E.cards || []).map((c) => (Array.isArray(c) ? c.length : null)),
      };
    }

    const cast = {};
    for (const k of Object.keys(NR.STORY_CAST)) cast[k] = Object.keys(NR.STORY_CAST[k].art || {});

    return { lastChapter: NR.STORY_LAST_CHAPTER, chapters, choices, endings, cast };
  }

  // ------------------------------------------------------------- the flow ---

  /** Replace everything that draws with a no-op, keeping everything that decides. */
  function muteRendering(SM) {
    const P = SM.prototype;
    const noop = function () {};
    for (const k of ['baseTick', 'conversationShot', 'establishingShot', 'carShot',
      'pairShot', 'overShot', 'trackShot', 'commitShot', 'cutTo', 'pulseScan',
      'textBlip', 'silenceCar', 'updateStoryAtmosphere', 'spawnInvitationalPack',
      'updateInvitationalPack', 'resolveInvitationalCollisions', 'tutorialTick']) P[k] = noop;
    P.setVehicle = function (car, s, lateral) { if (car) { car.sTrack = s; car.lateral = lateral || 0; } };
    P.guardEye = function (eye) { return eye; };
  }

  /* StoryManager is a class, so it is constructed rather than applied - and its
     constructor reads `global.document`, which is why the sandbox's document is
     swapped before it runs. NR.Save is stubbed empty, so every run is a first
     playthrough rather than whatever is in this machine's storage. */
  function makeStory(ctx, g) {
    ctx.document = documentStub();
    const story = new ctx.NR.StoryManager(g);
    g.story = story;
    return story;
  }

  /** One simulated ENTER per frame - a HELD key - for as long as a card is up. */
  function pump(story, state) {
    if (!story.dialogue.active) return;
    const before = story.dialogue.index;
    const wasTyping = !story.dialogue.finishedLine;
    story.dialogue.advance();
    if (story.dialogue.index !== before || !story.dialogue.active) {
      state.lines++;
      if (!wasTyping) state.fastest = Math.min(state.fastest, state.age);
      state.age = 0;
    }
  }

  /* `carry` replays on an existing manager and its existing save, which is what
     the closing card promises: the other ending is reachable from the same seven
     chapters by deciding differently. */
  function runCampaign(ctx, choices, carry) {
    const g = carry ? carry.g : gameStub();
    const story = carry ? carry.story : makeStory(ctx, g);
    const seen = new Set();
    const asked = [];
    const state = { lines: 0, fastest: Infinity, age: 0 };
    const LIMIT = 60 * 60 * 30;
    let frames = 0;

    story.startChapter(1, {});
    while (frames++ < LIMIT) {
      seen.add(story.mode);
      story.update(FLOW_DT);
      state.age += FLOW_DT;
      pump(story, state);

      if (story.mode === 'choice' && story.pendingChoice) {
        const which = choices[story.pendingChoice.id] || 'open';
        asked.push(story.pendingChoice.id + ':' + which);
        story.commitChoice(which);
        continue;
      }
      if (story.mode === 'continuePrompt') { story.chooseContinue(true); continue; }
      /* The race belongs to the game, so it is resolved the way the game
         resolves it: the player crosses the line in front. */
      if (story.mode === 'race') {
        g.won = true;
        g.car.sTrack = g.finishAt + 10;
        story.handleFinish(function () {});
        continue;
      }
      if (story.mode === 'hub' || story.mode === 'none') break;
    }
    return {
      seen: [...seen], asked, frames, lines: state.lines,
      fastest: state.fastest === Infinity ? null : state.fastest,
      ending: story.save.endingSeen, resolve: story.save.resolve,
      completed: story.save.completedChapters.length, timedOut: frames >= LIMIT,
      story, g,
    };
  }

  /* The opening, which is where the reported fault lived: the prologue, its
     anonymous card, and the tutorial that follows it. */
  function runPrologue(ctx) {
    const g = gameStub();
    const story = makeStory(ctx, g);
    const seen = new Set();
    const state = { lines: 0, fastest: Infinity, age: 0 };
    const LIMIT = 60 * 60 * 8;
    let frames = 0;
    story.startPrologue(false);
    while (frames++ < LIMIT) {
      seen.add(story.mode);
      story.update(FLOW_DT);
      state.age += FLOW_DT;
      pump(story, state);
      if (story.mode === 'coldOpen' || story.mode === 'chapterTitle') break;
    }
    return { seen: [...seen], frames, lines: state.lines,
      fastest: state.fastest === Infinity ? null : state.fastest,
      timedOut: frames >= LIMIT };
  }

  const strip = (r) => ({ seen: r.seen, asked: r.asked, frames: r.frames, lines: r.lines,
    fastest: r.fastest, ending: r.ending, resolve: r.resolve, completed: r.completed,
    timedOut: r.timedOut });

  function flow(ctx) {
    muteRendering(ctx.NR.StoryManager);
    const runs = {};
    const plans = {
      edge: { d1: 'edge', d2: 'edge', d3: 'edge' },
      open: { d1: 'open', d2: 'open', d3: 'open' },
      splitEdge: { d1: 'edge', d2: 'open', d3: 'edge' },
      splitOpen: { d1: 'open', d2: 'edge', d3: 'open' },
    };
    for (const name of Object.keys(plans)) {
      try { runs[name] = strip(runCampaign(ctx, plans[name])); }
      catch (e) { runs[name] = { threw: String(e && e.message || e) }; }
    }
    /* THE CLAIM ON THE CLOSING CARD, TESTED. Finish one way, then play again on
       the same save deciding the other way. If a decision were only ever asked
       once - which is how it was first written - this run would end where the
       first one did and the card would be lying. */
    let replay = null;
    try {
      const first = runCampaign(ctx, plans.edge);
      const again = runCampaign(ctx, plans.open, { story: first.story, g: first.g });
      replay = { first: strip(first), again: strip(again) };
    } catch (e) { replay = { threw: String(e && e.message || e) }; }

    let prologue = null;
    try { prologue = runPrologue(ctx); }
    catch (e) { prologue = { threw: String(e && e.message || e) }; }

    return { runs, replay, prologue };
  }

    const ctx = load();
    B.report({ dt: FLOW_DT, script: script(ctx.NR), flow: flow(ctx) });
};

/* The rival, driven for real: the shipped WASM, the shipped course geometry,
 * the shipped four-wheel solver and the shipped racing line, with nothing
 * rendered.
 *
 * Four modes, one process each, chosen by AI_MODE:
 *
 *   driver    every route at every difficulty, campaign engine
 *   free      the same with the Forge engine fitted, which has a hard cap
 *   boss      Chapter 7's R-IX under its own director
 *   tactics   the manoeuvres, rather than the lap: an overtake past a real
 *             slower car, a reset, an obstacle corridor, a wall recovery and
 *             the boss's pace curve
 *
 * It measures. Every threshold is in tools/check.py.
 */
MODES.ai = async function () {
  const REGIONS = [[60, 13000], [13000, 32000], [32000, 54000], [54000, 79900],
    [79900, 111500], [112080, 131300], [132070, 173000]];
  const LEVELS = ['EASY', 'MEDIUM', 'HARD', 'IMPOSSIBLE'];
  const env = process.env;

    const ctx = B.world();
    const NR = await ctx.NR.loadCore();
    const track = new NR.Track(NR.buildCourse(B.scene().centre));
    const car = new NR.Vehicle(track);
    const driver = new NR.Driver(track, 'HARD');
    const mode = env.AI_MODE || 'driver';

    if (mode === 'tactics') {
      const dt = 1 / 60;
      const traffic = new NR.Vehicle(track);
      track.setWidth(NR.DRIVE_HALF, NR.ROAD_HALF);
      const out = {};

      /* An actual slower vehicle, including pair collisions: a pass must succeed
         without hitting it or either barrier. No teleported ghost in this one. */
      driver.setLevel('IMPOSSIBLE'); driver.reset();
      car.reset(400, 0); traffic.reset(455, 0);
      let contacts = 0, walls = 0;
      for (let f = 0; f < 45 * 60; f++) {
        traffic.update(dt, { throttle: Math.max(0, Math.min(1, (45 - traffic.vLong) * 0.4)),
          brake: traffic.vLong > 47 ? 0.2 : 0 }, true);
        const cmd = driver.drive(dt, car, { raceOn: true, rivalS: traffic.sTrack,
          rivalX: traffic.x, rivalZ: traffic.z });
        car.update(dt, cmd, true);
        if (NR.collideCars(car, traffic) > 0) contacts++;
        if (car.lastHit && car.lastHitType === 'wall') walls++;
        car.lastHit = false;
      }
      out.overtake = { lead: car.sTrack - traffic.sTrack, contacts, walls };

      /* The same frame after a restart must not remember a previous passing lane. */
      driver.boostHold = 20;
      driver.laneHint = () => 14;
      driver.reset();
      car.reset(400, 0);
      const fresh = new NR.Driver(track, 'IMPOSSIBLE');
      const world = { raceOn: true };
      const a = driver.drive(dt, car, world);
      const b = fresh.drive(dt, car, world);
      out.reset = { same: JSON.stringify(a) === JSON.stringify(b), laneHintCleared: driver.laneHint === null };

      /* Hard obstacle guidance overrides a pass and reaches the corridor asked for. */
      driver.reset(); car.reset(400, 0);
      driver.laneHint = () => 13.2;
      for (let f = 0; f < 10 * 60; f++) {
        const p = track.at(car.sTrack + 25);
        car.update(dt, driver.drive(dt, car, { raceOn: true, rivalS: car.sTrack + 25,
          rivalX: p.x, rivalZ: p.z }), true);
      }
      out.corridor = { lateral: car.lateral, want: 13.2, offroad: !!car.offroad };

      /* ...and a car left facing a wall has to get itself going again. */
      out.recovery = [];
      for (const side of [-1, 1]) {
        driver.reset();
        car.reset(800, side * 15);
        car.minS = 400;
        car.yaw += side * 1.3;
        for (let f = 0; f < 25 * 60; f++) car.update(dt, driver.drive(dt, car, { raceOn: true }), true);
        out.recovery.push({ side, sTrack: car.sTrack, vLong: car.vLong });
      }

      /* The boss must not lift when the player boosts or the lead changes hands. */
      const hunt = NR.chapter7HuntPace;
      out.hunt = [];
      for (const gap of [-500, -41, -39, -2, 0, 2, 40, 500]) {
        const o = { confidence: 1, playerV: 100 };
        out.hunt.push({ gap, plain: hunt(gap, o).wantV,
          boosting: hunt(gap, Object.assign({}, o, { playerBoosting: true })).wantV });
      }
      out.huntSeam = {
        before: hunt(-41, { confidence: 1, playerV: 120 }).wantV,
        after: hunt(-39, { confidence: 1, playerV: 120 }).wantV,
      };
      B.report({ mode, tactics: out });
      return;
    }

    const rows = [];
    const selected = env.AI_LEVEL ? [Number(env.AI_LEVEL) - 1] : REGIONS.map((_, i) => i);
    const difficulties = env.AI_DIFFICULTY ? [env.AI_DIFFICULTY] : LEVELS;
    for (const region of selected) {
      for (const difficulty of difficulties) {
        const [start, finish] = REGIONS[region];
        track.setWidth(region === 6 ? 30 : NR.DRIVE_HALF, region === 6 ? 32 : NR.ROAD_HALF);
        driver.setLevel(difficulty);
        driver.reset();
        driver.personality = difficulty === 'IMPOSSIBLE' ? 'predator'
          : ['ryker', 'kael', 'nova', 'ryker', 'ryker', 'nova', 'predator'][region];
        car.reset(start, 5.5);
        // Campaign rivals keep the stock engine; the free-roam entry equips both
        // cars with the Forge engine, whose hard speed cap matters here.
        if (mode === 'free') car.fitEngine('swap');

        const game = Object.create(NR.Game.prototype);
        Object.assign(game, { driver, rival: car,
          car: { sTrack: start, vLong: 90, boosting: false },
          diffIndex: LEVELS.indexOf(difficulty),
          hud: { toast() {} }, audio: { boostHit() {} }, freeRoamMode: { active: false } });
        const boss = Object.create(NR.PredatorDirector.prototype);
        Object.assign(boss, { g: game, ui: {}, rivalry: 1, modeActive: false, lastDt: 1 / 60,
          trapRun: false, toast() {}, audio() {}, say() {} });
        if (mode === 'boss') {
          boss.baseCfg = NR.AI_LEVELS.IMPOSSIBLE;
          boss.baseSkill = boss.baseCfg.skill;
          boss.cfg = Object.assign({}, boss.baseCfg);
          driver.cfg = boss.cfg;
        }

        let frames = 0, wallFrames = 0, offroadFrames = 0, maxSlip = 0;
        let minSpeed = Infinity, firstWall = null, nonFinite = false;
        const dt = 1 / Number(env.AI_HZ || 60);
        const seconds = Number(env.AI_SECONDS || 1200);
        for (; frames * dt < seconds && car.sTrack < finish; frames++) {
          // The player repeatedly crosses the lead, but on a separate lane:
          // proximity must not switch off race pace or start an oscillation.
          const gap = Number(env.AI_GAP || 0) + 32 * Math.sin(frames * dt * 0.4);
          game.car.sTrack = car.sTrack + gap;
          if (mode === 'free') game.updateFreeRoamRival(dt);
          if (mode === 'boss') {
            boss.lastDt = dt;
            boss.rivalry = 0.5 + 0.5 * Math.sin(frames * dt * 0.1);
            boss.modeActive = frames * dt % 100 > 70;
            boss.trapRun = game.car.sTrack < 159840;
            game.car.boosting = frames * dt % 30 < 8;
            game.car.vLong = boss.modeActive ? 120 : game.car.boosting ? 105 : 85;
            boss.applyModel();
          }
          const p = track.at(car.sTrack + gap);
          const cmd = driver.drive(dt, car, { raceOn: true, rivalS: car.sTrack + gap,
            rivalX: p.x - Math.cos(p.yaw) * 6, rivalZ: p.z + Math.sin(p.yaw) * 6,
            finishAt: finish });
          car.update(dt, cmd, true);
          if ((car.lastHitType === 'wall' && car.lastHit) || car.scrape > 0.1) {
            wallFrames++;
            if (!firstWall) {
              firstWall = { s: Math.round(car.sTrack), speed: +car.vLong.toFixed(1),
                target: +driver.lastTarget.toFixed(1), lane: +car.lateral.toFixed(1),
                steer: +cmd.steer.toFixed(2) };
            }
          }
          if (car.offroad) offroadFrames++;
          maxSlip = Math.max(maxSlip, Math.abs(car.bodySlip));
          if (frames * dt > 10) minSpeed = Math.min(minSpeed, car.vLong);
          car.lastHit = false;
          if (![car.x, car.z, car.vLong, cmd.steer, driver.lastTarget].every(Number.isFinite)) {
            nonFinite = true;
            break;
          }
        }
        rows.push({ level: region + 1, difficulty, mode, hz: 1 / dt,
          gapBase: Number(env.AI_GAP || 0), seconds: +(frames * dt).toFixed(1),
          completed: car.sTrack >= finish, distance: Math.round(car.sTrack - start),
          pace: +((car.sTrack - start) / (frames * dt)).toFixed(2),
          wallPercent: +(100 * wallFrames / frames).toFixed(3), offroadFrames,
          maxSlip: +maxSlip.toFixed(3), minSpeed: +minSpeed.toFixed(1),
          firstWall, nonFinite });
      }
    }
    B.report({ mode, seconds: Number(env.AI_SECONDS || 1200), rows });
};

/* ------------------------------------------------------------------ run --- */

const WANT = process.argv[3];
if (!MODES[WANT]) {
  console.error('usage: node tools/probes/probe.js <out-dir> <'
    + Object.keys(MODES).join('|') + '>');
  process.exit(2);
}
B.main(MODES[WANT]);
