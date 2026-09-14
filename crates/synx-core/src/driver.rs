//! The driver figure's pose, solved.
//!
//! # Why this is in Rust
//!
//! The figure in the seat is seventeen pieces - a torso, a head with its visor
//! and its peak, two arms in four parts, a wheel with three spokes and the
//! column it is on - and every one of them needs a 4x4 built and multiplied
//! into the car's own transform. That is not expensive once. It is expensive
//! the way it actually happens:
//!
//!   seventeen parts, times up to five cars on the road, times every pass that
//!   submits the world again - the main pass, three shadow cascades and the
//!   reflection probe.
//!
//! Five hundred matrix compositions a frame, in JavaScript, in a loop that
//! allocates nothing and does nothing but arithmetic. It is the exact shape of
//! work that belongs on this side of the boundary, and none of it needs the
//! renderer: it is pure geometry in and pure geometry out.
//!
//! # What it replaces
//!
//! `DriverFigure.place`, `spinAbout`, `endOf` and `boneBetween` in
//! `js/scene.js`, which are gone. The part table is still authored in
//! JavaScript, because that is where the figure is designed and a table split
//! across two languages is a table that drifts; it is uploaded once at start
//! up and this module holds it for the rest of the session.
//!
//! # The three kinds of part
//!
//! PLAIN   placed by its own translation, rotation and scale, and that is all.
//!
//! SPIN    the same, and then turned about the steering wheel's axis. A glove
//!         on the rim has to travel round the rim; rotating it about its own
//!         origin - which is what the first version of this did - spins a hand
//!         on the spot and leaves it exactly where it was.
//!
//! BONE    not placed at all: solved between a fixed shoulder and whichever
//!         end of another part it is attached to, so an upper arm follows the
//!         hand rather than pointing where it was authored to point. A capsule
//!         is a unit shaft along its own z, so a bone is the rotation that
//!         takes +z onto the shoulder-to-elbow line and a z scale of exactly
//!         that length.
//!
//! BUTTON  a SPIN part that also sinks into its own housing when it is
//!         pressed. The travel is a few millimetres and it is the whole of
//!         the effect: a control that lights up without moving reads as a
//!         lamp, and a car with a lamp for a boost button is a car nobody
//!         is driving. How far it sinks is in the tenth slot of its record.
//!
//! REACH   a part with two poses that moves between them. The right hand
//!         lets go of the wheel, crosses to the console, presses the boost
//!         button and comes back - which is a thing a person does, and
//!         therefore the thing that sells a driver as a person rather than
//!         as a mannequin bolted to a rim. The travel is eased rather than
//!         linear: a hand accelerates off the wheel and decelerates onto
//!         the button, and a limb moving at a constant speed is the single
//!         clearest tell that something is being interpolated.

/// Floats per part in the uploaded table.
///
/// Twelve of these describe where a part rests. The last six are the pose a
/// REACH part moves TO - a second translation and a second rotation - which
/// is what lets a hand leave the wheel for a button and come back without
/// two tables or a second upload.
pub const STRIDE: usize = 18;
/// Floats per output matrix.
pub const MAT: usize = 16;

pub const PLAIN: f32 = 0.0;
pub const SPIN: f32 = 1.0;
pub const BONE: f32 = 2.0;
/* A part that rides the RIM but not all of the way round it.
 *
 * The rack is sixteen to one, so a corner turns the wheel most of a quarter
 * turn and a drift most of a half - and a hand welded to the rim through that
 * ends up underneath it with the arm laid across the windscreen. A driver does
 * not do that; the wheel slides through their hands and they shuffle. So the
 * rim gets the full angle and the hands get their own, which saturates.
 *
 * Everything that is HELD - the two forearms and the two gloves - is one of
 * these. Everything that IS the wheel stays SPIN. */
pub const GRIP: f32 = 5.0;
/* AN ARM THAT IS SOLVED RATHER THAN SWUNG.
 *
 * GRIP was only ever right for a HAND. A forearm carried round the hub with
 * it is a forearm whose elbow is carried round too, and at the angles this
 * rack now reaches - most of a quarter turn for a corner, most of a half for
 * a drift - that puts the elbow out over the passenger seat with the arm
 * lying across the windscreen. It was correct at ten degrees and absurd at
 * ninety, which is the whole of what changed.
 *
 * So the forearm stops being placed at all. The HAND rides the rim, because
 * that is what a hand does; the elbow is then wherever a shoulder that cannot
 * move and a wrist that has must put it, which is a two-bone solve with one
 * answer. The upper arm is already a BONE to the elbow, so it comes along for
 * free, and the whole arm bends and extends through the turn the way an arm
 * in a car does.
 *
 * The record for one of these is its REST pose, exactly as before -
 * `calibrate` reads the shoulder, the two lengths, the wrist and the plane the
 * elbow falls in straight out of it, so the figure standing still is the
 * figure that was authored and nothing has to be written down twice. */
pub const ARM: f32 = 6.0;

/* HOW FAR A HAND IS WILLING TO GO, as opposed to how far it is able to.
 *
 * The arm solve answers the second question and it answers it generously:
 * measured, the figure can keep its grip through a hundred and sixty degrees
 * on one lock, because the far side of the rim happens to swing back towards
 * the shoulder. Geometrically fine, and nobody drives like that - it puts the
 * left hand at five o'clock with the arms crossed and the elbows locked, and
 * it is wildly lopsided, because the SAME arm can only manage half that on
 * the other lock.
 *
 * So there is a limit on top of the reach: ninety-two degrees, which is a
 * hand from ten o'clock to one and back, symmetrical, and is what a driver
 * with their hands where they belong actually does before the wheel starts
 * sliding through them. The rim goes on to its own lock either way - the gap
 * between the two is the shuffle. */
pub const HAND_LOCK: f64 = 1.6;
pub const BUTTON: f32 = 3.0;
pub const REACH: f32 = 4.0;

/// One part, as the table describes it.
#[derive(Clone, Copy, Default)]
struct Part {
    /// Translation - or, for a bone, the fixed shoulder it hangs from.
    t: [f64; 3],
    s: [f64; 3],
    pitch: f64,
    roll: f64,
    kind: u8,
    /// For a bone: which part supplies the other end.
    reference: usize,
    /// For a button: how far it sinks when fully pressed, along its own
    /// down axis.
    travel: f64,
    /// For a reach: the translation and rotation it moves to.
    to: [f64; 3],
    to_pitch: f64,
    to_roll: f64,
    /// For a bone: the length to solve at, if the table names one. Zero means
    /// "whatever the rest pose happens to be", which is what this was before
    /// there was anywhere to put a number - and a rest pose with the arm
    /// already straight leaves an arm that can never bend.
    length: f64,
    /* ---- worked out once by `calibrate`, for an ARM and nothing else ---- */
    /// The shoulder this arm hangs from: the fixed end of whichever BONE
    /// names it.
    shoulder: [f64; 3],
    /// How long the upper arm is, which is that BONE's own `length` if it has
    /// one and the rest distance otherwise.
    upper: f64,
    /// The far end of the forearm at rest - the wrist joint, not the middle
    /// of the glove.
    rest_wrist: [f64; 3],
    /// Wrist minus the referenced glove's own origin, so the wrist can be
    /// carried by a hand that has gone somewhere else entirely.
    wrist_off: [f64; 3],
    /// Which way the elbow falls off the shoulder-to-wrist line. Taken from
    /// where the elbow sits at rest, so the authored pose is reproduced
    /// exactly at zero and is the swing plane at every other angle.
    pole: [f64; 3],
}

