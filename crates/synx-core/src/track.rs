//! The course: assembling the centreline, and querying it.
//!
//! A direct port of `js/track.js`. The shipped 26.9 km centreline arrives from
//! `data/scene.json`; everything past it is generated here, in four stages
//! that must run in exactly this order because each one continues from the
//! last sample the previous one laid:
//!
//!   1. the legacy random course, out to 80,000 units (seed 0x5DD24D)
//!   2. the Ashfall extension, to 112,000 (seed 1)
//!   3. Aurora Forge's authored proving loop, to 132,000
//!   4. Neon Horizon's nine authored districts, to 173,400
//!
//! Splitting it that way is not tidiness: the generator's difficulty ramp is
//! normalised by the length it is asked for, so a single pass at 173 km would
//! make different choices from sample one and silently rewrite Routes 1-4.
//!
//! Arithmetic is f64 throughout, because the JavaScript it replaces has no
//! other kind of number and the barriers, the racing line and the scenery are
//! all measured off these samples.

use crate::math::{ang_diff, clamp, Rng};

pub const ROAD_HALF: f64 = 20.0;
pub const DRIVE_HALF: f64 = 18.0;

pub const LEGACY_COURSE_LENGTH: f64 = 80_000.0;
pub const ASHFALL_COURSE_LENGTH: f64 = 112_000.0;
pub const FACTORY_COURSE_LENGTH: f64 = 132_000.0;
/// The whole course, INCLUDING THE RUN-OFF PAST THE FLAG.
///
/// Chapter 7 finishes at 173,000 and this used to stop at 173,400 - four
/// hundred units, which is under three seconds at deck speed. Every camera the
/// game points at the car after the flag looks three hundred units up the road,
/// so all of them looked at the edge of the world: the deck stopped, the city
/// grade stopped, and the finale played over a hard line with a blue void
/// behind it.
///
/// A race needs somewhere to slow down and a cutscene needs somewhere to be.
/// Two and a half kilometres of straight, flat, ordinary road past the line is
/// both, and it costs the generator one more kilometre of samples.
pub const COURSE_LENGTH: f64 = 175_800.0;

/// Chapter 7's districts. Each is a zero-mean sine under a squared envelope,
/// so the heading won in the first half is given back in the second and the
/// route cannot run into itself. `amp` is 1/radius at the peak.
pub struct NeonZone {
    pub from: f64,
    pub to: f64,
    pub amp: f64,
    pub cycles: f64,
    pub phase: f64,
}

pub const NEON_ZONES: [NeonZone; 9] = [
    NeonZone { from: 132_000.0, to: 136_710.0, amp: 1.0 / 520.0,  cycles: 2.0, phase: 0.15 },
    NeonZone { from: 136_710.0, to: 141_420.0, amp: 1.0 / 430.0,  cycles: 3.0, phase: 2.25 },
    NeonZone { from: 141_420.0, to: 146_130.0, amp: 1.0 / 1600.0, cycles: 1.0, phase: 0.40 },
    NeonZone { from: 146_130.0, to: 150_840.0, amp: 1.0 / 470.0,  cycles: 2.0, phase: 3.10 },
    NeonZone { from: 150_840.0, to: 155_550.0, amp: 1.0 / 580.0,  cycles: 2.0, phase: 0.65 },
    NeonZone { from: 155_550.0, to: 160_260.0, amp: 1.0 / 390.0,  cycles: 3.0, phase: 3.55 },
    NeonZone { from: 160_260.0, to: 164_960.0, amp: 1.0 / 340.0,  cycles: 3.0, phase: 0.95 },
    NeonZone { from: 164_960.0, to: 169_670.0, amp: 1.0 / 450.0,  cycles: 3.0, phase: 3.80 },
    NeonZone { from: 169_670.0, to: 173_210.0, amp: 1.0 / 380.0,  cycles: 2.0, phase: 1.20 },
];

