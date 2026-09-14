//! Multiplayer, on the client side.
//!
//! Everything in this file exists to answer one question sixty times a second:
//! *where do I draw the other three cars?* The honest answer is "somewhere
//! between two places they were, a little while ago", and the whole of the
//! difficulty is in the words "a little while".
//!
//! # The three clocks
//!
//! There is the client's own clock, the server's clock, and the moment a piece
//! of state was true. They are all different and only one of them is shared, so
//! every timestamp in this file is on the SERVER'S clock, converted on arrival.
//! [`Clock`] owns that conversion.
//!
//! # Why the other cars are drawn in the past
//!
//! A snapshot describing where a car was at server time T arrives at T + latency,
//! and the next one arrives 50 ms after that. Drawing each one the moment it
//! lands gives a car that jumps twenty times a second and stops dead whenever a
//! packet is late. So the renderer runs a fixed distance BEHIND the newest
//! state - the playout delay - and interpolates between the two samples that
//! bracket that moment. The car is then always moving, always smooth, and
//! always a known amount of time old.
//!
//! The size of that delay is the entire quality-of-experience knob. Too small
//! and the buffer starves on every hiccup, which is a stutter. Too large and
//! the cars are visibly behind, which is a fairness problem when you are
//! side by side going into a corner. It cannot be a constant, because the right
//! answer on a wired connection is 60 ms and on a phone tether is 250, so
//! [`Playout`] measures it. See that type for how.
//!
//! # Why the local car is never interpolated
//!
//! The player's own car is simulated locally by the same solver the server
//! validates against, with zero added latency - press the throttle, the car
//! goes. The server does not send back a position for it in the ordinary case;
//! it only sends a [`Correction`](synx_net::Correction) when the state it
//! received could not have been produced by the physics. That is what makes the
//! game feel like the single-player one while still being impossible to cheat
//! at, and it is the only arrangement that works when the round trip is
//! two hundred milliseconds.
//!
//! # What is deliberately not here
//!
//! No rollback, and no re-simulation of the local car against corrections. Both
//! need the client and the server to agree bit-for-bit on `sin`, `cos` and
//! `exp`, and they do not: the WebAssembly build takes those from Rust's own
//! `libm` and the server takes them from the platform's, and the two disagree
//! in the last place. A rollback architecture built on that foundation
//! corrects constantly and imperceptibly wrongly, which is worse than not
//! having one. The correction path below is the alternative that does not need
//! bit-exact determinism.

use core::f64::consts::PI;

use synx_net::msg::{CarState, Snapshot};
use synx_net::{flag, MAX_PLAYERS, MAX_SERVER_FRAME};

use crate::abi;
use crate::vehicle::Vehicle;
use crate::world;

/// How many past states are kept per remote car.
///
/// At the server's twenty snapshots a second this is a second and a half of
/// history - far more than the playout delay will ever ask for, and enough
/// that a burst of six late packets arriving together still finds room.
const RING: usize = 32;

/// Beyond this, a car has not moved but teleported, and smoothing the error
/// away would draw it flying across the map. Snap instead. World units.
const SNAP_DISTANCE: f64 = 42.0;

/// How long the renderer will dead-reckon a car forward past its newest known
/// state before giving up and holding it still, in seconds.
///
/// Extrapolation is a guess and the guess gets worse the longer it runs: a
/// third of a second of constant-turn-rate is convincing, a second and a half
/// is a car driving through a barrier under its own steam.
const MAX_EXTRAPOLATION: f64 = 0.35;

/// Bounds on the playout delay, in seconds. The floor is one snapshot interval
/// plus a little - below that the buffer starves even on a perfect connection.
/// The ceiling is where a racing game stops being one.
const MIN_DELAY: f64 = 0.055;
const MAX_DELAY: f64 = 0.320;

/// What [`NetClient::ingest`] decided a frame was. Returned to JavaScript as a
/// plain integer so the transport layer can route it without decoding
/// anything itself.
pub mod ingest {
    pub const NOTHING: u32 = 0;
    pub const SNAPSHOT: u32 = 1;
    pub const CORRECTION: u32 = 2;
    pub const TIME: u32 = 3;
    /// A liveness probe: the transport must send the queued PONG back.
    pub const PING: u32 = 4;
    pub const MALFORMED: u32 = 5;
}

#[inline]
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Shortest signed distance from `a` to `b` around the circle.
#[inline]
fn ang_diff(a: f64, b: f64) -> f64 {
    let mut d = (b - a) % (2.0 * PI);
    if d > PI {
        d -= 2.0 * PI;
    } else if d < -PI {
        d += 2.0 * PI;
    }
    d
}

/// A frame-rate independent exponential approach.
///
/// `1 - exp(-dt * rate)` rather than a fixed `dt * rate`, because the second
/// one converges at a different speed on a 30 Hz machine than on a 144 Hz one -
/// and "the other cars are smoother on a better PC" is exactly the class of
/// problem this whole file is here to remove.
#[inline]
fn approach(dt: f64, rate: f64) -> f64 {
    1.0 - (-dt * rate).exp()
}

// -------------------------------------------------------------------- clock --

/// The offset between this machine's clock and the server's.
///
/// # How it is measured
///
/// The standard round-trip estimate: the client stamps a request, the server
/// answers with its own time, and if the trip was symmetric the server's clock
/// at the moment of the reply was `server_ms + rtt/2`. That "if" is where all
/// the error lives, and it is why the estimate is not simply averaged.
///
/// # Why the minimum round trip wins
///
/// Queuing delay is one-sided and unpredictable; propagation delay is not. The
/// sample with the SMALLEST round trip is the one that spent the least time
/// sitting in a buffer somewhere, so it is the one whose halving assumption is
/// closest to true. Averaging samples pulls the estimate toward whichever
/// direction happened to be congested. So the best sample in a rolling window
/// wins outright, and the window forgets, so a route change is picked up rather
/// than being outvoted forever by one lucky packet from ten minutes ago.
///
/// # Why it slews rather than steps
///
/// Moving the clock is moving every remote car's timeline at once. A step
/// large enough to see is a step large enough to make every car on the road
/// jump, so the offset walks toward the estimate at a bounded rate. The one
/// exception is the first sample, and a divergence so large it can only be a
/// suspend-and-resume, where stepping is the lesser evil.
pub struct Clock {
    /// server_ms - client_ms, in milliseconds, as currently believed.
    offset: f64,
    /// Where the belief is heading.
    target: f64,
    /// Best (smallest) round trip seen in the current window, milliseconds.
    best_rtt: f64,
    /// Smoothed round trip, for display and for the send-rate governor.
    rtt: f64,
    /// Samples taken since the window was last cleared.
    window: u32,
    pub have: bool,
}

