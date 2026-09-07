//! Turning trails of world-space nodes into camera-facing strips.
//!
//! # What this is, and why it is not in JavaScript
//!
//! Every car in the game drops two light trails off its tail lamps and four
//! tyre marks under its wheels, and each of those is a ring buffer of up to a
//! hundred and seventy nodes that has to be rebuilt into triangles **every
//! frame**: gather the live nodes in order, smooth the polyline twice so the
//! light does not bend in facets, then for each segment work out a side vector
//! - billboarded about the trail's own length for a light trail, flat in the
//! ground plane for a tyre mark - and emit six vertices of nine floats.
//!
//! Two cars is twelve ribbons, about thirteen hundred quads, and seventy
//! thousand float writes a frame. That much is merely work. What made it worth
//! moving is the ALLOCATION: the JavaScript version built nine ordinary arrays
//! per ribbon to gather the nodes into, which is a hundred and eight array
//! allocations every frame, for the whole length of a race. That is not a
//! frame-time cost so much as a promise of a garbage collection at an
//! unpredictable moment, and a hitch in a racing game is worse than a
//! uniformly slower frame.
//!
//! Here the gather is a slice of a scratch buffer that is allocated once, the
//! output is written straight into the buffer the vertex upload reads, and the
//! whole thing costs nothing per frame that it did not cost last frame.
//!
//! # The layout
//!
//! A node is ten floats, exactly as `js/fx.js` writes them:
//!
//! ```text
//!     0 1 2   position
//!     3       width
//!     4 5 6 7 colour rgba
//!     8       age in seconds
//!     9       live flag
//! ```
//!
//! and a vertex is nine: position, uv, colour rgba. Neither layout is chosen
//! here - both are the ones the ribbon shader has always been fed.

/// Floats per node in the ring buffer.
pub const NODE_STRIDE: usize = 10;
/// Floats per emitted vertex: pos.xyz, uv.xy, rgba.
pub const VERT_FLOATS: usize = 9;
/// Six vertices - two triangles - per segment.
pub const VERTS_PER_QUAD: usize = 6;

#[derive(Default)]
pub struct Ribbons {
    /// One ribbon's nodes, written by the caller before each strip.
    pub nodes: Vec<f32>,
    /// The finished vertex data, for `gl.bufferSubData`.
    pub out: Vec<f32>,
    /// How many quads are in `out`.
    pub quads: usize,
    /// The gather scratch: x, y, z, w, r, g, b, a, life per live node.
    gx: Vec<f32>,
    gy: Vec<f32>,
    gz: Vec<f32>,
    gw: Vec<f32>,
    gr: Vec<f32>,
    gg: Vec<f32>,
    gb: Vec<f32>,
    ga: Vec<f32>,
    gt: Vec<f32>,
}

impl Ribbons {
    /// Start a frame. `cap` is how many quads the output buffer may hold.
    pub fn begin(&mut self, cap_quads: usize) {
        let want = cap_quads * VERTS_PER_QUAD * VERT_FLOATS;
        if self.out.len() < want {
            self.out.resize(want, 0.0);
        }
        self.quads = 0;
    }

    /// Reserve room for one ribbon's nodes, for the caller to write into.
    pub fn nodes_for(&mut self, count: usize) -> &mut [f32] {
        let want = count * NODE_STRIDE;
        if self.nodes.len() < want {
            self.nodes.resize(want, 0.0);
        }
        &mut self.nodes[..want]
    }