#[derive(Default)]
pub struct Rig {
    parts: Vec<Part>,
    out: Vec<f32>,
    hub: [f64; 3],
    rake: f64,
    /// Where the head is placed, in figure space. The first-person eye is
    /// measured from it rather than written down twice - see `pov`.
    head: [f64; 3],
    /// The last camera this rig produced: an eye, a point to look at, and
    /// the car's own up axis. Nine floats, handed back as a pointer rather
    /// than copied across the boundary.
    cam: [f32; 9],
    /// This frame's solved elbows, indexed by part. An ARM fills its own in
    /// and the BONE above it reads it back, which is how the upper arm ends
    /// up at the same joint the forearm does without either of them knowing
    /// the other exists. Kept as a field rather than a local so the solve
    /// allocates nothing on the frames where nothing has changed shape.
    elbow: Vec<Option<[f64; 3]>>,
}

/// Column-major 4x4, the same order the renderer wants.
type M4 = [f64; 16];

/* The handful of vector operations the arm solve needs. Written out here
   rather than pulled in, because a dependency for six three-line functions is
   a dependency for six three-line functions. */
#[inline]
fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn len3(a: [f64; 3]) -> f64 {
    dot3(a, a).sqrt()
}
#[inline]
fn norm3(a: [f64; 3]) -> [f64; 3] {
    let l = len3(a).max(1e-9);
    [a[0] / l, a[1] / l, a[2] / l]
}
#[inline]
fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
#[inline]
fn xform(m: &M4, p: [f64; 3]) -> [f64; 3] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ]
}

/// The smoothstep a REACH travels on, in one place because three things now
/// have to agree about where a hand is part way across.
#[inline]
fn ease01(k: f64) -> f64 {
    let k = k.clamp(0.0, 1.0);
    k * k * (3.0 - 2.0 * k)
}

/* WHERE THE ELBOW GOES.
 *
 * Two bones, a fixed shoulder, a wrist that has moved: the elbow is on a
 * circle, and which point of that circle it is on is the only thing left to
 * choose. `pole` chooses it - the direction the joint is allowed to fall in -
 * and taking that from the authored rest pose means the solve reproduces the
 * figure that was drawn by hand at zero and only starts inventing anything
 * once the wheel moves.
 *
 * The arm is allowed to reach for something it cannot get to: the distance is
 * clamped rather than the solve refused, so an unreachable target straightens
 * the arm and points it, which is what a person does and a great deal better
 * than a NaN.
 */
fn elbow_of(shoulder: [f64; 3], wrist: [f64; 3], upper: f64, fore: f64, pole: [f64; 3]) -> [f64; 3] {
    let to = sub3(wrist, shoulder);
    let reach = (upper + fore).max(1e-4);
    let d = len3(to).clamp((upper - fore).abs().max(1e-4), reach * 0.9999);
    let n = norm3(to);
    // the foot of the elbow on the shoulder-wrist line, and its height off it
    let a = ((upper * upper - fore * fore) / d + d) * 0.5;
    let h = (upper * upper - a * a).max(0.0).sqrt();
    // the pole, squared off against the line, so the elbow swings in a plane
    let k = dot3(pole, n);
    let mut u = [pole[0] - n[0] * k, pole[1] - n[1] * k, pole[2] - n[2] * k];
    if len3(u) < 1e-6 {
        // a pole along the arm names no plane at all; any perpendicular will do
        let alt = if n[1].abs() > 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
        u = cross3(cross3(n, alt), n);
    }
    let u = norm3(u);
    [
        shoulder[0] + n[0] * a + u[0] * h,
        shoulder[1] + n[1] * a + u[1] * h,
        shoulder[2] + n[2] * a + u[2] * h,
    ]
}

/* EASING INTO A LIMIT INSTEAD OF HITTING IT.
 *
 * The hands have a hard bound - past it the arm is not long enough and the
 * grip comes off the rim - but arriving at a hard bound at a hard stop is
 * exactly as readable as a clipping plane. The last quarter of the travel is
 * compressed into an exponential approach instead, so a hand slows as it runs
 * out of arm and the wheel keeps turning through it. Which is what shuffling
 * a wheel looks like, without animating a re-grip.
 */
fn ease_into(v: f64, lo: f64, hi: f64) -> f64 {
    fn soft(x: f64, edge: f64) -> f64 {
        if edge <= 1e-6 {
            return 0.0;
        }
        let knee = edge * 0.75;
        if x <= knee {
            x
        } else {
            knee + (edge - knee) * (1.0 - (-(x - knee) / (edge - knee)).exp())
        }
    }
    if v >= 0.0 {
        soft(v, hi.max(0.0))
    } else {
        -soft(-v, (-lo).max(0.0))
    }
}

fn identity() -> M4 {
    let mut m = [0.0; 16];
    m[0] = 1.0;
    m[5] = 1.0;
    m[10] = 1.0;
    m[15] = 1.0;
    m
}

