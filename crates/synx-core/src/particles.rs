//! The particle system's two hot loops, moved off the main thread's critical
//! path and out of JavaScript's object model.
//!
//! # Why this is here
//!
//! Measured on the release build with a real GPU, `Fx.draw` was the single
//! most expensive function the game's own code ran, and `Fx.integrate` was
//! close behind it. Neither was doing anything clever - between them they are
//! a damped Euler step and a billboard expansion - and both were slow for the
//! same three reasons, none of which is about arithmetic:
//!
//!   * **The particles were an array of 900 plain objects.** Seventeen fields
//!     each, chased through a pointer per particle per frame, twice. That is
//!     a cache miss per field on a working set that would otherwise fit in
//!     L1 several times over.
//!
//!   * **The builder allocated inside its own inner loop.** A `corners` array
//!     literal, per particle, per frame - nine hundred short-lived arrays a
//!     frame, which is why `(garbage collector)` was 22 ms of an eight-second
//!     profile.
//!
//!   * **It wrote 48,600 floats a frame through JavaScript.** Six vertices of
//!     nine floats for every one of 900 particles, every frame, as individual
//!     indexed stores.
//!
//! Here the same work is a flat `f32` slice walked linearly, the corner table
//! is a `const`, and the vertex buffer is filled in place and handed to the
//! caller as a pointer it maps once. The JavaScript keeps the interesting
//! half - what to spawn, when, and what colour - which is the half that is
//! actually about the game.
//!
//! # The layout
//!
//! One particle is [`STRIDE`] consecutive `f32`. The order is fixed by
//! [`F`] below and JavaScript writes it directly when it spawns; nothing
//! crosses this boundary except that buffer and a handful of scalars.

/// Fields of one particle, in order. A single list, because a layout written
/// out twice is a layout that drifts - and the symptom of a drifted particle
/// layout is sparks that are the wrong colour and fall upwards.
pub mod f {
    pub const LIFE: usize = 0;
    pub const MAX: usize = 1;
    pub const X: usize = 2;
    pub const Y: usize = 3;
    pub const Z: usize = 4;
    pub const VX: usize = 5;
    pub const VY: usize = 6;
    pub const VZ: usize = 7;
    pub const SIZE: usize = 8;
    pub const GROW: usize = 9;
    pub const DRAG: usize = 10;
    pub const GRAVITY: usize = 11;
    pub const STRETCH: usize = 12;
    pub const FLOOR: usize = 13;
    pub const R: usize = 14;
    pub const G: usize = 15;
    pub const B: usize = 16;
    pub const A: usize = 17;
}

/// Floats per particle.
pub const STRIDE: usize = 18;
/// Floats per emitted vertex: position.xyz, uv.xy, rgba.
pub const VERT_FLOATS: usize = 9;
/// Vertices per particle - two triangles, unindexed.
pub const VERTS_PER: usize = 6;

/// The two triangles of a sprite, as (corner.x, corner.y, u, v).
///
/// A `const`, not a literal built per particle. This is the allocation the
/// JavaScript version was making nine hundred times a frame.
const CORNERS: [[f32; 4]; VERTS_PER] = [
    [-1.0, -1.0, 0.0, 0.0],
    [1.0, -1.0, 1.0, 0.0],
    [1.0, 1.0, 1.0, 1.0],
    [-1.0, -1.0, 0.0, 0.0],
    [1.0, 1.0, 1.0, 1.0],
    [-1.0, 1.0, 0.0, 1.0],
];

pub struct Particles {
    /// `max * STRIDE` floats, owned here and written from JavaScript.
    pub p: Vec<f32>,
    /// `max * VERTS_PER * VERT_FLOATS` floats, filled by `build`.
    pub out: Vec<f32>,
    pub max: usize,
    /// How many were alive after the last `integrate`.
    pub live: usize,
}

impl Default for Particles {
    fn default() -> Self {
        Particles { p: Vec::new(), out: Vec::new(), max: 0, live: 0 }
    }
}

impl Particles {
    pub fn reset(&mut self, max: usize) {
        self.max = max;
        self.p = vec![0.0; max * STRIDE];
        self.out = vec![0.0; max * VERTS_PER * VERT_FLOATS];
        self.live = 0;
    }

