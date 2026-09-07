//! The rival driver, ported from `js/ai.js`.
//!
//! The AI does not cheat its way round the course. It drives a real
//! [`Vehicle`] - the same tyres, gearbox and collisions the player gets - by
//! producing the same five inputs a player produces. Everything it does has to
//! survive the physics, which is why it can be out-braked and why it can lose
//! the back end if it asks too much.
//!
//! The stack is the standard racing-AI one:
//!
//!   1. a racing line, relaxed toward minimum curvature inside the corridor
//!   2. a speed profile over it, with a backward pass that walks braking
//!      limits upstream - which is what creates real braking points
//!   3. pure-pursuit steering at a speed-dependent lookahead
//!   4. tactics: boost deployment, committed slides, overtaking, recovery
//!   5. dynamic competition balancing, bounded by difficulty, which nudges the
//!      driver's skill and never the car's performance
//!
//! # Randomness
//!
//! The JavaScript calls `Math.random()` for mistakes, slide errors and the
//! weaker drivers' boost. Those are *deliberately* non-deterministic - two
//! races against EASY should not play out identically - so this keeps a
//! per-driver [`Rng`] rather than trying to reproduce V8's stream. The course
//! and the racing line, which must be identical for everyone, use no
//! randomness at all.

use crate::math::{clamp, damp, Rng};
use crate::track::Track;
use crate::vehicle::{Input, Vehicle};

/// Lateral acceleration the car can actually hold, in world units per second
/// squared - measured off the model at about 1.2 g through a 0.733 m unit.
const GRIP_LAT: f64 = 1.22 * 9.81 / 0.733;
const BRAKE_A: f64 = 1.45 * 9.81 / 0.733;
const ACCEL_A: f64 = 0.42 * 9.81 / 0.733;

const WHEELBASE: f64 = 3.716;

/// A difficulty is a *driver*, not a car: skill, tyre, reaction, and how often
/// it gets one wrong. Nothing here touches the vehicle, which is why a rival
/// that beats you is a rival that drove better.
#[derive(Clone, Copy)]
pub struct Level {
    pub skill: f64,
    /// How far dynamic balancing may move that skill to keep the race close.
    pub assist: f64,
    /// Units it aims to sit ahead of (or behind) the player.
    pub target: f64,
    /// Fraction of the tyre it is willing to use.
    pub grip: f64,
    /// Seconds of reaction lag.
    pub react: f64,
    pub boost_skill: f64,
    pub drift_skill: f64,
    /// Chance per second of a small error.
    pub mistakes: f64,
}

/* THE LADDER, AND WHY IT IS SPACED THE WAY IT IS.
 *
 * `skill` is the number every pace term is built from, so the width of the
 * ladder is the width of this column. It used to run 0.72 / 0.90 / 0.97,
 * which sounds like a spread and is not: over two minutes of the shipped
 * course that came out as 71.1, 74.6 and 76.6 units per second - EASY within
 * eight per cent of HARD, and HARD within half a per cent of the R-IX. Three
 * difficulties that finish in the same second are one difficulty with three
 * labels on it.
 *
 * The reason the old numbers compressed is that most of this course is open
 * road, where corner grip does not apply and the only things that separate
 * two drivers are the straight-line pace they ask for and the margin they
 * leave. Both of those are driven off `skill`, so a narrow skill column is a
 * narrow ladder no matter what the other fields say.
 *
 * So the column is widened here, and the two terms it feeds are widened with
 * it (see `reset_state` and the margin in `drive`). What each rung is FOR:
 *
 *   EASY    a car to follow. Visibly imperfect - brakes early, rarely commits
 *           to a slide, spends the reserve in the wrong places, and gets one
 *           wrong often enough to be caught. The assist is generous, so it
 *           waits for a player who is a long way back.
 *   MEDIUM  a car to chase. Competent and close; small errors, not gifts.
 *   HARD    a car that knows the line. Clean, quick, and it does not wait.
 */
pub const EASY: Level = Level {
    skill: 0.58, assist: 0.30, target: -55.0, grip: 0.80, react: 0.28,
    boost_skill: 0.40, drift_skill: 0.25, mistakes: 0.035,
};
pub const MEDIUM: Level = Level {
    skill: 0.82, assist: 0.16, target: 15.0, grip: 0.90, react: 0.14,
    boost_skill: 0.82, drift_skill: 0.58, mistakes: 0.008,
};
pub const HARD: Level = Level {
    // Not 1.0 grip: a driver at the absolute limit has no margin for a bump, a
    // kerb or a rival's line, and spends the race in the barrier - which is
    // slower, not faster.
    skill: 0.95, assist: 0.07, target: 60.0, grip: 0.962, react: 0.075,
    boost_skill: 1.0, drift_skill: 0.80, mistakes: 0.0,
};
/// The profile Chapter 7's R-IX drives on. No assist either way, no mistakes
/// ever, and it means to be a hundred and forty units up the road.
pub const IMPOSSIBLE: Level = Level {
    skill: 1.0, assist: 0.0, target: 140.0, grip: 0.982, react: 0.055,
    boost_skill: 1.0, drift_skill: 0.95, mistakes: 0.0,
};

pub fn level_by_name(name: &str) -> Level {
    match name {
        "EASY" => EASY,
        "HARD" => HARD,
        "IMPOSSIBLE" => IMPOSSIBLE,
        _ => MEDIUM,
    }
}

/// Story-mode racecraft. These are small choices at the controller output, not
/// changes to the car: Ryker attacks a gap, Kael rotates and burns boost in
/// questionable places, Nova refuses to waste either on an unsettled chassis.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Personality {
    None,
    Ryker,
    Kael,
    Nova,
    /// The R-IX. It shuts the gap the player is moving toward before they
    /// reach it, because two samples of their lateral is a velocity.
    Predator,
}

// ------------------------------------------------------------ racing line ---

/// The racing line, stored as a lateral offset from the centreline at each
/// sample, so it inherits the centreline's arc-length parameterisation.
///
/// Every array here is `f32`, matching the `Float32Array`s the JavaScript used.
/// That is not a memory saving - at 28,900 samples it is worth a quarter of a
/// megabyte - it is fidelity. The relaxation runs 260 passes over these values
/// and rounds each one to `f32` on every store, so holding them at `f64`
/// converges to a measurably different line; and because the speed profile
/// reads `1/sqrt(curvature)` off the result, a difference of 1e-5 in curvature
/// comes out as half a unit per second of corner speed.
pub struct RacingLine {
    pub off: Vec<f32>,
    pub curv: Vec<f32>,
    pub px: Vec<f32>,
    pub pz: Vec<f32>,
    pub step: f64,
    pub count: usize,
}