impl Default for Clock {
    fn default() -> Self {
        Clock { offset: 0.0, target: 0.0, best_rtt: f64::INFINITY, rtt: 0.0, window: 0, have: false }
    }
}

impl Clock {
    /// One completed handshake. All three arguments are milliseconds.
    pub fn sample(&mut self, sent_client_ms: f64, server_ms: f64, now_client_ms: f64) {
        let rtt = now_client_ms - sent_client_ms;
        // A negative or absurd round trip means the local clock moved under us
        // (a laptop lid, a time-zone service) and the sample says nothing.
        if !(0.0..=8000.0).contains(&rtt) {
            return;
        }
        self.rtt = if self.rtt == 0.0 { rtt } else { self.rtt * 0.82 + rtt * 0.18 };

        // Forget the window periodically so a stale best sample cannot pin the
        // offset after the route between here and the server has changed.
        self.window += 1;
        if self.window > 24 {
            self.window = 0;
            self.best_rtt = f64::INFINITY;
        }
        if rtt > self.best_rtt {
            return;
        }
        self.best_rtt = rtt;
        self.target = server_ms + rtt * 0.5 - now_client_ms;
        if !self.have {
            self.have = true;
            self.offset = self.target;
        }
    }

    /// Walk the believed offset toward the estimate. Called once a frame.
    pub fn tick(&mut self, dt: f64) {
        if !self.have {
            return;
        }
        let err = self.target - self.offset;
        // Something that is not drift: a machine that went to sleep, or a
        // server restart. Correcting that at 40 ms/s would take a minute.
        if err.abs() > 750.0 {
            self.offset = self.target;
            return;
        }
        // 40 ms of correction per second of wall clock. Fast enough to track
        // real drift, slow enough that nothing on screen shows it happening.
        let step = 40.0 * dt;
        self.offset += clamp(err, -step, step);
    }

    /// The server's clock, right now, in milliseconds.
    #[inline]
    pub fn server_now(&self, now_client_ms: f64) -> f64 {
        now_client_ms + self.offset
    }

    #[inline]
    pub fn rtt(&self) -> f64 {
        self.rtt
    }

    /// The believed offset, in milliseconds. The interface needs it to place a
    /// countdown that the server stated on its own clock.
    #[inline]
    pub fn offset(&self) -> f64 {
        self.offset
    }
}

// ------------------------------------------------------------------ playout --

/// How far behind the newest state the renderer runs, and why that number.
///
/// # The estimator
///
/// This is the delay/variance pair from RFC 6298 - the one TCP uses to set a
/// retransmission timer - applied to a different quantity. For each state that
/// arrives, `late` is how old it already was: the difference between the
/// server clock now and the timestamp on the state. That figure is the sum of
/// one-way latency and whatever the packet spent queued, and its VARIATION is
/// exactly the jitter the buffer has to absorb.
///
/// `mean + 4 * deviation` covers a little beyond the observed spread, which for
/// a distribution this skewed lands close to a 99th percentile without having
/// to keep a histogram to compute one.
///
/// # Why it rises fast and falls slowly
///
/// The cost of the buffer being too small is a visible stutter, and the cost of
/// it being too large is a few tens of milliseconds of extra lag on cars that
/// are already being drawn in the past. Those are not symmetric, so neither is
/// the response: a starve raises the delay immediately, and a quiet link gives
/// it back over several seconds. Anything symmetric oscillates - it shrinks the
/// buffer until it starves, which is a stutter, then grows it again.
pub struct Playout {
    mean: f64,
    dev: f64,
    /// The delay actually in force, seconds.
    delay: f64,
    /// Where the estimator says it should be, seconds.
    want: f64,
    /// Consecutive frames the buffer has had nothing to interpolate into.
    starved: u32,
    pub have: bool,
}

impl Default for Playout {
    fn default() -> Self {
        Playout { mean: 0.0, dev: 0.0, delay: MIN_DELAY, want: MIN_DELAY, starved: 0, have: false }
    }
}

impl Playout {
    /// One arrival. `late_ms` is how old the state already was.
    pub fn arrival(&mut self, late_ms: f64) {
        // A state stamped in the future is a clock that has not settled yet,
        // not information about the network.
        if !(0.0..=4000.0).contains(&late_ms) {
            return;
        }
        if !self.have {
            self.have = true;
            self.mean = late_ms;
            self.dev = late_ms * 0.5;
        } else {
            let err = late_ms - self.mean;
            self.mean += err * 0.125;
            self.dev += (err.abs() - self.dev) * 0.25;
        }
        // One snapshot interval of headroom on top, because the newest state
        // is on average half an interval old before it is even sent.
        let interval = 1000.0 / synx_net::SERVER_SNAPSHOT_HZ as f64;
        self.want = clamp((self.mean + 4.0 * self.dev + interval) / 1000.0, MIN_DELAY, MAX_DELAY);
    }

    /// The buffer had nothing to interpolate into this frame.
    pub fn starve(&mut self) {
        self.starved = self.starved.saturating_add(1);
        // Two frames is a hiccup, ten is a pattern. Give the buffer room the
        // moment it looks like a pattern rather than waiting for the estimator
        // to notice through the mean.
        if self.starved >= 3 {
            self.starved = 0;
            self.want = clamp(self.want * 1.35 + 0.02, MIN_DELAY, MAX_DELAY);
            self.delay = self.delay.max(self.want);
        }
    }

    pub fn fed(&mut self) {
        self.starved = 0;
    }

    pub fn tick(&mut self, dt: f64) {
        let err = self.want - self.delay;
        // up in a quarter of a second, down over four
        let rate = if err > 0.0 { 4.0 } else { 0.25 };
        self.delay += err * approach(dt, rate);
        self.delay = clamp(self.delay, MIN_DELAY, MAX_DELAY);
    }

    #[inline]
    pub fn delay_ms(&self) -> f64 {
        self.delay * 1000.0
    }
}

// --------------------------------------------------------------------- peer --

/// One remote car: its history, and where it is being drawn right now.
pub struct Peer {
    pub active: bool,
    /// The seat this car occupies in the room.
    pub slot: u8,
    ring: [CarState; RING],
    /// Next write position.
    head: usize,
    /// How many of `ring` are valid, saturating at RING.
    filled: usize,
    /// The newest timestamp accepted, so an out-of-order or duplicated frame
    /// cannot walk the history backwards.
    newest_t: u32,

