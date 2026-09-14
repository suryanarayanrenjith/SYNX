//! The C ABI the browser side calls.
//!
//! # Why there is no `wasm-bindgen`
//!
//! Everything crossing this boundary is either a scalar or a block of numbers.
//! The centreline is 28,900 samples wide, the world's vertex buffer is twelve
//! megabytes, and a vehicle's state is read a dozen times a frame by the HUD,
//! the audio mixer and three level directors. Generated glue would copy all of
//! it; a raw pointer plus a typed-array view over `memory.buffer` copies none
//! of it, and it removes a build-time dependency on `wasm-bindgen-cli`.
//!
//! # The vehicle state block
//!
//! Each car owns a fixed-layout `f64` block in linear memory. JavaScript maps
//! it once as a `Float64Array` and its `Vehicle` proxy reads and writes fields
//! straight through it, so `car.x` and `car.boost` still work exactly as they
//! did while the solver runs in Rust. `veh_update` loads the block first (so a
//! director that moved the car is respected), steps the simulation, and stores
//! it back.
//!
//! The layout is *self-describing*: [`synx_veh_layout`] hands JavaScript the
//! field names in order, and the bridge builds its index map from that at
//! startup. Adding a field in one language and forgetting the other is
//! therefore impossible rather than merely discouraged.
//!
//! # Lifetime of a pointer
//!
//! Any call that can grow a `Vec` can grow linear memory, and growing it
//! detaches every existing JavaScript view. The bridge re-derives its views
//! whenever `memory.buffer` changes; callers of the raw pointers must do the
//! same.

use crate::ai::{self, Driver, Personality, RacingLine, WorldView};
use crate::track::{self, Centreline, Track};
use crate::vehicle::{self, HitKind, Input, Vehicle};
use crate::world;

/// The per-vehicle state block, declared once.
///
/// The macro emits three things from a single list: the field-name table the
/// bridge reads to build its index map, a `usize` constant per field, and the
/// stride. Declaring them separately is how a layout drifts - a field added to
/// the names but not the loader silently shifts every index after it, and the
/// symptom is a car whose brake lights come on when it boosts.
macro_rules! veh_layout {
    ($($konst:ident => $name:literal),* $(,)?) => {
        pub const VEH_FIELDS: &[&str] = &[$($name),*];
        #[allow(non_upper_case_globals, dead_code)]
        mod f {
            veh_layout!(@idx 0usize; $($konst),*);
        }
        pub const VEH_STRIDE: usize = VEH_FIELDS.len();
    };
    (@idx $n:expr; $head:ident $(, $rest:ident)*) => {
        pub const $head: usize = $n;
        veh_layout!(@idx $n + 1; $($rest),*);
    };
    (@idx $n:expr;) => {};
}

veh_layout! {
    X => "x", Y => "y", Z => "z", YAW => "yaw",
    ROAD_Y => "roadY", ROAD_PITCH => "roadPitch", LIFT => "lift",
    V_LONG => "vLong", V_LAT => "vLat", YAW_RATE => "yawRate",
    VX => "vx", VZ => "vz", SPEED => "speed",
    STEER => "steer", STEER_VISUAL => "steerVisual", COUNTER_STEERING => "counterSteering",
    DRIFTING => "drifting", DRIFT_AMOUNT => "driftAmount", DRIFT_HOLD => "driftHold",
    DRIFT_KICK => "driftKick", DRIFT_ANGLE => "driftAngle", DRIFT_DIR => "driftDir",
    SCRAPE => "scrape", BODY_SLIP => "bodySlip", SLIP_FRONT => "slipFront",
    SLIP_REAR => "slipRear", WHEEL_SLIP => "wheelSlip", WHEEL_SPIN_FX => "wheelSpinFx",
    WHEEL_SPIN => "wheelSpin", WHEEL_SPIN_FRONT => "wheelSpinFront",
    BOOST => "boost", BOOSTING => "boosting", BOOST_LOCKED => "boostLocked",
    GEAR => "gear", RPM => "rpm", ENGINE_RPM => "engineRpm",
    SHIFT_TIMER => "shiftTimer", SHIFT_HOLD => "shiftHold", SHIFT_FLASH => "shiftFlash",
    ENGINE_LOAD => "engineLoad", REVERSE_ARM => "reverseArm",
    ENGINE_TOP => "engineTop", SPEED_CAP => "speedCap", ENGINE_POWER => "enginePower",
    RACE_MODE_MULTIPLIER => "raceModeMultiplier", POWER_SCALE => "powerScale",
    S_TRACK => "sTrack", MAX_S => "maxS", MIN_S => "minS", LATERAL => "lateral",
    OFFROAD => "offroad", WRONG_WAY => "wrongWay", BEACHED => "beached",
    SURFACE_GRIP => "surfaceGrip", GRIP_SCALE => "gripScale", SURFACE_DRAG => "surfaceDrag",
    DAMAGE => "damage",
    HEAVE => "heave", PITCH => "pitch", ROLL => "roll", BODY_Y => "bodyY",
    ACCEL_LONG => "accelLong", ACCEL_LAT => "accelLat",
    CRASH_COOLDOWN => "crashCooldown", LAST_HIT => "lastHit", LAST_HIT_TYPE => "lastHitType",
    BRAKING => "braking", IMPACT => "impact", IMPACT_SPEED => "impactSpeed",
    STUN => "stun", CONTACT_TIMER => "contactTimer",
    W0_OMEGA => "w0omega", W0_LOAD => "w0load", W0_SLIP_ANGLE => "w0slipAngle", W0_SLIP_RATIO => "w0slipRatio",
    W1_OMEGA => "w1omega", W1_LOAD => "w1load", W1_SLIP_ANGLE => "w1slipAngle", W1_SLIP_RATIO => "w1slipRatio",
    W2_OMEGA => "w2omega", W2_LOAD => "w2load", W2_SLIP_ANGLE => "w2slipAngle", W2_SLIP_RATIO => "w2slipRatio",
    W3_OMEGA => "w3omega", W3_LOAD => "w3load", W3_SLIP_ANGLE => "w3slipAngle", W3_SLIP_RATIO => "w3slipRatio",
    // the stunt course; see the note above `Ramp` in vehicle.rs
    AIRBORNE => "airborne", AIR_Y => "airY", AIR_V => "airV", AIR_TIME => "airTime",
    AIR_PITCH => "airPitch", AIR_ROLL => "airRoll",
    LANDING => "landing", LANDED => "landed",
}

#[inline]
fn b(v: bool) -> f64 {
    if v {
        1.0
    } else {
        0.0
    }
}

/// `lastHitType`, as a number: 0 none, 1 wall, 2 car.
#[inline]
fn hit_code(k: HitKind) -> f64 {
    match k {
        HitKind::None => 0.0,
        HitKind::Wall => 1.0,
        HitKind::Car => 2.0,
    }
}

