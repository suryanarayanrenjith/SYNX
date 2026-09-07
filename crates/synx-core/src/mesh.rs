//! World meshing: the geometry arena, and the landscape's distance field.
//!
//! `js/scene.js` generates the whole world the shipped data does not contain -
//! eighty kilometres of road surface, barriers, neon caps, tunnel bores,
//! gantries, towers, ruins and a volcano - and it was the single most
//! expensive thing the game did, at about 1.36 seconds of pure CPU before a
//! frame had ever been drawn. Two things in it dominate, and both are here.
//!
//! # The arena
//!
//! Every one of the roughly two million vertices was appended with
//! `V.push(x, y, z, nx, ny, nz, u, v)` into an ordinary JavaScript array. That
//! is eight boxed appends and, every so often, a reallocation and copy of a
//! multi-megabyte array - and at the end the whole thing had to be converted
//! to a `Float32Array` before WebGL would look at it.
//!
//! [`Arena`] is that buffer, owned here. JavaScript maps it as a typed array
//! and writes vertices straight into it, so an append is eight float stores
//! into memory the GPU upload can read directly. Nothing is converted and
//! nothing is copied.
//!
//! # The distance field
//!
//! The landscape needs to know, for any point, how far it is from the road and
//! which part of the road that was - to cut the corridor, to place the verge,
//! and to decide which country it is in. `js/scene.js` answers that with a
//! uniform grid of "nearest centreline sample", stamped by walking the road
//! and marking a disc around every second sample.
//!
//! At a 2,000-unit reach over 120-unit cells that disc is 41 cells across, and
//! there are fourteen thousand of them to stamp: **twenty-four million** inner
//! iterations, which is most of the landscape's 638 ms. It is also perfectly
//! ordinary numeric work with no art direction in it at all, which makes it
//! exactly the right thing to move.

use crate::track::Centreline;

/// A growable interleaved vertex buffer plus its index buffer.
///
/// The vertex layout is the one `js/scene.js` has always used and the one the
/// scene VAO is set up for: position, normal, uv - eight floats, 32 bytes.
pub const VERTEX_FLOATS: usize = 8;

#[derive(Default)]
pub struct Arena {
    pub verts: Vec<f32>,
    pub idx: Vec<u32>,
}

impl Arena {
    /// Reserve room for a build. Called with a generous estimate so the common
    /// case never reallocates at all; growth still works if it is wrong.
    pub fn reset(&mut self, vert_cap: usize, idx_cap: usize) {
        self.verts.clear();
        self.idx.clear();
        self.verts.reserve_exact(vert_cap.saturating_sub(self.verts.capacity()));
        self.idx.reserve_exact(idx_cap.saturating_sub(self.idx.capacity()));
        // The JavaScript side writes through a typed-array view and moves its
        // own cursor, so the vectors are given their full length up front and
        // trimmed to the cursor when the build finishes.
        self.verts.resize(vert_cap, 0.0);
        self.idx.resize(idx_cap, 0);
    }

    /// Make room for at least `n` more floats, returning whether the buffer
    /// moved (which detaches any JavaScript view over it).
    pub fn grow_verts(&mut self, n: usize) -> bool {
        let want = self.verts.len() + n;
        let before = self.verts.as_ptr();
        self.verts.resize(want.next_power_of_two().max(1024), 0.0);
        before != self.verts.as_ptr()
    }

    pub fn grow_idx(&mut self, n: usize) -> bool {
        let want = self.idx.len() + n;
        let before = self.idx.as_ptr();
        self.idx.resize(want.next_power_of_two().max(1024), 0);
        before != self.idx.as_ptr()
    }
}

/// Merging a small mesh into a big one, many thousands of times.
///
/// # Why this is here
///
/// Chapter 7's world is built out of instanced boxes - every barrier post,
/// reflective stud, drain grate, sign gantry, building body and window shell -
/// and drawing each one as its own call would be several thousand draws a
/// frame. So they are BAKED: the box's twenty-four vertices are transformed by
/// the instance's matrix and appended to a per-chunk, per-material buffer, and
/// what the frame submits is one call per material per chunk.
///
/// That bake is about twenty thousand instances, which is half a million
/// vertex transforms and two million float appends, and in JavaScript it was
/// the single most expensive thing left in the route's load:
///
/// ```text
///     for (let i = 0; i < srcV.length; i += 8) {
///       const px = m[0]*x + m[4]*y + m[8]*z + m[12];   // ...and five more
///       g.V.push(px, py, pz, qx, qy, qz, u, v);        // eight boxed appends
///     }
/// ```
///
/// It is also perfectly ordinary arithmetic with no art direction in it, which
/// is exactly the shape of thing that belongs in here rather than there.
///
/// # The shape of the call
///
/// The caller uploads the source mesh once, then a block of 4x4 matrices, then
/// asks for the bake. Everything comes back in the shared [`Arena`], so the
/// vertex data goes from here into `gl.bufferData` without being copied.
#[derive(Default)]
pub struct Baker {
    /// The source mesh: interleaved position/normal/uv, [`VERTEX_FLOATS`] each.
    pub src_v: Vec<f32>,
    pub src_i: Vec<u32>,
    /// One column-major 4x4 per instance.
    pub mats: Vec<f32>,
}