    /// One damped Euler step over every live particle.
    ///
    /// Identical in result to the JavaScript it replaces, including the floor
    /// bounce - which is per particle rather than a world plane, because a
    /// spark thrown on Chapter 7's elevated deck has a different floor from
    /// one thrown in the underpass twenty-six units below it.
    pub fn integrate(&mut self, dt: f32) -> usize {
        let mut live = 0usize;
        for i in 0..self.max {
            let o = i * STRIDE;
            let q = &mut self.p[o..o + STRIDE];
            if q[f::LIFE] <= 0.0 {
                continue;
            }
            q[f::LIFE] -= dt;
            if q[f::LIFE] <= 0.0 {
                continue;
            }
            let k = (-q[f::DRAG] * dt).exp();
            q[f::VX] *= k;
            q[f::VZ] *= k;
            q[f::VY] = q[f::VY] * k + q[f::GRAVITY] * dt;
            q[f::X] += q[f::VX] * dt;
            q[f::Y] += q[f::VY] * dt;
            q[f::Z] += q[f::VZ] * dt;
            q[f::SIZE] += q[f::GROW] * dt;
            if q[f::Y] < q[f::FLOOR] {
                q[f::Y] = q[f::FLOOR];
                q[f::VY] *= -0.25;
            }
            live += 1;
        }
        self.live = live;
        live
    }

    /// Expand every live particle into two camera-facing triangles.
    ///
    /// `right`, `up` and `fwd` are the camera basis in WORLD space, which is
    /// what lets a sprite face the lens; `fwd` is needed separately because a
    /// stretched sprite is billboarded about its own direction of travel
    /// rather than about the view plane, and that direction has to be
    /// projected into the view plane before it can be used.
    ///
    /// Returns the number of VERTICES written.
    pub fn build(&mut self, right: [f32; 3], up: [f32; 3], fwd: [f32; 3]) -> usize {
        let mut o = 0usize;
        for i in 0..self.max {
            let b = i * STRIDE;
            let life = self.p[b + f::LIFE];
            let size = self.p[b + f::SIZE];
            if life <= 0.0 || size <= 0.0 {
                continue;
            }
            let t = life / self.p[b + f::MAX].max(1e-6);
            // fade in fast, out slow: a puff that pops on is what reads as impact
            let a = self.p[b + f::A] * (t * 3.2).min(1.0) * t;
            let s = size * 0.5;
            let (mut ux, mut uy, mut uz) = (right[0] * s, right[1] * s, right[2] * s);
            let (mut vx, mut vy, mut vz) = (up[0] * s, up[1] * s, up[2] * s);

            let stretch = self.p[b + f::STRETCH];
            if stretch > 0.0 {
                let (pvx, pvy, pvz) =
                    (self.p[b + f::VX], self.p[b + f::VY], self.p[b + f::VZ]);
                let sp = (pvx * pvx + pvy * pvy + pvz * pvz).sqrt();
                if sp > 0.5 {
                    let (mut ax, mut ay, mut az) = (pvx / sp, pvy / sp, pvz / sp);
                    // project out the view direction, or a sprite coming at the
                    // camera collapses to nothing
                    let dv = ax * fwd[0] + ay * fwd[1] + az * fwd[2];
                    ax -= fwd[0] * dv;
                    ay -= fwd[1] * dv;
                    az -= fwd[2] * dv;
                    /* `al` is how much of the travel direction survived the
                       projection - 1 across the view, 0 straight at the lens.
                       It scales the stretch as well as normalising the axis:
                       a plume aimed at the camera has no direction left to
                       elongate along, and normalising a near-zero residual
                       just picks an arbitrary one. Head-on it should be a
                       disc, which is what an afterburner looks like from
                       behind. */
                    let al = (ax * ax + ay * ay + az * az).sqrt();
                    if al > 1e-3 {
                        ax /= al;
                        ay /= al;
                        az /= al;
                        let bx = fwd[1] * az - fwd[2] * ay;
                        let by = fwd[2] * ax - fwd[0] * az;
                        let bz = fwd[0] * ay - fwd[1] * ax;
                        let long = s * (1.0 + stretch * al * al * (sp / 30.0).min(1.0));
                        ux = ax * long;
                        uy = ay * long;
                        uz = az * long;
                        vx = bx * s;
                        vy = by * s;
                        vz = bz * s;
                    }
                }
            }

            let (px, py, pz) = (self.p[b + f::X], self.p[b + f::Y], self.p[b + f::Z]);
            let (r, g, bl) = (self.p[b + f::R], self.p[b + f::G], self.p[b + f::B]);
            for c in CORNERS.iter() {
                let (cx, cy) = (c[0], c[1]);
                self.out[o] = px + ux * cx + vx * cy;
                self.out[o + 1] = py + uy * cx + vy * cy;
                self.out[o + 2] = pz + uz * cx + vz * cy;
                self.out[o + 3] = c[2];
                self.out[o + 4] = c[3];
                self.out[o + 5] = r;
                self.out[o + 6] = g;
                self.out[o + 7] = bl;
                self.out[o + 8] = a;
                o += VERT_FLOATS;
            }
        }
        o / VERT_FLOATS
    }
}