    /// Build one ribbon's strip and append it.
    ///
    /// `count`, `head` and `max` describe the ring buffer exactly as
    /// `Ribbon.forEach` walks it: while the buffer has not wrapped the live
    /// nodes are simply 0..count, and once it has, the oldest is the one after
    /// the head. `life` turns a node's age into the taper the trail ends on.
    ///
    /// Returns how many quads were added.
    #[allow(clippy::too_many_arguments)]
    pub fn strip(
        &mut self,
        count: usize,
        head: usize,
        max: usize,
        life: f32,
        ground: bool,
        cam: [f32; 3],
        cap_quads: usize,
    ) -> usize {
        // --- gather, oldest to newest, skipping the dead -------------------
        self.gx.clear(); self.gy.clear(); self.gz.clear(); self.gw.clear();
        self.gr.clear(); self.gg.clear(); self.gb.clear(); self.ga.clear();
        self.gt.clear();
        for k in 0..count {
            let i = if count < max { k } else { (head + 1 + k) % max };
            let o = i * NODE_STRIDE;
            if self.nodes[o + 9] < 0.5 {
                continue;
            }
            self.gx.push(self.nodes[o]);
            self.gy.push(self.nodes[o + 1]);
            self.gz.push(self.nodes[o + 2]);
            self.gw.push(self.nodes[o + 3]);
            self.gr.push(self.nodes[o + 4]);
            self.gg.push(self.nodes[o + 5]);
            self.gb.push(self.nodes[o + 6]);
            self.ga.push(self.nodes[o + 7]);
            self.gt.push(1.0 - self.nodes[o + 8] / life);
        }
        let n = self.gx.len();
        if n < 2 {
            return 0;
        }

        /* One smoothing pass over the interior, twice.
         *
         * Nodes are dropped when the car has travelled far enough, so they are
         * laid down at whatever the suspension and the steering were doing at
         * that instant - a trail through a corner is a polyline with a visible
         * kink at every node. A three-tap average takes the kinks out without
         * moving the line. The two ends are left alone: the newest is welded
         * to the lamp and must not drift off it, and the oldest is about to
         * die. */
        for _ in 0..2 {
            let (mut ax, mut ay, mut az) = (self.gx[0], self.gy[0], self.gz[0]);
            for k in 1..n - 1 {
                let (bx, by, bz) = (self.gx[k], self.gy[k], self.gz[k]);
                self.gx[k] = (ax + bx * 2.0 + self.gx[k + 1]) * 0.25;
                self.gy[k] = (ay + by * 2.0 + self.gy[k + 1]) * 0.25;
                self.gz[k] = (az + bz * 2.0 + self.gz[k + 1]) * 0.25;
                ax = bx; ay = by; az = bz;
            }
        }

        // --- emit ----------------------------------------------------------
        let side = |s: &Self, k: usize| -> [f32; 3] {
            let a = k.saturating_sub(1);
            let b = (k + 1).min(n - 1);
            let mut tx = s.gx[b] - s.gx[a];
            let mut ty = s.gy[b] - s.gy[a];
            let mut tz = s.gz[b] - s.gz[a];
            let tl = (tx * tx + ty * ty + tz * tz).sqrt().max(1e-6);
            tx /= tl; ty /= tl; tz /= tl;
            if ground {
                // flat in the ground plane: a tyre mark lies on the road
                return [tz, 0.0, -tx];
            }
            // cross(tangent, toCamera), so the strip always faces the lens
            let mut vx = s.gx[k] - cam[0];
            let mut vy = s.gy[k] - cam[1];
            let mut vz = s.gz[k] - cam[2];
            let vl = (vx * vx + vy * vy + vz * vz).sqrt().max(1e-6);
            vx /= vl; vy /= vl; vz /= vl;
            let sx = ty * vz - tz * vy;
            let sy = tz * vx - tx * vz;
            let sz = tx * vy - ty * vx;
            let sl = (sx * sx + sy * sy + sz * sz).sqrt();
            // dead-on along the view direction there is no side to pick
            if sl < 1e-4 {
                return [1.0, 0.0, 0.0];
            }
            [sx / sl, sy / sl, sz / sl]
        };

        let added_before = self.quads;
        for k in 0..n - 1 {
            if self.quads >= cap_quads {
                break;
            }
            let s0 = side(self, k);
            let s1 = side(self, k + 1);
            /* Age fades the tail out, and the very last node is tapered to a
               point so a trail ends rather than stopping. */
            let (t0, t1) = (self.gt[k], self.gt[k + 1]);
            let w0 = self.gw[k] * t0 * if k == 0 { 0.15 } else { 1.0 };
            let w1 = self.gw[k + 1] * t1;
            let a0 = self.ga[k] * t0 * t0;
            let a1 = self.ga[k + 1] * t1 * t1;
            let u0 = k as f32 / (n - 1) as f32;
            let u1 = (k + 1) as f32 / (n - 1) as f32;

            let mut o = self.quads * VERTS_PER_QUAD * VERT_FLOATS;
            // A, B, B, A, B, A with signs -1 -1 1 / -1 1 1
            let corners: [(usize, [f32; 3], f32, f32, f32, f32); 6] = [
                (k, s0, w0, u0, a0, -1.0),
                (k + 1, s1, w1, u1, a1, -1.0),
                (k + 1, s1, w1, u1, a1, 1.0),
                (k, s0, w0, u0, a0, -1.0),
                (k + 1, s1, w1, u1, a1, 1.0),
                (k, s0, w0, u0, a0, 1.0),
            ];
            for (idx, sv, w, u, al, sgn) in corners {
                self.out[o] = self.gx[idx] + sv[0] * w * sgn;
                self.out[o + 1] = self.gy[idx] + sv[1] * w * sgn;
                self.out[o + 2] = self.gz[idx] + sv[2] * w * sgn;
                self.out[o + 3] = u;
                self.out[o + 4] = sgn;
                self.out[o + 5] = self.gr[idx];
                self.out[o + 6] = self.gg[idx];
                self.out[o + 7] = self.gb[idx];
                self.out[o + 8] = al;
                o += VERT_FLOATS;
            }
            self.quads += 1;
        }
        self.quads - added_before
    }
}