impl Baker {
    pub fn set_source(&mut self, verts: usize, indices: usize) {
        self.src_v.clear();
        self.src_v.resize(verts, 0.0);
        self.src_i.clear();
        self.src_i.resize(indices, 0);
    }

    pub fn set_instances(&mut self, n: usize) {
        self.mats.clear();
        self.mats.resize(n * 16, 0.0);
    }

    /// Transform every instance into `out`, and return the vertex count.
    ///
    /// The normal is transformed by the upper 3x3 and renormalised rather than
    /// by the inverse transpose. Every matrix this is ever handed is a
    /// translation, a rotation and a per-axis scale (see `scaled` in
    /// js/chapters.js); for a NON-UNIFORM scale the two differ, and the
    /// difference is a normal that leans the wrong way on a stretched box.
    /// The JavaScript this replaces made the same approximation, deliberately:
    /// these are boxes, their faces are axis-aligned in local space, and for an
    /// axis-aligned face under an axis-aligned scale the two agree exactly.
    pub fn bake(&self, out: &mut Arena) -> usize {
        let vstride = VERTEX_FLOATS;
        let per_vert = self.src_v.len() / vstride;
        let n = self.mats.len() / 16;
        let total_v = per_vert * n;
        let total_i = self.src_i.len() * n;
        out.verts.clear();
        out.idx.clear();
        out.verts.reserve(total_v * vstride);
        out.idx.reserve(total_i);

        for i in 0..n {
            let m = &self.mats[i * 16..i * 16 + 16];
            let base = (i * per_vert) as u32;
            for v in 0..per_vert {
                let o = v * vstride;
                let (x, y, z) = (self.src_v[o], self.src_v[o + 1], self.src_v[o + 2]);
                let (nx, ny, nz) = (self.src_v[o + 3], self.src_v[o + 4], self.src_v[o + 5]);
                out.verts.push(m[0] * x + m[4] * y + m[8] * z + m[12]);
                out.verts.push(m[1] * x + m[5] * y + m[9] * z + m[13]);
                out.verts.push(m[2] * x + m[6] * y + m[10] * z + m[14]);
                let qx = m[0] * nx + m[4] * ny + m[8] * nz;
                let qy = m[1] * nx + m[5] * ny + m[9] * nz;
                let qz = m[2] * nx + m[6] * ny + m[10] * nz;
                let inv = 1.0 / (qx * qx + qy * qy + qz * qz).sqrt().max(1e-6);
                out.verts.push(qx * inv);
                out.verts.push(qy * inv);
                out.verts.push(qz * inv);
                out.verts.push(self.src_v[o + 6]);
                out.verts.push(self.src_v[o + 7]);
            }
            for k in 0..self.src_i.len() {
                out.idx.push(base + self.src_i[k]);
            }
        }
        total_v
    }
}

/// What the landscape asks about a point on the ground.
#[derive(Default)]
pub struct MeshOut {
    pub arena: Arena,
    /// Nearest centreline sample per grid cell, or -1 for "outside the band".
    pub near: Vec<i32>,
    /// Squared distance to that sample, for the stamp's own comparison.
    pub near_d: Vec<f32>,
    pub gw: usize,
    pub gh: usize,
    pub x0: f64,
    pub z0: f64,
    pub cell: f64,
}

/// Grid cell size and search reach, matching `js/scene.js`.
pub const GCELL: f64 = 120.0;
pub const REACH: f64 = 2000.0;

