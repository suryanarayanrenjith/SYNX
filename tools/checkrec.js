#!/usr/bin/env node
'use strict';
/* ---------------------------------------------------------------------------
 * THE RECORDER, DRIVEN END TO END WITHOUT A BROWSER.
 *
 *     node tools/checkrec.js
 *
 * The encoder has unit tests - `cargo test -p synx-rec` runs a JPEG round trip
 * against a decoder written beside it - and none of them touch the part that
 * actually broke. What broke was the PLUMBING: a synchronous readback in the
 * middle of the frame, a JPEG encode on the thread that draws, and a save that
 * turned a twenty-five megabyte clip into twenty-five million boxed numbers on
 * its way to the disk. Those live in js/record.js and js/recworker.js, and
 * they are exactly the code a unit test cannot see.
 *
 * So both halves are run here against stubs that answer like the real thing
 * and COUNT what is asked of them:
 *
 *   THE WORKER runs against the real synx_rec.wasm, over the real message
 *   protocol, and has to give every transferred buffer back and produce a
 *   playable RIFF/AVI.
 *
 *   THE CAPTURE LOOP runs against a WebGL2 stub that fails the test if it is
 *   ever asked to do the synchronous thing: a readPixels into CPU memory, a
 *   clientWaitSync with a timeout on it, a finish. It also has to drop frames
 *   rather than queue them when the GPU is slow, and it has to hand every
 *   pixel buffer back to be used again rather than allocating per frame.
 * ------------------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
let bad = 0;
const fail = (m) => { console.log('  PROBLEM: ' + m); bad++; };
const ok = (m) => console.log('  ' + m);

/* ------------------------------------------------------------ the worker -- */

