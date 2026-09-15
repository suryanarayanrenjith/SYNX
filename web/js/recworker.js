/* SYNX // THE RECORDER'S THREAD.
 *
 * Everything expensive about recording happens in here, which is a thread
 * that is not drawing the game.
 *
 * # What was wrong with doing it on the main thread
 *
 * Three things, and they were the three complaints:
 *
 *   THE ENCODE. A baseline JPEG of a 480p frame is a few milliseconds of DCT.
 *   Thirty of those a second, on the thread that is trying to produce a frame
 *   every seven, is a stutter you can see - and it is spent whether or not the
 *   clip is ever saved.
 *
 *   THE MUX. Building the file copies every frame in the window into one
 *   buffer: tens of megabytes of memcpy in a single call. On the main thread
 *   that is a hitch measured in frames.
 *
 *   THE HANDOVER. The old path did `Array.from(clip.bytes)` on a multi-megabyte
 *   Uint8Array and sent the result through a JSON IPC. That turns twenty-five
 *   megabytes of picture into twenty-five MILLION boxed JavaScript numbers and
 *   then into a string about three times that size, and it is the reason the
 *   game stopped responding until the file appeared. Nothing here ever converts
 *   pixels to numbers: see `write` in js/record.js for the binary path out.
 *
 * # The protocol
 *
 * Frames arrive as TRANSFERRED ArrayBuffers - ownership moves, nothing is
 * copied - and every one of them is handed straight back the same way once it
 * has been encoded, so the main thread can fill it again. There are only ever
 * a few buffers in the system and they circulate; nothing allocates per frame
 * in the steady state.
 *
 *   -> begin  {w,h,fps,quality,windowMs,budgetMb}   <- ready {ok,frameLen,step}
 *   -> frame  {px,ms,fmt,score}                     <- spent {px}
 *   -> mark   {label,ms}
 *   -> save   {kind,ms,tag}                         <- clip  {tag,frames,name,bytes}
 *   -> clear | end | stats                          <- stats {...}
 *
 * `kind` is 0 everything, 1 the last `ms`, 2 the marked highlights stitched,
 * 3 THE BEST `ms` THE RECORDER CAN FIND - the automatic mode, which reads the
 * score on every frame it is holding. See save_best in crates/synx-rec.
 */
'use strict';

let mod = null;          // the wasm instance's exports
let live = false;
let fmtDefault = 4;

/* THE RULE ABOUT VIEWS, which is the same here as everywhere else in this
   codebase: anything that can grow a Vec can grow linear memory, and growing
   linear memory DETACHES every typed array over it. `push` grows the ring on
   most frames, so the frame view is re-derived on every single use rather than
   cached. It cost one afternoon to learn this the first time. */
function frameView() {
  if (!mod) return null;
  const p = mod.synx_rec_frame_ptr();
  if (!p) return null;
  return new Uint8Array(mod.memory.buffer, p, mod.synx_rec_frame_len());
}

function readName() {
  if (!mod || !mod.synx_rec_name_ptr) return '';
  const p = mod.synx_rec_name_ptr(), n = mod.synx_rec_name_len();
  if (!p || !n) return '';
  const b = new Uint8Array(mod.memory.buffer, p, n);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
  return s;
}

function readStats() {
  if (!mod || !mod.synx_rec_stats) return null;
  const p = mod.synx_rec_stats();
  if (!p) return null;
  const d = new Float64Array(mod.memory.buffer, p, 8);
  return {
    frames: d[0], bytes: d[1], marks: d[2], spanMs: d[3],
    offered: d[4], taken: d[5], clipBytes: d[6], budget: d[7],
  };
}

