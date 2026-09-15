//! Four-wheel vehicle simulation, ported from `js/vehicle.js`.
//!
//! This is a real car, not a bicycle with a paint job: four independent
//! suspension corners, per-wheel angular velocity, Pacejka-shaped tyres with
//! relaxation length combined through a friction ellipse, and collisions
//! resolved as impulses at the contact corner. Everything is SI, and the
//! solver runs at a fixed 240 Hz so a stiff tyre model stays stable.
//!
//! # Porting notes
//!
//! Two JavaScript behaviours are load-bearing and are reproduced deliberately
//! rather than replaced with the idiomatic Rust:
//!
//!   * `Math.sign(0)` is `0`, while Rust's `f64::signum(0.0)` is `1.0`. The
//!     rolling-resistance and reverse terms both feed on that zero, so
//!     `math::sign` is used throughout and `signum` never is.
//!   * Reads of possibly-unset fields (`this.surfaceGrip === undefined ? 1 :
//!     ...`) become plain defaults on construction, because the struct cannot
//!     be partially initialised.
//!
//! The world is not in metres. The art and the physics were authored to
//! different scales and a world unit is about 0.733 m; the solver works in
//! world units and every speed it *reports* is converted through
//! [`UNIT_METRES`].

use crate::math::{clamp, damp, sign};
use crate::track::{Projection, Track};

pub const UNIT_METRES: f64 = 0.733;

// --- geometry / mass -------------------------------------------------------
const MASS: f64 = 1400.0;
const WHEELBASE: f64 = 3.716;
const TRACK_WIDTH: f64 = 2.21;
const FRONT_WEIGHT: f64 = 0.45;
const CG_HEIGHT: f64 = 0.44;
const WHEEL_RADIUS: f64 = 0.45;
const WHEEL_INERTIA: f64 = 1.45;
const HALF_LENGTH: f64 = 2.45;
const HALF_WIDTH: f64 = 1.06;

// --- suspension ------------------------------------------------------------
const SPRING_F: f64 = 38000.0;
const SPRING_R: f64 = 34000.0;
const DAMP_BUMP_F: f64 = 2900.0;
const DAMP_BUMP_R: f64 = 2650.0;
const DAMP_REB_F: f64 = 4100.0;
const DAMP_REB_R: f64 = 3700.0;
const ARB_F: f64 = 14000.0;
const ARB_R: f64 = 8000.0;
/* ROLL DAMPING, ON THE MODE ITSELF.
 *
 * The corner dampers resist roll already - one side in bump while the other is
 * in rebound - and across both axles that is about sixteen thousand against a
 * critical figure of thirty-eight, so the roll mode runs at about 0.43 of
 * critical. That is fine for a corner and not enough for a REVERSAL: measured
 * through a full-lock flick out of a drift, the body went from its two-degree
 * cornering attitude to the nine-degree stop in three frames and sat there.
 * The lateral force really does swing that far when a drifting car changes
 * hands, so the excursion is not a bug in the tyres; what it wants is the
 * damper valving a car built for this would have in roll.
 *
 * Twelve thousand takes the mode to about 0.75 of critical. It acts on roll
 * VELOCITY only, so a steady corner - where that velocity is zero - is exactly
 * the car it was: same attitude, same load transfer, same grip. All it changes
 * is how violently the body is allowed to get between two attitudes. */
const ROLL_DAMP: f64 = 12000.0;
const TRAVEL: f64 = 0.16;
/* How far the body may lean. It used to be written as the bare 0.16 that
   TRAVEL happens to be, which reads as the same number meaning the same thing
   and is a coincidence: one is a suspension displacement in metres, this is an
   angle in radians.

   Six and a half degrees rather than the nine the springs could physically
   reach. A car this low does not lean nine degrees and look like anything but
   a car falling over, and with ROLL_DAMP in the mode it should not be near
   either number outside a collision. */
const ROLL_MAX: f64 = 0.115;
/* BUMP STOPS. Past this much compression beyond the static ride height the
   spring is not the only thing left: the rubber stop closes and the rate goes
   up as the square of how far into it the corner is.

   The car had a linear rate to the end of its travel and then a hard clamp,
   which is a wall - the load stops rising at the exact moment the road is
   asking the tyre for the most it will ever give. It is why a landing off the
   stunt ramp used to arrive with no weight in it: the springs bottomed, the
   loads froze at their bottomed value, and the tyres had nothing extra to grip
   with at the one moment the car most needed it. */
const BUMP_GAP: f64 = 0.11;
const BUMP_STOP: f64 = 1_400_000.0;

/* SUSPENSION GEOMETRY: the transfer that does NOT go through the springs.

   Every gram of load transfer in this model used to be elastic - the body had
   to physically roll or pitch on its springs before a tyre saw any of it, and
   the roll mode takes about a fifth of a second to get there. Real suspension
   does not work like that. A wishbone points at a roll centre above the road,
   and the part of the cornering force that acts through that point is fed
   straight into the tyre by the links, arriving in the same instant the force
   does. The same geometry resists dive and squat.

   Splitting it matters to how the car FEELS more than to what it can do:
   turn-in gets its load immediately instead of a fifth of a second late, the
   nose stops diving so far under brakes, and the springs are left carrying
   only the part of the moment that is genuinely above the roll centre. */
const RC_FRONT: f64 = 0.085;
const RC_REAR: f64 = 0.125;
const ANTI_DIVE: f64 = 0.55;
const ANTI_SQUAT: f64 = 0.35;

/* THE LIMITED-SLIP DIFFERENTIAL. The rear axle used to be a bare 50/50 torque
   split with nothing tying the two wheels together, so the inner rear was free
   to light up on its own on every corner exit and take its half of the torque
   with it into a wheelspin the other side could do nothing about.

   A clutch-pack diff resists a speed DIFFERENCE with a torque that rises with
   how hard the axle is being driven: preload always, plus a ramp fraction of
   the axle torque, capped where the pack is fully clamped. Torque is moved
   from the faster wheel to the slower one, which is a transfer and not an
   addition - the axle total is untouched. */
const DIFF_PRELOAD: f64 = 120.0;
const DIFF_RAMP: f64 = 0.16;
const DIFF_MAX: f64 = 1600.0;
const DIFF_SLIP: f64 = 4.0;

// --- engine ----------------------------------------------------------------
const IDLE_RPM: f64 = 950.0;
const REDLINE: f64 = 8000.0;
const TORQUE_PEAK: f64 = 560.0;
const DRIVE_EFF: f64 = 0.92;
const RATIOS: [f64; 7] = [16.5, 11.6, 9.0, 7.2, 6.0, 5.2, 4.68];
const SHIFT_UP: f64 = 7550.0;
const SHIFT_DOWN: f64 = 4100.0;
const SHIFT_TIME: f64 = 0.12;
const SHIFT_HOLD: f64 = 0.42;
const SHIFT_MARGIN: f64 = 300.0;
const TOP_SPEED: f64 = 290.0 / 3.6;
const BOOST_THRUST: f64 = 7600.0;
const BOOST_TOP: f64 = 1.34;
/// The Forge engine swap: 144 mph base, 200 mph hard ceiling.
const SWAP_TOP: f64 = 88.0;
const SWAP_CAP: f64 = 122.0;
const SWAP_POWER: f64 = 1.20;
/* THE CAR RYKER LEFT IN THE CALDERA: 70 mph, and it feels like it.
 *
 * Chapter 6 opens on a car that has just been put through a wall at the end
 * of Chapter 5 and driven to the Forge on what was left of it - and it was
 * doing a hundred and thirty-two miles an hour through every trial, which is
 * the street car in perfect health. The rebuild at the end of the chapter is
 * the whole point of the chapter, and it was a twelve-mile-an-hour present.
 *
 * Seventy on the block, seventy-eight if the reheat is asked for something it
 * has not got, and a bit over half the power to get there with. The rebuild
 * then doubles it, which is what a rebuild should feel like: the calibration
 * run on Straight 07 is the first time the car has been a car all chapter.
 *
 * The numbers are in world units - see UNIT_METRES - so 70 mph is
 * 70 / 2.23694 metres a second over 0.733 metres a unit. */
const BROKEN_TOP: f64 = 42.7;
const BROKEN_CAP: f64 = 47.6;
const BROKEN_POWER: f64 = 0.58;
const BOOST_BURN: f64 = 0.28;
const BOOST_FILL: f64 = 1.6 / 12.0;
const BOOST_ARM: f64 = 0.34;
const REVERSE_TORQUE: f64 = 1500.0;
const REVERSE_ARM: f64 = 0.30;
const GEARS: usize = 7;

// --- brakes / resistance ---------------------------------------------------
const BRAKE_TORQUE: f64 = 4200.0;
const ABS_SLIP: f64 = 0.13;
const ENGINE_BRAKE: f64 = 26.0;
const DRAG: f64 = 0.4592;
/// How much more drag a completely wrecked body carries, as a fraction of the
/// clean car's. See `Vehicle::damage`.
const DAMAGE_DRAG: f64 = 0.42;
/// ...and how much of the reheat's thrust it costs.
const DAMAGE_BOOST: f64 = 0.22;
const ROLL_RESIST: f64 = 0.014;
const DOWNFORCE: f64 = 0.62;
/* ...and how much of it lands on the front axle. Deliberately less than the
   car's own 45% static split: a rearward aero balance is what makes a fast car
   calm at the top of sixth, because the axle that decides whether a twitch
   becomes a spin is the one gaining grip fastest with speed. */
const AERO_FRONT: f64 = 0.38;

// --- tyres -----------------------------------------------------------------
const LAT_STIFF: f64 = 8.6;
const LAT_SHAPE: f64 = 1.55;
const LONG_STIFF: f64 = 16.0;
const LONG_SHAPE: f64 = 1.62;
const GRIP_FRONT: f64 = 2.62;
const GRIP_REAR: f64 = 2.92;
const LOAD_SENS: f64 = 0.22;
const RELAX_LAT: f64 = 0.42;
const RELAX_LONG: f64 = 0.28;
const OFFROAD_GRIP: f64 = 0.44;
const OFFROAD_DRAG: f64 = 5200.0;
const OFFROAD_DRAG_SPEED: f64 = 9.0;
const BACKTRACK: f64 = 55.0;

// --- steering --------------------------------------------------------------
const MAX_STEER: f64 = 30.0 * core::f64::consts::PI / 180.0;
const STEER_RATE: f64 = 3.6;
const STEER_RETURN: f64 = 2.6;
const ACKERMANN: f64 = 0.55;
const STEER_TARGET_G: f64 = 2.05;
const YAW_DAMP: f64 = 2.3;

// --- the drift -------------------------------------------------------------
const DRIFT_ANGLE: f64 = 0.66;
const DRIFT_MIN_SPEED: f64 = 11.0;
const DRIFT_BETA_P: f64 = 2.1;
const DRIFT_AUTHORITY: f64 = 18.0;
const DRIFT_RATE_UP: f64 = 7.0;
const DRIFT_RATE_DOWN: f64 = 2.4;
const DRIFT_KICK_TIME: f64 = 0.34;
const DRIFT_KICK_BRAKE: f64 = 2600.0;
const DRIFT_KICK_GRIP: f64 = 0.66;
const DRIFT_REAR_GRIP: f64 = 0.88;
const DRIFT_PUSH: f64 = 9000.0;
const SPIN_LIMIT: f64 = 0.46;
const SPIN_MARGIN: f64 = 0.30;
const SPIN_AUTHORITY: f64 = 6.0;
const SPIN_RECOVER: f64 = 1.15;

// --- collision -------------------------------------------------------------
const WALL_RESTITUTION: f64 = 0.34;
const WALL_FRICTION: f64 = 0.55;
const WALL_STUN: f64 = 0.55;

const FIXED_DT: f64 = 1.0 / 240.0;
const MAX_STEPS: usize = 24;

const G: f64 = 9.81;
const A_ARM: f64 = WHEELBASE * (1.0 - FRONT_WEIGHT);
const B_ARM: f64 = WHEELBASE * FRONT_WEIGHT;
const YAW_I: f64 = MASS * A_ARM * B_ARM;
const PITCH_I: f64 = MASS * 0.29 * WHEELBASE * WHEELBASE;
const ROLL_I: f64 = MASS * 0.30 * TRACK_WIDTH * TRACK_WIDTH;
/// The share of each transfer the links take, averaged over the two axles by
/// weight. What is left is what the springs are asked for. See RC_FRONT.
const ANTI_MEAN: f64 = ANTI_DIVE * FRONT_WEIGHT + ANTI_SQUAT * (1.0 - FRONT_WEIGHT);
const RC_MEAN: f64 = RC_FRONT * FRONT_WEIGHT + RC_REAR * (1.0 - FRONT_WEIGHT);
const TARGET_LAT: f64 = STEER_TARGET_G * G / UNIT_METRES;
const RPM_PER_RAD: f64 = 60.0 / (2.0 * core::f64::consts::PI);
const HW: f64 = TRACK_WIDTH * 0.5;

/// The four wheels in body axes (`l` forward, `w` right), FL FR RL RR.
struct WheelCfg {
    l: f64,
    w: f64,
    front: bool,
}
const WHEELS: [WheelCfg; 4] = [
    WheelCfg { l: A_ARM, w: -HW, front: true },
    WheelCfg { l: A_ARM, w: HW, front: true },
    WheelCfg { l: -B_ARM, w: -HW, front: false },
    WheelCfg { l: -B_ARM, w: HW, front: false },
];

#[inline(always)]
fn magic(slip: f64, stiff: f64, shape: f64) -> f64 {
    (shape * (stiff * slip).atan()).sin()
}

/// Crank torque. Rises hard off idle, plateaus, then falls to the limiter.
#[inline]
fn engine_torque(rpm: f64) -> f64 {
    let x = clamp(rpm, IDLE_RPM, REDLINE) / REDLINE;
    TORQUE_PEAK * (0.45 + 1.45 * x - 1.02 * x * x)
}

#[derive(Clone, Copy, Default)]
pub struct Wheel {
    pub omega: f64,
    pub load: f64,
    pub slip_angle: f64,
    pub slip_ratio: f64,
    pub fy: f64,
    pub fx: f64,
    pub contact: bool,
}

/// The six inputs a driver produces, human or otherwise.
#[derive(Clone, Copy, Default)]
pub struct Input {
    pub steer: f64,
    pub throttle: f64,
    pub brake: f64,
    pub boost: bool,
    pub ebrake: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HitKind {
    None,
    Wall,
    Car,
}

impl Default for HitKind {
    fn default() -> Self {
        HitKind::None
    }
}

#[derive(Clone)]
pub struct Vehicle {
    // pose
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    pub road_y: f64,
    pub road_pitch: f64,
    pub lift: f64,

    // body-frame velocity
    pub v_long: f64,
    pub v_lat: f64,
    pub yaw_rate: f64,
    pub vx: f64,
    pub vz: f64,
    pub speed: f64,

    // steering
    pub steer: f64,
    pub steer_visual: f64,
    pub counter_steering: bool,