// ============================================================ THE EMITTERS ==
//
// What the last of the particle system's per-frame JavaScript was doing, and
// why it is here now.
//
// `integrate` and `build` came over first because they were the two loops that
// walked every particle. What stayed behind was the half that DECIDES things -
// the tyre smoke, the afterburner, the shower off a barrier and the grit the
// car drags past the lens - on the argument that it is the legible half and
// the arithmetic in it is trivial.
//
// The arithmetic is trivial. The allocation is not. Every one of those
// emitters produced its particles by building a JavaScript object with
// eighteen fields on it and handing that to `spawn`, which read the eighteen
// fields back out, wrote them into this buffer, and dropped the object. At a
// hundred and fifty grit motes a second, plus a plume at twelve hundred a
// second while the boost is lit, plus a shower off the wall at up to two
// hundred, that is a few thousand short-lived objects a second whose entire
// purpose was to carry eighteen floats across a function call. Several of the
// call sites also differ in which optional fields they set, so they are not
// even one hidden class: they are half a dozen.
//
// Here it is one call per car per frame. The rates, the thresholds and every
// constant below are transcribed from the JavaScript one line at a time; what
// comes out is the same distribution of the same particles.
//
// WHAT IS DELIBERATELY NOT THE SAME. `Math.random()` is gone, because there is
// no such thing on this side and reaching back across the boundary for one
// would cost more than the call this is replacing. `Rng` below is an
// xorshift32 per car. It is a different SEQUENCE - two runs of the game no
// longer scatter a given spark to the same place - and the same DISTRIBUTION,
// which is the only property any of these emitters was relying on. Nothing
// here is simulated against, checked or replayed; it is smoke.
//
// WHAT STAYS IN JAVASCRIPT. `Fx.spawn` is untouched and still takes an object:
// the chapter directors spawn one-off effects through it from a dozen places,
// and those are not hot, not repeated and not worth a boundary. Only the four
// emitters that run on every frame of every race moved.

/// One car's emitter state: the fractional accumulators that turn a rate into
/// whole particles, and its own stream.
///
/// The accumulators have to persist between frames or every emitter would
/// round its rate down to nothing at a high frame rate - eighteen smoke puffs
/// a second is less than one per frame, so a version that did not carry the
/// remainder would emit none of them at 60fps and all of them at 10.
///
/// The generator is the crate's existing Mulberry32 rather than a second one
/// written for this. It is a few more operations than the xorshift a particle
/// emitter would otherwise reach for, and at a few dozen draws a frame that
/// is not a cost worth a second implementation of a solved problem - the one
/// in `math` is already there, already tested bit-for-bit against the
/// JavaScript it replaced, and already what the course generator draws from.
pub struct Emitter {
    pub smoke: f32,
    pub dust: f32,
    pub spark: f32,
    rng: crate::math::Rng,
}

impl Emitter {
    pub fn new(seed: u32) -> Emitter {
        Emitter { smoke: 0.0, dust: 0.0, spark: 0.0, rng: crate::math::Rng::new(seed) }
    }

    /// A draw in `[0, 1)`.
    #[inline]
    fn u(&mut self) -> f32 {
        self.rng.next() as f32
    }

    /// ...and one in `[-0.5, 0.5)`, which is how most of these are used.
    #[inline]
    fn s(&mut self) -> f32 {
        self.rng.next() as f32 - 0.5
    }
}