pub(crate) fn store_vehicle(v: &Vehicle, out: &mut [f64]) {
    let mut i = 0;
    let mut p = |x: f64, i: &mut usize| {
        out[*i] = x;
        *i += 1;
    };
    p(v.x, &mut i); p(v.y, &mut i); p(v.z, &mut i); p(v.yaw, &mut i);
    p(v.road_y, &mut i); p(v.road_pitch, &mut i); p(v.lift, &mut i);
    p(v.v_long, &mut i); p(v.v_lat, &mut i); p(v.yaw_rate, &mut i);
    p(v.vx, &mut i); p(v.vz, &mut i); p(v.speed, &mut i);
    p(v.steer, &mut i); p(v.steer_visual, &mut i); p(b(v.counter_steering), &mut i);
    p(b(v.drifting), &mut i); p(v.drift_amount, &mut i); p(v.drift_hold, &mut i);
    p(v.drift_kick, &mut i); p(v.drift_angle, &mut i); p(v.drift_dir, &mut i);
    p(v.scrape, &mut i); p(v.body_slip, &mut i); p(v.slip_front, &mut i);
    p(v.slip_rear, &mut i); p(v.wheel_slip, &mut i); p(v.wheel_spin_fx, &mut i);
    p(v.wheel_spin, &mut i); p(v.wheel_spin_front, &mut i);
    p(v.boost, &mut i); p(b(v.boosting), &mut i); p(b(v.boost_locked), &mut i);
    p(v.gear as f64, &mut i); p(v.rpm, &mut i); p(v.engine_rpm, &mut i);
    p(v.shift_timer, &mut i); p(v.shift_hold, &mut i); p(v.shift_flash, &mut i);
    p(v.engine_load, &mut i); p(v.reverse_arm, &mut i);
    p(v.engine_top, &mut i); p(v.speed_cap, &mut i); p(v.engine_power, &mut i);
    p(v.race_mode_multiplier, &mut i); p(v.power_scale, &mut i);
    p(v.s_track, &mut i); p(v.max_s, &mut i); p(v.min_s, &mut i); p(v.lateral, &mut i);
    p(b(v.offroad), &mut i); p(v.wrong_way, &mut i); p(v.beached, &mut i);
    p(v.surface_grip, &mut i); p(v.grip_scale, &mut i); p(v.surface_drag, &mut i);
    p(v.damage, &mut i);
    p(v.heave, &mut i); p(v.pitch, &mut i); p(v.roll, &mut i); p(v.body_y, &mut i);
    p(v.accel_long, &mut i); p(v.accel_lat, &mut i);
    p(v.crash_cooldown, &mut i); p(b(v.last_hit), &mut i); p(hit_code(v.last_hit_kind), &mut i);
    p(v.braking, &mut i); p(v.impact, &mut i); p(v.impact_speed, &mut i);
    p(v.stun, &mut i); p(v.contact_timer, &mut i);
    for w in &v.w {
        p(w.omega, &mut i); p(w.load, &mut i); p(w.slip_angle, &mut i); p(w.slip_ratio, &mut i);
    }
    p(b(v.airborne), &mut i); p(v.air_y, &mut i); p(v.air_v, &mut i); p(v.air_time, &mut i);
    p(v.air_pitch, &mut i); p(v.air_roll, &mut i);
    p(v.landing, &mut i); p(v.landed, &mut i);
    debug_assert_eq!(i, VEH_STRIDE, "store_vehicle wrote {i} of {VEH_STRIDE} fields");
}

/// Pick up whatever JavaScript wrote into the block.
///
/// Only the fields a director legitimately drives are read back. The solver's
/// own integrator state - wheel speeds, spring velocities, relaxed slips - is
/// deliberately *not* reloaded: those are internal, JavaScript has no reason to
/// set them, and letting a stale copy overwrite them would corrupt the sim.
fn load_vehicle(v: &mut Vehicle, src: &[f64]) {
    v.x = src[f::X];
    v.y = src[f::Y];
    v.z = src[f::Z];
    v.yaw = src[f::YAW];
    v.lift = src[f::LIFT];
    v.v_long = src[f::V_LONG];
    v.v_lat = src[f::V_LAT];
    v.yaw_rate = src[f::YAW_RATE];
    v.speed = src[f::SPEED];
    v.s_track = src[f::S_TRACK];
    v.max_s = src[f::MAX_S];
    v.min_s = src[f::MIN_S];
    v.boost = src[f::BOOST];
    v.boost_locked = src[f::BOOST_LOCKED] != 0.0;
    v.gear = (src[f::GEAR] as usize).clamp(1, 7);
    v.engine_top = src[f::ENGINE_TOP];
    v.speed_cap = src[f::SPEED_CAP];
    v.engine_power = src[f::ENGINE_POWER];
    v.race_mode_multiplier = src[f::RACE_MODE_MULTIPLIER];
    v.power_scale = src[f::POWER_SCALE];
    v.surface_grip = src[f::SURFACE_GRIP];
    v.grip_scale = src[f::GRIP_SCALE];
    v.surface_drag = src[f::SURFACE_DRAG];
    v.damage = src[f::DAMAGE];
    v.wrong_way = src[f::WRONG_WAY];
    v.beached = src[f::BEACHED];
    v.stun = src[f::STUN];
    v.last_hit = src[f::LAST_HIT] != 0.0;
    v.contact_timer = src[f::CONTACT_TIMER];
    v.drift_amount = src[f::DRIFT_AMOUNT];
    v.body_slip = src[f::BODY_SLIP];
    v.scrape = src[f::SCRAPE];
    v.wheel_spin_fx = src[f::WHEEL_SPIN_FX];
    v.wheel_spin = src[f::WHEEL_SPIN];
    v.wheel_spin_front = src[f::WHEEL_SPIN_FRONT];
    v.pitch = src[f::PITCH];
    v.roll = src[f::ROLL];
    v.road_pitch = src[f::ROAD_PITCH];
    v.lateral = src[f::LATERAL];
    /* `landed` is a one-frame EVENT flag, and the director that reads it
       clears it - so it has to come back in, or the clear is thrown away by
       the next store and the same landing is reported for the rest of the
       run. Nothing else about the flight is loadable: `airborne`, the height
       and the vertical speed are integrator state, and letting a director
       write them is how a car ends up falling forever. */
    v.landed = src[f::LANDED];
}

// -------------------------------------------------------------- exports ----

/// NUL-separated field names for the vehicle state block, terminated by an
/// empty entry. The bridge builds its index map from this, so a layout change
/// cannot silently desynchronise the two languages.
#[no_mangle]
pub extern "C" fn synx_veh_layout() -> *const u8 {
    let w = world();
    if w.layout.is_empty() {
        let mut s = String::new();
        for f in VEH_FIELDS {
            s.push_str(f);
            s.push('\0');
        }
        s.push('\0');
        w.layout = s.into_bytes();
    }
    w.layout.as_ptr()
}

#[no_mangle]
pub extern "C" fn synx_veh_stride() -> usize {
    VEH_STRIDE
}

// ---- track ----------------------------------------------------------------

/// Build the course from a shipped centreline the caller has written into
/// linear memory as six parallel `f64` arrays of `count` entries each.
///
/// Returns the finished sample count.
///
/// # Safety
/// The six pointers must each address `count` readable `f64`s.
#[no_mangle]
pub unsafe extern "C" fn synx_track_build(
    x: *const f64,
    y: *const f64,
    z: *const f64,
    yaw: *const f64,
    curv: *const f64,
    tunnel: *const f64,
    count: usize,
    step: f64,
    want: f64,
) -> usize {
    let sl = |p: *const f64| core::slice::from_raw_parts(p, count).to_vec();
    let shipped = Centreline {
        x: sl(x),
        y: if y.is_null() { vec![0.0; count] } else { sl(y) },
        z: sl(z),
        yaw: sl(yaw),
        curv: sl(curv),
        tunnel: if tunnel.is_null() {
            vec![0; count]
        } else {
            core::slice::from_raw_parts(tunnel, count).iter().map(|v| *v as u8).collect()
        },
        step,
        count,
        shipped_count: count,
    };
    let c = track::build_course(&shipped, want);
    let n = c.count;
    world().track = Some(Track::new(c));
    n
}

macro_rules! track_ptr {
    ($name:ident, $field:ident) => {
        #[no_mangle]
        pub extern "C" fn $name() -> *const f64 {
            match &world().track {
                Some(t) => t.c.$field.as_ptr(),
                None => core::ptr::null(),
            }
        }
    };
}
track_ptr!(synx_track_x, x);
track_ptr!(synx_track_y, y);
track_ptr!(synx_track_z, z);
track_ptr!(synx_track_yaw, yaw);
track_ptr!(synx_track_curv, curv);

#[no_mangle]
pub extern "C" fn synx_track_tunnel() -> *const u8 {
    match &world().track {
        Some(t) => t.c.tunnel.as_ptr(),
        None => core::ptr::null(),
    }
}

/// Set the corridor this route drives in.
///
/// `Game.applyLevel` overrides these per route - Chapter 7's elevated deck is
/// sixty-four units across where the rest of the course is forty - and the
/// collision resolver and the rival's line both read them, so they have to
/// reach the core rather than only the JavaScript wrapper.
#[no_mangle]
pub extern "C" fn synx_track_set_width(drive_half: f64, road_half: f64) {
    if let Some(t) = world().track.as_mut() {
        t.half_width = drive_half;
        t.outer_half = road_half;
    }
}

