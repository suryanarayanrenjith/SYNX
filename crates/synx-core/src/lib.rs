//! SYNX simulation core.
//!
//! Everything in the game that costs real CPU lives here and is compiled to
//! WebAssembly: course generation, the world's mesh, the four-wheel vehicle
//! solver, the rival's racing line and driver, and the particle systems.
//! The browser side keeps the renderer, the interface and the story direction.
//!
//! # The boundary
//!
//! There is no `wasm-bindgen`. Every export is `extern "C"` over scalars and
//! pointers, and every bulk result is left in this module's own linear memory
//! for the JavaScript side to map as a typed-array view. That means a
//! centreline, a vertex buffer or a wheel's state crosses the boundary as an
//! address and a length rather than as a copy - which is the whole point,
//! because the vertex buffers are tens of megabytes and they go straight from
//! here into `gl.bufferData` with nothing in between.
//!
//! Callers must treat those views as valid only until the next call that can
//! grow a `Vec`, since growing linear memory detaches every existing view.
//! `js/wasm.js` re-derives its views whenever `memory.buffer` changes.

pub mod abi;
pub mod ai;
pub mod math;
pub mod mesh;
pub mod net;
pub mod particles;
pub mod ribbon;
pub mod track;
pub mod vehicle;

use core::mem;

// ------------------------------------------------------------ allocation ---

/// Hand a block of linear memory to the caller so it can write the inputs the
/// core needs (the shipped centreline, say) before asking for work.
///
/// The length is remembered in a header word ahead of the returned pointer, so
/// `dealloc` can rebuild the same `Vec` layout without the caller having to
/// carry the size around.
#[no_mangle]
pub extern "C" fn synx_alloc(size: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(size + 8);
    let p = v.as_mut_ptr();
    mem::forget(v);
    unsafe {
        (p as *mut usize).write(size + 8);
        p.add(8)
    }
}

/// Release a block from `synx_alloc`.
///
/// # Safety
/// `ptr` must be a pointer previously returned by `synx_alloc` and not yet
/// freed.
#[no_mangle]
pub unsafe extern "C" fn synx_free(ptr: *mut u8) {
    if ptr.is_null() {
        return;
    }
    let base = ptr.sub(8);
    let cap = (base as *mut usize).read();
    drop(Vec::from_raw_parts(base, 0, cap));
}

/// Version stamp, so the JavaScript side can refuse a stale `.wasm` rather
/// than read a struct layout that has moved under it.
///
/// BUMP THIS whenever an exported signature changes or a vehicle field is
/// added, moved or removed. The layout table is self-describing and the stride
/// is checked against it, so a *stale* wasm is self-consistent and passes that
/// check happily - what it cannot do is tell the caller that the function it
/// is about to be handed four arguments now takes five, or that the field the
/// renderer is reading did not exist when it was compiled. Both of those fail
/// silently, which is exactly what this number is for.
///
/// v10: `synx_driver_tune` dropped its `ram` argument along with the R-IX's
///      shoulder, and `wheelSpinFront` joined the vehicle block so the two
///      axles can be drawn turning at their own speeds.
#[no_mangle]
pub extern "C" fn synx_abi_version() -> u32 {
    10
}

// ------------------------------------------------------------------ world ---

/// Everything one loaded course owns. A single instance lives for the life of
/// the process; the game only ever has one road in it at a time.
#[derive(Default)]
pub struct World {
    pub track: Option<track::Track>,
    pub line: Option<ai::RacingLine>,
    pub cars: Vec<vehicle::Vehicle>,
    pub drivers: Vec<ai::Driver>,
    pub mesh: mesh::MeshOut,
    /// The per-car state blocks, `abi::VEH_STRIDE` doubles each, mapped
    /// directly by the JavaScript `Vehicle` proxy.
    pub veh_state: Vec<f64>,
    /// The self-describing field list, built once on demand.
    pub layout: Vec<u8>,
    /// Scratch the exports write their results into, so a caller can read a
    /// small struct back without an allocation per call.
    pub scratch: Vec<f64>,
    /// The multiplayer client, once a session has been opened. `None` in
    /// single player, which is every mode but one - so it is constructed on
    /// first use rather than costing a ring buffer per car to everybody.
    pub net: Option<net::NetClient>,
}

static mut WORLD: Option<World> = None;

/// Access to the single world.
///
/// # Safety
/// WebAssembly here is single-threaded and every entry point is called from
/// the one JavaScript thread, so there is no aliasing to guard against. This
/// is wrapped rather than written out at each use so the assumption is stated
/// in exactly one place.
#[allow(static_mut_refs)]
pub(crate) fn world() -> &'static mut World {
    unsafe {
        if WORLD.is_none() {
            WORLD = Some(World { scratch: vec![0.0; 128], ..Default::default() });
        }
        WORLD.as_mut().unwrap()
    }
}

/// Address of the shared scratch buffer, as a `Float64Array` view.
#[no_mangle]
pub extern "C" fn synx_scratch_ptr() -> *const f64 {
    world().scratch.as_ptr()
}