    /// The pose being drawn, after interpolation and after smoothing.
    pub render: CarState,
    /// The pose interpolation asked for, before smoothing. Kept so the
    /// smoother knows what it is chasing.
    target: CarState,
    /// The part of the last discontinuity that has not been smoothed out yet.
    err_x: f64,
    err_y: f64,
    err_z: f64,
    err_yaw: f64,
    /// True once `render` holds anything worth drawing.
    pub visible: bool,

    /* ---- what only the server knows about this car ----------------------
     *
     * Race position and round trip arrive inside every snapshot entry, twenty
     * times a second, and used to be dropped on the floor here - the ring took
     * the car and nothing took these. The interface was left reading them off
     * the lobby's JSON `room` message instead, which is sent when somebody
     * joins, readies or finishes and NEVER during a race. So the standings
     * card spent every race showing the positions and the distances that were
     * true on the grid. See `NetClient::take_snapshot`. */
    /// Race position, 1-based. Zero before the race is running.
    pub place: u8,
    /// The server's measured round trip to that player, milliseconds.
    pub rtt_ms: u16,

    /// Diagnostics, published to the interface.
    pub last_gap_ms: f64,
    pub extrapolated: bool,
}

impl Default for Peer {
    fn default() -> Self {
        Peer {
            active: false,
            slot: 0,
            ring: [CarState::default(); RING],
            head: 0,
            filled: 0,
            newest_t: 0,
            render: CarState::default(),
            target: CarState::default(),
            err_x: 0.0,
            err_y: 0.0,
            err_z: 0.0,
            err_yaw: 0.0,
            visible: false,
            place: 0,
            rtt_ms: 0,
            last_gap_ms: 0.0,
            extrapolated: false,
        }
    }
}

impl Peer {
    fn clear(&mut self) {
        let slot = self.slot;
        *self = Peer::default();
        self.slot = slot;
    }

    /// Forget what this car was doing, keeping the seat.
    ///
    /// Called when a seat changes hands. Slot numbers are reused, and
    /// interpolating a new player's first state from the last position of
    /// whoever was in that seat before would draw their car crossing the map.
    pub fn reset_history(&mut self) {
        let (slot, active) = (self.slot, self.active);
        self.clear();
        self.slot = slot;
        self.active = active;
    }

    /// Index into the ring, oldest first.
    #[inline]
    fn at(&self, i: usize) -> &CarState {
        let start = if self.filled == RING { self.head } else { 0 };
        &self.ring[(start + i) % RING]
    }

    fn newest(&self) -> Option<&CarState> {
        if self.filled == 0 {
            None
        } else {
            Some(self.at(self.filled - 1))
        }
    }

    /// Take one state off the wire.
    ///
    /// Out-of-order and duplicate frames are dropped rather than inserted.
    /// Over TCP neither should happen, but "should not happen" is not a
    /// property a decoder gets to rely on when a proxy, a load balancer or a
    /// reconnection sits in the path - and a history that is not monotonic
    /// makes the bracket search below return two samples in the wrong order,
    /// which draws the car running backwards.
    fn push(&mut self, s: CarState) -> bool {
        if self.filled > 0 && s.t_ms <= self.newest_t {
            return false;
        }
        self.newest_t = s.t_ms;
        self.ring[self.head] = s;
        self.head = (self.head + 1) % RING;
        if self.filled < RING {
            self.filled += 1;
        }
        true
    }

    /// Where this car is at server time `t_ms`.
    ///
    /// Returns false when there is nothing to say - no history at all, or the
    /// requested moment is so far past the newest state that guessing would be
    /// worse than holding still.
    fn resolve(&mut self, t_ms: f64) -> bool {
        if self.filled == 0 {
            return false;
        }
        let newest = *self.at(self.filled - 1);
        let oldest = *self.at(0);
        self.extrapolated = false;

        if t_ms >= newest.t_ms as f64 {
            // Ahead of everything known: dead reckon, briefly.
            let ahead = (t_ms - newest.t_ms as f64) / 1000.0;
            if ahead > MAX_EXTRAPOLATION || newest.is_idle() {
                self.target = newest;
                return true;
            }
            self.extrapolated = ahead > 0.001;
            self.target = dead_reckon(&newest, ahead);
            return true;
        }
        if t_ms <= oldest.t_ms as f64 {
            // Behind everything known. The playout delay has grown past the
            // history, which only happens after a long stall; the oldest state
            // is the honest answer.
            self.target = oldest;
            return true;
        }

        // Bracket. The history is at most thirty-two entries and is walked
        // newest-first, so the loop almost always exits on its first test.
        let mut lo = 0usize;
        for i in (1..self.filled).rev() {
            if (self.at(i - 1).t_ms as f64) <= t_ms {
                lo = i - 1;
                break;
            }
        }
        let a = *self.at(lo);
        let b = *self.at((lo + 1).min(self.filled - 1));
        let span = (b.t_ms as f64 - a.t_ms as f64).max(1.0);
        let u = clamp((t_ms - a.t_ms as f64) / span, 0.0, 1.0);
        self.target = hermite(&a, &b, u, span / 1000.0);
        true
    }

    /// Move the drawn pose toward the resolved one, absorbing discontinuities.
    ///
    /// A car whose packets stopped for four hundred milliseconds and then
    /// resumed has a real, correct, large jump in its target. Drawing it is a
    /// teleport; refusing it is a car in the wrong place. So the jump is taken
    /// immediately in the TARGET and paid back gradually in the RENDER, by
    /// carrying the difference as an error that decays - which is the same
    /// trick the local car's correction path uses below, for the same reason.
    fn smooth(&mut self, dt: f64) {
        let t = self.target;
        if !self.visible {
            self.visible = true;
            self.render = t;
            self.err_x = 0.0;
            self.err_y = 0.0;
            self.err_z = 0.0;
            self.err_yaw = 0.0;
            return;
        }

        // Fold the frame's motion into the error rather than into the render,
        // so the error is always "render minus target" and one decay handles
        // both the jump and the ordinary tracking.
        self.err_x += self.render.x as f64 - t.x as f64 - self.err_x;
        self.err_y += self.render.y as f64 - t.y as f64 - self.err_y;
        self.err_z += self.render.z as f64 - t.z as f64 - self.err_z;
        self.err_yaw = ang_diff(t.yaw as f64, self.render.yaw as f64);

        let d = (self.err_x * self.err_x + self.err_y * self.err_y + self.err_z * self.err_z).sqrt();
        if d > SNAP_DISTANCE {
            // Past this it is not an error, it is a different place: a respawn,
            // a rejoin, a corrected cheat. Smoothing would fly the car across
            // the map at whatever speed the decay happened to produce.
            self.err_x = 0.0;
            self.err_y = 0.0;
            self.err_z = 0.0;
            self.err_yaw = 0.0;
        } else {
            // Faster when the error is large, so a genuine gap closes in about
            // a fifth of a second while ordinary quantisation noise is barely
            // moved at all. Both are frame-rate independent.
            let rate = 9.0 + clamp(d, 0.0, 12.0) * 1.6;
            let k = 1.0 - approach(dt, rate);
            self.err_x *= k;
            self.err_y *= k;
            self.err_z *= k;
            self.err_yaw *= 1.0 - approach(dt, 12.0);
        }

        self.render = t;
        self.render.x = (t.x as f64 + self.err_x) as f32;
        self.render.y = (t.y as f64 + self.err_y) as f32;
        self.render.z = (t.z as f64 + self.err_z) as f32;
        self.render.yaw = (t.yaw as f64 + self.err_yaw) as f32;
    }
}

