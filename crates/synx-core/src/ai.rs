//! Racing driver shared by story mode and free roam.
//!
//! Minimum-curvature line, preview braking, velocity-aware pure pursuit and
//! committed passing lanes. All tactics pass through the same grip and braking
//! limits. No random steering errors or gap-based lifting.
//! References: Coulter, CMU-RI-TR-92-01; Reynolds, Steering Behaviors (GDC 1999).

use crate::math::{clamp, damp};
use crate::track::Track;
use crate::vehicle::{Input, Vehicle};

// Below the vehicle's 2.05 g steering ceiling, leaving authority for corrections.
const GRIP_LAT: f64 = 1.45 * 9.81 / 0.733;
const BRAKE_A: f64 = 1.45 * 9.81 / 0.733;
const ACCEL_A: f64 = 0.42 * 9.81 / 0.733;
const WHEELBASE: f64 = 3.716;

/// Legacy fields remain ABI-compatible. Difficulty changes margins and reaction,
/// never random mistakes; assist/target/drift_skill/mistakes are no longer controls.
#[derive(Clone, Copy)]
pub struct Level {
    pub skill: f64, pub assist: f64, pub target: f64, pub grip: f64,
    pub react: f64, pub boost_skill: f64, pub drift_skill: f64, pub mistakes: f64,
}

pub const EASY: Level = Level {
    skill: 0.80, assist: 0.0, target: 0.0, grip: 0.86, react: 0.075,
    boost_skill: 0.72, drift_skill: 0.0, mistakes: 0.0,
};
pub const MEDIUM: Level = Level {
    skill: 0.90, assist: 0.0, target: 0.0, grip: 0.91, react: 0.055,
    boost_skill: 0.86, drift_skill: 0.0, mistakes: 0.0,
};
pub const HARD: Level = Level {
    skill: 0.98, assist: 0.0, target: 0.0, grip: 0.96, react: 0.040,
    boost_skill: 1.0, drift_skill: 0.0, mistakes: 0.0,
};
pub const IMPOSSIBLE: Level = Level {
    skill: 1.0, assist: 0.0, target: 0.0, grip: 0.985, react: 0.030,
    boost_skill: 1.0, drift_skill: 0.0, mistakes: 0.0,
};

pub fn level_by_name(name: &str) -> Level {
    match name { "EASY" => EASY, "HARD" => HARD, "IMPOSSIBLE" => IMPOSSIBLE, _ => MEDIUM }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Personality { None, Ryker, Kael, Nova, Predator }

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

/// Inputs shared by story races, supporting cast and free-roam opponents.
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
    pub pace_scale: f64,
    pub grip_scale: f64,
    pub last_target: f64,
    pub lane_hint: Option<f64>,
    lag_steer: f64,
    boost_hold: f64,
    lane: f64,
    pass_side: f64,
    pass_lane: f64,
    pass_clear: f64,
    stuck: f64,
    reverse: f64,
    rival_prev: Option<f64>,
    rival_speed: f64,
    profile: Vec<f32>,
}

fn angle(a: f64) -> f64 {
    (a + core::f64::consts::PI).rem_euclid(core::f64::consts::TAU) - core::f64::consts::PI
}

/// Short enough to track a bend at racing speed; shared with the JS hint sampler.
pub fn lookahead(speed: f64) -> f64 { clamp(10.0 + speed.max(0.0) * 0.48, 14.0, 68.0) }

impl Driver {
    pub fn new(level: Level, _seed: u32) -> Self {
        Self {
            cfg: level, skill: level.skill, personality: Personality::None,
            pace_scale: 1.0, grip_scale: 1.0, last_target: 0.0, lane_hint: None,
            lag_steer: 0.0, boost_hold: 0.0, lane: 0.0, pass_side: 0.0,
            pass_lane: 0.0, pass_clear: 0.0, stuck: 0.0, reverse: 0.0,
            rival_prev: None, rival_speed: 0.0, profile: Vec::new(),
        }
    }

    pub fn set_level(&mut self, level: Level) {
        let who = self.personality;
        *self = Self::new(level, 0);
        self.personality = who;
    }

