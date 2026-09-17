/* SYNX // THE RECORDER.
 *
 * A replay buffer and a clip writer. The encoder is Rust - see crates/synx-rec
 * - it runs in a Web Worker, and this is the half that decides WHEN to
 * capture, HOW INTERESTING each frame was, and where the finished file goes.
 *
 * # What a player gets
 *
 *   F8   RECORDING ON / OFF. It is OFF when the game starts, always. A feature
 *        that costs memory and a readback is a feature a player opts into.
 *   F9   SAVE THE LAST THIRTY SECONDS. The instant replay: whatever just
 *        happened is already in the buffer, so the key is a save rather than a
 *        start.
 *   F10  MARK THIS MOMENT.
 *
 * ...and at the end of a run the recorder reads back over everything it is
 * holding, frame by frame, works out which stretch was the best one, cuts it
 * and writes it. A player who never touches a key after F8 gets a file of
 * their best moment without asking for it. That is the automatic mode, and the
 * search is `save_best` in crates/synx-rec/src/reel.rs.
 *
 * # The three things that made the old one unusable, and what replaced them
 *
 * THE READBACK WAS SYNCHRONOUS. `gl.readPixels` into a CPU array makes the
 * thread wait for the GPU to finish everything queued and then copies the
 * framebuffer back across the bus, thirty times a second, in the middle of the
 * frame. It reads into a PIXEL PACK BUFFER now - which returns immediately,
 * because the destination is on the card - and a fence is dropped behind it.
 * The fence is polled with a ZERO timeout on later frames, and the pixels are
 * collected once the GPU says they are there, usually one or two frames later.
 * A replay does not care that a frame arrives two frames late; the game cares
 * very much that nothing waits. (A non-zero timeout is the trap here: it is
 * the same stall wearing a different name.)
 *
 * THE ENCODE RAN HERE. It runs in js/recworker.js now, on its own thread, with
 * its own wasm module and its own linear memory - which also means the ring's
 * ninety-odd megabytes stop growing the simulation core's memory and detaching
 * every typed-array view the rest of the game holds over it.
 *
 * THE SAVE WENT THROUGH JSON. `Array.from(bytes)` on a twenty-five megabyte
 * clip builds twenty-five million boxed numbers, and the IPC then serialised
 * them to a string. That is the freeze: seconds of unresponsive game per save,
 * every time. The bytes go to the host as a RAW BODY now - see `write` below
 * and `clip_write` in src-tauri/src/main.rs - so a save is a memcpy and a
 * write, and the car never stops answering the wheel.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});
  const doc = global.document;

  /* The defaults. Every one of them is a settings row - see js/settings.js -
     and these are what a fresh install records at.

     `on` IS FALSE. The recorder is opt-in: F8, or the row on the options
     screen. Nothing is captured, nothing is allocated and no worker is started
     until somebody asks for one. */
  const DEF = {
    on: false,
    width: 854,           // 480p, 16:9
    fps: 30,
    quality: 72,
    windowMs: 30000,      // half a minute of ring
    budgetMb: 96,
    replayMs: 30000,      // what F9 writes
    autoMs: 14000,        // ...and how long the automatic mode's cut is
  };

  /* WHAT COUNTS AS A HIGHLIGHT, and every one of them is something the game
     already knows. A recorder that needs the game to be instrumented for it is
     a recorder that stays switched off; these are all existing events. */
  const REASONS = {
    win: 'WIN',
    cleanLanding: 'CLEAN LANDING',
    overtake: 'OVERTAKE',
    drift: 'DRIFT CHAIN',
    nearMiss: 'NEAR MISS',
    crash: 'BIG ONE',
    chapter: 'CHAPTER CLEAR',
    record: 'NEW RECORD',
    raceMode: 'RACE MODE',
    roof: 'THE BROKEN ROOF',
  };

  /* `kind` as crates/synx-rec understands it. */
  const KIND = { all: 0, replay: 1, reel: 2, auto: 3 };

  /* How many readbacks may be in the air at once. Three is the useful number:
     one being filled by the GPU, one whose fence has not come back yet, and
     one spare so a slow frame never has to wait for a slot. More would only
     buy latency nobody can see. */
  const SLOTS = 3;

  let g = null;                 // the game
  let cfg = Object.assign({}, DEF);
  let on = false;               // is the ring live
  let w = 0, h = 0;             // capture size
  let fb = null, tex = null;    // the small target the frame is scaled into
  let slots = [];               // the readbacks in flight
  let pool = [];                // pixel buffers circulating with the worker
  let outstanding = 0;          // buffers the worker currently holds
  let t0 = 0;                   // the clock the ring is stamped against
  let stepMs = 33;              // the pacing interval the worker reported
  let lastWant = -1e9;          // when the last frame was accepted
  let worker = null, ready = false, failed = '';
  let pending = null;           // a save in flight: { kind, at }
  let seq = 0;
  let stats = null, statsAt = -1e9;
  let hitFade = 0, lastImpact = 0;  // the director's memory of a bang
  let endWanted = false;            // a run ended; save when the ring answers

  /** Milliseconds since the recorder started, which is what the ring stamps. */
  const now = () => Math.max(0, ((global.performance ? performance.now() : Date.now()) - t0) | 0);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

  function toast(text, colour) {
    if (g && g.hud && g.hud.toast) g.hud.toast(text, colour || '#5affc0');
  }

  /* ------------------------------------------------------- the GL target --
   *
   * One texture, one framebuffer and `SLOTS` pixel buffers, made once per
   * size. The main frame is blitted into the texture with the driver's own
   * scaler, which is free, rather than being read at window size and scaled on
   * the CPU, which is not.
   */
  function target(gl) {
    if (fb && tex && slots.length) return true;
    fb = gl.createFramebuffer();
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { drop(gl); return false; }

    const bytes = w * h * 4;
    for (let i = 0; i < SLOTS; i++) {
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      /* STREAM_READ: written once by the GPU, read once by us, then thrown
         away. Telling the driver that is what lets it put the allocation
         somewhere the readback does not have to travel. */
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      slots.push({ pbo, sync: null, t: 0, score: 0 });
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return true;
  }

  function drop(gl) {
    for (const s of slots) {
      if (!gl) break;
      if (s.sync) gl.deleteSync(s.sync);
      if (s.pbo) gl.deleteBuffer(s.pbo);
    }
    slots = [];
    pool = [];
    outstanding = 0;
    if (!gl) { fb = null; tex = null; return; }
    if (fb) gl.deleteFramebuffer(fb);
    if (tex) gl.deleteTexture(tex);
    fb = null; tex = null;
  }

  /** A buffer to collect a readback into. They circulate; see the worker. */
  function take() {
    const b = pool.pop();
    if (b && b.byteLength === w * h * 4) return b;
    return new Uint8Array(w * h * 4);
  }

  /* ---------------------------------------------------------- THE DIRECTOR --
   *
   * How interesting was this frame, 0..1000.
   *
   * Everything here is something the game already computes for its own
   * reasons, which is the only kind of signal worth using: a recorder that
   * needs the simulation instrumented for it is a recorder that gets switched
   * off. Speed is read against the CAR'S OWN CEILING rather than an absolute,
   * because the Forge rebuild changes what fast means halfway through chapter
   * six and a fixed number would call the same driving dull afterwards.
   *
   * The terms that multiply by pace do so deliberately. A car parked next to a
   * rival is not a moment; a car alongside one at two hundred is the moment.
   * Sideways in the pit lane is not a drift.
   */
  /**
   * WATCHED ON EVERY FRAME, not on every captured one.
   *
   * A bang is reported by the solver on the single frame it happened, and the
   * recorder only looks at one game frame in five. Sampling the impact at
   * capture rate misses most of them outright - and decaying the memory of one
   * with the GAME's frame time while being called at the CAPTURE's rate makes
   * the tail five times too long into the bargain. So the cheap half runs
   * every frame and the rest is read when a frame is actually taken.
   */
  function watch(dt) {
    if (!g || !g.car) return;
    const car = g.car;
    const impact = car.impactSpeed || 0;
    if (impact > lastImpact + 0.5 || car.lastHit) hitFade = 1;
    lastImpact = impact;
    hitFade = Math.max(0, hitFade - (dt > 0 ? Math.min(dt, 0.1) : 0.016) * 0.7);
  }

  function score() {
    if (!g || !g.car) return 0;
    const car = g.car;
    /* A menu, a pause or a cutscene is still worth CAPTURING - a player who
       hits F9 after a finish expects the finish to be in it - but it must not
       be allowed to win the automatic mode's search. */
    const driving = g.state === 'racing' || g.state === 'countdown';

    const ceiling = Math.max(60, car.ceilingMph || 0);
    const pace = clamp01((car.speedMph || 0) / ceiling);

    let close = 0;
    const r = g.rival;
    if (r && r.sTrack !== undefined) {
      const d = Math.abs((car.sTrack || 0) - (r.sTrack || 0));
      close = clamp01((200 - d) / 140);
    }

    const air = car.airborne ? clamp01((car.airTime || 0) / 1.1) : 0;
    const slide = clamp01(Math.abs(car.bodySlip || 0) / 0.42);

    /* `hitFade` is a spike with a tail on it, kept by `watch` above: the
       impulse lands on one frame and what makes it readable is the second
       either side. */
    let v = 0.30 * pace
      + 0.26 * close * pace
      + 0.30 * air
      + 0.20 * slide * pace
      + 0.10 * (car.boosting ? 1 : 0)
      + 0.30 * hitFade
      + 0.12 * (g.raceModeActive ? 1 : 0);

    // going the wrong way at speed is not a highlight, it is a mistake
    if (car.wrongWay) v *= 0.2;
    if (car.offroad) v *= 0.7;
    if (!driving) v *= 0.15;
    return Math.round(1000 * clamp01(v));
  }

  /* ------------------------------------------------------------ the loop -- */

  /** Is a frame stamped `t` wanted, by the pacing the worker reported?
   *
   *  Answered HERE rather than by asking the ring, because the answer is
   *  needed before the readback is started and the ring is on another thread.
   *  It mirrors `Reel::wants`, and the ring is still the authority - a frame
   *  that slips through is declined there and costs an encode, not a bug. */
  function wants(t) { return t - lastWant + 1 >= stepMs; }

  /**
   * Collect any readback the GPU has finished with.
   *
   * Polled with a ZERO timeout: `clientWaitSync(sync, 0, 0)` asks "is it done"
   * and returns immediately either way. Anything else here - a timeout, a
   * `finish`, a `getBufferSubData` on a buffer whose fence has not signalled -
   * is the stall this whole design exists to avoid.
   */
  function drain(gl) {
    for (const s of slots) {
      if (!s.sync) continue;
      const st = gl.clientWaitSync(s.sync, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) continue;         // not yet; ask again next frame
      gl.deleteSync(s.sync);
      s.sync = null;
      if (st === gl.WAIT_FAILED) continue;             // the context is in trouble; drop it
      const dst = take();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dst);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      outstanding++;
      worker.postMessage(
        { t: 'frame', px: dst.buffer, ms: s.t, fmt: 4, score: s.score },
        [dst.buffer]);
    }
  }

  /**
   * Offer the frame that has just been drawn.
   *
   * Called from the very end of Game.draw, after the final blit, so what is on
   * the default framebuffer is exactly what the player is looking at - the
   * grade, the bloom, the HUD and all.
   */
  function capture(dt) {
    if (!on || !ready || !g || !g.gl) return;
    watch(dt);
    const gl = g.gl;
    if (!target(gl)) { stop(); return; }

    drain(gl);

    const t = now();
    if (!wants(t)) return;
    /* BACKPRESSURE, not a queue. If every slot is still in the air, or the
       worker has not given a buffer back yet, this frame is simply not taken.
       A recorder that lets work pile up when the machine is busy is a
       recorder that makes a busy machine worse. */
    const s = slots.find((x) => !x.sync);
    if (!s || outstanding >= SLOTS) return;

    /* Scale the finished frame into the small target with the driver's own
       blit: one call, and it happens on the GPU. */
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
    gl.blitFramebuffer(
      0, 0, g.outW || g.w, g.outH || g.h,
      /* Flipped vertically on the way in: GL's origin is bottom-left and every
         video format's is top-left, so the flip is free here and would be a
         whole extra pass over the picture anywhere else. */
      0, h, w, 0,
      gl.COLOR_BUFFER_BIT, gl.LINEAR);

    /* ...and read it into a buffer that lives on the card. This returns at
       once; the pixels are not here yet and are not wanted yet.
       One bind, not three: FRAMEBUFFER sets the read and the draw target
       together, and the read target is the only one that matters here. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    s.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    /* The flush matters: without it the fence can sit in an unsubmitted
       command buffer and never signal, and the recorder quietly records
       nothing at all. */
    gl.flush();
    s.t = t;
    s.score = score();
    lastWant = t;
  }

  /* ---------------------------------------------------------- the worker -- */

  function onWorker(ev) {
    const m = ev.data;
    if (!m) return;
    if (m.t === 'spent') {
      outstanding = Math.max(0, outstanding - 1);
      if (pool.length < SLOTS + 1) pool.push(new Uint8Array(m.px));
      return;
    }
    if (m.t === 'ready') {
      ready = !!m.ok;
      stepMs = m.step || 33;
      if (!ready) { failed = 'the encoder refused that size'; stop(); }
      return;
    }
    if (m.t === 'fail') {
      failed = m.why || 'the encoder could not be loaded';
      if (global.console) global.console.warn('SYNX: recorder unavailable - ' + failed);
      stop();
      toast('RECORDER UNAVAILABLE', '#ff8a3a');
      return;
    }
    if (m.t === 'stats') {
      stats = m.stats;
      /* THE END OF A RUN IS DECIDED HERE, not where it was asked.
         "Is there anything worth keeping" is a question about the ring, the
         ring is on this worker, and the answer therefore has a round trip in
         it. Reading a cached `stats` at the moment the run ended would read
         whatever the HUD last asked for, which on a short run is nothing at
         all - and the automatic save would silently never happen. */
      if (endWanted) {
        endWanted = false;
        if (!pending && stats && stats.frames > 4) {
          save(stats.marks > 0 ? 'reel' : 'auto', { quiet: true });
        }
      }
      return;
    }
    if (m.t === 'clip') {
      const req = pending;
      pending = null;
      if (!m.frames || !m.bytes) {
        toast(req && req.quiet ? '' : 'NOTHING TO SAVE', '#ffb400');
        return;
      }
      write(new Uint8Array(m.bytes), m.name || (req && req.label) || '', req);
      return;
    }
  }

  function startWorker() {
    if (worker) return true;
    if (!global.Worker) { failed = 'this browser has no Web Workers'; return false; }
    try {
      worker = new global.Worker('js/recworker.js');
      worker.onmessage = onWorker;
      worker.onerror = (e) => {
        failed = (e && e.message) || 'the recorder thread stopped';
        /* A save that was in flight when the thread died is never coming
           back, and leaving it pending locks F9 out for the session. */
        pending = null;
        if (global.console) global.console.warn('SYNX: recorder thread error - ' + failed);
        ready = false;
      };
      return true;
    } catch (e) {
      failed = String(e && e.message ? e.message : e);
      worker = null;
      return false;
    }
  }

  /* ---------------------------------------------------------- the events -- */

  /** Something happened worth keeping. Called from all over the game. */
  function mark(reason) {
    if (!on || !ready) return;
    const label = REASONS[reason] || String(reason || '').toUpperCase().slice(0, 24);
    worker.postMessage({ t: 'mark', label, ms: now() });
  }

  function start() {
    if (on || !g) return false;
    const gl = g.gl;
    if (!gl || !gl.fenceSync) return false;          // WebGL1: no fences, no recorder
    if (!startWorker()) return false;
    /* 16:9 at the configured width, rounded to even - the encoder subsamples
       chroma in both axes and a half-pixel is not a thing. */
    w = Math.max(160, cfg.width | 0) & ~1;
    h = Math.round(w * 9 / 16) & ~1;
    drop(gl);
    pool = [];
    outstanding = 0;
    lastWant = -1e9;
    hitFade = 0; lastImpact = 0;
    on = true;
    ready = false;                                   // until the worker says so
    t0 = global.performance ? performance.now() : Date.now();
    worker.postMessage({
      t: 'begin', w, h, fmt: 4,
      fps: cfg.fps, quality: cfg.quality,
      windowMs: cfg.windowMs, budgetMb: cfg.budgetMb,
    });
    return true;
  }

  function stop() {
    if (!on) return;
    on = false;
    ready = false;
    pending = null;
    stats = null;
    drop(g && g.gl);
    if (worker) worker.postMessage({ t: 'end' });
  }

  /**
   * Hand a finished clip to the host, which is the only thing with a disk.
   *
   * THE BYTES GO OVER RAW. Tauri serialises an ordinary command argument to
   * JSON, so the old `Array.from(bytes)` turned a twenty-five megabyte picture
   * into twenty-five million boxed numbers and then into a string three times
   * that size - seconds of frozen game, every save. A `Uint8Array` passed as
   * the whole payload goes through as a raw body instead and is read on the
   * far side as a `Vec<u8>`: see `clip_write` in src-tauri/src/main.rs.
   */
  function write(bytes, name, req) {
    const T = global.__TAURI__;
    const invoke = T && T.core && T.core.invoke;
    const what = (req && req.what) || 'REPLAY SAVED';
    if (!invoke) {
      /* In a browser there is no host. The clip is offered as a download
         instead, so the feature still does something under `python -m
         http.server` rather than silently failing. */
      try {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'video/x-msvideo' }));
        const a = doc.createElement('a');
        a.href = url;
        a.download = 'SYNX-' + Date.now() + (name ? '-' + name : '') + '.avi';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast(what + ' - ' + mb(bytes.length), '#5affc0');
      } catch (e) { toast('THE CLIP COULD NOT BE SAVED', '#ff8a3a'); }
      return;
    }
    /* The label rides in a header rather than in the body, because the body IS
       the file. It is sanitised on both sides - here so the header is legal,
       and again in Rust, because a string from the page that reaches a path is
       a string that gets checked on the far side of the boundary. */
    const tag = String(name || '').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 24);
    invoke('clip_write', bytes, { headers: { 'x-synx-clip': tag } })
      .then((path) => {
        toast(what + ' - ' + mb(bytes.length), '#5affc0');
        if (global.console) global.console.info('SYNX: clip written to ' + path);
      })
      .catch((e) => toast('CLIP FAILED: ' + e, '#ff3b3b'));
  }

  /**
   * Save something. `kind` is 'replay' (the last N seconds), 'reel' (every
   * marked moment, stitched), 'auto' (the best stretch the recorder can find)
   * or 'all'.
   *
   * NOTHING HERE BLOCKS. The request is posted and the function returns on the
   * same frame; the worker builds the file while the game keeps running, and
   * the clip comes back as a message. The car answers the wheel throughout,
   * which is the entire complaint this replaced.
   */
  function save(kind, opts) {
    if (!on || !ready) {
      if (on) toast('RECORDER STILL STARTING', '#ffb400');
      return false;
    }
    if (pending) { toast('ALREADY SAVING…', '#ffb400'); return false; }
    const o = opts || {};
    const ms = kind === 'auto' ? cfg.autoMs : cfg.replayMs;
    pending = {
      kind,
      what: kind === 'reel' ? 'HIGHLIGHT REEL SAVED'
        : kind === 'auto' ? 'BEST MOMENT SAVED' : 'REPLAY SAVED',
      label: kind === 'auto' ? 'BEST OF RUN' : '',
      quiet: !!o.quiet,
      at: now(),
      id: ++seq,
    };
    if (!o.quiet) toast('SAVING…', '#39e6ff');
    worker.postMessage({ t: 'save', kind: KIND[kind] || 0, ms, tag: pending.id });
    return true;
  }

  /** The end of a run. The automatic mode's moment: read back over everything
      that is held, choose the best stretch of it, and write that - unasked,
      which is the half of this feature a player never has to know about. A
      reel of explicit marks wins if there are any, because a mark is somebody
      saying what they wanted. */
  function runEnded() {
    if (!on || !ready || pending) return;
    endWanted = true;
    statsAt = -1e9;                 // this one is not a HUD refresh; ask now
    ask();
  }

  /** A new run: last lap's footage is not this lap's. */
  function runStarted() {
    if (on && ready) worker.postMessage({ t: 'clear' });
    lastWant = -1e9;
    hitFade = 0; lastImpact = 0;
  }

  /** Refresh the readout, at most twice a second - it is for a corner of the
      screen, not for the solver. */
  function ask() {
    const t = now();
    if (!on || !ready || t - statsAt < 500) return;
    statsAt = t;
    worker.postMessage({ t: 'stats' });
  }

  /* ------------------------------------------------------------- settings -- */

  function configure(next) {
    const before = JSON.stringify(cfg);
    cfg = Object.assign({}, DEF, next || {});
    if (!cfg.on) { stop(); return; }
    /* A size or quality change has to rebuild the ring, and rebuilding it
       throws the buffer away - so it only happens when something actually
       changed. */
    if (!on) { start(); return; }
    if (JSON.stringify(cfg) !== before) { stop(); start(); }
  }

  NR.Record = {
    attach(game) { g = game; },
    configure,
    start, stop, capture, mark, save, runEnded, runStarted,
    get on() { return on; },
    get ready() { return ready; },
    get busy() { return !!pending; },
    get why() { return failed; },
    get size() { return { w, h }; },
    stats() { ask(); return on ? stats : null; },
    /** For the options screen. */
    reasons: REASONS,
    defaults: DEF,
  };
})(window);