/// Cubic Hermite between two states, using their velocities as tangents.
///
/// Linear interpolation is the obvious choice and it is visibly wrong for a
/// car: two samples fifty milliseconds apart on the way through a corner are
/// joined by a straight line, so the car cuts every apex and its heading and
/// its path disagree. Hermite uses the velocity that was measured AT each
/// sample as the tangent there, which reproduces the curve the car actually
/// drove, and costs four multiplies more.
///
/// Yaw is done the same way with the yaw rate as its tangent - the reason the
/// state carries a yaw rate at all - and around the shortest arc, so a car
/// crossing the +/-pi seam does not spin the long way round.
fn hermite(a: &CarState, b: &CarState, u: f64, span_s: f64) -> CarState {
    let (avx, avz) = world_velocity(a);
    let (bvx, bvz) = world_velocity(b);

    let u2 = u * u;
    let u3 = u2 * u;
    let h00 = 2.0 * u3 - 3.0 * u2 + 1.0;
    let h10 = u3 - 2.0 * u2 + u;
    let h01 = -2.0 * u3 + 3.0 * u2;
    let h11 = u3 - u2;

    let mut out = *b;
    out.x = (h00 * a.x as f64 + h10 * span_s * avx + h01 * b.x as f64 + h11 * span_s * bvx) as f32;
    out.z = (h00 * a.z as f64 + h10 * span_s * avz + h01 * b.z as f64 + h11 * span_s * bvz) as f32;
    // Height follows the road rather than a velocity we do not carry, so it is
    // linear. The road is smooth; nothing here needs a tangent.
    out.y = (a.y as f64 + (b.y as f64 - a.y as f64) * u) as f32;

    let dy = ang_diff(a.yaw as f64, b.yaw as f64);
    out.yaw = (a.yaw as f64
        + h10 * span_s * a.yaw_rate as f64
        + h01 * dy
        + h11 * span_s * b.yaw_rate as f64
        + (h00 - 1.0) * 0.0) as f32;

    out.pitch = (a.pitch as f64 + ang_diff(a.pitch as f64, b.pitch as f64) * u) as f32;
    out.roll = (a.roll as f64 + ang_diff(a.roll as f64, b.roll as f64) * u) as f32;
    out.s = (a.s as f64 + (b.s as f64 - a.s as f64) * u) as f32;
    out.lateral = (a.lateral as f64 + (b.lateral as f64 - a.lateral as f64) * u) as f32;
    out.v_long = (a.v_long as f64 + (b.v_long as f64 - a.v_long as f64) * u) as f32;
    out.v_lat = (a.v_lat as f64 + (b.v_lat as f64 - a.v_lat as f64) * u) as f32;
    out.yaw_rate = (a.yaw_rate as f64 + (b.yaw_rate as f64 - a.yaw_rate as f64) * u) as f32;
    out.steer = (a.steer as f64 + (b.steer as f64 - a.steer as f64) * u) as f32;
    out.brake = (a.brake as f64 + (b.brake as f64 - a.brake as f64) * u) as f32;
    out.boost = (a.boost as f64 + (b.boost as f64 - a.boost as f64) * u) as f32;
    // Damage only ever grows and a lamp is either on or off; taking the later
    // sample's is correct and avoids a panel un-denting mid-interpolation.
    out.damage = b.damage.max(a.damage);
    out.t_ms = (a.t_ms as f64 + span_s * 1000.0 * u) as u32;
    out
}

/// The world-frame velocity of a state.
///
/// The convention is the solver's: forward is `(sin yaw, cos yaw)` and right is
/// `(cos yaw, -sin yaw)`. Written out here rather than derived, because
/// getting the handedness wrong produces cars that interpolate along a mirror
/// image of their own path and it is not obvious from the result which way
/// round the error is.
#[inline]
fn world_velocity(s: &CarState) -> (f64, f64) {
    let (sy, cy) = (s.yaw as f64).sin_cos();
    (
        sy * s.v_long as f64 + cy * s.v_lat as f64,
        cy * s.v_long as f64 - sy * s.v_lat as f64,
    )
}

/// Carry a state forward under a constant turn rate.
///
/// A car is not a point with a velocity, it is a body with a heading and a rate
/// of change of heading, and over the tenth of a second this is asked for the
/// difference matters: straight-line extrapolation of a car in a corner throws
/// it at the outside barrier, which is exactly where the eye is looking.
///
/// The closed form of a constant-turn-rate arc is used where the rate is worth
/// having and the straight-line limit below it, because the arc form divides by
/// the turn rate and a car on a straight has one that is nearly zero.
fn dead_reckon(s: &CarState, dt: f64) -> CarState {
    let mut out = *s;
    let w = s.yaw_rate as f64;
    let yaw0 = s.yaw as f64;
    let v_long = s.v_long as f64;
    let v_lat = s.v_lat as f64;

    if w.abs() > 0.02 {
        let yaw1 = yaw0 + w * dt;
        let (s0, c0) = yaw0.sin_cos();
        let (s1, c1) = yaw1.sin_cos();
        // integral of the rotating body frame, closed form
        out.x = (s.x as f64 + (v_long * (c0 - c1) + v_lat * (s1 - s0)) / w) as f32;
        out.z = (s.z as f64 + (v_long * (s1 - s0) + v_lat * (c1 - c0)) / w) as f32;
        out.yaw = yaw1 as f32;
    } else {
        let (vx, vz) = world_velocity(s);
        out.x = (s.x as f64 + vx * dt) as f32;
        out.z = (s.z as f64 + vz * dt) as f32;
        out.yaw = (yaw0 + w * dt) as f32;
    }
    out.s = (s.s as f64 + v_long * dt) as f32;
    out.t_ms = s.t_ms.wrapping_add((dt * 1000.0) as u32);
    out
}