/// The centreline, stored as parallel arrays indexed by sample.
#[derive(Clone, Default)]
pub struct Centreline {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
    pub yaw: Vec<f64>,
    pub curv: Vec<f64>,
    pub tunnel: Vec<u8>,
    pub step: f64,
    pub count: usize,
    /// How much of the above is the authored mesh's own road. The renderer
    /// draws shipped geometry up to here and generates the rest.
    pub shipped_count: usize,
}

impl Centreline {
    pub fn length(&self) -> f64 {
        self.count as f64 * self.step
    }

    fn grow_to(&mut self, n: usize) {
        for v in [&mut self.x, &mut self.y, &mut self.z, &mut self.yaw, &mut self.curv] {
            if v.len() < n {
                v.resize(n, 0.0);
            }
        }
        if self.tunnel.len() < n {
            self.tunnel.resize(n, 0);
        }
    }
}

// ------------------------------------------------------- generated course ---

/// One piece of road: a constant curvature held for a length. A straight is
/// curvature zero, a sweep a long one at a big radius, a hairpin a short one
/// at a small radius. Everything the generator lays is one of these.
struct Piece {
    curv: f64,
    len: f64,
    tunnel: bool,
}

fn piece(rnd: &mut Rng, hard: f64) -> Piece {
    let r = rnd.next();
    if r < 0.26 {
        return Piece { curv: 0.0, len: 260.0 + rnd.next() * (900.0 + hard * 700.0), tunnel: false };
    }
    if r < 0.54 {
        // a long open sweep
        let rad = 700.0 + rnd.next() * 900.0;
        let s = if rnd.next() < 0.5 { -1.0 } else { 1.0 };
        return Piece { curv: s / rad, len: rad * (0.5 + rnd.next() * 0.9), tunnel: false };
    }
    if r < 0.80 {
        // a corner you lift for
        let rad = 240.0 + rnd.next() * 380.0 - hard * 60.0;
        let s = if rnd.next() < 0.5 { -1.0 } else { 1.0 };
        return Piece { curv: s / rad, len: rad * (0.7 + rnd.next() * 1.0), tunnel: false };
    }
    if r < 0.92 {
        // tight, third-gear
        let rad = 150.0 + rnd.next() * 130.0 - hard * 25.0;
        let s = if rnd.next() < 0.5 { -1.0 } else { 1.0 };
        return Piece { curv: s / rad, len: rad * (0.8 + rnd.next() * 1.2), tunnel: false };
    }
    // a kink: quick direction change, barely off the throttle
    let rad = 420.0 + rnd.next() * 500.0;
    let s = if rnd.next() < 0.5 { -1.0 } else { 1.0 };
    Piece { curv: s / rad, len: rad * 0.34, tunnel: false }
}

const CELL: f64 = 220.0;
const CLEAR: f64 = 300.0;
const GAP_SAMPLES: i64 = 260;

/// A uniform grid of every sample laid so far, so "is anything here" is a
/// constant-time question. Without it the generator has no idea it is about to
/// lay tarmac across a stretch it built four kilometres ago.
///
/// The JavaScript keyed a `Map` on `(cx + 32768) * 65536 + (cz + 32768)`; the
/// same packing is used here so a cell holds exactly the same members.
struct Grid {
    m: std::collections::HashMap<i64, Vec<usize>>,
}

impl Grid {
    fn new() -> Self {
        Grid { m: std::collections::HashMap::with_capacity(4096) }
    }

    #[inline]
    fn key(cx: i64, cz: i64) -> i64 {
        (cx + 32768) * 65536 + (cz + 32768)
    }

    fn add(&mut self, x: f64, z: f64, i: usize) {
        let k = Self::key((x / CELL).floor() as i64, (z / CELL).floor() as i64);
        self.m.entry(k).or_default().push(i);
    }

