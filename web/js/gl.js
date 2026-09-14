/* SYNX Synthwave eXtreme racing
 * Maths + a small WebGL2 layer. No dependencies.
 */
(function (global) {
  'use strict';

  const M = {
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
    lerp: (a, b, t) => a + (b - a) * t,
    damp: (a, b, lambda, dt) => M.lerp(a, b, 1 - Math.exp(-lambda * dt)),
    angDiff(a, b) {
      let d = (b - a) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d;
    },
  };

  const V3 = {
    make: (x = 0, y = 0, z = 0) => new Float32Array([x, y, z]),
    set: (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o; },
    sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross(o, a, b) {
      const x = a[1] * b[2] - a[2] * b[1];
      const y = a[2] * b[0] - a[0] * b[2];
      const z = a[0] * b[1] - a[1] * b[0];
      return V3.set(o, x, y, z);
    },
    norm(o, a) {
      const l = Math.hypot(a[0], a[1], a[2]) || 1;
      return V3.set(o, a[0] / l, a[1] / l, a[2] / l);
    },
  };

  /* column-major 4x4 */
  const M4 = {
    make: () => new Float32Array(16),
    identity(o) { o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o; },
    perspective(o, fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      o.fill(0);
      o[0] = f / aspect; o[5] = f; o[11] = -1;
      o[10] = (far + near) / (near - far);
      o[14] = (2 * far * near) / (near - far);
      return o;
    },
    /* Unity is left-handed: +X right, +Y up, +Z forward. gluLookAt and the
       projection above are right-handed, so feeding Unity's coordinates
       through them mirrors the whole world - Unity's +X came out on the LEFT
       of the screen. That inverted every steering input, flipped the track's
       corners against the original, and reversed triangle winding (which is
       why back-face culling had to be switched off). Negating clip X converts
       the left-handed world into the right-handed clip space GL expects. */
    perspectiveLH(o, fovy, aspect, near, far) {
      M4.perspective(o, fovy, aspect, near, far);
      o[0] = -o[0];
      return o;
    },
    /* Sub-pixel jitter, applied in clip space after the projection is built.
       Shifting the third column's x and y offsets NDC by a fraction of a pixel
       without touching the depth range, which is what temporal anti-aliasing
       needs: every frame samples a slightly different point inside the pixel,
       and the history buffer accumulates them into one properly resolved one. */
    jitter(o, ndcX, ndcY) {
      o[8] += ndcX;
      o[9] += ndcY;
      return o;
    },
    /* Orthographic, for the shadow cascades.

       A directional light has no position - every ray is parallel - so what it
       needs is a box, not a frustum. `lookAt` down the light's direction gives
       the orientation and this gives the extent. */
    ortho(o, l, r, b, t, n, f) {
      o.fill(0);
      o[0] = 2 / (r - l);
      o[5] = 2 / (t - b);
      o[10] = -2 / (f - n);
      o[12] = -(r + l) / (r - l);
      o[13] = -(t + b) / (t - b);
      o[14] = -(f + n) / (f - n);
      o[15] = 1;
      return o;
    },
    /** Radical-inverse Halton, the standard low-discrepancy jitter sequence. */
    halton(index, base) {
      let f = 1, r = 0, i = index;
      while (i > 0) {
        f /= base;
        r += f * (i % base);
        i = Math.floor(i / base);
      }
      return r;
    },
    /* THE SCRATCH IS THE POINT.
     *
     * This allocated four Float32Array(3) every call, and it is not called
     * once a frame: the view matrix, three shadow cascades and six reflection
     * probe faces all go through it, so it was forty short-lived typed arrays
     * a frame for arithmetic that needs none of them. A typed array is the
     * most expensive small allocation JavaScript has - it is an object, a
     * backing store and an entry in the collector's remembered set - and
     * forty a frame is what turns into a collection every few seconds, which
     * in a racing game is a dropped frame somebody feels.
     *
     * Safe because the values do not outlive the call: everything is read
     * into `o` before this returns, and the renderer is single threaded, so
     * no two lookAts are ever in flight at once. */
    _lz: new Float32Array(3),
    _lx: new Float32Array(3),
    _ly: new Float32Array(3),
    lookAt(o, eye, center, up) {
      const z = V3.norm(M4._lz, V3.sub(M4._lz, eye, center));
      const x = V3.norm(M4._lx, V3.cross(M4._lx, up, z));
      const y = V3.cross(M4._ly, z, x);
      o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0;
      o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0;
      o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0;
      o[12] = -V3.dot(x, eye); o[13] = -V3.dot(y, eye); o[14] = -V3.dot(z, eye); o[15] = 1;
      return o;
    },
    mul(o, a, b) {
      for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        o[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
      }
      return o;
    },
    /** translate + yaw/pitch/roll, matching the car's presentation */
    trs(o, px, py, pz, yaw, pitch, roll) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(pitch || 0), sp = Math.sin(pitch || 0);
      const cr = Math.cos(roll || 0), sr = Math.sin(roll || 0);
      o[0] = cy * cr + sy * sp * sr; o[1] = cp * sr; o[2] = -sy * cr + cy * sp * sr; o[3] = 0;
      o[4] = -cy * sr + sy * sp * cr; o[5] = cp * cr; o[6] = sy * sr + cy * sp * cr; o[7] = 0;
      o[8] = sy * cp; o[9] = -sp; o[10] = cy * cp; o[11] = 0;
      o[12] = px; o[13] = py; o[14] = pz; o[15] = 1;
      return o;
    },
    copy(o, m) { for (let i = 0; i < 16; i++) o[i] = m[i]; return o; },
    invert(o, m) {
      const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
      const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
      const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
      const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
      const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
      const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
      const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
      const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return M4.identity(o);
      det = 1 / det;
      o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return o;
    },
  };

  // ------------------------------------------------------------- webgl2 ---
  function compile(gl, type, src, label) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const numbered = src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n');
      console.error('shader failed [' + label + ']\n' + log + '\n' + numbered);
      // Carry the driver's own message into the exception. "compile failed"
      // on its own tells you nothing, and the console is not always somewhere
      // you can read it - a headless capture, for one.
      throw new Error('shader compile failed: ' + label + ' -- ' +
        String(log || '').trim().split('\n').slice(0, 4).join(' | '));
    }
    return s;
  }

  function program(gl, vs, fs, label) {
    const p = gl.createProgram();
    const a = compile(gl, gl.VERTEX_SHADER, vs, label + '.vert');
    const b = compile(gl, gl.FRAGMENT_SHADER, fs, label + '.frag');
    gl.attachShader(p, a); gl.attachShader(p, b);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link failed [' + label + ']: ' + gl.getProgramInfoLog(p));
    }
    gl.deleteShader(a); gl.deleteShader(b);
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { prog: p, u, label };
  }

  function target(gl, w, h, opts) {
    opts = opts || {};
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    let internal = gl.RGBA8, type = gl.UNSIGNED_BYTE;
    if (opts.float && gl.getExtension('EXT_color_buffer_half_float')) {
      internal = gl.RGBA16F; type = gl.HALF_FLOAT;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (internal !== gl.RGBA8 &&
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      internal = gl.RGBA8; type = gl.UNSIGNED_BYTE;
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    }
    /* A second colour attachment carrying world normal + roughness. The
       screen-space reflection pass needs to know which way a surface faces and
       how sharp its reflection should be, and re-deriving that from depth loses
       exactly the normal-mapped detail the wet road is made of. RGBA8 is
       plenty: the normal is packed to 0..1. */
    let normTex = null;
    if (opts.mrt) {
      normTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, normTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, normTex, 0);
    }
    let depth = null, depthTex = null;
    if (opts.depthTex) {
      // sampleable depth: volumetrics, fog and reflections all need to know
      // how far away the scene is, which a renderbuffer cannot tell them
      depthTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, depthTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    } else if (opts.depth) {
      depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return {
      fb, tex, normTex, depth, depthTex, w, h,
      resize(nw, nh) {
        if (nw === this.w && nh === this.h) return;
        this.w = nw; this.h = nh;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, nw, nh, 0, gl.RGBA, type, null);
        if (this.normTex) {
          gl.bindTexture(gl.TEXTURE_2D, this.normTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nw, nh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        if (this.depthTex) {
          gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, nw, nh, 0,
            gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        }
        if (this.depth) {
          gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
          gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, nw, nh);
        }
      },
    };
  }

  const FS_VERT = `#version 300 es
  out vec2 vUv;
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  /* ================= THE REDUNDANT UNIFORM FILTER ======================
   *
   * Guarded setters - an unused uniform is optimised out of the program and
   * its location comes back null - and, on top of that, a filter that will
   * not send a value the program already has.
   *
   * WHY, WHEN THE STATE FILTER IN js/game.js DELIBERATELY DECLINED TO.
   * That filter's note says a uniform cache "would have to be keyed on
   * program and location, and the values are mostly matrices that change
   * every frame anyway". The first half is true and the second is not, and
   * the call pattern is what settles it:
   *
   *   Scene.bind uploads about sixty uniforms and runs SEVEN times a frame -
   *   once for the main view and once for each of the reflection probe's six
   *   faces. Exactly two of those sixty differ between the seven: uVP and
   *   uCamPos. The other fifty-eight are the ambient, the sun, the fog, the
   *   headlights, the rival lamps, the cascade matrices and the probe box,
   *   restated identically six times over - about three hundred and fifty
   *   calls a frame that cannot change the picture.
   *
   *   drawCasters restates uST and uCutout per caster per cascade, and for
   *   almost every caster uST is (1,1,0,0) three times in a row.
   *
   *   Every blit in the post chain re-binds the same sampler indices to the
   *   same units on every frame for the life of the process.
   *
   * WHY KEYING ON THE LOCATION ALONE IS CORRECT. Uniform values are
   * per-PROGRAM-OBJECT state, and a WebGLUniformLocation belongs to exactly
   * one program - `program()` below fetches each one once at link time and
   * nothing re-links - so a location identifies a program and a slot
   * together. There is no key to combine it with.
   *
   * WHY THE CACHE LIVES ON THE LOCATION. A Map lookup would hash an object
   * per uniform per draw; a property read on the location is a shape check.
   * The locations are ours, created by `program`, and are not shared.
   *
   * WHY IT IS COMPARED BY VALUE AND NEVER BY REFERENCE. `uModel` is handed
   * the SAME scratch Float32Array on consecutive draws with different
   * contents in it (see Scene.drawCar). A cache that trusted identity would
   * draw every part of a car at the first part's transform.
   *
   * AND IT HAS TO FORGET. A lost context resets every uniform to zero, so a
   * cache that survived one would suppress the writes that put them back.
   * Rather than walk every location, the epoch is bumped and every entry
   * misses once. See U.forget, called from the context-loss handler in
   * js/game.js.
   */
  let uEpoch = 1;

  const U = {
    /** Drop every cached value. The context has gone; nothing is set. */
    forget() { uEpoch++; },

    f: (gl, l, v) => {
      if (l == null) return;
      if (l._e === uEpoch && l._a === v) return;
      l._e = uEpoch; l._a = v;
      gl.uniform1f(l, v);
    },
    i: (gl, l, v) => {
      if (l == null) return;
      if (l._e === uEpoch && l._a === v) return;
      l._e = uEpoch; l._a = v;
      gl.uniform1i(l, v);
    },
    v2: (gl, l, a, b) => {
      if (l == null) return;
      if (l._e === uEpoch && l._a === a && l._b === b) return;
      l._e = uEpoch; l._a = a; l._b = b;
      gl.uniform2f(l, a, b);
    },
    v3: (gl, l, a, b, c) => {
      if (l == null) return;
      if (l._e === uEpoch && l._a === a && l._b === b && l._c === c) return;
      l._e = uEpoch; l._a = a; l._b = b; l._c = c;
      gl.uniform3f(l, a, b, c);
    },
    /* NOT three scalars. Four of this setter's five callers hand it a vec3
       ARRAY - the rival lamp positions, their aim axes and the two taillight
       tables - and `uniform3fv` uploads the whole array where `uniform3f`
       would upload only its first element and leave five lamps dark. So it
       stays a bulk upload and takes the element-wise cache below, which is
       what it wanted anyway: the table is identical on six of the seven binds
       a frame. */
    v3v: (gl, l, v) => { if (l != null && changed(l, v)) gl.uniform3fv(l, v); },
    v4: (gl, l, a, b, c, d) => {
      if (l == null) return;
      if (l._e === uEpoch && l._a === a && l._b === b && l._c === c && l._d === d) return;
      l._e = uEpoch; l._a = a; l._b = b; l._c = c; l._d = d;
      gl.uniform4f(l, a, b, c, d);
    },
    /* A whole vec4 array in one call. `program` strips the "[0]" off an array
       uniform's reported name, so `u.uDent` is the location of element zero -
       which is what uniform4fv wants for an array upload. */
    v4a: (gl, l, v) => { if (l != null && changed(l, v)) gl.uniform4fv(l, v); },
    /** ...and a float array, for the rival taillight intensities. */
    fa: (gl, l, v) => { if (l != null && changed(l, v)) gl.uniform1fv(l, v); },
    m4: (gl, l, v) => { if (l != null && changed(l, v)) gl.uniformMatrix4fv(l, false, v); },
  };

  /* The array case. Sixteen float compares against a matrix upload, or
     twenty-four against the dent table: an element-wise test that MISSES is
     still a small fraction of the call it was deciding about, and the ones
     that hit - every cascade matrix on six of the seven binds, the dent table
     on every draw of an undamaged car - are the whole point.
   *
   * `_ea` rather than the `_e` the scalar setters use, so the two caches
   * cannot alias. A location written through `v3` and then through `v3v`
   * would otherwise find a same-epoch array cache that `v3` never updated
   * and skip a write it had to make. Nothing does that today; the cost of
   * making it impossible is one field. */
  function changed(l, v) {
    const n = v.length;
    let c = l._m;
    if (c === undefined || c.length !== n) {
      c = l._m = new Float32Array(n);
    } else if (l._ea === uEpoch) {
      let same = true;
      for (let i = 0; i < n; i++) { if (c[i] !== v[i]) { same = false; break; } }
      if (same) return false;
    }
    for (let i = 0; i < n; i++) c[i] = v[i];
    l._ea = uEpoch;
    return true;
  }

  global.NR = global.NR || {};
  Object.assign(global.NR, { M, V3, M4 });
  global.NR.gl = { compile, program, target, FS_VERT, U };
})(window);