// ------------------------------------------------------------- the client --

/// Everything the client half of multiplayer owns.
///
/// One instance, hung off the world, because the game has one connection at a
/// time. It is driven entirely from JavaScript through `abi.rs`: bytes in,
/// a call a frame, and vehicle state blocks out.
pub struct NetClient {
    pub peers: [Peer; MAX_PLAYERS],
    pub clock: Clock,
    pub playout: Playout,

    /// Which seat this client occupies, so its own car is skipped in every
    /// snapshot rather than being drawn twice, once interpolated and late.
    pub self_slot: u8,
    /// This player's own race position and round trip, as the server last
    /// stated them. See the note in [`NetClient::take_snapshot`].
    pub self_place: u8,
    pub self_rtt_ms: u16,

    /// Outbound scratch. One buffer, filled and read in the same frame, so
    /// nothing on the send path allocates.
    out: [u8; MAX_SERVER_FRAME],
    out_len: usize,
    seq: u16,

    /// The last correction the server sent, and whether it has been read.
    pub correction: Option<(u8, CarState)>,

    /// The visual offset the local car is still paying back after a
    /// correction. See [`NetClient::local_smoothing`].
    pub local_err: [f64; 3],

    /// Counters, published to the diagnostics overlay.
    pub rx_frames: u32,
    pub rx_bytes: u32,
    pub tx_frames: u32,
    pub tx_bytes: u32,
    pub dropped: u32,
    pub corrections: u32,
    pub last_snapshot_flags: u8,
    pub last_snapshot_t: u32,
}

impl Default for NetClient {
    fn default() -> Self {
        NetClient {
            peers: core::array::from_fn(|i| Peer { slot: i as u8, ..Peer::default() }),
            clock: Clock::default(),
            playout: Playout::default(),
            self_slot: 255,
            self_place: 0,
            self_rtt_ms: 0,
            out: [0u8; MAX_SERVER_FRAME],
            out_len: 0,
            seq: 0,
            correction: None,
            local_err: [0.0; 3],
            rx_frames: 0,
            rx_bytes: 0,
            tx_frames: 0,
            tx_bytes: 0,
            dropped: 0,
            corrections: 0,
            last_snapshot_flags: 0,
            last_snapshot_t: 0,
        }
    }
}

impl NetClient {
    /// Which seat this client occupies.
    ///
    /// Separate from [`NetClient::reset`] on purpose. A room message arrives
    /// every time anybody presses READY, and resetting the whole client on
    /// each one would throw away the clock estimate and the playout buffer -
    /// which are properties of the CONNECTION, not of the room, and which take
    /// a second of handshaking to rebuild. That is exactly the bug this
    /// separation exists to make impossible.
    pub fn set_self(&mut self, slot: u8) {
        if self.self_slot == slot {
            return;
        }
        self.self_slot = slot;
        // Our own car is never interpolated, so whatever history that seat had
        // is not ours to draw.
        if let Some(p) = self.peers.get_mut(slot as usize) {
            let keep = p.slot;
            p.clear();
            p.slot = keep;
            p.active = false;
        }
    }

    /// Forget everything. Called on connect and on disconnect, so a second
    /// session can never inherit the first one's history.
    pub fn reset(&mut self) {
        for (i, p) in self.peers.iter_mut().enumerate() {
            p.clear();
            p.slot = i as u8;
        }
        self.clock = Clock::default();
        self.playout = Playout::default();
        self.self_place = 0;
        self.self_rtt_ms = 0;
        self.correction = None;
        self.local_err = [0.0; 3];
        self.seq = 0;
        self.out_len = 0;
        self.rx_frames = 0;
        self.rx_bytes = 0;
        self.tx_frames = 0;
        self.tx_bytes = 0;
        self.dropped = 0;
        self.corrections = 0;
        self.last_snapshot_flags = 0;
        self.last_snapshot_t = 0;
    }

    /// One frame off the socket.
    ///
    /// `now_client_ms` is `performance.now()`. Returns an [`ingest`] code so
    /// the transport can act on the frames that need an answer without
    /// understanding any of them.
    pub fn ingest(&mut self, frame: &[u8], now_client_ms: f64) -> u32 {
        self.rx_frames = self.rx_frames.wrapping_add(1);
        self.rx_bytes = self.rx_bytes.wrapping_add(frame.len() as u32);
        let Some((&id, body)) = frame.split_first() else {
            return ingest::NOTHING;
        };
        match id {
            synx_net::s2c::SNAPSHOT => match synx_net::msg::read_snapshot(body) {
                Ok(snap) => {
                    self.take_snapshot(&snap, now_client_ms);
                    ingest::SNAPSHOT
                }
                Err(_) => {
                    self.dropped = self.dropped.wrapping_add(1);
                    ingest::MALFORMED
                }
            },
            synx_net::s2c::CORRECTION => match synx_net::msg::read_correction(body) {
                Ok(c) => {
                    self.corrections = self.corrections.wrapping_add(1);
                    self.correction = Some((c.reason, c.car));
                    ingest::CORRECTION
                }
                Err(_) => {
                    self.dropped = self.dropped.wrapping_add(1);
                    ingest::MALFORMED
                }
            },
            synx_net::s2c::TIME => {
                let mut r = synx_net::Reader::new(body);
                let (Ok(echo), Ok(server_ms)) = (r.u32(), r.u32()) else {
                    self.dropped = self.dropped.wrapping_add(1);
                    return ingest::MALFORMED;
                };
                self.clock.sample(echo as f64, server_ms as f64, now_client_ms);
                ingest::TIME
            }
            synx_net::s2c::PING => {
                let mut r = synx_net::Reader::new(body);
                let Ok(nonce) = r.u32() else {
                    return ingest::MALFORMED;
                };
                // The answer is queued here rather than in JavaScript so the
                // transport never has to know a message layout.
                self.out_len = synx_net::msg::write_pong(&mut self.out, nonce).unwrap_or(0);
                ingest::PING
            }
            _ => {
                self.dropped = self.dropped.wrapping_add(1);
                ingest::MALFORMED
            }
        }
    }