#[no_mangle]
pub extern "C" fn synx_track_count() -> usize {
    world().track.as_ref().map(|t| t.count).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn synx_track_shipped() -> usize {
    world().track.as_ref().map(|t| t.shipped_count).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn synx_track_length() -> f64 {
    world().track.as_ref().map(|t| t.length).unwrap_or(0.0)
}

/* THE BORE BYPASSES, PUBLISHED RATHER THAN RESTATED.
 *
 * The deck is generated here - it is the road's own elevation, see
 * `OVERPASSES` in track.rs - and the renderer has to build the structure that
 * holds it up, seal the bore under it and keep the tunnel's fog off a car that
 * is on the roof rather than inside. All three need the same four arc lengths,
 * and a copy of them written down in JavaScript is a copy that drifts the
 * first time one of them moves by six units. */
#[no_mangle]
pub extern "C" fn synx_overpass_count() -> usize {
    crate::track::OVERPASSES.len()
}

/// `from, deck0, deck1, to, h, bore0, bore1` per entry, laid end to end.
#[no_mangle]
pub extern "C" fn synx_overpasses() -> *const f64 {
    let w = world();
    let mut t = Vec::new();
    crate::track::overpass_table(&mut t);
    let n = t.len().min(w.scratch.len());
    w.scratch[..n].copy_from_slice(&t[..n]);
    w.scratch.as_ptr()
}

/// Stride of the block above, so the bridge cannot guess it wrong.
#[no_mangle]
pub extern "C" fn synx_overpass_stride() -> usize {
    crate::track::OVERPASS_STRIDE
}

/* WHAT A CAR IN THE AIR DOES, PUBLISHED.
 *
 * The solver owns the flight - gravity, the drag that acts on a car with no
 * wheels down, how fast the nose drops and how far out a landing still scores
 * - and the front end has one other place that has to put a car through the
 * same arc: the attract drive behind the menus, which is kinematic and never
 * touches the solver at all. It used to slide straight through the ramps.
 *
 * Handing it these numbers rather than letting it keep its own copy is the
 * difference between a title screen that shows the game and a title screen
 * that shows something that looks a bit like it. Order: gravity, air drag,
 * nose-drop acceleration, its bound, and the landing tolerance.
 */
#[no_mangle]
pub extern "C" fn synx_air_constants() -> *const f64 {
    let w = world();
    let v = [
        crate::vehicle::AIR_G,
        crate::vehicle::AIR_DRAG,
        crate::vehicle::AIR_PITCH_ACC,
        crate::vehicle::AIR_PITCH_MAX,
        crate::vehicle::LAND_TOL,
    ];
    w.scratch[..v.len()].copy_from_slice(&v);
    w.scratch.as_ptr()
}

/// Sample the centreline. Writes `x, y, z, yaw, curv, tunnel` to the scratch
/// buffer and returns its address.
#[no_mangle]
pub extern "C" fn synx_track_at(s: f64) -> *const f64 {
    let w = world();
    if let Some(t) = &w.track {
        let p = t.at(s);
        w.scratch[0] = p.x;
        w.scratch[1] = p.y;
        w.scratch[2] = p.z;
        w.scratch[3] = p.yaw;
        w.scratch[4] = p.curv;
        w.scratch[5] = b(p.tunnel);
    }
    w.scratch.as_ptr()
}

/// Nearest centreline point. Writes `s, sExact, lateral, index, yaw, curv`.
#[no_mangle]
pub extern "C" fn synx_track_project(x: f64, z: f64, hint: f64) -> *const f64 {
    let w = world();
    if let Some(t) = &w.track {
        let p = t.project(x, z, hint);
        w.scratch[0] = p.s;
        w.scratch[1] = p.s_exact;
        w.scratch[2] = p.lateral;
        w.scratch[3] = p.index as f64;
        w.scratch[4] = p.yaw;
        w.scratch[5] = p.curv;
    }
    w.scratch.as_ptr()
}

// ---- vehicles -------------------------------------------------------------

/// The most cars that can exist at once.
///
/// The grid is small and fixed: the player, the rival, and on Chapter 4's
/// invitational two more. Sixteen is far more than the game will ever ask for,
/// and the whole table is four thousand doubles - so it is allocated once, up
/// front, and never moves. See the note inside `synx_veh_create`.
pub const MAX_CARS: usize = 16;

/// Create a car and return its handle. Handles are stable for the life of the
/// process; nothing destroys a car, because the game only ever has a fixed
/// small grid of them and reuses the slots.
#[no_mangle]
pub extern "C" fn synx_veh_create(lift: f64) -> u32 {
    let w = world();
    if w.cars.len() >= MAX_CARS {
        // out of slots: hand back the last one rather than corrupt the table
        return (MAX_CARS - 1) as u32;
    }

    /* THE STATE TABLE IS ALLOCATED ONCE AND NEVER MOVES.
     *
     * It used to be resized on every create, and a `Vec` that grows
     * REALLOCATES - it moves to a new address inside the same linear memory.
     * The JavaScript proxies cache the table's address, and their guard only
     * re-derives it when `memory.buffer` changes identity... which a Vec
     * reallocation does not do. So the moment Chapter 4 spawned Nova and Kael,
     * the player's and Ryker's proxies were still reading the OLD address:
     * both cars reported the right arc length and a position of exactly
     * (0, 0, 0), which is why they appeared stacked at the origin while the
     * pack drove the course.
     *
     * Reserving the whole table up front makes the address stable for the life
     * of the process, and the `memory.buffer` guard still covers the one case
     * that genuinely does move everything - WebAssembly memory growing. */
    if w.veh_state.is_empty() {
        w.veh_state.resize(MAX_CARS * VEH_STRIDE, 0.0);
    }

    let mut v = Vehicle::with_lift(lift);
    if let Some(t) = &w.track {
        v.reset(t, 0.0, 0.0);
    }
    w.cars.push(v);
    let id = (w.cars.len() - 1) as u32;
    let base = id as usize * VEH_STRIDE;
    let (cars, st) = (&w.cars, &mut w.veh_state);
    store_vehicle(&cars[id as usize], &mut st[base..base + VEH_STRIDE]);
    id
}

/// Address of the whole vehicle state table. Car `id`'s block starts at
/// `id * synx_veh_stride()`.
#[no_mangle]
pub extern "C" fn synx_veh_state() -> *mut f64 {
    world().veh_state.as_mut_ptr()
}

/// Load the block, run `f`, store it back.
///
/// EVERY entry point that writes the block must do this, and the reason is
/// worth stating once: `store_vehicle` writes the whole struct, so an export
/// that stores without loading first silently reverts every field JavaScript
/// has set since the last call. That is not a theoretical hazard - it is what
/// zeroed `lift` on every reset and sank all seven chapters' cars a metre into
/// the road, because `Game.load` sets `car.lift` once and `resetCar` then threw
/// it away.
fn with_car(id: u32, f: impl FnOnce(&mut Vehicle, &Track)) {
    let w = world();
    let i = id as usize;
    if i >= w.cars.len() {
        return;
    }
    let Some(t) = w.track.as_ref() else { return };
    let base = i * VEH_STRIDE;
    {
        let st = w.veh_state[base..base + VEH_STRIDE].to_vec();
        load_vehicle(&mut w.cars[i], &st);
    }
    // The track is borrowed immutably and the car mutably out of the same
    // struct; they are different fields, which the borrow checker cannot see
    // through an index.
    let t = t as *const Track;
    f(&mut w.cars[i], unsafe { &*t });
    store_vehicle(&w.cars[i], &mut w.veh_state[base..base + VEH_STRIDE]);
}

/// Put a car on the road at arc length `s`, `lateral` units off centre.
///
/// Configuration the game owns - the body lift, the engine that is fitted, a
/// director's grip and power scaling - survives this, because it is loaded
/// before `reset` runs and `reset` does not touch those fields. A rewind
/// inside a chapter must not un-fit an engine the player was given in a
/// cutscene, and every rewind in Chapters 5, 6 and 7 comes through here.
#[no_mangle]
pub extern "C" fn synx_veh_reset(id: u32, s: f64, lateral: f64) {
    with_car(id, |v, t| v.reset(t, s, lateral));
}

#[no_mangle]
/// Fit an engine: 0 stock, 1 the Forge rebuild, 2 the wreck Chapter 6 opens on.
pub extern "C" fn synx_veh_fit_engine(id: u32, kind: u32) {
    with_car(id, |v, _| v.fit_engine(kind));
}

/// Arm the next launch ramp for a car, or clear it with `h <= 0`.
///
/// One at a time: only one ramp can be being driven at once, and holding the
/// course's list of them in the solver would put level layout inside the
/// physics. The director arms the next one as the car comes up on it.
#[no_mangle]
pub extern "C" fn synx_veh_arm_ramp(id: u32, s0: f64, s1: f64, h: f64) {
    with_car(id, |v, _| v.arm_ramp(s0, s1, h));
}

/// Arm a ramp that has a CREST to drive along before it runs out.
///
/// `s1` is where the climb levels off, `s2` where the structure ends, and
/// `lip` the height there. It is what the bypass over MIRAGE CIRCUIT's blocked
/// bore is built from: a wedge launches you, and a thing you get OVER has a
/// top. `s2 == s1` with `lip == h` is exactly `synx_veh_arm_ramp`.
#[no_mangle]
pub extern "C" fn synx_veh_arm_ramp_deck(id: u32, s0: f64, s1: f64, s2: f64, h: f64, lip: f64) {
    with_car(id, |v, _| v.arm_ramp_deck(s0, s1, s2, h, lip));
}

/// Move a car to a lateral offset on the road WITHOUT resetting it.
///
/// An arrival is not a standing start: Chapter 1 opens with the player already
/// rolling in off the prologue, and `reset` would zero the velocity that makes
/// that read as arriving rather than as being placed. This puts the car on its
/// half of the grid and leaves everything else alone.
#[no_mangle]
pub extern "C" fn synx_veh_place_lateral(id: u32, s: f64, lateral: f64) {
    with_car(id, |v, t| {
        let p = t.at(s);
        let rx = p.yaw.cos();
        let rz = -p.yaw.sin();
        v.x = p.x + rx * lateral;
        v.z = p.z + rz * lateral;
        v.lateral = lateral;
        v.s_track = s;
        v.road_y = p.y;
        v.y = p.y + v.lift + v.body_y;
    });
}

/// Advance one car by `dt`.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn synx_veh_update(
    id: u32,
    dt: f64,
    steer: f64,
    throttle: f64,
    brake: f64,
    boost: u32,
    ebrake: u32,
    active: u32,
) {
    let w = world();
    let Some(t) = &w.track else { return };
    let i = id as usize;
    if i >= w.cars.len() {
        return;
    }
    let base = i * VEH_STRIDE;
    load_vehicle(&mut w.cars[i], &w.veh_state[base..base + VEH_STRIDE]);
    let input = Input { steer, throttle, brake, boost: boost != 0, ebrake: ebrake != 0 };
    w.cars[i].update(t, dt, input, active != 0);
    store_vehicle(&w.cars[i], &mut w.veh_state[base..base + VEH_STRIDE]);
}

/// Resolve a contact between two cars, returning the closing speed.
#[no_mangle]
pub extern "C" fn synx_collide_cars(a: u32, b: u32) -> f64 {
    let w = world();
    let (ai_, bi) = (a as usize, b as usize);
    if ai_ >= w.cars.len() || bi >= w.cars.len() || ai_ == bi {
        return 0.0;
    }
    let sa = ai_ * VEH_STRIDE;
    let sb = bi * VEH_STRIDE;
    // Two &mut into the same Vec: split so the borrow checker can see they are
    // disjoint, which they are because the handles differ.
    {
        let st = &w.veh_state;
        let (va, vb) = (st[sa..sa + VEH_STRIDE].to_vec(), st[sb..sb + VEH_STRIDE].to_vec());
        load_vehicle(&mut w.cars[ai_], &va);
        load_vehicle(&mut w.cars[bi], &vb);
    }
    let (lo, hi) = if ai_ < bi { (ai_, bi) } else { (bi, ai_) };
    let (left, right) = w.cars.split_at_mut(hi);
    let hit = if ai_ < bi {
        vehicle::collide_cars(&mut left[lo], &mut right[0])
    } else {
        vehicle::collide_cars(&mut right[0], &mut left[lo])
    };
    store_vehicle(&w.cars[ai_], &mut w.veh_state[sa..sa + VEH_STRIDE]);
    store_vehicle(&w.cars[bi], &mut w.veh_state[sb..sb + VEH_STRIDE]);
    hit
}

// ---- rival drivers --------------------------------------------------------

/// Build the racing line for the loaded course. One line per track, shared by
/// every driver on it.
#[no_mangle]
pub extern "C" fn synx_line_build() -> usize {
    let w = world();
    let Some(t) = &w.track else { return 0 };
    let line = RacingLine::build(t, t.half_width * 0.68);
    let n = line.count;
    w.line = Some(line);
    n
}

#[no_mangle]
pub extern "C" fn synx_driver_create(level: u32, seed: u32) -> u32 {
    let w = world();
    let cfg = match level {
        0 => ai::EASY,
        2 => ai::HARD,
        3 => ai::IMPOSSIBLE,
        _ => ai::MEDIUM,
    };
    let mut d = Driver::new(cfg, seed);
    if let Some(l) = &w.line {
        d.build_profile_for(l);
    }
    w.drivers.push(d);
    (w.drivers.len() - 1) as u32
}

#[no_mangle]
pub extern "C" fn synx_driver_set_level(id: u32, level: u32) {
    let w = world();
    let i = id as usize;
    if i >= w.drivers.len() {
        return;
    }
    let cfg = match level {
        0 => ai::EASY,
        2 => ai::HARD,
        3 => ai::IMPOSSIBLE,
        _ => ai::MEDIUM,
    };
    w.drivers[i].set_level(cfg);
    if let Some(l) = &w.line {
        w.drivers[i].build_profile_for(l);
    }
}

/// 0 none, 1 ryker, 2 kael, 3 nova, 4 predator.
#[no_mangle]
pub extern "C" fn synx_driver_set_personality(id: u32, p: u32) {
    let w = world();
    let i = id as usize;
    if i >= w.drivers.len() {
        return;
    }
    w.drivers[i].personality = match p {
        1 => Personality::Ryker,
        2 => Personality::Kael,
        3 => Personality::Nova,
        4 => Personality::Predator,
        _ => Personality::None,
    };
}

/// Replace a driver's whole difficulty profile.
///
/// Chapter 7 does not pick a difficulty, it *moves* one: the R-IX clones the
/// HARD entry and walks its skill, reaction, grip and appetite for a slide with
/// the prediction model's confidence. Setting the fields individually would
/// need one export each and would let the profile be read half-updated, so the
/// whole thing goes across at once.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn synx_driver_set_cfg(
    id: u32,
    skill: f64,
    assist: f64,
    target: f64,
    grip: f64,
    react: f64,
    boost_skill: f64,
    drift_skill: f64,
    mistakes: f64,
) {
    let w = world();
    let i = id as usize;
    if i >= w.drivers.len() {
        return;
    }
    w.drivers[i].cfg = ai::Level {
        skill, assist, target, grip, react, boost_skill, drift_skill, mistakes,
    };
    // Corner geometry is cached; grip and skill are applied during planning.
    // The level-7 director changes these each frame, so rebuilding the entire
    // course here would add work without changing any geometry.
    w.drivers[i].skill = skill;
}

