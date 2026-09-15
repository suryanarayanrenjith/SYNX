//! The recorder's C ABI, and the only thing in this crate that knows there is
//! a page above it.
//!
//! # It runs in a Web Worker, and that is the whole design
//!
//! This is compiled to its OWN wasm module rather than being linked into the
//! simulation core, and web/js/recworker.js is the only thing that calls it.
//! Two reasons, both of which were bugs before:
//!
//!   IT HAS ITS OWN HEAP. The ring holds up to half a gigabyte of encoded
//!   frames. Held in the core's linear memory, growing it grows the memory
//!   the whole game has typed-array views over - and growing wasm memory
//!   DETACHES every one of them. The recorder filling up could silently break
//!   the track, the mesh emitters and the solver bridge.
//!
//!   IT HAS ITS OWN THREAD. A baseline JPEG of a 480p frame is a few
//!   milliseconds of DCT, and it was being spent on the thread that was trying
//!   to draw the next frame, thirty times a second. Off the main thread it
//!   costs the game nothing at all, and the mux - which is tens of megabytes
//!   of memcpy - stops being a freeze.
//!
//! # The two buffers
//!
//! There is ONE frame buffer and ONE clip buffer, both owned here.
//!
//!   The FRAME buffer is where the worker copies the pixels it was handed.
//!   JavaScript asks for its address once per size change and maps a
//!   `Uint8Array` over it, so the transfer from the main thread lands directly
//!   in the encoder's input. There is no copy between the two.
//!
//!   The CLIP buffer is the finished AVI. JavaScript maps it, copies it once
//!   into a transferable array, and posts that to the main thread, which hands
//!   it to the host to write. That copy is unavoidable - it has to cross a
//!   thread and then a process - and it happens once per saved clip.
//!
//! # Lifetime of a pointer
//!
//! The same rule as the core's boundary: any call that can grow a `Vec` can
//! grow linear memory and detach every view JavaScript holds. Both buffers
//! here can grow, so the worker re-derives its views after any call that
//! might have.

use crate::Reel;

struct Rec {
    reel: Reel,
    /// Where readPixels lands. Sized `w * h * 4` and never handed out shorter.
    frame: Vec<u8>,
    /// The finished container.
    clip: Vec<u8>,
    /// The label the next save should be named after.
    name: Vec<u8>,
    /// Numbers the HUD reads: frames, bytes, marks, span_ms, last size.
    stats: [f64; 8],
}

static mut REC: Option<Rec> = None;

#[allow(static_mut_refs)]
fn rec() -> Option<&'static mut Rec> {
    unsafe { REC.as_mut() }
}

/// Start recording. Safe to call again: it replaces whatever was there, which
/// is what a resolution or quality change does.
///
/// `budget_mb` is the ceiling on how much the ring may hold. Both it and
/// `window_ms` are enforced - see the note on `Reel`.
#[no_mangle]
pub extern "C" fn synx_rec_begin(
    w: u32,
    h: u32,
    fps: u32,
    quality: u32,
    window_ms: u32,
    budget_mb: u32,
) -> u32 {
    /* Even dimensions, because 4:2:0 subsamples chroma in both axes and a
       half-pixel is not a thing. Rounded DOWN so the capture never reads past
       a framebuffer the caller sized to the odd number. */
    let w = (w as usize) & !1;
    let h = (h as usize) & !1;
    if w < 16 || h < 16 || w > 4096 || h > 4096 {
        return 0;
    }
    let budget = (budget_mb.clamp(4, 512) as usize) << 20;
    unsafe {
        REC = Some(Rec {
            reel: Reel::new(w, h, fps.clamp(5, 60), quality.clamp(10, 100), window_ms, budget),
            frame: vec![0u8; w * h * 4],
            clip: Vec::new(),
            name: Vec::new(),
            stats: [0.0; 8],
        });
    }
    1
}

/// Stop, and give the memory back. A player who turns the recorder off should
/// get the megabytes back, not merely stop adding to them.
#[no_mangle]
pub extern "C" fn synx_rec_end() {
    unsafe {
        REC = None;
    }
}

#[no_mangle]
pub extern "C" fn synx_rec_active() -> u32 {
    if rec().is_some() {
        1
    } else {
        0
    }
}