    fn take_snapshot(&mut self, snap: &Snapshot, now_client_ms: f64) {
        self.last_snapshot_flags = snap.flags;
        self.last_snapshot_t = snap.t_ms;
        let server_now = self.clock.server_now(now_client_ms);
        for i in 0..snap.count as usize {
            let e = snap.entries[i];
            let slot = e.slot as usize;
            if slot >= MAX_PLAYERS {
                continue;
            }
            /* OUR OWN SEAT CARRIES TWO THINGS WE CANNOT WORK OUT.
             *
             * The car is skipped - it is simulated here, and drawing the
             * server's copy of it would be drawing ourselves late. The place
             * and the round trip are not ours to compute: the first is the
             * server's ruling on a race it is refereeing, and the second is
             * measured at the other end. Taken before the skip, so the
             * standings can say what position the player is in while the race
             * is still being run. */
            if e.slot == self.self_slot {
                self.self_place = e.place;
                self.self_rtt_ms = e.rtt_ms;
                continue;
            }
            let peer = &mut self.peers[slot];
            peer.active = true;
            // Outside the `push` below on purpose: a snapshot that repeats a
            // car's last state - because its owner's packet has not arrived
            // yet - still carries a fresh ruling on where that car is placed.
            peer.place = e.place;
            peer.rtt_ms = e.rtt_ms;
            if peer.push(e.car) && self.clock.have {
                // How old this state already was. The only measurement the
                // playout estimator gets, and the only one it needs.
                self.playout.arrival(server_now - e.car.t_ms as f64);
            }
        }
    }

    /// Advance every remote car to the moment that should be drawn now.
    ///
    /// Called once a frame, before anything reads a car. `dt` is the frame's
    /// own delta so the smoothing is frame-rate independent.
    pub fn sample(&mut self, now_client_ms: f64, dt: f64) {
        let dt = clamp(dt, 0.0, 0.25);
        self.clock.tick(dt);
        self.playout.tick(dt);
        // Bleed off whatever is left of the local car's last correction.
        let k = 1.0 - approach(dt, 7.0);
        for v in self.local_err.iter_mut() {
            *v *= k;
            if v.abs() < 1e-4 {
                *v = 0.0;
            }
        }

        if !self.clock.have {
            return;
        }
        let render_t = self.clock.server_now(now_client_ms) - self.playout.delay_ms();
        let mut any_fed = false;
        let mut any_starved = false;
        for p in self.peers.iter_mut() {
            if !p.active {
                p.visible = false;
                continue;
            }
            if p.resolve(render_t) {
                p.last_gap_ms = p.newest().map_or(0.0, |n| render_t - n.t_ms as f64);
                p.smooth(dt);
                if p.extrapolated {
                    any_starved = true;
                } else {
                    any_fed = true;
                }
            } else {
                p.visible = false;
            }
        }
        if any_starved {
            self.playout.starve();
        } else if any_fed {
            self.playout.fed();
        }
    }

    /// Fill the outbound buffer with this client's own car.
    ///
    /// Returns the number of bytes; JavaScript reads them out of the module's
    /// memory and hands them to the socket without copying.
    pub fn pack_state(&mut self, car: &Vehicle, now_client_ms: f64, flags: u8, checkpoint: u8) -> usize {
        let t = if self.clock.have { self.clock.server_now(now_client_ms) } else { now_client_ms };
        let state = CarState {
            t_ms: t.max(0.0) as u32,
            x: car.x as f32,
            y: car.y as f32,
            z: car.z as f32,
            s: car.s_track as f32,
            lateral: car.lateral as f32,
            yaw: car.yaw as f32,
            pitch: (car.pitch + car.road_pitch) as f32,
            roll: car.roll as f32,
            v_long: car.v_long as f32,
            v_lat: car.v_lat as f32,
            yaw_rate: car.yaw_rate as f32,
            steer: car.steer as f32,
            flags: flags
                | if car.boosting { flag::BOOSTING } else { 0 }
                | if car.drifting { flag::DRIFTING } else { 0 }
                | if car.offroad { flag::OFFROAD } else { 0 }
                | if car.wrong_way > 0.5 { flag::WRONG_WAY } else { 0 },
            brake: car.braking as f32,
            boost: car.boost as f32,
            damage: car.damage as f32,
            checkpoint,
        };
        self.seq = self.seq.wrapping_add(1);
        self.out_len = synx_net::msg::write_state(&mut self.out, self.seq, &state).unwrap_or(0);
        self.tx_frames = self.tx_frames.wrapping_add(1);
        self.tx_bytes = self.tx_bytes.wrapping_add(self.out_len as u32);
        self.out_len
    }

    pub fn pack_time_req(&mut self, now_client_ms: f64) -> usize {
        self.out_len =
            synx_net::msg::write_time_req(&mut self.out, now_client_ms.max(0.0) as u32).unwrap_or(0);
        self.out_len
    }

    #[inline]
    pub fn out_ptr(&self) -> *const u8 {
        self.out.as_ptr()
    }

    #[inline]
    pub fn out_len(&self) -> usize {
        self.out_len
    }

    /// Accept a correction onto the local car.
    ///
    /// The server's word is final - that is the point of it - so the physics
    /// state is overwritten outright. What is NOT overwritten is where the car
    /// is DRAWN: the difference between where the player thought they were and
    /// where they actually are is kept as an offset that decays over a couple
    /// of hundred milliseconds, so a correction reads as the car being firmly
    /// pushed back into place rather than as a cut.
    ///
    /// A correction large enough that smoothing it would be a lie is taken
    /// whole, because at that size the player has either been teleported by a
    /// desync or has been caught cheating, and both should look like what they
    /// are.
    pub fn apply_correction(&mut self, car: &mut Vehicle, state: &CarState) {
        let dx = car.x - state.x as f64;
        let dy = car.y - state.y as f64;
        let dz = car.z - state.z as f64;
        let d = (dx * dx + dy * dy + dz * dz).sqrt();

        car.x = state.x as f64;
        car.y = state.y as f64;
        car.z = state.z as f64;
        car.s_track = state.s as f64;
        car.lateral = state.lateral as f64;
        car.yaw = state.yaw as f64;
        car.v_long = state.v_long as f64;
        car.v_lat = state.v_lat as f64;
        car.yaw_rate = state.yaw_rate as f64;
        let (sy, cy) = car.yaw.sin_cos();
        car.vx = sy * car.v_long + cy * car.v_lat;
        car.vz = cy * car.v_long - sy * car.v_lat;
        car.speed = car.vx.hypot(car.vz);
        // The wall behind the player follows them; leaving it where the
        // rejected position was would trap the car against nothing.
        car.max_s = car.max_s.min(car.s_track);
        car.min_s = car.min_s.min(car.s_track - 2.0);

        if d < SNAP_DISTANCE {
            self.local_err = [dx, dy, dz];
        } else {
            self.local_err = [0.0; 3];
        }
    }

