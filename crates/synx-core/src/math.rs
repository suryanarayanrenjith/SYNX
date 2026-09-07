//! Scalar helpers, a column-major 4x4, and the deterministic RNG the course
//! generator is seeded from.
//!
//! Everything here mirrors the semantics of the JavaScript it replaces rather
//! than the semantics Rust would reach for on its own. Two of those matter:
//!
//!   * Angles are wrapped the way `NR.M.angDiff` wraps them, into (-pi, pi].
//!   * `Rng` is Mulberry32 over a `u32`, reproducing `js/track.js`'s generator
//!     exactly - including the `Math.imul` wrap-around, which is a plain
//!     `wrapping_mul` here. The shipped course is one specific seed's output,
//!     so a generator that is merely "as good" would silently deal every
//!     player a different road.

use core::f64::consts::PI;

pub const TAU: f64 = PI * 2.0;

#[inline(always)]
pub fn clamp(v: f64, a: f64, b: f64) -> f64 {
    if v < a {
        a
    } else if v > b {
        b
    } else {
        v
    }
}

#[inline(always)]
pub fn clampf(v: f32, a: f32, b: f32) -> f32 {
    if v < a {
        a
    } else if v > b {
        b
    } else {
        v
    }
}

#[inline(always)]
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// Frame-rate independent exponential approach, as `NR.M.damp`.
#[inline(always)]
pub fn damp(a: f64, b: f64, lambda: f64, dt: f64) -> f64 {
    lerp(a, b, 1.0 - (-lambda * dt).exp())
}

/// Signed shortest angle from `a` to `b`.
#[inline(always)]
pub fn ang_diff(a: f64, b: f64) -> f64 {
    let mut d = (b - a) % TAU;
    if d > PI {
        d -= TAU;
    }
    if d < -PI {
        d += TAU;
    }
    d
}

