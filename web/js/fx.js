/* SYNX Synthwave eXtreme racing
 * Additive effects: neon trails, tyre marks, smoke, wall sparks, boost flame
 * and the dust the car drags past the camera at speed.
 *
 * Two systems, both one dynamic buffer of camera-facing geometry rebuilt each
 * frame. A few hundred sprites is far too little to be worth instancing, and
 * building them on the CPU keeps the whole thing in one file with no extra
 * state.
 *
 *   Particles  round or velocity-stretched quads: smoke, sparks, flame, dust.
 *   Ribbons    a strip laid through a trail of world-space nodes the car drops
 *              behind it. Two kinds - the light trails streaming off the tail
 *              lamps, which are billboarded around their own length so they
 *              read as glowing tubes from any angle, and the tyre marks a
 *              slide burns into the road, which lie flat in the ground plane
 *              because that is where a tyre mark is.
 */
(function (global) {
  'use strict';

  const G = global.NR.gl;
  const U = G.U;

  const MAX = 900;
  /* The particle field layout, mirroring `particles::f` in the core. Kept as
     one table so a spawn cannot get an offset wrong silently; the Rust side
     owns the order and nothing asserts the two agree, which is a hole worth filling. */
  const PF = {
    LIFE: 0, MAX: 1, X: 2, Y: 3, Z: 4, VX: 5, VY: 6, VZ: 7,
    SIZE: 8, GROW: 9, DRAG: 10, GRAVITY: 11, STRETCH: 12, FLOOR: 13,
    R: 14, G: 15, B: 16, A: 17, STRIDE: 18,
  };
  const FLOATS = 9;              // pos.xyz, uv.xy, rgba
  const VERTS_PER = 6;

  const VERT = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aUv;
  layout(location=2) in vec4 aCol;
  uniform mat4 uVP;
  out vec2 vUv;
  out vec4 vCol;
  void main() {
    vUv = aUv;
    vCol = aCol;
    gl_Position = uVP * vec4(aPos, 1.0);
  }`;

  const FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  in vec4 vCol;
  out vec4 outColor;
  void main() {
    // a soft round falloff, squared so the core stays hot and the edge is air
    float d = length(vUv - 0.5) * 2.0;
    float a = max(0.0, 1.0 - d);
    a *= a;
    outColor = vec4(vCol.rgb * a * vCol.a, a * vCol.a);
  }`;

  /* ---------------------------------------------------------------- ribbons

     A ribbon is a trail of world-space nodes with a colour and a width, turned
     into a strip of quads at draw time. Nodes are dropped by distance rather
     than by time: a car at 200 km/h and a car at 40 km/h then lay down the
     same shape, and the trail does not bunch into a bright knot every time the
     player lifts off.

     Light trails are billboarded about their own length - the strip is offset
     along cross(tangent, view), so it keeps its width whatever angle it is
     seen from and reads as a glowing tube rather than a ribbon that vanishes
     when it turns edge-on. Tyre marks are not: they are offset in the ground
     plane, because a mark burned into the road is a flat thing and billboarding
     it would peel it off the tarmac. */
  /** The one linear blend the trail colours are built from. */
  const mix = (a, b, t) => a + (b - a) * t;

  const TRAIL_NODES = 170;       // ~140 units of light trail behind the car
  const TRAIL_STEP = 0.85;       // world units between nodes
  const MARK_NODES = 150;
  const MARK_STEP = 1.3;
  /* Four marks per car, not two.
     Rubber is laid by whichever tyre is sliding, and on a car with brakes that
     is as often a locked front as a lit rear - so a heavy stop used to leave
     nothing on the road at all while a lift-off flick left two lines. */
  const MARK_RIBBONS = 4;
  /* Where each tyre stands, in the solver's own order: FL, FR, RL, RR
     (WHEELS in vehicle.rs), and the slip-ratio field each one reports through. */
  const MARK_SEATS = [[-1.06, 1.83], [1.06, 1.83], [-1.06, -1.88], [1.06, -1.88]];
  /* The smoke emitter's own seats: a side (-1 or +1 of the half track) and
     which end of the car (0 rear, 1 front), in the order Fx.wheels returns.
     A flat const rather than the four nested literals the loop used to build
     on every call. */
  const WHEEL_SEATS = [-1, 0, 1, 0, -1, 1, 1, 1];
  const MARK_SLIP = ['w0slipRatio', 'w1slipRatio', 'w2slipRatio', 'w3slipRatio'];

  class Ribbon {
    constructor(max, step, life, ground) {
      this.max = max;
      this.step = step;
      this.life = life;
      this.ground = !!ground;
      this.n = new Float32Array(max * 10);   // x y z  w  r g b a  age  live
      this.count = 0;                        // how many nodes are in play
      this.head = 0;                         // index of the newest
    }

    clear() { this.count = 0; this.head = 0; this.ax = this.ay = this.az = NaN; }

    write(i, x, y, z, w, r, g, b, a, fresh) {
      const o = i * 10;
      this.n[o] = x; this.n[o + 1] = y; this.n[o + 2] = z;
      this.n[o + 3] = w;
      this.n[o + 4] = r; this.n[o + 5] = g; this.n[o + 6] = b; this.n[o + 7] = a;
      if (fresh) { this.n[o + 8] = 0; this.n[o + 9] = 1; }
    }

    /* Drop a node once the emitter has actually travelled.
     *
     * The newest node is a TIP that rides along with the car, so the trail
     * stays welded to the bumper instead of trailing a gap behind it, and the
     * distance test is against the last ANCHORED node rather than against the
     * tip. Measuring against the tip is measuring against something that moves
     * with you: at 146 km/h the car covers 0.92 units a frame against a step of
     * 1.1, so the gap never once accumulated, no node was ever anchored, and
     * the single tip simply aged out and took the whole trail with it. The
     * player's trail was one dot. The rival's, sampled at a different speed,
     * was nine. */
    push(x, y, z, w, r, g, b, a) {
      if (this.count === 0) {
        this.head = 0;
        this.count = 1;
        this.write(0, x, y, z, w, r, g, b, a, true);
        this.ax = x; this.ay = y; this.az = z;
        return;
      }
      this.write(this.head, x, y, z, w, r, g, b, a, false);
      const dx = x - this.ax, dy = y - this.ay, dz = z - this.az;
      const d2 = dx * dx + dy * dy + dz * dz;
      /* A teleport is not a trail. Resetting the car to a route ten kilometres
         away would otherwise draw one enormous streak across the whole map on
         the frame it happens. */
      if (!(d2 < 4000 * 4000)) { this.clear(); return; }
      if (d2 < this.step * this.step) return;
      this.ax = x; this.ay = y; this.az = z;
      this.head = (this.head + 1) % this.max;
      if (this.count < this.max) this.count++;
      this.write(this.head, x, y, z, w, r, g, b, a, true);
    }

    age(dt) {
      if (!this.count) return;
      let live = 0;
      for (let i = 0; i < this.count; i++) {
        const o = i * 10;
        if (this.n[o + 9] < 0.5) continue;
        this.n[o + 8] += dt;
        if (this.n[o + 8] > this.life) this.n[o + 9] = 0;
        else live++;
      }
      if (!live) this.clear();
    }

    /** Oldest to newest, so the strip runs the length of the trail in order. */
    forEach(fn) {
      for (let k = 0; k < this.count; k++) {
        const i = this.count < this.max
          ? k
          : (this.head + 1 + k) % this.max;
        const o = i * 10;
        if (this.n[o + 9] < 0.5) continue;
        fn(this.n, o, 1 - this.n[o + 8] / this.life);
      }
    }
  }

  /* THE ROAD SURFACE UNDER A CAR.
   *
   * Everything that lies ON the road - tyre marks, the dust the wheels kick
   * up, the sparks off a barrier - has to know where the road actually is, and
   * for most of this file's life it did not: the height was the literal 0.055
   * (or 0.12) that happens to be right for a course whose centreline is flat.
   *
   * Four of the seven routes are not. Chapter 7's expressway climbs to +26
   * units over six plateaus and drops to -8 through the underpass; Chapter 5's
   * ash country and Chapter 6's hall each carry their own grade. On every one
   * of those a mark written at world y=0.055 is BELOW the tarmac - drawn,
   * depth-tested, and rejected by the road it is supposed to be burnt into.
   * That is the whole of "drift marks are not visible on all the maps".
   *
   * roadY is the solver's own copy of the centreline height it placed the car
   * on this frame (see Vehicle::update), so it is exactly right on every route
   * and costs a field read. y - lift is the fallback for a proxy old enough
   * not to carry it. */
  function surfaceY(car) {
    if (!car) return 0;
    const r = car.roadY;
    if (r !== undefined && isFinite(r)) return r;
    const y = car.y === undefined ? 1 : car.y;
    return y - (car.lift === undefined ? 1.0532 : car.lift);
  }

  const RIB_VERT = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aUv;
  layout(location=2) in vec4 aCol;
  uniform mat4 uVP;
  uniform vec3 uCamPos;
  out vec2 vUv;
  out vec4 vCol;
  out float vNear;
  void main() {
    vUv = aUv;
    vCol = aCol;
    /* How close this bit of trail is to the lens. A trail streams BACKWARDS
       from a car the camera is already behind, so its oldest end runs straight
       into the near plane - where a strip a few units wide covers half the
       frame and the additive core takes the bottom of the picture with it.
       Dissolving the last few units before the camera is both what stops that
       and what a dissipating light trail does. */
    vNear = smoothstep(0.8, 6.5, distance(aPos, uCamPos));
    gl_Position = uVP * vec4(aPos, 1.0);
  }`;

  /* A neon tube is not a gradient. It is a very hot, very narrow core with a
     wide soft halo around it, and the ratio between the two is what separates
     "glowing" from "bright": a linear falloff across the strip gives a flat
     bar, because after the tonemap the whole width clips to white together.
     Two lobes - one at a high power for the filament, one at a low power for
     the air around it - is what the bloom then picks up as a coloured glow
     rather than as an overexposed stripe. */
  const RIB_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  in vec4 vCol;
  in float vNear;
  out vec4 outColor;
  void main() {
    float e = 1.0 - abs(vUv.y);
    if (e <= 0.0 || vNear <= 0.001) discard;
    float core = pow(e, 3.2);
    float halo = pow(e, 0.7);
    // the head of the trail is hotter than the tail: u runs 0 at the oldest
    // node to 1 at the car
    float hot = 0.45 + 0.55 * vUv.x;
    /* Kept under the knee on purpose. Driven hard enough to clip, every
       channel saturates together and a red neon tube tonemaps to a white bar -
       which is what the first version of this was: two white streaks behind
       the car with no colour in them at all. The filament is allowed over 1
       and the halo is not, so the bloom picks up a coloured glow and the core
       is the only part that goes white. */
    vec3 c = vCol.rgb * (core * 1.45 * hot + halo * 0.34);
    float a = vCol.a * vNear;
    outColor = vec4(c * a, (core * 0.85 + halo * 0.32) * a);
  }`;

  class Fx {
    constructor(gl) {
      this.gl = gl;
      this.prog = G.program(gl, VERT, FRAG, 'fx');
      this.data = new Float32Array(MAX * VERTS_PER * FLOATS);
      /* THE PARTICLES ARE A FLAT BUFFER IN THE CORE.

         They were an array of 900 plain objects with seventeen fields each,
         walked twice a frame - once to integrate and once to build the
         sprites. Measured on the release build that made `Fx.draw` the most
         expensive function the game's own code ran, and it was never about
         the arithmetic: it was a pointer chase per particle per field, plus
         an array literal allocated inside the builder's inner loop nine
         hundred times a frame.

         `core` is the flat buffer, `PF` the field offsets. Everything that
         DECIDES things - what to spawn, when, what colour - stays here, in
         JavaScript, where it is legible. Only the two numeric loops moved.

         The object array is still built when there is no core, because the
         browser build has to run without one; `spawnJs` and the loops below
         keep working against it unchanged. */
      this.core = null;
      const NRx = global.NR;
      if (NRx.fxReset && NRx.fxReset(MAX)) this.core = NRx.fxParticles(MAX);
      this.p = [];
      if (!this.core) {
        for (let i = 0; i < MAX; i++) {
          this.p.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
                        size: 1, grow: 0, drag: 1, gravity: 0, stretch: 0,
                        floor: 0.05,
                        r: 1, g: 1, b: 1, a: 1 });
        }
      }
      this.next = 0;
      this.count = 0;
      /* Which emitter slot each car owns in the core. Assigned on first
         sight, like the ribbon set beside it. */
      this.slots = new Map();
      /* PARTICLE DENSITY, from the options screen. A multiplier on every
         emitter's RATE, never on the buffer - the cap is what the vertex
         buffer can hold and moving it would mean reallocating.
       *
       * It is applied where a rate is accumulated rather than inside spawn,
       * so a burst still reads as a burst: turning it down thins a plume and
       * shortens a shower, and does not make a collision throw four sparks. */
      this.density = 1;

      /* Ribbons, per car. Two light trails off the tail lamps and two tyre
         marks under the rear wheels; a car gets its set the first time it is
         seen, so the rival needs no special case. */
      this.ribProg = G.program(gl, RIB_VERT, RIB_FRAG, 'ribbon');
      this.ribbons = new Map();
      this.ribData = new Float32Array(
        (TRAIL_NODES * 2 + MARK_NODES * 2) * 4 * 6 * FLOATS);
      this.ribVao = gl.createVertexArray();
      gl.bindVertexArray(this.ribVao);
      this.ribVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ribVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.ribData.byteLength, gl.DYNAMIC_DRAW);
      {
        const stride = FLOATS * 4;
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
      }
      gl.bindVertexArray(null);

      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
      const stride = FLOATS * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
      gl.bindVertexArray(null);
    }

    /* THE PARTICLE BUFFER, RE-DERIVED IF THE CORE HAS MOVED UNDER US.
     *
     * `this.core` is a view onto the module's linear memory, taken once when
     * the system is built. Any allocation inside the core can grow that
     * memory, and growing it replaces `memory.buffer` outright - which
     * DETACHES every view over the old one.
     *
     * A detached typed array does not throw when you write to it. The write
     * is simply dropped. So the failure mode here is not a crash: it is the
     * one-off effects the chapter directors spawn through this quietly
     * ceasing to exist, at whatever point in a session the core last grew,
     * with nothing in the log. (It throws on `fill`, which is how this was
     * found at all.)
     *
     * `byteLength` is zero on a detached view and on nothing else, so that is
     * the test. The re-derive is one call and only happens when the memory
     * has actually moved - see the note on M in js/wasm.js. */
    particles() {
      const c = this.core;
      if (c && c.byteLength === 0) return (this.core = global.NR.fxParticles(MAX));
      return c;
    }

    spawn(o) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      if (this.core) {
        /* Eighteen stores into a flat buffer, in the layout `particles::f`
           declares. The field order is fixed on the Rust side and read from
           there; writing it out twice is how a layout drifts, and a drifted
           particle layout is sparks that are the wrong colour and fall up. */
        const c = this.particles(), b = i * PF.STRIDE;
        if (!c) return null;
        c[b + PF.LIFE] = o.life; c[b + PF.MAX] = o.life;
        c[b + PF.X] = o.x; c[b + PF.Y] = o.y; c[b + PF.Z] = o.z;
        c[b + PF.VX] = o.vx || 0; c[b + PF.VY] = o.vy || 0; c[b + PF.VZ] = o.vz || 0;
        c[b + PF.SIZE] = o.size; c[b + PF.GROW] = o.grow || 0;
        c[b + PF.DRAG] = o.drag === undefined ? 1.6 : o.drag;
        c[b + PF.GRAVITY] = o.gravity || 0;
        c[b + PF.STRETCH] = o.stretch || 0;
        c[b + PF.FLOOR] = o.floor === undefined ? -1e9 : o.floor;
        c[b + PF.R] = o.r; c[b + PF.G] = o.g; c[b + PF.B] = o.b;
        c[b + PF.A] = o.a === undefined ? 1 : o.a;
        return null;
      }
      const q = this.p[i];
      q.life = o.life; q.max = o.life;
      q.x = o.x; q.y = o.y; q.z = o.z;
      q.vx = o.vx || 0; q.vy = o.vy || 0; q.vz = o.vz || 0;
      q.size = o.size; q.grow = o.grow || 0;
      q.drag = o.drag === undefined ? 1.6 : o.drag;
      q.gravity = o.gravity || 0;
      // >0 elongates the sprite along its own velocity: what turns a round
      // puff into a flame tongue or a spark streak
      q.stretch = o.stretch || 0;
      /* The surface this particle will land on. Emitters that live on the
         road pass their own; anything in free air (flame, exhaust smoke)
         leaves it at a height nothing can reach, because a plume that bounces
         off an invisible plane behind the car is worse than one that does not
         bounce at all. */
      q.floor = o.floor === undefined ? -1e9 : o.floor;
      q.r = o.r; q.g = o.g; q.b = o.b; q.a = o.a === undefined ? 1 : o.a;
      return q;
    }

    /* The four wheel contact patches, in world space: rear left, rear right,
       front left, front right, as twelve floats.
     *
     * This built an outer array, two pairs of seat literals and four point
     * arrays - seven allocations - to answer with four points that the smoke
     * emitter reads and drops on the same line. It is one flat buffer now,
     * indexed `w * 3 + axis`, which is also how the caller was using it. */
    wheels(car) {
      const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
      const half = 1.1, front = 1.83, back = -1.88;
      // ...on the road the car is actually standing on, not on world zero:
      // see surfaceY. Tyre smoke on an elevated route was being emitted
      // underneath the deck and was invisible for the whole of Chapter 7.
      const y = surfaceY(car) + 0.12;
      const o = this._wheelBuf || (this._wheelBuf = new Float64Array(12));
      const SEAT = WHEEL_SEATS;
      for (let i = 0; i < 4; i++) {
        const lx = SEAT[i * 2] * half, lz = SEAT[i * 2 + 1] === 0 ? back : front;
        o[i * 3] = car.x + cy * lx + sy * lz;
        o[i * 3 + 1] = y;
        o[i * 3 + 2] = car.z - sy * lx + cy * lz;
      }
      return o;
    }

    /** A burst of sparks where the car scraped the barrier, sized by the hit. */
    sparks(car, force) {
      const f = force === undefined ? 1 : Math.max(0.15, Math.min(1, force));
      const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
      const side = car.lateral >= 0 ? 1 : -1;
      const px = car.x + cy * side * 1.1;
      const pz = car.z - sy * side * 1.1;
      const body = (car.y === undefined ? 1 : car.y);
      const floor = surfaceY(car) + 0.05;
      const n = Math.max(6, Math.round((10 + 44 * f) * this.density));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 6 + Math.random() * 22;
        this.spawn({
          x: px, y: body - 0.55 + Math.random() * 0.8, z: pz, floor,
          vx: -sy * car.speed * 0.35 + Math.cos(a) * sp * 0.5,
          vy: Math.abs(Math.sin(a)) * sp * 0.7,
          vz: -cy * car.speed * 0.35 + Math.sin(a) * sp * 0.5,
          life: 0.30 + Math.random() * 0.5 * f, size: 0.26 + 0.14 * f, grow: -0.2,
          gravity: -26, drag: 1.1, stretch: 5.0,
          r: 1.0, g: 0.72 + Math.random() * 0.28, b: 0.28, a: 1.5,
        });
      }
    }

    /**
     * One restrained ion-shedding hit for raceMode engagement.  This is not a
     * screen-space starburst: every mote leaves an actual seam on the car and
     * inherits its velocity, so the shot still has depth when the activation
     * camera cuts from the wheel to the diffuser.
     */
    raceModeBurst(car) {
      if (!car) return;
      const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
      const cvx = car.vx || sy * (car.vLong || car.speed || 0);
      const cvz = car.vz || cy * (car.vLong || car.speed || 0);
      const n = Math.max(18, Math.round(54 * this.density));
      for (let i = 0; i < n; i++) {
        const lx = (Math.random() - .5) * 2.55;
        const lz = -2.55 + Math.random() * 4.65;
        const side = (Math.random() < .5 ? -1 : 1) * (4 + Math.random() * 13);
        const back = 12 + Math.random() * 32;
        // a third of the burst is the hot core, whatever the density scaled
        // the count to - at LOW an unscaled 18 would have made all of it core
        const core = i * 3 < n;
        this.spawn({
          x: car.x + cy * lx + sy * lz,
          y: (car.y || 1) - .48 + Math.random() * 1.12,
          z: car.z - sy * lx + cy * lz,
          vx: cvx - sy * back + cy * side,
          vy: -.4 + Math.random() * 3.2,
          vz: cvz - cy * back - sy * side,
          life: .24 + Math.random() * .34,
          size: core ? .19 : .28,
          grow: core ? -.08 : .22,
          drag: 1.4,
          gravity: -1.4,
          stretch: core ? 8.5 : 5.2,
          r: core ? .24 : .015,
          g: core ? .82 : .34,
          b: 1.0,
          a: core ? 1.18 : .72,
        });
      }
    }

    /** A new race: nothing from the last one may be left hanging in the air. */
    reset() {
      for (const q of this.p) q.life = 0;
      { const c = this.particles(); if (c) c.fill(0); }
      this.count = 0;
      this.next = 0;
      if (this.acc) this.acc.clear();
      /* ...including half a puff of smoke banked in an accumulator, and the
         slot table, whose cars are about to be replaced. */
      if (this.slots) this.slots.clear();
      if (global.NR.fxEmitReset) global.NR.fxEmitReset();
      for (const set of this.ribbons.values()) {
        for (const r of set.trails) r.clear();
        for (const r of set.marks) r.clear();
      }
    }

    /** The ribbon set belonging to a car, created on first sight. */
    ribbonsFor(car) {
      let set = this.ribbons.get(car);
      if (!set) {
        set = {
          trails: [new Ribbon(TRAIL_NODES, TRAIL_STEP, 1.15, false),
                   new Ribbon(TRAIL_NODES, TRAIL_STEP, 1.15, false)],
          marks: (() => {
            const m = [];
            for (let i = 0; i < MARK_RIBBONS; i++) m.push(new Ribbon(MARK_NODES, MARK_STEP, 3.2, true));
            return m;
          })(),
          col: [1.0, 0.06, 0.13],
        };
        this.ribbons.set(car, set);
      }
      return set;
    }

    /** The colour a car's light trail burns in. */
    setTrailColor(car, rgb) { this.ribbonsFor(car).col = rgb.slice(); }

    /**
     * @param {number} dt
     * @param {Vehicle|Vehicle[]} cars  every car that should be emitting
     * @param {boolean} active
     */
    update(dt, cars, active) {
      /* A single car is the common case - every mode but a race has one -
         and wrapping it in a fresh array every frame is an allocation to
         iterate over one element. The scratch is refilled per call and holds
         nothing between them. */
      let list = cars;
      if (!Array.isArray(cars)) {
        list = this._one || (this._one = [null]);
        list[0] = cars;
      }
      // per-car emitter accumulators: the rival throws its own smoke and runs
      // its own afterburner, and sharing one counter between two cars halves
      // both of them
      if (!this.acc) this.acc = new Map();
      for (let ci = 0; ci < list.length; ci++) {
        this.emit(dt, list[ci], active, ci === 0);
        this.trail(dt, list[ci], active);
      }
      this.integrate(dt);
    }

    /* The light trails and the tyre marks.
     *
     * The trail is not a speed effect bolted on: it is where the tail lamps
     * have been, so it draws the line the car actually took - which is exactly
     * what makes a drift legible from behind. It thickens and turns with the
     * slide, goes white-blue on reheat and hot on the brakes, and the marks
     * under the rear wheels only exist while the tyres are genuinely sliding.
     */
    trail(dt, car, active) {
      if (!car) return;
      const set = this.ribbonsFor(car);
      const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
      const drift = car.driftAmount || 0;
      const boost = car.boosting ? 1 : 0;
      const raceMode = Math.min(1, Math.max(0,
        ((car.raceModeMultiplier || 1) - 1) / .5));
      const brake = car.braking || 0;
      const fast = Math.min(1, Math.max(0, (car.speed - 6) / 34));

      /* The trail is the tail lamp, so it is the COLOUR of the tail lamp.
         It used to be mixed toward cyan as the slide deepened, on the theory
         that a hotter effect wants a hotter colour - but the thing the player
         is looking at is two red lamps, and a red car leaving blue-white
         streaks reads as two unrelated effects rather than as one car. A slide
         does not change the colour of a lamp; it just makes more of it. Reheat
         does change it, because on boost the exhaust genuinely is the
         brightest thing back there and it genuinely is blue. */
      const base = set.col;
      let r = mix(base[0], 0.45, boost);
      let g = mix(base[1], 0.80, boost);
      let b = mix(base[2], 1.00, boost);
      // raceMode has its own propulsion signature: saturated cobalt energy,
      // not a brighter version of the ordinary almost-white reheat.
      r = mix(r, .025, raceMode);
      g = mix(g, .42, raceMode);
      b = mix(b, 1.00, raceMode);
      /* Narrow. A trail is only ever a few pixels wide at the far end and the
         eye reads the BLOOM around it as the glow - so the geometry itself
         wants to be thin, or the near end of it (which is metres from the
         lens and covers a hundred pixels) turns into a white slab and takes
         the bottom of the frame with it. */
      const width = 0.15 + drift * 0.30 + boost * 0.22 + fast * 0.12
        + raceMode * (.09 + boost * .12);
      const alpha = (0.22 + fast * 0.44 + drift * 0.62 + boost * 0.80 + brake * 0.36)
        * (active || raceMode > .01 ? 1 : 0.45)
        + raceMode * .18;

      /* Welded to the lamp bar, through the body's FULL attitude.
       *
       * The bar is measured off the car's own geometry: LIGHTS_BRAKE spans
       * x -1.31..1.32, y -0.40..-0.22, z -2.70..-2.56 in body space. And it is
       * transformed by pitch and roll as well as yaw, because the body is a
       * sprung mass: a tenth of a radian of dive moves the lamps a quarter of a
       * unit, and a trail that only knows about yaw detaches from them under
       * braking and through every corner. */
      const roadBodyPitch=(car.pitch||0)+(car.roadPitch||0);
      const cp = Math.cos(roadBodyPitch), sp = Math.sin(roadBodyPitch);
      const cr = Math.cos(car.roll || 0), sr = Math.sin(car.roll || 0);
      /* The nine coefficients of the same basis M4.trs builds for the car,
         named once rather than recomputed inside a closure that was itself
         rebuilt for every car on every frame. Only the two lamps are
         transformed, and they differ in one coordinate. */
      const m00 = cy * cr + sy * sp * sr, m01 = -cy * sr + sy * sp * cr, m02 = sy * cp;
      const m10 = cp * sr,                m11 = cp * cr,                 m12 = -sp;
      const m20 = -sy * cr + cy * sp * sr, m21 = sy * sr + cy * sp * cr, m22 = cy * cp;
      const lampX = 0.95, lampY = -0.31, lampZ = -2.66;
      const cxw = car.x, cyw = (car.y || 1), czw = car.z;
      for (let i = 0; i < 2; i++) {
        const lx = i === 0 ? -lampX : lampX;
        set.trails[i].push(
          cxw + m00 * lx + m01 * lampY + m02 * lampZ,
          cyw + m10 * lx + m11 * lampY + m12 * lampZ,
          czw + m20 * lx + m21 * lampY + m22 * lampZ,
          width, r, g, b, alpha);
        set.trails[i].life = 1.15 + raceMode * .52;
      }

      /* TYRE MARKS, PER WHEEL, ON WHATEVER THE ROAD IS DOING.
       *
       * Two things were wrong with these and both of them made marks vanish.
       *
       * THE HEIGHT was the constant 0.055, which is the road only on a route
       * whose centreline is flat. Chapters 5, 6 and 7 all carry a grade, and on
       * those the mark was written under the tarmac and thrown away by the
       * depth test - the reported "no drift marks on some maps". It comes off
       * the solver's own surface height now, so it follows a climb, a dip and
       * a banked corner without any of them being special-cased.
       *
       * WHAT MARKS was only the two rear wheels, and only lateral slide. A
       * tyre lays rubber whenever it is moving across the road rather than
       * rolling along it, and there are three ways to do that: slide the car,
       * light the rears up, or lock a wheel under the brakes. The last one is
       * a FRONT-wheel event on almost every car, which is why a heavy stop
       * used to leave the road completely clean.
       *
       * The colour follows the cause. A slide and a burnout run hot, in the
       * route's own neon, because a black mark on a road this dark is a mark
       * nobody can see. A locked wheel is a scrub rather than a burn, so it
       * comes in cooler and dimmer - two different things that look like two
       * different things. */
      const surf = surfaceY(car);
      const braking01 = Math.min(1, brake);
      const rolling = active && car.speed > 6;
      for (let i = 0; i < MARK_RIBBONS; i++) {
        const m = set.marks[i];
        const rear = i >= 2;
        const sv = car[MARK_SLIP[i]];
        const sr = sv === undefined ? 0 : sv;
        /* How hard this tyre is scrubbing, 0..1.
           - lateral: the whole car's slide angle, felt by every corner
           - spin:    a driven wheel turning faster than the road (rears only)
           - lock:    a wheel turning slower than the road, under the brakes */
        const lateral = Math.max(0, drift - 0.20) * 2.1;
        const spin = rear ? Math.max(0, (car.wheelSpinFx || 0) - 0.14) * 2.0 : 0;
        const lock = braking01 > 0.25 ? Math.max(0, -sr - 0.16) * 2.4 : 0;
        const heat = Math.min(1.2, Math.max(lateral, spin, lock));
        if (!rolling || heat < 0.06) { m.dead = true; continue; }
        if (m.dead) { m.clear(); m.dead = false; }
        const lx = MARK_SEATS[i][0], lz = MARK_SEATS[i][1];
        // a locked tyre scrubs cold; a lit one burns
        const cold = lock > Math.max(lateral, spin);
        m.push(
          car.x + cy * lx + sy * lz,
          surf + 0.055,
          car.z - sy * lx + cy * lz,
          (cold ? 0.50 : 0.62) + heat * 0.24,
          cold ? 0.30 : 0.55 + heat * 0.42,
          cold ? 0.42 : 0.84,
          cold ? 0.58 : 1.0,
          Math.min(1.15, heat * (cold ? 0.72 : 1.0)));
      }

      for (const rb of set.trails) rb.age(dt);
      for (const rb of set.marks) rb.age(dt);
    }

    /* THE FOUR CONTINUOUS EMITTERS.
     *
     * Tyre smoke, the twin afterburner, the shower off a barrier and the grit
     * whipping past the lens. All four are RATE driven - a number of particles
     * per second, accumulated across frames so the rate survives any frame
     * time - and all four ran here, building an eighteen-field object per
     * particle for `spawn` to read back out and throw away.
     *
     * They run in the core now. See the note at the head of
     * crates/synx-core/src/particles.rs for the whole argument; the short
     * version is that the arithmetic was never the cost and the allocation
     * was. What crosses the boundary is one call per car per frame carrying
     * the car's state, and what comes back is the spawn cursor.
     *
     * The JavaScript below is kept, unchanged, for a checkout with no
     * compiled .wasm - the same arrangement `integrate` and `stripsInJs`
     * already have in this file, and for the same reason: the browser build
     * has to run without one. It is not the path the shipped game takes.
     */
    emit(dt, car, active, isPlayer) {
      if (!car) return;
      if (this.core) {
        /* A stable slot per car, so a car keeps its own accumulators and its
           own random stream rather than inheriting the plume of whichever car
           happened to be emitted before it. */
        let slot = this.slots.get(car);
        if (slot === undefined) { slot = this.slots.size; this.slots.set(car, slot); }
        if (active) {
          const n = global.NR.fxEmit(slot, this.next, dt, this.density,
            car, surfaceY(car), !!isPlayer);
          // -1 is "there is no such export"; anything else is the new cursor
          if (n >= 0) { this.next = n; return; }
        } else {
          return;                       // nothing emits while nothing is driving
        }
      }
      let acc = this.acc.get(car);
      if (!acc) {
        acc = { smoke: 0, dust: 0 };
        this.acc.set(car, acc);
      }
      // --- emitters -------------------------------------------------------
      if (car && active) {
        const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
        const raceMode = Math.min(1, Math.max(0,
          ((car.raceModeMultiplier || 1) - 1) / .5));

        /* Tyre smoke, from the rears, when they are sliding or spinning UP.
           Reading the magnitude of the slip ratio put smoke on the road every
           time the car was braked hard, because a wheel being braked has just
           as large a slip ratio as one being spun - it is the sign that says
           which. wheelSpinFx is the signed one. */
        const slide = Math.max(car.driftAmount, car.wheelSpinFx || 0);
        if (slide > 0.12 && car.speed > 4) {
          acc.smoke += dt * (18 + slide * 70) * this.density;
          const w = this.wheels(car);
          while (acc.smoke > 1) {
            acc.smoke -= 1;
            // rear left or rear right, as an offset into the flat patch buffer
            const p = Math.random() < 0.5 ? 0 : 3;
            this.spawn({
              x: w[p] + (Math.random() - 0.5) * 0.8,
              y: w[p + 1] + Math.random() * 0.3,
              z: w[p + 2] + (Math.random() - 0.5) * 0.8,
              vx: -sy * car.speed * 0.10 + (Math.random() - 0.5) * 3.5,
              vy: 1.4 + Math.random() * 2.2,
              vz: -cy * car.speed * 0.10 + (Math.random() - 0.5) * 3.5,
              floor: w[p + 1] - 0.07,
              life: 0.75 + Math.random() * 0.8,
              size: 1.4, grow: 6.5, drag: 1.4,
              // lit by the neon around it rather than plain grey
              r: 0.62, g: 0.55, b: 0.85, a: 0.55 * Math.min(1, slide * 1.6),
            });
          }
        }

        /* Twin afterburner.

           The car has two nozzles, measured off the exhaust mesh at
           (+-0.62, -0.66, -2.65) in body space, and a real reheat plume is not
           a cloud: it is a stretched cone with a white-blue core that fades
           out through cyan to deep violet, punctuated by shock diamonds where
           the flow goes supersonic. Every sprite is elongated along its own
           velocity, which is what makes it read as flame rather than smoke.

           The gas leaves the nozzle fast *relative to the car*, which in world
           terms means it still travels forwards - just slower than the car
           does, so the car pulls away from its own plume and leaves it hanging
           in the air. Spawning it moving backwards through the world instead
           would fire it out of the back at twice the closing speed, which is
           not what an exhaust does at 160 km/h. */
        if (car.boosting) {
          const cvx = car.vx || 0, cvz = car.vz || 0;
          // both nozzles, without building a two-element array to name them
          for (let side = -1; side <= 1; side += 2) {
            const lx = side * 0.62, lz = -2.65;
            const nx = car.x + cy * lx + sy * lz;
            const ny = (car.y || 1) - 0.66;
            const nz = car.z - sy * lx + cy * lz;
            const bx = -sy, bz = -cy;             // straight out the back

            // white-blue core: fast, tiny, gone almost at once
            for (let i = 0; i < 3 + (raceMode > .5 ? 1 : 0); i++) {
              const sp = 30 + raceMode * 18 + Math.random() * 26;
              this.spawn({
                x: nx + (Math.random() - 0.5) * 0.18,
                y: ny + (Math.random() - 0.5) * 0.14,
                z: nz + (Math.random() - 0.5) * 0.18,
                vx: cvx + bx * sp + (Math.random() - 0.5) * 1.2,
                vy: (Math.random() - 0.5) * 0.7,
                vz: cvz + bz * sp + (Math.random() - 0.5) * 1.2,
                life: 0.10 + raceMode * .035 + Math.random() * 0.07,
                size: 0.34 + raceMode * .04, grow: 0.8, drag: 2.2, stretch: 8.0 + raceMode * 1.5,
                r: 0.58 - raceMode * .34, g: 0.84 - raceMode * .08,
                b: 1.00, a: 1.75 - raceMode * .40,
              });
            }
            // the cyan body of the flame
            for (let i = 0; i < 3; i++) {
              const sp = 17 + raceMode * 14 + Math.random() * 18;
              this.spawn({
                x: nx + (Math.random() - 0.5) * 0.3,
                y: ny + (Math.random() - 0.5) * 0.22,
                z: nz + (Math.random() - 0.5) * 0.3,
                vx: cvx + bx * sp + (Math.random() - 0.5) * 2.4,
                vy: 0.25 + (Math.random() - 0.5) * 1.1,
                vz: cvz + bz * sp + (Math.random() - 0.5) * 2.4,
                life: 0.20 + raceMode * .06 + Math.random() * 0.12,
                size: 0.50, grow: 2.4, drag: 1.9, stretch: 5.5 + raceMode,
                r: 0.14 - raceMode * .11, g: 0.50 - raceMode * .10,
                b: 1.00, a: 1.15 - raceMode * .16,
              });
            }
            // and the violet tail it dissolves into
            if (Math.random() < 0.75) {
              const sp = 10 + Math.random() * 12;
              this.spawn({
                x: nx + (Math.random() - 0.5) * 0.4,
                y: ny + (Math.random() - 0.5) * 0.3,
                z: nz + (Math.random() - 0.5) * 0.4,
                vx: cvx + bx * sp + (Math.random() - 0.5) * 3.4,
                vy: 0.6 + Math.random() * 1.2,
                vz: cvz + bz * sp + (Math.random() - 0.5) * 3.4,
                life: 0.34 + Math.random() * 0.22,
                size: 0.72, grow: 3.8, drag: 1.6, stretch: 2.6,
                r: 0.24 - raceMode * .16, g: 0.18 + raceMode * .08,
                b: 0.92 + raceMode * .08, a: 0.52,
              });
            }
            // shock diamonds: bright knots at fixed stations down the plume
            for (let k = 1; k <= 3; k++) {
              if (Math.random() > 0.5) continue;
              const d = k * 0.85 + Math.random() * 0.12;
              this.spawn({
                x: nx + bx * d, y: ny, z: nz + bz * d,
                vx: cvx + bx * 18, vy: 0, vz: cvz + bz * 18,
                life: 0.05, size: 0.26 - k * 0.045, grow: 0,
                drag: 3.0, stretch: 2.0,
                r: 0.72, g: 0.90, b: 1.00, a: 1.15 - k * 0.28,
              });
            }
          }
        }

        /* Scraping the barrier. The only thing in the game that throws sparks
           and the only thing the player asked to keep: a continuous shower off
           whichever flank is against the wall, for as long as it is. */
        if (car.scrape > 0.06) {
          acc.spark = (acc.spark || 0) + dt * car.scrape * 220 * this.density;
          const side = car.lateral >= 0 ? 1 : -1;
          const scrapeFloor = surfaceY(car) + 0.05;
          const scrapeBody = (car.y === undefined ? 1 : car.y);
          while (acc.spark > 1) {
            acc.spark -= 1;
            const along = (Math.random() - 0.5) * 3.2;
            const a = Math.random() * Math.PI * 2;
            const sp = 5 + Math.random() * 20 * car.scrape;
            this.spawn({
              x: car.x + cy * side * 1.12 + sy * along,
              y: scrapeBody - 0.66 + Math.random() * 0.7,
              z: car.z - sy * side * 1.12 + cy * along,
              floor: scrapeFloor,
              vx: -sy * car.speed * 0.42 - cy * side * sp * 0.5 + Math.cos(a) * sp * 0.3,
              vy: Math.abs(Math.sin(a)) * sp * 0.6,
              vz: -cy * car.speed * 0.42 + sy * side * sp * 0.5 + Math.sin(a) * sp * 0.3,
              life: 0.22 + Math.random() * 0.34, size: 0.20 + 0.12 * car.scrape,
              grow: -0.15, gravity: -24, drag: 1.2, stretch: 6.0,
              r: 1.0, g: 0.66 + Math.random() * 0.30, b: 0.24, a: 1.6,
            });
          }
        }

        // dust and grit whipping past once the car is really moving
        // the dust is a camera effect, so only the car being followed makes it
        if (isPlayer && car.speed > 26) {
          acc.dust += dt * (car.speed - 20) * 1.6 * this.density;
          const dustBase = surfaceY(car);
          while (acc.dust > 1) {
            acc.dust -= 1;
            const side = (Math.random() - 0.5) * 78;
            const ahead = 26 + Math.random() * 34;
            this.spawn({
              x: car.x + cy * side + sy * ahead,
              y: dustBase + 0.4 + Math.random() * 5.5,
              z: car.z - sy * side + cy * ahead,
              floor: dustBase + 0.05,
              vx: -sy * 3, vy: 0.4, vz: -cy * 3,
              life: 0.5 + Math.random() * 0.4,
              size: 0.22, grow: 0.1, drag: 0.2,
              r: 0.55, g: 0.8, b: 1.0, a: 0.5,
            });
          }
        }

      }

    }

    integrate(dt) {
      if (this.core) {
        this.count = global.NR.fxIntegrate(dt);
        return;
      }
      let live = 0;
      for (const q of this.p) {
        if (q.life <= 0) continue;
        q.life -= dt;
        if (q.life <= 0) continue;
        const k = Math.exp(-q.drag * dt);
        q.vx *= k; q.vz *= k;
        q.vy = q.vy * k + q.gravity * dt;
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        q.size += q.grow * dt;
        /* A grain of grit lands on the ROAD.
           This used to be the literal world plane at 0.05, which on Chapter 7
           is twenty-six units under the expressway and eight units over the
           underpass - so every spark thrown on the deck fell straight through
           it, and every spark thrown in the dip stopped and bounced in mid
           air. Each particle carries the surface it was born over. */
        if (q.y < q.floor) { q.y = q.floor; q.vy *= -0.25; }
        live++;
      }
      this.count = live;
    }

    /* Build every ribbon into one buffer and draw it.
     *
     * `camPos` is needed as well as the camera basis: a light trail is
     * billboarded about its OWN length rather than about the view plane, so
     * each node needs the direction from itself to the lens, not one direction
     * shared by the whole frame. A trail curling away round a corner is at a
     * different angle to the camera at each end of it. */
    /* The same strip build, in JavaScript, for a build with no core.
     *
     * It is never the path the shipped game takes; it exists so a development
     * checkout without a compiled .wasm still draws trails rather than
     * nothing. crates/synx-core/src/ribbon.rs is a line-for-line port of it,
     * and the two must stay that way - a divergence here is a trail that looks
     * different depending on which build you are running. */
    stripsInJs(camPos, cap) {
      const d = this.ribData;
      let o = 0, quads = 0;

      const strip = (rb, ground) => {
        // gather the live nodes first: a quad needs the node after it, and the
        // ring buffer does not hand out neighbours
        const px = [], py = [], pz = [], pw = [], pr = [], pg = [], pb = [], pa = [], pt = [];
        rb.forEach((n, i, life) => {
          px.push(n[i]); py.push(n[i + 1]); pz.push(n[i + 2]); pw.push(n[i + 3]);
          pr.push(n[i + 4]); pg.push(n[i + 5]); pb.push(n[i + 6]); pa.push(n[i + 7]);
          pt.push(life);
        });
        const N = px.length;
        if (N < 2) return;
        // one smoothing pass over the interior, twice; the ends are welded
        for (let pass = 0; pass < 2; pass++) {
          let ax = px[0], ay = py[0], az = pz[0];
          for (let k = 1; k < N - 1; k++) {
            const bx = px[k], by = py[k], bz = pz[k];
            px[k] = (ax + bx * 2 + px[k + 1]) * 0.25;
            py[k] = (ay + by * 2 + py[k + 1]) * 0.25;
            pz[k] = (az + bz * 2 + pz[k + 1]) * 0.25;
            ax = bx; ay = by; az = bz;
          }
        }
        for (let k = 0; k < N - 1; k++) {
          if (quads >= cap) return;
          const side = (k2) => {
            const a = Math.max(0, k2 - 1), b2 = Math.min(N - 1, k2 + 1);
            let tx = px[b2] - px[a], ty = py[b2] - py[a], tz = pz[b2] - pz[a];
            const tl = Math.hypot(tx, ty, tz) || 1;
            tx /= tl; ty /= tl; tz /= tl;
            if (ground) return [tz, 0, -tx];
            let vx = px[k2] - camPos[0], vy = py[k2] - camPos[1], vz = pz[k2] - camPos[2];
            const vl = Math.hypot(vx, vy, vz) || 1;
            vx /= vl; vy /= vl; vz /= vl;
            const sx = ty * vz - tz * vy;
            const sy2 = tz * vx - tx * vz;
            const sz = tx * vy - ty * vx;
            const sl = Math.hypot(sx, sy2, sz);
            if (sl < 1e-4) return [1, 0, 0];
            return [sx / sl, sy2 / sl, sz / sl];
          };
          const s0 = side(k), s1 = side(k + 1);
          const t0 = pt[k], t1 = pt[k + 1];
          const w0 = pw[k] * t0 * (k === 0 ? 0.15 : 1);
          const w1 = pw[k + 1] * t1;
          const a0 = pa[k] * t0 * t0, a1 = pa[k + 1] * t1 * t1;
          const u0 = k / (N - 1), u1 = (k + 1) / (N - 1);
          const put = (x, y, z, sx, sy2, sz, w, sgn, u, r, g, b, a) => {
            d[o++] = x + sx * w * sgn; d[o++] = y + sy2 * w * sgn; d[o++] = z + sz * w * sgn;
            d[o++] = u; d[o++] = sgn;
            d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
          };
          const A = [px[k], py[k], pz[k]], B = [px[k + 1], py[k + 1], pz[k + 1]];
          const cA = [pr[k], pg[k], pb[k]], cB = [pr[k + 1], pg[k + 1], pb[k + 1]];
          for (const [P, S, W, U, C, AL, SG] of [
            [A, s0, w0, u0, cA, a0, -1], [B, s1, w1, u1, cB, a1, -1], [B, s1, w1, u1, cB, a1, 1],
            [A, s0, w0, u0, cA, a0, -1], [B, s1, w1, u1, cB, a1, 1], [A, s0, w0, u0, cA, a0, 1],
          ]) {
            put(P[0], P[1], P[2], S[0], S[1], S[2], W, SG, U, C[0], C[1], C[2], AL);
          }
          quads++;
        }
      };

      // marks first: they are on the road and the trails hang above them
      for (const set of this.ribbons.values()) for (const rb of set.marks) strip(rb, true);
      for (const set of this.ribbons.values()) for (const rb of set.trails) strip(rb, false);
      return { quads, data: d };
    }

    drawRibbons(vp, camPos) {
      const gl = this.gl;
      const cap = (this.ribData.length / (6 * FLOATS)) | 0;
      let quads = 0;
      let data = null;

      /* THE STRIP BUILD IS IN THE CORE.
       *
       * It is the same gather, the same two smoothing passes and the same
       * billboarding it always was - see crates/synx-core/src/ribbon.rs, which
       * is a line-for-line port. What changed is where the scratch lives: the
       * JavaScript version allocated nine ordinary arrays per ribbon, twelve
       * ribbons a frame, for the whole length of a race, and a garbage
       * collection at an unpredictable moment is worse in a racing game than a
       * uniformly slower frame.
       *
       * `NR.ribbonBegin` returns false in a build with no core, and the
       * JavaScript below is kept for exactly that case. */
      const core = global.NR.ribbonBegin && global.NR.ribbonBegin(cap);
      if (core) {
        // marks first: they are on the road and the trails hang above them
        for (const set of this.ribbons.values()) {
          for (const rb of set.marks) {
            quads += global.NR.ribbonStrip(rb.n, rb.count, rb.head, rb.max,
              rb.life, true, camPos, cap);
          }
        }
        for (const set of this.ribbons.values()) {
          for (const rb of set.trails) {
            quads += global.NR.ribbonStrip(rb.n, rb.count, rb.head, rb.max,
              rb.life, false, camPos, cap);
          }
        }
        if (!quads) return;
        data = global.NR.ribbonOut();
        if (!data) return;
      } else {
        const built = this.stripsInJs(camPos, cap);
        quads = built.quads;
        if (!quads) return;
        data = built.data;
      }

      gl.useProgram(this.ribProg.prog);
      gl.bindVertexArray(this.ribVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ribVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, quads * 6 * FLOATS);
      U.m4(gl, this.ribProg.u.uVP, vp);
      U.v3(gl, this.ribProg.u.uCamPos, camPos[0], camPos[1], camPos[2]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.enable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, quads * 6);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    }

    /** `view` is the camera matrix; its rotation rows are the camera basis. */
    draw(vp, view) {
      const gl = this.gl;
      if (!this.count) return;
      /* World-space camera right, up and forward, so every sprite faces the
         lens. Read out of the view matrix into scratch that lives as long as
         the system: three arrays a frame is not much on its own, and it is
         exactly the kind of per-frame litter that adds up to a collection in
         the middle of a corner. */
      const B = this._basis || (this._basis = {
        right: new Float32Array(3), up: new Float32Array(3), fwd: new Float32Array(3),
      });
      const right = B.right, up = B.up, fwd = B.fwd;
      right[0] = view[0]; right[1] = view[4]; right[2] = view[8];
      up[0] = view[1]; up[1] = view[5]; up[2] = view[9];
      fwd[0] = view[2]; fwd[1] = view[6]; fwd[2] = view[10];

      if (this.core) {
        /* The whole build, in one call. What comes back is a view straight onto
           the core's own output buffer - no copy, and `bufferSubData` reads it
           where it already lives. */
        const out = global.NR.fxBuild(right, up, fwd);
        if (!out || !out.length) return;
        gl.useProgram(this.prog.prog);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, out.length);
        U.m4(gl, this.prog.u.uVP, vp);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        gl.enable(gl.DEPTH_TEST);
        gl.drawArrays(gl.TRIANGLES, 0, (out.length / FLOATS) | 0);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(null);
        return;
      }
      const d = this.data;
      let o = 0, n = 0;
      for (const q of this.p) {
        if (q.life <= 0 || q.size <= 0) continue;
        const t = q.life / q.max;
        // fade in fast, out slow: a puff that pops on is what reads as impact
        const a = q.a * Math.min(1, t * 3.2) * t;
        const s = q.size * 0.5;
        let ux = right[0] * s, uy = right[1] * s, uz = right[2] * s;
        let vx = up[0] * s, vy = up[1] * s, vz = up[2] * s;
        if (q.stretch > 0) {
          /* Velocity-aligned billboard. The sprite's long axis is the
             particle's own direction of travel, flattened into the view plane
             so it still faces the lens - which is what makes a flame a tongue
             and a spark a streak instead of a row of dots. Falls back to the
             camera basis when a particle is barely moving and has no direction
             to align to. */
          const sp = Math.hypot(q.vx, q.vy, q.vz);
          if (sp > 0.5) {
            let ax = q.vx / sp, ay = q.vy / sp, az = q.vz / sp;
            // project out the view direction, or a sprite coming at the camera
            // collapses to nothing
            const dv = ax * fwd[0] + ay * fwd[1] + az * fwd[2];
            ax -= fwd[0] * dv; ay -= fwd[1] * dv; az -= fwd[2] * dv;
            /* `al` is how much of the travel direction survives the
               projection - 1 when the particle moves across the view, 0 when
               it moves straight at or away from the camera. It has to scale
               the stretch as well as normalise the axis: a plume aimed at the
               lens has no direction left to elongate along, and normalising a
               near-zero residual just picks an arbitrary one. That is why the
               exhaust came out as two vertical bars when viewed from directly
               behind. Head-on, it should be a disc - which is what an
               afterburner looks like from there. */
            const al = Math.hypot(ax, ay, az);
            if (al > 1e-3) {
              ax /= al; ay /= al; az /= al;
              // the perpendicular in the view plane
              const bx = fwd[1] * az - fwd[2] * ay;
              const by = fwd[2] * ax - fwd[0] * az;
              const bz = fwd[0] * ay - fwd[1] * ax;
              const long = s * (1 + q.stretch * al * al * Math.min(1, sp / 30));
              ux = ax * long; uy = ay * long; uz = az * long;
              vx = bx * s; vy = by * s; vz = bz * s;
            }
          }
        }
        const corners = [
          [-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1],
          [-1, -1, 0, 0], [1, 1, 1, 1], [-1, 1, 0, 1],
        ];
        for (const [cx, cy, tu, tv] of corners) {
          d[o++] = q.x + ux * cx + vx * cy;
          d[o++] = q.y + uy * cx + vy * cy;
          d[o++] = q.z + uz * cx + vz * cy;
          d[o++] = tu; d[o++] = tv;
          d[o++] = q.r; d[o++] = q.g; d[o++] = q.b; d[o++] = a;
        }
        n++;
        if (n >= MAX) break;
      }
      if (!n) return;

      gl.useProgram(this.prog.prog);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, o);
      U.m4(gl, this.prog.u.uVP, vp);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.enable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, n * VERTS_PER);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    }
  }

  global.NR.Fx = Fx;
})(window);