/// Where `readPixels` should write. Valid until the next call that can grow
/// linear memory.
#[no_mangle]
pub extern "C" fn synx_rec_frame_ptr() -> *mut u8 {
    match rec() {
        Some(r) => r.frame.as_mut_ptr(),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn synx_rec_frame_len() -> u32 {
    rec().map(|r| r.frame.len() as u32).unwrap_or(0)
}

/// Would a frame stamped `t_ms` be kept?
///
/// Asked on the MAIN thread, before it even asks the GPU for the pixels: a
/// game running at 144 frames a second against a 30 fps recorder should start
/// thirty readbacks a second, not a hundred and forty-four. The main thread
/// keeps its own copy of the answer (see `wants` in js/record.js) because
/// asking across a worker boundary is asynchronous and the question has to be
/// answered before the draw call that follows it.
#[no_mangle]
pub extern "C" fn synx_rec_wants(t_ms: u32) -> u32 {
    match rec() {
        Some(r) => {
            if r.reel.wants(t_ms) {
                1
            } else {
                0
            }
        }
        None => 0,
    }
}

/// Encode whatever is in the frame buffer and put it in the ring.
///
/// `score` is 0..1000 - how interesting the game thought this frame was when
/// it drew it. It is carried through to `Frame::score` and it is what the
/// automatic mode reads. Returns the encoded size, or zero if the frame was
/// declined.
#[no_mangle]
pub extern "C" fn synx_rec_push(t_ms: u32, px: u32, score: u32) -> u32 {
    let px = if px == 3 { 3 } else { 4 };
    match rec() {
        Some(r) => {
            /* The borrow has to be split: `push` takes `&mut self` and the
               source is a field of the same struct. The frame buffer is only
               read, so a raw slice over it is sound and avoids a copy of the
               whole picture on every frame. */
            let src = unsafe { core::slice::from_raw_parts(r.frame.as_ptr(), r.frame.len()) };
            r.reel.push_scored(src, px, t_ms, score.min(1000) as u16) as u32
        }
        None => 0,
    }
}

/// Note a highlight. The label is UTF-8 in the frame buffer's first `len`
/// bytes, which is already mapped on the JavaScript side - a second buffer for
/// a twenty-character string would be a second thing to keep in sync.
#[no_mangle]
pub extern "C" fn synx_rec_mark(len: u32, t_ms: u32) {
    if let Some(r) = rec() {
        let n = (len as usize).min(24).min(r.frame.len());
        let label = core::str::from_utf8(&r.frame[..n]).unwrap_or("HIGHLIGHT");
        /* Copied out before the mutable borrow, because `mark` takes one. */
        let owned: Label24 = Label24::from(label);
        r.reel.mark(t_ms, owned.as_str());
    }
}

/// A fixed-size string, so a label can be read out of the frame buffer and
/// handed back to a method that wants `&mut self`. Twenty-four bytes is what
/// `Mark` keeps anyway.
struct Label24 {
    b: [u8; 24],
    n: usize,
}

impl Label24 {
    fn from(s: &str) -> Label24 {
        let mut h = Label24 { b: [0; 24], n: 0 };
        for (i, c) in s.as_bytes().iter().take(24).enumerate() {
            h.b[i] = *c;
            h.n = i + 1;
        }
        /* A truncation must not land in the middle of a multi-byte character,
           or the label stops being UTF-8 and the name it becomes is rejected
           by the filesystem layer rather than by anything here. */
        while h.n > 0 && core::str::from_utf8(&h.b[..h.n]).is_err() {
            h.n -= 1;
        }
        h
    }
    fn as_str(&self) -> &str {
        core::str::from_utf8(&self.b[..self.n]).unwrap_or("")
    }
}

/// Build a clip. `kind` is 0 for the whole ring, 1 for the last `ms`, 2 for
/// the marked highlights stitched together, and 3 for THE BEST `ms` THE
/// RECORDER CAN FIND - which is the automatic mode, and reads the score on
/// every frame it is holding. Returns the frame count.
#[no_mangle]
pub extern "C" fn synx_rec_save(kind: u32, ms: u32) -> u32 {
    let Some(r) = rec() else { return 0 };
    let mut out = core::mem::take(&mut r.clip);
    let mut picked = String::new();
    let n = match kind {
        1 => r.reel.save_last(ms, &mut out),
        2 => r.reel.save_reel(&mut out),
        3 => {
            let (n, label) = r.reel.save_best(ms, &mut out);
            picked.push_str(label);
            n
        }
        _ => r.reel.save_all(&mut out),
    };
    r.clip = out;
    /* The automatic mode names the file after what it found in the window it
       chose; everything else is named after the last thing the game marked. */
    let label = if kind == 3 { picked.as_str() } else { r.reel.last_mark() };
    r.name.clear();
    r.name.extend_from_slice(label.as_bytes());
    n as u32
}

#[no_mangle]
pub extern "C" fn synx_rec_clip_ptr() -> *const u8 {
    match rec() {
        Some(r) => r.clip.as_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn synx_rec_clip_len() -> u32 {
    rec().map(|r| r.clip.len() as u32).unwrap_or(0)
}

/// Give the clip buffer's memory back once the host has the bytes. A
/// forty-megabyte clip held for the rest of the session is forty megabytes of
/// nothing.
#[no_mangle]
pub extern "C" fn synx_rec_clip_free() {
    if let Some(r) = rec() {
        r.clip = Vec::new();
    }
}

#[no_mangle]
pub extern "C" fn synx_rec_name_ptr() -> *const u8 {
    match rec() {
        Some(r) => r.name.as_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn synx_rec_name_len() -> u32 {
    rec().map(|r| r.name.len() as u32).unwrap_or(0)
}

/// Throw the ring away without stopping. What a restart does: the last lap's
/// footage is not this lap's.
#[no_mangle]
pub extern "C" fn synx_rec_clear() {
    if let Some(r) = rec() {
        r.reel.clear();
    }
}

/// Frames, bytes, marks, span in ms, frames offered, frames taken, clip bytes,
/// and the ring's byte budget - as one block the HUD maps once.
#[no_mangle]
pub extern "C" fn synx_rec_stats() -> *const f64 {
    match rec() {
        Some(r) => {
            r.stats[0] = r.reel.held_frames() as f64;
            r.stats[1] = r.reel.held_bytes() as f64;
            r.stats[2] = r.reel.mark_count() as f64;
            r.stats[3] = r.reel.span_ms() as f64;
            r.stats[4] = r.reel.offered as f64;
            r.stats[5] = r.reel.taken as f64;
            r.stats[6] = r.clip.len() as f64;
            r.stats[7] = r.reel.budget as f64;
            r.stats.as_ptr()
        }
        None => core::ptr::null(),
    }
}