    pub fn set_boost_hold(&mut self, secs: f64) {
        self.boost_hold = if secs <= 0.0 { 0.0 } else { self.boost_hold.max(secs) };
    }

    pub fn build_profile_for(&mut self, line: &RacingLine) {
        self.profile = line.curv.iter().map(|k| (GRIP_LAT / (*k as f64).max(1e-6)).sqrt() as f32).collect();
    }

    fn sample(values: &[f32], line: &RacingLine, s: f64) -> f64 {
        let f = clamp(s / line.step, 0.0, (line.count - 1) as f64);
        let i = f as usize;
        let j = (i + 1).min(line.count - 1);
        values[i] as f64 + (values[j] as f64 - values[i] as f64) * (f - i as f64)
    }

    pub fn drive(&mut self, dt: f64, car: &Vehicle, track: &Track,
        line: &RacingLine, world: &WorldView) -> Input {
        if !dt.is_finite() || dt <= 0.0 || line.count < 2 { return Input::default(); }
        if self.profile.len() != line.count { self.build_profile_for(line); }
        let dt = dt.min(0.1);
        self.skill = clamp(self.cfg.skill, 0.0, 1.0);
        let speed = car.v_long.max(0.0);
        let s = car.s_track;
        let pr = track.project(car.x, car.z, s);
        let look = lookahead(speed);
        // Use absolute road coordinates for every lane, including obstacle hints.
        // Passing and obstacle avoidance choose ONE target, never additive offsets.
        let edge = (track.half_width - 3.5).max(1.0);
        let racing_lane = clamp(Self::sample(&line.off, line, s + look), -edge, edge);
        let mut wanted_lane = racing_lane;
        let mut obstacle_speed = f64::INFINITY;
        if world.has_rival {
            let gap = world.rival_s - s;
            let rival = track.project(world.rival_x, world.rival_z, world.rival_s);
            if let Some(prev) = self.rival_prev {
                // Teleports/checkpoint restores must not become enormous closing speeds.
                let measured = clamp((world.rival_s - prev) / dt, 0.0, 220.0);
                self.rival_speed = damp(self.rival_speed, measured, 6.0, dt);
            } else { self.rival_speed = speed; }
            self.rival_prev = Some(world.rival_s);
            let closing = (speed - self.rival_speed).max(0.0);
            let reach = clamp(45.0 + speed * 0.75 + closing * 1.5, 55.0, 180.0);
            let sharing = gap > -22.0 && gap < reach + 25.0;
            if self.pass_side != 0.0 {
                self.pass_clear = if sharing { 0.0 } else { self.pass_clear + dt };
                if self.pass_clear > 1.4 { self.pass_side = 0.0; }
            }
            if self.pass_side == 0.0 && gap > 6.0 && gap < reach
                && (rival.lateral - racing_lane).abs() < 6.0 {
                let clearance = 6.5;
                let left = rival.lateral - clearance;
                let right = rival.lateral + clearance;
                let left_ok = left >= -edge;
                let right_ok = right <= edge;
                if left_ok || right_ok {
                    let side = if !left_ok { 1.0 } else if !right_ok { -1.0 }
                        else if (right - pr.lateral).abs() < (left - pr.lateral).abs() { 1.0 }
                        else { -1.0 };
                    self.pass_side = side;
                    self.pass_lane = clamp(rival.lateral + side * clearance, -edge, edge);
                    self.pass_clear = 0.0;
                }
            }
            if self.pass_side != 0.0 { wanted_lane = self.pass_lane; }
            // Brake only for an actual closing conflict in our lane. A car behind
            // or beside us must never reduce pace just because the gap changed sign.
            let separation = (pr.lateral - rival.lateral).abs();
            if gap > 0.0 && gap < reach && separation < 3.3 && closing > 1.0 {
                let time_to_contact = (gap - 5.0).max(0.0) / closing;
                let time_to_clear = (3.8 - separation).max(0.0) / 4.5 + 0.3;
                if time_to_contact < time_to_clear {
                    obstacle_speed = (self.rival_speed * self.rival_speed
                        + 2.0 * BRAKE_A * 0.6 * (gap - 6.0).max(0.0)).sqrt();
                }
            }
        } else {
            self.rival_prev = None;
            self.pass_side = 0.0;
        }
        if let Some(hint) = self.lane_hint.filter(|v| v.is_finite()) {
            wanted_lane = clamp(hint, -edge, edge);
        }
        // Smooth committed lane changes, with room for the whole chassis at either edge.
        self.lane += clamp(wanted_lane - self.lane, -5.0 * dt, 5.0 * dt);
        self.lane = clamp(self.lane, -edge, edge);
        let ap = track.at(s + look);
        let tx = ap.x + ap.yaw.cos() * self.lane;
        let tz = ap.z - ap.yaw.sin() * self.lane;
        let dx = tx - car.x;
        let dz = tz - car.z;
        let dist2 = (dx * dx + dz * dz).max(1.0);
        // Pursue in the direction of travel, then damp slip and yaw. Positive
        // body slip requires POSITIVE countersteer in this vehicle's convention.
        let heading = car.yaw + car.body_slip;
        let curvature = 2.0 * (dx * heading.cos() - dz * heading.sin()) / dist2;
        let desired_yaw = speed * curvature;
        let delta = (WHEELBASE * curvature).atan()
            + car.body_slip.signum() * (car.body_slip.abs() - 0.12).max(0.0) * 0.35
            + (desired_yaw - car.yaw_rate) * WHEELBASE / speed.max(15.0) * 0.35;
        let mut steer = clamp(delta / car.steering_lock(delta), -1.0, 1.0);

        // Pace is independent of the player's gap. Directors can request higher
        // straight-line pace, but cannot manufacture steering authority or grip.
        let grip = self.cfg.grip * clamp(car.surface_grip, 0.18, 1.08)
            * clamp(car.grip_scale.min(self.grip_scale), 1.0, 2.2);
        let lateral_a = (GRIP_LAT * grip).min(27.4 * 0.75);
        // Keep braking capacity in reserve while the tyres are also turning.
        let braking = BRAKE_A * grip.min(1.3) * 0.72;
        let base_top = car.engine_top;
        let pace = 0.5 + self.skill * 0.5;
        let top = base_top * pace * self.pace_scale.max(0.5);
        let reserve = world.race_on && !car.boost_locked && car.boost > 0.025
            && (car.boost > 0.34 || car.boosting || self.boost_hold > 0.0);
        // Plan against the ceiling boost WILL enable. The current ceiling still
        // reflects last frame's boost state and otherwise prevents ever arming it.
        let ceiling = (base_top * car.race_mode_multiplier.max(1.0)
            * if reserve { 1.34 } else { 1.0 }).min(car.speed_cap);
        let fast_top = (if reserve { top * (1.0 + 0.34 * self.cfg.boost_skill) } else { top }).min(ceiling);
        let mut target = fast_top;
        // Raw geometric corner limits, then braking distance. Sampling an already
        // back-propagated profile at the steering lookahead brakes twice as early.
        let horizon = clamp(speed * speed / (2.0 * braking) + speed * 0.35 + 60.0, 100.0, 1400.0);
        let mut d = 0.0;
        while d <= horizon {
            let q = s + d;
            // A held passing lane follows the road's arc, not the optimized
            // racing line. Preview both so a cut apex cannot hide a tight turn.
            let k = Self::sample(&line.curv, line, q).abs().max(track.at(q).curv.abs());
            // An inside passing lane has a smaller radius than the racing line.
            let line_off = Self::sample(&line.off, line, q);
            let offset = (self.lane - line_off).abs();
            let k = k / (1.0 - k * offset).max(0.45);
            let corner_v2 = (Self::sample(&self.profile, line, q).powi(2) * lateral_a / GRIP_LAT)
                .min(lateral_a / k.max(1e-6));
            let distance = (d - speed * 0.16).max(0.0);
            target = target.min((corner_v2 + 2.0 * braking * distance).sqrt());
            d += line.step.min(6.0);
        }
        // A displaced or bumped car needs grip to rejoin its line as well as turn.
        let requested_k = curvature.abs();
        if requested_k > 1e-5 { target = target.min((lateral_a / requested_k).sqrt()); }
        let road_heading = angle(car.yaw - pr.yaw);
        let lateral_velocity = car.vx * pr.yaw.cos() - car.vz * pr.yaw.sin();
        let projected_edge = pr.lateral + lateral_velocity * 0.45;
        let danger = pr.lateral.abs() > edge && projected_edge.abs() > pr.lateral.abs();
        if danger { target = target.min(speed * 0.82); }
        if car.body_slip.abs() > 0.22 { target = target.min(speed * 0.88); }
        target = target.min(obstacle_speed).max(0.0);
        self.last_target = target;
        let error = target - speed;
        let mut brake = if error < -0.7 { clamp(-error * 0.22, 0.0, 1.0) } else { 0.0 };
        let mut throttle = if brake > 0.0 { 0.0 } else { clamp(0.5 + error * 0.3, 0.0, 1.0) };
        self.boost_hold = (self.boost_hold - dt).max(0.0);
        let settled = car.body_slip.abs() < 0.12 && road_heading.abs() < 0.25
            && !danger && !car.is_airborne();
        let mut boost = reserve && settled && brake == 0.0
            && error > if car.boosting { 0.4 } else { 2.0 } && speed > 18.0;
        if boost { throttle = 1.0; }

        // Recover using controls only; reverse long enough to clear a barrier, then
        // rejoin. Race starts are not stalls, and directors cannot boost a recovery.
        if world.race_on && speed < 3.0 && (pr.lateral.abs() > edge - 1.0 || road_heading.abs() > 0.7) {
            self.stuck += dt;
        } else { self.stuck = 0.0; }
        if self.stuck > 0.65 && self.reverse <= 0.0 { self.reverse = 1.5; self.stuck = 0.0; }
        if self.reverse > 0.0 {
            self.reverse -= dt;
            throttle = 0.0; brake = 1.0; boost = false;
            steer = clamp(road_heading * 1.8 + pr.lateral * 0.03, -1.0, 1.0);
            if car.v_long < -2.0 && road_heading.abs() < 0.22 { self.reverse = 0.0; }
        }
        self.lag_steer = damp(self.lag_steer, steer, 1.0 / self.cfg.react.max(0.025), dt);
        Input { steer: self.lag_steer, throttle, brake, boost, ebrake: false }
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

    #[test]
    fn proximity_and_lead_changes_do_not_reduce_race_pace() {
        let t = Track::new(shipped(500));
        let line = RacingLine::build(&t, 10.0);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 400.0, 0.0);
        car.v_long = 60.0;
        car.speed = 60.0;
        for level in [EASY, MEDIUM, HARD, IMPOSSIBLE] {
            let mut solo = Driver::new(level, 1);
            let clear = solo.drive(1.0/60.0, &car, &t, &line,
                &WorldView { race_on: true, ..Default::default() });
            for gap in [-500.0, -40.0, -2.0, 0.0, 2.0, 40.0, 500.0] {
                let mut driver = Driver::new(level, 1);
                let cmd = driver.drive(1.0/60.0, &car, &t, &line, &WorldView {
                    race_on: true, has_rival: true, rival_s: car.s_track + gap,
                    rival_x: 8.0, rival_z: car.s_track + gap, ..Default::default()
                });
                assert_eq!(cmd.brake, clear.brake, "braked at gap {gap}");
                assert_eq!(cmd.throttle, clear.throttle, "lifted at gap {gap}");
                assert_eq!(driver.last_target, solo.last_target);
            }
        }
    }