    /// The nearest stored sample at least `gap` behind `i`, or `None`. Samples
    /// close together *along* the road are legitimately close together in
    /// space - that is what a corner is - so only samples well behind in arc
    /// length count as a conflict.
    fn conflict(&self, x: f64, z: f64, i: usize, gap: i64, xs: &[f64], zs: &[f64]) -> Option<usize> {
        let cx = (x / CELL).floor() as i64;
        let cz = (z / CELL).floor() as i64;
        let r = (CLEAR / CELL).ceil() as i64;
        let mut best = None;
        let mut best_d = CLEAR * CLEAR;
        for ox in -r..=r {
            for oz in -r..=r {
                let Some(a) = self.m.get(&Self::key(cx + ox, cz + oz)) else { continue };
                for &j in a {
                    if (i as i64) - (j as i64) < gap {
                        continue;
                    }
                    let dx = xs[j] - x;
                    let dz = zs[j] - z;
                    let d = dx * dx + dz * dz;
                    if d < best_d {
                        best_d = d;
                        best = Some(j);
                    }
                }
            }
        }
        best
    }
}

/// Smooth curvature over a five-tap window, twice, starting `back` samples
/// before the join. A piecewise-constant curvature puts a step at every join,
/// and the racing line, the speed profile and the corner signs are all read
/// off it.
fn feather(curv: &mut [f64], from: usize, to: usize) {
    for _ in 0..2 {
        let src: Vec<f64> = curv[from..to].to_vec();
        if src.len() < 5 {
            return;
        }
        for k in 2..src.len() - 2 {
            curv[from + k] =
                (src[k - 2] + src[k - 1] * 2.0 + src[k] * 3.0 + src[k + 1] * 2.0 + src[k + 2]) / 9.0;
        }
    }
}