impl RacingLine {
    /// Relax toward minimum curvature inside the corridor.
    ///
    /// At each pass every point is nudged along its own lateral axis in the
    /// direction that straightens the path through it, then clamped back
    /// inside the road. Run enough times, that is exactly the geometric racing
    /// line - wide in, apex, wide out - without anyone having to say which way
    /// the corner goes.
    pub fn build(track: &Track, half_width: f64) -> RacingLine {
        let c = &track.c;
        let n = c.count;
        let lim = half_width as f32;
        let mut off = vec![0.0f32; n];
        let mut rx = vec![0.0f32; n];
        let mut rz = vec![0.0f32; n];
        for i in 0..n {
            rx[i] = c.yaw[i].cos() as f32;
            rz[i] = -c.yaw[i].sin() as f32;
        }

        // Arithmetic in f64, stored back to f32 - which is exactly what reading
        // from and assigning to a `Float32Array` does.
        let mut px = vec![0.0f32; n];
        let mut pz = vec![0.0f32; n];
        let liml = lim as f64;
        for _ in 0..260 {
            for i in 0..n {
                px[i] = (c.x[i] + rx[i] as f64 * off[i] as f64) as f32;
                pz[i] = (c.z[i] + rz[i] as f64 * off[i] as f64) as f32;
            }
            for i in 1..n - 1 {
                // second difference: which way this point bulges out of the path
                let dx = px[i - 1] as f64 - 2.0 * px[i] as f64 + px[i + 1] as f64;
                let dz = pz[i - 1] as f64 - 2.0 * pz[i] as f64 + pz[i + 1] as f64;
                let step = (dx * rx[i] as f64 + dz * rz[i] as f64) * 0.34;
                off[i] = clamp(off[i] as f64 + step, -liml, liml) as f32;
            }
        }

        // curvature of the finished line, for the speed profile
        let mut curv = vec![0.0f32; n];
        for i in 0..n {
            px[i] = (c.x[i] + rx[i] as f64 * off[i] as f64) as f32;
            pz[i] = (c.z[i] + rz[i] as f64 * off[i] as f64) as f32;
        }
        for i in 1..n - 1 {
            let ax = px[i] as f64 - px[i - 1] as f64;
            let az = pz[i] as f64 - pz[i - 1] as f64;
            let bx = px[i + 1] as f64 - px[i] as f64;
            let bz = pz[i + 1] as f64 - pz[i] as f64;
            let la = ax.hypot(az);
            let lb = bx.hypot(bz);
            if la < 1e-4 || lb < 1e-4 {
                continue;
            }
            let mut d = bz.atan2(bx) - az.atan2(ax);
            while d > core::f64::consts::PI {
                d -= core::f64::consts::TAU;
            }
            while d < -core::f64::consts::PI {
                d += core::f64::consts::TAU;
            }
            curv[i] = (d.abs() / (0.5 * (la + lb))) as f32;
        }
        if n >= 2 {
            curv[0] = curv[1];
            curv[n - 1] = curv[n - 2];
        }

        // light smoothing, or a single noisy sample plants a phantom hairpin
        let mut sm = vec![0.0f32; n];
        for i in 0..n {
            let mut acc = 0.0f32;
            let mut w = 0.0f32;
            for k in -3i64..=3 {
                let j = i as i64 + k;
                if j < 0 || j >= n as i64 {
                    continue;
                }
                acc += curv[j as usize];
                w += 1.0;
            }
            sm[i] = acc / w;
        }

        RacingLine { off, curv: sm, px, pz, step: c.step, count: n }
    }
}

/// The speed profile.
///
/// Grip-limited speed everywhere, then a backward pass so every point is also
/// slow enough to have braked down to whatever comes next, and a forward pass
/// so it is not faster than the engine could have got it there. The backward
/// pass is what creates braking points: the AI lifts because a corner some
/// distance ahead is not takeable at this speed, not because a trigger volume
/// told it to.
pub fn build_profile(line: &RacingLine, grip_frac: f64, top_speed: f64) -> Vec<f32> {
    let n = line.count;
    let ds = line.step;
    let mut v = vec![0.0f32; n];
    let a_lat = GRIP_LAT * grip_frac;
    for i in 0..n {
        let k = (line.curv[i] as f64).max(1e-6);
        v[i] = top_speed.min((a_lat / k).sqrt()) as f32;
    }
    let a_b = BRAKE_A * grip_frac;
    for i in (0..n.saturating_sub(1)).rev() {
        let next = v[i + 1] as f64;
        v[i] = (v[i] as f64).min((next * next + 2.0 * a_b * ds).sqrt()) as f32;
    }
    let a_a = ACCEL_A * grip_frac;
    for i in 1..n {
        let prev = v[i - 1] as f64;
        v[i] = (v[i] as f64).min((prev * prev + 2.0 * a_a * ds).sqrt()) as f32;
    }
    v
}