/// Hand a driver a boost commitment directly. Chapter 7's director does this
/// coming out of a scripted beat, so the R-IX is already on the reserve when
/// control returns rather than spending a second deciding to be.
#[no_mangle]
pub extern "C" fn synx_driver_set_boost_hold(id: u32, secs: f64) {
    let w = world();
    let i = id as usize;
    if i < w.drivers.len() {
        w.drivers[i].set_boost_hold(secs);
    }
}

/// The shipped difficulty ladder, as nine doubles per level, so the front end
/// can clone and modify a profile without duplicating its numbers.
#[no_mangle]
pub extern "C" fn synx_levels() -> *const f64 {
    let w = world();
    let mut i = 0;
    for l in [ai::EASY, ai::MEDIUM, ai::HARD, ai::IMPOSSIBLE] {
        for v in [l.skill, l.assist, l.target, l.grip, l.react, l.boost_skill, l.drift_skill, l.mistakes] {
            w.scratch[i] = v;
            i += 1;
        }
    }
    w.scratch.as_ptr()
}

/// Director knobs. `lane_hint` is an absolute lateral; pass NaN for "not set",
/// which is what the JavaScript's `null` meant.
///
/// There used to be a fourth knob, `ram`: an absolute lateral for the R-IX to
/// drive AT, so Chapter 7's director could have it lean on the player. It is
/// gone, along with the controller behind it - see the note on `ai::Driver`.
/// A director can still say where a car should BE, through `lane_hint`, which
/// is a gap in the road furniture rather than another car.
#[no_mangle]
pub extern "C" fn synx_driver_tune(
    id: u32,
    pace_scale: f64,
    grip_scale: f64,
    lane_hint: f64,
) {
    let w = world();
    let i = id as usize;
    if i >= w.drivers.len() {
        return;
    }
    let d = &mut w.drivers[i];
    d.pace_scale = pace_scale;
    d.grip_scale = grip_scale;
    d.lane_hint = if lane_hint.is_nan() { None } else { Some(lane_hint) };
}