    // drift
    pub drifting: bool,
    pub drift_amount: f64,
    pub drift_hold: f64,
    pub drift_kick: f64,
    pub drift_angle: f64,
    pub drift_dir: f64,
    pub drift_throttle: f64,
    pub scrape: f64,
    pub body_slip: f64,
    pub slip_front: f64,
    pub slip_rear: f64,
    pub wheel_slip: f64,
    pub wheel_spin_fx: f64,
    /// Accumulated REAR axle angle, in radians. The renderer turns the rear
    /// wheels by this, so a wheel that is spinning up under power turns faster
    /// than the car is travelling and one that is locked stops dead.
    pub wheel_spin: f64,
    /// ...and the front axle, which is a different number whenever it matters:
    /// under braking the fronts lock while the rears still turn, and under
    /// power the rears light up while the fronts only roll. One accumulator
    /// for both axles renders both of those as the same wheel.
    pub wheel_spin_front: f64,

    // drivetrain
    pub boost: f64,
    pub boosting: bool,
    pub boost_locked: bool,
    pub gear: usize,
    pub rpm: f64,
    pub engine_rpm: f64,
    pub shift_timer: f64,
    pub shift_hold: f64,
    pub shift_flash: f64,
    pub engine_load: f64,
    pub reverse_arm: f64,
    pub engine_top: f64,
    pub speed_cap: f64,
    pub engine_power: f64,
    pub race_mode_multiplier: f64,
    pub power_scale: f64,

    // road relationship
    pub s_track: f64,
    pub max_s: f64,
    pub min_s: f64,
    pub lateral: f64,
    pub offroad: bool,
    pub wrong_way: f64,
    pub beached: f64,
    pub surface_grip: f64,
    pub grip_scale: f64,
    pub surface_drag: f64,
    /* HOW BENT THE BODY IS, 0 intact .. 1 wrecked.
     *
     * Written by the presentation layer (js/damage.js counts the dents) and
     * read by exactly two things below: the drag, and the boost.
     *
     * IT IS NOT A HEALTH BAR. Nothing here can stop the car, nothing here
     * scales grip or steering, and at zero it changes nothing at all - the
     * differential harness drives with it at its default and the trace is
     * unchanged. What a caved-in nose and a torn-off diffuser actually cost is
     * AERODYNAMICS, and aerodynamics is a term that only matters at speed:
     * a wrecked car pulls away from a corner exactly as well as a clean one
     * and simply cannot hold the same top end. That is the right shape for a
     * racing penalty, because it punishes the player where they were winning
     * rather than where they were already struggling. */
    pub damage: f64,

    // body on its springs
    pub heave: f64,
    pub heave_v: f64,
    pub pitch: f64,
    pub pitch_v: f64,
    pub roll: f64,
    pub roll_v: f64,
    pub body_y: f64,
    pub accel_long: f64,
    pub accel_lat: f64,

    pub w: [Wheel; 4],

    // contact bookkeeping
    pub crash_cooldown: f64,
    pub last_hit: bool,
    pub last_hit_kind: HitKind,
    pub braking: f64,
    pub impact: f64,
    pub impact_speed: f64,
    pub stun: f64,
    pub contact_timer: f64,

    /* ---- the air. See the long note above `Ramp` at the end of this file. --
       `air_y` is the height above the road the pose adds; `air_abs` is the
       WORLD height it is integrated at, which is the one that must not follow
       the road down a dip. */
    pub airborne: bool,
    pub air_y: f64,
    pub air_abs: f64,
    pub air_v: f64,
    pub air_time: f64,
    pub air_pitch: f64,
    pub air_pitch_v: f64,
    pub air_roll: f64,
    pub air_roll_v: f64,
    pub air_yaw_v: f64,
    /// 0..1, how straight the last landing was. See `update_air`.
    pub landing: f64,
    /// Set to 1 on the frame a landing happens, and cleared by whoever reads
    /// it - a director wants the EVENT, and a flag it has to clear is the only
    /// version of that which cannot be missed by a slow frame.
    pub landed: f64,
    pub ramp: Option<Ramp>,

    accum: f64,
}

impl Default for Vehicle {
    fn default() -> Self {
        Vehicle {
            x: 0.0, y: 0.0, z: 0.0, yaw: 0.0, road_y: 0.0, road_pitch: 0.0, lift: 0.0,
            v_long: 0.0, v_lat: 0.0, yaw_rate: 0.0, vx: 0.0, vz: 0.0, speed: 0.0,
            steer: 0.0, steer_visual: 0.0, counter_steering: false,
            drifting: false, drift_amount: 0.0, drift_hold: 0.0, drift_kick: 0.0,
            drift_angle: 0.0, drift_dir: 0.0, drift_throttle: 0.0, scrape: 0.0,
            body_slip: 0.0, slip_front: 0.0, slip_rear: 0.0, wheel_slip: 0.0,
            wheel_spin_fx: 0.0, wheel_spin: 0.0, wheel_spin_front: 0.0,
            boost: 1.0, boosting: false, boost_locked: false, gear: 1,
            rpm: 0.0, engine_rpm: IDLE_RPM, shift_timer: 0.0, shift_hold: 0.0,
            shift_flash: 0.0, engine_load: 0.0, reverse_arm: 0.0,
            engine_top: TOP_SPEED, speed_cap: f64::INFINITY, engine_power: 1.0,
            race_mode_multiplier: 1.0, power_scale: 1.0,
            s_track: 0.0, max_s: 0.0, min_s: 0.0, lateral: 0.0, offroad: false,
            wrong_way: 0.0, beached: 0.0, surface_grip: 1.0, grip_scale: 1.0, surface_drag: 0.0,
            damage: 0.0,
            heave: 0.0, heave_v: 0.0, pitch: 0.0, pitch_v: 0.0, roll: 0.0, roll_v: 0.0,
            body_y: 0.0, accel_long: 0.0, accel_lat: 0.0,
            w: [Wheel::default(); 4],
            crash_cooldown: 0.0, last_hit: false, last_hit_kind: HitKind::None,
            braking: 0.0, impact: 0.0, impact_speed: 0.0, stun: 0.0, contact_timer: 0.0,
            airborne: false, air_y: 0.0, air_abs: 0.0, air_v: 0.0, air_time: 0.0,
            air_pitch: 0.0, air_pitch_v: 0.0, air_roll: 0.0, air_roll_v: 0.0,
            air_yaw_v: 0.0, landing: 0.0, landed: 0.0, ramp: None,
            accum: 0.0,
        }
    }
}

impl Vehicle {
    pub fn new(track: &Track, lift: f64) -> Self {
        let mut v = Vehicle::with_lift(lift);
        v.reset(track, 0.0, 0.0);
        v
    }

    /// A car that has not been placed on a road yet. Used by the ABI, which
    /// creates the grid before the course has necessarily finished building.
    pub fn with_lift(lift: f64) -> Self {
        Vehicle { lift, ..Default::default() }
    }

    /// Put the car on the track at arc length `s`, `lateral` units off centre.
    ///
    /// Everything that remembers where the car has *been* is reset with it, or
    /// a rewind puts the car back at the checkpoint with the road behind it
    /// still walled off at wherever it got to.
    pub fn reset(&mut self, track: &Track, s: f64, lateral: f64) {
        let p = track.at(s);
        let rx = p.yaw.cos();
        let rz = -p.yaw.sin();
        self.x = p.x + rx * lateral;
        self.road_y = p.y;
        self.y = self.road_y + self.lift;
        self.z = p.z + rz * lateral;
        self.yaw = p.yaw;
        self.s_track = s;
        self.max_s = s;
        self.min_s = s - 2.0;
        self.lateral = lateral;

        let pa = track.at(s - 6.0);
        let pb = track.at(s + 6.0);
        self.road_pitch = -((pb.y - pa.y).atan2(12.0));

        self.v_long = 0.0;
        self.v_lat = 0.0;
        self.yaw_rate = 0.0;
        self.vx = 0.0;
        self.vz = 0.0;
        self.speed = 0.0;
        self.steer = 0.0;
        self.steer_visual = 0.0;
        self.counter_steering = false;
        self.drifting = false;
        self.drift_amount = 0.0;
        self.drift_hold = 0.0;
        self.drift_kick = 0.0;
        self.drift_angle = 0.0;
        self.drift_dir = 0.0;
        self.drift_throttle = 0.0;
        self.scrape = 0.0;
        self.body_slip = 0.0;
        self.slip_front = 0.0;
        self.slip_rear = 0.0;
        self.wheel_slip = 0.0;
        self.wheel_spin_fx = 0.0;
        self.wheel_spin = 0.0;
        self.wheel_spin_front = 0.0;
        self.boost = 1.0;
        self.boosting = false;
        self.boost_locked = false;
        self.gear = 1;
        self.rpm = 0.0;
        self.engine_rpm = IDLE_RPM;
        self.shift_timer = 0.0;
        self.shift_hold = 0.0;
        self.shift_flash = 0.0;
        self.engine_load = 0.0;
        self.reverse_arm = 0.0;
        self.offroad = false;
        self.wrong_way = 0.0;
        self.beached = 0.0;
        self.surface_grip = 1.0;
        self.grip_scale = 1.0;
        self.surface_drag = 0.0;
        self.damage = 0.0;
        self.heave = 0.0;
        self.heave_v = 0.0;
        self.pitch = 0.0;
        self.pitch_v = 0.0;
        self.roll = 0.0;
        self.roll_v = 0.0;
        /* ...and out of the air. A rewind while the car is over a ramp used to
           be impossible because there was no air to be in; now it is a state
           that would otherwise survive a checkpoint restore and drop the car
           out of the sky at the checkpoint. */
        self.airborne = false;
        self.air_y = 0.0;
        self.air_abs = self.y;
        self.air_v = 0.0;
        self.air_time = 0.0;
        self.air_pitch = 0.0;
        self.air_pitch_v = 0.0;
        self.air_roll = 0.0;
        self.air_roll_v = 0.0;
        self.air_yaw_v = 0.0;
        self.landing = 0.0;
        self.landed = 0.0;
        self.ramp = None;
        self.body_y = 0.0;
        self.accel_long = 0.0;
        self.accel_lat = 0.0;
        for i in 0..4 {
            let k = &WHEELS[i];
            self.w[i] = Wheel {
                omega: 0.0,
                load: MASS * G * (if k.front { FRONT_WEIGHT } else { 1.0 - FRONT_WEIGHT }) * 0.5,
                slip_angle: 0.0,
                slip_ratio: 0.0,
                fy: 0.0,
                fx: 0.0,
                contact: true,
            };
        }
        self.crash_cooldown = 0.0;
        self.last_hit = false;
        self.last_hit_kind = HitKind::None;
        self.braking = 0.0;
        self.impact = 0.0;
        self.impact_speed = 0.0;
        self.stun = 0.0;
        self.contact_timer = 0.0;
        self.race_mode_multiplier = 1.0;
        self.power_scale = 1.0;
        self.accum = 0.0;
    }

    /// The ceiling this car is allowed to reach right now, in world units/s.
    #[inline]
    pub fn ceiling(&self) -> f64 {
        self.speed_cap.min(
            self.engine_top
                * (if self.boosting { BOOST_TOP } else { 1.0 })
                * self.race_mode_multiplier.max(1.0),
        )
    }

    /// Rack angle available in this direction, including countersteering assistance.
    /// AI input conversion must use exactly the same lock as the physics.
    pub fn steering_lock(&self, direction: f64) -> f64 {
        let aided = MAX_STEER.min(WHEELBASE * TARGET_LAT / (self.v_long * self.v_long).max(1.0));
        let blend = if self.body_slip.abs() > 0.07 && direction * self.body_slip > 0.0 {
            ((self.body_slip.abs() - 0.07) / 0.12).min(1.0)
        } else { 0.0 };
        aided + (MAX_STEER - aided) * blend
    }

    /// Which engine is in the car.
    ///
    /// Three of them, because the car has three lives in the campaign: the
    /// street block it starts with, the wreck it is reduced to at the end of
    /// ASHFALL ZERO, and what Javas builds out of it at the Forge.
    pub const ENGINE_STOCK: u32 = 0;
    pub const ENGINE_SWAP: u32 = 1;
    pub const ENGINE_BROKEN: u32 = 2;

    /// Fit an engine. See the three ENGINE_ constants above.
    pub fn fit_engine(&mut self, kind: u32) {
        match kind {
            Self::ENGINE_SWAP => {
                self.engine_top = SWAP_TOP;
                self.speed_cap = SWAP_CAP;
                self.engine_power = SWAP_POWER;
            }
            Self::ENGINE_BROKEN => {
                self.engine_top = BROKEN_TOP;
                self.speed_cap = BROKEN_CAP;
                self.engine_power = BROKEN_POWER;
            }
            _ => {
                self.engine_top = TOP_SPEED;
                self.speed_cap = f64::INFINITY;
                self.engine_power = 1.0;
            }
        }
    }

    #[inline]
    pub fn speed_ms(&self) -> f64 {
        self.speed * UNIT_METRES
    }
    #[inline]
    pub fn speed_kmh(&self) -> f64 {
        self.speed_ms() * 3.6
    }
    #[inline]
    pub fn speed_mph(&self) -> f64 {
        self.speed_ms() * 2.23694
    }