#[inline(always)]
pub fn smoothstep(t: f64) -> f64 {
    let t = clamp(t, 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// `smoothstep` with explicit edges, matching GLSL's argument order.
#[inline(always)]
pub fn smoothstep_e(e0: f64, e1: f64, x: f64) -> f64 {
    if e1 == e0 {
        return 0.0;
    }
    smoothstep((x - e0) / (e1 - e0))
}

#[inline(always)]
pub fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// Mulberry32, bit-for-bit with the `rng()` in `js/track.js`.
///
/// JavaScript's `Math.imul` is a 32-bit signed multiply that discards the
/// overflow; `wrapping_mul` on `u32` produces the same bit pattern, and the
/// final `>>> 0` division by 2^32 is the same unsigned conversion.
pub struct Rng {
    a: u32,
}

impl Rng {
    #[inline]
    pub fn new(seed: u32) -> Self {
        Rng { a: seed }
    }

    #[inline]
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6D2B_79F5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

// ------------------------------------------------------------------ mat4 ---

/// Column-major 4x4, laid out exactly as the `Float32Array`s `js/gl.js` hands
/// to `uniformMatrix4fv`, so a matrix built here can be uploaded with no
/// transpose and no repack.
pub type Mat4 = [f32; 16];

pub fn identity() -> Mat4 {
    let mut o = [0.0f32; 16];
    o[0] = 1.0;
    o[5] = 1.0;
    o[10] = 1.0;
    o[15] = 1.0;
    o
}

pub fn perspective(o: &mut Mat4, fovy: f32, aspect: f32, near: f32, far: f32) {
    let f = 1.0 / (fovy / 2.0).tan();
    *o = [0.0; 16];
    o[0] = f / aspect;
    o[5] = f;
    o[11] = -1.0;
    o[10] = (far + near) / (near - far);
    o[14] = (2.0 * far * near) / (near - far);
}

/// The world is left-handed (Unity's axes survived the export); clip space is
/// right-handed. Negating clip X is what reconciles them - see the note on
/// `M4.perspectiveLH` in `js/gl.js`.
pub fn perspective_lh(o: &mut Mat4, fovy: f32, aspect: f32, near: f32, far: f32) {
    perspective(o, fovy, aspect, near, far);
    o[0] = -o[0];
}

pub fn look_at(o: &mut Mat4, eye: [f32; 3], center: [f32; 3], up: [f32; 3]) {
    let mut z = [eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]];
    let zl = (z[0] * z[0] + z[1] * z[1] + z[2] * z[2]).sqrt().max(1e-20);
    z = [z[0] / zl, z[1] / zl, z[2] / zl];
    let mut x = [
        up[1] * z[2] - up[2] * z[1],
        up[2] * z[0] - up[0] * z[2],
        up[0] * z[1] - up[1] * z[0],
    ];
    let xl = (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]).sqrt().max(1e-20);
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    let y = [
        z[1] * x[2] - z[2] * x[1],
        z[2] * x[0] - z[0] * x[2],
        z[0] * x[1] - z[1] * x[0],
    ];
    o[0] = x[0];
    o[1] = y[0];
    o[2] = z[0];
    o[3] = 0.0;
    o[4] = x[1];
    o[5] = y[1];
    o[6] = z[1];
    o[7] = 0.0;
    o[8] = x[2];
    o[9] = y[2];
    o[10] = z[2];
    o[11] = 0.0;
    o[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
    o[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
    o[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
    o[15] = 1.0;
}

pub fn mul(o: &mut Mat4, a: &Mat4, b: &Mat4) {
    for c in 0..4 {
        let (b0, b1, b2, b3) = (b[c * 4], b[c * 4 + 1], b[c * 4 + 2], b[c * 4 + 3]);
        o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
}

/// Translate plus yaw/pitch/roll, matching `M4.trs` - the car's own pose.
pub fn trs(o: &mut Mat4, px: f32, py: f32, pz: f32, yaw: f32, pitch: f32, roll: f32) {
    let (cy, sy) = (yaw.cos(), yaw.sin());
    let (cp, sp) = (pitch.cos(), pitch.sin());
    let (cr, sr) = (roll.cos(), roll.sin());
    o[0] = cy * cr + sy * sp * sr;
    o[1] = cp * sr;
    o[2] = -sy * cr + cy * sp * sr;
    o[3] = 0.0;
    o[4] = -cy * sr + sy * sp * cr;
    o[5] = cp * cr;
    o[6] = sy * sr + cy * sp * cr;
    o[7] = 0.0;
    o[8] = sy * cp;
    o[9] = -sp;
    o[10] = cy * cp;
    o[11] = 0.0;
    o[12] = px;
    o[13] = py;
    o[14] = pz;
    o[15] = 1.0;
}

pub fn invert(o: &mut Mat4, m: &Mat4) {
    let (a00, a01, a02, a03) = (m[0], m[1], m[2], m[3]);
    let (a10, a11, a12, a13) = (m[4], m[5], m[6], m[7]);
    let (a20, a21, a22, a23) = (m[8], m[9], m[10], m[11]);
    let (a30, a31, a32, a33) = (m[12], m[13], m[14], m[15]);
    let b00 = a00 * a11 - a01 * a10;
    let b01 = a00 * a12 - a02 * a10;
    let b02 = a00 * a13 - a03 * a10;
    let b03 = a01 * a12 - a02 * a11;
    let b04 = a01 * a13 - a03 * a11;
    let b05 = a02 * a13 - a03 * a12;
    let b06 = a20 * a31 - a21 * a30;
    let b07 = a20 * a32 - a22 * a30;
    let b08 = a20 * a33 - a23 * a30;
    let b09 = a21 * a32 - a22 * a31;
    let b10 = a21 * a33 - a23 * a31;
    let b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if det == 0.0 {
        *o = identity();
        return;
    }
    let d = 1.0 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
    o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
    o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
    o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
    o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
    o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
    o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
    o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
    o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
}

/// Radical-inverse Halton, the TAA jitter sequence.
pub fn halton(index: u32, base: u32) -> f32 {
    let mut f = 1.0f64;
    let mut r = 0.0f64;
    let mut i = index;
    let b = base as f64;
    while i > 0 {
        f /= b;
        r += f * ((i % base) as f64);
        i /= base;
    }
    r as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first draws of the shipped course seed, captured from the
    /// JavaScript generator in `js/track.js`. These have to match to the last
    /// bit: the road every player drives is one specific seed's output, so a
    /// generator that is merely "as good" silently deals a different course.
    #[test]
    fn mulberry32_matches_js_bit_for_bit() {
        let mut r = Rng::new(0x5DD24D);
        let got: Vec<f64> = (0..8).map(|_| r.next()).collect();
        let want = [
            0.031677344581112266,
            0.25704666483215988,
            0.71377198398113251,
            0.87619584100320935,
            0.88192896894179285,
            0.26753383059985936,
            0.73877380508929491,
            0.43898680713027716,
        ];
        assert_eq!(got, want, "course RNG diverged from js/track.js");

        // ...and the Level 5 extension's seed, which continues the road from
        // the legacy 80 km endpoint.
        let mut r1 = Rng::new(1);
        let got1: Vec<f64> = (0..3).map(|_| r1.next()).collect();
        assert_eq!(
            got1,
            [
                0.62707394058816135,
                0.0027357211802154779,
                0.52744703995995224
            ]
        );
    }

    #[test]
    fn ang_diff_wraps_the_short_way() {
        let e = 1e-12;
        assert!((ang_diff(0.1, 0.2) - 0.1).abs() < e);
        assert!((ang_diff(3.1, -3.1) - (TAU - 6.2)).abs() < 1e-9);
        assert!(ang_diff(0.0, PI + 0.5) < 0.0, "just past pi turns the other way");
    }

    #[test]
    fn invert_round_trips() {
        let mut m = identity();
        trs(&mut m, 3.0, -2.0, 7.0, 0.4, 0.1, -0.2);
        let mut inv = identity();
        invert(&mut inv, &m);
        let mut r = identity();
        mul(&mut r, &m, &inv);
        for (i, v) in r.iter().enumerate() {
            let want = if i % 5 == 0 { 1.0 } else { 0.0 };
            assert!((v - want).abs() < 1e-4, "element {i} = {v}");
        }
    }
}