/// Everything about one car that the emitters below read, in the units the
/// solver already publishes.
#[derive(Clone, Copy, Default)]
pub struct CarFx {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub speed: f32,
    pub vx: f32,
    pub vz: f32,
    pub drift: f32,
    /// Signed wheel spin. The MAGNITUDE of a slip ratio is as large under
    /// braking as under power and only one of those makes smoke - see the note
    /// in `Fx.emit`.
    pub spin_fx: f32,
    /// The raceMode speed multiplier, 1.0 on the stock engine.
    pub race_mode: f32,
    pub scrape: f32,
    pub lateral: f32,
    /// The road height under the car this frame, not the world plane: a spark
    /// on Chapter 7's deck is twenty-six units above it.
    pub surf_y: f32,
    pub boosting: bool,
    pub is_player: bool,
}

impl Particles {
    /// Write one particle at the round-robin cursor and advance it.
    ///
    /// Deliberately the same cursor JavaScript's `spawn` uses - it is passed in
    /// and handed back - so the two paths share one ring and neither can
    /// overwrite the other's newest work.
    #[allow(clippy::too_many_arguments)]
    #[inline]
    fn put(
        &mut self,
        next: &mut usize,
        x: f32, y: f32, z: f32,
        vx: f32, vy: f32, vz: f32,
        life: f32, size: f32, grow: f32, drag: f32, gravity: f32,
        stretch: f32, floor: f32,
        r: f32, g: f32, b: f32, a: f32,
    ) {
        if self.max == 0 {
            return;
        }
        let o = *next * STRIDE;
        *next = (*next + 1) % self.max;
        let q = &mut self.p[o..o + STRIDE];
        q[f::LIFE] = life;
        q[f::MAX] = life;
        q[f::X] = x;
        q[f::Y] = y;
        q[f::Z] = z;
        q[f::VX] = vx;
        q[f::VY] = vy;
        q[f::VZ] = vz;
        q[f::SIZE] = size;
        q[f::GROW] = grow;
        q[f::DRAG] = drag;
        q[f::GRAVITY] = gravity;
        q[f::STRETCH] = stretch;
        q[f::FLOOR] = floor;
        q[f::R] = r;
        q[f::G] = g;
        q[f::B] = b;
        q[f::A] = a;
    }