async function load() {
  if (mod) return true;
  /* Relative to this script rather than to the page, because the worker is
     loaded from js/ and the modules live in wasm/ beside it. Streaming where
     the host serves a real content type, and a plain fetch where it does not -
     a custom protocol that answers application/octet-stream would otherwise
     fail the streaming compile for a reason that has nothing to do with the
     module being wrong. */
  const url = new URL('../wasm/synx_rec.wasm', self.location.href).href;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let inst;
    try {
      inst = await WebAssembly.instantiateStreaming(res.clone(), {});
    } catch (e) {
      inst = await WebAssembly.instantiate(await res.arrayBuffer(), {});
    }
    mod = inst.instance.exports;
    return true;
  } catch (e) {
    self.postMessage({ t: 'fail', why: String(e && e.message ? e.message : e) });
    return false;
  }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (!m) return;

  switch (m.t) {
    case 'begin': {
      if (!(await load())) return;
      fmtDefault = m.fmt === 3 ? 3 : 4;
      const ok = !!mod.synx_rec_begin(
        m.w | 0, m.h | 0, m.fps | 0, m.quality | 0, m.windowMs | 0, m.budgetMb | 0);
      live = ok;
      self.postMessage({
        t: 'ready',
        ok,
        frameLen: ok ? mod.synx_rec_frame_len() : 0,
        /* The pacing interval, so the main thread can answer "is this frame
           wanted?" ITSELF. That question has to be answered before the draw
           call that reads the framebuffer, and asking across a thread is
           asynchronous - by the time an answer came back the frame would be
           gone. The worker owns the ring; the main thread owns the clock. */
        step: ok ? Math.floor(1000 / Math.max(1, m.fps | 0)) : 0,
      });
      return;
    }

    case 'frame': {
      if (!live || !mod) {
        // hand the buffer back anyway, or the pool bleeds one per dropped frame
        if (m.px) self.postMessage({ t: 'spent', px: m.px }, [m.px]);
        return;
      }
      const src = new Uint8Array(m.px);
      const dst = frameView();
      if (dst && src.length <= dst.length) {
        dst.set(src);
        mod.synx_rec_push(m.ms >>> 0, m.fmt || fmtDefault, Math.max(0, Math.min(1000, m.score | 0)));
      }
      /* Back it goes, whatever happened. The buffer is the main thread's; this
         thread only ever borrows it for the length of one encode. */
      self.postMessage({ t: 'spent', px: m.px }, [m.px]);
      return;
    }

    case 'mark': {
      if (!live || !mod) return;
      /* The label goes in through the frame buffer, which is already mapped -
         a second buffer for a twenty-character string would be a second thing
         to keep in sync. ASCII only: these are all short upper-case tags, and
         a byte that is not ASCII is a byte that can split a UTF-8 character in
         half on the way into a fixed-size field. */
      const f = frameView();
      if (!f) return;
      let n = 0;
      const s = String(m.label || 'HIGHLIGHT');
      for (let i = 0; i < s.length && n < 24; i++) {
        const c = s.charCodeAt(i);
        if (c > 31 && c < 128) f[n++] = c;
      }
      mod.synx_rec_mark(n, m.ms >>> 0);
      return;
    }

    case 'save': {
      if (!live || !mod) { self.postMessage({ t: 'clip', tag: m.tag, frames: 0 }); return; }
      const frames = mod.synx_rec_save(m.kind | 0, m.ms | 0) | 0;
      const len = mod.synx_rec_clip_len();
      if (!frames || !len) {
        mod.synx_rec_clip_free();
        self.postMessage({ t: 'clip', tag: m.tag, frames: 0 });
        return;
      }
      const name = readName();
      /* ONE copy, into a buffer that is then TRANSFERRED. It has to leave wasm
         memory - the module is about to free the original - and it has to
         leave this thread, and this does both in a single memcpy. */
      const out = new Uint8Array(len);
      out.set(new Uint8Array(mod.memory.buffer, mod.synx_rec_clip_ptr(), len));
      mod.synx_rec_clip_free();
      self.postMessage(
        { t: 'clip', tag: m.tag, frames, name, bytes: out.buffer },
        [out.buffer]);
      return;
    }

    case 'clear':
      if (live && mod) mod.synx_rec_clear();
      return;

    case 'end':
      if (mod && mod.synx_rec_end) mod.synx_rec_end();
      live = false;
      return;

    case 'stats':
      self.postMessage({ t: 'stats', tag: m.tag, stats: live ? readStats() : null });
      return;

    default:
      return;
  }
};