/// Produce one frame of driver input for the car in `car_id`.
///
/// Writes `steer, throttle, brake, boost, ebrake, lastTarget, skill` to the
/// scratch buffer and returns its address.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn synx_driver_drive(
    id: u32,
    car_id: u32,
    dt: f64,
    race_on: u32,
    has_rival: u32,
    rival_s: f64,
    rival_x: f64,
    rival_z: f64,
    finish_at: f64,
) -> *const f64 {
    let w = world();
    let di = id as usize;
    let ci = car_id as usize;
    if di >= w.drivers.len() || ci >= w.cars.len() || w.track.is_none() || w.line.is_none() {
        return w.scratch.as_ptr();
    }
    let base = ci * VEH_STRIDE;
    {
        let st = w.veh_state[base..base + VEH_STRIDE].to_vec();
        load_vehicle(&mut w.cars[ci], &st);
    }
    let view = WorldView {
        race_on: race_on != 0,
        has_rival: has_rival != 0,
        rival_s,
        rival_x,
        rival_z,
        finish_at,
    };
    let t = w.track.as_ref().unwrap();
    let l = w.line.as_ref().unwrap();
    let cmd = w.drivers[di].drive(dt, &w.cars[ci], t, l, &view);
    w.scratch[0] = cmd.steer;
    w.scratch[1] = cmd.throttle;
    w.scratch[2] = cmd.brake;
    w.scratch[3] = b(cmd.boost);
    w.scratch[4] = b(cmd.ebrake);
    w.scratch[5] = w.drivers[di].last_target;
    w.scratch[6] = w.drivers[di].skill;
    w.scratch.as_ptr()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The block layout has to describe itself accurately, or the bridge maps
    /// the wrong field onto the wrong name and every symptom is baffling.
    #[test]
    fn layout_covers_every_stored_field() {
        let v = Vehicle::default();
        let mut out = vec![f64::NAN; VEH_STRIDE];
        store_vehicle(&v, &mut out);
        assert_eq!(out.len(), VEH_FIELDS.len());
        for (i, f) in VEH_FIELDS.iter().enumerate() {
            assert!(!out[i].is_nan(), "field {i} ({f}) was never written by store_vehicle");
        }
    }

    #[test]
    fn field_names_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for f in VEH_FIELDS {
            assert!(seen.insert(*f), "duplicate field name {f} in the layout");
        }
    }

    /// Creating a car must not move the state table.
    ///
    /// It used to: the table was resized per create, a Vec reallocation moves
    /// it inside linear memory, and every JavaScript proxy caches its address.
    /// Chapter 4 spawning two more cars therefore left the player and the
    /// rival reading freed memory - both at (0, 0, 0), stacked on the origin.
    #[test]
    fn the_state_table_address_is_stable() {
        let w = world();
        w.cars.clear();
        w.veh_state.clear();
        let first = synx_veh_create(1.0532);
        let addr = w.veh_state.as_ptr() as usize;
        assert_eq!(first, 0);
        for _ in 0..(MAX_CARS - 1) {
            synx_veh_create(1.0532);
            assert_eq!(
                world().veh_state.as_ptr() as usize, addr,
                "the state table moved when a car was created"
            );
        }
        // ...and asking past the limit does not corrupt it either
        let last = synx_veh_create(1.0);
        assert_eq!(last as usize, MAX_CARS - 1);
        assert_eq!(world().veh_state.as_ptr() as usize, addr);
        assert!(world().veh_state.len() >= MAX_CARS * VEH_STRIDE);
    }

    /// The bug this whole `with_car` rule exists to prevent.
    ///
    /// `Game.load` sets `car.lift` once, from the measured `carLift` in
    /// scene.json, because the car's parts are exported around an origin that
    /// sits up inside the body. An export that stored without loading first
    /// wrote the struct's stale zero back over it on every reset - and every
    /// car in the game sat a metre into the road for it.
    #[test]
    fn reset_preserves_the_body_lift() {
        let mut v = Vehicle::default();
        v.lift = 1.0532;
        // the Forge rebuild, which a rewind must not undo
        v.fit_engine(crate::vehicle::Vehicle::ENGINE_SWAP);
        let mut block = vec![0.0; VEH_STRIDE];
        store_vehicle(&v, &mut block);

        // what `with_car` does: load, mutate, store
        let mut back = Vehicle::default();
        load_vehicle(&mut back, &block);
        assert_eq!(back.lift, 1.0532, "the load did not carry the lift");

        let t = {
            let mut c = crate::track::Centreline {
                step: 6.0, count: 64, shipped_count: 64, ..Default::default()
            };
            for i in 0..64 {
                c.x.push(0.0); c.y.push(0.0); c.z.push(i as f64 * 6.0);
                c.yaw.push(0.0); c.curv.push(0.0); c.tunnel.push(0);
            }
            Track::new(c)
        };
        back.reset(&t, 60.0, -5.5);
        assert_eq!(back.lift, 1.0532, "reset threw the lift away");
        assert!(
            (back.y - 1.0532).abs() < 1e-9,
            "the car sits at y={} on a road at y=0; it should be lifted clear",
            back.y
        );
        /* The engine survives too, and deliberately: `reset` is how every
           rewind in Chapters 5, 6 and 7 works, and a rewind must not un-fit an
           engine the player was given in a cutscene. `raceModeMultiplier`,
           `gripScale` and the surface effects are NOT in that set - `reset`
           clears them on purpose, because they are a director's momentary
           doing rather than something the car now has. */
        assert!(back.engine_top > 80.0, "reset un-fitted the Forge engine");
        assert_eq!(back.speed_cap, 122.0, "reset lost the swapped engine's ceiling");
        assert_eq!(back.race_mode_multiplier, 1.0, "reset should clear raceMode");

        let mut out = vec![0.0; VEH_STRIDE];
        store_vehicle(&back, &mut out);
        let li = VEH_FIELDS.iter().position(|n| *n == "lift").unwrap();
        assert_eq!(out[li], 1.0532, "the store wrote a zero lift back");
    }

    /// A store followed by a load must not disturb the fields a director owns.
    #[test]
    fn round_trip_preserves_director_fields() {
        let mut v = Vehicle::default();
        v.x = 12.5;
        v.race_mode_multiplier = 1.5;
        v.surface_grip = 0.4;
        v.grip_scale = 1.8;
        v.gear = 5;
        let mut block = vec![0.0; VEH_STRIDE];
        store_vehicle(&v, &mut block);
        let mut back = Vehicle::default();
        load_vehicle(&mut back, &block);
        assert_eq!(back.x, 12.5);
        assert_eq!(back.race_mode_multiplier, 1.5);
        assert_eq!(back.surface_grip, 0.4);
        assert_eq!(back.grip_scale, 1.8);
        assert_eq!(back.gear, 5);
    }
}