/// The legacy random generator: `buildCourse`'s single pass.
fn build_random(c: &Centreline, want: f64, seed: u32) -> Centreline {
    let step = c.step;
    let n0 = c.count;
    let mut out = c.clone();
    let total = ((want / step).round() as usize).max(n0);
    if total <= n0 {
        out.shipped_count = if c.shipped_count > 0 { c.shipped_count } else { n0 };
        return out;
    }
    out.grow_to(total);

    let mut grid = Grid::new();
    for i in 0..n0 {
        grid.add(out.x[i], out.z[i], i);
    }

    let mut rnd = Rng::new(seed);
    let mut cx = out.x[n0 - 1];
    let mut cz = out.z[n0 - 1];
    let mut cy = out.yaw[n0 - 1];
    let mut i = n0;
    // Tunnels are the strongest change of scene the course has, so they are
    // placed on a rhythm - about one every four kilometres, never back to back.
    let mut next_tunnel = n0 + 900;

    let mut px: Vec<f64> = Vec::with_capacity(512);
    let mut pz: Vec<f64> = Vec::with_capacity(512);
    let mut py: Vec<f64> = Vec::with_capacity(512);

    while i < total {
        let hard = (i - n0) as f64 / ((total - n0).max(1)) as f64;
        let mut seg: Option<Piece> = None;
        let mut best_fallback: Option<usize> = None;
        let want_tunnel = i >= next_tunnel;
        // An outward bias on every piece. A generator that picks each corner
        // independently performs a random walk, and a random walk comes back:
        // after forty kilometres every candidate fails the clearance test and
        // the course simply stops. A fifth of a milliradian per unit is a
        // five-kilometre radius - far too gentle to feel, and enough to turn
        // the walk into a slowly opening spiral that can never close on itself.
        let spiral = 1.0 / (5200.0 + (i - n0) as f64 * step * 0.55);

        for attempt in 0..22 {
            if seg.is_some() {
                break;
            }
            let p = if want_tunnel && attempt == 0 {
                Piece { curv: (rnd.next() - 0.5) / 900.0, len: 700.0 + rnd.next() * 900.0, tunnel: true }
            } else if attempt < 16 {
                let mut p = piece(&mut rnd, hard);
                p.curv += spiral;
                // later attempts try the same shapes shorter, because a
                // shorter piece has fewer chances to run into anything
                if attempt > 7 {
                    p.len *= 0.55;
                }
                p
            } else {
                // Nothing random has fitted. Turn away from whatever is in the
                // way: the sign that increases the distance to the conflicting
                // sample is the one that gets the road out of the corner it
                // has driven itself into.
                let away = match best_fallback {
                    None => {
                        if rnd.next() < 0.5 {
                            -1.0
                        } else {
                            1.0
                        }
                    }
                    Some(b) => {
                        let a = (cx - out.x[b]).atan2(cz - out.z[b]);
                        if ang_diff(cy, a) > 0.0 {
                            1.0
                        } else {
                            -1.0
                        }
                    }
                };
                let k = (attempt - 16) as f64;
                Piece { curv: away / (170.0 + k * 55.0), len: 380.0 + k * 90.0, tunnel: false }
            };

            // trace it and see whether it fits
            let steps = ((p.len / step).round() as usize).max(2);
            let (mut tx, mut tz, mut ty) = (cx, cz, cy);
            let mut ok = true;
            px.clear();
            pz.clear();
            py.clear();
            for k in 0..steps {
                ty += p.curv * step;
                tx += ty.sin() * step;
                tz += ty.cos() * step;
                if let Some(cj) = grid.conflict(tx, tz, i + k, GAP_SAMPLES, &out.x, &out.z) {
                    ok = false;
                    best_fallback = Some(cj);
                    break;
                }
                px.push(tx);
                pz.push(tz);
                py.push(ty);
            }
            if ok {
                seg = Some(p);
            }
        }

        let Some(p) = seg else {
            // twenty-two tries and the road is boxed in: stop here rather than
            // lay tarmac through tarmac. The course is as long as it got.
            break;
        };

        let mut k = 0;
        while k < px.len() && i < total {
            out.x[i] = px[k];
            out.z[i] = pz[k];
            out.yaw[i] = py[k];
            out.curv[i] = p.curv;
            out.tunnel[i] = u8::from(p.tunnel);
            grid.add(out.x[i], out.z[i], i);
            k += 1;
            i += 1;
        }
        cx = out.x[i - 1];
        cz = out.z[i - 1];
        cy = out.yaw[i - 1];
        if p.tunnel {
            next_tunnel = i + 520 + (rnd.next() * 420.0).floor() as usize;
        }
    }

    let count = i;
    feather(&mut out.curv, n0 - 2, count);
    out.count = count;
    out.shipped_count = if c.shipped_count > 0 { c.shipped_count } else { n0 };
    out.truncate(count);
    out
}

impl Centreline {
    fn truncate(&mut self, n: usize) {
        self.x.truncate(n);
        self.y.truncate(n);
        self.z.truncate(n);
        self.yaw.truncate(n);
        self.curv.truncate(n);
        self.tunnel.truncate(n);
        self.count = n;
    }
}