    pub fn update(&mut self, track: &Track, dt: f64, input: Input, active: bool) {
        let throttle = if active { input.throttle } else { 0.0 };
        let brake_in = if active { input.brake } else { 0.0 };
        let steer_in = if active { input.steer } else { 0.0 };
        let ebrake = active && input.ebrake;

        // ---- boost -------------------------------------------------------
        // The reservoir latches when it is emptied and unlatches only when
        // there is a real charge in it again: `boost > 0.02` on its own is not
        // a gate, because the refill puts that much back a tenth of a second
        // later and a held key then boosts continuously off an empty bar.
        if self.boost <= 0.015 {
            self.boost_locked = true;
        } else if self.boost >= BOOST_ARM {
            self.boost_locked = false;
        }
        let want_boost =
            active && input.boost && !self.boost_locked && self.boost > 0.015 && self.speed > 2.0;
        self.boosting = want_boost;
        if want_boost {
            self.boost = (self.boost - BOOST_BURN * dt).max(0.0);
        } else {
            self.boost = (self.boost + BOOST_FILL * dt).min(1.0);
        }

        // Reverse has to be asked for; holding the brake through a corner must
        // not flip into reverse the instant the car stops.
        if brake_in > 0.01 && self.v_long.abs() < 0.6 {
            self.reverse_arm += dt;
        } else if brake_in <= 0.01 {
            self.reverse_arm = 0.0;
        }

        // ---- steering ----------------------------------------------------
        // The speed-sensitive limit is a driver aid for turn-in. Applying it
        // to opposite lock as well is what made a slide unrecoverable, so when
        // the input opposes the way the car is already travelling - the
        // definition of catching a slide - it gets the full mechanical lock.
        let catching = self.body_slip.abs() > 0.07 && steer_in * self.body_slip > 0.0;
        let blend = if catching {
            (1.0f64).min((self.body_slip.abs() - 0.07) / 0.12)
        } else {
            0.0
        };
        let lock = self.steering_lock(steer_in);
        self.counter_steering = blend > 0.02;
        let want_steer = steer_in * lock;
        let rate = if steer_in.abs() < 0.02 { STEER_RETURN } else { STEER_RATE };
        let max_delta = rate * dt;
        self.steer += clamp(want_steer - self.steer, -max_delta, max_delta);
        self.steer_visual = damp(self.steer_visual, steer_in, 9.0, dt);
        self.engine_load = damp(
            self.engine_load,
            throttle * (if self.boosting { 1.4 } else { 1.0 }),
            6.0,
            dt,
        );
        self.shift_flash = (self.shift_flash - dt * 3.0).max(0.0);

        // ---- where we are on the road ------------------------------------
        let proj = track.project(self.x, self.z, self.s_track);
        self.s_track = proj.s_exact;
        self.lateral = proj.lateral;
        // The road behind is a wall. The start line already is one; `max_s` is
        // the furthest the player has got, and they may give up `BACKTRACK` of
        // it - enough to reverse out of a barrier and get pointed the right
        // way - and no more.
        if self.s_track > self.max_s {
            self.max_s = self.s_track;
        }
        let floor_s = self.min_s.max(self.max_s - BACKTRACK);
        if active && self.s_track < floor_s {
            let back = floor_s - self.s_track;
            self.x += proj.yaw.sin() * back;
            self.z += proj.yaw.cos() * back;
            self.s_track = floor_s;
            self.lateral = proj.lateral;
            if self.v_long < 0.0 {
                self.v_long *= 0.2;
            }
        }
        // Ninety degrees is sideways and happens in every slide; past a
        // hundred and twenty the car is genuinely facing the wrong way.
        let head = crate::math::ang_diff(self.yaw, proj.yaw).abs();
        if active && head > 2.09 && self.speed > 4.0 {
            self.wrong_way += dt;
        } else {
            self.wrong_way = (self.wrong_way - dt * 2.5).max(0.0);
        }
        // A hand's width of tolerance, so brushing the wall is a scrape rather
        // than an OFF ROAD card and a grip penalty.
        self.offroad = proj.lateral.abs() > track.half_width + 0.35;
        if self.offroad && self.speed < 3.0 && active {
            self.beached += dt;
        } else {
            self.beached = (self.beached - dt * 3.0).max(0.0);
        }
        if self.beached > 1.1 {
            let back = -sign(if proj.lateral == 0.0 { 1.0 } else { proj.lateral });
            let rx = proj.yaw.cos();
            let rz = -proj.yaw.sin();
            self.x += rx * back * 3.4 * dt;
            self.z += rz * back * 3.4 * dt;
        }

        // ---- the drift, asked for once a frame ---------------------------
        // SPACE engages the slide controller, fully; how far the wheel is
        // turned into the corner sets how deep a slide is asked for.
        // Conflating engagement with depth is what made a half-turn produce no
        // slide at all - it scaled the angle *and* the authority to hold it.
        let fast = self.speed > DRIFT_MIN_SPEED;
        let steer_mag = (1.0f64).min(steer_in.abs());
        let asked: f64 = if ebrake && fast && steer_mag > 0.10 { 1.0 } else { 0.0 };
        // natural oversteer: already sideways, on the power, and not from a hit
        let natural = if fast
            && !ebrake
            && throttle > 0.45
            && self.contact_timer <= 0.0
            && self.body_slip.abs() > 0.22
            && steer_mag > 0.25
        {
            0.72
        } else {
            0.0
        };
        let want = asked.max(natural);
        let d_rate = if want > self.drift_hold { DRIFT_RATE_UP } else { DRIFT_RATE_DOWN };
        let was_held = self.drift_hold;
        self.drift_hold += (want - self.drift_hold) * (1.0f64).min(d_rate * dt);
        if self.drift_hold < 0.02 {
            self.drift_hold = 0.0;
        }
        // the rear has to let go once, at the start, and then be given back
        if was_held < 0.08 && self.drift_hold >= 0.08 && asked > 0.0 {
            self.drift_kick = DRIFT_KICK_TIME;
        }
        self.drift_kick = (self.drift_kick - dt).max(0.0);
        // Negative slip is a right-hand slide. Steering left asks for the
        // mirror of it, which is what lets a slide be flicked the other way
        // without ever finding opposite lock.
        self.drift_angle = -sign(steer_in) * DRIFT_ANGLE * steer_mag * self.drift_hold;
        self.drift_dir = if self.drift_hold > 0.05 { -sign(self.drift_angle) } else { 0.0 };
        self.drift_throttle = throttle;

        // ---- fixed-rate solve --------------------------------------------
        self.accum += dt;
        let mut steps = (self.accum / FIXED_DT).floor() as usize;
        if steps > MAX_STEPS {
            // the tab was hidden or the frame stalled: drop the time rather
            // than spiral trying to catch up with it
            steps = MAX_STEPS;
            self.accum = 0.0;
        } else {
            self.accum -= steps as f64 * FIXED_DT;
        }
        let h = FIXED_DT;
        for _ in 0..steps {
            self.step(h, throttle, brake_in);
            let sf = self.yaw.sin();
            let cf = self.yaw.cos();
            self.x += (sf * self.v_long + cf * self.v_lat) * h;
            self.z += (cf * self.v_long - sf * self.v_lat) * h;
        }

        let fx = self.yaw.sin();
        let fz = self.yaw.cos();
        self.vx = fx * self.v_long + fz * self.v_lat;
        self.vz = fz * self.v_long - fx * self.v_lat;
        self.speed = self.vx.hypot(self.vz);
        /* The two axles, kept apart, and kept small.

           A tour is a hundred and twenty-seven kilometres, and at eighty units
           a second a 0.45-unit wheel turns about 178 radians every second - so
           an accumulator that is never wrapped reaches seven figures inside
           half an hour, and a float that large has no precision left in the
           fractional part the renderer actually uses. Wrapped to a turn, it
           stays exact for as long as the run lasts. */
        let tau = core::f64::consts::TAU;
        self.wheel_spin = (self.wheel_spin + (self.w[2].omega + self.w[3].omega) * 0.5 * dt) % tau;
        self.wheel_spin_front =
            (self.wheel_spin_front + (self.w[0].omega + self.w[1].omega) * 0.5 * dt) % tau;

        // ---- what the rest of the game reads -----------------------------
        self.slip_front = (self.w[0].slip_angle + self.w[1].slip_angle) * 0.5;
        self.slip_rear = (self.w[2].slip_angle + self.w[3].slip_angle) * 0.5;
        self.wheel_slip = clamp(
            (self.w[2].slip_ratio.abs() + self.w[3].slip_ratio.abs()) * 0.5 - 0.06,
            0.0,
            1.0,
        );
        // Wheelspin, and only wheelspin: a driven wheel turning faster than
        // the road is smoke off the line, one turning slower is being braked,
        // and a magnitude cannot tell those apart. This reads the sign.
        self.wheel_spin_fx = clamp(
            (self.w[2].slip_ratio.max(0.0) + self.w[3].slip_ratio.max(0.0)) * 0.5 - 0.08,
            0.0,
            1.0,
        );
        // A drift is the car travelling sideways - the body slip angle.
        // Reading it off the rear tyres flags a straight-line stop as a drift.
        self.body_slip = self.v_lat.atan2((1.0f64).max(self.v_long.abs()));
        let beta = self.body_slip.abs();
        // Being shoved sideways is not a drift: a barrier scrape or a bump
        // spikes the body slip for a moment, and without this the HUD calls it
        // a drift and the scoring pays out for having been hit.
        self.contact_timer = (self.contact_timer - dt).max(0.0);
        let clean = self.speed > 8.0 && self.contact_timer <= 0.0;
        self.drifting = clean && beta > 0.18;
        let carrying = clamp((beta - 0.10) / 0.30, 0.0, 1.0);
        self.drift_amount = damp(
            self.drift_amount,
            carrying.max(self.drift_hold * 0.35 * if beta > 0.12 { 1.0 } else { 0.0 })
                * if clean { 1.0 } else { 0.0 },
            9.0,
            dt,
        );
        self.scrape = (self.scrape - dt * 2.0).max(0.0);

        self.collide(track, &proj, dt);
        self.gearbox(dt, throttle);

        // Brake lamps come on when the pedal is doing something. The engine
        // braking of a lifted throttle does not count.
        let want_brake = if brake_in > 0.02 && self.v_long > 0.4 { brake_in } else { 0.0 };
        self.braking = damp(
            self.braking,
            want_brake.max(if ebrake { 1.0 } else { 0.0 }),
            22.0,
            dt,
        );
        self.impact = (self.impact - dt * 2.6).max(0.0);
        self.stun = (self.stun - dt).max(0.0);

        // the renderer reads the sprung body, not the chassis
        self.body_y = clamp(self.heave, -0.18, 0.18);
        let road_pose = track.at(self.s_track);
        let road_back = track.at(self.s_track - 6.0);
        let road_ahead = track.at(self.s_track + 6.0);
        self.road_y = road_pose.y;
        self.road_pitch = -((road_ahead.y - road_back.y).atan2(12.0));
        /* The ramp and the flight, AFTER road_y is known and before the pose
           is assembled: `air_y` is measured from the road surface, so it has
           to be computed against this frame's elevation rather than last
           frame's. */
        self.update_air(track, dt, steer_in);
        self.y = self.road_y + self.lift + self.body_y + self.air_y;
    }

    /// Pick a gear from road speed.
    ///
    /// The schedule deliberately does *not* read the driven wheels: a spinning
    /// wheel turns at whatever the engine will turn it, so pinned against a
    /// barrier with the throttle down the old box saw redline, upshifted, saw
    /// it again, and rowed itself into seventh at a standstill. The tacho still
    /// reads the real wheels, because a burnout should scream.
    fn gearbox(&mut self, dt: f64, throttle: f64) {
        let wheel_omega = (self.w[2].omega + self.w[3].omega) * 0.5;
        let refr = self.v_long.abs() / WHEEL_RADIUS;
        let at = |g: usize| refr * RATIOS[g - 1] * RPM_PER_RAD;

        if self.shift_timer > 0.0 {
            self.shift_timer -= dt;
        }
        self.shift_hold = (self.shift_hold - dt).max(0.0);

        // A cutscene can put a car on the road at ninety units a second in
        // first. A box that is more than one gear out is simply in the wrong
        // gear, so it takes the right one rather than rowing up through six.
        let mut ideal = GEARS;
        for gi in 1..=GEARS {
            if at(gi) <= SHIFT_UP {
                ideal = gi;
                break;
            }
        }
        if (ideal as i64 - self.gear as i64).abs() >= 2 {
            self.gear = ideal;
            self.shift_timer = SHIFT_TIME * 0.5;
            self.shift_hold = SHIFT_HOLD;
        } else if self.shift_timer <= 0.0 && self.shift_hold <= 0.0 {
            if self.gear < GEARS
                && at(self.gear) > SHIFT_UP
                && at(self.gear + 1) > SHIFT_DOWN + SHIFT_MARGIN
            {
                // up, and only if the revs land above the downshift point in
                // the gear being taken - otherwise it shifts straight back
                self.gear += 1;
                self.shift_timer = SHIFT_TIME;
                self.shift_flash = 1.0;
                self.shift_hold = SHIFT_HOLD;
            } else if self.gear > 1
                && at(self.gear) < SHIFT_DOWN
                && at(self.gear - 1) < SHIFT_UP - SHIFT_MARGIN
            {
                self.gear -= 1;
                self.shift_timer = SHIFT_TIME * 0.6;
                self.shift_flash = 0.55;
                self.shift_hold = SHIFT_HOLD;
            } else if throttle > 0.85
                && self.gear > 1
                && at(self.gear) < SHIFT_UP * 0.60
                && at(self.gear - 1) < REDLINE * 0.94
            {
                // kickdown: throttle buried, engine nowhere near the torque
                self.gear -= 1;
                self.shift_timer = SHIFT_TIME * 0.7;
                self.shift_flash = 0.8;
                self.shift_hold = SHIFT_HOLD;
            }
        }

        let mut rpm = wheel_omega.abs() * RATIOS[self.gear - 1] * RPM_PER_RAD;
        // off the line the clutch is slipping, so the engine is not tied to
        // the wheels yet and sits up near where the torque is
        let launch = clamp(1.0 - self.v_long.abs() / 6.0, 0.0, 1.0);
        rpm = rpm.max(IDLE_RPM + launch * throttle * 4200.0);
        self.engine_rpm = clamp(rpm, IDLE_RPM, REDLINE);
        self.rpm = clamp((self.engine_rpm - IDLE_RPM) / (REDLINE - IDLE_RPM), 0.0, 1.0);
    }