// ----------------------------------------------------------------- driver ---

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DriftState {
    None,
    Entry,
    Hold,
    Exit,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DriftErr {
    None,
    Bail,
    Late,
    Over,
}

struct Drift {
    state: DriftState,
    t: f64,
    dir: f64,
    target: f64,
    blend: f64,
    err: DriftErr,
    entry_delay: f64,
    bail_at: f64,
    cool: f64,
    shaken: f64,
}

/// What the driver is told about the race it is in.
#[derive(Clone, Copy, Default)]
pub struct WorldView {
    pub race_on: bool,
    pub has_rival: bool,
    pub rival_s: f64,
    pub rival_x: f64,
    pub rival_z: f64,
    pub finish_at: f64,
}

pub struct Driver {
    pub cfg: Level,
    pub skill: f64,
    pub personality: Personality,
    lag_steer: f64,
    mistake: f64,
    mistake_timer: f64,
    boost_hold: f64,
    avoid: f64,
    /// Which side of the car ahead this driver has committed to going round,
    /// or 0 for "no pass in progress". Held for the whole move; see the note
    /// in `drive`. Without it the side is re-decided every frame and the car
    /// chatters between the two edges of the road.
    pass_side: f64,
    /* THERE IS NO SHOULDER, AND THERE IS NO `ram`.
     *
     * A previous version let a director hand this driver an absolute lateral
     * to drive AT - the player's - so the R-IX could lean on them rather than
     * go round. It is gone. The reason is worth keeping written down, because
     * the obvious fix is the one that was already tried and does not work.
     *
     * The first attempt wrote the overtaking controller's own `avoid` from the
     * personality block, a frame after that value had already been consumed:
     * two controllers owning one number, one pulling it toward zero and the
     * other pushing it at the player. Giving the shoulder its own term,
     * resolved before the line is built, fixed that ownership fight - and the
     * car still weaved, because the ownership was never the real fault. The
     * FRAME was.
     *
     * The shove was computed as `player_lateral - own_lateral`: a correction
     * relative to where the car is NOW. But every term added to `bias` is an
     * offset from the RACING LINE at the lookahead point. So the error nulled
     * itself. Aim at the player; reach the player; the error goes to zero, so
     * the bias goes to zero, so the aim point snaps back to the racing line,
     * so the car steers away from the player - and the error is full-sized
     * again. A self-nulling error expressed in the wrong frame is a limit
     * cycle, and no damping constant removes one; it only sets the period.
     * That is the left-right-left dash, and it is why it appeared only after
     * the cars had been near each other for a while.
     *
     * Re-expressing it in the line's frame would stop the oscillation and
     * leave a car that steers into another car on purpose, which the collision
     * resolver and the recovery controller then spend the rest of the race
     * fighting each other over. So the behaviour is removed rather than
     * re-tuned. The R-IX is frightening because it drives well; it does not
     * need to drive into anybody.
     */
    stuck: f64,
    lane_bias: f64,
    /// Multiplies the STRAIGHT-LINE speed this driver asks for. An AI never
    /// approaches its car's cap - its target comes from the profile - so
    /// raising the vehicle's ceiling alone does nothing at all.
    pub pace_scale: f64,
    tow: f64,
    /// How much more grip the car actually has. Corner speed goes with the
    /// *square root* of grip, so this and `pace_scale` are two different
    /// numbers, and conflating them is what drives a fast AI into a wall.
    pub grip_scale: f64,
    pub last_target: f64,
    /// Set by a level director: given the arc length being aimed at, the
    /// lateral the driver should be on to get through whatever is standing
    /// there. `None` means the road is open and the racing line stands.
    pub lane_hint: Option<f64>,
    drift: Drift,
    profile: Vec<f32>,
    profile_top: f64,
    rng: Rng,
}

#[derive(Clone, Copy, Default)]
struct LineSample {
    x: f64,
    z: f64,
    v: f64,
    curv: f64,
}

impl Driver {
    pub fn new(level: Level, seed: u32) -> Self {
        let mut d = Driver {
            cfg: level,
            skill: level.skill,
            personality: Personality::None,
            lag_steer: 0.0,
            mistake: 0.0,
            mistake_timer: 0.0,
            boost_hold: 0.0,
            avoid: 0.0,
            pass_side: 0.0,
            stuck: 0.0,
            lane_bias: 0.0,
            pace_scale: 1.0,
            tow: 0.0,
            grip_scale: 1.0,
            last_target: 0.0,
            lane_hint: None,
            drift: Drift {
                state: DriftState::None, t: 0.0, dir: 1.0, target: 0.0, blend: 0.0,
                err: DriftErr::None, entry_delay: 0.0, bail_at: 99.0, cool: 0.0, shaken: 0.0,
            },
            profile: Vec::new(),
            profile_top: 80.6,
            rng: Rng::new(seed | 1),
        };
        d.reset_state();
        d
    }

    /// Commit the driver to the reserve for `secs`, as a director does when
    /// handing control back out of a scripted beat.
    pub fn set_boost_hold(&mut self, secs: f64) {
        self.boost_hold = self.boost_hold.max(secs);
    }

    pub fn set_level(&mut self, level: Level) {
        self.cfg = level;
        self.reset_state();
    }

    fn reset_state(&mut self) {
        self.skill = self.cfg.skill;
        self.lag_steer = 0.0;
        self.mistake = 0.0;
        self.mistake_timer = 0.0;
        self.boost_hold = 0.0;
        self.avoid = 0.0;
        self.pass_side = 0.0;
        self.stuck = 0.0;
        self.lane_bias = 0.0;
        self.pace_scale = 1.0;
        self.tow = 0.0;
        self.grip_scale = 1.0;
        self.drift = Drift {
            state: DriftState::None, t: 0.0, dir: 1.0, target: 0.0, blend: 0.0,
            err: DriftErr::None, entry_delay: 0.0, bail_at: 99.0, cool: 0.0, shaken: 0.0,
        };
        // 0.80 + 0.20, not 0.90 + 0.10: this is the straight-line pace, and
        // on an open course it is most of the difference between two drivers.
        // See the note on the ladder.
        self.profile_top = 80.6 * (0.80 + 0.20 * self.skill);
    }

    /// The profile depends on this driver's own skill, so it is built once the
    /// level is known and rebuilt whenever it changes.
    pub fn build_profile_for(&mut self, line: &RacingLine) {
        self.profile_top = 80.6 * (0.80 + 0.20 * self.skill);
        self.profile =
            build_profile(line, self.cfg.grip * (0.86 + 0.14 * self.skill), self.profile_top);
    }

    fn line_at(&self, line: &RacingLine, s: f64) -> LineSample {
        let f = clamp(s / line.step, 0.0, line.count as f64 - 1.001);
        let i = f as usize;
        let t = f - i as f64;
        let j = (line.count - 1).min(i + 1);
        LineSample {
            x: line.px[i] as f64 + (line.px[j] as f64 - line.px[i] as f64) * t,
            z: line.pz[i] as f64 + (line.pz[j] as f64 - line.pz[i] as f64) * t,
            v: self.profile[i] as f64 + (self.profile[j] as f64 - self.profile[i] as f64) * t,
            curv: line.curv[i] as f64 + (line.curv[j] as f64 - line.curv[i] as f64) * t,
        }
    }

    /// Produce one frame of driver input.
    pub fn drive(
        &mut self,
        dt: f64,
        car: &Vehicle,
        track: &Track,
        line: &RacingLine,
        world: &WorldView,
    ) -> Input {
        if self.profile.len() != line.count {
            self.build_profile_for(line);
        }
        let cfg = self.cfg;
        let s = car.s_track;

        // ---- dynamic competition balancing --------------------------------
        // Skill is nudged toward a positional target, bounded by the
        // difficulty's assist allowance. The car is never touched: a rival that
        // gains its pace from a bigger engine stops feeling like a driver.
        if world.race_on && world.has_rival {
            let gap = s - world.rival_s; // + means the AI leads
            let want = clamp((cfg.target - gap) / 260.0, -1.0, 1.0);
            self.skill = damp(
                self.skill,
                clamp(cfg.skill + want * cfg.assist, 0.25, 1.0),
                0.35,
                dt,
            );
        }

        // ---- where the line wants the car to be ---------------------------
        let speed = car.v_long.max(2.0);
        // lookahead grows with speed: far enough ahead to plan, near enough to
        // still be a corner and not the one after it
        let look = 14.0 + speed * (0.55 + 0.35 * self.skill);
        let aim = self.line_at(line, s + look);
        let here = self.line_at(line, s + 4.0);

        // ---- the slide ----------------------------------------------------
        // A rival that only ever turns the wheel understeers through every
        // corner, and what that reads as from the other car is not a driver
        // being careful, it is a slower car. This is a real slide, committed to
        // before the corner arrives: entry on the handbrake, hold on the
        // throttle against a counter-steer target rather than against zero -
        // which is the whole difference between holding a drift and catching
        // one - then exit walked back to zero as the corner opens.
        let track_at = |d: f64| track.at(clamp(s + d, 0.0, track.length - 3.0));
        let mut peak_c = 0.0f64;
        let scan = clamp(14.0 + speed * 1.25, 26.0, 190.0);
        let mut d = 6.0;
        while d < scan {
            let c = track_at(d).curv;
            if c.abs() > peak_c.abs() {
                peak_c = c;
            }
            d += 8.0;
        }
        let mut turn = track_at(scan).yaw - track_at(4.0).yaw;
        while turn > core::f64::consts::PI {
            turn -= core::f64::consts::TAU;
        }
        while turn < -core::f64::consts::PI {
            turn += core::f64::consts::TAU;
        }
        // How far past the tyre the corner is. Above 1.0, rotating the car is
        // the quicker way round it and a good driver knows that.
        let demand = peak_c.abs() * speed * speed / (GRIP_LAT * cfg.grip).max(1.0);
        let corner_dir = if turn >= 0.0 { 1.0 } else { -1.0 };
        let slip = car.body_slip;

        self.drift.cool = (self.drift.cool - dt).max(0.0);
        self.drift.shaken = (self.drift.shaken - dt).max(0.0);
        if self.drift.state == DriftState::None {
            // Chasing makes a driver braver, leading makes it tidy: the same
            // rival slides more corners coming back at you than defending.
            let chasing = world.race_on && world.has_rival && (world.rival_s - s) > 25.0;
            let appetite = cfg.drift_skill
                * (if chasing { 1.22 } else { 1.0 })
                * (if self.drift.shaken > 0.0 { 0.35 } else { 1.0 });
            // The gate is the corner's RADIUS. A slide is what you do about a
            // corner too tight to steer through, and that is a property of the
            // road - gating on `demand` made the clumsiest car slide the most.
            let gate = 0.0172 - appetite * 0.0085;
            if peak_c.abs() > gate
                && speed > 18.0
                && self.drift.cool <= 0.0
                && car.v_long < aim.v * 1.45
                && demand > 0.55
            {
                self.drift.state = DriftState::Entry;
                self.drift.t = 0.0;
                self.drift.dir = corner_dir;
                self.drift.blend = 0.0;
                self.drift.target = corner_dir
                    * clamp(0.17 + demand * 0.18, 0.15, 0.44)
                    * (0.55 + 0.45 * cfg.drift_skill);
                self.drift.err = DriftErr::None;
                self.drift.entry_delay = 0.0;
                self.drift.bail_at = 99.0;
                // Whether THIS one goes wrong, weighted toward the cheap end:
                // over-rotating every corner would put a low-skill rival in
                // the barrier every corner, which is not catchable.
                if self.rng.next() < (1.0 - cfg.drift_skill) * 0.34 {
                    let roll = self.rng.next();
                    if roll < 0.50 {
                        self.drift.err = DriftErr::Bail;
                        self.drift.bail_at = 0.26 + self.rng.next() * 0.40;
                    } else if roll < 0.82 {
                        self.drift.err = DriftErr::Late;
                        self.drift.entry_delay = 0.16 + self.rng.next() * 0.20;
                    } else {
                        self.drift.err = DriftErr::Over;
                        self.drift.target *= 1.24 + self.rng.next() * 0.30;
                    }
                }
            }
        } else {
            self.drift.t += dt;
            // Spin guard: any slide past the angle the car can be recovered
            // from is abandoned on the spot, or one bad commitment ends the
            // rival's race.
            if slip.abs() > 0.78 || (car.v_long < 8.0 && self.drift.t > 0.6) {
                self.drift.state = DriftState::Exit;
                self.drift.t = 0.5;
                self.drift.err = DriftErr::Over;
                self.drift.blend = 0.0;
            }
            let opening = peak_c.abs() < 0.0045 || demand < 0.52;
            match self.drift.state {
                DriftState::Entry => {
                    // the rear is out far enough, or the corner ran out first
                    if slip.abs() > self.drift.target.abs() * 0.72
                        || self.drift.t > 1.1 + self.drift.entry_delay
                    {
                        self.drift.state = DriftState::Hold;
                        self.drift.t = 0.0;
                    }
                }
                DriftState::Hold => {
                    if opening || self.drift.t > self.drift.bail_at || self.drift.t > 1.9 {
                        self.drift.state = DriftState::Exit;
                        self.drift.t = 0.0;
                    }
                }
                DriftState::Exit => {
                    if self.drift.t > 0.55 || slip.abs() < 0.07 {
                        self.drift.state = DriftState::None;
                        self.drift.blend = 0.0;
                        // a mistake costs composure for a moment, so the next
                        // corner is taken flat rather than compounding it
                        self.drift.cool = if self.drift.err == DriftErr::None {
                            0.65 + self.rng.next() * 0.55
                        } else {
                            1.1 + self.rng.next() * 0.8
                        };
                        if self.drift.err != DriftErr::None {
                            self.drift.shaken = 1.6;
                        }
                        self.drift.err = DriftErr::None;
                    }
                }
                DriftState::None => {}
            }
            let want_blend = if self.drift.state == DriftState::Exit { 0.0 } else { 1.0 };
            self.drift.blend = damp(
                self.drift.blend,
                want_blend,
                if self.drift.state == DriftState::Exit { 4.5 } else { 7.0 },
                dt,
            );
        }
        // Only HOLD and EXIT steer to an angle. During entry the handbrake
        // makes the slide and the steering stays on pure pursuit - commanding
        // the target through the wheel too put an extra 0.4 rad of lock in at
        // the exact moment the rear let go, which is a spin.
        let slip_target = if matches!(self.drift.state, DriftState::Hold | DriftState::Exit) {
            self.drift.target * self.drift.blend
        } else {
            0.0
        };

        // ---- overtaking and avoidance -------------------------------------
        /* A PASS IS A DECISION, NOT A PER-FRAME OPINION.
         *
         * This used to choose a side every frame from `sign(their lateral)`
         * and damp toward it. Two consequences, and both were visible on the
         * road:
         *
         *   - a car being followed anywhere near the centreline flips that
         *     sign every time it drifts across, so the target snapped between
         *     the two edges of the road and the chasing car chattered between
         *     them at whatever rate the car in front wandered;
         *   - the 55-unit gate is a single threshold, so a rival hovering on
         *     it had the whole offset switched on and off at frame rate.
         *
         * A controller whose set point is the sign of a moving quantity is a
         * bang-bang controller, and bang-bang controllers chatter. That is a
         * property of the shape, not of the gain, so it is fixed by changing
         * the shape: the side is chosen ONCE, when the move begins, and held
         * until the move is over - through them, or dropped far enough back
         * that there is no move on. Capture and release distances differ, so
         * a rival sitting exactly on the boundary cannot toggle it.
         *
         * Inside a dead band around the centreline the sign of their lateral
         * carries no information, so the tie is broken by which side this car
         * is already on - the shorter move, and the one already committed to.
         */
        let mut bias;
        if world.has_rival {
            let ahead = world.rival_s - s;
            // Only look where a pass could be happening. Outside that the
            // projection is wasted work and the answer is always "go back to
            // the line".
            if self.pass_side != 0.0 && (ahead < -6.0 || ahead > 70.0) {
                self.pass_side = 0.0; // through them, or dropped: the move is over
            }
            if self.pass_side != 0.0 || (ahead > 0.0 && ahead < 55.0) {
                let p = track.project(world.rival_x, world.rival_z, world.rival_s);
                let mine = track.project(car.x, car.z, s);
                // How far sideways an overtake actually is. Most of the road
                // asks a car doing a hundred units a second to move
                // twenty-five sideways, and that is not a move, it is a spin.
                // Three car widths is a lane change and is all this needs.
                let room = (track.half_width * 0.85).min(8.5);
                if self.pass_side == 0.0 {
                    let lean = mine.lateral - p.lateral;
                    let mut side = if p.lateral.abs() > 1.5 {
                        // go round the side they are not on
                        if p.lateral > 0.0 { -1.0 } else { 1.0 }
                    } else if lean.abs() > 0.4 {
                        // ...or, if that tells us nothing, the way we lean
                        if lean > 0.0 { 1.0 } else { -1.0 }
                    } else {
                        1.0
                    };
                    // ...and never into a barrier. If the chosen side has no
                    // road left to move into, the pass goes the other way.
                    if (p.lateral + side * room).abs() > track.half_width - 2.6 {
                        side = -side;
                    }
                    self.pass_side = side;
                }
                // Urgency ramps in over the gap rather than switching on at
                // it, and is clamped so the capture edge is not a step.
                let urgency = clamp((55.0 - ahead) / 55.0, 0.0, 1.0);
                // Alongside already: hold the full width and hold it briskly,
                // because this is the moment the two cars are closest.
                let alongside = (mine.lateral - p.lateral).abs() < 3.2 && ahead < 9.0;
                let want = self.pass_side
                    * room
                    * if alongside { 1.0 } else { urgency * (0.55 + 0.45 * self.skill) };
                self.avoid = damp(self.avoid, want, if alongside { 6.0 } else { 3.0 }, dt);
                // NO DEFENSIVE LINE. Both shapes of it were tried and both are
                // positive feedback: the leader reads a car sitting in its own
                // mirror, moves over, reads it again from the new position, and
                // walks itself into the barrier.
            } else {
                self.avoid = damp(self.avoid, 0.0, 1.6, dt);
            }
        } else if self.pass_side != 0.0 {
            self.pass_side = 0.0;
        }
        bias = self.avoid;

        // Hard obstacles. The hint is an ABSOLUTE lateral, so it is taken
        // against wherever the racing line happens to be rather than added to
        // it - the line is not the centre of the road, and a gap eight units
        // left of centre is not eight units left of the line.
        match self.lane_hint {
            None => self.lane_bias = damp(self.lane_bias, 0.0, 2.0, dt),
            Some(want) => {
                let lp = track.project(aim.x, aim.z, s + look);
                let need = clamp(want - lp.lateral, -track.half_width, track.half_width);
                // commit briskly: a gap arrives quickly and half a lane is a strike
                self.lane_bias = damp(self.lane_bias, need, 3.2, dt);
            }
        }
        if self.lane_bias.abs() > 0.05 {
            bias += self.lane_bias;
        }

        // ...and never off the road. Both terms above are offsets from the
        // RACING LINE, which on a corner exit is already against the outside
        // edge - so adding a full half-width of avoidance aims the car past
        // the barrier. Clamped in ABSOLUTE lateral terms against the same
        // corridor the physics uses.
        {
            let lp = track.project(aim.x, aim.z, s + look);
            let edge = track.half_width - 2.6;
            bias = clamp(lp.lateral + bias, -edge, edge) - lp.lateral;
        }

        let ap = track.at(s + look);
        let arx = ap.yaw.cos();
        let arz = -ap.yaw.sin();
        let tx = aim.x + arx * bias;
        let tz = aim.z + arz * bias;

        // ---- steering: pure pursuit ---------------------------------------
        // delta = atan(2 L sin(alpha) / d). Stable, needs no tuning per corner,
        // and produces the smooth entry-apex-exit arc a hand-written
        // proportional controller never quite manages.
        let dx = tx - car.x;
        let dz = tz - car.z;
        let dist = dx.hypot(dz).max(1.0);
        let mut alpha = dx.atan2(dz) - car.yaw;
        while alpha > core::f64::consts::PI {
            alpha -= core::f64::consts::TAU;
        }
        while alpha < -core::f64::consts::PI {
            alpha += core::f64::consts::TAU;
        }
        let mut delta = (2.0 * WHEELBASE * alpha.sin()).atan2(dist);

        // Counter-steer against a TARGET rather than against zero. When the
        // driver is not drifting the target is zero and this is the ordinary
        // save-it behaviour; when it is drifting the target is the angle it
        // committed to, and the same arithmetic becomes what HOLDS the slide.
        let slip_err = slip - slip_target;
        let catch_gain = 0.62 + 0.55 * self.skill;
        if slip_err.abs() > 0.055 {
            delta -= clamp(slip_err * catch_gain, -0.34, 0.34);
        }
        if self.drift.err == DriftErr::Over && self.drift.state != DriftState::None {
            delta -= slip_err * 0.35 * (1.0 - cfg.drift_skill);
        }

        // the vehicle takes -1..1 against its own speed-dependent lock
        let v2 = (car.v_long * car.v_long).max(1.0);
        let lock = (30.0f64 * core::f64::consts::PI / 180.0).min(WHEELBASE * 27.4 / v2);
        let mut steer = clamp(delta / lock.max(0.02), -1.0, 1.0);

        // ---- speed: brake for what is coming, not for what is here ---------
        // The profile is `min(topSpeed, sqrt(grip/curvature))`. Where the top
        // speed limits it the road is open and terminal speed applies; where
        // curvature limits it, only extra grip does - and that goes with the
        // square root. Scaling both by the same number silently negates
        // itself, because the braking scan clamps back to the unscaled envelope.
        let corner_scale = self.grip_scale.max(1.0).sqrt();
        // How open this road is, as a ramp rather than a switch, so a route
        // with no true straights still gets some of the pace asked for.
        let openness = clamp((aim.v / self.profile_top - 0.90) / 0.10, 0.0, 1.0);
        let scale = corner_scale.max(corner_scale + (self.pace_scale - corner_scale) * openness);
        let mut target = aim.v.min(here.v) * scale;
        // scan the braking window explicitly, so a corner appearing between
        // the two samples is not missed
        let braking = BRAKE_A * cfg.grip * self.grip_scale.max(1.0);
        let brake_dist = (car.v_long * car.v_long) / (2.0 * braking) + 20.0;
        let mut d = 12.0;
        while d < brake_dist {
            let q = self.line_at(line, s + d);
            let able = (q.v * q.v * corner_scale * corner_scale + 2.0 * braking * d).sqrt();
            target = target.min(able);
            d += 14.0;
        }
        // Less skilled drivers leave more margin and react late. Widened with
        // the ladder: this and `profile_top` are the two terms that actually
        // separate difficulties on open road.
        target *= 0.78 + 0.22 * self.skill;
        // angle costs grip, so a car mid-slide is asking for a speed it cannot
        // hold unless the target comes back with it
        if self.drift.state != DriftState::None {
            target *= 1.0 - (0.26f64).min(slip_target.abs() * 0.42);
        }

        // ---- the tow -------------------------------------------------------
        // Close behind and roughly in line, a car is running in the hole the
        // one in front punched in the air. Worth a few per cent on a straight
        // and nothing through a corner, and it is what makes a chase STICK.
        if world.has_rival {
            let behind = world.rival_s - s;
            if behind > 3.0 && behind < 42.0 {
                let mine = track.project(car.x, car.z, s);
                let them = track.project(world.rival_x, world.rival_z, world.rival_s);
                let off = (mine.lateral - them.lateral).abs();
                if off < 6.5 {
                    self.tow = damp(
                        self.tow,
                        (1.0 - behind / 42.0) * (1.0 - off / 6.5) * 0.06 * (0.5 + 0.5 * self.skill),
                        3.0,
                        dt,
                    );
                } else {
                    self.tow = damp(self.tow, 0.0, 3.0, dt);
                }
            } else {
                self.tow = damp(self.tow, 0.0, 2.0, dt);
            }
            // only where the road is open: there is no tow through a corner
            target *= 1.0 + self.tow * clamp((aim.v - 48.0) / 26.0, 0.0, 1.0);
        }

        self.last_target = target;
        let err = target - car.v_long;
        let mut throttle;
        let mut brake = 0.0;
        if err > 0.6 {
            throttle = clamp(err * 0.35, 0.0, 1.0);
        } else if err < -0.4 {
            throttle = 0.0;
            brake = clamp(-err * 0.28, 0.0, 1.0);
        } else {
            throttle = 0.35;
        }

        // ---- driving the slide ---------------------------------------------
        // The handbrake only sets the angle. Everything after that is
        // throttle: a slide is held by keeping the rear at the edge of grip,
        // and letting off is how it is ended.
        let tight = aim.curv > 0.013 && car.v_long > 20.0 && car.v_long > aim.v * 1.06;
        let mut ebrake = false;
        match self.drift.state {
            DriftState::Entry => {
                ebrake = self.drift.t >= self.drift.entry_delay;
                throttle = (throttle * 0.5).max(0.42);
                brake = 0.0;
            }
            DriftState::Hold => {
                // modulate against the angle: too little, feed it; too much, ease
                let over = (slip - slip_target) * self.drift.dir;
                throttle = clamp(0.70 - over * 1.8, 0.14, 1.0);
                brake = 0.0;
                // A slide is not a substitute for braking. If the corner still
                // needs a lot of speed taking out, the brake comes back and the
                // angle is carried on trail brake instead of on throttle.
                if err < -8.0 {
                    brake = clamp(-err * 0.10, 0.0, 0.55);
                    throttle = 0.0;
                }
                // a clumsy driver keeps stabbing the handbrake and scrubs the exit
                if self.drift.err == DriftErr::Over
                    && self.rng.next() < (1.0 - cfg.drift_skill) * dt * 2.2
                {
                    ebrake = true;
                }
            }
            DriftState::Exit => {
                throttle = throttle.max(0.55 + 0.35 * cfg.drift_skill);
                brake = 0.0;
            }
            DriftState::None => {}
        }

        // ---- boost ----------------------------------------------------------
        // Measured, not rolled. Throwing dice every frame put the reserve down
        // in the wrong place on average: boost into a corner and the car
        // arrives too fast, brakes, and hands the time straight back. This asks
        // how much open road is actually in front and commits to the length of
        // it.
        let mut boost = false;
        if world.race_on {
            // "Open" is relative to what the car is already doing: on a route
            // whose profile never reaches eighty, a fixed threshold reads every
            // straight as a corner and the reserve is never spent at all.
            let hold = (car.v_long * 0.88).max(50.0);
            let mut open = 0.0;
            let mut d = 24.0;
            while d < 460.0 {
                if self.line_at(line, s + d).v < hold {
                    break;
                }
                open = d;
                d += 24.0;
            }
            let gap = if world.has_rival { world.rival_s - s } else { 0.0 };
            let attacking = gap > 4.0 && gap < 70.0; // in the tow, with a pass on
            let dropped = gap > 110.0;
            let worth = open > 165.0 - 85.0 * cfg.boost_skill;
            let armed = car.boost > (if attacking { 0.10 } else { 0.32 - 0.14 * cfg.boost_skill });
            if self.boost_hold <= 0.0 && armed && car.v_long > 24.0 && (worth || attacking || dropped)
            {
                let judge = 0.40 + 0.60 * cfg.boost_skill;
                self.boost_hold = (0.45f64).max((open / car.v_long.max(24.0)) * judge);
            }
            // lifts before the corner rather than in it
            if self.boost_hold > 0.0 && open < 70.0 {
                self.boost_hold = 0.0;
            }
            // ...and the weaker driver still spends it in the wrong places
            if cfg.boost_skill < 0.5 && self.boost_hold <= 0.0 && self.rng.next() < dt * 0.30 {
                self.boost_hold = 0.45;
            }
        }
        if self.boost_hold > 0.0 {
            self.boost_hold -= dt;
            boost = car.boost > 0.05;
        }

        // ---- mistakes --------------------------------------------------------
        self.mistake_timer -= dt;
        if cfg.mistakes > 0.0
            && self.mistake_timer <= 0.0
            && self.rng.next() < cfg.mistakes * dt * 60.0
        {
            self.mistake = 0.5 + self.rng.next() * 0.8;
            self.mistake_timer = 4.0;
        }
        if self.mistake > 0.0 {
            self.mistake -= dt;
            steer += (self.rng.next() - 0.5) * 0.5;
            throttle *= 0.55;
        }

        // ---- recovery ---------------------------------------------------------
        // Out of control is: off the road, and going nowhere near the speed
        // this driver has just decided it should be doing here. Counting only a
        // car that has STOPPED misses the one sliding from barrier to barrier
        // at thirty units a second, which is exactly what a badly upset
        // high-grip driver does.
        let pr = track.project(car.x, car.z, s);
        let off_road = pr.lateral.abs() > track.half_width * 0.92;
        let way_down = car.v_long < (11.0f64).max(self.last_target * 0.45);
        if (car.speed < 4.0 || (off_road && way_down)) && world.race_on {
            self.stuck += dt;
        } else {
            self.stuck = (self.stuck - dt * 2.5).max(0.0);
        }
        if self.stuck > 0.9 {
            // Back out of it aimed at the road rather than flailing. Reversing
            // with lock on rotates the nose the opposite way, so the steer sign
            // that straightens the car is the sign of its heading error - and
            // the manoeuvre ends when it is pointing down the track again
            // rather than after a fixed time.
            let mut head = car.yaw - pr.yaw;
            while head > core::f64::consts::PI {
                head -= core::f64::consts::TAU;
            }
            while head < -core::f64::consts::PI {
                head += core::f64::consts::TAU;
            }
            brake = 1.0;
            throttle = 0.0;
            boost = false;
            ebrake = false;
            steer = clamp(head * 2.2 + pr.lateral * 0.04, -1.0, 1.0);
            self.lag_steer = steer; // no lag while recovering
            if head.abs() < 0.28 && pr.lateral.abs() < track.half_width * 0.8 {
                self.stuck = 0.0;
            }
            if self.stuck > 4.5 {
                self.stuck = 0.0; // give up and try forwards
            }
        }

        // ---- reaction lag -----------------------------------------------------
        // A human does not apply a new steering angle the instant the geometry
        // changes. Filtering the output is the cheapest honest way to make a
        // lower difficulty feel like a slower driver rather than a slower car.
        let k = 1.0 - (-dt / cfg.react.max(0.02)).exp();
        self.lag_steer += (clamp(steer, -1.0, 1.0) - self.lag_steer) * k;

        // ---- character --------------------------------------------------------
        match self.personality {
            Personality::Ryker if world.race_on => {
                let player_ahead = world.has_rival && world.rival_s - s > 22.0;
                if player_ahead && car.boost > 0.08 && car.v_long > 22.0 {
                    boost = true;
                }
                // ...but never against his own brake. He attacks a gap; he does
                // not drive into the corner at the end of it with both feet down.
                if brake < 0.05 {
                    throttle = throttle.max(if player_ahead { 0.72 } else { 0.46 });
                }
            }
            Personality::Kael if world.race_on => {
                if car.boost > 0.18 && car.v_long > 20.0 && self.rng.next() < dt * 1.2 {
                    self.boost_hold = self.boost_hold.max(0.65);
                }
                boost = boost || self.boost_hold > 0.0;
                // Kael slides everything, including corners that did not need
                // it - but a corner is still the condition. Pulling the
                // handbrake on any lock with the drift machine idle does it on
                // straights too, and that ends against the barrier.
                if tight
                    && self.drift.state == DriftState::None
                    && self.lag_steer.abs() > 0.34
                    && brake < 0.05
                    && car.v_long > 22.0
                {
                    ebrake = true;
                }
            }
            Personality::Nova if world.race_on => {
                // Nova only ever rotates a car that has to be rotated
                if !tight && self.drift.state == DriftState::None {
                    ebrake = false;
                }
                if self.lag_steer.abs() > 0.34 && self.drift.state == DriftState::None {
                    boost = false;
                }
                if brake > 0.05 && self.drift.state == DriftState::None {
                    throttle = 0.0;
                }
            }
            Personality::Predator if world.race_on => {
                // Nova declines to rotate a car that does not need rotating;
                // the prototype rotates everything, because it is not managing
                // risk, it is minimising a lap time it has already computed.
                // Everything here is still an input at the controller, on the
                // same tyres and the same collisions.
                /* THE REHEAT IS ON WHENEVER IT CAN BE, and it is emphatically
                 * on when he is behind.
                 *
                 * Reported: overtaking him did not produce a car that came
                 * back. Part of that is the director's job - it decides WHEN
                 * to answer (see PredatorDirector.updateRivalry) - and part of
                 * it was here: `boost` was gated on `v_long > 16`, which is
                 * right, and then `throttle` was capped at 0.58 whenever the
                 * gap was under six units. Six units is a car length. So the
                 * exact moment he drew alongside to make the pass, he lifted
                 * to three fifths throttle and fell back behind, forever.
                 *
                 * There is only one reason for a predator to be off the
                 * throttle and it is the brake pedal. */
                if car.boost > 0.02 && car.v_long > 16.0 {
                    boost = true;
                }
                if brake < 0.05 {
                    throttle = 1.0;
                }
                // Rotation is left to the drift state machine. Pulling the
                // handbrake on any lock with the machine idle is, on a route
                // gently curved end to end, a permanent handbrake and a
                // permanent slide into the barrier.
                /* NO DEFENSIVE LINE AND NO SHOULDER. NOT EVEN FOR THE BOSS.
                 *
                 * There used to be a defensive line here: project where the
                 * player is moving, shut the door on it. It is the same
                 * positive feedback the general controller documents further
                 * up and declines to use - the leader reads a car in its
                 * mirror, moves, reads it again from the new position - except
                 * that this one was ALSO writing the general controller's own
                 * state variable a frame after it had been consumed.
                 *
                 * It was replaced by a "shoulder" that drove at the player's
                 * lateral on the director's command, and that oscillated for a
                 * different reason - see the long note on the struct. Both are
                 * gone. Everything this personality does now is longitudinal:
                 * the reheat is on and the throttle is pinned unless the brake
                 * pedal says otherwise. Where the car goes is the racing
                 * line's business, and only the racing line's, which is what
                 * makes it a stable controller instead of two arguing ones. */
            }
            _ => {}
        }

        Input {
            steer: clamp(self.lag_steer, -1.0, 1.0),
            throttle: clamp(throttle, 0.0, 1.0),
            brake: clamp(brake, 0.0, 1.0),
            boost,
            ebrake,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::track::{build_course, Centreline, Track, COURSE_LENGTH};

    fn shipped(n: usize) -> Centreline {
        let mut c = Centreline { step: 6.0, count: n, shipped_count: n, ..Default::default() };
        for i in 0..n {
            c.x.push(0.0);
            c.y.push(0.0);
            c.z.push(i as f64 * 6.0);
            c.yaw.push(0.0);
            c.curv.push(0.0);
            c.tunnel.push(0);
        }
        c
    }

    fn course() -> Track {
        Track::new(build_course(&shipped(4494), COURSE_LENGTH))
    }

    /// The line must stay inside the corridor it was given, everywhere.
    #[test]
    fn racing_line_stays_on_the_road() {
        let t = course();
        let lim = t.half_width * 0.68;
        let line = RacingLine::build(&t, lim);
        assert_eq!(line.count, t.count);
        for (i, o) in line.off.iter().enumerate() {
            assert!(
                o.abs() as f64 <= lim + 1e-3,
                "sample {i} is {o} off centre, past the {lim} corridor"
            );
        }
    }

    /// The line must actually cut corners rather than track the centre - that
    /// is the whole point of relaxing it.
    #[test]
    fn racing_line_cuts_corners() {
        let t = course();
        let line = RacingLine::build(&t, t.half_width * 0.68);
        let moved = line.off.iter().filter(|o| o.abs() > 1.0).count();
        assert!(
            moved > line.count / 20,
            "only {moved} of {} samples moved off the centreline",
            line.count
        );
        // ...and the resulting path must be straighter than the centreline
        // through the corners it cut.
        let mut line_c = 0.0f64;
        let mut road_c = 0.0f64;
        for i in 0..t.count {
            line_c += line.curv[i].abs() as f64;
            road_c += t.c.curv[i].abs();
        }
        assert!(line_c < road_c, "line curvature {line_c} did not beat the road's {road_c}");
    }

    /// The backward pass is what creates braking points: every point must be
    /// slow enough to have braked down to whatever comes next.
    #[test]
    fn speed_profile_can_always_brake_in_time() {
        let t = course();
        let line = RacingLine::build(&t, t.half_width * 0.68);
        let v = build_profile(&line, HARD.grip, 80.6);
        let a = BRAKE_A * HARD.grip;
        for i in 0..v.len() - 1 {
            let here = v[i] as f64;
            let next = v[i + 1] as f64;
            let reachable = (next * next + 2.0 * a * line.step).sqrt();
            assert!(
                here <= reachable + 1e-3,
                "sample {i} at {here} u/s cannot brake to {next} in {} units",
                line.step
            );
        }
    }

    /// A driver on a real course must complete a long run without beaching
    /// itself, and must actually use the road rather than crawl.
    #[test]
    fn driver_completes_a_long_run() {
        let t = course();
        let line = RacingLine::build(&t, t.half_width * 0.68);
        let mut d = Driver::new(HARD, 12345);
        d.build_profile_for(&line);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 60.0, 0.0);
        let world = WorldView { race_on: true, has_rival: false, finish_at: 13_000.0, ..Default::default() };

        let mut off_road_frames = 0;
        for _ in 0..(180 * 60) {
            let cmd = d.drive(1.0 / 60.0, &car, &t, &line, &world);
            car.update(&t, 1.0 / 60.0, cmd, true);
            if car.offroad {
                off_road_frames += 1;
            }
        }
        assert!(car.s_track > 6_000.0, "three minutes only covered {} units", car.s_track);
        let avg = car.s_track / 180.0;
        assert!(avg > 33.0, "averaged only {avg:.1} u/s over the run");
        assert!(
            off_road_frames < 180 * 60 / 4,
            "spent {off_road_frames} frames off the road"
        );
    }


    /// THE LADDER HAS TO BE A LADDER.
    ///
    /// `harder_drivers_are_faster` only asks that HARD beats EASY, and the
    /// shipped ladder passed it while being, in practice, one difficulty with
    /// three names on it: 71.1, 74.6 and 76.6 units per second, with HARD
    /// within half a per cent of the R-IX. This asks for daylight between the
    /// rungs, which is the thing a player actually feels.
    ///
    /// The gaps are deliberately asymmetric. EASY to MEDIUM is the widest
    /// because that is where a new player is; MEDIUM to HARD is a real step;
    /// HARD to the R-IX is small because HARD is already close to what the
    /// car can physically do, and the prototype's margin comes from its
    /// momentum drive rather than from its driver.
    #[test]
    fn the_ladder_is_actually_a_ladder() {
        let t = course();
        let line = RacingLine::build(&t, t.half_width * 0.68);
        let pace = |lvl: Level| {
            let mut tot = 0.0;
            let runs = 3;
            for seed in 0..runs {
                let mut d = Driver::new(lvl, 7 + seed * 977);
                d.build_profile_for(&line);
                let mut car = Vehicle::new(&t, 0.0);
                car.reset(&t, 400.0, 0.0);
                let world = WorldView {
                    race_on: true, has_rival: false, finish_at: 200_000.0, ..Default::default()
                };
                for _ in 0..(120 * 60) {
                    let cmd = d.drive(1.0 / 60.0, &car, &t, &line, &world);
                    car.update(&t, 1.0 / 60.0, cmd, true);
                }
                tot += car.s_track - 400.0;
            }
            tot / runs as f64 / 120.0
        };
        let (e, m, h, r) = (pace(EASY), pace(MEDIUM), pace(HARD), pace(IMPOSSIBLE));
        // Each rung must be clearly quicker than the one below it, in a way a
        // player would notice over a race rather than over a season.
        assert!(m > e * 1.06, "MEDIUM {m:.1} is not clear of EASY {e:.1}");
        assert!(h > m * 1.04, "HARD {h:.1} is not clear of MEDIUM {m:.1}");
        assert!(r > h, "the R-IX {r:.1} is not clear of HARD {h:.1}");
        // ...and the whole ladder has to be worth having.
        assert!(h > e * 1.14, "the ladder spans only {:.1}%", (h / e - 1.0) * 100.0);
        // EASY still has to be a car and not an obstacle.
        assert!(e > 55.0, "EASY averages only {e:.1} u/s");
    }

    /// THE RIVAL MUST DRIVE DOWN THE ROAD, NOT ACROSS IT.
    ///
    /// This is the regression test for the reported Chapter 7 fault - the boss
    /// dashing left-right-left across the deck instead of racing - and it
    /// covers every difficulty, because the controller behind it is the
    /// general one and not the boss's personality.
    ///
    /// The measurement is the thing a player actually sees: how far across the
    /// road the car travels while a rival is alongside it. A driver working a
    /// racing line moves a couple of units; the fault moved it the full width
    /// of the road and back, several times, indefinitely.
    ///
    /// The rival here WEAVES, which is what makes it a test of stability
    /// rather than of tracking. The old controller chose its side fresh every
    /// frame from `sign(their lateral)`, so a weaving car in front drove the
    /// chaser's set point between the two edges of the road: 21.6 units of
    /// lateral travel against 2.4 for the committed-side version.
    #[test]
    fn a_rival_alongside_does_not_make_the_driver_weave() {
        let t = course();
        let line = RacingLine::build(&t, t.half_width * 0.68);
        for (name, level, who) in [
            ("EASY", EASY, Personality::None),
            ("HARD", HARD, Personality::None),
            ("R-IX", IMPOSSIBLE, Personality::Predator),
        ] {
            let mut d = Driver::new(level, 4242);
            d.personality = who;
            d.build_profile_for(&line);
            let mut car = Vehicle::new(&t, 0.0);
            car.reset(&t, 400.0, 0.0);

            let dt = 1.0 / 60.0;
            let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
            for step in 0..(24 * 60) {
                // A car alongside, weaving across the road the way a player
                // being defended against does.
                let s = car.s_track;
                let plat = 5.5 * (step as f64 * dt * 1.1).sin();
                let p = t.at(s + 2.0);
                let (rx, rz) = (p.yaw.cos(), -p.yaw.sin());
                let world = WorldView {
                    race_on: true,
                    has_rival: true,
                    rival_s: s + 2.0,
                    rival_x: p.x + rx * plat,
                    rival_z: p.z + rz * plat,
                    finish_at: 100_000.0,
                };
                let cmd = d.drive(dt, &car, &t, &line, &world);
                car.update(&t, dt, cmd, true);
                // Settle first: getting off the line is one legitimate move.
                if step > 240 {
                    let lat = t.project(car.x, car.z, car.s_track).lateral;
                    lo = lo.min(lat);
                    hi = hi.max(lat);
                }
            }
            let swing = hi - lo;
            assert!(
                swing < 8.0,
                "{name} moved {swing:.1} units across the road with a car alongside \
                 - that is the weave, not a racing line"
            );
            // ...and it must have raced, rather than passing by crawling.
            assert!(
                car.s_track - 400.0 > 900.0,
                "{name} covered only {:.0} units in 24 s",
                car.s_track - 400.0
            );
        }
    }

    /// Difficulty must separate the drivers. HARD has to beat EASY over the
    /// same stretch, on the same car.
    #[test]
    fn harder_drivers_are_faster() {
        let t = course();
        let line = RacingLine::build(&t, t.half_width * 0.68);
        let run = |lvl: Level, seed: u32| {
            let mut d = Driver::new(lvl, seed);
            d.build_profile_for(&line);
            let mut car = Vehicle::new(&t, 0.0);
            car.reset(&t, 60.0, 0.0);
            let world = WorldView { race_on: true, ..Default::default() };
            for _ in 0..(120 * 60) {
                let cmd = d.drive(1.0 / 60.0, &car, &t, &line, &world);
                car.update(&t, 1.0 / 60.0, cmd, true);
            }
            car.s_track
        };
        let easy = run(EASY, 7);
        let hard = run(HARD, 7);
        assert!(hard > easy, "HARD covered {hard:.0}, EASY covered {easy:.0}");
    }
}