    /// One frame of every continuous emitter for one car.
    ///
    /// `density` is the PARTICLE DENSITY row: a multiplier on the rates, never
    /// on the budget. Returns the cursor for the caller to carry.
    pub fn emit(
        &mut self,
        e: &mut Emitter,
        c: &CarFx,
        dt: f32,
        density: f32,
        next: usize,
    ) -> usize {
        let mut n = next;
        let sy = c.yaw.sin();
        let cy = c.yaw.cos();
        // 0 at the stock engine, 1 at raceMode's full multiplier
        let race = ((c.race_mode - 1.0) / 0.5).clamp(0.0, 1.0);

        // ---- tyre smoke, from the rears, sliding or spinning UP -----------
        //
        // Reading the magnitude of the slip ratio put smoke on the road every
        // time the car was braked hard, because a wheel being braked has just
        // as large a slip ratio as one being spun. `spin_fx` is the signed one.
        let slide = c.drift.max(c.spin_fx);
        if slide > 0.12 && c.speed > 4.0 {
            e.smoke += dt * (18.0 + slide * 70.0) * density;
            // the rear contact patches, on the road the car is standing on
            let py = c.surf_y + 0.12;
            let alpha = 0.55 * (slide * 1.6).min(1.0);
            while e.smoke > 1.0 {
                e.smoke -= 1.0;
                let lx = if e.u() < 0.5 { -1.1 } else { 1.1 };
                let lz = -1.88;
                let px = c.x + cy * lx + sy * lz;
                let pz = c.z - sy * lx + cy * lz;
                self.put(
                    &mut n,
                    px + e.s() * 0.8,
                    py + e.u() * 0.3,
                    pz + e.s() * 0.8,
                    -sy * c.speed * 0.10 + e.s() * 3.5,
                    1.4 + e.u() * 2.2,
                    -cy * c.speed * 0.10 + e.s() * 3.5,
                    0.75 + e.u() * 0.8,
                    1.4, 6.5, 1.4, 0.0, 0.0,
                    py - 0.07,
                    // lit by the neon around it rather than plain grey
                    0.62, 0.55, 0.85, alpha,
                );
            }
        }

        // ---- the twin afterburner -----------------------------------------
        //
        // Two nozzles, measured off the exhaust mesh at (+-0.62, -0.66, -2.65)
        // in body space. A reheat plume is a stretched cone with a white-blue
        // core fading through cyan into deep violet, punctuated by shock
        // diamonds where the flow goes supersonic - not a cloud, which is why
        // every sprite is elongated along its own velocity.
        //
        // The gas leaves the nozzle fast RELATIVE TO THE CAR, so in world terms
        // it still travels forwards, just slower than the car does: the car
        // pulls away from its own plume and leaves it hanging in the air.
        // Firing it backwards through the world instead would throw it out of
        // the back at twice the closing speed, which is not what an exhaust
        // does at 160 km/h.
        if c.boosting {
            let ny = c.y - 0.66;
            let bx = -sy;
            let bz = -cy;
            let mut side = -1.0f32;
            while side <= 1.0 {
                let lx = side * 0.62;
                let lz = -2.65;
                let nx = c.x + cy * lx + sy * lz;
                let nz = c.z - sy * lx + cy * lz;

                // white-blue core: fast, tiny, gone almost at once
                let cores = if race > 0.5 { 4 } else { 3 };
                for _ in 0..cores {
                    let sp = 30.0 + race * 18.0 + e.u() * 26.0;
                    self.put(
                        &mut n,
                        nx + e.s() * 0.18,
                        ny + e.s() * 0.14,
                        nz + e.s() * 0.18,
                        c.vx + bx * sp + e.s() * 1.2,
                        e.s() * 0.7,
                        c.vz + bz * sp + e.s() * 1.2,
                        0.10 + race * 0.035 + e.u() * 0.07,
                        0.34 + race * 0.04, 0.8, 2.2, 0.0,
                        8.0 + race * 1.5, -1e9,
                        0.58 - race * 0.34, 0.84 - race * 0.08, 1.00,
                        1.75 - race * 0.40,
                    );
                }
                // the cyan body of the flame
                for _ in 0..3 {
                    let sp = 17.0 + race * 14.0 + e.u() * 18.0;
                    self.put(
                        &mut n,
                        nx + e.s() * 0.3,
                        ny + e.s() * 0.22,
                        nz + e.s() * 0.3,
                        c.vx + bx * sp + e.s() * 2.4,
                        0.25 + e.s() * 1.1,
                        c.vz + bz * sp + e.s() * 2.4,
                        0.20 + race * 0.06 + e.u() * 0.12,
                        0.50, 2.4, 1.9, 0.0, 5.5 + race, -1e9,
                        0.14 - race * 0.11, 0.50 - race * 0.10, 1.00,
                        1.15 - race * 0.16,
                    );
                }
                // and the violet tail it dissolves into
                if e.u() < 0.75 {
                    let sp = 10.0 + e.u() * 12.0;
                    self.put(
                        &mut n,
                        nx + e.s() * 0.4,
                        ny + e.s() * 0.3,
                        nz + e.s() * 0.4,
                        c.vx + bx * sp + e.s() * 3.4,
                        0.6 + e.u() * 1.2,
                        c.vz + bz * sp + e.s() * 3.4,
                        0.34 + e.u() * 0.22,
                        0.72, 3.8, 1.6, 0.0, 2.6, -1e9,
                        0.24 - race * 0.16, 0.18 + race * 0.08, 0.92 + race * 0.08,
                        0.52,
                    );
                }
                // shock diamonds: bright knots at fixed stations down the plume
                for k in 1..=3 {
                    if e.u() > 0.5 {
                        continue;
                    }
                    let kf = k as f32;
                    let d = kf * 0.85 + e.u() * 0.12;
                    self.put(
                        &mut n,
                        nx + bx * d, ny, nz + bz * d,
                        c.vx + bx * 18.0, 0.0, c.vz + bz * 18.0,
                        0.05, 0.26 - kf * 0.045, 0.0, 3.0, 0.0, 2.0, -1e9,
                        0.72, 0.90, 1.00, 1.15 - kf * 0.28,
                    );
                }
                side += 2.0;
            }
        }

        // ---- scraping the barrier -----------------------------------------
        //
        // A continuous shower off whichever flank is against the wall, for as
        // long as it is.
        if c.scrape > 0.06 {
            e.spark += dt * c.scrape * 220.0 * density;
            let side = if c.lateral >= 0.0 { 1.0 } else { -1.0 };
            let floor = c.surf_y + 0.05;
            while e.spark > 1.0 {
                e.spark -= 1.0;
                let along = e.s() * 3.2;
                let a = e.u() * core::f32::consts::TAU;
                let sp = 5.0 + e.u() * 20.0 * c.scrape;
                self.put(
                    &mut n,
                    c.x + cy * side * 1.12 + sy * along,
                    c.y - 0.66 + e.u() * 0.7,
                    c.z - sy * side * 1.12 + cy * along,
                    -sy * c.speed * 0.42 - cy * side * sp * 0.5 + a.cos() * sp * 0.3,
                    a.sin().abs() * sp * 0.6,
                    -cy * c.speed * 0.42 + sy * side * sp * 0.5 + a.sin() * sp * 0.3,
                    0.22 + e.u() * 0.34,
                    0.20 + 0.12 * c.scrape, -0.15, 1.2, -24.0, 6.0, floor,
                    1.0, 0.66 + e.u() * 0.30, 0.24, 1.6,
                );
            }
        }

        // ---- dust and grit whipping past ----------------------------------
        //
        // A camera effect, so only the car being followed makes it.
        if c.is_player && c.speed > 26.0 {
            e.dust += dt * (c.speed - 20.0) * 1.6 * density;
            let base = c.surf_y;
            while e.dust > 1.0 {
                e.dust -= 1.0;
                let side = e.s() * 78.0;
                let ahead = 26.0 + e.u() * 34.0;
                self.put(
                    &mut n,
                    c.x + cy * side + sy * ahead,
                    base + 0.4 + e.u() * 5.5,
                    c.z - sy * side + cy * ahead,
                    -sy * 3.0, 0.4, -cy * 3.0,
                    0.5 + e.u() * 0.4,
                    0.22, 0.1, 0.2, 0.0, 0.0, base + 0.05,
                    0.55, 0.8, 1.0, 0.5,
                );
            }
        }

        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(ps: &mut Particles, life: f32, size: f32) {
        ps.p[f::LIFE] = life;
        ps.p[f::MAX] = life;
        ps.p[f::SIZE] = size;
        ps.p[f::A] = 1.0;
        ps.p[f::DRAG] = 0.0;
    }

    /// A particle has to age, move, and stop being counted when it expires.
    #[test]
    fn a_particle_lives_and_dies() {
        let mut ps = Particles::default();
        ps.reset(4);
        one(&mut ps, 1.0, 1.0);
        ps.p[f::VX] = 10.0;
        ps.p[f::FLOOR] = -1e9;
        assert_eq!(ps.integrate(0.5), 1);
        assert!((ps.p[f::X] - 5.0).abs() < 1e-4, "x is {}", ps.p[f::X]);
        // ...and past its life it is gone, and stays gone
        assert_eq!(ps.integrate(0.6), 0);
        assert_eq!(ps.integrate(0.1), 0);
    }

    /// The floor is the particle's own, not the world plane. This is the bug
    /// the field exists for: a spark on an elevated deck must not fall through
    /// it, and one in a dip must not bounce in mid air.
    #[test]
    fn a_particle_lands_on_its_own_floor() {
        let mut ps = Particles::default();
        ps.reset(2);
        one(&mut ps, 5.0, 1.0);
        ps.p[f::Y] = 30.0;
        ps.p[f::VY] = -40.0;
        ps.p[f::FLOOR] = 26.0;
        for _ in 0..30 {
            ps.integrate(1.0 / 60.0);
        }
        assert!(ps.p[f::Y] >= 26.0 - 1e-4, "fell through its floor to {}", ps.p[f::Y]);
    }

    /// Six vertices per live particle, none for a dead or zero-sized one, and
    /// the quad has to have area - a builder that writes six identical points
    /// produces no pixels and looks exactly like a working particle system
    /// that is simply not spawning.
    #[test]
    fn build_emits_a_quad_with_area() {
        let mut ps = Particles::default();
        ps.reset(3);
        one(&mut ps, 1.0, 2.0);
        ps.p[f::MAX] = 1.0;
        let n = ps.build([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
        assert_eq!(n, VERTS_PER, "one live particle should be six vertices");
        let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
        for v in 0..VERTS_PER {
            let x = ps.out[v * VERT_FLOATS];
            lo = lo.min(x);
            hi = hi.max(x);
        }
        assert!((hi - lo - 2.0).abs() < 1e-4, "quad spans {} not 2.0", hi - lo);
        // a dead one contributes nothing
        ps.p[f::LIFE] = 0.0;
        assert_eq!(ps.build([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]), 0);
    }

    // ------------------------------------------------------- the emitters --

    /// A car that is doing nothing in particular: on the road, moving, not
    /// sliding, not boosting and not against a wall.
    fn idle_car() -> CarFx {
        CarFx { speed: 10.0, race_mode: 1.0, ..Default::default() }
    }

    fn live(ps: &Particles) -> usize {
        (0..ps.max).filter(|i| ps.p[i * STRIDE + f::LIFE] > 0.0).count()
    }

    /// Nothing happens until something is actually happening. Every one of
    /// these emitters has a threshold, and a car rolling down a straight must
    /// not be laying smoke or throwing sparks.
    #[test]
    fn a_quiet_car_emits_nothing() {
        let mut ps = Particles::default();
        ps.reset(256);
        let mut e = Emitter::new(1);
        let c = idle_car();
        let mut n = 0;
        for _ in 0..120 {
            n = ps.emit(&mut e, &c, 1.0 / 60.0, 1.0, n);
        }
        assert_eq!(live(&ps), 0, "a car doing nothing emitted something");
        assert_eq!(n, 0, "the cursor moved without a particle being written");
    }

    /// THE WHOLE REASON THE ACCUMULATORS PERSIST.
    ///
    /// A rate is particles per SECOND, so the same second of driving has to
    /// produce the same number of them whether it arrived in 30 frames or in
    /// 240. A version that dropped the remainder each frame would emit far
    /// too few at a high frame rate - which is the bug that is invisible on
    /// the machine it is written on and obvious on a fast one.
    #[test]
    fn a_rate_is_per_second_not_per_frame() {
        let counts: Vec<usize> = [30usize, 60, 144].iter().map(|hz| {
            let mut ps = Particles::default();
            ps.reset(4096);
            let mut e = Emitter::new(7);
            // sliding hard enough to smoke, and moving
            let c = CarFx { speed: 40.0, drift: 0.5, race_mode: 1.0, ..Default::default() };
            let dt = 1.0 / (*hz as f32);
            let mut n = 0;
            let mut total = 0usize;
            for _ in 0..*hz {
                let before = n;
                n = ps.emit(&mut e, &c, dt, 1.0, n);
                // the ring is far larger than one second of this rate, so the
                // cursor only ever moves forward here
                total += n.wrapping_sub(before);
            }
            total
        }).collect();
        // 18 + 0.5*70 = 53 a second; the remainder carried across frames means
        // every rate lands within one particle of it
        for (i, c) in counts.iter().enumerate() {
            assert!((*c as i32 - 53).abs() <= 1,
                "rate {} gave {} particles in a second, expected 53", i, c);
        }
        assert!(counts.windows(2).all(|w| (w[0] as i32 - w[1] as i32).abs() <= 1),
            "frame rate changed the number of particles: {:?}", counts);
    }

    /// PARTICLE DENSITY scales the rate and nothing else.
    #[test]
    fn density_scales_the_rate() {
        let run = |density: f32| {
            let mut ps = Particles::default();
            ps.reset(4096);
            let mut e = Emitter::new(11);
            let c = CarFx { speed: 40.0, drift: 0.5, race_mode: 1.0, ..Default::default() };
            let mut n = 0;
            let mut total = 0usize;
            for _ in 0..60 {
                let before = n;
                n = ps.emit(&mut e, &c, 1.0 / 60.0, density, n);
                total += n.wrapping_sub(before);
            }
            total
        };
        let half = run(0.45);
        let full = run(1.0);
        let more = run(1.6);
        assert!(half < full && full < more,
            "density did not order the rates: {} {} {}", half, full, more);
        // and it is a multiplier, not a curve
        assert!(((half as f32) / (full as f32) - 0.45).abs() < 0.06,
            "LOW is {} of NORMAL, expected about 0.45", (half as f32) / (full as f32));
    }

    /// SMOKE LANDS ON THE ROAD THE CAR IS STANDING ON, not on the world plane.
    ///
    /// This is the elevated-route bug the `floor` field exists for: Chapter 7's
    /// deck is twenty-six units above zero, and a puff given the world plane as
    /// its floor falls straight through the tarmac it was thrown from.
    #[test]
    fn smoke_sits_on_the_deck_it_was_thrown_from() {
        let mut ps = Particles::default();
        ps.reset(512);
        let mut e = Emitter::new(3);
        const DECK: f32 = 26.0;
        let c = CarFx {
            speed: 40.0, drift: 0.5, race_mode: 1.0, surf_y: DECK,
            y: DECK + 1.05, ..Default::default()
        };
        ps.emit(&mut e, &c, 0.5, 1.0, 0);
        let mut seen = 0;
        for i in 0..ps.max {
            let b = i * STRIDE;
            if ps.p[b + f::LIFE] <= 0.0 { continue; }
            seen += 1;
            assert!(ps.p[b + f::Y] > DECK,
                "a puff was emitted at y {} below the deck at {}", ps.p[b + f::Y], DECK);
            assert!(ps.p[b + f::FLOOR] > DECK - 1.0,
                "a puff's floor is {} - it will fall through the deck", ps.p[b + f::FLOOR]);
        }
        assert!(seen > 0, "nothing was emitted at all");
    }

    /// The grit is a CAMERA effect, so only the car being followed makes it.
    /// Every other car on the road throwing it would put a dust storm in front
    /// of a lens that is nowhere near them.
    #[test]
    fn only_the_followed_car_throws_grit() {
        let run = |is_player: bool| {
            let mut ps = Particles::default();
            ps.reset(2048);
            let mut e = Emitter::new(5);
            let c = CarFx { speed: 60.0, race_mode: 1.0, is_player, ..Default::default() };
            ps.emit(&mut e, &c, 0.5, 1.0, 0);
            live(&ps)
        };
        assert_eq!(run(false), 0, "a car nobody is watching threw grit past the lens");
        assert!(run(true) > 0, "the followed car threw no grit at 60 units a second");
    }

    /// The cursor is the CALLER's, carried in and out, so the one-off effects
    /// JavaScript still spawns share one ring with these. It must wrap rather
    /// than run off the end of the buffer.
    #[test]
    fn the_cursor_is_carried_and_wraps() {
        let mut ps = Particles::default();
        ps.reset(8);
        let mut e = Emitter::new(13);
        let c = CarFx { speed: 40.0, drift: 0.9, race_mode: 1.0, ..Default::default() };
        let mut n = 5;
        for _ in 0..20 {
            n = ps.emit(&mut e, &c, 1.0 / 60.0, 1.0, n);
            assert!(n < ps.max, "the cursor left the buffer: {} of {}", n, ps.max);
        }
    }

    /// Two cars must not share a stream. They are emitted one after the other
    /// from the same frame with the same state, and if they shared a generator
    /// the second would continue the first's sequence rather than having one -
    /// which is fine, and is NOT what a per-car Emitter is for: a car that
    /// stops emitting must not shift every other car's scatter.
    #[test]
    fn each_car_has_its_own_stream() {
        let c = CarFx { speed: 40.0, drift: 0.9, race_mode: 1.0, ..Default::default() };
        let first = |seed: u32| {
            let mut ps = Particles::default();
            ps.reset(64);
            let mut e = Emitter::new(seed);
            ps.emit(&mut e, &c, 0.2, 1.0, 0);
            ps.p[f::X]
        };
        assert!((first(1) - first(2)).abs() > 1e-6,
            "two seeds scattered the first puff to the same place");
    }

    /// The afterburner exists only while the boost is lit, and it is TWO
    /// nozzles - a plume that comes out of one is the single most obvious
    /// thing that can be wrong with it from behind.
    #[test]
    fn the_afterburner_has_two_nozzles() {
        let mut ps = Particles::default();
        ps.reset(512);
        let mut e = Emitter::new(17);
        let cold = CarFx { speed: 40.0, race_mode: 1.0, ..Default::default() };
        ps.emit(&mut e, &cold, 1.0 / 60.0, 1.0, 0);
        assert_eq!(live(&ps), 0, "the plume lit with the boost off");

        let hot = CarFx { speed: 40.0, race_mode: 1.0, boosting: true, ..Default::default() };
        ps.emit(&mut e, &hot, 1.0 / 60.0, 1.0, 0);
        // the car faces +z, so the nozzles are offset on x either side of it
        let (mut l, mut r) = (0, 0);
        for i in 0..ps.max {
            let b = i * STRIDE;
            if ps.p[b + f::LIFE] <= 0.0 { continue; }
            if ps.p[b + f::X] < 0.0 { l += 1; } else { r += 1; }
        }
        assert!(l > 0 && r > 0, "the plume came out of one nozzle: {} left, {} right", l, r);
    }
}
