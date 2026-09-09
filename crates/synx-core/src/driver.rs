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
}

/// Column-major 4x4, the same order the renderer wants.
type M4 = [f64; 16];

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
            });
        }
        self.out.clear();
        self.out.resize(n * MAT, 0.0);
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
    /// `press` is 0..1 of however hard the boost is being asked for. It
    /// moves the parts that are controls and nothing else.
    pub fn pose(&mut self, model: &[f32], spin_angle: f64, press: f64) {
        let mut m: M4 = identity();
        for i in 0..16 {
            m[i] = *model.get(i).unwrap_or(&0.0) as f64;
        }
        let spin = self.spin_matrix(spin_angle);
        for i in 0..self.parts.len() {
            let p = self.parts[i];
            let local = match p.kind {
                k if k as f32 == BONE => {
                    let elbow = match self.parts.get(p.reference) {
                        Some(f) => self.end_of(f, -0.5, &spin, press),
                        // a table that names a part that is not there poses the
                        // bone as a zero-length stub rather than reading past
                        // the end of the list
                        None => p.t,
                    };
                    Self::bone(p.t, elbow, p.s[0], p.s[1])
                }
                _ => {
                    /* A button sinks along its own down axis, which after a
                       yaw-free trs is the second column negated. Done to the
                       translation rather than to the matrix so the housing
                       around it does not move with it. */
                    let (mut t, pitch, roll) = self.placed(&p, press);
                    if p.kind as f32 == BUTTON && press > 0.0 {
                        let (cp, sp) = (pitch.cos(), pitch.sin());
                        let (cr, sr) = (roll.cos(), roll.sin());
                        let down = [-sr, -cp * cr, -sp * cr];
                        let k = press.clamp(0.0, 1.0) * p.travel;
                        t = [t[0] + down[0] * k, t[1] + down[1] * k, t[2] + down[2] * k];
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
                    /* A reach starts on the rim, so it turns with the rim -
                       otherwise the hand lets go of a wheel that has moved out
                       from under it. It keeps doing so all the way across,
                       which is wrong by a few millimetres at the far end and
                       wrong by a whole hand if it does not. */
                    let k = p.kind as f32;
                    if k == SPIN || k == BUTTON || k == REACH {
                        l = mul(&spin, &l);
                    }
                    l
                }
            };
            let world = mul(&m, &local);
            for c in 0..16 {
                self.out[i * MAT + c] = world[c] as f32;
            }
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
/// in js/scene.js - so its crown is at 0.30 and its chin at -0.03. Eyes sit a
/// little above the middle of a face and at the front of the skull, which puts
/// them here. z is forward of the head's centre by most of its depth: a camera
/// at the centre of the skull renders the inside of the visor.
/// Raised a little from the middle of the face: at 0.155 the eye sits level
/// with the top of the seat's own bounding box, which is close enough to the
/// headrest that a hard corner can put it inside one.
const EYE: [f64; 3] = [0.0, 0.170, 0.30];

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
        r.set_hub(-0.42, -0.12, 0.86, 0.42);
        // t xyz, s xyz, pitch, roll, kind, ref, spare, spare
        #[rustfmt::skip]
        let table: Vec<f32> = vec![
            // 0: the rim itself, which turns about its own axis
            -0.42, -0.12, 0.86,  0.60, 0.60, 0.60,  0.42, 0.0,  SPIN, 0.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            // 1: a forearm, which rides the wheel
            -0.67, -0.15, 0.70,  0.13, 0.13, 0.27, -0.20, 0.10, SPIN, 0.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            // 2: a glove on the rim
            -0.69, -0.10, 0.84,  0.115, 0.135, 0.13, 0.0, 0.0,  SPIN, 0.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            // 3: the upper arm, solved from a fixed shoulder to part 1's elbow
            -0.62, 0.0195, 0.2949, 0.15, 0.15, 0.0, 0.0, 0.0,   BONE, 1.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
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
        r.pose(&m, 0.0, 0.0);
        let hub = origin(&r, 0);
        let rest = origin(&r, 2);
        let radius = dist(rest, hub);
        assert!(radius > 0.2, "the glove is on the hub, not the rim: {radius:.4}");

        let mut moved: f64 = 0.0;
        for step in -8..=8 {
            let a = step as f64 * 0.18;
            r.pose(&m, a, 0.0);
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
        assert!(moved > 0.2, "the hands barely moved: {moved:.4} - they are turning on the spot");
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
        let shoulder = [-0.62, 0.0195, 0.2949];
        let mut span = (f64::MAX, f64::MIN);
        for step in -8..=8 {
            let a = step as f64 * 0.18;
            r.pose(&m, a, 0.0);
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
        // it has to actually stretch, or it is not following anything
        assert!(
            span.1 - span.0 > 0.02,
            "the arm was the same length at every angle ({:.4}..{:.4}) - it is not solving",
            span.0,
            span.1
        );
    }

    /// A part that is not on the wheel must not care what the wheel is doing.
    #[test]
    fn the_wheel_does_not_move_the_body() {
        let mut r = rig();
        let m = eye();
        r.pose(&m, 0.0, 0.0);
        let rest = origin(&r, 4);
        r.pose(&m, 1.45, 0.0);
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
        r.pose(&m, 0.3, 0.0);
        let before: Vec<[f64; 3]> = (0..r.len()).map(|i| origin(&r, i)).collect();
        m[12] = 120.0;
        m[13] = 4.0;
        m[14] = -37.5;
        r.pose(&m, 0.3, 0.0);
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
        r.pose(&eye(), 0.0, 0.0);
        let rest = r.out[13];
        r.pose(&eye(), 0.0, 1.0);
        let down = r.out[13];
        assert!(
            ((rest - down) as f64 - 0.02).abs() < 1e-5,
            "a fully pressed button moved {} rather than its 0.02 of travel",
            rest - down
        );
        // ...and half a press is half the travel, so it can follow a ramp
        r.pose(&eye(), 0.0, 0.5);
        assert!((((rest - r.out[13]) as f64) - 0.01).abs() < 1e-5, "the travel is not linear");
        // an unpressed button is exactly where the table put it
        r.pose(&eye(), 0.0, 0.0);
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

        r.pose(&eye(), 0.0, 0.0);
        assert!(r.out[12].abs() < 1e-6, "at rest the hand has already moved: {}", r.out[12]);
        r.pose(&eye(), 0.0, 1.0);
        assert!((r.out[12] - 1.0).abs() < 1e-6, "it did not arrive: {}", r.out[12]);
        r.pose(&eye(), 0.0, 0.0);
        assert!(r.out[12].abs() < 1e-6, "it did not come back: {}", r.out[12]);

        /* THE EASE. At the half way point a smoothstep is exactly half, so
           that says nothing on its own - what separates it from a straight
           line is the ENDS. A tenth of the way through, a linear hand is a
           tenth of the way across; an eased one has barely left. */
        r.pose(&eye(), 0.0, 0.1);
        let early = r.out[12] as f64;
        assert!(early < 0.05, "the hand left at a constant speed: {early:.4} at 10%");
        r.pose(&eye(), 0.0, 0.9);
        let late = r.out[12] as f64;
        assert!(late > 0.95, "the hand arrived at a constant speed: {late:.4} at 90%");
        r.pose(&eye(), 0.0, 0.5);
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
        r.pose(&eye(), 0.4, 0.0);
        assert_eq!(r.len(), 1);
        assert!(r.out.iter().all(|v| v.is_finite()), "a bad reference produced a NaN pose");
    }
}