    /// The offset the renderer should still add to the local car, if any.
    #[inline]
    pub fn local_smoothing(&self) -> [f64; 3] {
        self.local_err
    }
}

// -------------------------------------------------------------- collisions --

/// Resolve the local car against a remote one.
///
/// # Why this is not `collide_cars`
///
/// [`crate::vehicle::collide_cars`] pushes both bodies apart by half the
/// overlap each and gives each half the impulse, which is correct for two cars
/// this machine is simulating. A remote car is not simulated here: its position
/// is overwritten from the next snapshot regardless of anything done to it, so
/// the half of the separation applied to it is thrown away, and the local
/// player ends up half-penetrating every car they touch.
///
/// The remedy is the standard one in racing netcode: each machine resolves the
/// contact fully for the car it owns. Both players are pushed out by the whole
/// overlap on their own screen, both feel the whole impulse, and the two
/// resolutions agree closely enough that neither sees the other inside them.
/// It costs a small asymmetry in a hard T-bone, which is the correct thing to
/// spend to keep contact from feeling mushy.
pub fn collide_local(local: &mut Vehicle, remote: &Vehicle) -> f64 {
    let dx = remote.x - local.x;
    let dz = remote.z - local.z;
    let dist = dx.hypot(dz);
    if dist < 1e-4 || dist > 12.0 {
        return 0.0;
    }
    let nx = dx / dist;
    let nz = dz / dist;
    let overlap = crate::vehicle::support(local, nx, nz) + crate::vehicle::support(remote, -nx, -nz) - dist;
    if overlap <= 0.0 {
        return 0.0;
    }

    // the whole separation, on the car this machine owns
    local.x -= nx * (overlap + 0.002);
    local.z -= nz * (overlap + 0.002);

    let closing = {
        let (sy, cy) = local.yaw.sin_cos();
        let lvx = sy * local.v_long + cy * local.v_lat;
        let lvz = cy * local.v_long - sy * local.v_lat;
        let (ry, rc) = remote.yaw.sin_cos();
        let rvx = ry * remote.v_long + rc * remote.v_lat;
        let rvz = rc * remote.v_long - ry * remote.v_lat;
        // positive when they are separating
        (rvx - lvx) * nx + (rvz - lvz) * nz
    };
    if closing > 0.0 {
        return 0.0;
    }

    // Convert the closing speed back into the local car's body frame and take
    // it out of its velocity. Equal masses and a coefficient of restitution of
    // 0.22, matching the solver's own car-to-car response.
    let (sy, cy) = local.yaw.sin_cos();
    let n_long = nx * sy + nz * cy;
    let n_lat = nx * cy - nz * sy;
    let j = -(1.0 + 0.22) * closing * 0.5;
    local.v_long -= j * n_long;
    local.v_lat -= j * n_lat;
    local.yaw_rate = clamp(local.yaw_rate - j * n_lat * 0.28, -3.6, 3.6);
    local.contact_timer = local.contact_timer.max(0.55);

    let hit = closing.abs();
    if local.crash_cooldown <= 0.0 && hit > 2.2 {
        local.crash_cooldown = 0.30;
        local.last_hit = true;
        local.last_hit_kind = crate::vehicle::HitKind::Car;
        local.impact_speed = hit;
        local.impact = 1.0f64.min(hit / 14.0);
    }
    hit
}

// ------------------------------------------------------------------ hookup --

/// Write a peer's drawn pose into a vehicle, then publish it.
///
/// The remote cars are real [`Vehicle`]s so that everything downstream - the
/// renderer, the headlight rig, the tyre smoke, the collision resolver - works
/// on them unchanged. They are simply never *stepped*: their pose is assigned
/// from the interpolator and stored, which is what this does.
///
/// Only presentation fields are written. The solver's own integrator state is
/// left alone, so if a car ever transitions from remote to locally simulated -
/// which is what happens when a player disconnects and their car is dropped -
/// there is nothing stale to inherit.
pub fn apply_to_vehicle(car: &mut Vehicle, s: &CarState) {
    car.x = s.x as f64;
    car.y = s.y as f64;
    car.z = s.z as f64;
    car.yaw = s.yaw as f64;
    car.pitch = s.pitch as f64;
    car.road_pitch = 0.0;
    car.roll = s.roll as f64;
    car.s_track = s.s as f64;
    car.lateral = s.lateral as f64;
    car.v_long = s.v_long as f64;
    car.v_lat = s.v_lat as f64;
    car.yaw_rate = s.yaw_rate as f64;
    let (sy, cy) = car.yaw.sin_cos();
    car.vx = sy * car.v_long + cy * car.v_lat;
    car.vz = cy * car.v_long - sy * car.v_lat;
    car.speed = car.vx.hypot(car.vz);
    car.steer = s.steer as f64;
    car.steer_visual = s.steer as f64;
    car.braking = s.brake as f64;
    car.boost = s.boost as f64;
    car.damage = s.damage as f64;
    car.boosting = s.flags & flag::BOOSTING != 0;
    car.drifting = s.flags & flag::DRIFTING != 0;
    car.offroad = s.flags & flag::OFFROAD != 0;
    car.drift_amount = if car.drifting { 0.7 } else { 0.0 };
    // The wheels are not simulated for a remote car, but the renderer spins
    // them off `wheel_spin` and the audio reads `engine_load`, so both are
    // driven from the one thing that is known: how fast it is going.
    car.wheel_spin += car.v_long * 0.02;
    car.engine_load = clamp(car.v_long.abs() / 90.0, 0.0, 1.0);
}

/// The single client instance, hung off the world so it lives as long as the
/// process and is reachable from `abi.rs` without a second static.
pub fn client() -> &'static mut NetClient {
    let w = world();
    if w.net.is_none() {
        w.net = Some(NetClient::default());
    }
    w.net.as_mut().unwrap()
}