// ---- world mesh -----------------------------------------------------------

/// Reserve the geometry arena for a world build.
///
/// The caller passes a generous estimate; the common case then never
/// reallocates, and `synx_geo_grow_*` covers it if the estimate was low.
#[no_mangle]
pub extern "C" fn synx_geo_reset(vert_floats: usize, indices: usize) {
    world().mesh.arena.reset(vert_floats, indices);
}

#[no_mangle]
pub extern "C" fn synx_geo_vptr() -> *mut f32 {
    world().mesh.arena.verts.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn synx_geo_iptr() -> *mut u32 {
    world().mesh.arena.idx.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn synx_geo_vcap() -> usize {
    world().mesh.arena.verts.len()
}

#[no_mangle]
pub extern "C" fn synx_geo_icap() -> usize {
    world().mesh.arena.idx.len()
}

/// Grow the vertex buffer by at least `n` floats. Returns 1 if the allocation
/// moved, which is the signal for the caller to re-derive its typed-array view.
#[no_mangle]
pub extern "C" fn synx_geo_grow_verts(n: usize) -> u32 {
    u32::from(world().mesh.arena.grow_verts(n))
}

#[no_mangle]
pub extern "C" fn synx_geo_grow_idx(n: usize) -> u32 {
    u32::from(world().mesh.arena.grow_idx(n))
}

// ---- the landscape's distance field ---------------------------------------

/// Stamp the nearest-centreline-sample grid over the loaded course.
///
/// This is the landscape's most expensive step by a wide margin - twenty-four
/// million inner iterations at the shipped reach - and it is pure numeric work
/// with no art direction in it, which is why it lives here rather than in the
/// generator that consumes it.
// ---- baking instanced boxes into merged buffers ---------------------------
//
// See `mesh::Baker` for why this is in Rust at all. The call sequence is:
//
//     synx_bake_source(verts, indices)   -> reserve, then write through
//     synx_bake_src_v() / synx_bake_src_i()
//     synx_bake_instances(n)             -> reserve, then write through
//     synx_bake_mats()
//     synx_bake_run()                    -> vertex count; the geometry is in
//                                           the arena, at synx_geo_vptr()
//
// Every pointer is invalidated by the next call that can grow a Vec, which is
// the same rule every other bulk export here follows.
static mut BAKER: Option<crate::mesh::Baker> = None;

fn baker() -> &'static mut crate::mesh::Baker {
    unsafe {
        let b = &mut *core::ptr::addr_of_mut!(BAKER);
        if b.is_none() {
            *b = Some(crate::mesh::Baker::default());
        }
        b.as_mut().unwrap()
    }
}

#[no_mangle]
pub extern "C" fn synx_bake_source(verts: usize, indices: usize) {
    baker().set_source(verts, indices);
}

#[no_mangle]
pub extern "C" fn synx_bake_src_v() -> *mut f32 {
    baker().src_v.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn synx_bake_src_i() -> *mut u32 {
    baker().src_i.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn synx_bake_instances(n: usize) {
    baker().set_instances(n);
}

#[no_mangle]
pub extern "C" fn synx_bake_mats() -> *mut f32 {
    baker().mats.as_mut_ptr()
}

/// Bake, and report the vertex count. The index count is
/// `src_i.len() * instances`, which the caller already knows.
#[no_mangle]
pub extern "C" fn synx_bake_run() -> usize {
    let b = baker();
    b.bake(&mut world().mesh.arena)
}

// ---- ribbon strips --------------------------------------------------------
//
// Twelve ribbons a frame, rebuilt from scratch every frame. See
// `ribbon::Ribbons` for what was actually costing - which is the allocation,
// not the arithmetic.
//
//     synx_rib_begin(capQuads)          once a frame
//     synx_rib_nodes(count)  -> *mut f32   write one ribbon's nodes here
//     synx_rib_strip(...)    -> quads      ...and build it
//     synx_rib_out()         -> *const f32 the vertex data, synx_rib_quads() of them
static mut RIBBONS: Option<crate::ribbon::Ribbons> = None;

fn ribbons() -> &'static mut crate::ribbon::Ribbons {
    unsafe {
        let r = &mut *core::ptr::addr_of_mut!(RIBBONS);
        if r.is_none() {
            *r = Some(crate::ribbon::Ribbons::default());
        }
        r.as_mut().unwrap()
    }
}

#[no_mangle]
pub extern "C" fn synx_rib_begin(cap_quads: usize) {
    ribbons().begin(cap_quads);
}

#[no_mangle]
pub extern "C" fn synx_rib_nodes(count: usize) -> *mut f32 {
    ribbons().nodes_for(count).as_mut_ptr()
}

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn synx_rib_strip(
    count: usize,
    head: usize,
    max: usize,
    life: f32,
    ground: u32,
    cam_x: f32,
    cam_y: f32,
    cam_z: f32,
    cap_quads: usize,
) -> usize {
    ribbons().strip(count, head, max, life, ground != 0, [cam_x, cam_y, cam_z], cap_quads)
}

#[no_mangle]
pub extern "C" fn synx_rib_out() -> *const f32 {
    ribbons().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn synx_rib_quads() -> usize {
    ribbons().quads
}

#[no_mangle]
pub extern "C" fn synx_land_stamp() -> usize {
    let w = world();
    let Some(t) = &w.track else { return 0 };
    // `stamp` borrows the centreline immutably and writes the grid, which
    // lives in a different field; the clone of the shape avoids holding both
    // borrows of `w` at once without copying the samples themselves.
    let c = &t.c as *const crate::track::Centreline;
    unsafe { w.mesh.stamp(&*c) };
    w.mesh.gw * w.mesh.gh
}

#[no_mangle]
pub extern "C" fn synx_land_near() -> *const i32 {
    world().mesh.near.as_ptr()
}

/// Grid metrics: width, height, origin x, origin z, cell size.
#[no_mangle]
pub extern "C" fn synx_land_grid() -> *const f64 {
    let w = world();
    w.scratch[0] = w.mesh.gw as f64;
    w.scratch[1] = w.mesh.gh as f64;
    w.scratch[2] = w.mesh.x0;
    w.scratch[3] = w.mesh.z0;
    w.scratch[4] = w.mesh.cell;
    w.scratch.as_ptr()
}

// ---- multiplayer ----------------------------------------------------------
//
// The netcode itself is in `crate::net`; this is only the seam. Everything
// crossing here is a scalar or a pointer into linear memory, exactly like the
// rest of this file, so a snapshot goes from the socket into the interpolator
// without ever becoming a JavaScript object.
//
// THE SHAPE OF A FRAME, on the client:
//
//   1. js/net.js hands every arrived WebSocket frame to `synx_net_ingest`.
//   2. js/game.js calls `synx_net_sample` once, before anything reads a car.
//   3. For each remote player, `synx_net_apply` writes the interpolated pose
//      into that car's ordinary vehicle state block, so the renderer, the
//      lights and the collision resolver see a normal car.
//   4. On the send tick, `synx_net_pack_state` fills the outbound buffer and
//      js/net.js posts `synx_net_out_ptr`/`synx_net_out_len` to the socket.
//
// None of it allocates on the per-frame path.

/// Discard every peer, the clock and the playout buffer. Called on connect, on
/// disconnect and on leaving a room.
#[no_mangle]
pub extern "C" fn synx_net_reset(self_slot: u32) {
    let c = crate::net::client();
    c.reset();
    c.self_slot = if self_slot > 255 { 255 } else { self_slot as u8 };
}

/// Which seat this client occupies. Cheap, and safe to call every time the
/// room changes - unlike `synx_net_reset`, which also discards the clock.
#[no_mangle]
pub extern "C" fn synx_net_self(slot: u32) {
    crate::net::client().set_self(if slot > 255 { 255 } else { slot as u8 });
}

/// Mark a seat as occupied or empty. An empty seat is not interpolated and not
/// drawn.
///
/// Turning a seat ON discards whatever history it had: the same slot number is
/// reused when one player leaves and another joins, and interpolating the new
/// car from the old one's last known position would fly it across the map.
#[no_mangle]
pub extern "C" fn synx_net_peer(slot: u32, on: u32) {
    let c = crate::net::client();
    let Some(p) = c.peers.get_mut(slot as usize) else { return };
    if on == 0 {
        if p.active {
            p.reset_history();
        }
        p.active = false;
        p.visible = false;
    } else if !p.active {
        p.reset_history();
        p.active = true;
    }
}

/// Hand one received frame to the netcode.
///
/// Returns a `crate::net::ingest` code. A `PING` result means the transport
/// must send the queued answer at `synx_net_out_ptr`.
///
/// # Safety
/// `ptr` must address `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn synx_net_ingest(ptr: *const u8, len: usize, now_ms: f64) -> u32 {
    if ptr.is_null() || len == 0 || len > 64 * 1024 {
        return crate::net::ingest::NOTHING;
    }
    let frame = core::slice::from_raw_parts(ptr, len);
    crate::net::client().ingest(frame, now_ms)
}

/// Advance every remote car to the moment that should be drawn now.
#[no_mangle]
pub extern "C" fn synx_net_sample(now_ms: f64, dt: f64) {
    crate::net::client().sample(now_ms, dt);
}

/// Write seat `slot`s interpolated pose into vehicle `car_id`.
///
/// Returns 1 when the car should be drawn and 0 when there is nothing known
/// about it yet - a player who has joined but whose first snapshot has not
/// arrived, or one whose connection has gone quiet.
#[no_mangle]
pub extern "C" fn synx_net_apply(slot: u32, car_id: u32) -> u32 {
    let state = {
        let c = crate::net::client();
        let Some(p) = c.peers.get(slot as usize) else { return 0 };
        if !p.active || !p.visible {
            return 0;
        }
        p.render
    };
    let w = world();
    let id = car_id as usize;
    if id >= w.cars.len() {
        return 0;
    }
    crate::net::apply_to_vehicle(&mut w.cars[id], &state);
    crate::net::publish(id);
    1
}

/// Build this clients outbound state packet. Returns its length.
#[no_mangle]
pub extern "C" fn synx_net_pack_state(
    car_id: u32,
    now_ms: f64,
    flags: u32,
    checkpoint: u32,
) -> usize {
    let w = world();
    let id = car_id as usize;
    if id >= w.cars.len() {
        return 0;
    }
    // The car is loaded from its published block first, because a director may
    // have moved it this frame and the block is where that lands.
    let base = id * VEH_STRIDE;
    if w.veh_state.len() >= base + VEH_STRIDE {
        let src: Vec<f64> = w.veh_state[base..base + VEH_STRIDE].to_vec();
        load_vehicle(&mut w.cars[id], &src);
    }
    let car = w.cars[id].clone();
    crate::net::client().pack_state(&car, now_ms, flags as u8, checkpoint as u8)
}

/// Build a clock-sync request. Returns its length.
#[no_mangle]
pub extern "C" fn synx_net_pack_time(now_ms: f64) -> usize {
    crate::net::client().pack_time_req(now_ms)
}

#[no_mangle]
pub extern "C" fn synx_net_out_ptr() -> *const u8 {
    crate::net::client().out_ptr()
}

#[no_mangle]
pub extern "C" fn synx_net_out_len() -> usize {
    crate::net::client().out_len()
}

/// Take the pending correction, if there is one, and apply it to `car_id`.
///
/// Returns the reason code (see `synx_net::Correction`) or 0 for none. The
/// correction is consumed, so calling twice in a frame reports it once.
#[no_mangle]
pub extern "C" fn synx_net_take_correction(car_id: u32) -> u32 {
    let taken = crate::net::client().correction.take();
    let Some((reason, state)) = taken else { return 0 };
    let w = world();
    let id = car_id as usize;
    if id < w.cars.len() {
        let base = id * VEH_STRIDE;
        if w.veh_state.len() >= base + VEH_STRIDE {
            let src: Vec<f64> = w.veh_state[base..base + VEH_STRIDE].to_vec();
            load_vehicle(&mut w.cars[id], &src);
        }
        // The car and the net client both come out of statics. Copying the one
        // through the stack keeps the disjointness obvious rather than merely
        // true, and a Vehicle is a few hundred bytes on a path that runs at
        // most a handful of times a second.
        let mut car = w.cars[id].clone();
        crate::net::client().apply_correction(&mut car, &state);
        w.cars[id] = car;
        crate::net::publish(id);
    }
    reason as u32
}

/// Resolve the local car against a remote one. Returns the closing speed, in
/// the same units and with the same meaning as `synx_collide_cars`.
#[no_mangle]
pub extern "C" fn synx_net_collide(local_id: u32, remote_id: u32) -> f64 {
    let w = world();
    let (a, b) = (local_id as usize, remote_id as usize);
    if a == b || a >= w.cars.len() || b >= w.cars.len() {
        return 0.0;
    }
    let remote = w.cars[b].clone();
    let mut local = w.cars[a].clone();
    let hit = crate::net::collide_local(&mut local, &remote);
    if hit > 0.0 {
        w.cars[a] = local;
        crate::net::publish(a);
    }
    hit
}

/// Everything the diagnostics overlay and the lobby read, in one block so it
/// is one call a frame rather than twelve.
///
/// `[0]` clock offset ms, `[1]` round trip ms, `[2]` playout delay ms,
/// `[3]` frames in, `[4]` bytes in, `[5]` frames out, `[6]` bytes out,
/// `[7]` malformed frames dropped, `[8]` corrections taken,
/// `[9]` snapshot flags, `[10]` clock settled, `[11]` local smoothing left.
#[no_mangle]
pub extern "C" fn synx_net_stats() -> *const f64 {
    let c = crate::net::client();
    let (offset, rtt, delay, have) =
        (c.clock.offset(), c.clock.rtt(), c.playout.delay_ms(), c.clock.have);
    let err = c.local_smoothing();
    let mag = (err[0] * err[0] + err[1] * err[1] + err[2] * err[2]).sqrt();
    let (rx_f, rx_b, tx_f, tx_b) = (c.rx_frames, c.rx_bytes, c.tx_frames, c.tx_bytes);
    let (dropped, corrections, flags) = (c.dropped, c.corrections, c.last_snapshot_flags);
    let w = world();
    let s = &mut w.scratch;
    s[0] = offset;
    s[1] = rtt;
    s[2] = delay;
    s[3] = rx_f as f64;
    s[4] = rx_b as f64;
    s[5] = tx_f as f64;
    s[6] = tx_b as f64;
    s[7] = dropped as f64;
    s[8] = corrections as f64;
    s[9] = flags as f64;
    s[10] = if have { 1.0 } else { 0.0 };
    s[11] = mag;
    s.as_ptr()
}

/// The offset the renderer should still add to the local car after a
/// correction, as three doubles in the shared scratch.
#[no_mangle]
pub extern "C" fn synx_net_local_offset() -> *const f64 {
    let err = crate::net::client().local_smoothing();
    let w = world();
    w.scratch[0] = err[0];
    w.scratch[1] = err[1];
    w.scratch[2] = err[2];
    w.scratch.as_ptr()
}

// ---- registration proof of work -------------------------------------------
//
// The server issues a challenge and asks for a nonce whose SHA-256 has a
// number of leading zero bits. Solving it in JavaScript would mean either
// sixty-five thousand synchronous hashes on the main thread - a visible freeze
// on the one screen that is supposed to feel quick - or a Web Worker, a second
// file and a message protocol to avoid one.
//
// It is a tight integer loop over a short buffer, which is what this module is
// for. `synx_net::pow` is the same code the server verifies with, so a
// solution produced here is a solution accepted there by construction.
//
// The search is BUDGETED rather than unbounded: JavaScript calls it in slices
// of a few thousand attempts between frames, so the interface keeps animating
// while it works and a challenge that turns out to be unusually hard cannot
// hang the game.

/// Scratch the challenge is written into. 128 bytes is four times what the
/// server issues.
static mut POW_BUF: [u8; 128] = [0; 128];

/// This core's wire fingerprint, and the protocol version beside it.
///
/// Reported from here rather than from the host process on purpose. The
/// fingerprint that matters is the one belonging to the code that actually
/// encodes and decodes cars, and that code is compiled into this module. If
/// the WebAssembly were ever built against a different copy of the protocol
/// than the host was, this is the value that would disagree with the server -
/// and disagreeing loudly, at the handshake, is the entire point.
#[no_mangle]
pub extern "C" fn synx_wire_fingerprint() -> u32 {
    synx_net::WIRE_FINGERPRINT
}

/// The protocol version this core speaks.
#[no_mangle]
pub extern "C" fn synx_wire_protocol() -> u32 {
    synx_net::PROTOCOL_VERSION as u32
}

/// Address of the challenge buffer, for JavaScript to write into.
#[no_mangle]
pub extern "C" fn synx_pow_buf() -> *mut u8 {
    #[allow(static_mut_refs)]
    unsafe {
        POW_BUF.as_mut_ptr()
    }
}

/// Search `limit` nonces starting at `start`.
///
/// Returns the nonce, or `u32::MAX` when the budget ran out - which is not a
/// failure, it is "call me again with a later start".
#[no_mangle]
pub extern "C" fn synx_pow_solve(len: usize, bits: u32, start: u32, limit: u32) -> u32 {
    if len > 128 || bits > 32 {
        return u32::MAX;
    }
    #[allow(static_mut_refs)]
    let challenge = unsafe { &POW_BUF[..len] };
    match synx_net::pow::solve(challenge, bits, start as u64, limit as u64) {
        Some(n) if n <= u32::MAX as u64 => n as u32,
        _ => u32::MAX,
    }
}

/// Hash the buffer and hand back the digest in the shared scratch, one byte
/// per double.
///
/// Used for the device print: the game folds several awkward-to-transmit
/// signals - what its canvas rendered, what its audio stack produced, which
/// fonts resolved - into one short digest rather than sending any of them.
#[no_mangle]
pub extern "C" fn synx_pow_digest(len: usize) -> *const f64 {
    let n = len.min(128);
    #[allow(static_mut_refs)]
    let d = synx_net::pow::sha256(unsafe { &POW_BUF[..n] });
    let w = world();
    for (i, b) in d.iter().enumerate().take(32) {
        w.scratch[i] = *b as f64;
    }
    w.scratch.as_ptr()
}

// ---- particles ------------------------------------------------------------
//
// See `particles` for why the sprite system's two hot loops are on this side
// of the boundary. The buffer is owned here and written from JavaScript: one
// pointer, mapped once, and nothing else crosses per frame.

static mut PARTS: Option<crate::particles::Particles> = None;

fn parts() -> &'static mut crate::particles::Particles {
    unsafe {
        let p = &mut *core::ptr::addr_of_mut!(PARTS);
        if p.is_none() {
            *p = Some(crate::particles::Particles::default());
        }
        p.as_mut().unwrap()
    }
}

/// Allocate for `max` particles. Safe to call again; it reallocates, so the
/// caller must re-derive its views afterwards.
#[no_mangle]
pub extern "C" fn synx_fx_reset(max: usize) {
    parts().reset(max);
}

/// The particle buffer: `max * synx_fx_stride()` floats, laid out as
/// `particles::f`. JavaScript writes this directly when it spawns.
#[no_mangle]
pub extern "C" fn synx_fx_pptr() -> *mut f32 {
    parts().p.as_mut_ptr()
}

/// The vertex buffer `synx_fx_build` fills, ready for `bufferSubData`.
#[no_mangle]
pub extern "C" fn synx_fx_optr() -> *mut f32 {
    parts().out.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn synx_fx_stride() -> usize {
    crate::particles::STRIDE
}

/// Step every live particle. Returns how many are still alive.
#[no_mangle]
pub extern "C" fn synx_fx_integrate(dt: f32) -> usize {
    parts().integrate(dt)
}

/// Expand the live particles into camera-facing triangles. Returns the number
/// of VERTICES written to `synx_fx_optr`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn synx_fx_build(
    rx: f32, ry: f32, rz: f32,
    ux: f32, uy: f32, uz: f32,
    fx: f32, fy: f32, fz: f32,
) -> usize {
    parts().build([rx, ry, rz], [ux, uy, uz], [fx, fy, fz])
}

// ---------------------------------------------------------------- driver --
//
// The figure in the seat, posed. See `driver` for why seventeen small
// matrices a car turned out to be worth crossing the boundary for.
//
// The part table is uploaded once and lives here for the session; the only
// thing that crosses per frame is the car transform and the steering angle,
// and the only thing that comes back is a pointer.

static mut RIG: Option<crate::driver::Rig> = None;

fn rig() -> &'static mut crate::driver::Rig {
    unsafe {
        let r = &mut *core::ptr::addr_of_mut!(RIG);
        if r.is_none() {
            *r = Some(crate::driver::Rig::new());
        }
        r.as_mut().unwrap()
    }
}