    /// One fixed sub-step: suspension, tyres, body, wheels.
    fn step(&mut self, h: f64, throttle: f64, brake_in: f64) {
        let m = MASS;
        let (u, v, r) = (self.v_long, self.v_lat, self.yaw_rate);
        let abs_u = u.abs();
        let rr = WHEEL_RADIUS;

        // ---- suspension ---------------------------------------------------
        // Each corner's spring is compressed by however far the body has moved
        // down over it, and the force that comes back IS the tyre's vertical
        // load - so load transfer is an outcome of the body moving rather than
        // a formula applied on top of it.
        let aero = DOWNFORCE * u * u;
        let mut sum_f = 0.0;
        let mut pitch_m = 0.0;
        let mut roll_m = 0.0;
        let mut comp = [0.0f64; 4];
        for i in 0..4 {
            let k = &WHEELS[i];
            let k_s = if k.front { SPRING_F } else { SPRING_R };
            let static_load = m * G * (if k.front { FRONT_WEIGHT } else { 1.0 - FRONT_WEIGHT }) * 0.5;
            let s0 = static_load / k_s;
            let zi = self.heave + k.l * self.pitch + k.w * self.roll;
            let vi = self.heave_v + k.l * self.pitch_v + k.w * self.roll_v;
            let x = clamp(s0 - zi, 0.0, TRAVEL * 2.0);
            comp[i] = x;
            let rate_up = -vi;
            let c_d = if rate_up > 0.0 {
                if k.front { DAMP_BUMP_F } else { DAMP_BUMP_R }
            } else if k.front {
                DAMP_REB_F
            } else {
                DAMP_REB_R
            };
            // ...and the rubber, once this corner has used up its travel
            let into_stop = x - (s0 + BUMP_GAP);
            let stop = if into_stop > 0.0 { BUMP_STOP * into_stop * into_stop } else { 0.0 };
            /* WHAT THIS CORNER ACTUALLY CARRIES.
             *
             * A strut pushes the body up. It has never been able to pull it
             * down, and it cannot push at all once it has run out of travel -
             * at which point the wheel is hanging and the corner is carrying
             * nothing. Neither of those was true here, and both showed:
             *
             * `x` is clamped at zero, so the spring term vanishes when a
             * corner unloads - but `c_d * rate_up` was still added at the full
             * damper rate, and in rebound that term is NEGATIVE. So an
             * unloaded corner produced a negative force, and that force went
             * into `sum_f` and `roll_m` and pulled the body down and over,
             * while `self.w[i].load` was floored at zero so the tyre never
             * felt any of it. The body and the contact patch were being told
             * two different things about the same corner.
             *
             * Measured, at a hard steering reversal in a drift: the inside
             * corners unloaded, their dampers hauled the body down through its
             * whole travel in a tenth of a second, and roll went from two
             * degrees to the nine-degree stop in three frames and rang there.
             * That is the rollover and the floating in the report.
             *
             * One number for the body and the tyre, and it only ever pushes.
             * In a steady corner every wheel carries positive load, so this is
             * identical to what it replaces - it bites only where a corner has
             * gone light, which is the only place it was ever wrong.
             *
             * NOT gated on `x > 0` as well: at full droop the wheel is hanging
             * on its own stop and that stop still holds the body up. Gating it
             * let the body free-fall through its travel while the car was
             * airborne, so it arrived at touchdown with nothing left to
             * compress - which the landing test catches. */
            let carried = (k_s * x + stop + c_d * rate_up).max(0.0);
            // aero pushes the whole car down and is not carried by the
            // springs' static travel, so it goes straight to the contact load
            let load =
                carried + aero * (if k.front { AERO_FRONT } else { 1.0 - AERO_FRONT }) * 0.5;
            self.w[i].load = load.max(0.0);
            self.w[i].contact = self.w[i].load > 1.0;
            sum_f += carried;
            pitch_m += k.l * carried;
            roll_m += k.w * carried;
        }
        /* THE TRANSFER THE LINKS CARRY, which arrives in the same instant the
           force that causes it does - see RC_FRONT. Both terms read the
           PREVIOUS sub-step's accelerations, four milliseconds old at 240 Hz,
           because this sub-step's are not known until its tyre forces are, and
           its tyre forces need these loads. Four milliseconds of lag on a
           fifth of a second of body motion is not a lag anybody can feel.

           Positive lateral acceleration is to the right of the car, and load
           moves to the OUTSIDE of the turn - the wheels at negative track
           offset. Positive longitudinal acceleration moves it rearward. */
        let geo_f = m * self.accel_lat * FRONT_WEIGHT * RC_FRONT / TRACK_WIDTH;
        let geo_r = m * self.accel_lat * (1.0 - FRONT_WEIGHT) * RC_REAR / TRACK_WIDTH;
        let geo_l = m * self.accel_long * CG_HEIGHT / WHEELBASE;
        for i in 0..4 {
            let k = &WHEELS[i];
            let lat = if k.front { geo_f } else { geo_r };
            let lon = if k.front { -geo_l * ANTI_DIVE } else { geo_l * ANTI_SQUAT };
            let side = if k.w < 0.0 { 1.0 } else { -1.0 };
            self.w[i].load = (self.w[i].load + side * lat + lon * 0.5).max(0.0);
            self.w[i].contact = self.w[i].load > 1.0;
        }

        // Anti-roll bars: a torsion bar pushes back on whichever side is
        // compressed further, so the compressed side gains load. Adding it to
        // the lighter side inverts the whole distribution and the car leans
        // out of the bend.
        let arb_f = ARB_F * (comp[0] - comp[1]);
        let arb_r = ARB_R * (comp[2] - comp[3]);
        self.w[0].load = (self.w[0].load + arb_f).max(0.0);
        self.w[1].load = (self.w[1].load - arb_f).max(0.0);
        self.w[2].load = (self.w[2].load + arb_r).max(0.0);
        self.w[3].load = (self.w[3].load - arb_r).max(0.0);
        /* NOTHING IS CARRYING THE CAR. This is the whole of "no grip in the
           air": every tyre force below is `mu * load * f(slip)`, so a wheel
           with no load makes no lateral force, no longitudinal force and no
           yaw moment, and the car simply keeps the velocity it left with. One
           line, in the one place where it cannot be got round, rather than an
           airborne branch through the rest of the solver. */
        if self.airborne {
            for i in 0..4 {
                self.w[i].load = 0.0;
                self.w[i].contact = false;
            }
        }
        roll_m += (-HW) * arb_f + HW * (-arb_f) + (-HW) * arb_r + HW * (-arb_r);
        // ...and the damping the mode itself wants. See ROLL_DAMP.
        roll_m -= ROLL_DAMP * self.roll_v;

        // ---- tyres --------------------------------------------------------
        // Slip angle and slip ratio per wheel, both passed through a relaxation
        // length so a force builds over the distance the tyre rolls. The floor
        // keeps a launch responsive: dividing a lag distance by road speed at a
        // standing start gives a half-second time constant, and the tyre cannot
        // build a force before the car has already gone.
        let relax_lat = abs_u.max(4.0) / RELAX_LAT;
        let relax_long = abs_u.max(4.0) / RELAX_LONG;
        let stun = if self.stun > 0.0 { 1.0 - 0.3 * (self.stun / WALL_STUN) } else { 1.0 };

        // Ackermann: the inner wheel turns more tightly than the outer one
        let steer_l = self.steer * if self.steer > 0.0 { 1.0 } else { 1.0 + ACKERMANN * self.steer.abs() };
        let steer_r = self.steer * if self.steer < 0.0 { 1.0 } else { 1.0 + ACKERMANN * self.steer.abs() };

        let mut total_load = 0.0;
        for i in 0..4 {
            total_load += self.w[i].load;
        }
        total_load = total_load.max(1.0);

        let mut fx_total = 0.0;
        let mut fy_total = 0.0;
        let mut yaw_m = 0.0;

        // Engine speed is read here, not once a frame: evaluating it in the
        // frame loop left it eight sub-steps stale at 30 fps, which is a
        // torque difference, and is why the model used to reach two different
        // speeds depending on the refresh rate.
        let ratio = RATIOS[self.gear - 1];
        let wheel_omega = (self.w[2].omega + self.w[3].omega) * 0.5;
        let launch = clamp(1.0 - abs_u / 6.0, 0.0, 1.0);
        let rpm_now = clamp(
            (wheel_omega.abs() * ratio * RPM_PER_RAD).max(IDLE_RPM + launch * throttle * 4200.0),
            IDLE_RPM,
            REDLINE,
        );
        let top_now = self.ceiling();
        let mut drive_torque = 0.0;
        if throttle > 0.01 && u < top_now && self.shift_timer <= 0.0 {
            drive_torque = engine_torque(rpm_now)
                * ratio
                * DRIVE_EFF
                * throttle
                * self.engine_power
                * self.power_scale.max(1.0);
        }
        let mut reverse = 0.0;
        if brake_in > 0.01 && self.reverse_arm >= REVERSE_ARM && u < 0.5 {
            reverse = -REVERSE_TORQUE * brake_in;
        }
        let eng_brake = if throttle < 0.01 && abs_u > 0.5 {
            ENGINE_BRAKE * (self.engine_rpm / 1000.0) * RATIOS[self.gear - 1]
        } else {
            0.0
        };

        /* The differential, read before the wheels are stepped so both of them
           see the same locking torque. It is a TRANSFER: whatever is taken off
           the faster wheel is given to the slower one, so the axle total is
           exactly what the engine sent it and no torque is invented. See
           DIFF_PRELOAD. */
        let axle_t = (drive_torque + reverse).abs() + eng_brake;
        let lock = (DIFF_PRELOAD + DIFF_RAMP * axle_t).min(DIFF_MAX);
        let lsd = -lock * ((self.w[2].omega - self.w[3].omega) / DIFF_SLIP).tanh();

        for i in 0..4 {
            let k = &WHEELS[i];
            // velocity of this contact patch, in body axes
            let vxw = u - r * k.w;
            let vyw = v + r * k.l;
            let delta = if k.front {
                if k.w < 0.0 { steer_l } else { steer_r }
            } else {
                0.0
            };

            let ss_angle = vyw.atan2(vxw.abs().max(2.2))
                - delta * sign(if vxw == 0.0 { 1.0 } else { vxw });
            self.w[i].slip_angle += (ss_angle - self.w[i].slip_angle) * (1.0f64).min(relax_lat * h);

            let vroll = vxw * delta.cos() + vyw * delta.sin();
            let ss_ratio = (self.w[i].omega * rr - vroll) / vroll.abs().max(2.0);
            self.w[i].slip_ratio += (ss_ratio - self.w[i].slip_ratio) * (1.0f64).min(relax_long * h);

            // grip at this wheel's own load
            let static_load = m * G * (if k.front { FRONT_WEIGHT } else { 1.0 - FRONT_WEIGHT }) * 0.5;
            let mut mu = (if k.front { GRIP_FRONT } else { GRIP_REAR }) * stun;
            mu *= clamp(self.surface_grip, 0.18, 1.08);
            mu *= clamp(self.grip_scale, 1.0, 2.2);
            mu *= 1.0 - LOAD_SENS * (self.w[i].load / static_load.max(1.0) - 1.0);
            if self.offroad {
                mu = mu.min(OFFROAD_GRIP);
            }
            // The rear lets go hard for the third of a second it takes to
            // start the slide, then gets most of its grip back. Holding it at
            // half grip for the whole drift is what turned the handbrake into
            // a brake: the car went sideways and simply stopped.
            if !k.front && self.drift_hold > 0.02 {
                mu *= if self.drift_kick > 0.0 { DRIFT_KICK_GRIP } else { DRIFT_REAR_GRIP };
            }
            mu = mu.max(0.15);

            let mut fy = -mu * self.w[i].load * magic(self.w[i].slip_angle, LAT_STIFF, LAT_SHAPE);
            let mut fx = mu * self.w[i].load * magic(self.w[i].slip_ratio, LONG_STIFF, LONG_SHAPE);

            // Friction ellipse: one budget, both directions spend from it.
            // This is what makes power-on oversteer and braking-induced
            // understeer fall out of the model rather than be special-cased.
            let cap = mu * self.w[i].load;
            let mag = fx.hypot(fy);
            if mag > cap && mag > 1.0 {
                let s = cap / mag;
                fx *= s;
                fy *= s;
            }
            self.w[i].fx = fx;
            self.w[i].fy = fy;

            let roll = -sign(vroll) * ROLL_RESIST * self.w[i].load;

            let cd = delta.cos();
            let sd = delta.sin();
            let bx = (fx + roll) * cd - fy * sd;
            let by = (fx + roll) * sd + fy * cd;
            fx_total += bx;
            fy_total += by;
            yaw_m += k.l * by - k.w * bx;

            // ---- wheel spin ------------------------------------------------
            let mut tq = 0.0;
            if !k.front {
                tq += (drive_torque + reverse) * 0.5 - eng_brake * 0.5;
                // negative track offset is the left wheel, which the sign is for
                tq += if k.w < 0.0 { lsd } else { -lsd };
            }
            // Brake proportioning follows the load this wheel is actually
            // carrying. Under heavy braking the rear goes light, and a fixed
            // split then asks it for more than it can hold: the rear locks
            // first, loses its lateral grip, and the car spins.
            let mut brake_t = 0.0;
            if brake_in > 0.01 && u > 0.5 {
                brake_t = 2.0 * BRAKE_TORQUE * brake_in * (self.w[i].load / total_load);
                let over = (-self.w[i].slip_ratio - ABS_SLIP) / 0.12;
                brake_t *= 1.0 - 0.9 * clamp(over, 0.0, 1.0);
            }
            if !k.front && self.drift_kick > 0.0 {
                brake_t = brake_t.max(DRIFT_KICK_BRAKE);
            }
            // Semi-implicit, because the tyre is stiff. An explicit step lets
            // the road torque overshoot the rolling condition and the wheel
            // rings about it - which averages to *less* drive force than the
            // true equilibrium, so the car ends up slower the harder the tyre
            // grips. Linearising the tyre about the current slip removes it.
            let ks = LONG_STIFF * self.w[i].slip_ratio;
            let d_f_d_slip =
                cap * LONG_SHAPE * LONG_STIFF * (LONG_SHAPE * ks.atan()).cos() / (1.0 + ks * ks);
            let d_f_d_omega = d_f_d_slip.max(0.0) * rr / vroll.abs().max(2.0);
            // The brake is part of the same balance, not a separate
            // subtraction from wheel speed: decrementing omega directly makes
            // the brake infinitely strong, the slip ratio pins at -1, and the
            // stopping distance stops depending on the brakes at all.
            let spin = if self.w[i].omega.abs() > 0.2 { sign(self.w[i].omega) } else { sign(vroll) };
            let net = tq - fx * rr - brake_t * spin;
            let mut omega = self.w[i].omega + h * net / (WHEEL_INERTIA + h * rr * d_f_d_omega);
            // a brake can stop a wheel but never drive it backwards
            if brake_t > 0.0 && self.w[i].omega * omega < 0.0 && tq.abs() < brake_t {
                omega = 0.0;
            }
            self.w[i].omega = clamp(omega, -400.0, 400.0);
        }

        // ---- resistance ---------------------------------------------------
        /* Body damage is drag, and drag is quadratic in speed - which is what
           makes it the honest penalty. A wrecked car loses nothing at all
           getting out of a hairpin and loses about eight per cent of its
           terminal speed on the straight, because terminal speed goes as the
           square root of thrust over drag: DAMAGE_DRAG of 0.42 at full damage
           is sqrt(1/1.42) of it, sixteen per cent off the top end. The HUD
           prints that same figure back at the player - see js/hud.js. */
        let mut resist = DRAG * (1.0 + DAMAGE_DRAG * clamp(self.damage, 0.0, 1.0)) * u * abs_u;
        // Tapered to nothing at a standstill: a flat 5,200 N is three and a
        // half m/s^2 applied to a car that is not moving, which no amount of
        // throttle gets out of. The verge has to cost speed, not forbid motion.
        if self.offroad {
            resist += sign(u) * OFFROAD_DRAG * clamp(u.abs() / OFFROAD_DRAG_SPEED, 0.0, 1.0);
        }
        if self.surface_drag > 0.0 {
            resist += sign(u) * OFFROAD_DRAG * clamp(self.surface_drag, 0.0, 2.0);
        }
        fx_total -= resist;
        if self.boosting && u < top_now {
            /* ...and the reheat has less to push against. Half the loss of the
               drag term, because the thing that is broken is the body rather
               than the drive - a bent car still has all of its engine. */
            fx_total += BOOST_THRUST * (1.0 - DAMAGE_BOOST * clamp(self.damage, 0.0, 1.0));
        }

        // ---- the slide controller -----------------------------------------
        // beta is where the car is going against where it is pointing, and
        //     beta_dot = (u*Fy - v*Fx) / (m * V^2) - r
        // so the yaw rate that HOLDS a slide is the rate the lateral tyre
        // force is already curving the path at. Servo r onto that plus a
        // proportional term on the angle error and the car sits at whatever
        // slide it is asked for. In the steady state the correction is zero -
        // the tyres carry the angle themselves - which is the difference
        // between this and yaw-rate-on-rails.
        let beta = v.atan2((1.0f64).max(abs_u));
        let want_yaw = u * self.steer.tan() / WHEELBASE;
        let drift = self.drift_hold;
        let beta_limit = SPIN_LIMIT
            + (self.drift_angle.abs() - SPIN_LIMIT).max(0.0)
            + SPIN_MARGIN * drift;
        // The exact derivative, not the small-angle v/u form: past thirty
        // degrees that is wrong by enough to hand the servo the wrong target,
        // and a servo with the wrong target drives the car round.
        let vsq = (u * u + v * v).max(36.0);
        let r_neutral = (u * fy_total - v * fx_total) / (m * vsq);

        if drift > 0.02 && u > DRIFT_MIN_SPEED {
            // Deeper slide means MORE rotation, and beta is negative in a
            // right-hand slide, so the error term is added rather than
            // subtracted. Backwards, the servo points at the mirror of the
            // angle asked for and the car swaps ends.
            let r_des = r_neutral + (beta - self.drift_angle) * DRIFT_BETA_P;
            yaw_m += (r_des - r) * DRIFT_AUTHORITY * YAW_I * drift;
            yaw_m -= (r - want_yaw) * YAW_DAMP * YAW_I * (1.0 - drift);
            // Sideways is slow - every tyre is scrubbing. On the throttle some
            // of that is handed back, which is what makes a drift a line
            // through the corner instead of a penalty for taking one.
            let push = DRIFT_PUSH * drift * (1.0f64).min(beta.abs() / DRIFT_ANGLE) * self.drift_throttle;
            fx_total += push * if u >= 0.0 { 1.0 } else { -1.0 };
        } else {
            yaw_m -= (r - want_yaw) * YAW_DAMP * YAW_I;
        }

        // The spin guard, always on. Past the limit the correction stops
        // holding the angle and starts removing it, so the car can be thrown a
        // long way sideways and still comes back pointing forwards. Nothing
        // caps the yaw rate directly: a cap is what made a spin wind up to it
        // and stay there.
        let over = beta.abs() - beta_limit;
        if over > 0.0 && abs_u > 2.0 {
            let pull = (1.0f64).min(over / 0.35);
            let r_back = r_neutral + sign(beta) * SPIN_RECOVER * pull;
            yaw_m += (r_back - r) * SPIN_AUTHORITY * YAW_I * pull;
        }

        let du = fx_total / m + r * v;
        let dv = fy_total / m - r * u;
        let dr = yaw_m / YAW_I;
        self.v_long = u + du * h;
        self.v_lat = v + dv * h;
        self.yaw_rate = clamp(r + dr * h, -3.0, 3.0);
        self.accel_long = du;
        self.accel_lat = dv + r * u;

        if self.v_long.abs() < 0.05 && throttle < 0.01 && brake_in < 0.01 {
            self.v_long = 0.0;
            self.v_lat *= 0.5;
            for w in self.w.iter_mut() {
                w.omega *= 0.5;
            }
        }
        self.v_long = clamp(self.v_long, -18.0, self.ceiling());
        self.yaw += self.yaw_rate * h;

        // ---- body: heave, pitch and roll ----------------------------------
        /* Only the moment the SPRINGS are left with. Everything the links took
           above has already reached the tyre; asking the body for it as well
           would count the same load transfer twice - once instantly at the
           contact patch and once again, a fifth of a second later, as roll. */
        let d_heave = (sum_f - m * G) / m;
        let d_pitch =
            (pitch_m + m * self.accel_long * CG_HEIGHT * (1.0 - ANTI_MEAN)) / PITCH_I;
        let d_roll = (roll_m + m * self.accel_lat * (CG_HEIGHT - RC_MEAN)) / ROLL_I;
        self.heave_v = (self.heave_v + d_heave * h) * 0.999;
        self.pitch_v = (self.pitch_v + d_pitch * h) * 0.999;
        self.roll_v = (self.roll_v + d_roll * h) * 0.999;
        /* THE TRAVEL LIMITS ARE A BACKSTOP, NOT THE SUSPENSION.
           Arresting the body's velocity when it touches one was tried and
           reverted: a landing is caught by the bump rubber taking the body's
           momentum out over the last of its travel, and zeroing the velocity
           at the limit takes that momentum away from the rubber and leaves the
           body resting on the clamp instead - which is the thing
           `a_landing_is_caught_by_the_bump_stops` exists to catch. The clamp
           stays what it was: a last line that should never be reached. */
        self.heave = clamp(self.heave + self.heave_v * h, -TRAVEL, TRAVEL);
        self.pitch = clamp(self.pitch + self.pitch_v * h, -0.10, 0.10);
        self.roll = clamp(self.roll + self.roll_v * h, -ROLL_MAX, ROLL_MAX);
    }