/// Push a peer's pose into its vehicle's published state block.
///
/// `abi::store_vehicle` is the one thing that knows the block's layout, so it
/// is what writes it here too - a second writer is a second place for the
/// layout to drift.
pub fn publish(car_id: usize) {
    let w = world();
    if car_id >= w.cars.len() {
        return;
    }
    let base = car_id * abi::VEH_STRIDE;
    if w.veh_state.len() < base + abi::VEH_STRIDE {
        return;
    }
    let (cars, state) = (&w.cars, &mut w.veh_state);
    abi::store_vehicle(&cars[car_id], &mut state[base..base + abi::VEH_STRIDE]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(t: u32, x: f32, z: f32, yaw: f32, v: f32) -> CarState {
        CarState { t_ms: t, x, z, yaw, v_long: v, ..CarState::default() }
    }

    #[test]
    fn the_history_stays_monotonic() {
        let mut p = Peer::default();
        assert!(p.push(state(100, 0.0, 0.0, 0.0, 10.0)));
        assert!(p.push(state(150, 0.0, 5.0, 0.0, 10.0)));
        // a duplicate and a straggler, both refused
        assert!(!p.push(state(150, 9.0, 9.0, 0.0, 10.0)));
        assert!(!p.push(state(120, 9.0, 9.0, 0.0, 10.0)));
        assert_eq!(p.filled, 2);
        assert_eq!(p.newest().unwrap().t_ms, 150);
    }

    #[test]
    fn the_ring_wraps_without_losing_order() {
        let mut p = Peer::default();
        for i in 0..(RING as u32 * 3) {
            p.push(state(100 + i * 50, 0.0, i as f32, 0.0, 10.0));
        }
        assert_eq!(p.filled, RING);
        for i in 1..p.filled {
            assert!(p.at(i - 1).t_ms < p.at(i).t_ms, "history is out of order at {i}");
        }
    }

    /// A car driving straight north must interpolate to exactly the midpoint,
    /// which is the case linear and Hermite agree on and therefore the one
    /// that catches a sign error in the tangent term.
    #[test]
    fn interpolation_lands_on_the_midpoint_of_a_straight() {
        let mut p = Peer::default();
        // forward is (sin yaw, cos yaw); yaw 0 is +z
        p.push(state(1000, 0.0, 0.0, 0.0, 10.0));
        p.push(state(2000, 0.0, 10.0, 0.0, 10.0));
        assert!(p.resolve(1500.0));
        assert!((p.target.z - 5.0).abs() < 1e-3, "midpoint came out at {}", p.target.z);
        assert!(p.target.x.abs() < 1e-3);
    }

    /// The tangent has to bend the path. Two samples either side of a corner
    /// are joined by a curve, not a chord, and the curve bulges the right way.
    #[test]
    fn interpolation_bends_through_a_corner() {
        let mut p = Peer::default();
        // entering heading +z, leaving heading +x: a left-hand quarter turn
        p.push(CarState { t_ms: 1000, x: 0.0, z: 0.0, yaw: 0.0, v_long: 20.0, ..CarState::default() });
        p.push(CarState {
            t_ms: 2000,
            x: 20.0,
            z: 20.0,
            yaw: core::f32::consts::FRAC_PI_2,
            v_long: 20.0,
            ..CarState::default()
        });
        assert!(p.resolve(1500.0));
        // the chord midpoint is (10, 10); the arc must run outside it
        let chord = (p.target.x - 10.0).hypot(p.target.z - 10.0);
        assert!(chord > 1.0, "the path did not bend: {} {}", p.target.x, p.target.z);
        assert!(p.target.z > p.target.x, "it bent the wrong way");
    }

    #[test]
    fn dead_reckoning_follows_the_arc_not_the_tangent() {
        // a car turning hard left at 20 u/s for a fifth of a second
        let s = CarState { x: 0.0, z: 0.0, yaw: 0.0, v_long: 20.0, yaw_rate: 1.0, ..CarState::default() };
        let out = dead_reckon(&s, 0.2);
        assert!(out.x > 0.0, "a left turn must move it in +x, got {}", out.x);
        assert!(out.z > 3.0 && out.z < 4.0, "arc length is wrong: {}", out.z);
        assert!((out.yaw - 0.2).abs() < 1e-5);
        // the straight-line answer would have been exactly (0, 4)
        assert!(out.z < 4.0);
    }

    #[test]
    fn extrapolation_gives_up_rather_than_inventing() {
        let mut p = Peer::default();
        p.push(state(1000, 0.0, 0.0, 0.0, 80.0));
        // one second past the newest state - well beyond the limit
        assert!(p.resolve(2000.0));
        assert!(p.target.z.abs() < 1e-3, "it kept extrapolating to {}", p.target.z);
        assert!(!p.extrapolated);
    }

    #[test]
    fn a_teleport_snaps_and_a_nudge_smooths() {
        let mut p = Peer::default();
        p.render = state(0, 0.0, 0.0, 0.0, 0.0);
        p.visible = true;
        p.target = state(0, 0.0, 400.0, 0.0, 0.0);
        p.smooth(1.0 / 60.0);
        assert!((p.render.z - 400.0).abs() < 1e-3, "a 400 unit jump was smoothed");

        p.render = state(0, 0.0, 0.0, 0.0, 0.0);
        p.target = state(0, 0.0, 2.0, 0.0, 0.0);
        p.smooth(1.0 / 60.0);
        assert!(p.render.z > 0.0 && p.render.z < 2.0, "a 2 unit error was not smoothed: {}", p.render.z);
    }

    #[test]
    fn the_clock_settles_and_then_slews() {
        let mut c = Clock::default();
        // server is 5000 ms ahead; a 40 ms round trip
        c.sample(1000.0, 6020.0, 1040.0);
        assert!(c.have);
        assert!((c.offset - 5000.0).abs() < 1.0, "offset settled at {}", c.offset);

        // a later, worse sample must not move the belief far in one frame
        c.sample(2000.0, 7600.0, 2400.0);
        let before = c.offset;
        c.tick(1.0 / 60.0);
        assert!((c.offset - before).abs() < 1.0);
    }

    #[test]
    fn the_playout_delay_rises_faster_than_it_falls() {
        let mut p = Playout::default();
        for _ in 0..40 {
            p.arrival(40.0);
            p.tick(1.0 / 60.0);
        }
        let calm = p.delay_ms();
        for _ in 0..40 {
            p.arrival(260.0);
            p.tick(1.0 / 60.0);
        }
        let rough = p.delay_ms();
        assert!(rough > calm + 20.0, "jitter did not open the buffer: {calm} -> {rough}");

        for _ in 0..40 {
            p.arrival(40.0);
            p.tick(1.0 / 60.0);
        }
        // 0.66 s of settling must not have given the whole margin back
        assert!(p.delay_ms() > calm, "the buffer collapsed the moment the link calmed down");
        assert!(p.delay_ms() >= MIN_DELAY * 1000.0 && p.delay_ms() <= MAX_DELAY * 1000.0);
    }

    #[test]
    fn a_starve_opens_the_buffer_immediately() {
        let mut p = Playout::default();
        for _ in 0..20 {
            p.arrival(30.0);
            p.tick(1.0 / 60.0);
        }
        let before = p.delay_ms();
        for _ in 0..3 {
            p.starve();
        }
        assert!(p.delay_ms() > before, "three starved frames did not widen the buffer");
    }
}
