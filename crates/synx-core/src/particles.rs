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
}