    /// The barrier, resolved as an impulse at the corner that touched it.
    ///
    /// Damping the sideways velocity and scaling the forward one reads as the
    /// car being quietly deleted into the wall. A real contact has a point of
    /// application, and because that point is off the centre of mass the same
    /// equation that stops a square hit spins a glancing one.
    fn collide(&mut self, track: &Track, proj: &Projection, dt: f64) {
        // How far the car reaches across the road depends on which way it is
        // pointing: half its width square to the road, half its length
        // broadside. Testing the centre against a fixed half-width lets a
        // yawed car put a corner straight through the barrier.
        let skew = crate::math::ang_diff(self.yaw, proj.yaw);
        let reach = (HALF_WIDTH * skew.cos()).abs() + (HALF_LENGTH * skew.sin()).abs();
        let limit = track.outer_half - reach - 0.05;
        if proj.lateral.abs() <= limit {
            if self.s_track < self.min_s {
                self.hold_start_line(proj);
            }
            if self.crash_cooldown > 0.0 {
                self.crash_cooldown -= dt;
            }
            return;
        }

        let over = proj.lateral.abs() - limit;
        let sgn = sign(proj.lateral);
        let nx = -proj.yaw.cos() * sgn;
        let nz = proj.yaw.sin() * sgn;
        self.x += nx * over;
        self.z += nz * over;

        let yaw_n = nx.atan2(nz);
        let rel = crate::math::ang_diff(self.yaw, yaw_n);
        let n_l = rel.cos();
        let n_w = rel.sin();

        // The corner of the car furthest into the wall. Which end touches
        // first decides whether the car is spun or stopped, so it comes from
        // the geometry rather than from a constant.
        let cw = -sgn * reach;
        let cl = if self.v_long >= 0.0 { HALF_LENGTH * 0.85 } else { -HALF_LENGTH * 0.85 };
        let vp_l = self.v_long - self.yaw_rate * cw;
        let vp_w = self.v_lat + self.yaw_rate * cl;
        let vn = vp_l * n_l + vp_w * n_w;
        if vn >= 0.0 {
            self.v_lat *= 0.6;
            if self.s_track < self.min_s {
                self.hold_start_line(proj);
            }
            if self.crash_cooldown > 0.0 {
                self.crash_cooldown -= dt;
            }
            return;
        }

        let rxn = cl * n_w - cw * n_l;
        let inv_mass = 1.0 / MASS + (rxn * rxn) / YAW_I;
        let jn = -(1.0 + WALL_RESTITUTION) * vn / inv_mass;

        let t_l = -n_w;
        let t_w = n_l;
        let vt = vp_l * t_l + vp_w * t_w;
        let rxt = cl * t_w - cw * t_l;
        let inv_mass_t = 1.0 / MASS + (rxt * rxt) / YAW_I;
        let max_t = WALL_FRICTION * jn.abs();
        let jt = clamp(-vt / inv_mass_t, -max_t, max_t);

        self.v_long += (jn * n_l + jt * t_l) / MASS;
        self.v_lat += (jn * n_w + jt * t_w) / MASS;
        self.yaw_rate = clamp(self.yaw_rate + (jn * rxn + jt * rxt) / YAW_I, -3.6, 3.6);

        let hit = vn.abs();
        self.roll_v += -sgn * hit * 0.10;
        self.pitch_v += hit * 0.045;
        self.heave_v -= (1.4f64).min(hit * 0.05);
        for w in self.w.iter_mut() {
            w.omega *= 1.0 - (0.5f64).min(hit * 0.03);
        }

        self.contact_timer = self.contact_timer.max(0.55);
        // A brush along the wall at speed scrubs hard even when the closing
        // speed is small, so this reads the speed along the barrier as well as
        // the speed into it.
        let along = vt.abs();
        self.scrape = (1.0f64).min(
            self.scrape
                .max((1.0f64).min(hit / 6.0) * 0.75 + (1.0f64).min(along / 26.0) * 0.55),
        );
        if self.crash_cooldown <= 0.0 && hit > 1.4 {
            self.crash_cooldown = 0.28;
            self.last_hit = true;
            self.last_hit_kind = HitKind::Wall;
            self.impact_speed = hit;
            self.impact = (1.0f64).min(hit / 11.0);
            self.stun = WALL_STUN * (1.0f64).min(hit / 8.0);
        }
        if self.s_track < self.min_s {
            self.hold_start_line(proj);
        }
        if self.crash_cooldown > 0.0 {
            self.crash_cooldown -= dt;
        }
    }

    /// The start line is a wall: there is no level behind it.
    fn hold_start_line(&mut self, proj: &Projection) {
        let back = self.min_s - self.s_track;
        self.x += proj.yaw.sin() * back;
        self.z += proj.yaw.cos() * back;
        self.s_track = self.min_s;
        if self.v_long < 0.0 {
            self.v_long = 0.0;
        }
    }
}

/// How far this body reaches along a world direction.
pub(crate) fn support(car: &Vehicle, nx: f64, nz: f64) -> f64 {
    let sy = car.yaw.sin();
    let cy = car.yaw.cos();
    let l = nx * sy + nz * cy;
    let w = nx * cy - nz * sy;
    l.abs() * HALF_LENGTH + w.abs() * HALF_WIDTH
}

fn body_point(car: &Vehicle, dx: f64, dz: f64) -> (f64, f64) {
    let sy = car.yaw.sin();
    let cy = car.yaw.cos();
    (dx * sy + dz * cy, dx * cy - dz * sy)
}

/// Two cars touching.
///
/// Resolved the same way the barrier is: separate them, then exchange an
/// impulse at the contact point. Because that point is off both centres of
/// mass, a nose-to-tail nudge shoves the car in front forwards while a
/// door-to-door lean pushes both sideways and turns them - out of one
/// equation, with no special case for who hit whom. Equal masses, so neither
/// car gets a free ride out of being the one that made contact.
pub fn collide_cars(a: &mut Vehicle, b: &mut Vehicle) -> f64 {
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    let dist = dx.hypot(dz);
    if dist < 1e-4 || dist > 12.0 {
        return 0.0;
    }
    let nx = dx / dist;
    let nz = dz / dist;
    let overlap = support(a, nx, nz) + support(b, -nx, -nz) - dist;
    if overlap <= 0.0 {
        return 0.0;
    }

    // push apart evenly, so neither car is walked through the other
    let push = overlap * 0.5 + 0.002;
    a.x -= nx * push;
    a.z -= nz * push;
    b.x += nx * push;
    b.z += nz * push;

    let sa = support(a, nx, nz);
    let cx = a.x + nx * sa;
    let cz = a.z + nz * sa;
    let (al, aw) = body_point(a, cx - a.x, cz - a.z);
    let (bl, bw) = body_point(b, cx - b.x, cz - b.z);
    let (anl, anw) = body_point(a, nx, nz);
    let (bnl, bnw) = body_point(b, nx, nz);

    let avn = (a.v_long - a.yaw_rate * aw) * anl + (a.v_lat + a.yaw_rate * al) * anw;
    let bvn = (b.v_long - b.yaw_rate * bw) * bnl + (b.v_lat + b.yaw_rate * bl) * bnw;
    let rel = bvn - avn;
    if rel > 0.0 {
        return 0.0; // already separating
    }

    let ra = al * anw - aw * anl;
    let rb = bl * bnw - bw * bnl;
    let inv_mass = 2.0 / MASS + (ra * ra + rb * rb) / YAW_I;
    let j = -(1.0 + 0.22) * rel / inv_mass;

    a.v_long -= j * anl / MASS;
    a.v_lat -= j * anw / MASS;
    a.yaw_rate = clamp(a.yaw_rate - j * ra / YAW_I, -3.6, 3.6);
    b.v_long += j * bnl / MASS;
    b.v_lat += j * bnw / MASS;
    b.yaw_rate = clamp(b.yaw_rate + j * rb / YAW_I, -3.6, 3.6);

    let hit = rel.abs();
    a.roll_v += hit * 0.05;
    b.roll_v -= hit * 0.05;
    a.contact_timer = a.contact_timer.max(0.55);
    b.contact_timer = b.contact_timer.max(0.55);
    for c in [&mut *a, &mut *b] {
        if c.crash_cooldown <= 0.0 && hit > 2.2 {
            c.crash_cooldown = 0.30;
            c.last_hit = true;
            c.last_hit_kind = HitKind::Car;
            c.impact_speed = hit;
            c.impact = (1.0f64).min(hit / 14.0);
        }
    }
    hit
}

/* -------------------------------------------------------------- the air ---
 *
 * A CAR THAT LEAVES THE ROAD.
 *
 * Everything else in this solver assumes the wheels are on the tarmac. The
 * pose is `road_y + lift + body_y` - an elevation looked up from the track and
 * a spring travel on top of it - so there is no vertical state at all and no
 * way for the car to be anywhere the road is not. That is the right model for
 * a road racer and it is exactly one assumption short of a stunt course.
 *
 * What is added is the smallest thing that makes a jump real:
 *
 *   - an ABSOLUTE world height while airborne, integrated under gravity.
 *     Absolute rather than an offset from the road, because the road keeps
 *     rising and falling underneath a car that has left it, and a car flying
 *     over a dip should not follow the dip down.
 *
 *   - ZERO WHEEL LOAD. This is the whole of "no grip in the air", and it is
 *     one line rather than a second code path: every tyre force in this file
 *     is `mu * load * f(slip)`, so a wheel carrying no load generates no
 *     lateral force, no longitudinal force and no yaw moment. The engine still
 *     spins the wheels - they are free - which is what a car does off a ramp.
 *
 *   - AIR CONTROL, deliberately weak. The trial is to land straight, so the
 *     player has to be able to correct; but a car that can be spun freely in
 *     the air is a toy, and a car that cannot be corrected at all is a coin
 *     toss. It is a yaw RATE the steering asks for, damped, so releasing the
 *     wheel stops the rotation rather than leaving it spinning.
 *
 * The ramp itself is not geometry the car collides with. It is an arc-length
 * window with a height profile, armed by the director; while the car is inside
 * it the wheels follow that profile, and at the lip the vertical speed the
 * profile was already producing becomes the launch speed. That means the
 * take-off is continuous - the car never gains a velocity it did not have -
 * and it means the ramp cannot be clipped through, driven around, or landed on
 * from the wrong side, none of which a collision mesh gives for free.
 */

/// A ramp: an arc-length window, a height, and an optional deck to drive on.
///
/// THE CREST IS THE PART YOU DRIVE ALONG.
///
/// A launch ramp is a wedge: climb, leave. That is the whole of what the three
/// on Chapter 7's stunt course are, and for a jump it is right. It is NOT what
/// a ramp built to get over something is - a plank thrown across a blocked
/// tunnel mouth has a top you drive ALONG before you run out of it, and a
/// structure with no top reads as a jump rather than as a way past.
///
/// So a ramp has four marks rather than two:
///
///   s0 .. s1   the incline, `h * u^2`, as it always was
///   s1 .. s2   the CREST: a long shallow run from `h` up to `lip`
///   s2 .. s3   the DESCENT, `lip` back down to the road
///   s3         the end of it, where the car runs out of structure
///
/// `s2 == s1` with `lip == h` and `s3 == s2` is exactly the old wedge, which
/// is what `arm_ramp` still builds - so the eight launch ramps on the course
/// are untouched by any of this.
///
/// # Why a descent, when falling off the end already worked
///
/// Because a structure a car is meant to come back down off is not a jump.
/// Aurora Forge's roof run climbs eighteen units, holds that for a kilometre
/// and has to put the car back on the factory floor at the far end - and the
/// only thing the two-part profile could do there was throw it off an
/// eighteen-unit drop at whatever speed it was carrying. That is a crash, not
/// a way down, and building the way down as scenery under a falling car does
/// not help: the flight ends when the car reaches the ROAD, so the slope would
/// be something it passed through.
///
/// # And the incline eases differently when there is one
///
/// A launch ramp wants a kicker: `h * u^2` has its steepest slope at the very
/// top, which is exactly what throws the car. A ramp onto a deck wants the
/// opposite - it has to arrive PARALLEL to the thing it joins, or there is a
/// corner at the top that the suspension reads as an impact. So a ramp with a
/// descent eases both ends with smoothstep, whose slope is zero at both, and a
/// ramp without one keeps the quadratic it has always had.
#[derive(Clone, Copy, Default)]
pub struct Ramp {
    /// Where the incline starts, where it levels onto the crest, where the
    /// crest ends, and where the descent reaches the road, in arc length.
    pub s0: f64,
    pub s1: f64,
    pub s2: f64,
    pub s3: f64,
    /// Height at the crest and at the far end of it, in world units. A crest
    /// that rises slightly is what makes a makeshift ramp throw the car at all
    /// rather than simply drop it off the end.
    pub h: f64,
    pub lip: f64,
}

/// Smoothstep: zero slope at both ends, which is what lets a ramp meet a deck
/// without a corner in it.
#[inline]
fn smoothstep(u: f64) -> f64 {
    let u = u.clamp(0.0, 1.0);
    u * u * (3.0 - 2.0 * u)
}

/* WHY THE FIRST TUNE FELT LIKE A PAPER CAR, AND WHAT FIXED IT.
 *
 * Reported: boosting off a ramp read as "someone tossed a paper car in the
 * air". That is a specific complaint and it had three specific causes, none
 * of which was the gravity constant on its own.
 *
 *   NOTHING SLOWED DOWN. A car off a ramp has no wheels on the road, so the
 *   only thing still acting on it horizontally is air - and the solver's drag
 *   lives in the tyre model, which was switched off with the wheel loads. So
 *   the car held its exact launch speed for the whole flight and landed doing
 *   what it took off doing. Real cars do not; that alone reads as weightless.
 *
 *   THE STEERING STILL WORKED. Air control was a whole radian a second, which
 *   is faster than the car yaws ON THE GROUND at speed. A mass with no contact
 *   patch cannot rotate like that, and being able to spin it freely in mid-air
 *   is exactly the "paper" feeling.
 *
 *   THE NOSE FELL AT A CONSTANT RATE. `air_pitch_v` was a fixed -0.30 rad/s,
 *   so the car rotated like a hand on a clock rather than tipping. A real car
 *   pitches nose-down under its own weight, and the rate BUILDS.
 *
 * Gravity was also too low - a 4-unit lip at 70 units/s hung for about a
 * second and a half - but raising it alone would have made a lighter paper
 * car that fell faster. All four are below.
 */
/// How hard the world pulls a car down.
///
/// Not 9.81. This game's unit is about a metre but its speeds are not - a
/// stock car runs to 83 units/s, which is 300 km/h - so at real gravity a
/// jump taken at racing speed hangs for two and a half seconds and reads as
/// the moon. Arcade racers all exaggerate this for the same reason; the value
/// is chosen from the flight TIME, which lands a good launch in a little
/// under a second.
pub const AIR_G: f64 = 27.0;
/// Aerodynamic drag while airborne, per second, as a fraction of speed.
///
/// The tyre model carries all the drag this solver has and it is switched off
/// with the wheel loads, so without this a car in the air is in a vacuum. A
/// car doing 70 units/s sheds about four of them over a one-second flight,
/// which is small enough not to feel like a handbrake and large enough that
/// the landing is visibly slower than the launch - which is the thing that
/// makes it read as having weight.
pub const AIR_DRAG: f64 = 0.055;
/// How fast the steering can yaw the car in the air, in radians a second.
///
/// A fifth of what it was. Enough to straighten a car that left the lip a few
/// degrees out - which is the trial - and nowhere near enough to point it
/// somewhere else, which is what a car with no contact patch cannot do.
const AIR_YAW: f64 = 0.34;
/// ...and how quickly it settles to that. Slow, because this is a two-tonne
/// mass changing its rotation rather than a cursor: the wheel asks, and the
/// car takes most of a second to agree.
const AIR_YAW_DAMP: f64 = 1.15;
/// How fast the nose drops, as an ACCELERATION rather than a rate.
///
/// A car leaving a ramp is unsupported at the front first and pitches forward
/// under its own weight, so the rotation builds through the flight instead of
/// running at a constant speed. This is what turns "a model sliding through
/// the air at a fixed angle" into something that tips.
pub const AIR_PITCH_ACC: f64 = 0.85;
/// ...bounded, so a long flight cannot put the car on its roof.
pub const AIR_PITCH_MAX: f64 = 0.85;
/// The heading error, in radians, at which a landing scores nothing. Twelve
/// degrees: past that the car is visibly sideways as it touches down.
pub const LAND_TOL: f64 = 0.21;

impl Vehicle {
    /// Arm the next ramp, or clear it with `h <= 0`.
    ///
    /// One at a time, because only one can be being driven at once and holding
    /// a list here would put course layout inside the solver.
    pub fn arm_ramp(&mut self, s0: f64, s1: f64, h: f64) {
        self.arm_ramp_deck(s0, s1, s1, h, h);
    }