/// Where the head is placed, in figure space. The first-person eye is
/// measured from this rather than from a second constant that would have to
/// be kept in step with it by hand.
#[no_mangle]
pub extern "C" fn synx_drv_head(x: f32, y: f32, z: f32) {
    rig().set_head(x as f64, y as f64, z as f64);
}

/// The driver's eye and where it is looking, against whatever is in MODEL.
/// Six floats: three of eye, three of look-at.
#[no_mangle]
pub extern "C" fn synx_cam_pov(yaw: f32, pitch: f32) -> *const f32 {
    let m = unsafe { &*core::ptr::addr_of!(MODEL) };
    rig().pov(m, yaw as f64, pitch as f64).as_ptr()
}

/// Where the steering wheel is and how far it is raked, in figure space.
#[no_mangle]
pub extern "C" fn synx_drv_hub(x: f32, y: f32, z: f32, rake: f32) {
    rig().set_hub(x as f64, y as f64, z as f64, rake as f64);
}

/// The scratch the caller writes the part table into, before
/// `synx_drv_load`. `n` records of `synx_drv_stride()` floats.
#[no_mangle]
pub extern "C" fn synx_drv_tptr(n: usize) -> *mut f32 {
    let t = table();
    t.resize(n * crate::driver::STRIDE, 0.0);
    t.as_mut_ptr()
}

