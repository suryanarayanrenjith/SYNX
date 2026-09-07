/* SYNX Synthwave eXtreme racing
 * The windscreen, and what a hard enough impact does to it.
 *
 * WHY THIS IS A TEXTURE AND NOT A SHADER
 * --------------------------------------
 * Laminated glass does not crack procedurally. It fails from a point, throws a
 * set of radial cracks outward, and then ties those together with lateral ones
 * that run BETWEEN adjacent radials - which is a graph, not a noise field. The
 * closed-form versions of this (Voronoi, a distance field of a few lines) all
 * give the same answer: something that looks like a spider drawn on the frame,
 * because it has no crushed core, no branch, and every crack is the same
 * width from end to end.
 *
 * Drawing it once with a 2D canvas gets all three for free - a stroke has a
 * width, a path can branch, and a polygon can be filled - and it costs a few
 * milliseconds ON THE FRAME OF THE IMPACT and nothing at all after that. What
 * the renderer sees is one RGB texture:
 *
 *      R    how much fracture is here. It carries two things at two scales -
 *           a hard, narrow ridge where a crack actually runs, and a soft halo
 *           around every crack and over the crushed core where the glass has
 *           milled itself opaque. The composite separates them with two
 *           smoothsteps, which is cheaper than a second channel and puts the
 *           frost exactly where the fracture is by construction.
 *      GB   this SHARD's offset, signed around 0.5 - every fragment of a
 *           broken screen sits at its own angle, so what you see through it is
 *           displaced, and the displacement is constant across a shard and
 *           discontinuous at its edges. That discontinuity is most of what
 *           makes it read as glass rather than as a decal of cracks.
 *
 * EVERYTHING IS DRAWN OPAQUE. A 2D canvas stores premultiplied alpha, so a
 * colour written at low alpha comes back quantised to a few levels and a
 * colour written at zero alpha comes back as nothing at all - which would
 * destroy exactly the channels the offsets live in. The sheet is therefore
 * cleared to opaque neutral (offset zero, no crack) and everything after that
 * is either an opaque fill or an additive stroke.
 *
 * The composite is in FINAL_FRAG, which is the last pass before the frame is
 * presented, so the cracks are in front of the bloom, the grade and the motion
 * blur - in front of the picture, which is where a windscreen is.
 *
 * IT IS NEVER FATAL AND NEVER PERMANENT. The screen heals over about twelve
 * seconds, because a racer that ends up with an unreadable windscreen twenty
 * seconds into a twenty-minute route has taken the game away from the player
 * as a punishment for touching a wall.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};

  const SIZE = 512;              // the crack sheet, square, sampled by screen uv
  const MAX_SITES = 4;           // impacts held at once; the oldest is dropped
  const HEAL = 0.085;            // per second, once the impact has settled

  /* A deterministic little generator so one impact draws the same star every
     time it is asked to redraw, and two impacts never draw the same one. */
  function rng(seed) {
    let x = (seed | 0) || 1;
    return () => {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return ((x >>> 0) % 100000) / 100000;
    };
  }

  class Glass {
    constructor(gl) {
      this.gl = gl;
      this.sites = [];
      this.amount = 0;          // 0..1, what the composite multiplies by
      this.tex = null;
      this.dirty = false;
      this.canvas = null;
      this.ctx = null;
    }

    reset() {
      this.sites.length = 0;
      this.amount = 0;
      this.dirty = true;
    }

    _ensure() {
      if (this.ctx) return true;
      const doc = global.document;
      if (!doc) return false;
      const c = doc.createElement('canvas');
      c.width = SIZE; c.height = SIZE;
      const x = c.getContext('2d');
      if (!x) return false;
      this.canvas = c; this.ctx = x;
      const gl = this.gl;
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.dirty = true;
      return true;
    }

    /* A hit worth cracking the screen for.
     *
     * `force` is the solver's own 0..1 impact. Where the star lands is where
     * the blow came from: a hit on the left flank cracks the left of the
     * screen, one from behind cracks low and central, because that is where a
     * loose object in the cabin would have gone. It is not simulated - it is
     * the difference between a crack that belongs to the crash the player just
     * had and one that appeared in the middle of the frame. */
    impact(car, force, kind) {
      if (!this._ensure()) return;
      const f = Math.max(0, Math.min(1, force || 0));
      if (f < 0.2) return;
      const side = car && (car.lateral || 0) >= 0 ? 1 : -1;
      const lean = kind === 'car' ? 0.20 : 0.34;
      const u = 0.5 + side * lean * (0.55 + Math.random() * 0.6);
      const v = 0.44 + (Math.random() - 0.5) * 0.24;
      this.sites.push({
        u: Math.max(0.08, Math.min(0.92, u)),
        v: Math.max(0.12, Math.min(0.86, v)),
        f, seed: (Math.random() * 1e6) | 0, age: 0,
      });
      while (this.sites.length > MAX_SITES) this.sites.shift();
      this.amount = Math.min(1, this.amount + 0.35 + f * 0.65);
      this.dirty = true;
      /* How hard the frame should kick, for the caller to add to whatever the
         impact was already going to do. A crack that appears without the
         camera reacting to it reads as an overlay; this is the half-frame that
         makes it read as something that happened to the car. */
      return 0.18 + f * 0.34;
    }

    update(dt) {
      if (!this.sites.length && this.amount <= 0) return;
      for (const s of this.sites) s.age += dt;
      /* The screen clears from the outside in. Dropping a site entirely once
         it has faded keeps the redraw cheap and the texture from silting up
         with fifty invisible stars over a long route. */
      const before = this.sites.length;
      this.sites = this.sites.filter(s => s.age < 14);
      if (this.sites.length !== before) this.dirty = true;
      this.amount = Math.max(0, this.amount - HEAL * dt * (1 + this.amount));
      if (this.amount <= 0.001) { this.amount = 0; this.sites.length = 0; }
    }

    /* --------------------------------------------------------- drawing --
     *
     * One star. Radials first, because everything else is measured off where
     * they went: the shards are the wedges BETWEEN two radials, and the
     * lateral cracks run from one radial to the next, so both have to know the
     * angles the radials actually took rather than the ones they were asked
     * for. Drawing them independently produces the classic wrong version - a
     * wheel with the spokes and the rim not meeting.
     *
     * WHAT THE FIRST VERSION GOT WRONG, and it is what "looks fake" meant:
     *
     *   EVERY CRACK WAS THE SAME WIDTH along its length, because it was a
     *   stroked polyline with one lineWidth per segment. A real fracture is
     *   widest at the origin and ends in a hairline you cannot resolve, and it
     *   does that CONTINUOUSLY. Each arm is a tapering polygon now - one
     *   filled path per arm rather than a stroke - so the width is a function
     *   of distance rather than of which segment you are in.
     *
     *   NOTHING BRANCHED. One optional stub per arm is not branching; a real
     *   star is a tree, where a branch throws its own branches and each
     *   generation is thinner and shorter than its parent. It is recursive
     *   now, three deep, which is the difference between a drawn asterisk and
     *   a fracture.
     *
     *   THE CORE WAS A GLOW. An impact does not blur, it PULVERISES: the first
     *   centimetre is a cluster of individual fragments with their own seams.
     *   Those are drawn.
     */
    _arm(c, x0, y0, ang, len, wide, depth, R) {
      /* One tapering crack, as a filled polygon.
       *
       * The path runs out along one side and back along the other, so the two
       * edges are independent - which is what stops it looking like a stroked
       * line with rounded caps. Both wander, and they wander by DIFFERENT
       * amounts, because the two faces of a fracture are not parallel. */
      const STEPS = 7;
      const pts = [];
      let x = x0, y = y0, a = ang;
      const spine = [[x, y, wide]];
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        a += (R() - 0.5) * 0.34;
        const step = len / STEPS;
        x += Math.cos(a) * step;
        y += Math.sin(a) * step;
        // a fracture narrows faster than linearly and ends in nothing
        spine.push([x, y, wide * Math.pow(1 - t, 1.7)]);
      }
      // out along one side...
      for (let i = 0; i < spine.length; i++) {
        const p = spine[i];
        const n = spine[Math.min(spine.length - 1, i + 1)];
        const dx = n[0] - p[0], dy = n[1] - p[1];
        const l = Math.hypot(dx, dy) || 1;
        const w = p[2] * (0.72 + R() * 0.56);
        pts.push([p[0] - dy / l * w, p[1] + dx / l * w]);
      }
      // ...and back along the other
      for (let i = spine.length - 1; i >= 0; i--) {
        const p = spine[i];
        const n = spine[Math.max(0, i - 1)];
        const dx = p[0] - n[0], dy = p[1] - n[1];
        const l = Math.hypot(dx, dy) || 1;
        const w = p[2] * (0.72 + R() * 0.56);
        pts.push([p[0] + dy / l * w, p[1] - dx / l * w]);
      }
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath();
      /* Brighter near the impact, because that is where the fracture actually
         goes through the laminate; the far end is a surface hairline. */
      const v = Math.round(120 + 135 * Math.min(1, wide / 2.2));
      c.fillStyle = 'rgb(' + v + ',0,0)';
      c.fill();

      /* CHILDREN. A fracture branches where the stress ran out of one
         direction to go; each is shorter, thinner and turned away from its
         parent. Three generations is enough to read as a tree and cheap enough
         to draw four of on the frame of an impact. */
      if (depth <= 0) return spine;
      const kids = depth === 3 ? 2 : 1;
      for (let k = 0; k < kids; k++) {
        if (R() > 0.72) continue;
        const i = 1 + Math.floor(R() * (spine.length - 2));
        const from = spine[i];
        const off = (R() < 0.5 ? -1 : 1) * (0.5 + R() * 0.7);
        this._arm(c, from[0], from[1],
          Math.atan2(from[1] - y0, from[0] - x0) + off,
          len * (0.30 + R() * 0.26), from[2] * 0.62, depth - 1, R);
      }
      return spine;
    }

    _star(c, site) {
      const R = rng(site.seed);
      const cx = site.u * SIZE, cy = (1 - site.v) * SIZE;
      const reach = SIZE * (0.16 + site.f * 0.34);
      const spokes = 7 + Math.floor(R() * 6 + site.f * 4);

      // where each radial went, sampled at four radii, so the laterals and the
      // shard fills can follow the same jagged line
      const rings = [0.16, 0.40, 0.68, 1.0];
      const arms = [];
      for (let i = 0; i < spokes; i++) {
        const a0 = (i / spokes) * Math.PI * 2 + R() * 0.42;
        const pts = [[cx, cy]];
        let a = a0;
        for (const t of rings) {
          a += (R() - 0.5) * 0.30;               // a crack wanders as it runs
          const r = reach * t * (0.72 + R() * 0.5);
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
        arms.push(pts);
      }

      /* THE SHARDS, first and underneath: each wedge gets one offset, which is
         what the composite refracts by. Encoded around 0.5 so it is signed,
         and scaled by how near the impact it is - a fragment at the edge of
         the damage is barely disturbed. */
      for (let i = 0; i < spokes; i++) {
        const a = arms[i], b = arms[(i + 1) % spokes];
        for (let k = 1; k < rings.length; k++) {
          const near = 1 - (k - 1) / (rings.length - 1);
          const amp = (0.10 + near * 0.36) * site.f;
          const ox = Math.round(128 + (R() - 0.5) * 250 * amp);
          const oy = Math.round(128 + (R() - 0.5) * 250 * amp);
          // opaque: see the note at the top about premultiplied alpha
          c.fillStyle = 'rgb(0,' + ox + ',' + oy + ')';
          c.beginPath();
          c.moveTo(a[k - 1][0], a[k - 1][1]);
          c.lineTo(a[k][0], a[k][1]);
          c.lineTo(b[k][0], b[k][1]);
          c.lineTo(b[k - 1][0], b[k - 1][1]);
          c.closePath();
          c.fill();
        }
      }

      /* THE CRACKS. Red channel only - the composite reads R as "how much
         fracture" and lights it from the frame behind, which is why a crack
         over a bright headlight flares and one over the night sky is a dark
         hairline. Additive, so two stars that overlap get brighter rather than
         the later one replacing the earlier one's shards. */
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.lineCap = 'round';
      c.lineJoin = 'round';
      for (let i = 0; i < spokes; i++) {
        const a0 = Math.atan2(arms[i][1][1] - cy, arms[i][1][0] - cx);
        this._arm(c, cx, cy, a0, reach * (0.78 + R() * 0.5),
          1.0 + site.f * 2.4, 3, R);
      }
      // the laterals: arcs from one radial to the next, at each ring
      for (let k = 1; k < rings.length; k++) {
        if (k === rings.length - 1 && R() < 0.4) continue;   // the outer ring is often open
        for (let i = 0; i < spokes; i++) {
          if (R() < 0.22) continue;                          // ...and always broken
          const a = arms[i][k], b = arms[(i + 1) % spokes][k];
          const mx = (a[0] + b[0]) * 0.5 + (R() - 0.5) * 14;
          const my = (a[1] + b[1]) * 0.5 + (R() - 0.5) * 14;
          c.strokeStyle = 'rgba(' + Math.round(120 + 90 * (1 - k / rings.length)) + ',0,0,1)';
          c.lineWidth = Math.max(0.55, (0.8 + site.f * 1.5) * (1 - k / (rings.length + 1)));
          c.beginPath();
          c.moveTo(a[0], a[1]);
          c.quadraticCurveTo(mx, my, b[0], b[1]);
          c.stroke();
        }
      }
      /* THE CRUSH ZONE. Not a glow - a cluster of individual fragments, each
         with its own seam, getting smaller toward the middle. This is the part
         the eye lands on first and the part a radial gradient cannot fake. */
      const core = reach * 0.20;
      for (let i = 0; i < 26 + Math.round(site.f * 30); i++) {
        const a = R() * Math.PI * 2, r = Math.pow(R(), 0.6) * core;
        const fx = cx + Math.cos(a) * r, fy = cy + Math.sin(a) * r;
        const size = 1.0 + (1 - r / core) * 3.4 * (0.4 + R());
        c.strokeStyle = 'rgba(' + Math.round(150 + 105 * (1 - r / core)) + ',0,0,1)';
        c.lineWidth = 0.7 + R() * 0.9;
        c.beginPath();
        for (let k = 0; k < 5; k++) {
          const ka = a + k * 1.257 + R() * 0.5;
          const kr = size * (0.55 + R() * 0.7);
          const px = fx + Math.cos(ka) * kr, py = fy + Math.sin(ka) * kr;
          if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
        }
        c.closePath();
        c.stroke();
      }
      // ...and the halo of pulverised glass around it, under the crack level
      const halo = c.createRadialGradient(cx, cy, 0, cx, cy, reach * 0.46);
      halo.addColorStop(0, 'rgba(160,0,0,' + (0.62 * site.f).toFixed(3) + ')');
      halo.addColorStop(0.4, 'rgba(140,0,0,' + (0.28 * site.f).toFixed(3) + ')');
      halo.addColorStop(1, 'rgba(140,0,0,0)');
      c.fillStyle = halo;
      c.beginPath();
      c.arc(cx, cy, reach * 0.46, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }

    /** Rebuild the sheet if anything changed, and hand back the texture. */
    texture() {
      if (!this.sites.length || this.amount <= 0) return null;
      if (!this._ensure()) return null;
      if (this.dirty) {
        const c = this.ctx;
        // clear glass: no crack (R 0), no offset (128 is signed zero), opaque
        c.globalCompositeOperation = 'source-over';
        c.clearRect(0, 0, SIZE, SIZE);
        c.fillStyle = 'rgb(0,128,128)';
        c.fillRect(0, 0, SIZE, SIZE);
        for (const s of this.sites) this._star(c, s);
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.dirty = false;
      }
      return this.tex;
    }
  }

  Glass.SIZE = SIZE;
  NR.Glass = Glass;
})(window);