    /// Arm a ramp with a crest to drive along AND a descent off the far end.
    ///
    /// `s2 .. s3` eases `lip` back down to the road, and the car stays on the
    /// ground for the whole of it - there is no launch. Passing `s3 <= s2`
    /// gives the launch ramp `arm_ramp_deck` builds.
    pub fn arm_ramp_road(&mut self, s0: f64, s1: f64, s2: f64, s3: f64, h: f64, lip: f64) {
        self.ramp = if h > 0.0 && s1 > s0 && s2 >= s1 {
            Some(Ramp { s0, s1, s2, s3: s3.max(s2), h, lip: if lip > 0.0 { lip } else { h } })
        } else {
            None
        };
    }

    /// Arm a ramp with a crest to drive along. `s1` is where the climb levels
    /// off and `s2` where the structure runs out; `lip` is the height there.
    /// Passing `s2 == s1` and `lip == h` is the plain wedge `arm_ramp` builds.
    pub fn arm_ramp_deck(&mut self, s0: f64, s1: f64, s2: f64, h: f64, lip: f64) {
        self.ramp = if h > 0.0 && s1 > s0 && s2 >= s1 {
            Some(Ramp { s0, s1, s2, s3: s2, h, lip: if lip > 0.0 { lip } else { h } })
        } else {
            None
        };
    }

    /// True while no wheel is on the ground.
    pub fn is_airborne(&self) -> bool {
        self.airborne
    }