/// Aurora Forge's body-shop proving loop. Each signed pair is an S rather than
/// a hairpin: the heading won in one cell is paid back in the next, so the
/// hall advances instead of curling over itself.
fn append_factory(c: &Centreline, want: f64) -> Centreline {
    let step = c.step;
    let n0 = c.count;
    let mut out = c.clone();
    let total = ((want / step).round() as usize).max(n0);
    out.grow_to(total);

    let mut cx = out.x[n0 - 1];
    let mut cz = out.z[n0 - 1];
    let mut cy = out.yaw[n0 - 1];
    let mut i = n0;

    let mut plan: Vec<(f64, f64)> = vec![(520.0, 0.0)];
    for k in 0..10i32 {
        let sign = if k % 2 != 0 { -1.0 } else { 1.0 };
        plan.push((185.0 + (k % 3) as f64 * 16.0, sign / (158.0 + (k % 4) as f64 * 12.0)));
        plan.push((135.0 + (k % 2) as f64 * 30.0, 0.0));
    }
    plan.push((620.0, 0.0));
    for k in 0..6i32 {
        let sign = if k % 2 != 0 { -1.0 } else { 1.0 };
        plan.push((205.0 + (k % 2) as f64 * 24.0, sign / (205.0 + (k % 3) as f64 * 18.0)));
        plan.push((205.0, 0.0));
    }
    // ...and then the raceMode calibration straight.
    plan.push(((want - ASHFALL_COURSE_LENGTH).max(6000.0), 0.0));

    'outer: for (len, curv) in plan {
        let steps = ((len / step).round() as usize).max(1);
        for _ in 0..steps {
            if i >= total {
                break 'outer;
            }
            cy += curv * step;
            cx += cy.sin() * step;
            cz += cy.cos() * step;
            out.x[i] = cx;
            out.z[i] = cz;
            out.y[i] = 0.0;
            out.yaw[i] = cy;
            out.curv[i] = curv;
            out.tunnel[i] = 0;
            i += 1;
        }
    }
    while i < total {
        cx += cy.sin() * step;
        cz += cy.cos() * step;
        out.x[i] = cx;
        out.z[i] = cz;
        out.y[i] = 0.0;
        out.yaw[i] = cy;
        out.curv[i] = 0.0;
        out.tunnel[i] = 0;
        i += 1;
    }

    feather(&mut out.curv, n0 - 3, i);
    out.shipped_count = if c.shipped_count > 0 { c.shipped_count } else { n0 };
    out.truncate(i);
    out
}