static mut TABLE: Option<Vec<f32>> = None;

fn table() -> &'static mut Vec<f32> {
    unsafe {
        let t = &mut *core::ptr::addr_of_mut!(TABLE);
        if t.is_none() {
            *t = Some(Vec::new());
        }
        t.as_mut().unwrap()
    }
}

#[no_mangle]
pub extern "C" fn synx_drv_stride() -> usize {
    crate::driver::STRIDE
}

/// Take the table that was written to `synx_drv_tptr`. Returns how many
/// parts were read, which the caller checks against what it sent.
#[no_mangle]
pub extern "C" fn synx_drv_load() -> usize {
    let raw = table().clone();
    let r = rig();
    r.load(&raw);
    r.len()
}

/// The car transform the next pose is taken against: sixteen floats, written
/// by the caller before `synx_drv_pose`.
///
/// A fixed slot of its own rather than a pointer passed in, and rather than
/// borrowing the table scratch - which the first version did, by asking for a
/// table of zero parts and writing sixteen floats into the empty vector that
/// came back. The table is also not free to reuse: it holds the part list
/// between frames.
static mut MODEL: [f32; 16] = [0.0; 16];

#[no_mangle]
pub extern "C" fn synx_drv_mptr() -> *mut f32 {
    // addr_of_mut on a static is not itself unsafe; only reading through it is
    core::ptr::addr_of_mut!(MODEL) as *mut f32
}

/// Every part's world matrix, for one figure, against whatever is in MODEL.
#[no_mangle]
pub extern "C" fn synx_drv_pose(spin: f32, hand: f32, press: f32) -> *mut f32 {
    let r = rig();
    if r.is_empty() {
        return r.out_ptr();
    }
    let m = unsafe { &*core::ptr::addr_of!(MODEL) };
    /* TWO ANGLES. `spin` is how far the rim has turned and `hand` how far the
       hands have gone round with it - the same number until the rim is past
       about seventy degrees, and then not. See GRIP in driver.rs. */
    r.pose(m, spin as f64, hand as f64, press as f64);
    r.out_ptr()
}