impl MeshOut {
    /// Stamp the nearest-sample grid over the whole course.
    ///
    /// The grid is stamped WIDER than the band that will actually be built. A
    /// cell is chosen by its lower-left corner but drawn from all four, and a
    /// corner that fell outside the stamp had no nearest sample at all - so it
    /// was told it was a very long way from any road, which the height profile
    /// turned into a 190-unit mountain standing on the edge of the world.
    /// Three cells of margin is more than the diagonal of one.
    pub fn stamp(&mut self, c: &Centreline) {
        let (mut x0, mut x1) = (f64::INFINITY, f64::NEG_INFINITY);
        let (mut z0, mut z1) = (f64::INFINITY, f64::NEG_INFINITY);
        for i in 0..c.count {
            if c.x[i] < x0 { x0 = c.x[i]; }
            if c.x[i] > x1 { x1 = c.x[i]; }
            if c.z[i] < z0 { z0 = c.z[i]; }
            if c.z[i] > z1 { z1 = c.z[i]; }
        }
        x0 -= REACH + GCELL;
        z0 -= REACH + GCELL;
        x1 += REACH + GCELL;
        z1 += REACH + GCELL;
        let gw = ((x1 - x0) / GCELL).ceil() as usize + 1;
        let gh = ((z1 - z0) / GCELL).ceil() as usize + 1;

        self.gw = gw;
        self.gh = gh;
        self.x0 = x0;
        self.z0 = z0;
        self.cell = GCELL;
        self.near.clear();
        self.near.resize(gw * gh, -1);
        self.near_d.clear();
        self.near_d.resize(gw * gh, f32::INFINITY);

        let stamp = REACH + GCELL * 3.0;
        let r2 = stamp * stamp;
        let span = (stamp / GCELL).ceil() as i64;

        // Every second sample: the road moves six units a sample and the cells
        // are a hundred and twenty across, so stamping every one of them writes
        // the same answer twice for no benefit.
        let mut i = 0usize;
        while i < c.count {
            let px = c.x[i];
            let pz = c.z[i];
            let cgx = ((px - x0) / GCELL).floor() as i64;
            let cgz = ((pz - z0) / GCELL).floor() as i64;
            for ox in -span..=span {
                let gx = cgx + ox;
                if gx < 0 || gx >= gw as i64 {
                    continue;
                }
                let wx = x0 + gx as f64 * GCELL - px;
                let wx2 = wx * wx;
                // Nothing in this column can be in range, so skip its whole
                // inner loop rather than testing every cell in it.
                if wx2 > r2 {
                    continue;
                }
                let row = gx as usize;
                for oz in -span..=span {
                    let gz = cgz + oz;
                    if gz < 0 || gz >= gh as i64 {
                        continue;
                    }
                    let wz = z0 + gz as f64 * GCELL - pz;
                    let d = wx2 + wz * wz;
                    if d > r2 {
                        continue;
                    }
                    let k = gz as usize * gw + row;
                    if (d as f32) < self.near_d[k] {
                        self.near_d[k] = d as f32;
                        self.near[k] = i as i32;
                    }
                }
            }
            i += 2;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::track::Centreline;

    fn straight(n: usize) -> Centreline {
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

    /// Every cell within reach of the road must know which sample is nearest,
    /// and the answer must actually be the nearest one.
    #[test]
    fn stamp_finds_the_nearest_sample() {
        let c = straight(2000);
        let mut m = MeshOut::default();
        m.stamp(&c);
        assert!(m.gw > 0 && m.gh > 0);

        // a point right beside the road, halfway along it
        let x = 30.0;
        let z = 6000.0;
        let gx = ((x - m.x0) / m.cell).round() as usize;
        let gz = ((z - m.z0) / m.cell).round() as usize;
        let seed = m.near[gz * m.gw + gx];
        assert!(seed >= 0, "a cell beside the road has no nearest sample");
        // the true nearest sample is z/step = 1000
        assert!(
            (seed - 1000).abs() < 40,
            "nearest sample {seed} is not near the true answer of 1000"
        );
    }

    /// The margin exists so that a cell CORNER outside the built band still
    /// has an answer. Without it the height profile builds a mountain there.
    #[test]
    fn stamp_covers_the_margin_beyond_the_reach() {
        let c = straight(2000);
        let mut m = MeshOut::default();
        m.stamp(&c);
        // just inside the reach, plus a cell: must still be stamped
        let x = REACH + GCELL;
        let z = 6000.0;
        let gx = ((x - m.x0) / m.cell).round() as usize;
        let gz = ((z - m.z0) / m.cell).round() as usize;
        assert!(
            m.near[gz * m.gw + gx] >= 0,
            "the margin beyond the reach was not stamped"
        );
    }

    /// A long way out there must be no answer, so the caller can say "rim"
    /// rather than inventing a distance.
    #[test]
    fn stamp_leaves_the_far_field_empty() {
        let c = straight(2000);
        let mut m = MeshOut::default();
        m.stamp(&c);
        let gx = 1usize; // the very edge of the grid
        let gz = 1usize;
        assert_eq!(m.near[gz * m.gw + gx], -1, "the far field was stamped");
    }

    #[test]
    fn arena_grows_without_losing_data() {
        let mut a = Arena::default();
        a.reset(16, 8);
        for (i, v) in a.verts.iter_mut().enumerate() {
            *v = i as f32;
        }
        a.grow_verts(64);
        assert!(a.verts.len() >= 80);
        for i in 0..16 {
            assert_eq!(a.verts[i], i as f32, "growth lost vertex float {i}");
        }
    }
}