/// Chapter 7's authored city route: nine districts, three tunnels and six
/// height plateaus. Smooth plateaus keep the four-wheel physics grounded while
/// still producing readable climbs, descents and suspended districts - no gap
/// relies on airborne-car simulation.
fn append_neon(c: &Centreline, want: f64) -> Centreline {
    let step = c.step;
    let n0 = c.count;
    let mut out = c.clone();
    let total = ((want / step).round() as usize).max(n0);
    out.grow_to(total);

    let ease = |t: f64| {
        let t = clamp(t, 0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let plateau = |s: f64, a: f64, b: f64, cc: f64, d: f64, h: f64| -> f64 {
        if s < a || s > d {
            return 0.0;
        }
        if s < b {
            return ease((s - a) / (b - a)) * h;
        }
        if s <= cc {
            return h;
        }
        (1.0 - ease((s - cc) / (d - cc))) * h
    };
    let height_at = |s: f64| -> f64 {
        plateau(s, 132_590.0, 133_090.0, 136_060.0, 136_590.0, 12.0)
            + plateau(s, 140_860.0, 141_450.0, 145_510.0, 146_190.0, 22.0)
            + plateau(s, 150_480.0, 151_010.0, 153_280.0, 153_840.0, 10.0)
            + plateau(s, 153_960.0, 154_490.0, 158_430.0, 159_110.0, 18.0)
            + plateau(s, 159_490.0, 160_050.0, 162_430.0, 163_020.0, -8.0)
            + plateau(s, 165_380.0, 166_080.0, 171_590.0, 172_760.0, 26.0)
    };
    let is_tunnel = |s: f64| -> bool {
        (137_090.0..=138_500.0).contains(&s)
            || (146_540.0..=147_920.0).contains(&s)
            || (160_840.0..=162_290.0).contains(&s)
    };
    let curve_at = |s: f64| -> f64 {
        let z = NEON_ZONES
            .iter()
            .find(|q| s >= q.from && s < q.to)
            .unwrap_or(&NEON_ZONES[NEON_ZONES.len() - 1]);
        let t = clamp((s - z.from) / (z.to - z.from), 0.0, 1.0);
        let envelope = (core::f64::consts::PI * t).sin();
        (t * core::f64::consts::PI * 2.0 * z.cycles + z.phase).sin() * z.amp * envelope * envelope
    };

    let mut cx = out.x[n0 - 1];
    let mut cz = out.z[n0 - 1];
    let mut cy = out.yaw[n0 - 1];
    let mut i = n0;
    while i < total {
        let s = i as f64 * step;
        let k = curve_at(s);
        cy += k * step;
        cx += cy.sin() * step;
        cz += cy.cos() * step;
        out.x[i] = cx;
        out.z[i] = cz;
        out.y[i] = height_at(s);
        out.yaw[i] = cy;
        out.curv[i] = k;
        out.tunnel[i] = u8::from(is_tunnel(s));
        i += 1;
    }

    feather(&mut out.curv, n0, i);
    out.shipped_count = if c.shipped_count > 0 { c.shipped_count } else { n0 };
    out.truncate(i);
    out
}

/// Carry the shipped centreline on to `want` units of course.
///
/// The staging here is load-bearing - see the module note. Each stage starts
/// from the exact last sample of the one before it, so no older sample ever
/// moves and Routes 1-4 stay byte-for-byte the road they have always been.
pub fn build_course(shipped: &Centreline, want: f64) -> Centreline {
    let shipped_len = shipped.count as f64 * shipped.step;

    if want > ASHFALL_COURSE_LENGTH && shipped_len < ASHFALL_COURSE_LENGTH - shipped.step * 2.0 {
        let legacy = build_random(shipped, LEGACY_COURSE_LENGTH, 0x5DD24D);
        let ashfall = build_random(&legacy, ASHFALL_COURSE_LENGTH, 1);
        let factory = append_factory(&ashfall, want.min(FACTORY_COURSE_LENGTH));
        return if want > FACTORY_COURSE_LENGTH {
            append_neon(&factory, want)
        } else {
            factory
        };
    }

    if want > LEGACY_COURSE_LENGTH && shipped_len < LEGACY_COURSE_LENGTH - shipped.step * 2.0 {
        let legacy = build_random(shipped, LEGACY_COURSE_LENGTH, 0x5DD24D);
        return build_random(&legacy, want, 1);
    }

    build_random(shipped, want, 0x5DD24D)
}

// ------------------------------------------------------------------ query ---

#[derive(Clone, Copy, Default)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    pub curv: f64,
    pub tunnel: bool,
}

#[derive(Clone, Copy, Default)]
pub struct Projection {
    pub s: f64,
    pub s_exact: f64,
    pub lateral: f64,
    pub index: usize,
    pub yaw: f64,
    pub curv: f64,
}

pub struct Track {
    pub c: Centreline,
    pub length: f64,
    pub step: f64,
    pub count: usize,
    pub half_width: f64,
    pub outer_half: f64,
    pub shipped_count: usize,
}

impl Track {
    pub fn new(c: Centreline) -> Self {
        let length = c.length();
        let step = c.step;
        let count = c.count;
        let shipped_count = if c.shipped_count > 0 { c.shipped_count } else { count };
        Track { c, length, step, count, half_width: DRIVE_HALF, outer_half: ROAD_HALF, shipped_count }
    }

    /// Interpolated point and heading at arc length `s`.
    #[inline]
    pub fn at(&self, s: f64) -> Sample {
        let c = &self.c;
        let f = clamp(s / c.step, 0.0, c.count as f64 - 1.001);
        let i = f as usize;
        let t = f - i as f64;
        let j = (c.count - 1).min(i + 1);
        Sample {
            x: c.x[i] + (c.x[j] - c.x[i]) * t,
            y: c.y[i] + (c.y[j] - c.y[i]) * t,
            z: c.z[i] + (c.z[j] - c.z[i]) * t,
            yaw: c.yaw[i] + ang_diff(c.yaw[i], c.yaw[j]) * t,
            curv: c.curv[i] + (c.curv[j] - c.curv[i]) * t,
            tunnel: c.tunnel[i] == 1,
        }
    }

    /// Nearest centreline point, searched around `hint` so it stays O(1).
    ///
    /// The window is a bet that the car has not moved far since last frame.
    /// When that bet is wrong - a teleport, a route change, a stale hint - the
    /// closest sample inside the window can be kilometres away, and returning
    /// it makes the collision resolver shove the car sideways into a barrier
    /// on a different stretch of road. So the window's answer is
    /// sanity-checked, and a miss falls back to a full sweep: one scan on the
    /// frame it happens, nothing on every other frame.
    pub fn project(&self, x: f64, z: f64, hint: f64) -> Projection {
        let c = &self.c;
        const SPAN: i64 = 120;
        let bi = clamp((hint / c.step).round(), 0.0, c.count as f64 - 1.0) as i64;
        let lo = (bi - SPAN).max(0) as usize;
        let hi = (bi + SPAN).min(c.count as i64 - 1) as usize;
        let mut best = bi as usize;
        let mut best_d = f64::INFINITY;
        for i in lo..=hi {
            let dx = c.x[i] - x;
            let dz = c.z[i] - z;
            let d = dx * dx + dz * dz;
            if d < best_d {
                best_d = d;
                best = i;
            }
        }
        const WINDOW_TRUST: f64 = 240.0 * 240.0;
        if best_d > WINDOW_TRUST || ((best == lo || best == hi) && lo > 0 && hi < c.count - 1) {
            for i in 0..c.count {
                let dx = c.x[i] - x;
                let dz = c.z[i] - z;
                let d = dx * dx + dz * dz;
                if d < best_d {
                    best_d = d;
                    best = i;
                }
            }
        }
        let yaw = c.yaw[best];
        let rx = yaw.cos();
        let rz = -yaw.sin();
        let dx = x - c.x[best];
        let dz = z - c.z[best];
        Projection {
            s: best as f64 * c.step,
            s_exact: best as f64 * c.step + dx * yaw.sin() + dz * yaw.cos(),
            lateral: dx * rx + dz * rz,
            index: best,
            yaw,
            curv: c.curv[best],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn straight(n: usize, step: f64) -> Centreline {
        let mut c = Centreline { step, count: n, shipped_count: n, ..Default::default() };
        for i in 0..n {
            c.x.push(0.0);
            c.y.push(0.0);
            c.z.push(i as f64 * step);
            c.yaw.push(0.0);
            c.curv.push(0.0);
            c.tunnel.push(0);
        }
        c
    }

    #[test]
    fn at_interpolates_between_samples() {
        let t = Track::new(straight(10, 6.0));
        let s = t.at(9.0);
        assert!((s.z - 9.0).abs() < 1e-9, "z = {}", s.z);
    }

    #[test]
    fn project_finds_lateral_offset() {
        let t = Track::new(straight(200, 6.0));
        let p = t.project(7.5, 60.0, 60.0);
        assert!((p.lateral - 7.5).abs() < 1e-6, "lateral = {}", p.lateral);
        assert_eq!(p.index, 10);
    }

    /// A stale hint must not return a point kilometres away - the fallback
    /// sweep is what keeps the collision resolver honest.
    #[test]
    fn project_recovers_from_a_stale_hint() {
        let t = Track::new(straight(4000, 6.0));
        let p = t.project(0.0, 12_000.0, 0.0);
        assert!((p.s - 12_000.0).abs() < 6.0, "s = {}", p.s);
    }

    #[test]
    fn generated_course_reaches_full_length_and_stays_open() {
        let c = build_course(&straight(4494, 6.0), COURSE_LENGTH);
        assert!(
            c.count as f64 * c.step > COURSE_LENGTH - 100.0,
            "course stopped short at {}",
            c.length()
        );
        assert_eq!(c.shipped_count, 4494, "shipped span must survive extension");
        // no sample may sit on top of a much older one
        let t = Track::new(c);
        for i in (5000..t.count).step_by(97) {
            let p = t.project(t.c.x[i], t.c.z[i], i as f64 * t.step);
            assert!(
                (p.index as i64 - i as i64).abs() < 400,
                "sample {i} projects onto {} - the road crosses itself",
                p.index
            );
        }
    }
}
