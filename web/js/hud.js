/* SYNX Synthwave eXtreme racing
 * Canvas2D interface using the game's own sprites and bitmap font.
 *
 * UIRoot is FixedSize with manualHeight 720, so coordinates below are in that
 * virtual space: origin at screen centre, +y up, exactly as the widget
 * positions were extracted from level1/level2. Sprite rects, glyph metrics and
 * every string come from data/game_data.js.
 */
(function (global) {
  'use strict';

  const AMBER = '#ffb400';
  const CYAN = '#39e6ff';
  const PINK = '#ff2e88';
  const WHITE = '#f2f0ff';
  const VIOLET = '#8b5cf6';
  const VW = 1280;
  /* Where the position/gap group starts on the left flank, and how wide it
     runs. Both are constants because the toast clamp has to know them too - if
     they drift apart the overlap comes straight back, and only on the long
     messages, which is the hardest kind to notice. */
  /* -330 rather than further out because the Chapter card on this flank is a
     DOM element sized in CSS pixels with a 196px floor, while everything here
     scales with the canvas - so the two are closest at the SMALLEST window the
     host allows, not the largest. At 960x540 this leaves 15px between them;
     at 1920x1080, 177. */
  const RIVAL_X = -330;
  const RIVAL_W = 150;               // the gap rail, which is its widest part
  const VH = 720;

  // The chrome ramp the 80s logo treatment is built on: white highlight,
  // violet mid, a hard specular break, then warm gold into magenta.
  const CHROME = [
    [0.00, '#ffffff'], [0.30, '#c8b8ff'], [0.47, '#5b3fb8'],
    [0.50, '#2a1650'], [0.53, '#ffd977'], [0.72, '#ff5fb0'], [1.00, '#7a1f6b'],
  ];

  const TEXDIR = 'assets/textures/';

  /* Title-screen row geometry, in the 1280x720 virtual space.
     `topFor` centres a block of `n` rows on the same midpoint the original two
     rows sat on, so the menu can grow a row without the layout being retuned
     and without the hit test in js/game.js going out of step with it. */
  const ML = {
    gap: 88,
    midpoint: -34,
    topFor(n) { return ML.midpoint + (n - 1) * ML.gap / 2; },
    yFor(i, n) { return ML.topFor(n) - i * ML.gap; },
  };

  /** Blend two #rrggbb strings; used for the speed readout's heat tint. */
  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const c = Math.floor((sec * 100) % 100);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(m) + ':' + p(s) + ':' + p(c);
  }

  /* How much of the HUD is showing while the lights run, and how long it takes
     to come up once the race is live. */
  const HUD_GHOST = 0.26, HUD_REVEAL = 0.75;

  /* ---------------------------------------------------------------- INK --
   *
   * Every secondary colour in this file used to be written out where it was
   * used: INK.mute for one caption, INK.mute
   * for the next, INK.body for a third. Nine different greys,
   * none of them the same, all of them meaning "quieter than the value beside
   * it" - and that is exactly what makes an interface read as assembled
   * rather than designed, because the eye can tell that two labels doing the
   * same job are not the same colour even when it cannot say why.
   *
   * Four levels, from the one colour. Nothing outside this table.
   */
  const INK = {
    key: 'rgba(238,246,255,0.96)',      // the value itself
    body: 'rgba(206,228,255,0.82)',     // a readable secondary
    mute: 'rgba(176,204,240,0.60)',     // captions, units, hints
    faint: 'rgba(150,180,222,0.38)',    // rails, dividers, disabled
  };

  /* THE TYPE SCALE. A ratio, not a list of sizes somebody liked.
     1.28 between steps, which is wide enough that two adjacent roles never
     look like the same size drawn slightly wrong. */
  const T = {
    hero: 58, title: 44, head: 34, value: 26, body: 18, cap: 14, micro: 11,
  };

  const ease = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
  /* A little past the mark and back. Used on anything that ARRIVES - a card,
     a selection, a toast - because a panel that stops dead where it was going
     reads as a slide show and one that settles reads as an object. */
  const overshoot = (t) => {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const u = 1 - t;
    return 1 - u * u * u * (1 - 1.7 * t);
  };

  class Hud {
    constructor(canvas, data) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.data = data || {};
      this.dpr = 1;
      this.toasts = [];
      this.img = {};
      this.sprites = {};      // name -> {rect, tex}
      this.font = (this.data.font) || { size: 90, glyphs: {} };

      const at = this.data.atlas || {};
      this.byAtlas = {};        // atlas key -> name -> {r, tex}
      for (const k of Object.keys(at)) {
        const a = at[k];
        const tex = a.texture ? a.texture + '.png' : null;
        const tbl = this.byAtlas[k] = {};
        for (const n of Object.keys(a.sprites || {})) {
          tbl[n] = { r: a.sprites[n], tex };
          if (!this.sprites[n]) this.sprites[n] = { r: a.sprites[n], tex };
        }
      }

      // The NGUI HUD layout, extracted from the game's own widget tree by
      // tools/re/build_gamedata.py. Indexed by GameObject name; a few names
      // repeat (two race flags, a nested txt_mph), so every hit is kept.
      this.layout = {};
      for (const wgt of (this.data.hud || [])) {
        (this.layout[wgt.name] || (this.layout[wgt.name] = [])).push(wgt);
      }
    }

    /** One widget by name, or null. `i` picks among repeated names. */
    wgt(name, i) {
      const a = this.layout && this.layout[name];
      return a ? a[i || 0] : null;
    }

    /* NGUI UIWidget.Pivot: TopLeft 0, Top 1, TopRight 2, Left 3, Center 4,
       Right 5, BottomLeft 6, Bottom 7, BottomRight 8. Returns the widget's
       centre in virtual units, which is what the drawing helpers take. */
    centre(wgt) {
      // TopLeft is pivot 0, so `|| 4` would silently recentre it - that pushed
      // the DRIVETRAIN panel off the left edge of the screen.
      const pv = (wgt.pivot === undefined || wgt.pivot === null) ? 4 : wgt.pivot;
      const ax = [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1][pv];
      const ay = [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1][pv];
      return {
        x: wgt.x - ax * wgt.w + wgt.w / 2,
        y: wgt.y + ay * wgt.h - wgt.h / 2,
      };
    }

    /** Draw a laid-out sprite widget at its authored size. */
    placeSprite(name, i, alpha, frac) {
      const wgt = this.wgt(name, i);
      if (!wgt || !wgt.sprite) return false;
      const tbl = (wgt.atlas && this.byAtlas[wgt.atlas]) || null;
      const s = (tbl && tbl[wgt.sprite]) || this.sprites[wgt.sprite];
      if (!s || !s.tex || !this.img[s.tex]) return false;
      const p = this.centre(wgt);
      const r = s.r;
      const w = this.vs(wgt.w), h = this.vs(wgt.h);
      const f = frac === undefined ? 1 : Math.max(0, Math.min(1, frac));
      if (f <= 0) return true;
      const c = this.ctx;
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.drawImage(this.img[s.tex], r[0], r[1], r[2] * f, r[3],
        this.vx(p.x) - w / 2, this.vy(p.y) - h / 2, w * f, h);
      c.restore();
      return true;
    }

    /** Draw one atlas widget recoloured without tinting HUD layers beneath it. */
    placeSpriteTinted(name, i, alpha, frac, tint) {
      const wgt = this.wgt(name, i);
      if (!wgt || !wgt.sprite) return false;
      const tbl = (wgt.atlas && this.byAtlas[wgt.atlas]) || null;
      const s = (tbl && tbl[wgt.sprite]) || this.sprites[wgt.sprite];
      if (!s || !s.tex || !this.img[s.tex]) return false;
      const f = frac === undefined ? 1 : Math.max(0, Math.min(1, frac));
      if (f <= 0) return true;
      const p = this.centre(wgt), r = s.r;
      const w = Math.max(2, Math.ceil(this.vs(wgt.w) * f));
      const h = Math.max(2, Math.ceil(this.vs(wgt.h)));
      if (!this.scratch) {
        this.scratch = document.createElement('canvas');
        this.sctx = this.scratch.getContext('2d');
      }
      if (this.scratch.width < w || this.scratch.height < h) {
        this.scratch.width = Math.max(this.scratch.width, w);
        this.scratch.height = Math.max(this.scratch.height, h);
      }
      const sc = this.sctx;if (!sc) return false;
      sc.setTransform(1,0,0,1,0,0);sc.clearRect(0,0,this.scratch.width,this.scratch.height);
      sc.drawImage(this.img[s.tex],r[0],r[1],r[2]*f,r[3],0,0,w,h);
      sc.save();sc.globalCompositeOperation='source-atop';sc.fillStyle=tint;sc.globalAlpha=.92;sc.fillRect(0,0,w,h);sc.restore();
      const c=this.ctx;c.save();if(alpha!==undefined)c.globalAlpha=alpha;c.shadowColor=tint;c.shadowBlur=this.vs(11);
      c.drawImage(this.scratch,0,0,w,h,this.vx(p.x)-this.vs(wgt.w)/2,this.vy(p.y)-h/2,w,h);c.restore();
      return true;
    }

    /** An atlas sprite at an explicit centre and virtual size. */
    spriteAt(sprite, cx, cy, w, h, alpha) {
      const s = this.sprites[sprite];
      if (!s || !s.tex || !this.img[s.tex]) return false;
      const r = s.r;
      const dw = this.vs(w), dh = this.vs(h);
      const c = this.ctx;
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.drawImage(this.img[s.tex], r[0], r[1], r[2], r[3],
        this.vx(cx) - dw / 2, this.vy(cy) - dh / 2, dw, dh);
      c.restore();
      return true;
    }

    /** Draw digits into a laid-out label widget, matching its box height.
     *  `shift` nudges the run sideways in virtual units. */
    placeDigits(name, txt, i, alpha, tint, shift) {
      const wgt = this.wgt(name, i);
      if (!wgt) return false;
      const p = this.centre(wgt);
      this.digits(txt, p.x + (shift || 0), p.y, wgt.h, 'center', alpha, tint);
      return true;
    }

    load() {
      const need = new Set();
      for (const n of Object.keys(this.sprites)) {
        if (this.sprites[n].tex) need.add(this.sprites[n].tex);
      }
      need.add('Digital_Italic.png');
      return Promise.all([...need].map(f => new Promise(res => {
        const im = new Image();
        im.onload = () => { this.img[f] = im; res(); };
        im.onerror = () => res();
        im.src = global.NR.Pak.url(TEXDIR + f);
      })));
    }

    resize(w, h, dpr) {
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.w = w; this.h = h;
      /* The authored interface is 1280x720. Scaling from height alone works at
         16:9, but a portrait or narrow browser window makes the virtual width
         smaller than the menu itself: panels clip at both sides and the title,
         selection brackets and footer appear piled together. Fit the complete
         virtual frame in both axes so every menu and HUD group keeps its
         authored spacing at every aspect ratio. */
      this.k = Math.max(0.01, Math.min(w / VW, h / VH));
      this.vw = w / this.k;
      this.vh = h / this.k;
    }

    vx(x) { return this.w / 2 + x * this.k; }
    vy(y) { return this.h / 2 - y * this.k; }
    vs(n) { return n * this.k; }

    toast(text, color) { this.toasts.push({ text, color: color || CYAN, t: 0 }); }

    // -------------------------------------------------------- primitives --
    label(txt, x, y, size, color, align, weight, alpha) {
      const c = this.ctx;
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.font = (weight || 700) + ' ' + this.vs(size) + 'px "Orbitron", "Segoe UI", system-ui, sans-serif';
      c.textAlign = align || 'left';
      c.textBaseline = 'middle';
      c.shadowColor = color;
      c.shadowBlur = this.vs(size) * 0.5;
      c.fillStyle = color;
      c.fillText(txt, this.vx(x), this.vy(y));
      c.restore();
    }

    measure(txt, size) {
      const c = this.ctx;
      c.save();
      c.font = '700 ' + this.vs(size) + 'px "Orbitron", system-ui, sans-serif';
      const w = c.measureText(txt).width;
      c.restore();
      return w / this.k;
    }

    sprite(name, cx, cy, scale, alpha) {
      const s = this.sprites[name];
      if (!s || !s.tex) return false;
      const im = this.img[s.tex];
      if (!im) return false;
      const r = s.r;
      const k = (scale === undefined ? 1 : scale) * this.k;
      const w = r[2] * k, h = r[3] * k;
      const c = this.ctx;
      if (alpha !== undefined) { c.save(); c.globalAlpha = alpha; }
      c.drawImage(im, r[0], r[1], r[2], r[3], this.vx(cx) - w / 2, this.vy(cy) - h / 2, w, h);
      if (alpha !== undefined) c.restore();
      return true;
    }

    /** Clip a sprite horizontally to `frac` of its width, from the left. */
    spriteClipped(name, cx, cy, scale, frac, alpha) {
      const s = this.sprites[name];
      if (!s || !s.tex || !this.img[s.tex]) return false;
      const r = s.r;
      const k = (scale === undefined ? 1 : scale) * this.k;
      const w = r[2] * k, h = r[3] * k;
      const f = Math.max(0, Math.min(1, frac));
      if (f <= 0) return true;
      const c = this.ctx;
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.drawImage(this.img[s.tex], r[0], r[1], r[2] * f, r[3],
        this.vx(cx) - w / 2, this.vy(cy) - h / 2, w * f, h);
      c.restore();
      return true;
    }

    /** The shipped Digital_Italic 7-segment face. */
    /* The shipped Digital_Italic 7-segment face.

       `tint` recolours it. That has to happen in an offscreen buffer: a
       source-atop fill on the live canvas paints through everything already
       drawn under the rectangle, which turned the speed meter orange as well
       as the digits. */
    digits(txt, x, y, size, align, alpha, tint) {
      const im = this.img['Digital_Italic.png'];
      const g = this.font.glyphs || {};
      txt = String(txt);
      if (!im) {
        this.label(txt, x, y, size * 0.8, tint || AMBER, align, 700, alpha);
        return;
      }
      const scale = this.vs(size) / (this.font.size || 90);
      let width = 0;
      for (const ch of txt) {
        const m = g[ch.charCodeAt(0)];
        width += (m ? m[6] : 45) * scale;
      }
      let pen = this.vx(x);
      if (align === 'center') pen -= width / 2;
      else if (align === 'right') pen -= width;
      const top = this.vy(y) - this.vs(size) * 0.5;

      if (!tint) {
        const c = this.ctx;
        c.save();
        if (alpha !== undefined) c.globalAlpha = alpha;
        this.glyphRun(c, im, g, txt, pen, top, scale);
        c.restore();
        return;
      }

      // --- tinted: draw the run into a scratch canvas and recolour it there
      const padX = this.vs(size) * 0.6, padY = this.vs(size) * 0.8;
      const bw = Math.max(2, Math.ceil(width + padX * 2));
      const bh = Math.max(2, Math.ceil(this.vs(size) * 2 + padY));
      if (!this.scratch) {
        this.scratch = document.createElement('canvas');
        this.sctx = this.scratch.getContext('2d');
      }
      if (this.scratch.width < bw || this.scratch.height < bh) {
        this.scratch.width = bw;
        this.scratch.height = bh;
      }
      const sc = this.sctx;
      if (!sc) return;
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.clearRect(0, 0, this.scratch.width, this.scratch.height);
      this.glyphRun(sc, im, g, txt, padX, padY * 0.5, scale);
      sc.save();
      sc.globalCompositeOperation = 'source-atop';
      sc.fillStyle = tint;
      sc.globalAlpha = 0.85;
      sc.fillRect(0, 0, this.scratch.width, this.scratch.height);
      sc.restore();

      const c = this.ctx;
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.shadowColor = tint;
      c.shadowBlur = this.vs(size) * 0.35;
      c.drawImage(this.scratch, 0, 0, bw, bh,
        pen - padX, top - padY * 0.5, bw, bh);
      c.restore();
    }

    /** Blit one run of bitmap glyphs into `c` starting at (pen, top). */
    glyphRun(c, im, g, txt, pen, top, scale) {
      for (const ch of txt) {
        const m = g[ch.charCodeAt(0)];
        if (m && m[2] > 0 && m[3] > 0) {
          c.drawImage(im, m[0], m[1], m[2], m[3],
            pen + m[4] * scale, top + m[5] * scale, m[2] * scale, m[3] * scale);
        }
        pen += (m ? m[6] : 45) * scale;
      }
    }

    // ------------------------------------------- retro-futuristic bits --

    /** Chrome-ramp headline with an outer neon glow and a bevelled edge. */
    chrome(txt, x, y, size, glow, alpha) {
      const c = this.ctx;
      const px = this.vs(size);
      const sx = this.vx(x), sy = this.vy(y);
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.font = '900 ' + px + 'px "Orbitron", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';

      // bloom halo underneath
      c.shadowColor = glow || PINK;
      c.shadowBlur = px * 0.7;
      c.fillStyle = glow || PINK;
      c.fillText(txt, sx, sy);
      c.fillText(txt, sx, sy);
      c.shadowBlur = 0;

      const g = c.createLinearGradient(0, sy - px * 0.62, 0, sy + px * 0.62);
      for (const [stop, col] of CHROME) g.addColorStop(stop, col);
      c.fillStyle = g;
      c.fillText(txt, sx, sy);

      c.lineWidth = Math.max(1, px * 0.028);
      c.strokeStyle = 'rgba(255,255,255,0.65)';
      c.strokeText(txt, sx, sy);

      // horizontal cut lines, the way the era's airbrushed logos were done
      const w = c.measureText(txt).width;
      c.globalCompositeOperation = 'destination-out';
      const step = Math.max(2, px * 0.11);
      for (let ly = sy - px * 0.55; ly < sy + px * 0.55; ly += step) {
        c.fillStyle = 'rgba(0,0,0,0.5)';
        c.fillRect(sx - w / 2 - 4, ly, w + 8, Math.max(1, px * 0.022));
      }
      c.globalCompositeOperation = 'source-over';
      c.restore();
    }

    /** Text with a wide outer glow and a bright core - a neon tube. */
    neon(txt, x, y, size, color, align, weight, alpha) {
      const c = this.ctx;
      const px = this.vs(size);
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.font = (weight || 800) + ' ' + px + 'px "Orbitron", system-ui, sans-serif';
      c.textAlign = align || 'center';
      c.textBaseline = 'middle';
      const sx = this.vx(x), sy = this.vy(y);
      c.shadowColor = color;
      c.shadowBlur = px * 0.85;
      c.fillStyle = color;
      c.fillText(txt, sx, sy);
      c.shadowBlur = px * 0.35;
      c.fillText(txt, sx, sy);
      c.shadowBlur = 0;
      c.fillStyle = '#ffffff';
      c.globalAlpha = (alpha === undefined ? 1 : alpha) * 0.55;
      c.fillText(txt, sx, sy);
      c.restore();
    }

    /* THE FROSTED BACKDROP.
     *
     * A modal that darkens what is behind it is a rectangle on a photograph. A
     * modal that BLURS what is behind it is a piece of glass in front of it,
     * and the difference is most of what separates an interface that looks
     * shipped from one that looks placed.
     *
     * The 3D is a different canvas underneath this one, and it has already
     * been drawn for this frame by the time draw() runs - so it can be sampled
     * directly. It goes through a small offscreen canvas first: downsampling to
     * an eighth and letting the upscale do the smoothing is both far cheaper
     * than a full-resolution blur filter and a better blur, because a box
     * downsample averages every pixel rather than the ones inside a kernel.
     *
     * Only the modal screens ask for it - a pause, a finish card, the options.
     * Those are exactly the screens where nothing is moving, so the cost lands
     * where there is nothing else spending the frame.
     */
    frost(strength, tint) {
      const src = this.glCanvas;
      if (!src || !src.width || !src.height) return false;
      const q = Math.max(0, Math.min(1, strength === undefined ? 1 : strength));
      try {
        const sw = Math.max(2, Math.round(this.w / 10));
        const sh = Math.max(2, Math.round(this.h / 10));
        let b = this._frostBuf;
        if (!b || b.width !== sw || b.height !== sh) {
          b = this._frostBuf = global.document.createElement('canvas');
          b.width = sw; b.height = sh;
          this._frostCtx = b.getContext('2d');
        }
        const bc = this._frostCtx;
        bc.clearRect(0, 0, sw, sh);
        bc.drawImage(src, 0, 0, sw, sh);
        const c = this.ctx;
        c.save();
        c.imageSmoothingEnabled = true;
        c.globalAlpha = q;
        /* Drawn twice at slightly different scales: the second pass is a
           half-texel offset from the first, which softens the bilinear
           upscale's own grid without a second downsample. */
        c.drawImage(b, 0, 0, this.w, this.h);
        c.globalAlpha = q * 0.55;
        c.drawImage(b, -this.w * 0.004, -this.h * 0.004,
          this.w * 1.008, this.h * 1.008);
        c.restore();
        // ...and a colour wash over it, so the blur reads as glass rather than
        // as a mistake, and the type on top of it has a floor to sit on
        c.save();
        c.fillStyle = tint || 'rgba(7,2,22,0.62)';
        c.fillRect(0, 0, this.w, this.h);
        c.restore();
        return true;
      } catch (e) {
        // some drivers refuse to hand back a WebGL canvas mid-frame; the
        // caller's scrim still runs and the screen is dimmer, not broken
        return false;
      }
    }

    /* A framed panel with cut corners.
     *
     * Four things a flat fill with a neon edge does not have, in the order
     * they matter: a GRADIENT, so the panel has a top and a bottom rather than
     * being a colour; an INNER GLOW along the lit edge, which is what makes a
     * border look like it is emitting rather than drawn; a HIGHLIGHT on the
     * top face, which is the single cue that says "this is in front"; and a
     * SHADOW under it, which is the cue that says how far in front.
     *
     * `t` is 0..1 and animates all four together, so a card can arrive.
     */
    panel(x, y, w, h, color, fillA, t) {
      const c = this.ctx;
      const k = t === undefined ? 1 : ease(t);
      if (k <= 0.001) return;
      const X = this.vx(x - w / 2), Y = this.vy(y + h / 2);
      const W = this.vs(w), H = this.vs(h);
      const cut = Math.min(W, H) * 0.09;
      const col = color || CYAN;
      const path = () => {
        c.beginPath();
        c.moveTo(X + cut, Y);
        c.lineTo(X + W, Y);
        c.lineTo(X + W, Y + H - cut);
        c.lineTo(X + W - cut, Y + H);
        c.lineTo(X, Y + H);
        c.lineTo(X, Y + cut);
        c.closePath();
      };
      c.save();
      c.globalAlpha = k;

      const a = fillA === undefined ? 0.78 : fillA;
      /* The drop, first and underneath - AND IN PROPORTION.
       *
       * The shadow is drawn by filling the panel's own shape and letting the
       * blur spill past it, which means the fill is under the panel as well as
       * around it. On an opaque card that is invisible; on a translucent one -
       * a menu highlight at 0.28, a notification at 0.46 - it is a second
       * layer of black the caller did not ask for, and the selection bar over
       * a lit road came out as a solid slab. So the shadow carries the same
       * translucency the panel does. */
      const drop = Math.min(0.5, a * 0.62);
      if (drop > 0.04) {
        c.save();
        c.shadowColor = 'rgba(0,0,0,' + (0.30 + drop * 0.5).toFixed(3) + ')';
        c.shadowBlur = this.vs(26);
        c.shadowOffsetY = this.vs(8);
        path();
        c.fillStyle = 'rgba(0,0,0,' + drop.toFixed(3) + ')';
        c.fill();
        c.restore();
      }

      const g = c.createLinearGradient(0, Y, 0, Y + H);
      g.addColorStop(0, 'rgba(23,10,48,' + (a * 1.06).toFixed(3) + ')');
      g.addColorStop(0.55, 'rgba(11,3,29,' + a.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(5,1,16,' + (a * 1.04).toFixed(3) + ')');
      path();
      c.fillStyle = g;
      c.fill();

      c.save();
      path();
      c.clip();
      // the scanline wash the whole game is graded through
      c.fillStyle = 'rgba(255,255,255,0.026)';
      for (let ly = Y; ly < Y + H; ly += 4) c.fillRect(X, ly, W, 1);
      // an inner glow off the lit edge
      const inner = c.createLinearGradient(0, Y, 0, Y + this.vs(46));
      inner.addColorStop(0, this._alpha(col, 0.20));
      inner.addColorStop(1, this._alpha(col, 0));
      c.fillStyle = inner;
      c.fillRect(X, Y, W, this.vs(46));
      // ...and the highlight along the top face
      c.fillStyle = this._alpha(col, 0.55);
      c.fillRect(X + cut, Y, W - cut, Math.max(1, this.vs(1.2)));
      c.restore();

      c.strokeStyle = col;
      c.lineWidth = Math.max(1, this.vs(1.6));
      c.shadowColor = col;
      c.shadowBlur = this.vs(12);
      path();
      c.stroke();
      c.restore();
    }

    /** A hex or rgb(a) colour at a given alpha. */
    _alpha(col, a) {
      if (!col) return 'rgba(57,230,255,' + a + ')';
      if (col[0] === '#') {
        const h = col.slice(1);
        const n = h.length === 3
          ? [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
          : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        return 'rgba(' + n[0] + ',' + n[1] + ',' + n[2] + ',' + a + ')';
      }
      const m = col.match(/rgba?\(([^)]+)\)/);
      if (!m) return col;
      const v = m[1].split(',').map(x => parseFloat(x));
      return 'rgba(' + (v[0] | 0) + ',' + (v[1] | 0) + ',' + (v[2] | 0) + ',' + a + ')';
    }

    /* A hint line along the bottom of a panel.

       Placed FROM the panel rather than at an absolute height, because the
       options hint was authored at y = -326 under a panel whose bottom edge is
       at -323: three units outside it, straight through the border, on every
       screen at every resolution. Passing the panel's own geometry in is what
       stops that being possible. */
    footer(txt, panelY, panelH) {
      this.label(txt, 0, panelY - panelH / 2 + 26, 15,
        INK.mute, 'center', 600);
    }

    /** Corner brackets, the universal "targeting system" cue. */
    brackets(x, y, w, h, color, len, alpha) {
      const c = this.ctx;
      const X = this.vx(x - w / 2), Y = this.vy(y + h / 2);
      const W = this.vs(w), H = this.vs(h), L = this.vs(len || 22);
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.strokeStyle = color || CYAN;
      c.lineWidth = Math.max(1, this.vs(2.2));
      c.shadowColor = color || CYAN;
      c.shadowBlur = this.vs(8);
      c.beginPath();
      c.moveTo(X, Y + L); c.lineTo(X, Y); c.lineTo(X + L, Y);
      c.moveTo(X + W - L, Y); c.lineTo(X + W, Y); c.lineTo(X + W, Y + L);
      c.moveTo(X + W, Y + H - L); c.lineTo(X + W, Y + H); c.lineTo(X + W - L, Y + H);
      c.moveTo(X + L, Y + H); c.lineTo(X, Y + H); c.lineTo(X, Y + H - L);
      c.stroke();
      c.restore();
    }

    /* The DRIVETRAIN readout.
     *
     * It shipped as an atlas sprite called C.A.T. - and the sprite is a
     * 512x142 bitmap
     * with an alpha channel that is 255 everywhere and a mean colour of
     * (20, 50, 52). Drawn over the road at a fifth of the screen width, that
     * is a large, hard-edged, low-resolution BLACK BOX sitting on the tarmac,
     * with a waveform baked into it that never moves. In the original it was
     * one cell of a full-width dashboard console, where an opaque panel is
     * exactly right; on its own over open road it is the single most obviously
     * broken thing on the screen.
     *
     * So it is drawn rather than blitted: the same readout as a translucent
     * instrument with a real trace running through it. The trace is built from
     * the drivetrain - engine speed sets the frequency, load and wheelspin set
     * the amplitude - so it is an instrument showing something rather than a
     * picture of one. */
    catScope(g) {
      const c = this.ctx;
      const car = g.car;
      const x = -444, y = -272, w = 200, h = 54;
      /* TWO INSTRUMENTS, TWO CELLS.
       The trace ran the full width of the glass and the gear numeral was
       printed on top of it, in the middle, which is exactly where the
       waveform is loudest - so the one number a driver reads at a glance was
       the one thing on the panel with a moving background. The panel is
       divided now: the scope has the left of it and the gearbox has a cell
       of its own on the right, with a rule between them. */
      const SCOPE = 0.71;
      const boost = car.boosting ? 1 : 0;
      const col = boost ? PINK : CYAN;

      // the glass: dark enough to read a trace against, clear enough to see
      // the road through - which is the whole difference from the sprite
      const X = this.vx(x - w / 2), Y = this.vy(y + h / 2);
      const W = this.vs(w), H = this.vs(h);
      c.save();
      c.beginPath();
      const cut = this.vs(7);
      c.moveTo(X + cut, Y);
      c.lineTo(X + W, Y);
      c.lineTo(X + W, Y + H - cut);
      c.lineTo(X + W - cut, Y + H);
      c.lineTo(X, Y + H);
      c.lineTo(X, Y + cut);
      c.closePath();
      const gr = c.createLinearGradient(X, Y, X, Y + H);
      gr.addColorStop(0, 'rgba(12,4,30,0.30)');
      gr.addColorStop(1, 'rgba(6,2,18,0.46)');
      c.fillStyle = gr;
      c.fill();
      c.save();
      c.clip();
      // ...and the trace is clipped to its own cell, not to the whole glass
      const SW = W * SCOPE;
      c.save();
      c.beginPath();
      c.rect(X, Y, SW, H);
      c.clip();

      // graticule
      c.strokeStyle = 'rgba(160,220,255,0.10)';
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 1; i < 6; i++) {
        const gx = X + SW * (i / 6);
        c.moveTo(gx, Y); c.lineTo(gx, Y + H);
      }
      c.moveTo(X, Y + H * 0.62); c.lineTo(X + SW, Y + H * 0.62);
      c.stroke();

      /* The trace. Engine speed sets the pitch, throttle and wheelspin set how
         hard it is driven, and it scrolls with road speed - so it settles to a
         flat line at a standstill and screams at the limiter. */
      const rpm = Math.max(0, Math.min(1, car.rpm || 0));
      const load = Math.max(0, Math.min(1, car.engineLoad || 0));
      const amp = H * (0.06 + 0.26 * load + 0.10 * (car.wheelSpinFx || 0)
        + 0.08 * (car.driftAmount || 0));
      const freq = 5 + rpm * 26;
      const scroll = g.time * (2.0 + rpm * 9.0);
      const mid = Y + H * 0.62;
      const N = 96;
      c.beginPath();
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const px = X + SW * t;
        const ph = t * freq + scroll;
        // two beating partials plus a rasp that comes in with the revs: a
        // single sine reads as a test tone, not as an engine
        const v = Math.sin(ph) * 0.62
          + Math.sin(ph * 2.13 + 1.7) * 0.26 * (0.3 + rpm)
          + Math.sin(ph * 5.7 + 0.4) * 0.14 * rpm;
        // and it fades in from each end, as a scope trace does
        const env = Math.sin(t * Math.PI);
        if (i === 0) c.moveTo(px, mid - v * amp * env);
        else c.lineTo(px, mid - v * amp * env);
      }
      c.strokeStyle = col;
      c.lineWidth = Math.max(1, this.vs(1.6));
      c.shadowColor = col;
      c.shadowBlur = this.vs(7);
      c.stroke();
      // a second, brighter pass down the middle gives the trace a filament
      c.globalAlpha = 0.55;
      c.strokeStyle = '#ffffff';
      c.lineWidth = Math.max(1, this.vs(0.7));
      c.shadowBlur = this.vs(3);
      c.stroke();
      c.restore();          // the scope cell's clip

      /* The gear cell: its own ground, so the numeral is read against a flat
         surface rather than against the waveform. */
      c.globalAlpha = 1;
      c.shadowBlur = 0;
      c.fillStyle = 'rgba(6,2,20,0.52)';
      c.fillRect(X + SW, Y, W - SW, H);
      c.strokeStyle = 'rgba(120,190,240,0.34)';
      c.lineWidth = Math.max(1, this.vs(1));
      c.beginPath();
      c.moveTo(X + SW, Y + this.vs(3));
      c.lineTo(X + SW, Y + H - this.vs(3));
      c.stroke();
      c.restore();          // the panel's clip

      // frame and label
      c.globalAlpha = 1;
      c.strokeStyle = 'rgba(57,230,255,0.55)';
      c.lineWidth = Math.max(1, this.vs(1.3));
      c.shadowColor = col;
      c.shadowBlur = this.vs(8);
      c.stroke();
      c.restore();
      this.label('DRIVETRAIN', x - w / 2 + 9, y + h / 2 - 11, 11,
        'rgba(160,220,255,0.75)', 'left', 700);

      /* The gearbox, in the instrument that is already showing what the
         gearbox is doing - and in a cell of its own inside it, because the
         same number over a live trace was unreadable at exactly the moment
         the trace was busiest. */
      const flash = car.shiftFlash || 0;
      const gx0 = x + w / 2 - (w * (1 - SCOPE)) / 2;
      this.label('GEAR', gx0, y + h / 2 - 11, 10,
        'rgba(160,220,255,0.62)', 'center', 700);
      this.neon(String(car.gear), gx0, y + h / 2 - 40, 30 + flash * 8,
        flash > 0.05 ? AMBER : CYAN, 'center', 900, 1);

      /* Revs along the scope's floor, with the shift point marked on it - so
         the trace above and the bar below are the same drivetrain, read two
         ways. The bar goes hot at the upshift, which is the cue to lift. */
      const rev = Math.max(0, Math.min(1, car.rpm || 0));
      const bw = w * SCOPE - 18, bx = x - w / 2 + 9, by = y - h / 2 + 5, bh = 4;
      c.save();
      c.fillStyle = 'rgba(255,255,255,0.13)';
      c.fillRect(this.vx(bx), this.vy(by), this.vs(bw), this.vs(bh));
      c.fillStyle = rev > 0.90 ? '#ff2e88' : (rev > 0.78 ? AMBER : CYAN);
      c.shadowColor = c.fillStyle;
      c.shadowBlur = this.vs(6);
      c.fillRect(this.vx(bx), this.vy(by), this.vs(bw) * rev, this.vs(bh));
      // the upshift point, so the bar means something
      c.shadowBlur = 0;
      c.fillStyle = 'rgba(255,255,255,0.5)';
      c.fillRect(this.vx(bx + bw * 0.90), this.vy(by - 2), Math.max(1, this.vs(1.4)), this.vs(bh + 4));
      c.restore();
    }

    /** A neon rule with a diamond at each end. */
    rule(x, y, w, color, alpha) {
      const c = this.ctx;
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.strokeStyle = color || CYAN;
      c.lineWidth = Math.max(1, this.vs(2));
      c.shadowColor = color || CYAN;
      c.shadowBlur = this.vs(12);
      c.beginPath();
      c.moveTo(this.vx(x - w / 2), this.vy(y));
      c.lineTo(this.vx(x + w / 2), this.vy(y));
      c.stroke();
      c.fillStyle = color || CYAN;
      for (const sx of [x - w / 2, x + w / 2]) {
        c.beginPath();
        const d = this.vs(5);
        c.moveTo(this.vx(sx), this.vy(y) - d);
        c.lineTo(this.vx(sx) + d, this.vy(y));
        c.lineTo(this.vx(sx), this.vy(y) + d);
        c.lineTo(this.vx(sx) - d, this.vy(y));
        c.fill();
      }
      c.restore();
    }

    /** The perspective grid the whole genre is built on. */
    gridFloor(g, yHorizon, alpha) {
      const c = this.ctx;
      c.save();
      c.globalAlpha = alpha === undefined ? 0.5 : alpha;
      c.strokeStyle = VIOLET;
      c.lineWidth = Math.max(1, this.vs(1.2));
      c.shadowColor = VIOLET;
      c.shadowBlur = this.vs(6);
      const hy = this.vy(yHorizon);
      const bottom = this.h;
      // verticals converging on the vanishing point
      for (let i = -14; i <= 14; i++) {
        c.beginPath();
        c.moveTo(this.vx(0), hy);
        c.lineTo(this.vx(i * 110), bottom);
        c.stroke();
      }
      // horizontals, scrolling toward the viewer
      const t = (g.time * 0.35) % 1;
      for (let i = 0; i < 12; i++) {
        const f = (i + t) / 12;
        const ly = hy + (bottom - hy) * f * f;
        c.globalAlpha = (alpha === undefined ? 0.5 : alpha) * (0.25 + f * 0.75);
        c.beginPath();
        c.moveTo(0, ly);
        c.lineTo(this.w, ly);
        c.stroke();
      }
      c.restore();
    }

    /** A scanline sweeping down the screen, as if a CRT were refreshing. */
    sweep(g, alpha) {
      const c = this.ctx;
      const t = (g.time * 0.22) % 1.6;
      if (t > 1) return;
      const y = t * this.h;
      const grad = c.createLinearGradient(0, y - this.vs(70), 0, y + this.vs(20));
      grad.addColorStop(0, 'rgba(57,230,255,0)');
      grad.addColorStop(0.8, 'rgba(57,230,255,' + (0.10 * (alpha === undefined ? 1 : alpha)) + ')');
      grad.addColorStop(1, 'rgba(57,230,255,0)');
      c.save();
      c.fillStyle = grad;
      c.fillRect(0, y - this.vs(70), this.w, this.vs(90));
      c.restore();
    }

    /** Key cap, for the controls card. */
    keycap(txt, x, y, size) {
      const c = this.ctx;
      c.save();
      c.font = '700 ' + this.vs(size * 0.62) + 'px "Orbitron", system-ui, sans-serif';
      const w = c.measureText(txt).width / this.k + size * 0.85;
      const h = size * 1.15;
      this.panel(x + w / 2, y, w, h, CYAN, 0.35);
      c.font = '700 ' + this.vs(size * 0.62) + 'px "Orbitron", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = WHITE;
      c.shadowColor = CYAN;
      c.shadowBlur = this.vs(6);
      c.fillText(txt, this.vx(x + w / 2), this.vy(y));
      c.restore();
      return w;
    }

    /* The screen the menus are pretending to be on.

       Scanlines across the whole frame rather than only inside a panel, a
       phosphor tint, a soft edge falloff and a slow horizontal roll. Cheap, and
       it is what ties the panels, the chrome headline and the grid floor
       together into one object instead of three effects sharing a canvas. */
    crt(g, strength) {
      const c = this.ctx;
      const k = strength === undefined ? 1 : strength;
      c.save();
      // scanlines
      c.fillStyle = 'rgba(0,0,0,' + (0.20 * k) + ')';
      const step = Math.max(2, Math.round(this.vs(3)));
      for (let y = 0; y < this.h; y += step) c.fillRect(0, y, this.w, 1);
      // a bright band rolling slowly down the tube
      const roll = ((g.time * 0.08) % 1.4) * this.h - this.h * 0.2;
      const gr = c.createLinearGradient(0, roll - this.vs(90), 0, roll + this.vs(90));
      gr.addColorStop(0, 'rgba(120,220,255,0)');
      gr.addColorStop(0.5, 'rgba(120,220,255,' + (0.035 * k) + ')');
      gr.addColorStop(1, 'rgba(120,220,255,0)');
      c.fillStyle = gr;
      c.fillRect(0, roll - this.vs(90), this.w, this.vs(180));
      // corner falloff, so the picture sits inside a tube
      const rad = c.createRadialGradient(
        this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.30,
        this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.72);
      rad.addColorStop(0, 'rgba(0,0,0,0)');
      rad.addColorStop(1, 'rgba(2,0,10,' + (0.55 * k) + ')');
      c.fillStyle = rad;
      c.fillRect(0, 0, this.w, this.h);
      c.restore();
    }

    scrim(a) {
      const c = this.ctx;
      c.save();
      c.fillStyle = 'rgba(6,0,18,' + a + ')';
      c.fillRect(0, 0, this.w, this.h);
      c.restore();
    }

    // ------------------------------------------------------------- draw --
    draw(g, dt) {
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.w, this.h);

      /* HOW LONG THIS SCREEN HAS BEEN UP.
       *
       * Everything modal in here animates in, and every one of them wants the
       * same number: seconds since the state last changed. Deriving it from
       * the state machine rather than asking each screen to keep its own means
       * a card cannot be shown without its entrance, and two cards cannot
       * disagree about how long an entrance takes.
       *
       * It is also what makes ESC into the pause screen feel like an event
       * rather than a cut - the panel arrives, the rows stagger in behind it,
       * and the whole thing is over in a third of a second. */
      if (g.state !== this._lastState) {
        const from = this._lastState;
        this._lastState = g.state;
        this.stateT = 0;
        // ...and both selection bars re-seek rather than sliding in from
        // wherever the previous screen happened to leave them
        this.selY = null;
        this.menuSelY = null;

        /* THE INSTRUMENT REVEAL, ON ONE CLOCK FOR EVERY MODE.
         *
         * It used to be driven off `g.raceTime`, which is a GAMEPLAY clock,
         * and every way into a race means something different by it. Story
         * Mode zeroes it at the lights; Free Roam zeroes it; a resumed tour
         * restores the saved elapsed time and so began already revealed; a
         * Chapter 7 rewind deliberately keeps it running; and the chapter
         * directors that hand control back after a cinematic never touch it
         * at all. Six callers, six answers, one animation.
         *
         * An entrance should not read a gameplay clock. This is its own, it is
         * reset by the state machine rather than by each mode, and there is
         * exactly one of it - so every way into a race now reveals identically
         * because there is nowhere left for them to differ.
         *
         * A pause is not a start. Coming back from PAUSED or from a
         * confirmation resumes a race whose instruments are already up, and
         * replaying the entrance there would be the interface announcing
         * itself for no reason. */
        const resumed = from === 'paused' || from === 'confirm' || from === 'finished';
        if (g.state === 'countdown' || (g.state === 'racing' && !resumed)) {
          this.reveal = 0;
        } else if (g.state === 'racing') {
          this.reveal = 1;
        }
      }
      this.stateT = (this.stateT || 0) + (dt || 0);
      if (g.state === 'racing') {
        this.reveal = Math.min(1, (this.reveal === undefined ? 1 : this.reveal)
          + (dt || 0) / HUD_REVEAL);
      }
      this._dt = dt || 0.016;
      this.time = g.time;
      const IN = 0.30;
      this.enter = Math.min(1, this.stateT / IN);

      switch (g.state) {
        case 'loading': this.drawLoading(g); this.crt(g, 1); break;
        case 'menu': this.drawMenu(g); this.crt(g, 1); break;
        case 'controls': this.drawControlsScreen(g); this.crt(g, 1); break;
        case 'startcard': this.drawHud(g); this.drawStartCard(g); break;
        /* THE LIGHTS ARE THE EVENT.
           The instruments are held back to a ghost while the countdown runs
           and come up over three quarters of a second once the race is live.
           It is done by multiplying the finished HUD's alpha rather than by
           threading an opacity through forty draw calls - `destination-in`
           with a flat fill scales what is already on the canvas, and the
           canvas at this point is the HUD and nothing else. */
        /* The instruments FADE IN to a ghost while the lights run, on the
           same curve and over the same fifth of a second the DOM panels in
           Story Mode arrive on - they used to snap to the ghost on the first
           frame of the countdown, which is the one entrance in the game that
           was a cut. */
        case 'countdown': {
          this.drawHud(g);
          const inK = ease(Math.min(1, this.stateT / 0.42));
          this.veil(HUD_GHOST * inK);
          this.drawCountdown(g);
          break;
        }
        case 'racing': {
          this.drawHud(g);
          /* Eased OUT, not in. This was `up * up` - a quadratic ease-IN - so
             the instruments hung at a quarter opacity and then rushed the
             last of it, while every DOM panel in the game arrives on an
             ease-out. Two halves of one interface with opposite curves is
             precisely the inconsistency this is fixing. */
          const up = this.reveal === undefined ? 1 : this.reveal;
          if (up < 1) this.veil(HUD_GHOST + (1 - HUD_GHOST) * ease(up));
          break;
        }
        /* A modal replaces the instruments; it does not sit on top of them.
           Drawing both left the speedometer, the score, the clock and the
           DRIVETRAIN panel showing round the edges of the finish card at a quarter
           opacity - close enough to read, far enough from anything to look
           like a mistake, and the reason the card felt like it was overlapping
           something rather than being the screen. */
        case 'confirm': this.drawConfirm(g, dt); this.crt(g, 0.8); break;
        case 'paused': this.drawPause(g, dt); this.crt(g, 0.8); break;
        case 'finished': this.drawFinish(g); this.crt(g, 0.8); break;
        default: break;
      }
      /* A NOTIFICATION IS PART OF THE RACE, NOT PART OF THE MENU.
       *
       * The stack sits at y 176 and the pause card's title is at 186, so a
       * toast still in flight when ESC lands - which is exactly what happens
       * after a crash, because IMPACT and the pause are half a second apart -
       * was drawn straight through PAUSED. Same on the finish card and the
       * controls card, both of which cover that band.
       *
       * They still AGE while a modal is up, so they expire behind it and are
       * gone by the time the race comes back rather than resuming
       * mid-animation on a screen they no longer belong to. */
      const modal = g.state === 'paused' || g.state === 'finished'
        || g.state === 'startcard' || g.state === 'confirm';
      this.drawToasts(dt, !modal, g.state);
      if (g.fade > 0.001) this.scrim(Math.min(1, g.fade));
      /* LAST, AND OVER EVERYTHING INCLUDING THE FADE. A counter that is hidden
         by the thing being measured is a counter nobody can use during the one
         moment it matters - a transition is exactly where frames are dropped. */
      if (g.showFps) this.drawFps(g);
    }

    /* THE FRAME COUNTER.
     *
     * Two numbers, because the average alone hides the thing it is read to
     * find: 90 FPS with one 40 ms hitch in it is not a smooth second, and it
     * reports as 90. `MIN` is the slowest frame of the last half second, which
     * is the one the player actually felt.
     *
     * Top-left, small, and outside every other widget's box - the HUD's own
     * instruments live along the bottom and down the right, and the corner it
     * uses is the one nothing else has claimed. Colour is the reading rather
     * than decoration: green while it is holding, amber under 50, red under
     * 30. A number that changes colour can be read without being read.
     */
    drawFps(g) {
      const F = g.fps;
      if (!F || !F.now) return;
      const hue = (v) => (v >= 50 ? '#91ff31' : v >= 30 ? '#ffb400' : '#ff3b1e');
      const now = Math.round(F.now), low = Math.round(F.worst);
      const c = this.ctx;
      c.save();
      // a plate under it, or a bright number over a bright road is unreadable
      c.globalAlpha = 0.55;
      c.fillStyle = '#05010f';
      /* TOP LEFT. The virtual space is 1280x720 about its own centre with y
         UP, so this corner is (-640, +360) - and it is the one corner nothing
         else in this file draws in. The instruments are along the bottom and
         down the right; the story cards come in from the middle. */
      c.fillRect(this.vx(-628), this.vy(344), this.vs(150), this.vs(46));
      c.restore();
      this.label(now + ' FPS', -620, 330, 20, hue(now), 'left', 900);
      this.label('MIN ' + low, -620, 310, 13, hue(low), 'left', 700, 0.85);
    }

    drawLoading(g) {
      const c = this.ctx;
      c.save();
      c.fillStyle = '#05010f';
      c.fillRect(0, 0, this.w, this.h);
      c.restore();
      this.chrome('SYNX', 0, 78, 62, PINK);
      this.neon('S Y N T H W A V E   e X T R E M E   R A C I N G', 0, 22, 18, CYAN, 'center', 900);
      this.label('LOADING', 0, -40, 18, CYAN, 'center', 700,
        0.5 + 0.5 * Math.sin(g.time * 5));
      const pw = 360;
      const c2 = this.ctx;
      c2.save();
      c2.strokeStyle = 'rgba(140,90,220,0.6)';
      c2.lineWidth = Math.max(1, this.vs(1.5));
      c2.strokeRect(this.vx(-pw / 2), this.vy(-90), this.vs(pw), this.vs(10));
      c2.fillStyle = PINK;
      c2.shadowColor = PINK;
      c2.shadowBlur = this.vs(12);
      c2.fillRect(this.vx(-pw / 2) + 1, this.vy(-90) + 1,
        (this.vs(pw) - 2) * (g.loadProgress || 0), this.vs(10) - 2);
      c2.restore();
      this.digits(Math.round((g.loadProgress || 0) * 100) + '%', 0, -130, 26, 'center');
    }

    // ---------------------------------------------------------- menu -----
    drawMenu(g) {
      const c = this.ctx;
      /* THE TITLE SCREEN ASSEMBLES OUT OF THE OPENING SHOT.

         `introReveal` runs 0 to 1 across the last third of the camera move -
         see introCamera in js/game.js - and everything the menu draws is
         behind it. Alpha only, deliberately: the layout is hit-tested by
         Game.menuItemAt against fixed coordinates, and a reveal that also
         moved the rows would put the pointer and the labels in different
         places for the second and a half nobody would think to test. */
      const reveal = g.introReveal === undefined ? 1 : g.introReveal;
      /* Only an ACTIVELY RUNNING move may hide the title screen. A reveal
         stuck at zero for any other reason - a move that was started and
         never stepped, which is exactly what a mis-placed hook did once -
         must not be able to leave the menu invisible and unusable. */
      if (reveal <= 0.001 && g.intro) return;
      if (reveal < 1) { c.save(); c.globalAlpha = reveal; }

      // a horizon grid under the title, the genre's signature
      this.gridFloor(g, -120, 0.30);

      // title block
      // GUI_Title.png is a packed atlas (C64 loading screen, colour bars,
      // "BUY THE ALBUMS"), not a logo - drawing the sheet covered the game.
      const bob = Math.sin(g.time * 1.6) * 4;
      /* WHERE THE WORDMARK SITS, AND WHY IT IS NOT HIGHER.
         SYNX is drawn from the middle of the glyphs at 96 units, so it owns
         about thirty-five either side of this line. It used to sit at 210,
         which left the band between it and the top of the frame too shallow
         for a notification - and a notification therefore landed ON it, which
         is exactly what SETTINGS SAVED and PROGRESS SAVED were doing. Sixteen
         units of headroom is the difference between the two things sharing a
         line and the two things being stacked. See drawToasts. */
      const titleY = 196;
      const subtitleY = 122;
      /* The rows are centred as a block rather than pinned to a fixed top, so
         adding QUIT did not push the best-time readout into the footer. The
         numbers live in NR.MENU_LAYOUT because Game.menuItemAt has to hit-test
         exactly what is drawn here, and two copies of a layout drift. */
      const menuGap = ML.gap;
      const menuTop = ML.topFor(g.menuItems.length);
      this.chrome('SYNX', 0, titleY + bob, 96, PINK);
      this.neon('S Y N T H W A V E   e X T R E M E   R A C I N G', 0, subtitleY + bob, 18, CYAN, 'center', 900);
      /* Clear of the first row's selection brackets, which reach 93. At 92
         the rule was drawn straight through the top edge of START's frame
         whenever START was the selected row - which is every time the title
         screen is opened. */
      this.rule(0, 101, 470, VIOLET, 0.85);

      // menu items, bracketed and glowing when selected
      const items = g.menuItems;
      /* ONE BAR, WHICH MOVES.
         Drawing the highlight under whichever row is current means it does not
         travel - it vanishes and reappears somewhere else, and the eye has to
         re-find it on every keystroke. Damping it toward the selected row
         turns five labels into a control. Same reasoning, same code, as the
         pause and finish lists: see menuList. */
      const selTarget = menuTop - g.menuIndex * menuGap;
      if (this.menuSelY === undefined || this.menuSelY === null) this.menuSelY = selTarget;
      this.menuSelY += (selTarget - this.menuSelY) * Math.min(1, (this._dt || 0.016) * 20);
      const pulse = 0.55 + 0.45 * Math.sin(g.time * 4);
      this.panel(0, this.menuSelY, 400, 66, PINK, 0.28);
      this.brackets(0, this.menuSelY, 430, 78, AMBER, 20, pulse);

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const y = menuTop - i * menuGap;
        const shown = it.label.slice(0, Math.max(0, Math.floor(it.typed)));
        const sel = i === g.menuIndex;
        const caret = it.typed < it.label.length && (g.time * 3 % 1) < 0.5 ? '_' : '';
        this.neon(shown + caret, 0, y, 44, sel ? AMBER : WHITE, 'center', sel ? 900 : 700,
          sel ? 1 : 0.72);
      }

      // best time, as an instrument readout
      const by = menuTop - items.length * menuGap - 8;
      if (g.record != null) {
        this.panel(0, by, 300, 46, CYAN, 0.5);
        this.label('BEST', -108, by, 17, CYAN, 'center', 700);
        this.digits(fmtTime(g.record), 30, by, 30, 'center');
      }

      this.label('START  STORY MODE + FREE ROAM      ARROWS  SELECT      ENTER  CONFIRM',
        0, -330, 13, INK.mute, 'center', 500);

      const frameW = Math.min(1230, this.vw - 30);
      const frameH = Math.min(690, this.vh - 30);
      this.brackets(0, 0, frameW, frameH, 'rgba(139,92,246,0.55)', 34, 0.8);
      this.sweep(g, 1);
      if (reveal < 1) c.restore();
    }

    // ------------------------------------------------------------ HUD ----
    // Every position, size and pivot below comes from data/game_data.js `hud`,
    // which build_gamedata.py walks out of the shipped NGUI widget tree. The
    // numbers were previously transcribed by hand without the parents' scales
    // or the HUD panel's TweenPosition offset, which put the whole interface
    // ~200 units below the screen.
    drawHud(g) {
      const car = g.car;

      /* WHAT THE HANDOVER CARD IS STANDING ON.
       *
       * A Free Roam tour puts a 540-unit card across the middle of the frame
       * for five seconds at every region boundary, and the rival readout - the
       * position, the gap and its rail - lives at y 226..295 on the left
       * flank. The card spans 162..266, so for those five seconds the one
       * number the player is actually watching had a translucent panel and the
       * words NEON HORIZON drawn through it.
       *
       * Neither is in the wrong place. The card is the most important thing on
       * screen while it is up and the instruments are the most important thing
       * the rest of the time, so the instruments step back for it and come
       * straight back afterwards - which is what a director would do with the
       * same two pieces of information. */
      let quiet = 1;
      if (g.freeRoam && g.freeRoamBanner) {
        const b = g.freeRoamBanner, LIFE = 5.4;
        const a = Math.min(Math.min(1, b.t * 2.6), Math.max(0, LIFE - b.t));
        quiet = 1 - Math.max(0, Math.min(1, a)) * 0.76;
      }

      // speedometer: the 'speed' dial, its fill clipped by road speed
      this.placeSprite('SpeedMeterBG', 0, 0.55);
      /* The dial has to sweep against the top speed in the unit it is showing.
         It used to divide MPH by 290 - the car's top speed in km/h - so the
         needle only ever reached two thirds of the way round even flat out. */
      const top = g.useMetric ? 215 : 134;
      const shown = g.useMetric ? car.speedKmh : car.speedMph;
      this.placeSprite('SpeedMeter', 0, 1, Math.max(0, Math.min(1, shown / top)));
      const spd = Math.round(g.useMetric ? car.speedKmh : car.speedMph);
      this.placeDigits('txt_speed_bg', '888', 0, 0.12);
      // the readout heats up as the car nears its limit, and flares on boost
      // the readout heats up over the last third of the range
      const heat = Math.max(0, Math.min(1, (car.speedMph / 134 - 0.55) / 0.45));
      const tint = g.raceModeActive ? '#45d7ff' : car.boosting ? '#ff4bd8'
        : (heat > 0.02 ? mixHex('#ffb400', '#ff3b3b', heat) : null);
      this.placeDigits('txt_speed', String(spd), 0, undefined, tint);
      if (!this.placeSprite('MPH')) {
        this.placeDigits('txt_mph', g.useMetric ? 'KM/H' : 'MPH', 0, 1, PINK);
      }

      // timer
      this.catScope(g);
      this.placeDigits('txt_timer_bg', '88:88:88', 0, 0.12, undefined, 10);
      this.placeDigits('txt_timer', fmtTime(g.raceTime), 0, undefined, undefined, 10);
      const tt = this.wgt('txt_time');
      if (tt) {
        // the label sat hard against the first digit; back it off its own width
        const p = this.centre(tt);
        this.label('TIME', p.x - 14, p.y, tt.h * 0.9, CYAN, 'center', 600);
      }

      // boost meter
      const pulse = car.boosting ? 0.75 + 0.25 * Math.sin(g.time * 26) : 1;
      if (g.raceModeBlueFuel) this.placeSpriteTinted('Overlay',0,(car.boosting?1:.92)*pulse,car.boost,'#008cff');
      else this.placeSprite('Overlay', 0, (car.boosting ? 1 : 0.9) * pulse, car.boost);
      if(g.raceModeBlueFuel)this.placeSpriteTinted('BoostBar',0,1,1,'#078cff');
      else this.placeSprite('BoostBar');
      if(g.raceModeBlueFuel)this.placeSpriteTinted('Sprite',0,car.boosting?pulse:.72,1,'#64eaff');
      else this.placeSprite('Sprite', 0, car.boosting ? pulse : 0.5);
      // a bracket around the meter that lights up when there is boost to spend
      const bw = this.wgt('BoostBar');
      if (bw) {
        const bp = this.centre(bw);
        if (g.raceModeBlueFuel) {
          // The shipped atlas bakes its normal fuel segments red. Draw the
          // synchronized reservoir last as real cyan segments so no red atlas
          // layer can cover or colour-contaminate the raceMode fuel.
          const c=this.ctx,n=18,fullW=this.vs(bw.w*.88),barH=this.vs(Math.max(8,bw.h*.34));
          const left=this.vx(bp.x)-fullW*.5,top=this.vy(bp.y)-barH*.5,gap=this.vs(2.4),seg=(fullW-gap*(n-1))/n;
          c.save();c.fillStyle='rgba(2,27,55,.94)';c.fillRect(left,top,fullW,barH);
          c.shadowColor='#00aaff';c.shadowBlur=this.vs(12);
          const live=Math.ceil(Math.max(0,Math.min(1,car.boost))*n);
          for(let i=0;i<n;i++){c.fillStyle=i<live?(i>n*.72?'#6eeaff':'#078cff'):'rgba(18,74,112,.52)';c.fillRect(left+i*(seg+gap),top,seg,barH);}
          c.restore();
          this.brackets(bp.x, bp.y, bw.w + 34, bw.h + 24, '#38bfff', 16, .88);
          this.label('BLUE RESERVE', bp.x, bp.y + bw.h * .5 + 16, 10,
            '#75e8ff', 'center', 800, .92);
        } else if (car.boosting) this.brackets(bp.x, bp.y, bw.w + 26, bw.h + 18, PINK, 14, pulse);
        else if (car.boostLocked) {
          /* Spent. The reservoir latches when it empties and will not fire
             again until there is a burn's worth back in it, so the bar has to
             read as CHARGING rather than as a boost that has stopped working. */
          const arm = 0.34, f = Math.max(0, Math.min(1, car.boost / arm));
          this.brackets(bp.x, bp.y, bw.w + 26, bw.h + 18, '#ff8a3a', 14,
            0.30 + 0.30 * Math.sin(g.time * 6));
          this.label('CHARGING  ' + Math.round(f * 100) + '%',
            bp.x, bp.y + bw.h * 0.5 + 16, 10, '#ffb46a', 'center', 800, 0.9);
        } else if (car.boost > 0.98) {
          this.brackets(bp.x, bp.y, bw.w + 26, bw.h + 18, CYAN, 14,
            0.25 + 0.25 * Math.sin(g.time * 3));
        }
      }

      // Race flags and the record readout. This is a time trial, so the
      // record is what shows between them.
      this.placeSprite('Flag', 0, 0.85);
      this.placeSprite('Flag', 1, 0.85);
      const recW = this.wgt('txt_record');
      if (recW && recW.active) {
        /* A route nobody has finished has no record, and printing 00:00:00 for
           it is worse than printing nothing: it is a real time, it is between
           the two chequered flags where a record goes, and it says the player
           has already driven this in no seconds. Dashes say "not set", which
           is what every clock in the game says for a time it does not have. */
        this.placeDigits('txt_record',
          g.record != null ? fmtTime(g.record) : '--:--:--');
      }

      /* The gear and the rev counter live in the DRIVETRAIN panel, which is
         the instrument that is already reading the gearbox. They were here as
         well - the same number, twice, in two sizes, in two corners. */

      /* Position and gap to the rival. The number that matters in a race is
         not the clock, it is how far away the other car is - so it is the
         biggest thing on this side of the screen and it changes colour the
         moment the lead does. */
      if (g.rival && !g.soloRun && (g.state === 'racing' || g.state === 'countdown')) {
        const racePlace = g.storyRaceTotal > 2 ? g.storyRacePlace : g.place;
        const raceTotal = g.storyRaceTotal > 2 ? g.storyRaceTotal : 2;
        const lead = racePlace === 1;
        const col = lead ? '#54ff4b' : PINK;
        const gapUnits = raceTotal > 2 ? (g.storyLeaderGap || 0) : Math.abs(g.rivalGap || 0);
        const gap = gapUnits * 0.733;   // world units to metres
        /* THE LEFT FLANK, not the middle.
           This group used to start at x=-250, which put its gap figure and the
           right half of its rail underneath the toast stack - and a toast is
           drawn centred and opaque, so DRIFT +400 landed on top of the one
           number the player is actually watching. It sits out at RIVAL_X now,
           clear of the widest toast the clamp in drawToasts allows, and still
           inboard of the chapter card on this flank. */
        const RX = RIVAL_X;
        this.label(raceTotal > 2 ? 'POSITION // 4 CARS' : 'RIVAL', RX, 282, 13, INK.mute, 'left', 700, quiet);
        const suffix = racePlace === 1 ? 'st' : (racePlace === 2 ? 'nd' : (racePlace === 3 ? 'rd' : 'th'));
        this.neon(String(racePlace) + suffix, RX, 252, 30, col, 'left', 900, quiet);
        const txt = gap > 999 ? '999+' : gap.toFixed(0);
        this.label((lead ? '+' : '-') + txt + ' M', RX + 75, 252, 17,
          INK.body, 'left', 700, quiet);
        // a rail showing the two cars' relative positions
        const c = this.ctx;
        c.save();
        c.globalAlpha = quiet;
        const bw = RIVAL_W, bx = RX, by = 226;
        c.fillStyle = INK.faint;
        c.fillRect(this.vx(bx), this.vy(by), this.vs(bw), this.vs(3));
        const f = Math.max(-1, Math.min(1, (g.rivalGap || 0) / 200));
        const mid = bx + bw * 0.5;
        c.fillStyle = col; c.shadowColor = col; c.shadowBlur = this.vs(7);
        c.fillRect(this.vx(mid + f * bw * 0.5) - this.vs(2), this.vy(by + 4),
          this.vs(4), this.vs(11));
        c.restore();
      }

      /* raceMode, WHEREVER IT IS SPENT.
       *
       * Three different modes hand the player the same ability - Chapter 6
       * awards it, Chapter 7 fields it against the R-IX, a Free Roam tour
       * carries it - and each of them used to draw its own meter. Two were DOM
       * panels on the right flank at different heights with different colours
       * and different wording ("READY // PRESS R" against "raceMode  R"), and
       * the third was this. The ability is identical in all three; the readout
       * had no business not being.
       *
       * `Game.raceMode` is the one state object now (see Game.syncRaceMode),
       * and this is the one widget. It sits in the slot the chapter panels
       * used, so nothing else on the flank had to move. */
      const rm = g.raceMode;
      if (rm && rm.available && (g.state === 'racing' || g.state === 'countdown')) {
        const rx = 570, ry = 176;
        const ready = !rm.active && rm.cooldown <= 0;
        const col = rm.active ? '#45d7ff' : (ready ? '#5affc0' : INK.mute);
        const label = rm.active ? 'raceMode  //  ' + rm.timer.toFixed(1) + 's'
          : (ready ? 'raceMode  //  R' : 'raceMode  //  ' + Math.ceil(rm.cooldown) + 's');
        /* One bar, three meanings, and it always fills toward the right:
           ACTIVE counts the window down, COOLDOWN counts the wait back up,
           READY is full. A meter that emptied for one and filled for another
           is a meter the player has to think about. */
        const f = rm.active ? Math.max(0, rm.timer / Math.max(1, rm.window))
          : (ready ? 1 : 1 - rm.cooldown / Math.max(1, rm.rest));
        const pulse = ready ? 0.72 + 0.28 * Math.sin(g.time * 4) : 1;
        this.label(rm.active ? 'SYNCHRONIZED' : ready ? 'READY' : 'CHARGING',
          rx, ry + 26, T.micro, INK.mute, 'right', 800, quiet * 0.9);
        this.label(label, rx, ry, 15, col, 'right', 900, pulse * quiet);
        this.meterBar(rx - 75, ry - 15, 150, f, col, quiet);
        /* ...and the reserve, which only Chapter 6 and 7 hand out. It is a
           second, shorter bar under the first rather than a second widget. */
        if (rm.reserveLive) {
          this.label('BLUE RESERVE', rx - 158, ry - 15, T.micro, '#75e8ff', 'right', 800, quiet * .9);
        }
      }

      // Score and multiplier. Keep this stack beyond the checkpoint rail's
      // right edge. It used to sit at x=250/y=274, directly under the rail and
      // on the same line as its distance label, so the combo read as another
      // checkpoint marker rather than a separate instrument.
      if (g.score > 0 || g.combo > 1) {
        const sx = 570;
        /* THE SCORE COUNTS UP.
           A drift bank pays out in one lump - four hundred points appear
           between one frame and the next - and a number that jumps is a number
           the eye reads as having changed rather than as having been earned.
           Rolling it is the oldest trick there is and it costs one damped
           value; the readout still ARRIVES at the true score, it just takes a
           fifth of a second to get there. */
        const want = g.score | 0;
        if (this.scoreShown === undefined || Math.abs(want - this.scoreShown) > 20000) {
          this.scoreShown = want;
        }
        this.scoreShown += (want - this.scoreShown) * Math.min(1, this._dt * 7);
        if (Math.abs(want - this.scoreShown) < 0.6) this.scoreShown = want;
        this.label('SCORE', sx, 282, 14, INK.mute, 'right', 700, quiet);
        this.digits(String(Math.round(this.scoreShown)), sx, 250, 34, 'right', quiet, AMBER);
        if (g.combo > 1) {
          const p = 0.7 + 0.3 * Math.sin(g.time * 7);
          this.neon('x' + g.combo, sx, 216, 26, PINK, 'right', 900, p * quiet);
        }
      }

      /* BODY INTEGRITY.
       *
       * The car now carries damage, and damage the player cannot see the state
       * of is damage they cannot decide anything about. It only appears once
       * there is something to report, it sits under the drivetrain panel on
       * the left flank where nothing else is drawn, and it is a bar rather
       * than a number because the only question it answers is "how bad".
       *
       * IT COSTS SOMETHING NOW, and so it says what. A bent body is extra
       * drag and a weaker reheat in the solver (see Vehicle::damage), which is
       * a loss of TOP END and almost nothing out of a corner - so the readout
       * is the top-end figure, live, rather than a warning light. A penalty
       * the player can feel but cannot read is indistinguishable from the car
       * handling badly, and that is the version of this they would blame on
       * the game.
       *
       * The arithmetic is the solver's own, inverted: terminal speed goes as
       * the square root of thrust over drag, so a drag multiplier of
       * (1 + 0.42d) costs 1 - 1/sqrt(1 + 0.42d) of it. Sixteen per cent at a
       * completely wrecked body. See js/damage.js. */
      if (g.damage && g.damage.total > 0.02 &&
          (g.state === 'racing' || g.state === 'countdown')) {
        const d = Math.min(1, g.damage.total);
        /* Directly above the DRIVETRAIN panel and on its own column, which
           is the one band of the left flank nothing else uses: the drivetrain
           readout runs -299..-245, the clock sits under that at -328, and the
           drift meter is a hundred units inboard. Anything lower lands on the
           clock; anything further right lands on the drift bank. */
        const bx = -444, by = -216;
        const col = d > 0.66 ? PINK : (d > 0.33 ? AMBER : CYAN);
        this.label('BODY', bx - 100, by + 16, 11, INK.mute, 'left', 700, 0.85);
        this.meterBar(bx, by, 200, 1 - d, col, 0.9);
        /* What it is costing, in the only currency this game has. Below about
           a tenth it rounds to nothing and saying "-0%" is worse than saying
           nothing at all. */
        const loss = Math.round((1 - 1 / Math.sqrt(1 + 0.42 * d)) * 100);
        if (loss >= 1) {
          this.label('-' + loss + '% TOP END', bx + 100, by + 16, 10, col, 'right', 800,
            d > 0.66 ? 0.55 + 0.45 * Math.sin(g.time * 5) : 0.8);
        }
      }

      /* THE AUTOSAVE MARK.
         It is deliberately the smallest thing on the screen: what the player
         needs to know is that it happened, not to be told about it. Two
         seconds, on the rail the progress bar already owns, in the same green
         the tour's own confirmations use. */
      if (g.autosave && g.autosave.notify > 0 &&
          (g.state === 'racing' || g.state === 'countdown')) {
        const a = Math.min(1, g.autosave.notify / 0.5);
        this.label('SAVED', -452, 300, T.micro, '#5affc0', 'left', 800, a * 0.85);
      }

      // Run progress: a thin rail across the top with a marker for the car.
      // A 22 km course needs some sense of how much of it is left.
      if (g.state === 'racing' || g.state === 'countdown') {
        const c = this.ctx;
        const w = 900, y = 318;
        const f = Math.max(0, Math.min(1, g.progress || 0));
        c.save();
        c.fillStyle = INK.faint;
        c.fillRect(this.vx(-w / 2), this.vy(y), this.vs(w), this.vs(3));
        c.fillStyle = CYAN;
        c.shadowColor = CYAN;
        c.shadowBlur = this.vs(8);
        c.fillRect(this.vx(-w / 2), this.vy(y), this.vs(w) * f, this.vs(3));
        /* Checkpoint ticks - or, on a Free Roam tour, the six handovers
           between the seven regions. Fifths of a hundred and twenty-seven
           kilometres mean nothing to anybody; the country changing does, and
           it is what a player on this rail is counting down to. */
        c.fillStyle = 'rgba(255,255,255,0.35)';
        if (g.freeRoam && g.regionEdges) {
          const span = Math.max(1, g.finishAt - g.startAt);
          for (let i = 1; i < g.regionEdges.length; i++) {
            const q = (g.regionEdges[i] - g.startAt) / span;
            if (q <= 0.004 || q >= 0.996) continue;
            c.fillRect(this.vx(-w / 2 + w * q) - this.vs(1), this.vy(y + 3),
              this.vs(2), this.vs(9));
          }
        } else {
          for (let i = 1; i < 5; i++) {
            c.fillRect(this.vx(-w / 2 + w * i / 5) - this.vs(1), this.vy(y + 3),
              this.vs(2), this.vs(9));
          }
        }
        c.fillStyle = PINK;
        c.shadowColor = PINK;
        c.beginPath();
        const mx = this.vx(-w / 2 + w * f), my = this.vy(y + 1.5);
        c.moveTo(mx, my - this.vs(7));
        c.lineTo(mx + this.vs(6), my);
        c.lineTo(mx, my + this.vs(7));
        c.lineTo(mx - this.vs(6), my);
        c.fill();
        c.restore();
        const left = Math.max(0, (g.finishAt - g.distance)) * 0.733 / 1000;
        this.label(left.toFixed(2) + ' KM TO GO', w / 2, y - 18, 13,
          INK.mute, 'right', 600);
        if (g.freeRoam && g.level) {
          this.label('FREE ROAM  //  ' + g.level.name, -w / 2, y - 18, 13,
            INK.mute, 'left', 600);
        }
      }

      /* The handover card. A Free Roam tour crosses six borders and the
         picture has already finished changing by the time it reaches one, so
         the only thing left to say is where the player now is - said once,
         high enough to clear both shoulder readouts, and gone. */
      if (g.freeRoam && g.freeRoamBanner &&
          (g.state === 'racing' || g.state === 'countdown')) {
        const b = g.freeRoamBanner;
        const LIFE = 5.4;
        const a = Math.min(Math.min(1, b.t * 2.6), Math.max(0, LIFE - b.t));
        if (a > 0.01) {
          this.panel(0, 214, 540, 104, CYAN, 0.44 * a);
          this.label(b.kicker, 0, 248, 13, 'rgba(160,220,255,' + (0.78 * a).toFixed(3) + ')',
            'center', 800);
          this.neon(b.title, 0, 212, 34, AMBER, 'center', 900, a);
          this.label(b.note, 0, 182, 12, 'rgba(200,235,255,' + (0.62 * a).toFixed(3) + ')',
            'center', 600);
        }
      }

      /* Drift meter: only present while the rear is actually sliding, so it
         never clutters a clean lap.

         Off to the left, not in the middle. Dead centre and a hundred and
         fifty units down is exactly where the chase camera puts the car, so
         the word DRIFT was printed across the roof of the thing the player is
         watching - at the one moment in the game when they most need to see
         it. */
      if (car.driftAmount > 0.04) {
        const a = Math.min(1, car.driftAmount * 1.6);
        const x = -296, y = -118;
        this.neon('DRIFT', x, y, 24, PINK, 'center', 900, a);
        // the angle it is actually carrying, which is the thing being scored
        const deg = Math.abs(car.bodySlip || 0) * 57.2958;
        this.label(deg.toFixed(0) + '°', x, y - 26, 15,
          'rgba(255,180,215,0.85)', 'center', 700, a);
        const c = this.ctx;
        c.save();
        c.globalAlpha = a;
        c.fillStyle = PINK;
        c.shadowColor = PINK;
        c.shadowBlur = this.vs(10);
        const n = Math.round(car.driftAmount * 7);
        for (let i = 0; i < n; i++) {
          const cx = x + (i - (n - 1) / 2) * 24;
          c.beginPath();
          c.moveTo(this.vx(cx - 8), this.vy(y - 52));
          c.lineTo(this.vx(cx), this.vy(y - 42));
          c.lineTo(this.vx(cx + 8), this.vy(y - 52));
          c.lineTo(this.vx(cx), this.vy(y - 48));
          c.fill();
        }
        c.restore();
        // and the bank it is building, which pays out when the slide lands
        if (g.driftBank > 40) {
          this.digits('+' + Math.round(g.driftBank * g.combo), x, y - 78, 22,
            'center', a, CYAN);
        }
      }

      // Off-road warning, framed rather than bare text
      if (car.offroad && g.state === 'racing') {
        const p2 = 0.4 + 0.6 * Math.sin(g.time * 12);
        this.brackets(0, 0, 1180, 640, PINK, 40, p2 * 0.5);
      }

      // Chase meter. Authored inactive in level2 - this is the time trial, so
      // there is no chopper - and drawing it anyway laid a 402-unit segmented
      // bar across the bottom of the screen.
      const chaseW = this.wgt('ChaseBar');
      if (chaseW && chaseW.active && g.chase > 0.001) {
        this.placeSprite('ChaseBar', 0, 0.9);
        const cw = chaseW;
        const cc = this.wgt('ChaseIconCar');
        const ch = this.wgt('ChaseChopper');
        if (cw && cc) this.placeSprite('ChaseIconCar');
        if (cw && ch) {
          const f = Math.max(0, Math.min(1, g.chase));
          const p = this.centre(ch);
          this.spriteAt('chase_chopper', p.x + cw.w * (1 - f), p.y, ch.w, ch.h);
        }
      }

      // No lap-progress bar: the shipped HUD has none, and the one drawn here
      // sat across the top of the screen.
      if (car.offroad && g.state === 'racing') {
        this.neon('OFF ROAD', 0, -232, 24, PINK, 'center', 900,
          0.45 + 0.55 * Math.sin(g.time * 12));
      }
      /* Pointed back down the road. The route behind the car is a wall now, so
         a player who has spun has to be told which way out is - otherwise they
         drive into an invisible one and conclude the game is stuck. */
      if ((car.wrongWay || 0) > 0.55 && g.state === 'racing') {
        const wp = 0.5 + 0.5 * Math.sin(g.time * 9);
        this.neon('WRONG WAY', 0, 96, 34, '#ff7a2a', 'center', 900, 0.55 + 0.45 * wp);
        this.label('TURN AROUND', 0, 60, 13, '#ffc08a', 'center', 800, 0.85);
        this.brackets(0, 0, 1180, 640, '#ff7a2a', 40, wp * 0.35);
      }
    }

    // ------------------------------------------------------- options -----

    /* ====================================================================
     * THE CONTROLLER, DRAWN LIVE.
     *
     * WHY IT IS VECTOR AND NOT A PICTURE.
     *
     * The obvious way to show a pad layout is a high-resolution photograph
     * with callouts around it. That would be wrong here for three reasons, and
     * the third is the one that matters.
     *
     *   It would not be high resolution for long. This interface is drawn on a
     *   canvas that is resized to the window and can be supersampled to twice
     *   native, so a bitmap is either enormous or soft. Paths are exact at
     *   every one of those sizes and cost nothing to ship.
     *
     *   It would not look like this game. Every other panel here is neon line
     *   work on glass. A photographed lump of grey plastic in the middle of it
     *   would read as a screenshot of a different program.
     *
     *   IT WOULD BE DEAD. This one is not a diagram of a controller, it is a
     *   picture of YOUR controller, right now: every stick moves, every button
     *   lights, both triggers fill as they are squeezed. That turns the page
     *   from a reference into a test - which is what a player on this screen
     *   actually wants, because the question in their head is not "what does B
     *   do" but "why is nothing happening". A drifting stick is visible here
     *   in a way no amount of labelling could describe.
     *
     * The geometry is in local units, centred on the origin, and scaled once
     * on the way out - so the whole thing is placed by two numbers and its
     * proportions cannot drift.
     */
    drawPadDiagram(g, cx, cy, scale) {
      const c = this.ctx;
      const pad = g.pad;
      const info = pad ? pad.describe() : { connected: false };
      const B = global.NR.PAD_BUTTONS || {};
      const live = !!(pad && pad.active);

      // local unit -> HUD unit -> canvas pixel, in one step
      const S = (n) => this.vs(n * scale);
      const X = (x) => this.vx(cx + x * scale);
      /* LOCAL +Y POINTS DOWN, and the HUD's points up.
         The geometry above is written the way a drawing is - triggers at the
         top with a negative y - so the flip happens here, once, rather than
         every literal in the path being negated and one of them being missed. */
      const Y = (y) => this.vy(cy - y * scale);

      /* Everything is dimmed when there is nothing attached. The layout is
         still drawn - it is the reference for a pad the player is about to
         plug in - but it must not look like it is reporting state. */
      /* Dimmed when nothing is attached, but only to a half - this is still
         the reference for a pad about to be plugged in, and at a third it was
         a smudge rather than a diagram. */
      const alpha = live ? 1 : 0.55;
      const bodyCol = live ? 'rgba(57,230,255,' : 'rgba(150,180,222,';
      const on = AMBER;

      c.save();
      c.globalAlpha = alpha;

      // ------------------------------------------------------------ body --
      /* Two grips and a waist, as one closed path. Drawn as a silhouette
         rather than an outline of parts so the highlights sit INSIDE
         something, which is most of what makes a line drawing read as an
         object. */
      /* THE SILHOUETTE.
         Wide across the shoulders, a waist that dips between the hands, and
         two grips that hang DOWN and outward. The first version of this had
         no grips at all - the outline closed straight across the bottom - and
         the result read as a bean rather than as a controller. The grips are
         most of what makes the shape recognisable at a glance, which is the
         entire job of a diagram. */
      c.beginPath();
      c.moveTo(X(-118), Y(-26));
      c.bezierCurveTo(X(-130), Y(-8), X(-126), Y(18), X(-110), Y(38));   // left flank
      c.bezierCurveTo(X(-98), Y(62), X(-72), Y(66), X(-60), Y(44));      // left grip
      c.bezierCurveTo(X(-46), Y(26), X(-26), Y(30), X(0), Y(30));        // waist, left half
      c.bezierCurveTo(X(26), Y(30), X(46), Y(26), X(60), Y(44));         // waist, right half
      c.bezierCurveTo(X(72), Y(66), X(98), Y(62), X(110), Y(38));        // right grip
      c.bezierCurveTo(X(126), Y(18), X(130), Y(-8), X(118), Y(-26));     // right flank
      c.bezierCurveTo(X(96), Y(-44), X(40), Y(-48), X(0), Y(-48));       // shoulder, right
      c.bezierCurveTo(X(-40), Y(-48), X(-96), Y(-44), X(-118), Y(-26));  // shoulder, left
      c.closePath();
      const grad = c.createLinearGradient(0, Y(66), 0, Y(-48));
      grad.addColorStop(0, 'rgba(12,4,32,0.92)');
      grad.addColorStop(1, 'rgba(26,10,58,0.92)');
      c.fillStyle = grad;
      c.fill();
      c.strokeStyle = bodyCol + '0.75)';
      c.lineWidth = Math.max(1, S(1.6));
      c.shadowColor = live ? CYAN : 'transparent';
      c.shadowBlur = S(10);
      c.stroke();
      c.shadowBlur = 0;

      // ---------------------------------------------------- the elements --
      /* One helper per shape, so a lit control and an unlit one differ by a
         value rather than by which branch drew them. */
      const ring = (x, y, r, lit, label) => {
        c.beginPath();
        c.arc(X(x), Y(y), S(r), 0, Math.PI * 2);
        c.fillStyle = lit ? 'rgba(255,180,0,0.85)' : 'rgba(120,150,210,0.16)';
        c.fill();
        c.strokeStyle = lit ? on : bodyCol + '0.55)';
        c.lineWidth = Math.max(1, S(1.2));
        if (lit) { c.shadowColor = on; c.shadowBlur = S(12); }
        c.stroke();
        c.shadowBlur = 0;
        if (label) {
          c.fillStyle = lit ? '#1a0d00' : bodyCol + '0.85)';
          c.font = '900 ' + S(r * 1.15) + 'px "Orbitron", system-ui, sans-serif';
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText(label, X(x), Y(y) + S(0.5));
        }
      };

      const box = (x, y, w, h, lit, r) => {
        const rr = S(r === undefined ? 3 : r);
        const x0 = X(x - w / 2), y0 = Y(y - h / 2);
        const ww = S(w), hh = S(h);
        c.beginPath();
        if (c.roundRect) c.roundRect(x0, y0, ww, hh, rr);
        else c.rect(x0, y0, ww, hh);
        c.fillStyle = lit ? 'rgba(255,180,0,0.80)' : 'rgba(120,150,210,0.14)';
        c.fill();
        c.strokeStyle = lit ? on : bodyCol + '0.5)';
        c.lineWidth = Math.max(1, S(1.1));
        if (lit) { c.shadowColor = on; c.shadowBlur = S(10); }
        c.stroke();
        c.shadowBlur = 0;
      };

      /* A stick, with its cap where the player is actually holding it. The
         travel is exaggerated three times so a small real movement is
         legible - this is a readout, not a scale drawing, and a stick that
         moves two pixels tells nobody anything. */
      const stick = (x, y, ax, ay, pressed) => {
        c.beginPath();
        c.arc(X(x), Y(y), S(15), 0, Math.PI * 2);
        c.fillStyle = 'rgba(6,2,18,0.85)';
        c.fill();
        c.strokeStyle = bodyCol + '0.42)';
        c.lineWidth = Math.max(1, S(1));
        c.stroke();
        const dx = (pad ? pad.axis(ax) : 0) * 8.5;
        const dy = (pad ? pad.axis(ay) : 0) * 8.5;
        const moved = Math.hypot(dx, dy) > 1.2;
        c.beginPath();
        c.arc(X(x + dx), Y(y + dy), S(9.5), 0, Math.PI * 2);
        c.fillStyle = pressed ? 'rgba(255,180,0,0.85)'
          : (moved ? 'rgba(57,230,255,0.55)' : 'rgba(120,150,210,0.24)');
        c.fill();
        c.strokeStyle = pressed ? on : (moved ? CYAN : bodyCol + '0.6)');
        c.lineWidth = Math.max(1, S(1.3));
        if (pressed || moved) {
          c.shadowColor = pressed ? on : CYAN;
          c.shadowBlur = S(12);
        }
        c.stroke();
        c.shadowBlur = 0;
      };

      /* A trigger, which is the one control that is not a switch: it FILLS.
         Showing it as pressed or not would throw away the only analogue
         information on the pad, and trailing the brakes is the whole reason
         that information exists. */
      const trigger = (x, y, v, lbl) => {
        const w = 26, h = 13;
        box(x, y, w, h, false, 4);
        if (v > 0.02) {
          const fw = w * Math.min(1, v);
          c.save();
          c.beginPath();
          const x0 = X(x - w / 2), y0 = Y(y - h / 2);
          if (c.roundRect) c.roundRect(x0, y0, S(fw), S(h), S(4));
          else c.rect(x0, y0, S(fw), S(h));
          c.fillStyle = 'rgba(255,180,0,0.80)';
          c.shadowColor = on;
          c.shadowBlur = S(10);
          c.fill();
          c.restore();
        }
        c.fillStyle = v > 0.5 ? '#1a0d00' : bodyCol + '0.9)';
        c.font = '900 ' + S(8) + 'px "Orbitron", system-ui, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(lbl, X(x), Y(y));
      };

      const held = (i) => !!(pad && pad.held(i));

      // triggers and bumpers, riding above the shoulder line
      trigger(-84, -68, pad ? pad.value(B.LT) : 0, 'LT');
      trigger(84, -68, pad ? pad.value(B.RT) : 0, 'RT');
      box(-84, -52, 32, 9, held(B.LB), 4);
      box(84, -52, 32, 9, held(B.RB), 4);
      c.fillStyle = bodyCol + '0.9)';
      c.font = '900 ' + S(7) + 'px "Orbitron", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('LB', X(-84), Y(-52));
      c.fillText('RB', X(84), Y(-52));

      // sticks: left high, right low - the layout the standard mapping assumes
      stick(-66, -12, 0, 1, held(B.LS));
      stick(28, 14, 2, 3, held(B.RS));

      // d-pad, as four separate pads so each direction lights on its own
      const dpx = -28, dpy = 14, dw = 11, dh = 11;
      box(dpx, dpy - 11, dw, dh, held(B.UP), 2);
      box(dpx, dpy + 11, dw, dh, held(B.DOWN), 2);
      box(dpx - 11, dpy, dw, dh, held(B.LEFT), 2);
      box(dpx + 11, dpy, dw, dh, held(B.RIGHT), 2);

      /* Face buttons, in the standard diamond. A IS AT THE BOTTOM and Y at the
         top - local +y points down, so the two were swapped when this was
         first written and the diagram was quietly telling every player that
         boost was the top button. */
      const fx = 66, fy = -12;
      ring(fx, fy + 15, 9.5, held(B.A), 'A');
      ring(fx + 15, fy, 9.5, held(B.B), 'B');
      ring(fx - 15, fy, 9.5, held(B.X), 'X');
      ring(fx, fy - 15, 9.5, held(B.Y), 'Y');

      // back and start
      ring(-18, -14, 5.5, held(B.BACK), '');
      ring(18, -14, 5.5, held(B.START), '');
      c.fillStyle = bodyCol + '0.7)';
      c.font = '700 ' + S(6) + 'px "Orbitron", system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('BACK', X(-18), Y(-24));
      c.fillText('START', X(18), Y(-24));

      c.restore();

      // ------------------------------------------------------- the status --
      /* What the game thinks is plugged in, in the words the player needs. The
         three states are genuinely different problems and they get genuinely
         different sentences: nothing attached, attached but switched off, and
         attached but not recognised - the last of which still drives, and says
         so, because a pad with a non-standard mapping is not a broken pad. */
    }

    /* What the game thinks is plugged in, in the words the player needs.
     *
     * Its own method, and placed by its caller, because it belongs to the PAGE
     * rather than to the drawing - the pad occupies the corner where there is
     * room for it, and the sentence explaining it belongs at the top where a
     * sentence is read.
     *
     * The three states are genuinely different problems and get genuinely
     * different sentences: nothing attached, attached but switched off, and
     * attached but not recognised - the last of which still drives, and says
     * so, because a pad with a non-standard mapping is not a broken pad. */
    drawPadStatus(g, x, y) {
      const pad = g.pad;
      const info = pad ? pad.describe() : { connected: false };
      const dot = (col) => {
        const c = this.ctx;
        c.save();
        c.beginPath();
        c.arc(this.vx(x - 138), this.vy(y) + this.vs(1), this.vs(5), 0, Math.PI * 2);
        c.fillStyle = col;
        c.shadowColor = col;
        c.shadowBlur = this.vs(12);
        c.fill();
        c.restore();
      };
      if (!info.connected) {
        dot('rgba(150,180,222,0.45)');
        this.label('NO CONTROLLER DETECTED', x - 120, y, 17, INK.mute, 'left', 900);
        this.label('PLUG ONE IN AND PRESS ANY BUTTON',
          x - 120, y - 22, 11, INK.faint, 'left', 700);
      } else if (!info.enabled) {
        dot('rgba(255,90,120,0.9)');
        this.label(info.name, x - 120, y, 17, INK.mute, 'left', 900);
        this.label('SWITCHED OFF BY THE ROW OPPOSITE',
          x - 120, y - 22, 11, 'rgba(255,90,120,0.8)', 'left', 700);
      } else {
        dot('#5affc0');
        this.label(info.name, x - 120, y, 17, '#5affc0', 'left', 900);
        this.label(info.standard
          ? 'STANDARD LAYOUT — PRESS ANYTHING TO TEST IT'
          : 'LAYOUT NOT RECOGNISED — STEERING AND TRIGGERS ONLY',
          x - 120, y - 22, 11, info.standard ? INK.mute : AMBER, 'left', 700);
      }
    }

    /* The list of what each control does, beside the diagram.
     *
     * Read from js/gamepad.js rather than written here: it is a fact about the
     * binding, and a second copy of it on this screen is a second copy to
     * forget when one changes. */
    drawPadLegend(g, x, y, colW) {
      const map = global.NR.PAD_MAP || [];
      const pad = g.pad;
      const B = global.NR.PAD_BUTTONS || {};
      this.label('WHAT EACH CONTROL DOES', x, y, 12, VIOLET, 'left', 900);
      /* TWO COLUMNS, because one column of thirteen is a column that runs off
         the bottom of the panel - and because the band this sits in is the
         full width of the screen, so a single column at the far left leaves
         the other two thirds of it empty. */
      const perCol = Math.ceil(map.length / 2);
      for (let i = 0; i < map.length; i++) {
        const m = map[i];
        const col = Math.floor(i / perCol);
        const ry = y - 24 - (i % perCol) * 18;
        const rx = x + col * colW;
        /* Lit the moment the player touches it, so the legend and the diagram
           answer the same question at the same time - press a button and BOTH
           the shape and its name light up, which is what turns a list into a
           confirmation. */
        let lit = false;
        if (pad && pad.active) {
          if (m.id === 'DPAD') {
            lit = pad.held(B.UP) || pad.held(B.DOWN) || pad.held(B.LEFT) || pad.held(B.RIGHT);
          } else if (m.id === 'LSTICK') lit = Math.abs(pad.stickX(0)) > 0.02;
          else if (m.id === 'RSTICK') lit = Math.abs(pad.axis(2)) > 0.2 || Math.abs(pad.axis(3)) > 0.2;
          else if (m.button !== undefined) lit = pad.held(m.button) || pad.value(m.button) > 0.15;
        }
        this.label(m.id, rx, ry, 12, lit ? AMBER : INK.mute, 'left', 900);
        this.label(m.label, rx + 76, ry, 12, lit ? WHITE : INK.faint, 'left', 700);
      }
    }

    drawControlsScreen(g) {
      const k = this.enter;
      const c = this.ctx;
      this.gridFloor(g, -150, 0.22 * k);
      const PW = 1120, PH = 700, PY = -6;
      this.panel(0, PY + (1 - ease(k)) * 18, PW, PH, CYAN, 0.74, k);
      this.brackets(0, PY, PW - 14, PH - 14, VIOLET, 32, 0.5 * k);

      /* The header. A rule under a title is the difference between a screen
         and a list, and the kicker above it says which room of the game this
         is - the same language the Story hub and the driver terminal use. */
      this.label('SYNX GRID  //  SYSTEM', 0, 314, 13, 'rgba(180,200,255,0.62)', 'center', 700);
      this.neon('CONTROLS', 0, 282, 40, CYAN, 'center', 900);
      this.rule(0, 258, 900, VIOLET, 0.8);

      const rows = g.settingRows || [];
      const tab = g.controlTab || 0;
      const L = (global.NR.CONTROLS_LAYOUTS || [])[tab] || global.NR.CONTROLS_LAYOUT;
      const onTabs = g.controlIndex < 0;

      /* THE PAGES.
         Two of them, and a strip is the right control for two: a player can
         see both names at once and can see which one they are on without
         having to operate anything. It is also row minus one for the keyboard,
         so arrowing up off the top of the list lands here rather than wrapping
         - see Game.controlItemAt, which hit-tests these same numbers. */
      {
        const TY = global.NR.CTL_TAB_Y, TW = global.NR.CTL_TAB_W;
        const TX = global.NR.ctlTabX;
        const names = global.NR.CONTROL_TABS || [];
        for (let t = 0; t < names.length; t++) {
          const cx = TX(t), live = t === tab, sel = onTabs && live;
          this.panel(cx, TY, TW, 30, live ? PINK : VIOLET, live ? 0.30 : 0.12);
          if (sel) {
            this.brackets(cx, TY, TW + 22, 42, AMBER, 12,
              0.6 + 0.4 * Math.sin(g.time * 5));
          }
          this.label(names[t], cx, TY, 15,
            live ? (onTabs ? AMBER : WHITE) : 'rgba(190,200,235,0.52)',
            'center', live ? 900 : 700, live ? 1 : 0.8);
          /* The live page carries a lit underline. Two panels of slightly
             different opacity is not a strong enough signal on a screen this
             busy; a bar under one of them is. */
          if (live) {
            c.save();
            c.fillStyle = AMBER;
            c.shadowColor = AMBER;
            c.shadowBlur = this.vs(8);
            c.fillRect(this.vx(cx - TW / 2), this.vy(TY - 17), this.vs(TW), this.vs(2.5));
            c.restore();
          }
        }
      }
      /* The key legend, beside the title rather than under it. The band it
         used to occupy is the tab strip's now, and a legend is the one thing
         on this screen that can go anywhere - it is read once and then never
         again. */
      this.label(tab === 1
        ? 'ENTER  REBIND      ‹  CLEAR      R  RESET ALL      ESC  BACK'
        : '‹ ›  CHANGE      ENTER  SELECT      ESC  BACK',
        548, 288, 11, 'rgba(170,190,230,0.50)', 'right', 700);
      this.label('ARROWS  MOVE', 548, 272, 11, 'rgba(170,190,230,0.50)', 'right', 700);
      /* THE COLUMNS, WHICH ARE NOT THE SAME ON EVERY PAGE.
       *
       * KEYBOARD and MOUSE are lists and use the full width. GAMEPAD is not a
       * list - it is a picture with four settings beside it - so its rows move
       * into the right-hand third and the diagram takes the space they leave.
       * Hard-coding one pair of columns for all three pages is what would
       * force the diagram into whatever gap happened to be left over. */
      const padTab = tab === 1;
      const LX = padTab ? -40 : -466;    // the label column
      const VX = padTab ? 330 : 250;     // the value column
      const ROW_W = padTab ? 620 : 970;  // the selection band

      if (padTab) {
        /* Drawn BEFORE the rows so the selection band, which is translucent,
           composites over the panel rather than over the controller. */
        /* THE NUMBERS ARE THE PAGE'S, not a guess. The rows on this tab run
           from 156 down to 72; SAVE AND BACK sits at 12; the explanation band
           spans -24 to -70; the tab strip's brackets reach down to 211; and
           the panel ends at -356.
       
           So the whole band BELOW the explanation - 286 units tall and the
           full width - is empty, and that is where the controller goes. It
           gets to be nearly twice the size it could have been squeezed in
           beside the rows, which matters: this drawing is the page. The status
           line takes the gap above it, and the legend the column beside it. */
        this.drawPadStatus(g, -300, 168);
        this.drawPadDiagram(g, -300, -196, 1.72);
        this.drawPadLegend(g, 46, -92, 258);
      }

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const y = L.rows[i];
        const sel = i === g.controlIndex;

        /* A group header, drawn above the first row of its group. Small,
           spaced, and in the dim violet the rest of the chrome uses for
           structure rather than for content. */
        if (r.group) {
          /* Centred in the gap the group opens, not hung off it.
             Labels draw with textBaseline 'middle', so a 12px header occupies
             six units either side of gy - and the selected row's panel is 32
             tall, reaching sixteen above its own centre. At y+18 the lower
             half of the header was inside that panel, which is what clipped
             DISPLAY against the band on the first row. */
          const gy = y + 26;
          this.label(r.group, LX, gy, 12, 'rgba(139,92,246,0.95)', 'left', 900);
          c.save();
          c.strokeStyle = 'rgba(139,92,246,0.30)';
          c.lineWidth = Math.max(1, this.vs(1));
          c.beginPath();
          const gx = LX + this.textWidth(r.group, 12, 900) + 16;
          // ...to the end of THIS page's column, not to a number that happens
          // to be the right edge of the widest one
          c.moveTo(this.vx(gx), this.vy(gy) - this.vs(4));
          c.lineTo(this.vx(LX + ROW_W - 32), this.vy(gy) - this.vs(4));
          c.stroke();
          c.restore();
        }

        if (sel) {
          /* The selection. One bar the full width of the row with a solid
             accent down its leading edge, rather than a box around the label:
             a full-width band is what tells the eye which ROW is live when the
             thing being changed is over on the other side of the panel. */
          const bandX = padTab ? (LX - 16 + ROW_W / 2) : 0;
          this.panel(bandX, y, ROW_W, 32, PINK, 0.22);
          c.save();
          c.fillStyle = AMBER;
          c.shadowColor = AMBER;
          c.shadowBlur = this.vs(10);
          c.fillRect(this.vx(LX - 19), this.vy(y) - this.vs(13), this.vs(4), this.vs(26));
          c.restore();
        }

        this.label(r.label, LX + 16, y, 19,
          sel ? WHITE : 'rgba(214,210,240,0.70)', 'left', sel ? 900 : 700);

        /* A BINDING ROW.
           No option list, no meter, no chevrons - the value is a key, and the
           only thing that can be done to it is to press a different one. It is
           drawn as a cap so it reads as a key rather than as a word, and the
           row being listened for says so in place of the cap. */
        if (r.bind) {
          const NR2 = global.NR;
          const capturing = g.bindCapture === r.bind;
          const list = (g.settings.binds && g.settings.binds[r.bind]) || [];
          this.label(r.label, LX + 16, y, 19,
            sel ? WHITE : 'rgba(214,210,240,0.70)', 'left', sel ? 900 : 700);
          if (capturing) {
            const p2 = 0.45 + 0.55 * Math.sin(g.time * 8);
            this.panel(VX + 40, y, 300, 28, AMBER, 0.30);
            this.label('PRESS A KEY   //   ESC CANCELS', VX + 40, y, 15, AMBER,
              'center', 900, p2);
          } else if (!list.length) {
            this.label('—', VX + 40, y, 20, 'rgba(255,90,120,0.85)', 'center', 900);
            this.label('UNBOUND', VX + 150, y, 11, 'rgba(255,90,120,0.55)', 'center', 700);
          } else {
            let cx = VX - 60;
            for (let bi = 0; bi < list.length; bi++) {
              if (bi) { this.label('/', cx + 8, y, 15, VIOLET, 'left', 700); cx += 22; }
              cx += this.keycap(NR2.keyLabel(list[bi]), cx, y, 22) + 10;
            }
          }
          continue;
        }

        const val = r.opts[g.settings[r.key]];
        if (sel) {
          /* Both chevrons, in phase and never fully out.
             Offsetting one from the other made them alternate rather than
             pulse, and the old amplitude took the alpha negative - so at any
             moment one of the two was simply missing, which reads as the
             control only going one way. */
          const pulse = 0.62 + 0.38 * Math.sin(g.time * 6);
          this.label('‹', VX - 132, y, 26, AMBER, 'center', 900, pulse);
          this.label('›', VX + 132, y, 26, AMBER, 'center', 900, pulse);
        }
        this.neon(val, VX, y, 21, sel ? AMBER : CYAN, 'center', sel ? 900 : 700,
          sel ? 1 : 0.72);

        /* The meter. Graded settings get a segment per step so the position in
           the range is readable at a glance; two-state ones get a switch,
           because a two-segment meter reads as a broken slider. */
        if (r.opts.length > 2) {
          c.save();
          const n = r.opts.length, cur = g.settings[r.key];
          for (let k = 0; k < n; k++) {
            const bx = 430 + (k - (n - 1) / 2) * 15;
            const lit = k <= cur;
            c.fillStyle = lit ? (sel ? AMBER : CYAN) : INK.faint;
            if (lit) { c.shadowColor = sel ? AMBER : CYAN; c.shadowBlur = this.vs(6); }
            else c.shadowBlur = 0;
            c.fillRect(this.vx(bx) - this.vs(4), this.vy(y) - this.vs(7),
              this.vs(8), this.vs(14));
          }
          c.restore();
        } else {
          const on = g.settings[r.key] === 1;
          c.save();
          const tw = 40, th = 16;
          c.strokeStyle = sel ? 'rgba(255,180,0,0.9)' : 'rgba(57,230,255,0.55)';
          c.lineWidth = Math.max(1, this.vs(1.5));
          c.strokeRect(this.vx(430) - this.vs(tw / 2), this.vy(y) - this.vs(th / 2),
            this.vs(tw), this.vs(th));
          c.fillStyle = on ? (sel ? AMBER : CYAN) : 'rgba(255,255,255,0.16)';
          if (on) { c.shadowColor = sel ? AMBER : CYAN; c.shadowBlur = this.vs(8); }
          c.fillRect(this.vx(430) + (on ? this.vs(2) : -this.vs(tw / 2 - 2)) - (on ? 0 : 0),
            this.vy(y) - this.vs(th / 2 - 2), this.vs(tw / 2 - 4), this.vs(th - 4));
          c.restore();
        }
      }

      // the exit row, drawn as a button rather than as another setting
      {
        const y = L.exitY;
        const sel = g.controlIndex >= rows.length;
        if (sel) {
          this.panel(0, y, 400, 42, PINK, 0.34);
          this.brackets(0, y, 430, 52, AMBER, 14, 0.6 + 0.4 * Math.sin(g.time * 5));
        }
        this.neon('SAVE AND BACK', 0, y, 22, sel ? AMBER : WHITE, 'center',
          sel ? 900 : 700, sel ? 1 : 0.72);
        /* RESET is not a setting, so it is not in the list. It sits beside the
           way out, on the page it belongs to, and it is the only thing on this
           screen that can undo a player who has bound the accelerator to the
           pause key and back again. */
        if (tab === 1) {
          this.panel(360, y, 220, 34, VIOLET, 0.20);
          this.label('R   RESET CONTROLS', 360, y, 14,
            'rgba(214,210,240,0.78)', 'center', 800);
        }
      }

      /* The explanation for whatever is selected.

         A settings screen that only names its settings makes the player guess
         what each one costs, and the whole point of the screen is to let them
         make that trade deliberately. It sits in a fixed band so the layout
         does not move as the selection does. */
      {
        const r = rows[g.controlIndex];
        const hint = g.controlIndex < 0
          ? 'Two pages. GRAPHICS + AUDIO is how the game looks and sounds; CONTROLS is every key the car answers to, and the mouse.'
          : (r ? r.hint : 'Keep the changes and return to the title.');
        const hy = L.hintY, hh = L.hintH || 46;
        c.save();
        c.fillStyle = 'rgba(8,3,22,0.62)';
        c.fillRect(this.vx(-500), this.vy(hy) - this.vs(hh / 2), this.vs(1000), this.vs(hh));
        c.strokeStyle = 'rgba(57,230,255,0.20)';
        c.lineWidth = Math.max(1, this.vs(1));
        c.strokeRect(this.vx(-500), this.vy(hy) - this.vs(hh / 2), this.vs(1000), this.vs(hh));
        c.restore();
        this.wrapLabel(hint || '', 0, hy, 14, INK.body, 900, 2);
      }

      this.sweep(g, 0.6);
    }

    /** Measure a label the same way `label` draws one. */
    textWidth(txt, size, weight) {
      const c = this.ctx;
      c.save();
      c.font = (weight || 700) + ' ' + this.vs(size) + 'px "Orbitron", system-ui, sans-serif';
      const w = c.measureText(txt).width / this.k;
      c.restore();
      return w;
    }

    /** A centred label broken over at most `maxLines` lines. */
    wrapLabel(txt, x, y, size, colour, weight, maxLines) {
      if (!txt) return;
      const words = String(txt).split(' ');
      const lines = [];
      let line = '';
      const LIMIT = 940;
      for (const w of words) {
        const t = line ? line + ' ' + w : w;
        if (this.textWidth(t, size, weight) > LIMIT && line) { lines.push(line); line = w; }
        else line = t;
        if (lines.length >= (maxLines || 2)) break;
      }
      if (line && lines.length < (maxLines || 2)) lines.push(line);
      const lh = size * 1.35;
      const y0 = y + (lines.length - 1) * lh * 0.5;
      for (let i = 0; i < lines.length; i++) {
        this.label(lines[i], x, y0 - i * lh, size, colour, 'center', weight);
      }
    }

    /* Level select. Each row is a stretch of the course with its own name and
       its own palette, and a locked one shows what it is waiting for. */
    drawStartCard(g) {
      const k = this.enter;
      if (!this.frost(k * 0.9)) this.scrim(0.66 * k);
      this.panel(0, 12 + (1 - ease(k)) * 22, 940, 430, CYAN, 0.55, k);
      this.chrome('CONTROLS', 0, 190, T.title, CYAN, k);
      this.rule(0, 158, 700, VIOLET, 0.7 * k);

      /* THE CARD READS THE BINDINGS.
         It used to be five hard-coded strings, which was true right up until
         the controls became rebindable - at which point a player who had moved
         the accelerator was told, before every race, that it was still on the
         up arrow. `cap` takes the FIRST key bound to an action, because this
         is a reminder and not the reference; the reference is the CONTROLS
         screen, which lists every key on every action. */
      const NRk = global.NR;
      const B = (g.settings && g.settings.binds) || {};
      const cap = (action, fallback) => {
        const list = B[action] || (NRk.ACTION_DEFAULTS && NRk.ACTION_DEFAULTS[action]);
        return (list && list.length) ? NRk.keyLabel(list[0]) : (fallback || '—');
      };
      const rows = [
        ['GAS / BRAKE', [cap('throttle', 'UP'), cap('brake', 'DOWN')], 110],
        ['STEER', [cap('left', 'LEFT'), cap('right', 'RIGHT')], 56],
        ['DRIFT', [cap('ebrake', 'SPACE'), '+', cap('left', 'LEFT') + ' / ' + cap('right', 'RIGHT')], 2],
        ['BOOST', [cap('boost', 'B')], -52],
        ['PAUSE / RESTART', [cap('pause', 'ESC'), cap('raceMode', 'R')], -106],
      ];
      for (let ri = 0; ri < rows.length; ri++) {
        const [name, keys, y] = rows[ri];
        // staggered, so the card deals its rows rather than stamping them
        const rk = ease(Math.min(1, Math.max(0, (k * 0.30 - ri * 0.035) / 0.19)));
        if (rk <= 0.002) continue;
        this.ctx.save();
        this.ctx.globalAlpha = rk;
        this.label(name, -390 - (1 - rk) * 24, y, 22, INK.key, 'left', 700);
        let x = -70;
        for (const kc of keys) {
          if (kc === '+') { this.label('+', x + 10, y, 22, VIOLET, 'left', 700); x += 34; continue; }
          x += this.keycap(kc, x, y, 30) + 14;
        }
        this.ctx.restore();
      }
      this.label('PRESS SPACE BAR TO CONTINUE   //   CONTROLS TO REBIND',
        0, -168, T.body, AMBER, 'center', 700,
        (0.45 + 0.55 * Math.sin(g.time * 4)) * k);
      this.sweep(g, 0.6);
    }

    /* Scale everything already drawn on the HUD canvas by `k`. The 3D is a
       different canvas underneath, so this dims the instruments and nothing
       else. */
    veil(k) {
      if (k >= 0.999) return;
      const c = this.ctx;
      c.save();
      c.globalCompositeOperation = 'destination-in';
      c.globalAlpha = 1;
      c.fillStyle = 'rgba(0,0,0,' + Math.max(0, k) + ')';
      c.fillRect(0, 0, this.w, this.h);
      c.restore();
    }

    drawCountdown(g) {
      const n = Math.ceil(g.countdown);
      if (n <= 0) {
        // a shockwave ring on the green light
        const t = Math.min(1, -g.countdown * 2.2);
        const c = this.ctx;
        c.save();
        c.strokeStyle = 'rgba(84,255,75,' + (1 - t) + ')';
        c.lineWidth = Math.max(1, this.vs(6 * (1 - t)));
        c.shadowColor = '#54ff4b';
        c.shadowBlur = this.vs(24);
        c.beginPath();
        c.arc(this.vx(0), this.vy(83), this.vs(60 + t * 320), 0, Math.PI * 2);
        c.stroke();
        c.restore();
        this.neon('GO!', 0, 83, 140, '#54ff4b', 'center', 900, 1 - t * 0.6);
        return;
      }
      const frac = 1 - (g.countdown - Math.floor(g.countdown));
      const scale = 0.34 * (1 + (1 - frac) * 0.22);
      /* NO FADE AT ALL.
         Each digit used to ramp up from a fraction of its opacity over the
         first third of its second. The instruments behind it are ghosted, but
         the ROAD behind those is not, and a half-strength green numeral over
         lit neon at a hundred miles an hour is not a countdown, it is a
         suggestion. The digit is solid for the whole of its second and it
         darkens the frame behind itself to sit on. */
      const alpha = 1;
      const c = this.ctx;
      c.save();
      const glow = c.createRadialGradient(this.vx(0), this.vy(83), this.vs(20),
        this.vx(0), this.vy(83), this.vs(230));
      glow.addColorStop(0, 'rgba(2,0,10,0.62)');
      glow.addColorStop(0.55, 'rgba(2,0,10,0.34)');
      glow.addColorStop(1, 'rgba(2,0,10,0)');
      c.fillStyle = glow;
      c.fillRect(0, 0, this.w, this.h);
      c.restore();
      // a ring closing in behind the shipped countdown sprite
      c.save();
      c.globalAlpha = 0.9;
      c.strokeStyle = CYAN;
      c.lineWidth = Math.max(1, this.vs(3));
      c.shadowColor = CYAN;
      c.shadowBlur = this.vs(16);
      c.beginPath();
      c.arc(this.vx(0), this.vy(83), this.vs(150 - frac * 40), -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * frac);
      c.stroke();
      c.restore();
      if (!this.sprite('countdown_' + n, 0, 83, scale, alpha)) {
        this.neon(String(n), 0, 83, 168, '#54ff4b', 'center', 900, alpha);
      }
    }

    /* A LIST WITH ONE SELECTION IN IT.
     *
     * The highlight used to be redrawn under whichever row was current, which
     * means it does not move - it disappears and reappears somewhere else, and
     * the eye has to find it again every keystroke. Damping its position
     * instead turns the same three rows into a control: the bar slides, the
     * eye follows it, and the player always knows where they are.
     *
     * `this.selY` is null on a state change so the first frame of a screen
     * places the bar rather than sliding it in from wherever the last screen
     * happened to leave it.
     */
    menuList(items, index, baseY, gap, dt, opts) {
      const o = opts || {};
      const width = o.width || 360;

      /* SHRINK TO FIT THE BAR.
       *
       * The selection bar and its brackets are a FIXED width, and the label is
       * drawn centred inside them at a fixed size - so a label longer than the
       * bar is a label drawn straight through its own bracket. That is what
       * happened to NO - KEEP PLAYING on the quit card: seventeen characters at
       * the head size is about three hundred and sixty units, which is exactly
       * the width of the bar it was sitting in.
       *
       * Measuring and shrinking here fixes it for every caller at once, rather
       * than by finding a shorter word for this one dialogue and waiting for
       * the next label that does not fit. The floor stops a very long string
       * from shrinking to nothing - past that point the caller needs a wider
       * bar, and will now be able to see that it does. */
      let size = o.size || T.head;
      const inner = width - 36;
      let widest = 0;
      for (let i = 0; i < items.length; i++) {
        widest = Math.max(widest, this.textWidth(items[i], size, 900));
      }
      if (widest > inner) size = Math.max(15, size * (inner / widest));

      const target = baseY - index * gap;
      if (this.selY === null || this.selY === undefined) this.selY = target;
      else this.selY += (target - this.selY) * Math.min(1, (dt || 0.016) * 22);

      // the bar, once, where it actually is
      const glow = 0.55 + 0.45 * Math.sin((this.time || 0) * 4);
      this.panel(0, this.selY, width, gap * 0.82, PINK, 0.34);
      this.brackets(0, this.selY, width + 30, gap * 0.97, AMBER, 15, 0.55 + 0.35 * glow);

      for (let i = 0; i < items.length; i++) {
        const sel = i === index;
        const y = baseY - i * gap;
        /* Rows stagger in behind the panel, forty milliseconds apart. It is
           the difference between a menu appearing and a menu being dealt. */
        const k = ease(Math.min(1, Math.max(0, ((this.enter || 1) * 0.30 - i * 0.045) / 0.20)));
        if (k <= 0.002) continue;
        const dx = (1 - k) * 26;
        this.neon(items[i], dx, y, size, sel ? AMBER : WHITE, 'center',
          sel ? 900 : 700, (sel ? 1 : 0.68) * k);
      }
    }

    drawPause(g, dt) {
      /* GLASS, NOT A CURTAIN.
         The road is still there behind this - the camera is still running -
         and blurring it rather than covering it is what says the race is
         waiting rather than over. */
      if (!this.frost(this.enter)) this.scrim(0.74 * this.enter);
      /* The panel is as tall as what goes into it, with the gaps still
         reading as gaps: title, rule, two lines of run state, a progress rail,
         three rows and a hint band. At 452 the last row and the footer were
         twenty-two units apart, which is closer than any other pair on the
         card and is what made the bottom of it feel crowded. */
      const PW = 620, PH = 492, PY = 10;
      const k = this.enter;
      this.panel(0, PY + (1 - ease(k)) * 26, PW, PH, VIOLET, 0.60, k);
      this.brackets(0, PY, PW - 14, PH - 14, CYAN, 26, 0.45 * k);

      this.chrome('PAUSED', 0, 186, T.title, PINK, k);
      this.rule(0, 146, 430, CYAN, 0.7 * k);

      // where the run is, so the pause screen is worth reading
      if (g.level) {
        this.label(g.level.name, 0, 112, T.body, INK.body, 'center', 700, k);
        const done = Math.round((g.progress || 0) * 100);
        this.label(done + '%  OF THE ROUTE', -104, 84, T.cap, INK.mute, 'center', 600, k);
        this.label(fmtTime(g.raceTime), 104, 84, T.cap, INK.mute, 'center', 600, k);
        /* A progress rail rather than a percentage on its own. Two hundred and
           forty units of bar say the same thing the number does and say it at
           a glance, which is what a pause screen is read at. */
        this.meterBar(0, 60, 320, Math.max(0, Math.min(1, g.progress || 0)), CYAN, k);
      }
      /* WHEN THE RUN WAS LAST WRITTEN. The pause screen is where a player
         decides whether it is safe to stop, and that decision needs this. */
      if (g.autosave && g.autosave.lastAt) {
        const secs = Math.max(0, (Date.now() - g.autosave.lastAt) / 1000);
        const when = secs < 12 ? 'JUST NOW'
          : secs < 90 ? Math.round(secs) + ' SECONDS AGO'
          : Math.round(secs / 60) + ' MINUTES AGO';
        this.label('PROGRESS SAVED  ' + when, 0, 26, T.micro, '#5affc0', 'center', 800, k * .8);
      }
      this.menuList(g.pauseItems, g.pauseIndex, -12, 64, dt);
      this.footer('CLICK / ENTER  SELECT      ESC  RESUME', PY, PH);
      this.sweep(g, 0.5);
    }

    /* ARE YOU SURE.
     *
     * Built from the same primitives as the pause card and entering on the
     * same curve, because it is the same kind of object: a modal that stops
     * the thing behind it. Deliberately narrower and shorter than PAUSED -
     * it asks one question and it should not look like a screen.
     *
     * The frame behind it is frosted rather than covered, for the reason the
     * pause card documents: what is underneath has not gone away, and saying
     * so is the difference between a question and a verdict. */
    drawConfirm(g, dt) {
      const box = g.confirmBox;
      if (!box) return;
      const k = this.enter;
      if (!this.frost(k)) this.scrim(0.80 * k);

      const PW = 660, PH = 360, PY = 10;
      this.panel(0, PY + (1 - ease(k)) * 26, PW, PH, PINK, 0.62, k);
      this.brackets(0, PY, PW - 14, PH - 14, AMBER, 26, 0.45 * k);

      this.chrome(box.title, 0, 128, T.title, PINK, k);
      this.rule(0, 92, 430, AMBER, 0.7 * k);
      if (box.body) {
        this.label(box.body, 0, 60, T.body, INK.body, 'center', 600, k);
      }
      /* The reassurance, in the colour the game uses for a save. A player
         hesitating over QUIT is usually hesitating about losing something,
         and the answer to that belongs on this card rather than in a manual. */
      if (box.note) {
        this.label(box.note, 0, 30, T.micro, '#5affc0', 'center', 800, k * 0.9);
      }

      /* Wider than the default bar, because this card is 660 across and its
         answers are sentences rather than words. */
      this.menuList(box.items, g.confirmIndex, -40, 62, dt, { width: 470 });
      this.footer('ARROWS  CHOOSE      ENTER  CONFIRM      ESC  CANCEL', PY, PH);
      this.sweep(g, 0.5);
    }

    /* A horizontal fill. One primitive, so every meter in the game - the
       pause screen's progress, the finish card's rating, the options screen's
       graded settings - is drawn the same way. */
    meterBar(x, y, w, f, col, alpha) {
      const c = this.ctx;
      const a = alpha === undefined ? 1 : alpha;
      if (a <= 0.002) return;
      const X = this.vx(x - w / 2), Y = this.vy(y), W = this.vs(w), H = this.vs(6);
      c.save();
      c.globalAlpha = a;
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(X, Y - H / 2, W, H);
      const q = Math.max(0, Math.min(1, f));
      if (q > 0) {
        const g = c.createLinearGradient(X, 0, X + W * q, 0);
        g.addColorStop(0, this._alpha(col, 0.55));
        g.addColorStop(1, col);
        c.fillStyle = g;
        c.shadowColor = col;
        c.shadowBlur = this.vs(10);
        c.fillRect(X, Y - H / 2, W * q, H);
        // the head of the fill, brighter, so the eye finds where it is
        c.fillStyle = '#ffffff';
        c.fillRect(X + W * q - this.vs(1.5), Y - H / 2 - this.vs(1.5),
          this.vs(3), H + this.vs(3));
      }
      c.restore();
    }

    /* The finish card.
     *
     * Laid out on a grid rather than by eye. The old one placed everything at
     * an absolute height inside a fixed 760x600 panel, which left a hollow
     * band a hundred and fifty units deep whenever there were no splits to
     * fill it, and it was drawn ON TOP of the racing instruments - so the
     * speedometer, the clock and the score sat around its edges at a quarter
     * opacity for the whole of it. The instruments are gone now (see draw()),
     * and the card measures itself: rows are stacked from the top, and the
     * panel is as tall as what went into it.
     */
    drawFinish(g) {
      const k = this.enter;
      if (!this.frost(k)) this.scrim(0.78 * k);
      const sp = g.splits || [];
      const hasSplits = sp.length > 0;
      const PW = 820;
      /* The card measures itself - rows are stacked from the top and the panel
         is as tall as what went into it - but a card taller than the screen is
         a card with its title off the top of it. With splits AND an unlock it
         reaches 726 against a 720-unit frame, which is the one combination
         nothing in the layout was stopping. */
      const PH = Math.min(this.vh - 26,
        610 + (hasSplits ? 72 : 0) + (g.unlockedNow ? 44 : 0));
      const PY = 0;
      const top = PH / 2 - 18;
      let y = top;

      /* A solo Free Roam tour has nobody to have beaten, so the card reports
         the drive rather than a result. */
      const contested = !!(g.rival && !g.soloRun);
      const won = contested ? g.won : true;
      const key = contested ? (won ? '#54ff4b' : PINK) : (g.newRecord ? AMBER : PINK);
      this.panel(0, PY + (1 - ease(k)) * 30, PW, PH, g.newRecord ? AMBER : CYAN, 0.66, k);
      this.brackets(0, PY, PW - 14, PH - 14, key, 30, 0.5 * k);

      y -= 46;
      this.chrome(contested ? (won ? 'WINNER' : 'DEFEATED')
        : (g.freeRoam ? 'ROUTE CLEAR' : 'FINISH'), 0, y, 58, key);
      y -= 42;
      if (contested) {
        this.label(won ? 'YOU TOOK THE RIVAL' : 'THE RIVAL TOOK IT',
          0, y, 16, key, 'center', 700);
        y -= 26;
      } else if (g.freeRoam) {
        this.label('YOU DROVE IT END TO END', 0, y, 16, key, 'center', 700);
        y -= 26;
      }
      if (g.freeRoam && g.levels) {
        const from = g.levels[g.freeRoamRegion || 0];
        const to = g.levels[g.levels.length - 1];
        this.label('FREE ROAM   -   ' + ((g.freeRoamRegion | 0) === 0
          ? 'GRAND TOUR  //  ALL ' + g.levels.length + ' REGIONS'
          : (from ? from.name : '') + '   ->   ' + (to ? to.name : '')),
          0, y, 14, INK.mute, 'center', 600);
        y -= 22;
      } else if (g.level) {
        this.label(g.level.name + '   -   ' + (g.difficulties
          ? g.difficulties[g.diffIndex] : ''), 0, y, 14,
          INK.mute, 'center', 600);
        y -= 22;
      }
      this.rule(0, y, PW - 240, VIOLET, 0.8);

      // --- the clock, which is the headline ---------------------------------
      y -= 34;
      this.label('RACE TIME', 0, y, 17, CYAN, 'center', 700);
      y -= 48;
      this.digits(fmtTime(g.raceTime), 0, y, 70, 'center');
      y -= 46;
      if (g.newRecord) {
        const p = 0.55 + 0.45 * Math.sin(g.time * 8);
        this.neon('NEW RECORD', 0, y, 28, AMBER, 'center', 900, p);
      } else if (g.record != null) {
        this.label('BEST', -76, y, 15, CYAN, 'center', 700);
        this.digits(fmtTime(g.record), 36, y, 25, 'center');
      }

      // --- three figures on one line ---------------------------------------
      y -= 52;
      const cells = [
        ['SCORE', String(g.score | 0), ''],
        ['TOP SPEED', String(Math.round(g.topSpeedSeen || 0)),
          g.useMetric ? 'KM/H' : 'MPH'],
        ['DISTANCE', ((g.finishAt - g.startAt) * 0.733 / 1000).toFixed(1), 'KM'],
      ];
      for (let i = 0; i < cells.length; i++) {
        const x = (i - 1) * 246;
        this.label(cells[i][0], x, y, 14, CYAN, 'center', 700);
        this.digits(cells[i][1], x, y - 30, 28, 'center', 1, AMBER);
        if (cells[i][2]) {
          this.label(cells[i][2], x, y - 56, 11,
            INK.mute, 'center', 600);
        }
      }
      y -= 76;

      // --- splits, so a retry has something to beat piece by piece ----------
      if (hasSplits) {
        y -= 12;
        this.rule(0, y, PW - 260, VIOLET, 0.45);
        y -= 26;
        for (let i = 0; i < sp.length; i++) {
          const x = (i - (sp.length - 1) / 2) * Math.min(140, (PW - 160) / sp.length);
          this.label('CP' + (i + 1), x, y, 12, INK.mute, 'center', 600);
          this.label(fmtTime(sp[i]), x, y - 22, 15, WHITE, 'center', 700);
        }
        y -= 46;
      }
      if (g.unlockedNow) {
        y -= 10;
        const p = 0.55 + 0.45 * Math.sin(g.time * 6);
        this.neon('NEXT ROUTE UNLOCKED', 0, y, 22, '#54ff4b', 'center', 900, p);
        y -= 34;
      }

      // the buttons sit clear of both the last row of figures and the footer
      this.menuList(g.finishItems, g.finishIndex,
        Math.min(y - 34, -PH / 2 + 168), 54, this._dt);
      this.footer('ENTER  SELECT      R  RETRY', PY, PH);
      this.sweep(g, 0.5);
    }

    drawToasts(dt, visible, state) {
      /* WHY THE STACK MOVED DOWN.
         It sat at y=230, which is the same line as the position indicator and
         its gap rail on the left flank - so a wide notification and the one
         number the player is actually watching were drawn on top of each
         other. Squeezing the notification to fit beside it was the wrong
         trade: the player is told to look at these, and the long ones
         (BLUE RESERVE // FLOW RESTORED) are the ones that would have shrunk
         most. Dropping the stack clear of that band instead lets them keep
         full size, and gives the flank back to the instrument.

         The clamp stays as a backstop for a message longer than any that
         exists today: it stops short of the raceMode meter, whose bar starts
         at x=420 on the other flank. */
      const MAX_W = 2 * (420 - 24);
      /* A TITLE SCREEN IS NOT A RACE, AND THE STACK CANNOT LIVE IN THE SAME
       * PLACE ON BOTH.
       *
       * y=176 is chosen against the instruments, and on the road it is right.
       * On the front end there are no instruments there - there is the
       * wordmark, whose glyphs occupy 161..231 - so SETTINGS SAVED and
       * PROGRESS SAVED were drawn straight through SYNX.
       *
       * The front end therefore has its own band, in the headroom above the
       * wordmark: 300 and 254, on shorter panels, capped at two. Two is not a
       * shortcut - there is only room for two up there, and the alternative is
       * a third that lands back on the title. Anything beyond the cap still
       * AGES normally, so a burst clears itself in order rather than queueing
       * up behind a screen the player has already left. */
      const front = state === 'menu' || state === 'controls'
        || state === 'loading' || state === 'quit' || state === 'confirm';
      const BASE = front ? 300 : 176;
      const GAP = front ? 46 : 46;
      const H = front ? 34 : 42;
      for (let i = this.toasts.length - 1; i >= 0; i--) {
        const t = this.toasts[i];
        t.t += dt;
        if (t.t > 2.0) { this.toasts.splice(i, 1); continue; }
        if (visible === false) continue;
        if (front && i > 1) continue;
        const a = t.t < 0.2 ? t.t / 0.2 : (t.t > 1.5 ? (2.0 - t.t) / 0.5 : 1);
        /* IT ARRIVES FROM SOMEWHERE.
           A notification that fades up in place is a caption; one that drops
           the last few units into its slot and settles is an object being put
           down, and it costs one eased term. The stack also slides: each
           toast damps toward the slot it currently occupies, so when the one
           above it expires the rest move up rather than jumping. */
        const rise = (1 - overshoot(Math.min(1, t.t / 0.34))) * 30;
        const slot = BASE - i * GAP;
        t.y = t.y === undefined ? slot : t.y + (slot - t.y) * Math.min(1, dt * 14);
        const y = t.y + rise;
        let size = T.value;
        let w = Math.max(180, this.measure(t.text, size + 2) + 64);
        if (w > MAX_W) {
          size = Math.max(14, size * (MAX_W - 64) / Math.max(1, w - 64));
          w = MAX_W;
        }
        this.panel(0, y, w, H, t.color, 0.46 * a);
        this.neon(t.text, 0, y, size, t.color, 'center', 800, a);
      }
    }
  }

  global.NR.Hud = Hud;
  global.NR.MENU_LAYOUT = ML;
  global.NR.fmtTime = fmtTime;
})(window);