    #[test]
    fn forced_boost_cannot_override_braking_or_a_slide() {
        let t = course();
        let line = RacingLine::build(&t, 10.0);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 400.0, 0.0);
        car.v_long = 110.0;
        car.body_slip = 0.4;
        let mut d = Driver::new(IMPOSSIBLE, 1);
        d.personality = Personality::Predator;
        d.set_boost_hold(20.0);
        let cmd = d.drive(1.0/60.0, &car, &t, &line,
            &WorldView { race_on: true, ..Default::default() });
        assert!(!cmd.boost && !cmd.ebrake);
        assert!(cmd.brake > 0.0 && cmd.throttle == 0.0);
    }

    #[test]
    fn a_tuning_request_cannot_invent_tyre_grip() {
        let t = course();
        let line = RacingLine::build(&t, 10.0);
        let mut car = Vehicle::new(&t, 0.0);
        car.reset(&t, 114000.0, 0.0);
        car.v_long = 60.0;
        let mut stock = Driver::new(HARD, 1);
        let mut tuned = Driver::new(HARD, 1);
        tuned.grip_scale = 2.2;
        let world = WorldView { race_on: true, ..Default::default() };
        stock.drive(1.0/60.0, &car, &t, &line, &world);
        tuned.drive(1.0/60.0, &car, &t, &line, &world);
        assert_eq!(stock.last_target, tuned.last_target);
        car.surface_grip = 0.35;
        tuned.drive(1.0/60.0, &car, &t, &line, &world);
        assert!(tuned.last_target < stock.last_target);
    }

    #[test]
    fn restart_clears_passing_recovery_and_boost_state() {
        let mut d = Driver::new(IMPOSSIBLE, 1);
        d.pass_side = -1.0; d.pass_lane = -12.0; d.lane = -12.0;
        d.reverse = 1.0; d.stuck = 3.0; d.boost_hold = 4.0;
        d.lane_hint = Some(14.0); d.last_target = 120.0;
        d.set_level(IMPOSSIBLE);
        assert_eq!((d.pass_side, d.reverse, d.boost_hold, d.lane, d.last_target), (0.0,0.0,0.0,0.0,0.0));
        assert!(d.lane_hint.is_none());
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


    /// Every setting is competitive, with smaller but measurable pace steps.
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
        assert!(m > e * 1.025, "MEDIUM {m:.1} is not clear of EASY {e:.1}");
        assert!(h > m * 1.02, "HARD {h:.1} is not clear of MEDIUM {m:.1}");
        assert!(r > h, "the R-IX {r:.1} is not clear of HARD {h:.1}");
        // ...and the whole ladder has to be worth having.
        assert!(h > e * 1.05, "the ladder spans only {:.1}%", (h / e - 1.0) * 100.0);
        // EASY still has to be a car and not an obstacle.
        assert!(e > 65.0, "EASY averages only {e:.1} u/s");
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

    /// REGRESSION: THE LEAD-CHANGE WEAVE (the reported Chapter 7 fault).
    ///
    /// `a_rival_alongside_does_not_make_the_driver_weave` pins the rival two
    /// units ahead for the whole run, so `pass_side` is captured once and is
    /// never released - the one path that test cannot reach is the one Chapter
    /// 7 lives on. The R-IX's hunt curve holds it wheel to wheel with the
    /// player, so the SIGN of the gap changes every few seconds, and on the old
    /// code every change re-armed the side from `sign(their lateral)`. That is
    /// the same bang-bang controller the capture latch was added to remove,
    /// running at the rate the lead changes rather than at frame rate.
    ///
    /// The player here swaps the lead on a slow cycle AND moves across the road
    /// while it happens, which is what a real one does.
    #[test]
    fn a_lead_change_does_not_make_the_driver_weave() {
        let t = course();
        let line = RacingLine::build(&t, t.half_width * 0.68);
        for (name, level, who) in [
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
            for step in 0..(40 * 60) {
                let time = step as f64 * dt;
                let s = car.s_track;
                // The lead changes hands on a seven-second cycle.
                let gap = 14.0 * (time * 0.9).sin();
                // ...and the player is not on the centreline while it does.
                let plat = 6.0 * (time * 0.55 + 1.0).sin();
                let p = t.at(s + gap);
                let (rx, rz) = (p.yaw.cos(), -p.yaw.sin());
                let world = WorldView {
                    race_on: true,
                    has_rival: true,
                    rival_s: s + gap,
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
            println!("{name}: {swing:.1} units of lateral travel");
            assert!(
                swing < 8.0,
                "{name} moved {swing:.1} units across the road as the lead changed \
                 - that is the weave, not a racing line"
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
