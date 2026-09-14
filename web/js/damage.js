/* SYNX Synthwave eXtreme racing
 * Body damage: what a car looks like after it has been driven into things.
 *
 * WHAT THIS IS
 * ------------
 * A car in this game hits the barrier, hits the other car, and comes out of
 * both looking exactly as it went in. Every other cue is there - the impact
 * sound, the shake, the sparks, the lost momentum - and the one thing the
 * player is actually looking at never changes, which reads as the crash not
 * having happened to the car so much as to the frame around it.
 *
 * So each car carries a small list of DENTS. A dent is a point in the car's
 * own body space, a radius, a depth and a direction, and it does two things:
 *
 *   THE PANEL GOES IN.  The vertex shader pushes every vertex inside the
 *   dent's radius along its own normal, weighted by how squarely that panel
 *   faces the impact - so a hit on the left flank crumples the left door and
 *   leaves the roof alone - and re-bends the normal from the analytic gradient
 *   of the same bowl, because a displacement nothing shades is a silhouette
 *   change nobody sees.
 *
 *   THE PAINT COMES OFF.  The fragment shader scrubs the clearcoat away around
 *   the dent along the car's long axis (which is the direction a car scrapes
 *   in), takes the smoothness down, and at the centre of a hard hit lets the
 *   primer and then bare metal through.
 *
 * WHY IT LIVES IN BODY SPACE
 * --------------------------
 * The obvious implementation is a damage texture, and it is the wrong one
 * here: the car mesh is a shipped asset whose UVs are packed for its own
 * atlas, so a texel is not a place on the car and neighbouring texels are not
 * neighbouring panels. A handful of world-space bowls transformed into the
 * body's own axes needs no UV layout at all, costs six vec4s of uniform, and
 * gives the rival, the R-IX and the player exactly the same behaviour from one
 * implementation.
 *
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------
 * Not a damage MODEL. Nothing here changes how the car drives: the solver is
 * shared with the differential harness and with the rival's racing line, and a
 * cosmetic system that quietly altered the physics would invalidate both. A
 * car that has been battered looks battered and drives the same.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};

  /* Six. The shader loops over these per vertex AND per pixel on the car, and
     the seventh dent on a car this size is always inside the radius of one of
     the first six anyway - which is what the merge below is for. */
  const MAX_DENTS = 6;

  /* The shell, measured off the shipped mesh rather than guessed: the body
     spans x -1.31..1.32, the nose reaches z 3.26 and the tail z -2.70. A dent
     is clamped into that box so a glancing blow at a weird angle cannot place
     a crater out in the air beside the car. */
  const BODY = { hx: 1.30, hy: 0.85, front: 3.10, back: -2.60 };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  class Damage {
    constructor() {
      this.dents = [];
      /* Overall paint wear, 0..1. Separate from the dents because it comes
         from a different thing: a long scrape down a wall polishes the whole
         flank dull without denting anything. */
      this.wear = 0;
      this.total = 0;                       // how battered, for the HUD
      this.buf = new Float32Array(MAX_DENTS * 4);
      this.dirBuf = new Float32Array(MAX_DENTS * 4);
      this.count = 0;
      this.dirty = true;
    }

    reset() {
      this.dents.length = 0;
      this.wear = 0;
      this.total = 0;
      this.count = 0;
      this.dirty = true;
    }

    get any() { return this.count > 0 || this.wear > 0.002; }

    /* ARRIVE WRECKED.
     *
     * Chapter 6 opens on the car Ryker put into the wall at the end of
     * ASHFALL ZERO, and it opened on a showroom one: clean panels, full bar,
     * no penalty. The chapter is about a rebuild and the thing being rebuilt
     * was in perfect condition.
     *
     * Driven through `hit` rather than by setting the numbers, so the body
     * that comes out of this is a body the dent shader already knows how to
     * draw and the solver already knows how to slow down - there is no
     * second way to be damaged. The placements are fixed rather than random
     * because this is a scripted state: every player arrives at the Forge in
     * the same wreck, and a replay of the chapter shows the same car.
     *
     * Front-left is the heaviest, because that is the corner that went into
     * the wall; the rest is what happened on the way to the Forge.
     */
    wreck() {
      this.reset();
      const HITS = [
        // x,          y,     z,      inward normal,        force
        [-BODY.hx * 0.86, 0.10, BODY.front * 0.82, 0.72, -0.10, -0.68, 1.00],
        [-BODY.hx * 0.94, -0.16, BODY.front * 0.30, 0.96, -0.06, -0.26, 0.86],
        [BODY.hx * 0.90, 0.02, BODY.front * 0.58, -0.92, -0.08, -0.38, 0.74],
        [BODY.hx * 0.82, -0.10, BODY.back * 0.62, -0.88, -0.04, 0.46, 0.68],
        [-BODY.hx * 0.70, 0.24, BODY.back * 0.84, 0.54, -0.22, 0.80, 0.80],
        [0.10, BODY.hy * 0.72, BODY.front * 0.10, -0.05, -0.98, -0.16, 0.62],
      ];
      for (const h of HITS) this.hit(h[0], h[1], h[2], h[3], h[4], h[5], h[6]);
      /* ...and then it is simply AT the end of the scale. The hits above are
         what it looks like; this is what it costs, and a wreck the player is
         told to go and get rebuilt should read as fully spent rather than as
         eighty-odd per cent of one. */
      this.wear = 1;
      this.total = 1;
      this.dirty = true;
      return this;
    }

    /* Record a hit.
     *
     * `bx,by,bz` is where it landed in body space and `nx,ny,nz` is the
     * inward direction the panel was pushed. `force` is 0..1 - the solver's
     * own `impact`, which is already normalised against the speed at which a
     * hit stops being survivable.
     *
     * Dents MERGE. Grinding along a wall generates a contact every frame, and
     * without this the list would be six copies of the same crease refreshed
     * sixty times a second: the same place hit twice deepens and widens once
     * rather than becoming two dents. */
    hit(bx, by, bz, nx, ny, nz, force) {
      const f = clamp(force || 0, 0, 1);
      if (f < 0.06) return null;
      bx = clamp(bx, -BODY.hx, BODY.hx);
      by = clamp(by, -BODY.hy, BODY.hy);
      bz = clamp(bz, BODY.back, BODY.front);
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      const radius = 0.62 + f * 0.72;
      const depth = 0.030 + f * 0.115;

      let best = null, bestD = 1e9;
      for (const d of this.dents) {
        const dd = Math.hypot(d.x - bx, d.y - by, d.z - bz);
        if (dd < bestD) { bestD = dd; best = d; }
      }
      if (best && bestD < best.r * 0.62) {
        // the same crease, hit again
        best.depth = Math.min(0.185, best.depth + depth * 0.55);
        best.r = Math.min(1.65, best.r + radius * 0.16);
        best.scuff = Math.min(1, best.scuff + 0.22 + f * 0.4);
        // the normal swings toward the new blow rather than being replaced
        const t = 0.35;
        best.nx += (nx - best.nx) * t;
        best.ny += (ny - best.ny) * t;
        best.nz += (nz - best.nz) * t;
        const l = Math.hypot(best.nx, best.ny, best.nz) || 1;
        best.nx /= l; best.ny /= l; best.nz /= l;
      } else {
        const dent = { x: bx, y: by, z: bz, r: radius, depth,
                       nx, ny, nz, scuff: 0.35 + f * 0.6 };
        if (this.dents.length >= MAX_DENTS) {
          /* Full. The shallowest goes, not the oldest: a light kerb rub from
             two minutes ago is worth less to look at than the crease this
             barrier just put in the door. */
          let worst = 0;
          for (let i = 1; i < this.dents.length; i++) {
            if (this.dents[i].depth < this.dents[worst].depth) worst = i;
          }
          if (this.dents[worst].depth < dent.depth) this.dents[worst] = dent;
        } else {
          this.dents.push(dent);
        }
      }
      this.wear = Math.min(1, this.wear + f * 0.16);
      this.total = Math.min(1, this.total + f * 0.20);
      this.dirty = true;
      return best;
    }

    /* A hit expressed the way the game has it: a world direction, and the car
       it landed on. Turns both into the body space the shader wants. */
    hitWorld(car, dirX, dirY, dirZ, force, alongHint) {
      if (!car) return;
      const cy = Math.cos(car.yaw || 0), sy = Math.sin(car.yaw || 0);
      /* Yaw only. Pitch and roll are a sprung mass moving a few degrees, and
         resolving the contact through them would place the dent by whatever
         the suspension happened to be doing on the frame of the impact. */
      let bx = dirX * cy - dirZ * sy;
      const by = dirY;
      let bz = dirX * sy + dirZ * cy;
      const l = Math.hypot(bx, by, bz) || 1;
      bx /= l; bz /= l;

      /* Where on the shell that direction lands. The contact point is where
         the inward ray crosses the body box, so a square hit on the flank
         dents the middle of the door and a glancing one at the front corner
         dents the corner. `alongHint` lets the caller bias it fore or aft -
         a nose-in impact is not the same event as a tail slap. */
      const t = Math.min(
        Math.abs(bx) > 1e-3 ? BODY.hx / Math.abs(bx) : 1e9,
        Math.abs(bz) > 1e-3 ? (bz > 0 ? BODY.front : -BODY.back) / Math.abs(bz) : 1e9);
      const px = clamp(bx * t, -BODY.hx, BODY.hx);
      const pz = clamp(bz * t + (alongHint || 0), BODY.back, BODY.front);
      const py = clamp(-0.10 + (by || 0) * 0.5, -BODY.hy, BODY.hy);
      return this.hit(px, py, pz, -bx, -0.10, -bz, force);
    }

    /* Grinding along something. Not a dent - a scrape polishes a flank rather
       than pushing it in - so this only feeds the wear term and the scuff of
       whatever crease is nearest the contact. */
    scrape(car, amount, dt) {
      const a = clamp(amount || 0, 0, 1);
      if (a < 0.05) return;
      this.wear = Math.min(1, this.wear + a * dt * 0.30);
      this.total = Math.min(1, this.total + a * dt * 0.16);
      this.dirty = true;
    }

    /** Pack the list for the shader. Rebuilt only when something changed. */
    pack() {
      if (!this.dirty) return this.count;
      const b = this.buf, n = this.dirBuf;
      const c = Math.min(MAX_DENTS, this.dents.length);
      for (let i = 0; i < c; i++) {
        const d = this.dents[i];
        b[i * 4] = d.x; b[i * 4 + 1] = d.y; b[i * 4 + 2] = d.z; b[i * 4 + 3] = d.r;
        n[i * 4] = d.nx; n[i * 4 + 1] = d.ny; n[i * 4 + 2] = d.nz; n[i * 4 + 3] = d.depth;
      }
      for (let i = c; i < MAX_DENTS; i++) {
        b[i * 4 + 3] = 0.0001;              // a zero radius is a divide by zero
        n[i * 4 + 3] = 0;
      }
      this.count = c;
      this.dirty = false;
      return c;
    }
  }

  Damage.MAX = MAX_DENTS;
  Damage.BODY = BODY;
  NR.Damage = Damage;
})(window);