    /// The ramp climb and the flight, run once per frame after the solver.
    ///
    /// Returns nothing and writes `air_y`, which the caller adds to the pose.
    fn update_air(&mut self, track: &Track, dt: f64, steer_in: f64) {
        let ground = self.road_y + self.lift;

        // ---- on the ramp, still on the ground ----------------------------
        if !self.airborne {
            let mut launched = false;
            if let Some(r) = self.ramp {
                let crest_end = r.s2.max(r.s1);
                /* A ramp with a descent ends at the bottom of it; one without
                   ends where the structure does, exactly as before. */
                let has_down = r.s3 > crest_end;
                let end = if has_down { r.s3 } else { crest_end };
                if self.s_track >= r.s0 && self.s_track <= end {
                    let prev = self.air_y;
                    if self.s_track <= r.s1 {
                        /* THE INCLINE.
                           A LAUNCH ramp is quadratic: a constant slope has a
                           corner at the bottom that the car hits rather than
                           rides, and the steepest part being at the very top
                           is what throws it.
                           A ramp onto a DECK is smoothstepped instead, because
                           it has to arrive parallel to the deck it joins - a
                           quadratic meets a flat roof at its steepest and the
                           suspension reads that as an impact. */
                        let span = (r.s1 - r.s0).max(1.0);
                        let u = ((self.s_track - r.s0) / span).clamp(0.0, 1.0);
                        if has_down {
                            self.air_y = r.h * smoothstep(u);
                            self.air_pitch = (6.0 * r.h * u * (1.0 - u) / span).atan();
                        } else {
                            self.air_y = r.h * u * u;
                            self.air_pitch = (2.0 * r.h * u / span).atan();
                        }
                    } else if self.s_track <= crest_end {
                        /* THE CREST, which is the part that is driven along.
                           Straight rather than curved: it is a deck somebody
                           laid, not a moulded kicker, and the shallow rise
                           along it is the only thing throwing the car at the
                           far end. */
                        let span = (crest_end - r.s1).max(1.0);
                        let v = ((self.s_track - r.s1) / span).clamp(0.0, 1.0);
                        self.air_y = r.h + (r.lip - r.h) * v;
                        self.air_pitch = ((r.lip - r.h) / span).atan();
                    } else {
                        /* THE DESCENT. Smoothstepped, so it leaves the deck
                           level and reaches the road level - the car drives
                           down it rather than dropping off the end of the
                           structure, which is the whole reason it exists. */
                        let span = (r.s3 - crest_end).max(1.0);
                        let v = ((self.s_track - crest_end) / span).clamp(0.0, 1.0);
                        self.air_y = r.lip * (1.0 - smoothstep(v));
                        self.air_pitch = (-6.0 * r.lip * v * (1.0 - v) / span).atan();
                    }
                    /* The vertical speed is read back off the profile rather
                       than assumed, so what leaves the end is what the car was
                       actually doing - on either section. */
                    self.air_v = if dt > 1e-6 { (self.air_y - prev) / dt } else { 0.0 };
                    self.air_time = 0.0;
                    return;
                }
                if self.s_track > end && self.air_y > 0.02 {
                    launched = true;
                }
            }
            if launched {
                self.airborne = true;
                self.air_time = 0.0;
                self.air_abs = ground + self.air_y;
                self.landing = 0.0;
                self.landed = 0.0;
                /* THE LAUNCH. The nose keeps the angle the ramp gave it and
                   then starts falling from there - the rate is zero at the lip
                   and builds, which is what a car actually does. Starting it
                   at a fixed rate made every jump rotate identically no matter
                   how it was taken. */
                self.air_pitch_v = 0.0;
                self.air_yaw_v = self.yaw_rate * 0.35;
                /* ...and the suspension unloads. A car leaving a ramp rebounds
                   as the springs let go, which is the visual cue that it has
                   left the ground at all. */
                self.heave_v += 1.6;
                self.ramp = None;
            } else if self.air_y != 0.0 {
                // walked off the side of an armed ramp, or was teleported
                self.air_y = 0.0;
                self.air_v = 0.0;
                self.air_pitch = 0.0;
            }
        }

        // ---- the flight ---------------------------------------------------
        if !self.airborne {
            return;
        }
        self.air_time += dt;
        self.air_v -= AIR_G * dt;
        self.air_abs += self.air_v * dt;
        self.air_y = self.air_abs - ground;

        /* AIR RESISTANCE. The only thing still touching the car is the air,
           and the solver's own drag went away with the wheel loads - so
           without this the car holds its launch speed exactly and lands doing
           what it took off doing, which is most of why it felt weightless.
           Applied to both axes: a car sliding sideways through the air loses
           that too. */
        let keep = (-AIR_DRAG * dt).exp();
        self.v_long *= keep;
        self.v_lat *= keep;

        /* Air control: a damped yaw RATE, so letting go stops the rotation
           rather than leaving it spinning. Deliberately weak and deliberately
           slow to respond - see AIR_YAW. */
        let want = clamp(steer_in, -1.0, 1.0) * AIR_YAW;
        self.air_yaw_v += (want - self.air_yaw_v) * (1.0f64).min(AIR_YAW_DAMP * dt);
        self.yaw += self.air_yaw_v * dt;
        self.yaw_rate = self.air_yaw_v;
        /* THE NOSE DROPS, AND THE DROP BUILDS. Gravity acts at the centre of
           mass and the car is unsupported at the front first, so this is an
           angular acceleration, not the constant rate it used to be. Bounded,
           or a long flight ends inverted. */
        self.air_pitch_v = (self.air_pitch_v - AIR_PITCH_ACC * dt).max(-AIR_PITCH_MAX);
        self.air_pitch += self.air_pitch_v * dt;
        self.air_roll += self.air_roll_v * dt;
        /* The body follows the chassis. `pitch` and `roll` are what the
           renderer and the camera read, and leaving them on the spring model
           while the car is in the air is why it used to fly dead level - the
           suspension has nothing to push against up here. */
        self.pitch = self.air_pitch;
        self.roll += (self.air_roll - self.roll) * (1.0f64).min(6.0 * dt);

        if self.air_y > 0.0 {
            return;
        }

        // ---- the landing ---------------------------------------------------
        /* WHAT "PERFECTLY STRAIGHT" MEANS, and it is measured rather than
           judged: the angle between where the car is pointing and where the
           road is going, at the moment the wheels touch. Roll is folded in
           because a car that lands on two wheels has not landed well either. */
        let p = track.at(self.s_track);
        let head = crate::math::ang_diff(self.yaw, p.yaw).abs();
        let straight = (1.0 - head / LAND_TOL).clamp(0.0, 1.0);
        let level = (1.0 - self.air_roll.abs() / 0.45).clamp(0.0, 1.0);
        self.landing = straight * straight * level;
        self.landed = 1.0;

        self.airborne = false;
        self.air_y = 0.0;
        self.air_abs = ground;
        self.air_pitch = 0.0;
        self.air_roll = 0.0;
        self.air_pitch_v = 0.0;
        self.air_roll_v = 0.0;
        self.air_yaw_v = 0.0;

        /* The impact. A landing is a vertical speed arriving at a suspension,
           so it goes into the heave the body model already runs rather than
           into a separate shake - that way the car squats and rebounds, the
           camera follows it because the camera already follows the body, and
           there is nothing new to tune. */
        /* THE ARRIVAL. A landing is a vertical speed meeting a suspension, so
           it goes into the heave the body model already runs - the car squats,
           rebounds, and the camera follows it because the camera already
           follows the body. Heavier than it was: the first tune barely moved
           and a landing you cannot feel is a landing that did not happen. */
        let fall = (-self.air_v).max(0.0);
        self.heave_v -= (fall * 0.22).min(6.5);
        self.impact = self.impact.max((fall / 20.0).min(0.85));
        self.impact_speed = self.impact_speed.max(fall);
        /* The nose slaps down. Whatever pitch the car was carrying is thrown
           into the spring rather than snapped to zero, so a nose-down arrival
           bottoms the front and comes back up. */
        self.pitch_v -= self.air_pitch * 5.0;

        /* THE PENALTY, and it is a penalty on SPEED, not a crash.
           A bad landing scrubs momentum: the tyres arrive pointing one way and
           travelling another, which is a slide, and a slide costs the exit.
           A good one costs nothing at all, which is what makes the trial worth
           doing well rather than merely surviving. */
        /* Every landing costs something, and a bad one costs a lot. The floor
           is the point: even a perfect arrival scrubs a little, because four
           tyres taking a car's whole weight at once cannot do it for free, and
           a jump that returned the car to the road at exactly its launch speed
           was the other half of what made this feel weightless. */
        let miss = 1.0 - self.landing;
        self.v_long *= 1.0 - (0.06 + 0.34 * miss);
        // and the sideways component the heading error just created is real
        let slip = head.sin() * self.v_long;
        self.v_lat += slip * miss;
        self.yaw_rate += slip * miss * 0.04;
        if miss > 0.55 {
            // hard enough to unsettle it, never hard enough to end the run
            self.stun = self.stun.max(WALL_STUN * 0.45 * miss);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::track::{Centreline, Track};

    fn straight_track(n: usize) -> Track {
        let mut c = Centreline { step: 6.0, count: n, shipped_count: n, ..Default::default() };
        for i in 0..n {
            c.x.push(0.0);
            c.y.push(0.0);
            c.z.push(i as f64 * 6.0);
            c.yaw.push(0.0);
            c.curv.push(0.0);
            c.tunnel.push(0);
        }
        Track::new(c)
    }

    fn drive(car: &mut Vehicle, t: &Track, secs: f64, input: Input) {
        let n = (secs * 60.0) as usize;
        for _ in 0..n {
            car.update(t, 1.0 / 60.0, input, true);
        }
    }

    /// The car's ceiling is `TOP_SPEED` **world units** per second, and the
    /// speedometer converts that through `UNIT_METRES` - which is why the
    /// street engine reads 132 mph rather than the 290 the constant looks
    /// like. The Forge swap lifts it to 144, and its hard cap to 200.
    #[test]
    fn reaches_its_specified_top_speed() {
        let t = straight_track(20_000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 100.0, 0.0);
        drive(&mut car, &t, 60.0, Input { throttle: 1.0, ..Default::default() });
        let mph = car.speed_mph();
        assert!(mph > 125.0, "flat out for a minute only reached {mph:.1} mph");
        assert!(mph <= 133.0, "street engine exceeded its ceiling at {mph:.1} mph");
        assert_eq!(car.gear, 7, "should be in top gear at {mph:.0} mph");

        // ...and the rebuild is worth what Javas says it is worth.
        let mut swapped = Vehicle::new(&t, 0.0);
        swapped.reset(&t, 100.0, 0.0);
        swapped.fit_engine(Vehicle::ENGINE_SWAP);
        drive(&mut swapped, &t, 60.0, Input { throttle: 1.0, ..Default::default() });
        let smph = swapped.speed_mph();
        assert!(smph > 140.0 && smph <= 146.0, "swapped engine reached {smph:.1} mph, wanted ~144");

        // raceMode lifts the ceiling to the 200 mph hard cap and no further.
        swapped.race_mode_multiplier = 1.5;
        drive(&mut swapped, &t, 40.0, Input { throttle: 1.0, boost: true, ..Default::default() });
        let rmph = swapped.speed_mph();
        assert!(rmph <= 201.0, "raceMode blew past the 200 mph cap at {rmph:.1}");

        /* ...AND THE WRECK IS A WRECK.

           Chapter 6 opens on the car Ryker left in the caldera, and it used to
           be doing the full street 132 through every trial in the Forge - so
           the rebuild that the whole chapter is built around was worth twelve
           miles an hour. Seventy is a car that is hurt, and it makes the
           hundred and forty-four at the end of it mean something. */
        let mut wreck = Vehicle::new(&t, 0.0);
        wreck.reset(&t, 100.0, 0.0);
        wreck.fit_engine(Vehicle::ENGINE_BROKEN);
        drive(&mut wreck, &t, 60.0, Input { throttle: 1.0, ..Default::default() });
        let wmph = wreck.speed_mph();
        assert!(wmph > 66.0 && wmph <= 72.0, "the wreck reached {wmph:.1} mph, wanted ~70");

        /* And the rebuild is the thing that fixes it: the same car, fitted
           with what Javas builds, has to roughly double. */
        wreck.fit_engine(Vehicle::ENGINE_SWAP);
        drive(&mut wreck, &t, 60.0, Input { throttle: 1.0, ..Default::default() });
        let fixed = wreck.speed_mph();
        assert!(fixed > 140.0 && fixed <= 146.0,
            "the rebuilt wreck reached {fixed:.1} mph, wanted ~144");
    }

    /// A car on full throttle in a straight line must not wander off it.
    #[test]
    fn tracks_straight_under_power() {
        let t = straight_track(20_000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 100.0, 0.0);
        drive(&mut car, &t, 20.0, Input { throttle: 1.0, ..Default::default() });
        assert!(car.lateral.abs() < 0.5, "drifted {} units off line", car.lateral);
        assert!(car.s_track > 500.0, "barely moved: s = {}", car.s_track);
    }

    /// Braking must actually stop the car, and the ABS must keep the wheels
    /// turning while it does - a locked wheel has no lateral grip left.
    #[test]
    fn brakes_stop_the_car_without_locking() {
        let t = straight_track(20_000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 100.0, 0.0);
        drive(&mut car, &t, 20.0, Input { throttle: 1.0, ..Default::default() });
        let entry = car.speed;
        assert!(entry > 40.0);
        let mut min_omega = f64::INFINITY;
        for _ in 0..(6 * 60) {
            car.update(&t, 1.0 / 60.0, Input { brake: 1.0, ..Default::default() }, true);
            if car.speed > 8.0 {
                for w in &car.w {
                    min_omega = min_omega.min(w.omega.abs());
                }
            }
        }
        assert!(car.speed < entry * 0.25, "six seconds of brakes left {} u/s", car.speed);
        assert!(min_omega > 1.0, "a wheel locked solid (omega {min_omega})");
    }

    /// The boost reservoir latches empty. A held key must never produce a
    /// continuous stuttering boost off a bar that reads as spent: once
    /// emptied, nothing fires again until there is a real charge in it, so the
    /// reservoir settles into a burn/refill cycle between the two thresholds
    /// rather than trickling out at zero.
    #[test]
    fn boost_latches_when_spent() {
        let t = straight_track(20_000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 100.0, 0.0);
        let input = Input { throttle: 1.0, boost: true, ..Default::default() };

        // it empties in about three and a half seconds of holding it
        let mut emptied = false;
        for i in 0..(10 * 60) {
            car.update(&t, 1.0 / 60.0, input, true);
            if car.boost_locked {
                emptied = true;
                assert!(i < 5 * 60, "reservoir took {} s to empty", i as f64 / 60.0);
                break;
            }
        }
        assert!(emptied, "holding boost never emptied the reservoir");

        // The reservoir now cycles. What must never happen is a burn starting
        // on an empty bar: the latch only clears once the refill has put a
        // real charge back, so every frame that fires has at least BOOST_ARM's
        // worth in it at the moment it re-arms, and there is a measurable gap
        // between running dry and firing again.
        let mut dry_fires = 0;
        let mut gap = 0usize;
        let mut worst_gap = usize::MAX;
        for _ in 0..(12 * 60) {
            car.update(&t, 1.0 / 60.0, input, true);
            if car.boosting {
                if gap > 0 {
                    worst_gap = worst_gap.min(gap);
                }
                gap = 0;
                if car.boost < 0.01 {
                    dry_fires += 1;
                }
            } else {
                gap += 1;
            }
        }
        assert_eq!(dry_fires, 0, "boost fired off an empty reservoir");
        assert!(
            worst_gap > 30,
            "only {worst_gap} frames of recharge between burns - that is the stutter the latch exists to stop"
        );
    }

    /// The barrier is a wall with a point of application, and a car thrown at
    /// it must come back rather than be deleted into it.
    #[test]
    fn barrier_bounces_rather_than_absorbs() {
        let t = straight_track(20_000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 100.0, 0.0);
        drive(&mut car, &t, 12.0, Input { throttle: 1.0, ..Default::default() });
        // aim it at the wall
        car.v_lat = 14.0;
        for _ in 0..90 {
            car.update(&t, 1.0 / 60.0, Input { throttle: 1.0, ..Default::default() }, true);
        }
        assert!(
            car.lateral.abs() <= t.outer_half,
            "car ended up {} units out, past the barrier at {}",
            car.lateral,
            t.outer_half
        );
        assert!(car.speed > 1.0, "the wall swallowed the car");
    }

    /// A spin must recover. The guard is always on, so however far the car is
    /// thrown sideways it comes back pointing forwards.
    #[test]
    fn spin_guard_recovers_the_car() {
        let t = straight_track(20_000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 100.0, 0.0);
        drive(&mut car, &t, 12.0, Input { throttle: 1.0, ..Default::default() });
        car.yaw_rate = 2.6;
        car.v_lat = 18.0;
        drive(&mut car, &t, 6.0, Input { throttle: 0.5, ..Default::default() });
        assert!(
            car.body_slip.abs() < 0.7,
            "still sideways at {} rad after six seconds",
            car.body_slip
        );
    }

    /// Two cars must not occupy the same space, and a contact must exchange
    /// momentum rather than give one of them a free ride.
    #[test]
    fn cars_separate_and_exchange_momentum() {
        let t = straight_track(20_000);
        let mut a = Vehicle::new(&t, 0.0);
        let mut b = Vehicle::new(&t, 0.0);
        a.reset(&t, 100.0, 0.0);
        b.reset(&t, 100.0, 1.2);
        a.v_long = 40.0;
        b.v_long = 40.0;
        a.v_lat = 6.0;
        let before = a.v_lat + b.v_lat;
        let hit = collide_cars(&mut a, &mut b);
        assert!(hit > 0.0, "overlapping cars did not register a hit");
        let apart = (b.x - a.x).hypot(b.z - a.z);
        assert!(apart > 1.2, "cars still interpenetrating at {apart}");
        assert!(
            (a.v_lat + b.v_lat - before).abs() < 1.0,
            "momentum was created: {} -> {}",
            before,
            a.v_lat + b.v_lat
        );
    }

    /// The solver is fixed-step, so the same inputs must produce the same
    /// result whatever frame rate they arrive at. Straight-line acceleration
    /// is the honest test: a constant steering input would put the two runs on
    /// different parts of the barrier and compare nothing.
    #[test]
    fn frame_rate_independent() {
        let t = straight_track(20_000);
        let input = Input { throttle: 1.0, ..Default::default() };
        let mut fast = Vehicle::new(&t, 0.0);
        fast.reset(&t, 100.0, 0.0);
        for _ in 0..(15 * 120) {
            fast.update(&t, 1.0 / 120.0, input, true);
        }
        let mut slow = Vehicle::new(&t, 0.0);
        slow.reset(&t, 100.0, 0.0);
        for _ in 0..(15 * 30) {
            slow.update(&t, 1.0 / 30.0, input, true);
        }
        let d = (fast.speed - slow.speed).abs();
        assert!(d < 1.5, "120 Hz reached {} u/s, 30 Hz reached {}", fast.speed, slow.speed);
    }
    /// A ROAD RAMP CLIMBS, RUNS LEVEL, AND COMES BACK DOWN ON ITS WHEELS.
    ///
    /// Aurora Forge's roof run is the only structure on the course the car is
    /// meant to LEAVE the way it arrived. Three things have to hold and the
    /// two-part profile could not give any of them: the car reaches the deck
    /// height, it stays on the ground for the whole of it - a launch off an
    /// eighteen-unit deck is a crash, not a way down - and it ends the section
    /// back on the road rather than above it.
    #[test]
    fn a_road_ramp_comes_back_down() {
        let t = straight_track(6000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 400.0, 0.0);
        car.v_long = 70.0;
        // climb 500..640, deck 640..1400, descend 1400..1560
        car.arm_ramp_road(500.0, 640.0, 1400.0, 1560.0, 18.0, 18.0);

        let dt = 1.0 / 120.0;
        let (mut peak, mut deck_frames, mut air_frames) = (0.0f64, 0, 0);
        let mut off_deck = 0.0f64;
        for _ in 0..(40 * 120) {
            let input = Input { throttle: 1.0, ..Default::default() };
            car.update(&t, dt, input, true);
            if car.airborne {
                air_frames += 1;
            }
            if car.air_y > peak {
                peak = car.air_y;
            }
            if car.s_track > 700.0 && car.s_track < 1350.0 {
                deck_frames += 1;
                // on the deck the height must be the deck height, flat
                let err = (car.air_y - 18.0).abs();
                if err > off_deck {
                    off_deck = err;
                }
            }
            if car.s_track > 1600.0 {
                break;
            }
        }
        assert!(air_frames == 0, "a road ramp launched the car for {air_frames} frames");
        assert!(deck_frames > 60, "the car never spent time on the deck");
        assert!(
            (peak - 18.0).abs() < 0.05,
            "the deck is 18 units up and the car reached {peak}"
        );
        assert!(off_deck < 0.02, "the deck was not level: {off_deck} units of error");
        assert!(
            car.s_track > 1600.0,
            "the car never reached the end of the section (s={})",
            car.s_track
        );
        assert!(
            car.air_y.abs() < 0.02,
            "the car finished {} units above the road",
            car.air_y
        );
    }

    /// ...and the eight launch ramps are untouched by any of it. The same
    /// window, armed the old way, still throws the car.
    #[test]
    fn a_deck_ramp_without_a_descent_still_launches() {
        let t = straight_track(4000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 400.0, 0.0);
        car.v_long = 70.0;
        car.arm_ramp_deck(500.0, 560.0, 600.0, 10.4, 12.0);

        let dt = 1.0 / 120.0;
        let mut air_frames = 0;
        for _ in 0..(10 * 120) {
            let input = Input { throttle: 1.0, ..Default::default() };
            car.update(&t, dt, input, true);
            if car.airborne {
                air_frames += 1;
            }
        }
        assert!(air_frames > 10, "the crest ramp stopped launching: {air_frames} air frames");
    }

    /// A RAMP MUST LAUNCH THE CAR, AND THE CAR MUST COME DOWN.
    ///
    /// The three things a jump has to be, none of which the road-locked solver
    /// could do before: it leaves the ground, it is unsupported while it is up
    /// there, and it arrives back on the road further down it.
    #[test]
    fn a_ramp_launches_the_car_and_it_lands() {
        let t = straight_track(4000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 400.0, 0.0);
        car.v_long = 70.0;
        car.arm_ramp(500.0, 530.0, 4.2);

        let dt = 1.0 / 120.0;
        let (mut peak, mut air_frames, mut launch_s, mut land_s) = (0.0f64, 0, 0.0, 0.0);
        let mut was_air = false;
        for _ in 0..(10 * 120) {
            let input = Input { throttle: 1.0, ..Default::default() };
            car.update(&t, dt, input, true);
            if car.airborne && !was_air {
                launch_s = car.s_track;
            }
            if !car.airborne && was_air {
                land_s = car.s_track;
            }
            if car.airborne {
                air_frames += 1;
                /* No wheel may carry load while the car is off the ground -
                   checked from the SECOND airborne frame on. The loads are
                   computed before `update_air` decides the car has left the
                   lip, so the launch frame still has grip; at 1/120 s and 70
                   u/s that is half a unit of road, and moving the decision
                   earlier would mean deciding it against last frame's arc
                   length, which is a worse error than the one it fixes. */
                if was_air {
                    for i in 0..4 {
                        assert_eq!(car.w[i].load, 0.0, "a wheel is loaded in mid-air");
                    }
                }
            }
            was_air = car.airborne;
            peak = peak.max(car.air_y);
        }
        assert!(air_frames > 30, "the car was airborne for only {air_frames} frames");
        assert!(peak > 4.2, "the jump only reached {peak:.1}u, lower than the lip");
        assert!(
            land_s - launch_s > 40.0,
            "the car flew only {:.0}u down the road",
            land_s - launch_s
        );
        assert!(!car.airborne, "the car never came down");
        assert!(car.air_y.abs() < 1e-9, "it landed but is still {}u up", car.air_y);
    }

    /// LANDING STRAIGHT HAS TO BE WORTH MORE THAN LANDING SIDEWAYS.
    ///
    /// The whole trial is the landing, so the score has to separate the two
    /// cases and the penalty has to be real - and it has to be a penalty on
    /// SPEED rather than a crash, or the stunt is a checkpoint reload.
    #[test]
    fn a_straight_landing_beats_a_crooked_one() {
        let t = straight_track(4000);
        let run = |yaw_off: f64| {
            let mut car = Vehicle::new(&t, 0.0);
            car.reset(&t, 400.0, 0.0);
            car.v_long = 70.0;
            car.arm_ramp(500.0, 530.0, 4.2);
            let dt = 1.0 / 120.0;
            let mut turned = false;
            for _ in 0..(10 * 120) {
                car.update(&t, dt, Input { throttle: 1.0, ..Default::default() }, true);
                // put the heading error in once, just after take-off, so both
                // runs are otherwise identical
                if car.airborne && !turned {
                    turned = true;
                    car.yaw += yaw_off;
                }
                if turned && !car.airborne {
                    return (car.landing, car.v_long);
                }
            }
            (-1.0, -1.0)
        };
        let (good, v_good) = run(0.0);
        let (bad, v_bad) = run(0.30);          // seventeen degrees out
        assert!(good > 0.9, "a straight landing scored only {good:.2}");
        assert!(bad < 0.15, "a landing 17 degrees out still scored {bad:.2}");
        assert!(
            v_good > v_bad + 8.0,
            "a crooked landing cost only {:.1} u/s ({v_good:.1} vs {v_bad:.1})",
            v_good - v_bad
        );
    }

    /* A CREST IS DRIVEN ALONG, NOT FLOWN OVER.
     *
     * The bypass at MIRAGE CIRCUIT's blocked bore is a structure somebody threw
     * up over the rubble: climb, a long shallow top the car actually drives
     * along, and then the end of it. Three things have to be true and none of
     * them is true of a plain wedge:
     *
     *   the car is still ON THE GROUND for the whole crest - a ramp whose top
     *   launches you at the near end is a kicker, not a way past;
     *   it holds its height there rather than continuing to climb;
     *   and it is the shallow rise ALONG the crest that throws it at the far
     *   end, so the launch is gentle and the drop is what makes the jump.
     */
    #[test]
    fn a_crested_ramp_is_driven_along_before_it_launches() {
        let t = straight_track(4000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 400.0, 0.0);
        car.v_long = 70.0;
        car.speed = 70.0;
        // climb 500..600 to 10, crest 600..660 rising to 11.4, then nothing
        car.arm_ramp_deck(500.0, 600.0, 660.0, 10.0, 11.4);

        let dt = 1.0 / 120.0;
        let (mut crest_frames, mut airborne_on_crest, mut top) = (0, 0, 0.0f64);
        let mut launched_at = 0.0;
        let mut landed_at = 0.0;
        for _ in 0..(120 * 20) {
            car.update(&t, dt, Input { throttle: 1.0, ..Default::default() }, true);
            if car.s_track > 600.0 && car.s_track < 660.0 {
                crest_frames += 1;
                if car.is_airborne() { airborne_on_crest += 1; }
                top = top.max(car.air_y);
            }
            if car.is_airborne() && launched_at == 0.0 { launched_at = car.s_track; }
            if car.landed != 0.0 && landed_at == 0.0 { landed_at = car.s_track; }
        }
        assert!(crest_frames > 20, "the crest was crossed in {crest_frames} frames");
        assert_eq!(airborne_on_crest, 0,
            "the car left the ground {airborne_on_crest} times while still on the crest");
        assert!((top - 11.4).abs() < 0.2, "the crest topped out at {top:.2}, not 11.4");
        assert!(launched_at >= 659.0, "it launched at {launched_at:.0}, before the end of the crest");
        assert!(landed_at > launched_at, "it never came down");
        /* ...and the plain wedge is untouched by any of this: `arm_ramp` is
           the same ramp it always was. */
        car.reset(&t, 400.0, 0.0);
        car.v_long = 70.0;
        car.arm_ramp(500.0, 546.0, 4.2);
        let r = car.ramp.expect("arm_ramp armed nothing");
        assert_eq!((r.s1, r.s2, r.h, r.lip), (546.0, 546.0, 4.2, 4.2));
    }

    /// AN ARMED RAMP MUST NOT CHANGE A CAR THAT NEVER REACHES IT, and a car
    /// that is reset out of the air must not keep falling.
    #[test]
    fn the_air_state_does_not_leak() {
        let t = straight_track(4000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 400.0, 0.0);
        car.v_long = 60.0;
        car.arm_ramp(9000.0, 9030.0, 4.0);     // far up the road
        let dt = 1.0 / 120.0;
        for _ in 0..(4 * 120) {
            car.update(&t, dt, Input { throttle: 1.0, ..Default::default() }, true);
            assert!(!car.airborne, "an unreached ramp put the car in the air");
            assert_eq!(car.air_y, 0.0, "an unreached ramp lifted the car");
        }
        // ...and a rewind out of mid-flight
        car.arm_ramp(car.s_track + 40.0, car.s_track + 70.0, 4.2);
        for _ in 0..(3 * 120) {
            car.update(&t, dt, Input { throttle: 1.0, ..Default::default() }, true);
            if car.airborne {
                break;
            }
        }
        assert!(car.airborne, "the second ramp never launched it");
        car.reset(&t, 400.0, 0.0);
        assert!(!car.airborne, "reset left the car airborne");
        assert!(car.ramp.is_none(), "reset left a ramp armed");
        car.update(&t, dt, Input::default(), true);
        assert_eq!(car.air_y, 0.0, "reset left the car {}u off the road", car.air_y);
    }


    /// A JUMP HAS TO HAVE WEIGHT, and "weight" is three measurable things.
    ///
    /// The first tune of this read as "someone tossed a paper car in the air",
    /// and every part of that complaint is a number: the flight was too long,
    /// the car did not slow down while it was up there, and it arrived doing
    /// exactly what it left doing. This pins all three so they cannot drift
    /// back - a floaty jump is a regression nobody notices in a diff.
    #[test]
    fn a_jump_has_weight() {
        let t = straight_track(4000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 400.0, 0.0);
        car.v_long = 72.0;
        car.arm_ramp(500.0, 546.0, 4.2);

        let dt = 1.0 / 120.0;
        let (mut air, mut launch_v, mut land_v, mut peak_pitch) = (0.0f64, 0.0, 0.0, 0.0f64);
        let mut was = false;
        for _ in 0..(12 * 120) {
            car.update(&t, dt, Input { throttle: 1.0, ..Default::default() }, true);
            if car.airborne && !was {
                launch_v = car.v_long;
            }
            if !car.airborne && was {
                land_v = car.v_long;
                break;
            }
            was = car.airborne;
            if car.airborne {
                air += dt;
                peak_pitch = peak_pitch.max(car.air_pitch.abs());
            }
        }
        assert!(air > 0.35, "the jump lasted only {air:.2}s - it barely left the road");
        assert!(air < 1.35, "the jump hung for {air:.2}s, which is the moon");
        /* IT MUST SLOW DOWN IN THE AIR. Without drag the solver has nothing
           acting on a car with no wheel load, so it holds its launch speed
           exactly - which is the single clearest tell that a thing has no
           mass. */
        assert!(
            land_v < launch_v - 1.5,
            "the car left at {launch_v:.1} and landed at {land_v:.1}: nothing slowed it down"
        );
        // ...and the nose has to actually drop, rather than flying dead level
        assert!(
            peak_pitch > 0.06,
            "the body never pitched more than {peak_pitch:.3} rad - it flew flat"
        );
    }

    /* THE LINKS BEAT THE BODY TO IT.
     *
     * Every gram of load transfer used to be elastic: the body had to roll on
     * its springs before an outside tyre saw any extra load, and the roll mode
     * takes about a fifth of a second to get anywhere. The car turned in on
     * whatever grip it had at the instant the wheel moved, and the grip it was
     * going to have arrived afterwards.
     *
     * With the roll centres in, the part of the cornering force that acts
     * through them is fed to the tyre by the wishbones in the same instant the
     * force exists. Seventeen milliseconds after a step input - four sub-steps,
     * before the body has rolled a twentieth of a degree - the front axle is
     * already carrying three times the load split it used to.
     */
    #[test]
    fn the_links_carry_load_before_the_body_rolls() {
        let t = straight_track(20_000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 100.0, 0.0);
        car.v_long = 40.0;
        drive(&mut car, &t, 1.0, Input { throttle: 0.55, ..Default::default() });

        for _ in 0..4 {
            car.update(
                &t,
                1.0 / 240.0,
                Input { throttle: 0.55, steer: 1.0, ..Default::default() },
                true,
            );
        }
        let split = car.w[0].load - car.w[1].load;
        assert!(
            car.roll.abs() < 0.001,
            "the body has already rolled {:.4} rad - this is not the instant being tested",
            car.roll
        );
        assert!(
            split > 180.0,
            "seventeen milliseconds in, the front axle has moved only {split:.0} N across \
             while the body is still flat: the links are carrying nothing"
        );
    }

    /* A LANDING HAS TO BE CAUGHT BY THE CAR, NOT BY A CLAMP.
     *
     * `heave` is limited to the suspension's travel so the body cannot sink
     * through the floor, and before the bump stops existed a hard arrival went
     * straight to that limit and sat on it: the spring was linear all the way
     * down, ran out of rate, and the limiter took the rest. That is a collision
     * with a number, and it is why a big jump used to land dead.
     *
     * With a progressive stop the rate climbs as the square of how far into the
     * rubber the corner is, so the energy goes into force - which is load,
     * which is grip - instead of into travel. The same landing now stops a
     * third of the way down.
     */
    #[test]
    fn a_landing_is_caught_by_the_bump_stops() {
        let t = straight_track(4000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 400.0, 0.0);
        car.v_long = 72.0;
        car.arm_ramp(500.0, 546.0, 4.2);

        let (mut peak, mut lowest, mut after) = (0.0f64, 0.0f64, 0usize);
        for _ in 0..(12 * 240) {
            let air = car.airborne;
            car.update(&t, 1.0 / 240.0, Input { throttle: 1.0, ..Default::default() }, true);
            if air && !car.airborne {
                after = 1;
            }
            if after > 0 && after < 480 {
                after += 1;
                peak = peak.max(car.w.iter().map(|w| w.load).sum::<f64>());
                lowest = lowest.min(car.heave);
            }
        }
        assert!(after > 0, "the car never landed, so there is nothing to catch");
        assert!(
            lowest > -TRAVEL + 0.04,
            "the body went to {lowest:.4} against a travel limit of {TRAVEL}: \
             the landing was stopped by the clamp, not by the suspension"
        );
        assert!(
            peak > 4.5 * MASS * G,
            "the tyres never saw more than {:.1}g on touchdown - a landing has to have \
             weight in it",
            peak / (MASS * G)
        );
    }

    /* THE AERO BALANCE IS BEHIND THE CAR'S OWN.
     *
     * Static weight is 45% front. Downforce is 38%, so the faster the car goes
     * the further back its balance moves, and the axle that decides whether a
     * twitch at the top of sixth becomes a spin is the one gaining grip
     * fastest. At terminal speed there is no acceleration left to transfer
     * anything, so what is measured here is the aero split and nothing else.
     */
    #[test]
    fn downforce_is_biased_to_the_rear() {
        let t = straight_track(20_000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 100.0, 0.0);
        drive(&mut car, &t, 60.0, Input { throttle: 1.0, ..Default::default() });

        assert!(car.v_long > TOP_SPEED - 1.0, "it never got up to speed: {:.1}", car.v_long);
        /* The speed limiter pins the velocity at the ceiling but not the
           derivative, so a small positive figure survives here. It is worth
           about 160 N of rearward transfer against a 17,700 N total - a tenth
           of what the aero split is being asked to show. */
        assert!(
            car.accel_long.abs() < 1.5,
            "still accelerating hard at {:.2} m/s^2 - weight transfer would be measured, not aero",
            car.accel_long
        );
        let front = car.w[0].load + car.w[1].load;
        let rear = car.w[2].load + car.w[3].load;
        let share = front / (front + rear);
        assert!(
            share < 0.442,
            "at terminal speed the front axle still carries {:.1}% of the load; with a \
             rearward aero balance it has to be under 44.2%",
            share * 100.0
        );
        assert!(
            front + rear > MASS * G * 1.2,
            "there is no downforce here at all: {:.0} N against a {:.0} N car",
            front + rear,
            MASS * G
        );
    }

    /* THE AXLE IS TIED TOGETHER.
     *
     * On dry tarmac the tyres equalise the rear wheels by themselves - a wheel
     * that gets ahead builds slip ratio and the road pulls it straight back -
     * so an open diff and a locked one look the same. Take the grip away and
     * they stop looking the same at all: with nothing to react against, the
     * inner wheel lights up and takes its half of the torque into a wheelspin
     * the other side cannot do anything about.
     *
     * The measured peak difference across the rear axle on a slippery corner
     * exit was 68 rad/s open. The clutch pack holds it under two.
     */
    #[test]
    fn the_diff_ties_the_rear_axle_together() {
        let t = straight_track(20_000);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 100.0, 0.0);
        car.v_long = 18.0;

        let mut worst = 0.0f64;
        for _ in 0..(240 * 2) {
            // the surface is re-applied every step: `update` samples it fresh
            car.surface_grip = 0.55;
            car.update(
                &t,
                1.0 / 240.0,
                Input { throttle: 1.0, steer: 0.8, ..Default::default() },
                true,
            );
            worst = worst.max((car.w[2].omega - car.w[3].omega).abs());
        }
        assert!(
            worst < 6.0,
            "the rear wheels ran {worst:.1} rad/s apart on a slippery exit - the axle is open"
        );
        assert!(car.v_long > 4.0, "it never got out of the corner at all: {:.1}", car.v_long);
    }
}