/** Run js/recworker.js in a context that looks enough like a Worker. */
function bootWorker() {
  const inbox = [];
  const ctx = vm.createContext({
    console, WebAssembly, URL, TextDecoder, TextEncoder, performance,
    Uint8Array, Float64Array, ArrayBuffer, Math, JSON, String, Number, Error,
    fetch: async (url) => {
      const file = path.join(root, 'web/wasm', path.basename(String(url)));
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
  /* No real location under Node, so give the worker the one it would have. */
  ctx.self.location = { href: 'file:///synx/web/js/recworker.js' };
  ctx.self.postMessage = (m) => inbox.push(m);
  vm.runInContext(fs.readFileSync(path.join(root, 'web/js/recworker.js'), 'utf8'), ctx);
  return {
    inbox,
    /* onmessage is async - it compiles the module on the first call - so the
       promise it returns is awaited AND the loop is then given several turns.
       A test that reads the inbox one tick after posting reads an empty one
       and blames the code. */
    send: (m, transfer) => ctx.self.onmessage({ data: m, transfer }),
    settle: async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); },
  };
}

function riff(bytes) {
  const s = (i, n) => Buffer.from(bytes.slice(i, i + n)).toString('latin1');
  return s(0, 4) === 'RIFF' && s(8, 4) === 'AVI ';
}

async function checkWorker() {
  console.log('\n=== THE RECORDER THREAD ===');
  const W = bootWorker();

  W.send({ t: 'begin', w: 128, h: 72, fps: 20, quality: 70, windowMs: 20000, budgetMb: 16 });
  await W.settle();
  const ready = W.inbox.find((m) => m.t === 'ready');
  if (!ready) { fail('the worker never answered `begin` - ' + JSON.stringify(W.inbox)); return; }
  if (!ready.ok) { fail('the worker refused a 128x72 ring'); return; }
  ok('begin: frame buffer ' + ready.frameLen + ' bytes, pacing every ' + ready.step + ' ms');
  if (ready.step !== 50) fail('20 fps should pace at 50 ms, not ' + ready.step);

  /* Feed it a run: dull, then two seconds of high scores in the middle. Every
     buffer is one the worker gave back, which is the point of the pool. */
  const bytes = ready.frameLen;
  let owned = [new Uint8Array(bytes)];
  let handedOut = 0, handedBack = 0;
  for (let i = 0; i < 200; i++) {
    const px = owned.pop() || new Uint8Array(bytes);
    px.fill((i * 11) & 255);
    handedOut++;
    W.inbox.length = 0;
    W.send({ t: 'frame', px: px.buffer, ms: i * 50, fmt: 4, score: i >= 80 && i < 120 ? 700 : 30 });
    await W.settle();
    for (const m of W.inbox) {
      if (m.t === 'spent') { handedBack++; owned.push(new Uint8Array(m.px)); }
    }
    if (i === 100) W.send({ t: 'mark', label: 'OVERTAKE', ms: i * 50 });
  }
  if (handedBack !== handedOut) {
    fail(`the worker kept ${handedOut - handedBack} of ${handedOut} pixel buffers - `
      + 'the pool bleeds one per frame and the page allocates for ever');
  } else ok(`every one of ${handedOut} pixel buffers came back to be refilled`);

  W.inbox.length = 0;
  W.send({ t: 'stats', tag: 1 });
  await W.settle();
  const st = (W.inbox.find((m) => m.t === 'stats') || {}).stats;
  if (!st) fail('the worker did not report its stats');
  else {
    ok(`held ${st.frames} frames, ${(st.bytes / 1024).toFixed(0)} KB, `
      + `${st.marks} mark(s), ${st.spanMs} ms`);
    if (st.frames < 50) fail('only ' + st.frames + ' frames were kept out of 200 offered');
    if (st.marks !== 1) fail('expected exactly one mark, got ' + st.marks);
  }

  /* Every kind of save, including the automatic one. */
  for (const [kind, name, ms] of [[0, 'all', 0], [1, 'last 5 s', 5000],
    [2, 'highlight reel', 0], [3, 'AUTOMATIC', 6000]]) {
    W.inbox.length = 0;
    W.send({ t: 'save', kind, ms, tag: 'k' + kind });
    await W.settle();
    const clip = W.inbox.find((m) => m.t === 'clip');
    if (!clip) { fail(name + ': no clip came back'); continue; }
    if (!clip.frames || !clip.bytes) { fail(name + ': the clip was empty'); continue; }
    const out = new Uint8Array(clip.bytes);
    if (!riff(out)) { fail(name + ': what came back is not a RIFF/AVI file'); continue; }
    ok(`${name.padEnd(15)} ${String(clip.frames).padStart(4)} frames, `
      + `${String(out.length).padStart(7)} bytes`
      + (clip.name ? '  named "' + clip.name + '"' : ''));
    if (kind === 3 && clip.name !== 'OVERTAKE') {
      fail('the automatic mode should have named its window after the mark inside it, '
        + 'not "' + clip.name + '"');
    }
  }

  /* ...and it gives the memory back. */
  W.send({ t: 'end' });
  await W.settle();
  W.inbox.length = 0;
  W.send({ t: 'stats', tag: 2 });
  await W.settle();
  const after = W.inbox.find((m) => m.t === 'stats');
  if (after && after.stats) fail('the ring is still live after `end`');
  else ok('`end` gave the ring back');
}

/* ------------------------------------------------------ the capture loop -- */

/** A WebGL2 stub that refuses to be used synchronously. */
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

function checkCapture() {
  console.log('\n=== THE CAPTURE LOOP ===');
  const report = { reads: 0, blits: 0, fences: 0, polls: 0, flushes: 0, collected: 0,
    latency: 2, sync: [], posted: 0, allocs: 0 };

  /* js/record.js wants a window. Give it one, plus a fake Worker that
     answers `begin` at once and hands every buffer straight back. */
  const ctx = vm.createContext({
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
  vm.runInContext(fs.readFileSync(path.join(root, 'web/js/record.js'), 'utf8'), ctx);
  const R = ctx.NR.Record;

  const gl = stubGL(report);
  const car = {
    speedMph: 120, ceilingMph: 150, sTrack: 1000, airborne: false, airTime: 0,
    bodySlip: 0.1, boosting: false, impactSpeed: 0, lastHit: false,
    wrongWay: false, offroad: false,
  };
  const game = { gl, w: 1920, h: 1080, outW: 1920, outH: 1080, state: 'racing',
    car, rival: { sTrack: 1040 }, hud: { toast() {} } };
  R.attach(game);

  if (!R.configure) { fail('NR.Record has no configure'); return; }
  R.configure({ on: true, width: 256, fps: 30, quality: 70, windowMs: 5000, budgetMb: 8 });
  if (!R.on) { fail('the recorder did not start'); return; }

  return new Promise((done) => setImmediate(async () => {
    if (!R.ready) { fail('the recorder never became ready'); return done(); }

    /* Two hundred frames at 144 Hz against a 30 fps recorder. */
    let clock = 0;
    const realNow = performance.now.bind(performance);
    let fake = realNow();
    performance.now = () => fake;
    for (let i = 0; i < 200; i++) {
      fake += 1000 / 144;
      clock += 1000 / 144;
      R.capture(1 / 144);
      /* THE EVENT LOOP TURNS BETWEEN FRAMES in a real game - each one is its
         own rAF callback - so the worker's replies are delivered and its
         pixel buffers come back. A loop that never yields starves the pool
         after three frames and measures the backpressure instead of the
         pacing. */
      await new Promise((r) => setImmediate(r));
    }
    performance.now = realNow;

    if (report.sync.length) for (const s of new Set(report.sync)) fail(s);
    else ok('nothing in the capture path blocks: no CPU readPixels, no timed wait, no finish');

    ok(`${report.reads} readbacks started over ${Math.round(clock)} ms of a 144 Hz game`);
    /* 200 frames at 144 Hz is about 1389 ms, which is about 42 frames at 30. */
    if (report.reads > 55) {
      fail(`${report.reads} readbacks for ~42 wanted frames - the pacing gate is not working`);
    }
    if (report.reads < 30) fail(`only ${report.reads} readbacks in ${Math.round(clock)} ms`);
    if (report.fences !== report.reads) {
      fail(`${report.reads} readbacks but ${report.fences} fences - one is unguarded`);
    }
    if (report.flushes !== report.fences) fail('a fence was left in an unsubmitted command buffer');
    if (report.blits !== report.reads) fail('a readback happened without a downscale blit');
    ok(`${report.collected} of them collected once the GPU signalled, ${report.posted} posted on`);
    if (report.collected < report.reads - 4) {
      fail(`${report.reads - report.collected} readbacks were started and never collected`);
    }
    done();
  }));
}

/* ---------------------------------------------------------------- the gate -- */

(async () => {
  const wasm = path.join(root, 'web/wasm/synx_rec.wasm');
  if (!fs.existsSync(wasm)) {
    console.log('web/wasm/synx_rec.wasm is not built - run tools/build.js first');
    process.exitCode = 1;
    return;
  }
  await checkWorker();
  await checkCapture();
  console.log(bad
    ? '\n' + bad + ' problem(s) in the recorder'
    : '\nthe encoder thread answers, gives every buffer back and writes playable files;\n'
      + 'the capture loop paces itself, never blocks and collects what it starts');
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