fn mul(a: &M4, b: &M4) -> M4 {
    let mut o = [0.0; 16];
    for c in 0..4 {
        let (b0, b1, b2, b3) = (b[c * 4], b[c * 4 + 1], b[c * 4 + 2], b[c * 4 + 3]);
        o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    o
}

/// Translation and a yaw-free rotation, matching the renderer's own `M4.trs`
/// so a part authored against that one lands in the same place.
fn trs(t: [f64; 3], pitch: f64, roll: f64) -> M4 {
    let (cp, sp) = (pitch.cos(), pitch.sin());
    let (cr, sr) = (roll.cos(), roll.sin());
    let mut o = [0.0; 16];
    o[0] = cr;
    o[1] = cp * sr;
    o[2] = sp * sr;
    o[4] = -sr;
    o[5] = cp * cr;
    o[6] = sp * cr;
    o[8] = 0.0;
    o[9] = -sp;
    o[10] = cp;
    o[12] = t[0];
    o[13] = t[1];
    o[14] = t[2];
    o[15] = 1.0;
    o
}

impl Rig {
    pub fn new() -> Self {
        Self {
            parts: Vec::new(),
            out: Vec::new(),
            hub: [0.0; 3],
            rake: 0.0,
            head: [0.0; 3],
            cam: [0.0; 9],
            elbow: Vec::new(),
        }
    }

    pub fn set_hub(&mut self, x: f64, y: f64, z: f64, rake: f64) {
        self.hub = [x, y, z];
        self.rake = rake;
    }

    /// Take the table. `raw` is `n * STRIDE` floats; see the module note for
    /// what each record means.
    pub fn load(&mut self, raw: &[f32]) {
        let n = raw.len() / STRIDE;
        self.parts.clear();
        self.parts.reserve(n);
        for i in 0..n {
            let r = &raw[i * STRIDE..i * STRIDE + STRIDE];
            self.parts.push(Part {
                t: [r[0] as f64, r[1] as f64, r[2] as f64],
                s: [r[3] as f64, r[4] as f64, r[5] as f64],
                pitch: r[6] as f64,
                roll: r[7] as f64,
                kind: r[8] as u8,
                reference: r[9] as usize,
                travel: r[10] as f64,
                to: [r[12] as f64, r[13] as f64, r[14] as f64],
                to_pitch: r[15] as f64,
                to_roll: r[16] as f64,
                length: r[11] as f64,
                ..Part::default()
            });
        }
        self.out.clear();
        self.out.resize(n * MAT, 0.0);
        self.elbow.clear();
        self.elbow.resize(n, None);
        self.calibrate();
    }

    /* WHAT AN ARM IS, READ OFF THE POSE SOMEBODY DREW.
     *
     * An ARM record is a rest pose and nothing else - the same twelve numbers
     * a GRIP forearm had - and everything the solve needs comes out of it
     * here, once, at load:
     *
     *   THE SHOULDER is the fixed end of whichever BONE names this part. It
     *   is already in the table; asking for it again in the arm's own record
     *   would be the same point written down twice, and two copies of a point
     *   are two points as soon as anybody edits one.
     *
     *   THE LENGTHS are the forearm's own z scale, and the upper arm's
     *   authored `length` - or, if the table does not name one, the rest
     *   distance from the shoulder to the elbow. Naming one matters: the
     *   figure as drawn has the arm very nearly straight, and an arm solved at
     *   exactly its rest length can only ever straighten, so the hands could
     *   travel about four degrees before running out of arm.
     *
     *   THE POLE is where the elbow actually sits at rest, measured off the
     *   shoulder-to-wrist line. That is what makes this safe to turn on: at
     *   zero the solve puts the elbow back exactly where the author put it,
     *   so nothing about the figure standing still changes.
     */
    fn calibrate(&mut self) {
        let id = identity();
        let n = self.parts.len();
        let mut fill: Vec<Option<([f64; 3], f64, [f64; 3], [f64; 3], [f64; 3])>> = vec![None; n];
        for i in 0..n {
            let p = self.parts[i];
            if p.kind as f32 != ARM {
                continue;
            }
            let elbow = self.end_of(&p, -0.5, &id, 0.0);
            let wrist = self.end_of(&p, 0.5, &id, 0.0);
            // the shoulder, and how long the bone hanging off it wants to be
            let mut shoulder = elbow;
            let mut upper = 0.0;
            for q in self.parts.iter() {
                if q.kind as f32 == BONE && q.reference == i {
                    shoulder = q.t;
                    upper = q.length;
                    break;
                }
            }
            if upper <= 1e-4 {
                upper = len3(sub3(elbow, shoulder)).max(1e-3);
            }
            let glove = self.parts.get(p.reference).map(|g| g.t).unwrap_or(wrist);
            let off = sub3(wrist, glove);
            // where the elbow hangs, off the line between the two fixed ends
            let n_line = norm3(sub3(wrist, shoulder));
            let e = sub3(elbow, shoulder);
            let k = dot3(e, n_line);
            let mut pole = [
                e[0] - n_line[0] * k,
                e[1] - n_line[1] * k,
                e[2] - n_line[2] * k,
            ];
            if len3(pole) < 1e-3 {
                /* A STRAIGHT ARM NAMES NO PLANE, and the figure as authored is
                   within a centimetre of straight - so the fallback is not an
                   edge case here, it is the case.

                   DOWN, AND TUCKED IN. The first version of this pointed the
                   elbows AWAY from the centreline, on the reasoning that
                   elbows point away from the body. They do when you are
                   standing up. Sitting behind a wheel with something to
                   reach for, they come IN - which is not a stylistic
                   preference here, it is the difference between an arm with
                   its elbow beside the driver's own hip and one with a joint
                   the size of a fist resting on the centre console next to
                   the hand that is pressing the button on it. That is what
                   outboard produced, measured: the right elbow at x -0.14,
                   which is on the tunnel.

                   In, and down, and a shade forward: x -0.33, y -0.19,
                   z 0.65 for the right arm at rest, which is beside the
                   chest where it belongs. The direction is taken from the
                   hub rather than written twice, so it is right for both
                   arms and stays right if the figure is ever mirrored. */
                let side = if shoulder[0] >= self.hub[0] { -1.0 } else { 1.0 };
                pole = [side * 0.55, -1.0, 0.05];
            }
            fill[i] = Some((shoulder, upper, wrist, off, norm3(pole)));
        }
        for i in 0..n {
            if let Some((shoulder, upper, wrist, off, pole)) = fill[i] {
                let q = &mut self.parts[i];
                q.shoulder = shoulder;
                q.upper = upper;
                q.rest_wrist = wrist;
                q.wrist_off = off;
                q.pole = pole;
            }
        }
    }

    /* HOW FAR ROUND THE WHEEL THIS HAND CAN GO.
     *
     * The wrist rides a circle about the hub, so its distance from a shoulder
     * that does not move is
     *
     *     d(theta)^2 = C - 2K cos(theta - phi)
     *
     * for three constants that fall straight out of the geometry. Setting that
     * equal to the arm's reach gives the arc the hand is allowed, exactly and
     * in closed form - no search, no iteration, and no chance of the bisection
     * that would otherwise be here disagreeing with itself between frames.
     *
     * Returns the middle of the allowed arc and its half width.
     */
    fn reach_arc(&self, p: &Part) -> (f64, f64) {
        let (ca, sa) = (self.rake.cos(), self.rake.sin());
        /* THE AXIS THE WHEEL TURNS ABOUT, read back out of spin_matrix rather
           than guessed from the rake. It is NEGATIVE in y: that matrix has
           m[0][2] = -sin(s)cos(rake) and m[2][0] = +sin(s)sin(rake), and a
           rotation about a unit u has R[0][2] = +u_y sin(s), so u_y = -sin(rake).
           Getting this backwards mirrors the allowed arc about the rest pose -
           the hand is free in the direction it should be limited and limited in
           the direction it is free - which shows up as an arm stretching past
           its own length on one lock and stopping short on the other. */
        let axis = [0.0, -sa, ca];
        let v0 = sub3(p.rest_wrist, self.hub);
        let along = dot3(v0, axis);
        let par = [axis[0] * along, axis[1] * along, axis[2] * along];
        let perp = sub3(v0, par);
        let side = cross3(axis, perp);
        let sh = sub3(sub3(p.shoulder, self.hub), par);
        let c = dot3(perp, perp) + dot3(sh, sh);
        let (x, y) = (dot3(perp, sh), dot3(side, sh));
        let k = (x * x + y * y).sqrt();
        let reach = (p.upper + p.s[2]) * 0.995;
        if k < 1e-9 {
            // the shoulder is on the wheel's own axis: every angle is the same
            return (0.0, core::f64::consts::PI);
        }
        let phi = y.atan2(x);
        let cut = ((c - reach * reach) / (2.0 * k)).clamp(-1.0, 1.0);
        (phi, cut.acos())
    }

    pub fn len(&self) -> usize {
        self.parts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }

    pub fn out_ptr(&mut self) -> *mut f32 {
        self.out.as_mut_ptr()
    }

    /// The wheel's rotation, about its own raked axis, through its own hub.
    ///
    /// Written out rather than composed from three matrices because the first
    /// version was composed by hand and got four signs wrong - which is not a
    /// rotation any more, and showed up as hands drifting off the rim as the
    /// wheel turned. `a_grip_never_leaves_the_rim` is the test that would
    /// have caught it.
    fn spin_matrix(&self, s: f64) -> M4 {
        let (ca, sa) = (self.rake.cos(), self.rake.sin());
        let (cs, ss) = (s.cos(), s.sin());
        let m = [
            [cs, -ss * ca, -ss * sa],
            [ca * ss, ca * cs * ca + sa * sa, ca * cs * sa - sa * ca],
            [sa * ss, sa * cs * ca - ca * sa, sa * cs * sa + ca * ca],
        ];
        let h = self.hub;
        let mut o = [0.0; 16];
        for c in 0..3 {
            o[c * 4] = m[0][c];
            o[c * 4 + 1] = m[1][c];
            o[c * 4 + 2] = m[2][c];
        }
        for r in 0..3 {
            o[12 + r] = h[r] - (m[r][0] * h[0] + m[r][1] * h[1] + m[r][2] * h[2]);
        }
        o[15] = 1.0;
        o
    }

    /// Where a capsule's own end sits once the wheel has been turned. `end` is
    /// -0.5 for the back of the shaft, +0.5 for the front.
    /* WHERE A PART ACTUALLY IS, which is not always where the table put it.

       A reach moves; a bone that solves to a reaching part has to solve to
       where it has moved TO. Reading the table directly - which is what this
       did first - leaves the upper arm pointing at an elbow the forearm has
       left, so the arm comes apart the moment the hand goes for the button.
       One function decides it, and both callers ask. */
    fn placed(&self, p: &Part, press: f64) -> ([f64; 3], f64, f64) {
        if p.kind as f32 != REACH {
            return (p.t, p.pitch, p.roll);
        }
        let k = press.clamp(0.0, 1.0);
        let e = k * k * (3.0 - 2.0 * k);
        (
            [
                p.t[0] + (p.to[0] - p.t[0]) * e,
                p.t[1] + (p.to[1] - p.t[1]) * e,
                p.t[2] + (p.to[2] - p.t[2]) * e,
            ],
            p.pitch + (p.to_pitch - p.pitch) * e,
            p.roll + (p.to_roll - p.roll) * e,
        )
    }

    /// Where a capsule's own end sits in figure space once the wheel has been
    /// turned. `end` is -0.5 for the back of the shaft, +0.5 for the front.
    fn end_of(&self, part: &Part, end: f64, spin: &M4, press: f64) -> [f64; 3] {
        let (t, pitch, _roll) = self.placed(part, press);
        // a yaw-free trs puts a capsule's own z axis here
        let ax = [0.0, -pitch.sin(), pitch.cos()];
        let p = [
            t[0] + ax[0] * end * part.s[2],
            t[1] + ax[1] * end * part.s[2],
            t[2] + ax[2] * end * part.s[2],
        ];
        [
            spin[0] * p[0] + spin[4] * p[1] + spin[8] * p[2] + spin[12],
            spin[1] * p[0] + spin[5] * p[1] + spin[9] * p[2] + spin[13],
            spin[2] * p[0] + spin[6] * p[1] + spin[10] * p[2] + spin[14],
        ]
    }

    /// A capsule stretched between two points.
    fn bone(a: [f64; 3], b: [f64; 3], sx: f64, sy: f64) -> M4 {
        let mut d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(1e-4);
        d[0] /= len;
        d[1] /= len;
        d[2] /= len;
        /* Any pair of axes across the bone will do - nothing about an arm is
           keyed to its roll - so world up is the reference, unless the bone is
           nearly vertical, where it stops being a usable one. */
        let up = if d[1].abs() > 0.98 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
        let mut r = [
            up[1] * d[2] - up[2] * d[1],
            up[2] * d[0] - up[0] * d[2],
            up[0] * d[1] - up[1] * d[0],
        ];
        let rl = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt().max(1e-4);
        r[0] /= rl;
        r[1] /= rl;
        r[2] /= rl;
        let n = [
            d[1] * r[2] - d[2] * r[1],
            d[2] * r[0] - d[0] * r[2],
            d[0] * r[1] - d[1] * r[0],
        ];
        let mut o = [0.0; 16];
        o[0] = r[0] * sx;
        o[1] = r[1] * sx;
        o[2] = r[2] * sx;
        o[4] = n[0] * sy;
        o[5] = n[1] * sy;
        o[6] = n[2] * sy;
        o[8] = d[0] * len;
        o[9] = d[1] * len;
        o[10] = d[2] * len;
        o[12] = (a[0] + b[0]) * 0.5;
        o[13] = (a[1] + b[1]) * 0.5;
        o[14] = (a[2] + b[2]) * 0.5;
        o[15] = 1.0;
        o
    }

    /// Every part's world matrix, for one figure, at one steering angle.
    ///
    /// `model` is the car's own transform. Applying it here rather than on the
    /// far side is the whole saving: it is one multiply per part either way,
    /// and doing it in the same pass avoids handing seventeen matrices back
    /// only for the caller to multiply every one of them again.
    ///
    /// `spin_angle` is where the RIM is - the full steering angle through the
    /// rack, which at sixteen to one is most of a half turn at drift angles.
    /// `hand_angle` is where the hands would LIKE to be, and is not the same
    /// number: it is clamped here to whatever the arms can actually hold.
    /// `press` is 0..1 of however hard the boost is being asked for. It moves
    /// the parts that are controls, and the hand that goes to them.
    pub fn pose(&mut self, model: &[f32], spin_angle: f64, hand_angle: f64, press: f64) {
        let mut m: M4 = identity();
        for i in 0..16 {
            m[i] = *model.get(i).unwrap_or(&0.0) as f64;
        }
        let n = self.parts.len();
        let spin = self.spin_matrix(spin_angle);

        /* HOW FAR THE HANDS GO, WHICH THE ARMS DECIDE AND NOT THE RACK.
         *
         * Every arm gives an arc it can hold the rim through; the hands take
         * the intersection of them. Both hands therefore move by the same
         * angle and stay opposite each other on the rim, which is what a pair
         * of hands on a wheel look like - clamping each arm separately is more
         * physical and reads as a driver whose hands have come unstuck from
         * one another.
         *
         * Zero is forced into the arc whatever the geometry says. A figure
         * authored so badly that its rest pose is out of reach should sit
         * still, not snap somewhere else the moment it is drawn.
         */
        let mut lo = -core::f64::consts::PI * 4.0;
        let mut hi = core::f64::consts::PI * 4.0;
        let mut arms = false;
        for i in 0..n {
            let p = self.parts[i];
            if p.kind as f32 != ARM {
                continue;
            }
            let (phi, half) = self.reach_arc(&p);
            lo = lo.max(phi - half);
            hi = hi.min(phi + half);
            arms = true;
        }
        let hand = if arms {
            ease_into(
                hand_angle,
                lo.min(0.0).max(-HAND_LOCK),
                hi.max(0.0).min(HAND_LOCK),
            )
        } else {
            hand_angle
        };
        let hands = self.spin_matrix(hand);
        // a hand on its way to the console has let go, so the rim leaves it
        let gone = self.spin_matrix(hand * (1.0 - ease01(press)));

        /* THE ELBOWS, BEFORE ANYTHING IS PLACED. An upper arm is a bone to a
           joint the forearm decides, and the two parts are in whatever order
           the table happens to list them - so the joints are all solved first
           and both ends then read the same answer. */
        if self.elbow.len() != n {
            self.elbow.resize(n, None);
        }
        for e in self.elbow.iter_mut() {
            *e = None;
        }
        for i in 0..n {
            let p = self.parts[i];
            if p.kind as f32 != ARM {
                continue;
            }
            let wrist = self.wrist_of(&p, &hands, &gone, press);
            self.elbow[i] = Some(elbow_of(p.shoulder, wrist, p.upper, p.s[2], p.pole));
        }

        for i in 0..n {
            let p = self.parts[i];
            let k = p.kind as f32;
            let local = if k == ARM {
                /* THE FOREARM IS THE BONE BETWEEN THEM. Its length comes out
                   of the solve exactly - the elbow was placed at the arm's own
                   z scale from the wrist - so nothing is stretched here even
                   though `bone` would happily stretch it. */
                let wrist = self.wrist_of(&p, &hands, &gone, press);
                let elbow = self.elbow[i].unwrap_or(p.t);
                Self::bone(elbow, wrist, p.s[0], p.s[1])
            } else if k == BONE {
                let elbow = match self.elbow.get(p.reference).copied().flatten() {
                    Some(e) => e,
                    // an older-style bone, onto the back end of a placed part
                    None => match self.parts.get(p.reference) {
                        Some(f) => self.end_of(f, -0.5, &hands, press),
                        // a table naming a part that is not there poses the
                        // bone as a zero-length stub rather than reading past
                        // the end of the list
                        None => p.t,
                    },
                };
                Self::bone(p.t, elbow, p.s[0], p.s[1])
            } else {
                /* A button sinks along its own down axis, which after a
                   yaw-free trs is the second column negated. Done to the
                   translation rather than to the matrix so the housing
                   around it does not move with it. */
                let (mut t, pitch, roll) = self.placed(&p, press);
                if k == BUTTON && press > 0.0 {
                    let (cp, sp) = (pitch.cos(), pitch.sin());
                    let (cr, sr) = (roll.cos(), roll.sin());
                    let down = [-sr, -cp * cr, -sp * cr];
                    let d = press.clamp(0.0, 1.0) * p.travel;
                    t = [t[0] + down[0] * d, t[1] + down[1] * d, t[2] + down[2] * d];
                }
                let mut l = trs(t, pitch, roll);
                for c in 0..4 {
                    l[c] *= p.s[0];
                }
                for c in 4..8 {
                    l[c] *= p.s[1];
                }
                for c in 8..12 {
                    l[c] *= p.s[2];
                }
                /* WHAT TURNS WITH WHAT.
                 *
                 * SPIN is the wheel itself - rim, spokes, column - and it gets
                 * the full steering angle, all the way to lock.
                 *
                 * GRIP is a hand ON that wheel, and it gets the hands' angle,
                 * which is the most of it the arms can follow.
                 *
                 * REACH is a hand LEAVING it, so the rim's angle leaves the
                 * hand as it goes: a hand that arrives at a fixed console
                 * button still carrying a hundred and eighty degrees of
                 * steering is a hand somewhere behind the driver's seat.
                 *
                 * AND A BUTTON TURNS WITH NEITHER. This list used to include
                 * BUTTON, from when the boost control was on the wheel. It has
                 * been on the centre console for a long time and the spin was
                 * never taken off it - so the console button orbited the
                 * steering hub on a two-thirds-of-a-unit radius and swung out
                 * to somewhere around the driver's right elbow, on its own,
                 * leaving its bezel behind on the console. That is the loose
                 * chunk by the elbow in the report, and at sixteen to one it
                 * would have become spectacular. */
                if k == SPIN {
                    l = mul(&spin, &l);
                } else if k == GRIP {
                    l = mul(&hands, &l);
                } else if k == REACH {
                    l = mul(&gone, &l);
                }
                l
            };
            let world = mul(&m, &local);
            for c in 0..16 {
                self.out[i * MAT + c] = world[c] as f32;
            }
        }
    }

    /* WHERE AN ARM'S WRIST ACTUALLY IS.
     *
     * It is wherever the hand went, plus the fixed offset from the middle of
     * that hand to the joint behind it. Deriving it from the hand rather than
     * from the rim is what lets the right arm follow its own hand across to
     * the console: the hand is a REACH and has somewhere else to be, and an
     * arm solved to the rim while its hand is on the boost button is an arm
     * with a gap in it.
     */
    fn wrist_of(&self, p: &Part, hands: &M4, gone: &M4, press: f64) -> [f64; 3] {
        match self.parts.get(p.reference) {
            Some(g) => {
                let (gt, _, _) = self.placed(g, press);
                let local = [
                    gt[0] + p.wrist_off[0],
                    gt[1] + p.wrist_off[1],
                    gt[2] + p.wrist_off[2],
                ];
                let frame = if g.kind as f32 == REACH { gone } else { hands };
                xform(frame, local)
            }
            // no hand named: the arm just holds the rim where it was drawn
            None => xform(hands, p.rest_wrist),
        }
    }
}


/* ------------------------------------------------------------- the eye --
 *
 * THE FIRST-PERSON CAMERA, WHICH IS THE DRIVER'S OWN.
 *
 * This replaces a bonnet camera that sat on the nose of the car and looked
 * forward over it. The bonnet was a workaround: the first attempt at a
 * first-person view put the eye at a guessed point inside a cabin that was not
 * to human scale, saw almost nothing, and was moved outside where there was
 * something to look at.
 *
 * That reason has gone. The figure in the seat is now built and measured
 * against the shipped body - a head 0.33 tall whose crown clears the headliner
 * by two centimetres - so there is a correct answer to where the eyes are, and
 * it is not a guess: it is a point on the head this module already poses.
 *
 * WHY THE CAMERA IS HERE RATHER THAN IN THE RENDERER.
 *
 * It is the same arithmetic as the figure, against the same transform, and it
 * needs the same numbers. Putting it beside them means the eye cannot drift
 * away from the head it is supposed to be inside - move the driver and the
 * camera moves with them, because it is derived from the same table rather
 * than from a constant that has to be remembered separately.
 *
 * WHAT COMES BACK is six floats: an eye and a point to look at. Everything
 * about the SHOT - the field of view, the shake, how much the free-look is
 * allowed to turn the head - stays on the renderer's side, because those are
 * presentation and this is geometry.
 */

/// Where the eyes sit on the head, in figure space.
///
/// The head is a shell centred at y 0.115 of scale 0.37 - see the parts table
/// in js/scene.js - so its crown is at 0.30 and its chin at -0.03, and the
/// headliner over the seat is at 0.323. This puts the eye at 0.23, which is
/// 9cm below the crown and 9cm under the roof: a driver's head in a car,
/// rather than a camera on top of one.
///
/// THE Z USED TO BE 0.30, AND THAT IS THE WHOLE OF THE FRAMING BUG.
///
/// It was pushed most of a head-depth forward on the grounds that a camera at
/// the centre of the skull renders the inside of the visor - which is true of
/// every view except the one this is for, because the first-person view drops
/// the helmet, the visor and the torso before it draws anything (see `own` in
/// js/scene.js). Nothing was ever there to render.
///
/// What it cost was the entire cockpit. It left the eye 36cm behind the wheel
/// instead of 59cm, so the hub sat 48 degrees below the view axis - nearly two
/// frame-heights under the bottom edge at this field of view - and the driver
/// could see the top arc of the rim and nothing holding it. Both hands, both
/// forearms and the whole of the dash the hands are over were off the screen.
/// A shot of that looks like a wheel that turns itself, and no amount of work
/// on the arms can show up in it.
///
/// At 0.06 the eye sits just forward of the head's centre, where an eye is,
/// and the hands land in the bottom quarter of the frame where they belong.
const EYE: [f64; 3] = [0.0, 0.115, 0.06];

/// How far ahead the look-at point is put. Far enough that the direction is
/// what matters and the distance does not.
const AHEAD: f64 = 30.0;

impl Rig {
    /// The driver's eye and where it is looking, in world space.
    ///
    /// `yaw` and `pitch` are the car's, plus whatever the free-look has added;
    /// the caller composes those because it owns the input. The eye itself is
    /// put through the car's own transform, so it inherits the body roll, the
    /// road pitch and the yaw for free - which is the whole point of a view
    /// from inside a car, and the reason it is not built from a position and a
    /// heading independently.
    pub fn pov(&mut self, model: &[f32], yaw: f64, pitch: f64) -> &[f32] {
        let mut m = [0.0f64; 16];
        for i in 0..16 {
            m[i] = *model.get(i).unwrap_or(&0.0) as f64;
        }
        // the head's own placement, so the eye follows the driver rather than
        // a second copy of where the driver is supposed to be
        let h = self.head;
        let p = [h[0] + EYE[0], h[1] + EYE[1], h[2] + EYE[2]];
        let ex = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
        let ey = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
        let ez = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];

        let (sy, cy) = (yaw.sin(), yaw.cos());
        let rise = pitch.tan() * AHEAD;

        /* THE CAR'S OWN UP, WHICH IS THE WHOLE OF THE ROLL PROBLEM.

           The eye is put through the car's transform, so it rolls with the
           body - and so does everything the driver is sitting in. The view
           did NOT: it was built against world up, always level. The result
           is that the cabin appears to rotate about the camera through
           every corner, and at speed it swings far enough to fill the frame
           with a door card. That is the pale panel that was reported, and
           it is not the interior being wrong - it is the camera refusing to
           lean with the car it is bolted into.

           An interior is rigidly attached to the body, so a camera inside
           one has to share its roll exactly. Not partially: half the roll
           still swings the cabin, just half as far. This is the second
           column of the car's matrix, which is its local +Y in world space,
           normalised because the transform may carry a scale. */
        let (ux, uy, uz) = (m[4], m[5], m[6]);
        let ul = (ux * ux + uy * uy + uz * uz).sqrt().max(1e-9);

        self.cam = [
            ex as f32,
            ey as f32,
            ez as f32,
            (ex + sy * AHEAD) as f32,
            (ey + rise) as f32,
            (ez + cy * AHEAD) as f32,
            (ux / ul) as f32,
            (uy / ul) as f32,
            (uz / ul) as f32,
        ];
        &self.cam
    }

    /// Where the head is, which the eye is measured from. Set with the table.
    pub fn set_head(&mut self, x: f64, y: f64, z: f64) {
        self.head = [x, y, z];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The figure as js/scene.js actually authors it, cut down to the pieces
    /// these tests are about: the hub, one glove on the rim, the forearm it is
    /// on, and the upper arm solved back to a fixed shoulder.
    fn rig() -> Rig {
        let mut r = Rig::new();
        /* THE SAME NUMBERS THE GAME SHIPS. A fixture that drifts from the
           rig it stands in for keeps passing while the thing it is about
           breaks, which is what happened here: this still described a 60cm
           wheel with the hands at nine and three long after neither was
           true. Every row below is copied from build() in js/scene.js. */
        r.set_hub(-0.42, -0.09, 0.845, 0.42);
        // t xyz, s xyz, pitch, roll, kind, ref, spare, spare
        #[rustfmt::skip]
        let table: Vec<f32> = vec![
            // 0: the rim itself, which turns about its own axis - 36cm across
            -0.42, -0.09, 0.845, 0.36, 0.36, 0.36,  0.42, 0.0,  SPIN, 0.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            // 1: a forearm - not placed, but solved to the glove below it
            -0.58, -0.044, 0.701, 0.115, 0.108, 0.26, -0.20, 0.10, ARM, 2.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            // 2: a glove, on the rim at ten o'clock, which rides it
            -0.576, 0.004, 0.854, 0.105, 0.098, 0.115, -0.20, 0.0, GRIP, 0.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            // 3: the upper arm, 0.32 long, from a fixed shoulder to part 1's elbow
            -0.62, -0.075, 0.37, 0.135, 0.135, 0.0, 0.0, 0.0,   BONE, 1.0, 0.0, 0.32,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            // 4: the torso, which does none of this
            -0.42, -0.30, 0.26,  0.56, 0.74, 0.42, -0.20, 0.0,  PLAIN, 0.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        ];
        r.load(&table);
        r
    }

    fn origin(r: &Rig, i: usize) -> [f64; 3] {
        [
            r.out[i * MAT + 12] as f64,
            r.out[i * MAT + 13] as f64,
            r.out[i * MAT + 14] as f64,
        ]
    }

    fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
        ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
    }

    fn eye() -> Vec<f32> {
        let mut m = vec![0.0f32; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        m
    }

    /* THE HAND NEVER LEAVES THE RIM.
     *
     * A hand on a wheel goes round the wheel. The first version of this
     * rotated each glove about its OWN origin, which spins a hand on the spot
     * and leaves it exactly where it was - a driver who is not holding
     * anything. The second version orbited the hub with a rotation matrix
     * multiplied out by hand, and four of its signs were wrong, so the grip
     * radius drifted by a fifth of the rim as the wheel turned.
     *
     * Both are the same test: measure the glove against the hub at every
     * angle. It must move, and the distance must not change. */
    #[test]
    fn a_grip_never_leaves_the_rim() {
        let mut r = rig();
        let m = eye();
        r.pose(&m, 0.0, 0.0, 0.0);
        let hub = origin(&r, 0);
        let rest = origin(&r, 2);
        let radius = dist(rest, hub);
        // a 36cm rim is 0.18 of radius, and a hand sits just inside it
        assert!(radius > 0.12, "the glove is on the hub, not the rim: {radius:.4}");

        let mut moved: f64 = 0.0;
        for step in -8..=8 {
            let a = step as f64 * 0.18;
            r.pose(&m, a, a, 0.0);
            let hub_now = origin(&r, 0);
            let grip = origin(&r, 2);
            assert!(
                // the pose is written as f32, so 1e-5 is the floor of what
                // can be asserted about it at all - not a slack tolerance
                dist(hub_now, hub) < 1e-5,
                "the hub moved when the wheel turned: {:.6}",
                dist(hub_now, hub)
            );
            let rad = dist(grip, hub_now);
            assert!(
                (rad - radius).abs() < 1e-5,
                "at {a:.2} rad the grip is {rad:.6} from the hub, not {radius:.6}"
            );
            moved = moved.max(dist(grip, rest));
        }
        /* Lock to lock over this sweep is 2.88 rad, so a hand on a 0.18
           rim travels a 0.24 chord. A hand turning on the spot travels
           nothing at all, which is the failure being excluded. */
        assert!(moved > 0.15, "the hands barely moved: {moved:.4} - they are turning on the spot");
    }

    /* THE ARM STAYS ATTACHED AT BOTH ENDS.
     *
     * The shoulder is fixed and the hand is not, so the arm between them
     * cannot be a fixed pose. A bone that reaches the elbow at rest and misses
     * it at lock is exactly the failure this replaced. */
    #[test]
    fn an_upper_arm_follows_the_hand() {
        let mut r = rig();
        let m = eye();
        let shoulder = [-0.62, -0.075, 0.37];
        let mut span = (f64::MAX, f64::MIN);
        for step in -8..=8 {
            let a = step as f64 * 0.18;
            r.pose(&m, a, a, 0.0);
            let arm = origin(&r, 3);
            // the bone's origin is its midpoint, so both ends are one half-axis away
            let half = [
                r.out[3 * MAT + 8] as f64 * 0.5,
                r.out[3 * MAT + 9] as f64 * 0.5,
                r.out[3 * MAT + 10] as f64 * 0.5,
            ];
            let top = [arm[0] - half[0], arm[1] - half[1], arm[2] - half[2]];
            assert!(
                dist(top, shoulder) < 1e-6,
                "at {a:.2} rad the arm has come off the shoulder by {:.5}",
                dist(top, shoulder)
            );
            let len = (half[0] * half[0] + half[1] * half[1] + half[2] * half[2]).sqrt() * 2.0;
            span = (span.0.min(len), span.1.max(len));
        }
        /* AND IT IS THE SAME ARM THROUGHOUT.

           This used to assert the opposite - that the bone CHANGED length by
           at least two centimetres - because the only way a fixed shoulder
           reached a forearm that had been carried bodily round the hub was to
           telescope, and the test was written to describe what the code did.
           A limb that grows and shrinks as the wheel turns is not an arm; it
           was only ever invisible because the wheel barely turned. Now the
           elbow is solved and the bone has the length the table gives it, at
           every angle. */
        assert!(
            span.1 - span.0 < 2e-3,
            "the upper arm telescoped between {:.4} and {:.4} as the wheel turned",
            span.0,
            span.1
        );
        assert!(
            (span.0 - 0.32).abs() < 2e-3,
            "the upper arm solved at {:.4} rather than the 0.32 it was given",
            span.0
        );
    }

    /* THE ARM DOES NOT COME APART, AND DOES NOT GO THROUGH ITSELF.
     *
     * Three joints, two segments, and the only thing that may change between
     * frames is the angle at the elbow. Both segments keep the length the
     * table gives them at every steering angle in the sweep, and the wrist
     * stays on the rim - which together are the whole contract of the solve.
     */
    #[test]
    fn an_arm_keeps_its_own_bones() {
        let mut r = rig();
        let m = eye();
        let shoulder = [-0.62, -0.075, 0.37];
        let mut bend = (f64::MAX, f64::MIN);
        for step in -12..=12 {
            let a = step as f64 * 0.16;
            r.pose(&m, a, a, 0.0);
            // the forearm, by its own matrix: origin at the middle, z the shaft
            let mid = origin(&r, 1);
            let half = [
                r.out[1 * MAT + 8] as f64 * 0.5,
                r.out[1 * MAT + 9] as f64 * 0.5,
                r.out[1 * MAT + 10] as f64 * 0.5,
            ];
            let elbow = [mid[0] - half[0], mid[1] - half[1], mid[2] - half[2]];
            let wrist = [mid[0] + half[0], mid[1] + half[1], mid[2] + half[2]];
            let fore = dist(elbow, wrist);
            assert!(
                (fore - 0.26).abs() < 2e-3,
                "at {a:.2} rad the forearm is {fore:.4} long, not 0.26"
            );
            let up = dist(shoulder, elbow);
            assert!(
                (up - 0.32).abs() < 2e-3,
                "at {a:.2} rad the upper arm is {up:.4} long, not 0.32"
            );
            // ...and the hand is still on the end of it
            let hand = origin(&r, 2);
            assert!(
                dist(hand, wrist) < 0.06,
                "at {a:.2} rad the glove is {:.4} from the wrist",
                dist(hand, wrist)
            );
            bend = (bend.0.min(dist(shoulder, wrist)), bend.1.max(dist(shoulder, wrist)));
        }
        /* THE ELBOW HAS TO ACTUALLY WORK. A shoulder-to-wrist distance that
           never changes is an arm being carried round rigidly, which is the
           thing this replaced. */
        assert!(
            bend.1 - bend.0 > 0.03,
            "the arm held one shape all the way round ({:.4}..{:.4})",
            bend.0,
            bend.1
        );
        // and it is never asked to be longer than it is
        assert!(bend.1 < 0.58, "the arm was stretched to {:.4} of a 0.58 reach", bend.1);
    }

    /* THE HANDS GO ROUND FAR ENOUGH TO BE WORTH DRAWING.
     *
     * The figure as it was could hold the rim through about four degrees
     * before the arm ran out, which is why a sixteen-to-one rack looked like a
     * ten-degree one. The arms are now long enough and the shoulder forward
     * enough that a hand follows a real corner most of the way round.
     */
    #[test]
    fn the_hands_follow_a_real_corner() {
        let mut r = rig();
        let m = eye();
        r.pose(&m, 0.0, 0.0, 0.0);
        let hub = origin(&r, 0);
        let rest = origin(&r, 2);
        let angle = |p: [f64; 3], q: [f64; 3]| -> f64 {
            let a = sub3(p, hub);
            let b = sub3(q, hub);
            (dot3(a, b) / (len3(a) * len3(b)).max(1e-9)).clamp(-1.0, 1.0).acos()
        };
        // a quarter turn of wheel, which is what a normal corner now asks for
        r.pose(&m, 1.57, 1.57, 0.0);
        let went = angle(rest, origin(&r, 2));
        assert!(
            went > 1.0,
            "at a quarter turn of wheel the hands moved {:.0} degrees",
            went.to_degrees()
        );
        /* ...and at a drift they stop, while the rim does not. The wheel is
           at three radians and the hands are nowhere near it: that gap IS the
           shuffle, and a hand that kept up with the rim here would be under
           the wheel with the arm through the windscreen. */
        r.pose(&m, 3.2, 3.2, 0.0);
        let far = angle(rest, origin(&r, 2));
        assert!(
            far < 2.0,
            "the hands followed the rim to {:.0} degrees of drift lock",
            far.to_degrees()
        );
        assert!(far >= went - 1e-9, "the hands went BACKWARDS past the limit");
    }

    /* A HAND ON ITS WAY TO THE CONSOLE HAS LET GO OF THE WHEEL.
     *
     * A REACH used to keep the rim's rotation all the way across, which is
     * right at the start of the move and nonsense at the end of it: the boost
     * button is bolted to the car, so a hand arriving at it while still
     * carrying a hundred and eighty degrees of steering arrives somewhere
     * behind the seat. Fully pressed, the steering angle must not move the
     * hand at all.
     */
    #[test]
    fn a_pressing_hand_ignores_the_wheel() {
        let mut r = Rig::new();
        r.set_hub(0.0, 0.0, 0.0, 0.42);
        #[rustfmt::skip]
        let table: Vec<f32> = vec![
            0.3, 0.0, 0.0,  0.1, 0.1, 0.1,  0.0, 0.0,  REACH, 0.0, 0.0, 0.0,
            0.0, -0.4, 0.2,  0.0, 0.0, 0.0,
        ];
        r.load(&table);
        r.pose(&eye(), 1.4, 1.4, 1.0);
        let a = [r.out[12] as f64, r.out[13] as f64, r.out[14] as f64];
        r.pose(&eye(), -1.4, -1.4, 1.0);
        let b = [r.out[12] as f64, r.out[13] as f64, r.out[14] as f64];
        assert!(
            dist(a, b) < 1e-5,
            "lock to lock moved a fully pressed hand by {:.4}",
            dist(a, b)
        );
        // ...and it is on the button, not near it
        assert!(
            dist(a, [0.0, -0.4, 0.2]) < 1e-5,
            "the hand arrived {:.4} from the button",
            dist(a, [0.0, -0.4, 0.2])
        );
        // at rest it still rides the rim, or it never held the wheel at all
        r.pose(&eye(), 1.4, 1.4, 0.0);
        let held = [r.out[12] as f64, r.out[13] as f64, r.out[14] as f64];
        r.pose(&eye(), -1.4, -1.4, 0.0);
        let other = [r.out[12] as f64, r.out[13] as f64, r.out[14] as f64];
        assert!(dist(held, other) > 0.1, "an unpressed hand did not ride the wheel");
    }

    /// A part that is not on the wheel must not care what the wheel is doing.
    #[test]
    fn the_wheel_does_not_move_the_body() {
        let mut r = rig();
        let m = eye();
        r.pose(&m, 0.0, 0.0, 0.0);
        let rest = origin(&r, 4);
        r.pose(&m, 1.45, 1.45, 0.0);
        let locked = origin(&r, 4);
        assert!(
            dist(rest, locked) < 1e-6,
            "turning the wheel moved the torso by {:.6}",
            dist(rest, locked)
        );
    }

    /// The car's own transform is applied here, so the whole figure has to move
    /// with it - and by exactly as much.
    #[test]
    fn the_figure_rides_the_car() {
        let mut r = rig();
        let mut m = eye();
        r.pose(&m, 0.3, 0.3, 0.0);
        let before: Vec<[f64; 3]> = (0..r.len()).map(|i| origin(&r, i)).collect();
        m[12] = 120.0;
        m[13] = 4.0;
        m[14] = -37.5;
        r.pose(&m, 0.3, 0.3, 0.0);
        for i in 0..r.len() {
            let a = before[i];
            let b = origin(&r, i);
            let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            assert!(
                (d[0] - 120.0).abs() < 1e-4 && (d[1] - 4.0).abs() < 1e-4 && (d[2] + 37.5).abs() < 1e-4,
                "part {i} moved by {d:?} rather than with the car"
            );
        }
    }

    /* THE EYE IS IN THE DRIVER'S HEAD, AND STAYS THERE.
     *
     * The whole reason this is next to the figure rather than in the
     * renderer is that the two must not be able to disagree. So: put the
     * head somewhere, ask for the eye, and check it came out of the head
     * rather than out of a constant that used to match it.
     */
    #[test]
    fn the_eye_is_in_the_head() {
        let mut r = rig();
        r.set_head(-0.42, 0.115, 0.20);
        let cam = r.pov(&eye(), 0.0, 0.0).to_vec();
        let e = [cam[0] as f64, cam[1] as f64, cam[2] as f64];
        // x is the head's own, y a little above its centre, z in front of it
        assert!((e[0] + 0.42).abs() < 1e-5, "the eye is not on the head's own x: {}", e[0]);
        assert!(e[1] > 0.115 && e[1] < 0.40, "the eye is not on the face: y {}", e[1]);
        assert!(e[2] > 0.20, "the eye is behind the middle of the skull: z {}", e[2]);
        /* ...and BELOW the roof, which is what the bonnet camera existed to
           work around. Over the seat the headliner is at 0.385. */
        assert!(e[1] < 0.385, "the eye is through the roof at y {}", e[1]);

        /* AND IT CAN SEE THE WHEEL IT IS HOLDING.
         *
         * The eye being on the face is not enough - it was on the face when
         * the whole cockpit was two frame-heights below the bottom edge. What
         * makes a first-person view a driving position is where the eye is
         * relative to the WHEEL, and the core knows where that is, because
         * the hub is loaded with the rig.
         *
         * Behind it far enough to see over it, above it by less than a head.
         * At 36cm behind and 40cm above - which is what shipped - the hub sat
         * 48 degrees down and the hands were off the screen. */
        let hub = [-0.42f64, -0.09, 0.845];
        let back = hub[2] - e[2];
        let rise = e[1] - hub[1];
        assert!(back > 0.45, "the eye is {back:.3}u behind the wheel - too close to see over it");
        assert!(rise < 0.40, "the eye is {rise:.3}u above the hub - the wheel is off the bottom");
        assert!(
            (rise / back).atan() < 0.52,
            "the hub is {:.0} degrees below the view axis, so the hands are out of frame",
            (rise / back).atan().to_degrees()
        );

        // move the head, and the eye must move with it by exactly as much
        r.set_head(-0.42, 0.315, 0.20);
        let up = r.pov(&eye(), 0.0, 0.0).to_vec();
        assert!(
            ((up[1] - cam[1]) as f64 - 0.2).abs() < 1e-4,
            "the eye did not follow the head: it moved {}",
            up[1] - cam[1]
        );
    }

    /* THE VIEW LEANS WITH THE CAR.
     *
     * The interior is bolted to the body. A camera inside it that stays
     * level while the body rolls makes the whole cabin rotate about the
     * frame, and at speed that is a door card across the view.
     */
    #[test]
    fn the_view_rolls_with_the_body() {
        let mut r = rig();
        r.set_head(-0.42, 0.115, 0.20);
        for a in [0.0f64, 0.12, -0.3] {
            // a roll about the car's own forward axis, which is z here
            let (c, s2) = (a.cos(), a.sin());
            let mut m = eye();
            m[0] = c as f32; m[1] = s2 as f32;
            m[4] = -s2 as f32; m[5] = c as f32;
            let cam = r.pov(&m, 0.0, 0.0).to_vec();
            let up = [cam[6] as f64, cam[7] as f64, cam[8] as f64];
            let len = (up[0] * up[0] + up[1] * up[1] + up[2] * up[2]).sqrt();
            assert!((len - 1.0).abs() < 1e-5, "up is not a unit vector: {len}");
            /* It must be the car's up, not the world's: at a roll of a, the
               car's +Y has swung by exactly a. */
            let got = up[0].atan2(up[1]);
            assert!(
                (got + a).abs() < 1e-4,
                "at {a:.2} rad of roll the view leaned {:.4}",
                -got
            );
        }
    }

    /// It looks where the car is pointed, and rides the car's own transform.
    #[test]
    fn the_eye_looks_where_the_car_points() {
        let mut r = rig();
        r.set_head(-0.42, 0.115, 0.20);
        for a in [0.0, 0.8, -1.9, 3.0] {
            let cam = r.pov(&eye(), a, 0.0).to_vec();
            let dx = (cam[3] - cam[0]) as f64;
            let dz = (cam[5] - cam[2]) as f64;
            let len = (dx * dx + dz * dz).sqrt();
            assert!(len > 1.0, "the look-at is on top of the eye");
            let got = dx.atan2(dz);
            let want = a;
            let diff = ((got - want + core::f64::consts::PI).rem_euclid(
                2.0 * core::f64::consts::PI)) - core::f64::consts::PI;
            assert!(diff.abs() < 1e-4, "at yaw {a:.2} it looks {got:.4}");
        }
        // ...and the whole thing moves with the car
        let rest = r.pov(&eye(), 0.0, 0.0).to_vec();
        let mut m = eye();
        m[12] = 40.0;
        m[14] = -7.0;
        let moved = r.pov(&m, 0.0, 0.0).to_vec();
        assert!((moved[0] - rest[0] - 40.0).abs() < 1e-3, "the eye did not ride the car in x");
        assert!((moved[2] - rest[2] + 7.0).abs() < 1e-3, "the eye did not ride the car in z");
    }

    /// A button sinks when it is pressed, and only when it is pressed.
    #[test]
    fn a_button_travels_when_pressed() {
        let mut r = Rig::new();
        r.set_hub(0.0, 0.0, 0.0, 0.0);
        #[rustfmt::skip]
        let table: Vec<f32> = vec![
            0.0, 0.5, 0.0,  0.1, 0.1, 0.1,  0.0, 0.0,  BUTTON, 0.0, 0.02, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        ];
        r.load(&table);
        r.pose(&eye(), 0.0, 0.0, 0.0);
        let rest = r.out[13];
        r.pose(&eye(), 0.0, 0.0, 1.0);
        let down = r.out[13];
        assert!(
            ((rest - down) as f64 - 0.02).abs() < 1e-5,
            "a fully pressed button moved {} rather than its 0.02 of travel",
            rest - down
        );
        // ...and half a press is half the travel, so it can follow a ramp
        r.pose(&eye(), 0.0, 0.0, 0.5);
        assert!((((rest - r.out[13]) as f64) - 0.01).abs() < 1e-5, "the travel is not linear");
        // an unpressed button is exactly where the table put it
        r.pose(&eye(), 0.0, 0.0, 0.0);
        assert!((r.out[13] - rest).abs() < 1e-6, "it did not come back up");
    }

    /* THE HAND LEAVES THE WHEEL AND COMES BACK.
     *
     * Three things have to be true of it, and the middle one is the one that
     * makes it read as a person rather than as a lerp:
     *
     *   at rest it is exactly where the table put it, so a driver who never
     *   touches the boost has both hands where they have always been;
     *
     *   it eases - it leaves fast and arrives slowly - because a limb that
     *   travels at one speed from end to end is the clearest possible tell
     *   that something is being interpolated;
     *
     *   and it arrives, exactly, at the button.
     */
    #[test]
    fn a_hand_reaches_and_returns() {
        let mut r = Rig::new();
        r.set_hub(0.0, 0.0, 0.0, 0.0);
        // rests at x 0, reaches to x 1
        #[rustfmt::skip]
        let table: Vec<f32> = vec![
            0.0, 0.0, 0.0,  0.1, 0.1, 0.1,  0.0, 0.0,  REACH, 0.0, 0.0, 0.0,
            1.0, 0.0, 0.0,  0.0, 0.0, 0.0,
        ];
        r.load(&table);

        r.pose(&eye(), 0.0, 0.0, 0.0);
        assert!(r.out[12].abs() < 1e-6, "at rest the hand has already moved: {}", r.out[12]);
        r.pose(&eye(), 0.0, 0.0, 1.0);
        assert!((r.out[12] - 1.0).abs() < 1e-6, "it did not arrive: {}", r.out[12]);
        r.pose(&eye(), 0.0, 0.0, 0.0);
        assert!(r.out[12].abs() < 1e-6, "it did not come back: {}", r.out[12]);

        /* THE EASE. At the half way point a smoothstep is exactly half, so
           that says nothing on its own - what separates it from a straight
           line is the ENDS. A tenth of the way through, a linear hand is a
           tenth of the way across; an eased one has barely left. */
        r.pose(&eye(), 0.0, 0.0, 0.1);
        let early = r.out[12] as f64;
        assert!(early < 0.05, "the hand left at a constant speed: {early:.4} at 10%");
        r.pose(&eye(), 0.0, 0.0, 0.9);
        let late = r.out[12] as f64;
        assert!(late > 0.95, "the hand arrived at a constant speed: {late:.4} at 90%");
        r.pose(&eye(), 0.0, 0.0, 0.5);
        assert!(((r.out[12] as f64) - 0.5).abs() < 1e-5, "it is not symmetrical");
    }

    /// A table naming a part that is not there must not read past the end of it.
    #[test]
    fn a_bad_reference_is_survivable() {
        let mut r = Rig::new();
        r.set_hub(0.0, 0.0, 0.0, 0.0);
        #[rustfmt::skip]
        let table: Vec<f32> = vec![
            0.0, 0.0, 0.0,  0.15, 0.15, 0.0,  0.0, 0.0,  BONE, 99.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        ];
        r.load(&table);
        r.pose(&eye(), 0.4, 0.4, 0.0);
        assert_eq!(r.len(), 1);
        assert!(r.out.iter().all(|v| v.is_finite()), "a bad reference produced a NaN pose");
    }
}
