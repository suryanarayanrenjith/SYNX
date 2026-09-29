/* SYNX // WEATHER.
 *
 * Rain, as something that happens IN the world rather than to the screen.
 *
 * WHAT WAS HERE. Chapter 3's storm was two CSS sheets of diagonal streaks
 * translated over the whole window. It fell in front of the HUD and the
 * letterbox, it fell inside tunnels, it fell the same way whether the car was
 * parked or doing two hundred, the road under it was merely glossy, and in the
 * driver's seat it fell through the roof. It was a picture of rain laid over a
 * dry game.
 *
 * WHAT IT IS NOW. Four things, each where it belongs:
 *
 *   IN THE AIR      Streaks in a volume that follows the camera and wraps
 *                   round it (Tariq, "Rain", NVIDIA 2007): world-fixed drops,
 *                   so they rush past when the car moves; stretched along
 *                   their velocity RELATIVE TO THE LENS, so at speed they turn
 *                   into the long lines a real camera sees; lit by the car's
 *                   own headlights and by the street lamps, which is what rain
 *                   at night actually looks like; and depth-tested softly
 *                   against the scene (Lagarde, "Water drop 2a") so they stop
 *                   at walls, stay out of tunnels and never fall in the cabin.
 *
 *   ON THE GROUND   Splashes, found where the rain lands by reading the depth
 *                   and normal buffers - every upward-facing pixel in reach is
 *                   a place a drop can hit, the bonnet included - and the ROAD
 *                   itself: darkened by porosity, puddles that fill while it
 *                   rains and drain after it stops, a flat water surface with
 *                   the right reflectance, and the four-layer procedural
 *                   ripples from Remember Me (Lagarde, "Water drop 2b"). The
 *                   ripples bend the normal the SSR pass reads, so the neon
 *                   reflected in a puddle shivers with it. See js/scene.js.
 *
 *   ON THE GLASS    From the driver's seat: drops that land, bead up, slide
 *                   down once they are heavy enough and - at speed - are blown
 *                   UP the screen by the airflow, leaving trails; and fine
 *                   beads that the air strips off the middle of the screen at
 *                   speed and leaves along its edges. No wipers: a coated
 *                   screen on a fast car clears itself. All of it refracts the
 *                   finished frame.
 *
 *   IN THE EAR      A rain bed, the drumming on the roof in the cabin, and
 *                   spray off the tyres for the eye.
 *
 * WHERE IT RUNS. Chapter 3 - Mirage Circuit, with Nova - is set in a storm,
 * and it is pouring from the moment the chapter opens. Free Roam has showers
 * that come and go at random, on a schedule of the tour's own from a seed, on
 * the routes RAIN_ROUTES below allows. Every other chapter and every
 * multiplayer race is dry.
 *
 * WHAT IT COSTS. Nothing at all when it is dry: every pass is skipped and the
 * two shaders it touches branch on a uniform. Raining, the air is two instanced
 * draws with no vertex buffers, the splashes are one, the glass is a few
 * hundred tiny quads into a half-resolution buffer, and the road is a handful
 * of texture fetches on road pixels near the car. Density follows the quality
 * preset and PARTICLE DENSITY.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};
  if (NR.Weather) return;

  /* ============================================================ helpers == */

  // An integer hash, so the schedule is the same on every machine.
  function hashU(x) {
    x = (x ^ 61) ^ (x >>> 16);
    x = (x + (x << 3)) | 0;
    x ^= x >>> 4;
    x = Math.imul(x, 0x27d4eb2d);
    x ^= x >>> 15;
    return x >>> 0;
  }
  function rnd(seed, a, b) {
    return hashU((seed ^ Math.imul((a | 0) + 1, 0x9E3779B1) ^ Math.imul((b | 0) + 7, 0x85EBCA6B)) >>> 0)
      / 4294967296;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

  /* ====================================================== the schedule ==
   *
   * The sky, as a pure function of a seed and a time. The day is cut into
   * two-and-a-half-minute stretches; each one is dry, drizzle or a proper
   * shower, decided by its own hash, and a shower rises and falls over a
   * quarter of a minute at each end rather than switching. A pure function
   * rather than a state machine because two machines running it with the same
   * seed and the same clock must agree on every frame without talking. */
  const SLOT = 150;

  /* WHERE IT CAN RAIN, by index into LEVELS in js/game.js: routes 1, 2, 3, 4
     and 7. ASHFALL ZERO (4) turns into a lava field and AURORA FORGE (5) is a
     roofed hall, so neither ever has weather - and a shower that is under way
     when a tour crosses into one of them is over within seconds, the road dry
     and the sky clear. */
  const RAIN_ROUTES = new Set([0, 1, 2, 3, 6]);

  function scheduled(seed, t) {
    if (!(t >= 0)) t = 0;
    const k = Math.floor(t / SLOT), x = t - k * SLOT;
    const roll = rnd(seed, k, 1);
    if (roll >= 0.56) return 0;
    const heavy = roll < 0.40;
    const peak = heavy ? 0.45 + 0.55 * rnd(seed, k, 2) : 0.16 + 0.14 * rnd(seed, k, 2);
    const a = SLOT * (0.04 + 0.30 * rnd(seed, k, 3));
    const b = Math.min(SLOT * 0.96, a + SLOT * (0.40 + 0.50 * rnd(seed, k, 4)));
    const up = smooth((x - a) / 16), dn = 1 - smooth((x - (b - 16)) / 16);
    return peak * Math.max(0, Math.min(up, dn));
  }

  /* ==================================================== the textures ==
   *
   * Both built once, here, from a seed - nothing in the pack.
   *
   * THE RIPPLE SHEET, laid out exactly as Lagarde describes it for Remember
   * Me: circles scattered on a jittered grid, and per texel
   *   R  1 at a circle's centre falling to 0 at its rim
   *   GB the direction from the centre, packed around 0.5
   *   A  that circle's own time offset, so no two drops land together.
   * The shader turns one fetch of it into an expanding ring (see ripple() in
   * js/scene.js), and four fetches at four scales into rain. */
  function buildRipples(size, cells, seed) {
    const out = new Uint8Array(size * size * 4);
    const cs = size / cells;
    const drops = [];
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        drops.push({
          x: (i + 0.2 + 0.6 * rnd(seed, i, j * 3 + 1)) * cs,
          y: (j + 0.2 + 0.6 * rnd(seed, i, j * 3 + 2)) * cs,
          r: cs * (0.34 + 0.52 * rnd(seed, i, j * 3 + 3)),
          t: rnd(seed, i + 91, j + 17),
        });
      }
    }
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const ci = Math.floor(px / cs), cj = Math.floor(py / cs);
        let best = 0, bx = 0, by = 0, bt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = (ci + di + cells) % cells, jj = (cj + dj + cells) % cells;
            const d = drops[jj * cells + ii];
            // the neighbour's centre, carried across the wrap so the sheet tiles
            const cx = d.x + (ci + di - ii) * cs, cy = d.y + (cj + dj - jj) * cs;
            const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist >= d.r) continue;
            const w = 1 - dist / d.r;
            if (w > best) {
              best = w;
              const l = Math.max(dist, 1e-4);
              bx = dx / l; by = dy / l; bt = d.t;
            }
          }
        }
        const o = (py * size + px) * 4;
        out[o] = Math.round(best * 255);
        out[o + 1] = Math.round((bx * 0.5 + 0.5) * 255);
        out[o + 2] = Math.round((by * 0.5 + 0.5) * 255);
        out[o + 3] = Math.round(bt * 255);
      }
    }
    return out;
  }

  /* THE PUDDLE MAP: where the road is low. Tileable value noise over three
     octaves, normalised to the full range, so the shader can flood it from the
     lowest point upward - which is how standing water gathers. Sampled twice
     at unrelated scales and rotations in the shader, so no tile ever shows. */
  function buildPuddles(size, seed) {
    const f = new Float32Array(size * size);
    const octave = (period, amp, salt) => {
      const n = size / period;
      const lat = new Float32Array(n * n);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd(seed, i, salt);
      for (let y = 0; y < size; y++) {
        const gy = y / period, j0 = Math.floor(gy), ty = smooth(gy - j0);
        for (let x = 0; x < size; x++) {
          const gx = x / period, i0 = Math.floor(gx), tx = smooth(gx - i0);
          const i1 = (i0 + 1) % n, j1 = (j0 + 1) % n;
          const a = lat[j0 * n + i0], b = lat[j0 * n + i1];
          const c = lat[j1 * n + i0], d = lat[j1 * n + i1];
          f[y * size + x] += amp * ((a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty);
        }
      }
    };
    octave(size / 4, 0.55, 11);
    octave(size / 8, 0.30, 23);
    octave(size / 16, 0.15, 37);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < f.length; i++) { lo = Math.min(lo, f[i]); hi = Math.max(hi, f[i]); }
    const out = new Uint8Array(size * size);
    for (let i = 0; i < f.length; i++) out[i] = Math.round(((f[i] - lo) / Math.max(1e-6, hi - lo)) * 255);
    return out;
  }

  /* ======================================================= the shaders == */

  const HASH_GLSL = `
  uint hu(uint x) {
    x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
    return x;
  }
  float hf(uint x) { return float(hu(x)) * (1.0 / 4294967295.0); }
  `;

  /* The light a drop catches. The same lamps the road is lit by - the car's
     dipped beams and the six nearest street lights and gantries, see the
     scene shader - evaluated at the drop, because a drop has no facing: it
     scatters whatever passes through it. This is what makes rain at night
     visible where it is visible in life, in the beams and under the lamps, and
     nearly invisible everywhere else. */
  const LIGHT_GLSL = `
  uniform vec3 uHeadL, uHeadR, uHeadFwd, uHeadRight, uHeadCol;
  uniform float uHeadOn, uHeadRange, uHeadInner, uHeadOuter, uHeadDip, uHeadToe;
  #define WL 6
  uniform vec4 uLampP[WL];
  uniform vec4 uLampC[WL];
  uniform vec4 uLampD[WL];
  uniform int uLampN;
  uniform vec3 uAmb;
  float beam(vec3 P, vec3 lp, float toe) {
    vec3 d = P - lp;
    float dist = length(d);
    if (dist > uHeadRange * 0.35 || dist < 0.25) return 0.0;
    vec3 dir = d / dist;
    vec3 axis = normalize(uHeadFwd - vec3(0.0, uHeadDip, 0.0) + uHeadRight * toe);
    float c = smoothstep(uHeadOuter, uHeadInner, dot(dir, axis));
    float above = max(0.0, dir.y + uHeadDip * 0.55);
    c *= 1.0 - smoothstep(0.03, 0.22, above);
    return c / (1.0 + dist * dist * 0.006);
  }
  vec3 rainLight(vec3 P) {
    vec3 L = uAmb;
    if (uHeadOn > 0.001) {
      L += uHeadCol * uHeadOn * (beam(P, uHeadL, -uHeadToe) + beam(P, uHeadR, uHeadToe)) * 3.4;
    }
    for (int i = 0; i < WL; i++) {
      if (i >= uLampN) break;
      float range = uLampP[i].w;
      vec3 rel = P - uLampP[i].xyz;
      float t = clamp(dot(rel, uLampD[i].xyz), -uLampC[i].w, uLampC[i].w);
      vec3 d = rel - uLampD[i].xyz * t;
      float d2 = dot(d, d);
      if (d2 > range * range) continue;
      float dist = sqrt(max(d2, 1e-4));
      float fall = 1.0 / (1.0 + d2 * 0.012);
      fall *= 1.0 - smoothstep(range * 0.45, range, dist);
      float down = mix(1.0, clamp(-d.y / dist, 0.0, 1.0), uLampD[i].w * 0.6);
      L += uLampC[i].rgb * fall * down * 0.8;
    }
    return L;
  }
  `;

  /* THE AIR. One instance per drop, no vertex buffer: the drop is a hash of
     its instance id, its position the hash plus its fall, wrapped into a box
     round the camera. Drawn as a screen-space quad along the line the drop
     travels RELATIVE TO THE CAMERA during one exposure - which is the only
     honest way to motion-blur a thing smaller than a pixel. */
  const STREAK_VS = `#version 300 es
  precision highp float;
  uniform mat4 uVP;
  uniform mat4 uCarInv;
  uniform vec3 uCam;
  uniform vec3 uBox;
  uniform vec3 uFall;
  uniform vec3 uCamVel;
  uniform float uTime;
  uniform float uExposure;
  uniform float uActive;
  uniform float uWidth;
  uniform float uFocal;
  uniform float uAlpha;
  uniform vec2 uRes;
  uniform float uSalt;
  out vec3 vCol;
  out float vAlpha;
  out vec2 vQ;
  out float vZ;
  ` + HASH_GLSL + LIGHT_GLSL + `
  void main() {
    uint id = uint(gl_InstanceID) + uint(uSalt);
    int corner = gl_VertexID;
    vec3 r = vec3(hf(id * 3u + 1u), hf(id * 3u + 2u), hf(id * 3u + 3u));
    if (hf(id ^ 0x9e3779b9u) > uActive) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float spd = mix(0.82, 1.18, hf(id * 7u + 5u));
    vec3 vel = uFall * spd;
    vec3 rel = mod(r * uBox + vel * uTime - uCam + uBox * 0.5, uBox) - uBox * 0.5;
    vec3 head = uCam + rel;

    /* It does not rain inside the car. The cabin, as a box in the car's own
       body space - see the room's measurements in js/scene.js. */
    vec3 b = (uCarInv * vec4(head, 1.0)).xyz;
    if (abs(b.x) < 1.15 && b.y > -0.62 && b.y < 0.44 && b.z > -1.1 && b.z < 1.86) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
    }

    vec3 relVel = vel - uCamVel;
    vec3 tail = head - relVel * uExposure;
    vec4 ch = uVP * vec4(head, 1.0);
    if (ch.w < 0.3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec4 ct = uVP * vec4(tail, 1.0);
    if (ct.w < 0.3) ct = ch;
    vec2 sh = (ch.xy / ch.w * 0.5 + 0.5) * uRes;
    vec2 st = (ct.xy / ct.w * 0.5 + 0.5) * uRes;
    vec2 d = st - sh;
    float len = length(d);
    vec2 dir = len > 0.5 ? d / len : vec2(0.0, -1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    float wpx = uWidth * uFocal / ch.w;
    float wDraw = max(wpx, 1.15);
    // a drop narrower than a pixel is fainter, not wider
    float cover = clamp(wpx / wDraw, 0.12, 1.0);

    float along = (corner == 1 || corner == 2 || corner == 4) ? 1.0 : 0.0;
    float side = (corner == 2 || corner == 4 || corner == 5) ? 1.0 : -1.0;
    vec2 a0 = sh - dir * wDraw * 0.5, a1 = st + dir * wDraw * 0.5;
    vec2 pos = mix(a0, a1, along) + perp * side * wDraw * 0.5;
    gl_Position = vec4(pos / uRes * 2.0 - 1.0, 0.0, 1.0);
    vQ = vec2(along, side);
    vZ = mix(ch.w, ct.w, along);

    /* Faded out toward the edge of the box so the wrap is never seen, faded
       in over the first metre so a drop does not appear in the lens, and
       spread over its own length: a longer streak is the same light over
       more pixels. */
    float reach = uBox.x * 0.5;
    float fade = (1.0 - smoothstep(reach * 0.62, reach, length(rel.xz)))
               * smoothstep(0.45, 1.3, ch.w);
    vAlpha = uAlpha * cover * fade * clamp(22.0 / max(len, 22.0), 0.22, 1.0);
    vCol = rainLight(head);
  }`;

  const STREAK_FS = `#version 300 es
  precision highp float;
  in vec3 vCol;
  in float vAlpha;
  in vec2 vQ;
  in float vZ;
  out vec4 outColor;
  uniform sampler2D uDepth;
  uniform vec2 uRes;
  uniform vec2 uNearFar;
  ` + '__DEPTH__' + `
  void main() {
    float d = texture(uDepth, gl_FragCoord.xy / uRes).r;
    float sz = depthIsSky(d) ? 1e5 : depthLinear(d, uNearFar.x, uNearFar.y);
    // soft: a drop just in front of a wall fades rather than cutting off
    float occ = clamp((sz - vZ) * 1.4, 0.0, 1.0);
    if (occ <= 0.0) discard;
    float across = 1.0 - vQ.y * vQ.y;
    float prof = mix(1.0, 0.45, vQ.x) * smoothstep(0.0, 0.07, vQ.x) * smoothstep(1.0, 0.82, vQ.x);
    float a = vAlpha * across * prof * occ;
    vec3 c = vCol / (1.0 + vCol);
    outColor = vec4(c * a, a);
  }`;

  /* THE GROUND. A splash is placed by reading where the rain would land: a
     hashed point in the lower part of the frame, its depth and its normal from
     this frame's own buffers, and if that pixel is a surface facing the sky
     within reach, a drop hits it there. Every instance is a short-lived splash
     that respawns somewhere else each cycle, so the pattern never repeats. */
  const SPLASH_VS = `#version 300 es
  precision highp float;
  uniform mat4 uVP;
  uniform mat4 uInvVP;
  uniform mat4 uCarInv;
  uniform sampler2D uDepth;
  uniform sampler2D uNormal;
  uniform vec2 uNearFar;
  uniform vec3 uCamRight;
  uniform float uTime;
  uniform float uActive;
  out vec2 vQ;
  out float vAge;
  out vec3 vCol;
  ` + HASH_GLSL + LIGHT_GLSL + '__DEPTH__' + `
  void main() {
    uint id = uint(gl_InstanceID);
    int corner = gl_VertexID;
    if (hf(id ^ 0x51ed27u) > uActive) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float life = mix(0.20, 0.34, hf(id * 5u + 1u));
    float tt = uTime / life + hf(id * 5u + 2u);
    float cyc = floor(tt);
    float age = tt - cyc;
    uint k = id * 7919u + uint(cyc) * 104729u;
    vec2 uv = vec2(hf(k + 11u), pow(hf(k + 12u), 1.25) * 0.64);
    float d = textureLod(uDepth, uv, 0.0).r;
    if (depthIsSky(d)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float z = depthLinear(d, uNearFar.x, uNearFar.y);
    vec3 n = textureLod(uNormal, uv, 0.0).xyz * 2.0 - 1.0;
    if (z > 34.0 || z < 0.7 || n.y < 0.72) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec4 w = uInvVP * vec4(uv * 2.0 - 1.0, depthNdc(d), 1.0);
    vec3 P = w.xyz / w.w;
    vec3 b = (uCarInv * vec4(P, 1.0)).xyz;
    if (abs(b.x) < 1.15 && b.y > -0.62 && b.y < 0.44 && b.z > -1.1 && b.z < 1.86) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
    }
    // the far ones thin out, so the density on the road is even rather than
    // even per pixel of screen
    if (hf(k + 13u) > 9.0 / (6.0 + z)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float size = mix(0.07, 0.16, hf(k + 14u)) * (0.55 + age * 0.9);
    float cx = (corner == 1 || corner == 2 || corner == 4) ? 1.0 : -1.0;
    float cy = (corner == 2 || corner == 4 || corner == 5) ? 1.0 : 0.0;
    vec3 pos = P + uCamRight * cx * size + vec3(0.0, 1.0, 0.0) * (cy * size * 1.1 - 0.01);
    gl_Position = uVP * vec4(pos, 1.0);
    vQ = vec2(cx, cy);
    vAge = age;
    vCol = rainLight(P + vec3(0.0, 0.1, 0.0));
  }`;

  const SPLASH_FS = `#version 300 es
  precision highp float;
  in vec2 vQ;
  in float vAge;
  in vec3 vCol;
  out vec4 outColor;
  uniform float uAlpha;
  void main() {
    float a = vAge;
    float x = vQ.x, y = vQ.y;
    // the crown: droplets thrown up and out, rising and falling on a parabola
    float s = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float px = (fi * 0.5 - 1.0) * (0.22 + a * 0.78);
      float py = 4.0 * a * (1.0 - a) * (0.50 + 0.40 * fract(fi * 0.618 + 0.31));
      vec2 dd = vec2(x - px, (y - py) * 1.7);
      s += exp(-dot(dd, dd) * 160.0);
    }
    // ...and the flattened sheet at its foot, which is most of a splash seen from a car
    float sheet = exp(-y * y * 80.0) * smoothstep(1.0, 0.45, abs(x) / (0.28 + a * 0.72));
    float k = (s + sheet * 0.65) * (1.0 - a) * (1.0 - a) * uAlpha;
    vec3 c = vCol / (1.0 + vCol);
    outColor = vec4(c * k, k);
  }`;

  /* THE GLASS. Each drop the simulation holds is drawn into a small buffer
     as a lens: its normal packed into RG around 0.5 and premultiplied by its
     coverage, so overlapping drops composite, and its thickness into B. The
     final pass reads it to bend the frame. See FINAL_FRAG in js/game.js. */
  const DROP_VS = `#version 300 es
  precision highp float;
  layout(location = 0) in vec4 aD;   // centre (uv), radius x (uv), radius y (uv)
  layout(location = 1) in vec2 aR;   // orientation, cos and sin
  out vec2 vQ;
  out vec2 vN;
  void main() {
    int c = gl_VertexID;
    vec2 q = vec2((c == 1 || c == 2 || c == 4) ? 1.0 : -1.0, (c == 2 || c == 4 || c == 5) ? 1.0 : -1.0);
    vec2 o = vec2(q.x * aD.z, q.y * aD.w);
    o = vec2(o.x * aR.x - o.y * aR.y, o.x * aR.y + o.y * aR.x);
    gl_Position = vec4((aD.xy + o) * 2.0 - 1.0, 0.0, 1.0);
    vQ = q;
    vN = vec2(q.x * aR.x - q.y * aR.y, q.x * aR.y + q.y * aR.x);
  }`;
  const DROP_FS = `#version 300 es
  precision highp float;
  in vec2 vQ;
  in vec2 vN;
  out vec4 outColor;
  void main() {
    float l2 = dot(vQ, vQ);
    if (l2 > 1.0) discard;
    float a = 1.0 - smoothstep(0.72, 1.0, l2);
    vec2 n = vN * (0.55 + 0.45 * l2);
    outColor = vec4(0.5 * a + 0.5 * n.x * a, 0.5 * a + 0.5 * n.y * a, sqrt(1.0 - l2) * a, a);
  }`;

  /* ========================================================= the glass ==
   *
   * The drops on the windscreen, in screen space: x from 0 to the aspect
   * ratio, y from 0 at the bottom to 1 at the top, so a round drop is round.
   * The eye is bolted into the car, so the glass does not move across the
   * screen except as the head does - close enough to hold them there.
   *
   * WHAT MOVES A DROP. Nothing, while it is small: surface tension holds a
   * bead in place. Past a critical size gravity wins and it runs down the
   * rake, leaving a trail of beads it sheds as it goes. Above about forty
   * kilometres an hour the airflow over the screen is stronger than either and
   * pushes water UP and outward toward the pillars, which is the look of rain
   * on a fast car's glass that nothing else gives.
   *
   * THERE ARE NO WIPERS. The screen is treated the way a racing car's is -
   * coated, so water beads up and the air takes it - and what keeps the view
   * is speed: parked in a downpour it beads over completely, and the faster
   * the car goes the more of the middle of the screen is swept clear, the
   * water holding on longest along the pillars and the lower edge where the
   * air over the glass is slowest.
   *
   * THE GLASS STARTS DRY and only rain wets it. When the rain stops the water
   * goes again - drop by drop, in about half a minute standing still and in a
   * few seconds at speed. */
  const MAXD = 320;
  const AGE_W = 96, AGE_H = 54;
  /* The most rain a patch of glass keeps count of. The last bead forms at
     twelve and takes a second and a half to grow (bead() in js/game.js), so
     fourteen is a fully beaded screen - and a short way back down to dry. */
  const AGE_CAP = 14;
  /* How hard the air works on each patch of the glass, 0.55 at the pillars
     and the lower edge to 1.45 high in the middle. Built once. */
  const AIR = (() => {
    const a = new Float32Array(AGE_W * AGE_H);
    for (let y = 0; y < AGE_H; y++) {
      const v = (y + 0.5) / AGE_H;
      for (let x = 0; x < AGE_W; x++) {
        const c = 1 - Math.abs((x + 0.5) / AGE_W - 0.5) * 2;
        a[y * AGE_W + x] = 0.55 + 0.9 * Math.pow(c, 1.5) * (0.6 + 0.4 * v);
      }
    }
    return a;
  })();

  class Glass {
    constructor() {
      this.n = 0;
      this.x = new Float32Array(MAXD); this.y = new Float32Array(MAXD);
      this.r = new Float32Array(MAXD);
      this.vx = new Float32Array(MAXD); this.vy = new Float32Array(MAXD);
      this.trail = new Float32Array(MAXD);
      this.inst = new Float32Array(MAXD * 6);
      this.age = new Float32Array(AGE_W * AGE_H);
      this.age8 = new Uint8Array(AGE_W * AGE_H);
      this.acc = 0;
      this.seed = 12345;
      this.wet = false;          // any water on the glass at all
      this.dirty = true;         // age8 has changed since it was last uploaded
    }
    rand() {
      let x = this.seed | 0;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this.seed = x;
      return (x >>> 0) / 4294967296;
    }
    add(x, y, r) {
      let i = this.n;
      if (i >= MAXD) {
        // full: the smallest bead makes room, which is the one nobody misses
        let small = 0, sr = 1e9;
        for (let k = 0; k < this.n; k++) if (this.r[k] < sr) { sr = this.r[k]; small = k; }
        if (sr > r) return;
        i = small;
      } else {
        this.n++;
      }
      this.x[i] = x; this.y[i] = y; this.r[i] = r;
      this.vx[i] = 0; this.vy[i] = 0; this.trail[i] = 0;
    }
    remove(i) {
      const last = --this.n;
      if (i !== last) {
        this.x[i] = this.x[last]; this.y[i] = this.y[last]; this.r[i] = this.r[last];
        this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.trail[i] = this.trail[last];
      }
    }
    clear() {
      this.n = 0;
      this.age.fill(0);
      this.age8.fill(0);
      this.wet = false;
      this.dirty = true;         // the texture has to hear about it once
    }

    step(dt, rain, speed, aspect) {
      // --- arrivals: more of them at speed, because the car drives into them
      this.acc += dt * rain * (34 + Math.max(0, speed) * 1.6);
      while (this.acc >= 1) {
        this.acc -= 1;
        const u = this.rand();
        this.add(this.rand() * aspect, 0.10 + this.rand() * 0.90, 0.0022 + 0.0105 * u * u * u);
      }
      const air = Math.max(0, speed - 11);
      // 1 once it has stopped raining, easing in over the last of a drizzle
      const dryK = 1 - clamp(rain / 0.05, 0, 1);
      const evap = dryK > 0 ? Math.exp(-dt * dryK * (0.08 + Math.max(0, speed) * 0.005)) : 1;
      for (let i = 0; i < this.n; i++) {
        this.r[i] *= evap;
        const r = this.r[i];
        // dried to nothing - checked here, because a drop too small to run
        // never reaches the test at the bottom of the loop
        if (dryK > 0 && r < 0.0012) { this.remove(i); i--; continue; }
        let vy = 0, vx = 0;
        if (r > 0.0068) vy -= (r - 0.0068) * 34;           // it runs down the rake
        if (air > 0 && r > 0.0030) {                        // ...or the air takes it up
          const lift = air * 0.0042 * clamp(r / 0.006, 0.45, 1.7);
          vy += lift;
          vx += (this.x[i] - aspect * 0.5) * lift * 0.55;
        }
        if (vy === 0 && vx === 0) { this.vx[i] = 0; this.vy[i] = 0; continue; }
        // a running drop wanders a little, the way water finds its way down glass
        vx += (this.rand() - 0.5) * 0.02;
        this.vx[i] = vx; this.vy[i] = vy;
        const mx = vx * dt, my = vy * dt;
        this.x[i] += mx; this.y[i] += my;
        this.trail[i] += Math.sqrt(mx * mx + my * my);
        if (this.trail[i] > 0.016) {
          this.trail[i] = 0;
          this.r[i] *= 0.968;
          if (this.n < MAXD - 8) this.add(this.x[i] - mx * 0.5, this.y[i] - my * 0.5, r * (0.24 + this.rand() * 0.16));
        }
        if (this.y[i] < -0.05 || this.y[i] > 1.05 || this.x[i] < -0.05 || this.x[i] > aspect + 0.05
            || this.r[i] < 0.0012) {
          this.remove(i); i--;
        }
      }
      /* --- the fine water. Rain lays it down on every patch alike; the air
         over a moving car takes it off, harder in the middle of the screen
         than at its edges, and each patch settles where the two balance - so
         the faster the car, the less of the screen holds water, and the
         middle clears first. When the rain stops it all dries back. */
      const inc = dt * rain * 1.6;
      const dry = dt * (0.45 + Math.max(0, speed) * 0.03);
      const blow = Math.max(0, speed - 4) * 0.08;
      // a drizzle keeps less on the glass than a downpour, and as a shower
      // eases the glass starts drying before the last of it has stopped
      const soak = AGE_CAP * clamp(rain / 0.25, 0, 1);
      /* One pass: the count, its byte for the texture, and whether anything
         changed - a settled shower changes nothing frame to frame, and then
         the texture is not uploaded at all (see `dirty`, read by drawGlass). */
      const age = this.age, age8 = this.age8, toByte = 255 / AGE_CAP;
      let wet = this.n > 0, dirty = false;
      for (let i = 0; i < age.length; i++) {
        const target = rain > 0.001 ? soak * rain / (rain + blow * AIR[i]) : 0;
        const a = age[i];
        const b = a < target ? Math.min(target, a + inc) : Math.max(target, a - dry);
        if (b !== a) {
          age[i] = b;
          const q = Math.round(b * toByte);
          if (q !== age8[i]) { age8[i] = q; dirty = true; }
        }
        if (b > 0.02) wet = true;
      }
      this.wet = wet;
      if (dirty) this.dirty = true;

      // --- what the drop pass draws
      const I = this.inst;
      for (let i = 0; i < this.n; i++) {
        const o = i * 6;
        const sp = Math.sqrt(this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i]);
        const stretch = 1 + Math.min(2.2, sp * 11);
        let c = 0, s = 1;
        if (sp > 1e-4) { c = this.vy[i] / sp; s = -this.vx[i] / sp; }
        const r = this.r[i];
        I[o] = this.x[i] / aspect; I[o + 1] = this.y[i];
        I[o + 2] = r / aspect; I[o + 3] = r * stretch;
        // rotation from +y onto the direction of travel
        I[o + 4] = c; I[o + 5] = s;
        if (sp <= 1e-4) { I[o + 4] = 1; I[o + 5] = 0; }
      }
    }
  }

  /* ======================================================= the weather == */

  class Weather {
    constructor(game) {
      this.g = game;
      this.mode = 'off';      // 'story', 'roam' or 'off'
      this.storyLevel = 0;
      this.seed = 1;
      this.clock = 0;
      this.rain = 0;          // what is falling now, 0..1
      this.vis = 0;           // ...as seen from where the camera is
      this.wet = 0;           // how wet the surfaces are
      this.puddle = 0;        // how much standing water there is
      this.cloud = 0;         // how overcast the sky is, which leads the rain
      this.t = 0;             // animation clock
      this.wind = [1.2, 0.6];
      this.glass = new Glass();
      this.glassK = 0;        // 0..1, the driver's view fading in and out
      this.pov = false;       // the camera is in the driver's seat
      this.camVel = new Float32Array(3);
      this.prevEye = null;
      this.said = 0;
      this.sprayAcc = new Map();
      this.gfx = null;
      this.sound = null;
    }

    // ------------------------------------------------------------ control

    /** Free Roam: showers on a schedule of this tour's own. */
    roam(seed) {
      this.mode = 'roam';
      this.seed = (seed >>> 0) || 1;
      this.clock = 0;
      this.settle(this.canRain() ? scheduled(this.seed, 0) : 0);
    }

    /** A chapter set in the rain - Chapter 3 - at a steady level: it is
        already pouring when the chapter opens. See js/story.js. */
    story(level) {
      this.mode = level > 0 ? 'story' : 'off';
      this.storyLevel = level;
      if (level > 0) this.settle(this.canRain() ? level : 0);
    }

    /** Back to a dry world, at once: a screen change is a cut. */
    clear() {
      this.mode = 'off';
      this.storyLevel = 0;
      this.rain = 0; this.vis = 0; this.wet = 0; this.puddle = 0; this.cloud = 0;
      this.glass.clear();
      this.said = 0;
      if (this.sound) this.soundLevels(0, 0, 0);
    }

    /* Arriving mid-storm: the road is already running with water. */
    settle(level) {
      this.rain = level;
      this.wet = level > 0.02 ? clamp(0.35 + level * 0.75, 0, 1) : 0;
      this.puddle = level > 0.02 ? clamp(0.30 + level * 0.70, 0, 1) : 0;
      this.cloud = clamp(level * 1.8, 0, 1);
      this.said = level > 0.1 ? 1 : 0;
    }

    /** Whether the route the car is on ever has weather. levelIndex is the
        region the car is IN: on a tour, freeRoamRegion is only where it
        started. */
    canRain() { return RAIN_ROUTES.has(this.g.levelIndex); }

    // --------------------------------------------------------- per frame

    tick(dt) {
      const g = this.g;
      const step = (g.state === 'paused') ? 0 : Math.max(0, Math.min(dt, 0.1));
      // the sound's silence is timed in real time: a paused game is still a
      // silent one, and its idle sources should still be let go
      const wall = Math.max(0, Math.min(dt, 0.1));
      if (this.mode === 'off') { this.vis = 0; this.soundUpdate(wall); return; }
      this.clock += step;
      this.t += step;
      let want = 0, sky = 0;
      const here = this.canRain();
      if (!here) {
        // the lava and the hall: no weather, whatever the schedule says
      } else if (this.mode === 'story') {
        want = sky = this.storyLevel;
      } else {
        want = scheduled(this.seed, this.clock);
        /* The cloud comes over before the rain does and clears after it: the
           sky reads the same schedule twenty-five seconds ahead and holds the
           heavier of the two. */
        sky = Math.max(want, scheduled(this.seed, this.clock + 25));
      }
      this.rain += (want - this.rain) * (1 - Math.exp(-step / (here ? 2.5 : 1.0)));
      if (this.rain < 1e-4) this.rain = 0;
      const cw = clamp(sky * 1.8, 0, 1);
      this.cloud += (cw - this.cloud) * (1 - Math.exp(-step / (!here ? 3 : cw > this.cloud ? 6 : 14)));

      /* Water on the ground: laid down in about ten seconds of real rain,
         puddles over the better part of a minute, and it takes far longer to
         go away than to arrive. */
      const r = this.rain;
      if (r > 0.02) {
        this.wet += (clamp(0.35 + r * 0.75, 0, 1) - this.wet) * (1 - Math.exp(-step * 0.12 * (0.4 + r)));
        this.puddle += (clamp(0.30 + r * 0.70, 0, 1) - this.puddle) * (1 - Math.exp(-step * 0.028 * (0.4 + r)));
      } else {
        // off a rain route it goes in a few seconds; on one, it takes minutes
        const dry = here ? 1 : 25;
        this.wet = Math.max(0, this.wet - step * 0.010 * dry);
        this.puddle = Math.max(0, this.puddle - step * 0.0045 * dry * 2.2);
      }
      const tunnel = clamp(g.camTunnel !== undefined ? Math.max(g.camTunnel, g.tunnel || 0) : (g.tunnel || 0), 0, 1);
      this.vis = r * (1 - tunnel);
      const k = (this.wind[0] = 1.2 + Math.sin(this.t * 0.07 + this.seed % 7) * 1.1);
      this.wind[1] = 0.5 + Math.cos(this.t * 0.05 + (this.seed % 11)) * 0.9 + k * 0.1;

      // the camera's own velocity, which is what stretches the streaks
      const e = g.eye;
      if (e) {
        if (!this.prevEye) this.prevEye = new Float32Array([e[0], e[1], e[2]]);
        const p = this.prevEye;
        if (step > 0) {
          let vx = (e[0] - p[0]) / step, vy = (e[1] - p[1]) / step, vz = (e[2] - p[2]) / step;
          const sp = Math.hypot(vx, vy, vz);
          if (sp > 120) { vx = 0; vy = 0; vz = 0; }       // a cut, not a car
          const a = 1 - Math.exp(-step * 12);
          this.camVel[0] += (vx - this.camVel[0]) * a;
          this.camVel[1] += (vy - this.camVel[1]) * a;
          this.camVel[2] += (vz - this.camVel[2]) * a;
        }
        p[0] = e[0]; p[1] = e[1]; p[2] = e[2];
      }

      this.announce();
      this.spray(step);
      this.soundUpdate(wall);
    }

    /* A line on the HUD when the sky changes. Not on a route without weather,
       where "road still wet" would not be true for long. */
    announce() {
      if (this.mode !== 'roam') return;
      if (!this.canRain()) { if (this.rain < 0.03) this.said = 0; return; }
      const g = this.g;
      if (g.state !== 'racing' || !g.hud || !g.hud.toast) return;
      if (this.said === 0 && this.rain > 0.14) {
        this.said = 1;
        g.hud.toast(this.rain > 0.4 ? 'RAIN  //  ROAD SURFACE WET' : 'LIGHT RAIN', '#7fd4ff');
      } else if (this.said === 1 && this.rain < 0.03) {
        this.said = 0;
        g.hud.toast('RAIN EASING  //  ROAD STILL WET', '#9fb6d8');
      }
    }

    /* Spray off the tyres: a wet road at speed throws a mist behind every
       wheel, and a car in front of you in the rain is mostly its spray. */
    spray(dt) {
      const g = this.g;
      const fx = g.fx;
      if (!fx || !fx.spawn || !fx.wheels || dt <= 0 || this.wet < 0.25) return;
      if (g.state !== 'racing' && g.state !== 'countdown' && g.state !== 'story') return;
      const cars = [g.car];
      if (g.rival && !g.soloRun && !g.storyHideRival) cars.push(g.rival);
      const dens = (g.particleDensity || 1) * (g.weatherScale || 1);
      for (const car of cars) {
        if (!car || !(car.speed > 12)) continue;
        let acc = (this.sprayAcc.get(car) || 0) + dt * (car.speed - 12) * 0.85 * this.wet * dens;
        if (acc < 1) { this.sprayAcc.set(car, acc); continue; }
        const w = fx.wheels(car);
        const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
        while (acc >= 1) {
          acc -= 1;
          const p = Math.random() < 0.5 ? 0 : 3;
          fx.spawn({
            x: w[p] + (Math.random() - 0.5) * 0.5,
            y: w[p + 1] + 0.05 + Math.random() * 0.15,
            z: w[p + 2] + (Math.random() - 0.5) * 0.5,
            vx: sy * car.speed * 0.55 + (Math.random() - 0.5) * 2.4,
            vy: 0.5 + Math.random() * 1.4,
            vz: cy * car.speed * 0.55 + (Math.random() - 0.5) * 2.4,
            floor: w[p + 1] - 0.05,
            life: 0.45 + Math.random() * 0.45,
            size: 0.8, grow: 7.5, drag: 2.6,
            r: 0.46, g: 0.52, b: 0.68,
            a: 0.06 + 0.07 * this.wet,
          });
        }
        this.sprayAcc.set(car, acc);
      }
    }

    // ------------------------------------------------------------ sound

    ensureSound() {
      if (this.sound === false) return null;
      if (this.sound) return this.sound;
      const A = this.g.audio;
      if (!A || !A.ctx || !A.sfx) return null;
      try {
        const ctx = A.ctx, sr = ctx.sampleRate;
        /* The bed: broadband, a little pink, and brightened - rain is hiss
           far more than it is rumble. */
        const bedBuf = ctx.createBuffer(2, sr * 3, sr);
        for (let ch = 0; ch < 2; ch++) {
          const d = bedBuf.getChannelData(ch);
          let b0 = 0, b1 = 0;
          for (let i = 0; i < d.length; i++) {
            const w = Math.random() * 2 - 1;
            b0 = 0.97 * b0 + w * 0.12; b1 = 0.6 * b1 + w * 0.4;
            d[i] = (b0 + b1) * 0.55;
          }
        }
        /* The patter: separate drops - short pings at random - which is the
           sound of rain on a roof you are sitting under. */
        const patBuf = ctx.createBuffer(1, sr * 4, sr);
        {
          const d = patBuf.getChannelData(0);
          const n = 4 * 260;
          for (let k = 0; k < n; k++) {
            const at = Math.floor(Math.random() * (d.length - sr * 0.01));
            const f = 1800 + Math.random() * 3200, amp = 0.15 + Math.random() * 0.55;
            const len = Math.floor(sr * (0.002 + Math.random() * 0.006));
            for (let i = 0; i < len; i++) {
              d[at + i] += Math.sin(i / sr * f * Math.PI * 2) * amp * Math.exp(-i / (len * 0.35));
            }
          }
        }
        /* The graph is built once and kept; the two sources feeding it are
           started and stopped with the rain (see soundStart / soundStop). */
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 260;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
        const bedG = ctx.createGain(); bedG.gain.value = 0;
        hp.connect(lp); lp.connect(bedG); bedG.connect(A.sfx);
        const pbp = ctx.createBiquadFilter(); pbp.type = 'bandpass'; pbp.frequency.value = 2600; pbp.Q.value = 0.6;
        const patG = ctx.createGain(); patG.gain.value = 0;
        pbp.connect(patG); patG.connect(A.sfx);
        this.sound = {
          ctx, bedG, patG, lp, A, bedBuf, patBuf, bedIn: hp, patIn: pbp,
          bedSrc: null, patSrc: null, playing: false, quiet: 0, bed: 0, pat: 0, cut: 7000,
        };
        this.soundStart(this.sound);
      } catch (e) {
        this.sound = false;
      }
      return this.sound || null;
    }

    /* The mix, told only what CHANGED. Each call schedules an automation
       event on the audio thread, and a mix that is re-asked for the same
       levels sixty times a second is a timeline that grows by a hundred and
       eighty events a second for nothing. A rain level moves slowly, so a
       change smaller than these would be inaudible anyway. */
    soundLevels(bed, pat, cut) {
      const S = this.sound;
      if (!S) return;
      const moved = Math.abs(bed - S.bed) > 0.0015 || Math.abs(pat - S.pat) > 0.0015
        || (bed === 0) !== (S.bed === 0) || (pat === 0) !== (S.pat === 0);
      if (moved) {
        const t = S.ctx.currentTime;
        S.bedG.gain.setTargetAtTime(bed, t, 0.35);
        S.patG.gain.setTargetAtTime(pat, t, 0.35);
        S.bed = bed; S.pat = pat;
      }
      if (cut && cut !== S.cut) {
        S.lp.frequency.setTargetAtTime(cut, S.ctx.currentTime, 0.25);
        S.cut = cut;
      }
    }

    soundUpdate(step) {
      const g = this.g;
      const want = this.mode !== 'off' && this.rain > 0.01;
      if (!want && !this.sound) return;
      const S = this.ensureSound();
      if (!S) return;
      const inside = !!this.pov;
      /* 'off' is silent whatever this.rain still holds: story(0) turns the
         weather off without zeroing it, and surface() and the glass go dry
         on the mode alone - the sound has to as well. */
      const muted = this.mode === 'off' || g.state === 'paused' || g.state === 'loading';
      const r = muted ? 0 : this.rain * (1 - clamp(g.tunnel || 0, 0, 1) * 0.85);
      const bed = r * (inside ? 0.10 : 0.16), pat = r * (inside ? 0.22 : 0.035);
      /* SILENCE STOPS THE SOURCES. Two looping noise buffers and their filters
         run on the audio thread whether or not anybody can hear them; once
         the mix has sat at nothing for four seconds (long enough for the fade
         to have reached it) they are stopped, and started again from the
         same buffers when the rain comes back. */
      if (bed > 0 || pat > 0) {
        S.quiet = 0;
        if (!S.playing) this.soundStart(S);
      } else if (S.playing) {
        S.quiet += Math.max(0, step || 0);
        if (S.quiet > 4) this.soundStop(S);
      }
      // inside, the roof takes the high end off the bed and adds its own drumming
      this.soundLevels(bed, pat, inside ? 2600 : 7000);
    }

    soundStart(S) {
      try {
        const mk = (buf, into) => {
          const s = S.ctx.createBufferSource();
          s.buffer = buf;
          s.loop = true;
          s.connect(into);
          s.start();
          return s;
        };
        S.bedSrc = mk(S.bedBuf, S.bedIn);
        S.patSrc = mk(S.patBuf, S.patIn);
        S.playing = true;
      } catch (e) { S.playing = false; }
    }

    soundStop(S) {
      for (const s of [S.bedSrc, S.patSrc]) {
        if (!s) continue;
        try { s.stop(); s.disconnect(); } catch (e) { /* already gone */ }
      }
      S.bedSrc = S.patSrc = null;
      S.playing = false;
      S.quiet = 0;
    }

    // ------------------------------------------------------------ the GPU

    initGL(gl, zDefs) {
      const G = NR.gl;
      if (!gl || !G) return;
      const depth = NR.DEPTH_GLSL || '';
      const X = {};
      try {
        X.streak = G.program(gl, STREAK_VS, STREAK_FS.replace('__DEPTH__', depth), 'rain.streak', zDefs);
        X.splash = G.program(gl, SPLASH_VS.replace('__DEPTH__', depth), SPLASH_FS, 'rain.splash', zDefs);
        X.drop = G.program(gl, DROP_VS, DROP_FS, 'rain.drop');
      } catch (e) {
        console.warn('SYNX: rain shaders did not build; the weather is off', e);
        return;
      }
      X.empty = gl.createVertexArray();
      X.dropVao = gl.createVertexArray();
      gl.bindVertexArray(X.dropVao);
      X.dropBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, X.dropBuf);
      gl.bufferData(gl.ARRAY_BUFFER, MAXD * 6 * 4, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      const tex = (w, h, internal, fmt, data, repeat, mips) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, gl.UNSIGNED_BYTE, data);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        if (mips) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } else {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
        return t;
      };
      X.ripple = tex(256, 256, gl.RGBA8, gl.RGBA, buildRipples(256, 16, 0x5eed), true, true);
      X.puddle = tex(256, 256, gl.R8, gl.RED, buildPuddles(256, 0xd00d), true, true);
      X.wipe = tex(AGE_W, AGE_H, gl.R8, gl.RED, this.glass.age8, false, false);
      gl.bindTexture(gl.TEXTURE_2D, null);
      X.layer = G.target(gl, 2, 2);
      X.drops = G.target(gl, 2, 2);
      this.gfx = X;
    }

    /* Everything the scene shader wants from the sky. See js/scene.js. */
    surface() {
      // one object, refilled: this is read every frame
      const S = this._surface || (this._surface = {});
      const dry = this.mode === 'off';
      S.rain = dry ? 0 : this.rain;
      S.puddle = dry ? 0 : this.puddle;
      S.wet = dry ? 0 : this.wet;
      S.overcast = dry ? 0 : this.cloud;
      S.t = this.t;
      S.ripple = this.gfx ? this.gfx.ripple : null;
      S.puddleTex = this.gfx ? this.gfx.puddle : null;
      return S;
    }

    /* The air and the ground, drawn into a layer of their own at the output
       resolution AFTER the temporal resolve - a thin fast streak is exactly
       what a temporal filter averages away - and added in the final pass. */
    drawLayer(g, outW, outH) {
      const X = this.gfx, gl = g.gl;
      this.layerOn = 0;
      if (!X || this.vis < 0.004 || !g.vpClean) return;
      const U = NR.gl.U;
      X.layer.resize(outW, outH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, X.layer.fb);
      gl.viewport(0, 0, outW, outH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(X.empty);

      const scene = g.scene;
      const inv = this._carInv || (this._carInv = new Float32Array(16));
      NR.M4.invert(inv, g.model);
      const scale = clamp(g.weatherScale || 1, 0.2, 1.6);
      const focal = outH * 0.5 / Math.tan((g.fov || 60) * Math.PI / 360);
      const fall = this._fall || (this._fall = new Float32Array(3));
      fall[0] = this.wind[0]; fall[1] = -9.4; fall[2] = this.wind[1];

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, g.rtScene.depthTex);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, g.rtScene.normTex);
      gl.activeTexture(gl.TEXTURE0);

      const lights = (P) => {
        const u = P.u, h = scene.head;
        U.v3(gl, u.uHeadL, h.L[0], h.L[1], h.L[2]);
        U.v3(gl, u.uHeadR, h.R[0], h.R[1], h.R[2]);
        U.v3(gl, u.uHeadFwd, h.fwd[0], h.fwd[1], h.fwd[2]);
        U.v3(gl, u.uHeadRight, h.right[0], h.right[1], h.right[2]);
        U.v3(gl, u.uHeadCol, h.col[0], h.col[1], h.col[2]);
        U.f(gl, u.uHeadOn, h.on);
        U.f(gl, u.uHeadRange, h.range);
        U.f(gl, u.uHeadInner, h.inner);
        U.f(gl, u.uHeadOuter, h.outer);
        U.f(gl, u.uHeadDip, h.dip);
        U.f(gl, u.uHeadToe, h.toe);
        const B = scene._lampBuf;
        const n = B ? B.n : 0;
        U.i(gl, u.uLampN, n);
        if (n) { U.v4a(gl, u.uLampP, B.p); U.v4a(gl, u.uLampC, B.c); U.v4a(gl, u.uLampD, B.d); }
        /* What a drop scatters when nothing is shining on it. A drop is a
           lens with a view of the whole sky, so it shows roughly the sky's
           average - brighter than the road it falls in front of, which is why
           rain reads against dark ground and vanishes against the horizon.
           The level's own ambient and the neon its fog is tinted with. */
        const ft = g.levelFog || [1, 1, 1];
        const amb = 0.10 + 0.16 * (scene.ambInt || 1);
        U.v3(gl, u.uAmb, ft[0] * amb, ft[1] * amb, ft[2] * amb * 1.15);
        U.m4(gl, u.uCarInv, inv);
      };

      // ---- the air, near and far
      {
        const P = X.streak, u = P.u;
        gl.useProgram(P.prog);
        lights(P);
        U.m4(gl, u.uVP, g.vpClean);
        U.v3(gl, u.uCam, g.eye[0], g.eye[1], g.eye[2]);
        U.v3(gl, u.uFall, fall[0], fall[1], fall[2]);
        U.v3(gl, u.uCamVel, this.camVel[0], this.camVel[1], this.camVel[2]);
        U.f(gl, u.uTime, this.t % 1000);
        // about a thirtieth of a second: the streak a film camera sees, and
        // long enough that a downpour reads as one from a still camera
        U.f(gl, u.uExposure, 0.034);
        U.f(gl, u.uFocal, focal);
        U.v2(gl, u.uRes, outW, outH);
        U.v2(gl, u.uNearFar, g.nearPlane || 1, g.camFar || 2000);
        U.i(gl, u.uDepth, 3);
        const act = clamp(this.vis * 1.1, 0, 1);
        // near: the drops you can see one by one
        U.v3(gl, u.uBox, 22, 16, 22);
        U.f(gl, u.uActive, act);
        U.f(gl, u.uWidth, 0.0075);
        U.f(gl, u.uAlpha, 0.90);
        U.f(gl, u.uSalt, 0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, Math.round(6000 * scale));
        /* middle: ten to twenty-five metres out, which is most of the air in
           the frame and where a still camera looks for a downpour. The near
           box has faded by then and the curtain is too faint to carry it. */
        U.v3(gl, u.uBox, 48, 28, 48);
        U.f(gl, u.uActive, act);
        U.f(gl, u.uWidth, 0.011);
        U.f(gl, u.uAlpha, 0.75);
        U.f(gl, u.uSalt, 51133);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, Math.round(3200 * scale));
        // far: a curtain, fainter and coarser
        U.v3(gl, u.uBox, 84, 44, 84);
        U.f(gl, u.uActive, act);
        U.f(gl, u.uWidth, 0.02);
        U.f(gl, u.uAlpha, 0.55);
        U.f(gl, u.uSalt, 91771);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, Math.round(3400 * scale));
      }
      // ---- the ground
      {
        const P = X.splash, u = P.u;
        gl.useProgram(P.prog);
        lights(P);
        U.m4(gl, u.uVP, g.vpClean);
        U.m4(gl, u.uInvVP, g.invVPClean || g.invVP);
        U.v2(gl, u.uNearFar, g.nearPlane || 1, g.camFar || 2000);
        const v = g.view;
        U.v3(gl, u.uCamRight, v[0], v[4], v[8]);
        U.f(gl, u.uTime, this.t % 1000);
        U.f(gl, u.uActive, clamp(this.vis, 0, 1));
        U.f(gl, u.uAlpha, 0.85);
        U.i(gl, u.uDepth, 3);
        U.i(gl, u.uNormal, 4);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, Math.round(1100 * scale));
      }
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.layerOn = 1;
    }

    /* The windscreen, from the driver's seat: step the water on it and draw
       the drops into their buffer. */
    drawGlass(g, outW, outH, pov, dt) {
      const X = this.gfx, gl = g.gl;
      this.pov = !!pov;
      /* Only while there is water on the glass or rain coming down onto it.
         A weather that is merely ON - Free Roam and a multiplayer race always
         have one - is not rain, and a dry screen draws nothing at all. */
      const want = pov && this.mode !== 'off' && (this.vis > 0.004 || this.glass.wet) ? 1 : 0;
      this.glassK += (want - this.glassK) * (1 - Math.exp(-Math.max(0, dt) * 8));
      if (!X || this.glassK < 0.01) { this.glassK = want ? this.glassK : 0; return; }
      const step = g.state === 'paused' ? 0 : Math.min(0.1, Math.max(0, dt));
      const aspect = outW / Math.max(1, outH);

      /* From the frame to the car's body space, for the final pass to tell the
         windscreen from the side glass by where each pixel's ray meets it. */
      {
        const inv = this._glassInv || (this._glassInv = new Float32Array(16));
        const M = this._glassM || (this._glassM = new Float32Array(16));
        const e = this._glassEye || (this._glassEye = new Float32Array(3));
        NR.M4.invert(inv, g.model);
        NR.M4.mul(M, inv, g.invVPClean || g.invVP);
        const p = g.eye;
        e[0] = inv[0] * p[0] + inv[4] * p[1] + inv[8] * p[2] + inv[12];
        e[1] = inv[1] * p[0] + inv[5] * p[1] + inv[9] * p[2] + inv[13];
        e[2] = inv[2] * p[0] + inv[6] * p[1] + inv[10] * p[2] + inv[14];
      }

      const speed = g.car ? (g.car.speed || 0) : 0;
      this.glass.step(step, this.vis, speed, aspect);

      // ---- the drops, into their buffer at half resolution
      const dw = Math.max(2, Math.round(outW * 0.5)), dh = Math.max(2, Math.round(outH * 0.5));
      const n = this.glass.n;
      /* No drops, and none last frame at this size: the buffer is already
         the empty lens it would be cleared to, so it is left alone. The
         beads are drawn in the final pass, not here. */
      const sized = X.drops.w === dw && X.drops.h === dh;
      if (n || !this._dropsEmpty || !sized) {
        X.drops.resize(dw, dh);
        gl.bindFramebuffer(gl.FRAMEBUFFER, X.drops.fb);
        gl.viewport(0, 0, dw, dh);
        gl.clearColor(0.5, 0.5, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      this._dropsEmpty = !n;
      if (n) {
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(X.drop.prog);
        gl.bindVertexArray(X.dropVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, X.dropBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.glass.inst, 0, n * 6);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.disable(gl.BLEND);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // ---- how much water each part of the glass is holding, when that changed
      if (this.glass.dirty) {
        this.glass.dirty = false;
        gl.bindTexture(gl.TEXTURE_2D, X.wipe);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, AGE_W, AGE_H, gl.RED, gl.UNSIGNED_BYTE, this.glass.age8);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }

    /* The final pass's share: the rain layer and the glass. Every
       sampler is bound whether or not it is read, to a texture of its own type. */
    bindFinal(g, u, white) {
      const gl = g.gl, U = NR.gl.U, X = this.gfx;
      const layer = X && this.layerOn ? X.layer.tex : white;
      const glassOn = X && this.glassK > 0.01;
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, layer);
      U.i(gl, u.uRainLayer, 3);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, glassOn ? X.drops.tex : white);
      U.i(gl, u.uDrops, 4);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, glassOn ? g.rtScene.depthTex : white);
      U.i(gl, u.uSceneDepth, 5);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, glassOn ? X.wipe : white);
      U.i(gl, u.uWipe, 7);
      gl.activeTexture(gl.TEXTURE0);
      U.f(gl, u.uRainOn, X && this.layerOn ? 1 : 0);
      U.f(gl, u.uGlass, glassOn ? this.glassK : 0);
      if (glassOn && this._glassM) {
        U.m4(gl, u.uGlassM, this._glassM);
        const e = this._glassEye;
        U.v3(gl, u.uGlassEye, e[0], e[1], e[2]);
      }
      U.v2(gl, u.uNearFar, g.nearPlane || 0.08, g.camFar || 2000);
      U.f(gl, u.uWipeCap, AGE_CAP);
    }
  }

  NR.Weather = Weather;
  NR.rainScheduled = scheduled;   // for the harness, and nothing else
})(window);
