/* SYNX Synthwave eXtreme racing
 * The Canvas2D interface: every instrument, menu and card drawn in code, in
 * the two faces the stylesheet uses, with no bitmaps.
 *
 * Coordinates are in a fixed 1280x720 virtual space - origin at screen
 * centre, +y up - fitted to the window in both axes.
 */
(function (global) {
  'use strict';

  /* WHICH KEY AN ACTION IS ON, for the several places the interface has to
     name one. Read from the live bindings rather than written into the
     string, because a hard-coded key name is a lie the moment somebody
     rebinds it - and, as the boost meter and the raceMode widget both
     proved, it can be a lie from the day it is typed.

     One implementation, in js/game.js, next to the bindings themselves and
     shared with the chapter directors. This name stays because the call
     sites below read better with it. Empty means NOTHING IS BOUND, and each
     caller decides what to say about that. */
  function keyFor(g, action) {
    const f = global.NR && global.NR.keyFor;
    return f ? f(g, action) : '';
  }

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
  /* FOCUS's meter: the top-left corner, mirroring raceMode's x 570 on the
     right. `y` is the name's line; the state rides 24 above it and the tube 15
     under it, so the whole instrument spans y 302..349 - above the story cards,
     which style.css holds below y 292 on this flank, and left of the route
     rail, which starts at x -380. Changing any of these means changing that
     rule too. */
  const FOCUS_HUD = { x: -570, y: 320, w: 150 };
  const VH = 720;

  /* THE BOOST METER. The shipped widget is 512x64 at the bottom centre, which
     is a third of the frame's width for one number - so this is narrower and
     much shallower, in the same slot. `n` is the segment count: the reserve is
     spent in discrete bursts and latches when it empties, so what the player
     reads off it is a count rather than a length. See Hud.boostMeter. */
  /* y is six units above the shipped widget's: the caption under the bar and
     the record readout between the two chequered flags at y -315 were sharing
     a line at the old height, and two centred readouts that touch read as one. */
  const BST = { x: 0, y: -268, w: 380, h: 17, n: 24 };
  /* ...AND FROM THE DRIVING SEAT, where the reserve is still the one number
     the car's own instruments do not give at a glance - the cluster carries a
     boost read-out, but it is behind the rim, and in a slide it is behind a
     glove. So the meter stays, slimmer, floating on the glass just above the
     top of the wheel where the eye already is, with its reading over it
     rather than under it (under it is the rim). */
  const SEAT_BST = { x: 0, y: -86, w: 300, h: 11, n: 24, capAbove: true, capSize: 10, tick: 11 };

  /* ===================================================== THE TYPE KIT ==
   *
   * THE SITE'S THREE FACES, FIVE JOBS - the same kit synx-landing sets
   * itself in, so the game and the page that sells it read as one object.
   *
   *   ORBITRON is the display face, and on the site it is more than the
   *   wordmark: every headline, every kicker, every button label and every
   *   big statistic. So it is the hero numerals here (the speed, the place,
   *   the gear, the count) at its black weight, and the tracked labels at its
   *   lighter one.
   *   RAJDHANI is what the site's prose is set in: copy, captions, hints.
   *   SHARE TECH MONO is the site's data face - versions, sizes, distances -
   *   and it is the data here: the clock, the gaps, the kilometres, the
   *   frequencies. Monospaced, so a number that changes does not move.
   *
   * See the note above the @font-face rules in css/style.css. Everything in
   * this file sets its type through these, so the hierarchy is a property of
   * the role and not of whoever wrote the call. */
  const RAJ = '"Rajdhani", "Orbitron", system-ui, sans-serif';
  const ORB = '"Orbitron", "Rajdhani", system-ui, sans-serif';
  const MONO = '"Share Tech Mono", "Rajdhani", ui-monospace, monospace';
  const FACE = {
    num: (px) => '900 ' + px + 'px ' + ORB,               // hero numerals, menu words
    numL: (px) => px + 'px ' + MONO,                       // data: clocks, gaps, distances
    lab: (px) => '600 ' + px + 'px ' + ORB,               // kickers and labels, tracked
    body: (px) => '600 ' + px + 'px ' + RAJ,              // copy, captions
    row: (px) => '700 ' + px + 'px ' + RAJ,               // list rows that are read
    disp: (px) => '900 ' + px + 'px ' + ORB,              // headlines
  };
  /* THE OLDER PRIMITIVES' FACE, chosen by weight - the rule the stylesheet
     keeps too. 900 is a headline and is Orbitron; anything lighter is text
     and is Rajdhani (shipped at 500, 600 and 700). Every label, row and hint
     on the menus, the pause card, the finish card and the options screen
     goes through this, and so does everything that measures them, so a row
     and its measurement can never disagree. */
  function uiFont(px, weight) {
    const w = weight || 700;
    if (w >= 900) return '900 ' + px + 'px ' + ORB;
    return (w >= 700 ? '700 ' : '600 ') + px + 'px ' + RAJ;
  }
  /* Mint for "good", the one green-ish hue the palette allows: the lead, a
     save, a ready ability. The old lime (#54ff4b) was the only colour on the
     screen that belonged to no other part of the game. */
  const MINT = '#5affc0';

  /* ================================================== THE SPEED CLUSTER ==
   *
   * The instrument in the bottom-right corner, drawn after the reference
   * the art direction asked for: a dark glass dial whose swept sector is
   * filled with light rather than marked by a line, crisp white ticks and
   * figures, a thin bright needle on a ring hub, two curved pills either side
   * - revs on the left, the boost reserve on the right - a row of shift
   * lights over the top and the reading itself set large in a trapezoid
   * window under the dial.
   *
   * IT REPLACED THREE INSTRUMENTS. The dial, the DRIVETRAIN scope that held
   * the gear and the revs, and the boost bar across the bottom centre of the
   * frame - which sat on exactly the part of the picture the chase camera
   * puts the car in. One cluster, read in one glance, is what every racing
   * game that feels finished does; three instruments in three corners is
   * what one that is still being assembled does.
   *
   * IT DOES NOT BLUR ANYTHING AT RUNTIME. Every glow on it is either part of
   * the cached face or a pre-rendered sprite blitted through a clip - the
   * old dial drew forty-odd shadow-blurred strokes a frame, and on the
   * integrated graphics this game is most often played on, each one of those
   * is a separate raster pass competing with the 3D. See Hud.cluster. */
  const CL = { x: 482, y: -222, r: 86 };
  /* Two hundred and forty degrees, with the gap at the bottom - where the
     needle never points, and so where the gear and the readout can live. */
  const CL_A0 = Math.PI * (150 / 180), CL_A1 = Math.PI * (390 / 180);
  const CL_HOT = 0.86;
  /* The pills, as fractions of the dial radius and angles in radians. Each
     runs from its BOTTOM end to its TOP end, which is the way both fill. */
  const CL_PILL = { r: 1.235, w: 0.088 };
  const CL_PILL_L = [Math.PI * (156 / 180), Math.PI * (204 / 180)];
  const CL_PILL_R = [Math.PI * (24 / 180), Math.PI * (-24 / 180)];
  /* THE RIGHT-HAND PILL IS THE GEARBOX, foot to top: reverse, neutral and
     the seven forward ratios the core's box has (GEARS in vehicle.rs), the
     engaged one lit - the column the reference cluster carries beside its
     dial. It used to be a ten-cell boost pill, and that was a SECOND boost
     readout with a different count from the bar: the reserve has always been
     read in the bar's twenty-four cells (BST), and story chapters are tuned
     against that count, so the bar is the only place it is shown. */
  const CL_GEARS = ['R', 'N', '1', '2', '3', '4', '5', '6', '7'];
  /* What the box is in, as a driver would read it. The core's `gear` is the
     forward ratio and is never zero, so reverse is read off the car moving
     backwards and neutral off a car at rest with no load on the engine -
     which is the grid, and the moment after a stop. */
  function gearLabel(car) {
    if ((car.vLong || 0) < -0.6) return 'R';
    if (Math.abs(car.speed || 0) < 0.4 && (car.engineLoad || 0) < 0.05) return 'N';
    return String(Math.max(1, car.gear | 0));
  }
  /* Shift lights, along the top. */
  const CL_LEDS = 9, CL_LED0 = Math.PI * (236 / 180), CL_LED1 = Math.PI * (304 / 180), CL_LED_R = 1.255;
  /* The window under the dial: top and bottom edges as fractions of the
     radius below the centre, and the two widths. */
  const CL_TRAP = { top: 0.90, bot: 1.27, wTop: 1.36, wBot: 1.02 };

  /* THE MAP, on the left flank directly over the DRIVETRAIN panel, so the
     bottom-left is one stack of instruments: where the road goes, then what
     the engine is doing. It sat in the corner itself until the DRIVETRAIN
     panel came back to the slot it always had. `carY` is how far below the
     centre the car sits as a fraction of the radius, so most of the disc is
     road AHEAD; `ahead` and `behind` are world units. The integrity rail runs
     up the side of the map that faces the middle of the frame, from its
     bottom end (p0) to its top (p1). */
  /* THE DRIVETRAIN PANEL, back in the bottom-left slot it has always had:
     centre, size and the lean of its glass. */
  const DT = { x: -444, y: -272, w: 216, h: 58, s: 12 };

  const MM = {
    x: -484, y: -158, r: 62, carY: 0.36, ahead: 1400, behind: 420,
    pill: 1.155, p0: Math.PI * (32 / 180), p1: Math.PI * (-32 / 180),
  };

  // The chrome ramp the 80s logo treatment is built on: white highlight,
  // violet mid, a hard specular break, then warm gold into magenta.
  const CHROME = [
    [0.00, '#ffffff'], [0.30, '#c8b8ff'], [0.47, '#5b3fb8'],
    [0.50, '#2a1650'], [0.53, '#ffd977'], [0.72, '#ff5fb0'], [1.00, '#7a1f6b'],
  ];

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

  /* Blend two colours that may be #rrggbb OR the rgb() string mixHex itself
     returns. The ramp chains - violet into the state colour, then that into
     the hot colour - and the second link is handed the first link's output,
     which mixHex cannot parse. */
  function mixHex2(a, b, t) {
    const rd = (c) => {
      if (c[0] === '#') {
        /* Three-digit shorthand is expanded rather than parsed as a number:
           #fff is 4095, and 4095 read as three bytes is a dark blue. */
        const h = c.length === 4 ? c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c.slice(1, 7);
        const p = parseInt(h, 16);
        return [(p >> 16) & 255, (p >> 8) & 255, p & 255];
      }
      /* Read without a regular expression, so the two brackets cannot be
         mistaken for a capture group by anything that rewrites this file. */
      const o = c.indexOf('('), e = c.indexOf(')', o + 1);
      if (o < 0 || e < 0) return [255, 255, 255];
      const v = c.slice(o + 1, e).split(',').map(x => parseFloat(x) | 0);
      return v.length >= 3 ? v : [255, 255, 255];
    };
    const pa = rd(a), pb = rd(b);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return 'rgb(' + Math.round(pa[0] * (1 - t) + pb[0] * t) + ','
      + Math.round(pa[1] * (1 - t) + pb[1] * t) + ','
      + Math.round(pa[2] * (1 - t) + pb[2] * t) + ')';
  }

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
  /* The same clock as a race clock is written: minutes, seconds, and the
     hundredths after a point. fmtTime keeps its colons because the shipped
     seven-segment face has no point glyph and the screens that still use it
     depend on that. */
  function fmtClock(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const c = Math.floor((sec * 100) % 100);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(m) + ':' + p(s) + '.' + p(c);
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

  /* ------------------------------------------------- THE GLOW, AND FONTS --
   *
   * Two things this file does on nearly every call, both of which are far
   * more expensive than they look, and both of which are now answered once.
   *
   * SHADOW BLUR IS A SEPARATE RENDER. Setting `shadowBlur` and then filling
   * anything makes the 2D context rasterise the shape, blur it in a scratch
   * surface and composite the result underneath - per call. This file does
   * that forty-odd times a frame, over a canvas that is the size of the
   * window times the device pixel ratio, and it is the whole of what the HUD
   * costs the CPU. It is also exactly what makes the interface look like it
   * is made of light, so it is not something to simply delete: it is
   * something to put a control on.
   *
   * `GLOW` scales every blur radius in the file. At 0 the assignment is a
   * literal zero and the context skips the blur path entirely - the interface
   * is drawn flat, sharp and cheap. At 1 it is what it always was, and above
   * that the neon opens up for a machine that can afford it. See the HUD GLOW
   * row in js/settings.js.
   *
   * A BLUR RADIUS ALSO HAS TO STAY A RADIUS. It is in device pixels, so it
   * already scales with the canvas - `gb` only ever applies the player's
   * multiplier and never touches the layout.
   */
  let GLOW = 1;
  const gb = (px) => px * GLOW;

  /* ASSIGNING `font` PARSES A CSS FONT SHORTHAND. Every `label` call built a
     fresh string and assigned it, and the HUD draws dozens of labels a frame
     at a handful of distinct sizes - so the same half-dozen strings were
     rebuilt and re-parsed a few hundred times a second. The cache lives on
     the context because there are two of them, the live canvas and the
     scratch buffer the tinted digits are recoloured in, and they carry
     independent state. */
  function setFont(c, str) {
    if (c.__f === str) return;
    c.__f = str;
    c.font = str;
  }

  /* ...AND THE CACHE HAS TO FORGET, at the two places the context puts the
     font back without being asked.
   *
   * `restore()` pops the whole 2D state, font included, so a cache that
   * survived one would report a typeface the context no longer has - and the
   * symptom is the worst kind: the NEXT label, at a size that happens to
   * match the cached string, silently draws at whatever size was current
   * before the save. Every primitive in this file sets its font inside a
   * save/restore pair, so that is every label after the first.
   *
   * Resizing the backing store is the other one: assigning `width` or
   * `height` resets the context to its defaults outright. See `resize` and
   * the scratch buffer in `digits`.
   *
   * Clearing is conservative - the worst it costs is one assignment that was
   * not strictly needed - and it is the only version of this that cannot be
   * wrong. */
  function hRestore(c) { c.restore(); c.__f = ''; }

  /* ORBITRON'S FIGURES ARE PROPORTIONAL. A '1' is 391 units wide and an '8'
     is 834, the face has no tabular feature to ask for, and its licence
     reserves the name, so it cannot be rebuilt with one the way Rajdhani was.
     Set plainly, a number that changes - a speed, a clock, a gap - shuffles
     sideways on every tick.
   *
   * So a string with a figure in it, in an Orbitron role, is laid out here:
   * each digit centred in a cell as wide as the widest, and the words between
   * them set whole, so they keep their kerning. Everything is measured with
   * whatever tracking the context has, so a tracked readout keeps its rhythm.
   * The ten figures' widths are kept per font; the words are measured live,
   * and are few. */
  const TAB = new Map();
  const HAS_DIGIT = /[0-9]/;
  const tabular = (kind, s) => kind !== 'body' && kind !== 'row' && kind !== 'numL' && HAS_DIGIT.test(s);
  function tabDigits(c) {
    const key = (c.__f || c.font) + '|' + (c.letterSpacing || '');
    let d = TAB.get(key);
    if (!d) {
      d = new Array(11);
      let cell = 0;
      for (let i = 0; i < 10; i++) {
        d[i] = c.measureText(String(i)).width;
        if (d[i] > cell) cell = d[i];
      }
      d[10] = cell;
      if (TAB.size > 96) TAB.clear();
      TAB.set(key, d);
    }
    return d;
  }
  /* Walk `s` from x = 0, handing each piece and its left edge to `put`, and
     return the whole advance. Without `put` it only measures. */
  function tabRun(c, s, put) {
    const d = tabDigits(c);
    let x = 0, run = '';
    for (let i = 0; i <= s.length; i++) {
      const ch = i < s.length ? s.charCodeAt(i) : -1;
      const dig = ch >= 48 && ch <= 57;
      if (ch < 0 || dig) {
        if (run) {
          if (put) put(run, x);
          x += c.measureText(run).width;
          run = '';
        }
        if (dig) {
          if (put) put(s[i], x + (d[10] - d[ch - 48]) / 2);
          x += d[10];
        }
      } else run += s[i];
    }
    return x;
  }
  /* Fill - or stroke - `s` laid out tabular, aligned on (x, y) as the
     context's own fillText would have aligned it. */
  function tabText(c, s, x, y, align, stroke) {
    const was = c.textAlign;
    c.textAlign = 'left';
    const w = tabRun(c, s);
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    if (stroke) tabRun(c, s, (p, dx) => c.strokeText(p, x0 + dx, y));
    else tabRun(c, s, (p, dx) => c.fillText(p, x0 + dx, y));
    c.textAlign = was;
    return w;
  }

  /* ------------------------------------------------ THE GLOW SPRITE CACHE --
   *
   * WHAT THE HUD SPENDS ITS FRAME ON. Nearly every word on it is a fillText
   * with a shadow blur under it - a label is one blur, a neon title is two, a
   * panel is a large drop shadow and a glowing stroke - and the canvas is
   * cleared and redrawn whole sixty times a second. The words do not change:
   * SCORE, GEAR, BOOST, the rows of the options screen, the frame of a card
   * are the same pixels in the same place on every one of those frames.
   * Where the 2D context is on the GPU (WebView2, WebKitGTK from 2.46) every
   * blur is two more render passes competing with the 3D for the same weak
   * card; where it is on the CPU it is a software Gaussian over the bounding
   * box. Either way it is work whose answer is already known.
   *
   * So a label, a neon title or a finished panel that is asked for TWICE IN A
   * ROW with exactly the same text, font, colour, glow, opacity and sub-pixel
   * position is drawn once into a sprite of its own and blitted from then on.
   *
   * IT IS THE SAME PICTURE, NOT A LOOKALIKE. The sprite is drawn with the
   * same fractional device-pixel offset the live call would have had, and is
   * blitted one-to-one at a whole device pixel, so the glyphs rasterise onto
   * exactly the same grid. The caller's opacity is baked INTO the sprite
   * rather than applied to it, and source-over is associative: compositing
   * the pre-built group gives what drawing its layers would have, to within
   * the last bit of rounding. Anything that is moving, fading, rotated or
   * composited any other way changes its key every frame, never reaches the
   * second sighting, and is drawn exactly as it always was.
   *
   * Nothing is cached until the typefaces have loaded - a sprite built from
   * the fallback font would outlive it - and anything unused for a couple of
   * seconds is dropped, as is everything on a resize. */
  const GLYPH_AREA = 8e6;       // device pixels the cache may hold in total
  const GLYPH_IDLE = 150;       // frames a sprite may go unused before it goes
  const GLYPH_BIG = 3e6;        // a single sprite larger than this is not kept

  /* NOTHING ON THIS CANVAS IS A BITMAP ANY MORE. The interface used to load
     two atlas sheets out of the pack (the shipped HUD's sprites, laid out by
     the widget tree in data/game_data.js) and a 7-segment digit face, and by
     the end the only thing still drawing from them was a chase meter that is
     authored switched off. Every instrument is drawn, so the sheets, the face
     and the layout data are gone from the pack and the page. */
  class Hud {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = 1;
      this.toasts = [];
    }

    load() {
      /* THE FACES, ASKED FOR BY NAME. A preload link puts the file in the
         cache; it does not make the face available to a canvas, which only
         asks for a typeface on the first frame that sets one - and draws that
         frame, and every frame until the file is decoded, in the fallback.
         Loading them here means the instruments' first frame is already set
         in the face it was designed in. Never fatal: a failure leaves the
         fallback, which is still legible. */
      const faces = [];
      try {
        const F = global.document && global.document.fonts;
        if (F && F.load) {
          for (const f of ['700 20px "Rajdhani"', '600 20px "Rajdhani"', '20px "Share Tech Mono"',
            '600 20px "Orbitron"', '900 20px "Orbitron"']) {
            faces.push(F.load(f).catch(() => null));
          }
        }
      } catch (e) { /* no font loading API: the fallback is drawn */ }
      return Promise.all(faces);
    }

    resize(w, h, dpr) {
      /* NOTHING CHANGED IS NOT A RESIZE.
       *
       * Assigning `width` or `height` reallocates the backing store and
       * clears it, whether or not the number is different. That was harmless
       * while this was only called from a window resize; it is not now that
       * the adaptive scaler calls Game.onResize whenever it moves a step -
       * the WINDOW has not changed on those frames, so this would throw away
       * and rebuild a full-resolution 2D surface, reset the context, and
       * blank the interface for the frame, several times a minute, for no
       * reason at all. */
      const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
      if (this.canvas.width === cw && this.canvas.height === ch
          && this.w === w && this.h === h && this.dpr === dpr) return;
      this.dpr = dpr;
      this.canvas.width = cw;
      this.canvas.height = ch;
      // assigning width or height resets the 2D state to its defaults - see
      // the note on hRestore
      this.ctx.__f = '';
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.w = w; this.h = h;
      // every sprite was built for the old scale and pixel ratio
      if (this.glyphs) this.dropGlyphs();
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

    /* How far the interface glows, from the HUD GLOW row. 0 draws it flat and
       skips the blur path in the 2D context altogether, which is the single
       largest thing the HUD costs a CPU; 1 is the shipped look. See the note
       on `gb` at the top of this file. */
    setGlow(scale) { GLOW = scale === undefined ? 1 : Math.max(0, scale); }

    // ------------------------------------------------- the sprite cache --
    /* Once a frame, from draw(): age the cache, roll the sightings over, and
       switch it on the first time the typefaces are known to be loaded. */
    glyphFrame() {
      const G = this.glyphs || (this.glyphs = {
        on: false, frame: 0, map: new Map(), area: 0,
        now: new Set(), prev: new Set(), probe: null,
      });
      G.frame++;
      const t = G.prev; G.prev = G.now; G.now = t; t.clear();
      if (!G.on && G.frame % 15 === 1) {
        try {
          const f = global.document.fonts;
          G.on = !!(f && f.status === 'loaded'
            && f.check('900 16px "Orbitron"') && f.check('600 16px "Orbitron"')
            && f.check('700 16px "Rajdhani"') && f.check('600 16px "Rajdhani"')
            && f.check('16px "Share Tech Mono"'));
        } catch (e) { G.on = false; }
      }
      if (G.frame % 30 === 0) {
        for (const [key, e] of G.map) {
          if (G.frame - e.used > GLYPH_IDLE) { G.area -= e.cv.width * e.cv.height; G.map.delete(key); }
        }
      }
    }

    dropGlyphs() {
      const G = this.glyphs;
      if (!G) return;
      G.map.clear(); G.area = 0; G.now.clear(); G.prev.clear();
    }

    /* Whether the context is in the one state a sprite can stand in for: the
       HUD's own transform, plain source-over, no offset shadow inherited. */
    glyphReady(c) {
      const G = this.glyphs;
      if (!G || !G.on || c.globalCompositeOperation !== 'source-over'
          || c.shadowOffsetX || c.shadowOffsetY) return false;
      if (c.filter !== undefined && c.filter !== 'none') return false;
      const m = c.getTransform();
      return m.a === this.dpr && m.d === this.dpr && m.b === 0 && m.c === 0
        && m.e === 0 && m.f === 0;
    }

    /* Serve the thing described by `this.gp` - one reused object, so a hit
       allocates nothing but its key - from the cache, and blit it with its
       origin at CSS (sx, sy). On its second sighting it is built: painted into
       a sprite whose transform puts its origin on the same sub-pixel it would
       have had on the canvas. False means "draw it yourself". */
    glyphBlit(key, sx, sy) {
      const G = this.glyphs, c = this.ctx, dpr = this.dpr;
      const dx = sx * dpr, dy = sy * dpr;
      const ix = Math.floor(dx), iy = Math.floor(dy);
      const fx = dx - ix, fy = dy - iy;
      const full = key + '@' + Math.round(fx * 64) + ',' + Math.round(fy * 64);
      let e = G.map.get(full);
      if (!e) {
        if (!G.prev.has(full)) { G.now.add(full); return false; }
        const ext = this.glyphExt(this.gp);
        const ox = Math.ceil(ext[0] * dpr) + 2, oy = Math.ceil(ext[1] * dpr) + 2;
        const W = ox + Math.ceil(ext[2] * dpr) + 2, H = oy + Math.ceil(ext[3] * dpr) + 2;
        if (!(W > 0 && H > 0) || W * H > GLYPH_BIG) return false;
        if (G.area + W * H > GLYPH_AREA) this.dropGlyphs();
        const cv = global.document.createElement('canvas');
        cv.width = W; cv.height = H;
        const s = cv.getContext('2d');
        if (!s) return false;
        s.setTransform(dpr, 0, 0, dpr, ox + fx, oy + fy);
        this.glyphPaint(s, this.gp);
        e = { cv, ox, oy, used: G.frame };
        G.map.set(full, e);
        G.area += W * H;
      }
      e.used = G.frame;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.shadowBlur = 0;
      c.drawImage(e.cv, ix - e.ox, iy - e.oy);
      hRestore(c);
      return true;
    }

    /* How far a cached thing's ink can reach from its origin, in CSS pixels:
       left, up, right, down. Text is measured; a panel is its own box plus
       its drop shadow. Only ever asked when a sprite is being built. */
    glyphExt(p) {
      if (p.kind === 'P') {
        const pad = p.drop * 2 + p.glow * 2 + 4;
        return [pad, pad, p.W + pad, p.H + pad + p.dropY];
      }
      const G = this.glyphs;
      const q = G.probe || (G.probe = global.document.createElement('canvas').getContext('2d'));
      q.font = p.font;
      q.textAlign = p.align;
      q.textBaseline = 'middle';
      const m = q.measureText(p.txt);
      const w = m.width;
      const l = m.actualBoundingBoxLeft !== undefined ? m.actualBoundingBoxLeft
        : (p.align === 'center' ? w / 2 : p.align === 'right' ? w : 0);
      const r = m.actualBoundingBoxRight !== undefined ? m.actualBoundingBoxRight : w - l;
      const u = m.actualBoundingBoxAscent !== undefined ? m.actualBoundingBoxAscent : p.px * 0.75;
      const d = m.actualBoundingBoxDescent !== undefined ? m.actualBoundingBoxDescent : p.px * 0.75;
      // a blur of b reaches about 1.5b device pixels; this is comfortably past it
      const pad = Math.max(p.b1, p.b2) * 2 + p.px * 0.12 + 3;
      return [Math.max(0, l) + pad, Math.max(0, u) + pad, Math.max(0, r) + pad, Math.max(0, d) + pad];
    }

    /* Paint a cached thing into its sprite, with its origin at (0, 0). These
       are the SAME calls, in the same order, as the live paths below - the
       sprite is that drawing, done once. */
    glyphPaint(s, p) {
      if (p.kind === 'P') {
        s.globalAlpha = p.a;
        this.panelBody(s, 0, 0, p.W, p.H, p.cut, p.col, p.fa);
        return;
      }
      s.globalAlpha = p.a;
      s.font = p.font;
      s.textAlign = p.align;
      s.textBaseline = 'middle';
      s.shadowColor = p.color;
      s.shadowBlur = p.b1;
      s.fillStyle = p.color;
      s.fillText(p.txt, 0, 0);
      if (p.kind === 'N') {
        s.shadowBlur = p.b2;
        s.fillText(p.txt, 0, 0);
        s.shadowBlur = 0;
        s.fillStyle = '#ffffff';
        s.globalAlpha = p.a2;
        s.fillText(p.txt, 0, 0);
      }
    }

    /** The one parameter block the cache reads from; see glyphBlit. */
    get gp() {
      return this._gp || (this._gp = {
        kind: '', txt: '', font: '', align: '', color: '', px: 0, b1: 0, b2: 0, a: 1, a2: 1,
        W: 0, H: 0, cut: 0, col: '', fa: 0, drop: 0, dropY: 0, glow: 0,
      });
    }

    // -------------------------------------------------------- primitives --
    label(txt, x, y, size, color, align, weight, alpha) {
      const c = this.ctx;
      const font = uiFont(this.vs(size), weight);
      /* A breath of light, not a halo: a label is read, not looked at. */
      const blur = gb(this.vs(size) * 0.24);
      if (this.glyphReady(c)) {
        const p = this.gp;
        p.kind = 'L';
        p.txt = String(txt);
        p.font = font;
        p.align = align || 'left';
        p.color = color;
        p.px = this.vs(size);
        p.b1 = blur; p.b2 = 0;
        // an opacity the caller set, or the one it inherited: baked in either way
        p.a = alpha !== undefined ? alpha : c.globalAlpha;
        const key = 'L|' + p.txt + '|' + font + '|' + p.align + '|' + color + '|' + blur + '|' + p.a;
        if (this.glyphBlit(key, this.vx(x), this.vy(y))) return;
      }
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      setFont(c, font);
      c.textAlign = align || 'left';
      c.textBaseline = 'middle';
      c.shadowColor = color;
      c.shadowBlur = blur;
      c.fillStyle = color;
      c.fillText(txt, this.vx(x), this.vy(y));
      hRestore(c);
    }

    // ------------------------------------------- retro-futuristic bits --

    /** Chrome-ramp headline with an outer neon glow and a bevelled edge.
     *
     * `glint` is an optional 0..1 position for a specular band travelling
     * across the letters, and it is the one thing a chrome logo does that a
     * gradient cannot: a ramp is a still, and what makes chrome read as METAL
     * is a highlight moving over it. It is drawn as another fill of the same
     * text with a mostly-transparent gradient, so it is clipped to the glyphs
     * for free and costs one more fillText - there is no text-to-path in a 2D
     * context, and compositing it any other way would paint through the road
     * underneath.
     *
     * Undefined, or outside 0..1, means no glint at all. Only the title screen
     * asks for one: a story card that is on screen for two seconds should not
     * be waiting for a highlight to cross it. */
    chrome(txt, x, y, size, glow, alpha, glint) {
      const c = this.ctx;
      const px = this.vs(size);
      const sx = this.vx(x), sy = this.vy(y);
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      setFont(c, '900 ' + px + 'px "Orbitron", system-ui, sans-serif');
      c.textAlign = 'center';
      c.textBaseline = 'middle';

      // bloom halo underneath
      c.shadowColor = glow || PINK;
      c.shadowBlur = gb(px * 0.7);
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

      /* The specular band, before the cut lines so they slice it too - a
         highlight that runs over the gaps in the logo is a highlight sitting
         on top of it rather than in it. */
      if (glint >= 0 && glint <= 1) {
        const band = 0.13;
        const lo = Math.max(0, Math.min(1, glint - band));
        const hi = Math.max(0, Math.min(1, glint + band));
        const mid = Math.max(lo, Math.min(hi, glint));
        const sweep = c.createLinearGradient(sx - w / 2 - 6, 0, sx + w / 2 + 6, 0);
        sweep.addColorStop(0, 'rgba(255,255,255,0)');
        if (lo > 0) sweep.addColorStop(lo, 'rgba(255,255,255,0)');
        sweep.addColorStop(mid, 'rgba(255,255,255,0.78)');
        if (hi < 1) sweep.addColorStop(hi, 'rgba(255,255,255,0)');
        sweep.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = sweep;
        c.fillText(txt, sx, sy);
      }
      c.globalCompositeOperation = 'destination-out';
      const step = Math.max(2, px * 0.11);
      for (let ly = sy - px * 0.55; ly < sy + px * 0.55; ly += step) {
        c.fillStyle = 'rgba(0,0,0,0.5)';
        c.fillRect(sx - w / 2 - 4, ly, w + 8, Math.max(1, px * 0.022));
      }
      c.globalCompositeOperation = 'source-over';
      hRestore(c);
    }

    /** Text with a wide outer glow and a bright core - a neon tube. */
    neon(txt, x, y, size, color, align, weight, alpha) {
      const c = this.ctx;
      const px = this.vs(size);
      if (this.glyphReady(c)) {
        const p = this.gp;
        p.kind = 'N';
        p.txt = String(txt);
        p.font = uiFont(px, weight || 800);
        p.align = align || 'center';
        p.color = color;
        p.px = px;
        p.b1 = gb(px * 0.85); p.b2 = gb(px * 0.35);
        p.a = alpha !== undefined ? alpha : c.globalAlpha;
        // the white core's opacity is absolute here, exactly as below
        p.a2 = (alpha === undefined ? 1 : alpha) * 0.55;
        const key = 'N|' + p.txt + '|' + p.font + '|' + p.align + '|' + color + '|'
          + p.b1 + '|' + p.b2 + '|' + p.a + '|' + p.a2;
        if (this.glyphBlit(key, this.vx(x), this.vy(y))) return;
      }
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      setFont(c, uiFont(px, weight || 800));
      c.textAlign = align || 'center';
      c.textBaseline = 'middle';
      const sx = this.vx(x), sy = this.vy(y);
      c.shadowColor = color;
      c.shadowBlur = gb(px * 0.85);
      c.fillStyle = color;
      c.fillText(txt, sx, sy);
      c.shadowBlur = gb(px * 0.35);
      c.fillText(txt, sx, sy);
      c.shadowBlur = 0;
      c.fillStyle = '#ffffff';
      c.globalAlpha = (alpha === undefined ? 1 : alpha) * 0.55;
      c.fillText(txt, sx, sy);
      hRestore(c);
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
        hRestore(c);
        // ...and a colour wash over it, so the blur reads as glass rather than
        // as a mistake, and the type on top of it has a floor to sit on
        c.save();
        c.fillStyle = tint || 'rgba(7,2,22,0.62)';
        c.fillRect(0, 0, this.w, this.h);
        hRestore(c);
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
      const a = fillA === undefined ? 0.78 : fillA;
      /* A card that has ARRIVED is the same picture every frame - the options
         panel, the pause card, the BEST readout - and it is the most expensive
         single thing the interface draws: a wide drop shadow under its whole
         area and a glowing stroke round it. See the glow sprite cache. Its
         opacity is set, not inherited, so it goes into the key as `k`. */
      if (this.glyphReady(c)) {
        const p = this.gp;
        p.kind = 'P';
        p.W = W; p.H = H; p.cut = cut; p.col = col; p.fa = a; p.a = k;
        p.drop = gb(this.vs(26)); p.dropY = this.vs(8); p.glow = gb(this.vs(12));
        const key = 'P|' + W + '|' + H + '|' + col + '|' + a + '|' + k + '|' + p.drop + '|' + p.glow;
        if (this.glyphBlit(key, X, Y)) return;
      }
      c.save();
      c.globalAlpha = k;
      this.panelBody(c, X, Y, W, H, cut, col, a);
      hRestore(c);
    }

    /* The panel itself, into any context, with its top-left at (X, Y). The
       caller owns the save, the opacity and the restore. */
    panelBody(c, X, Y, W, H, cut, col, a) {
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
        c.shadowBlur = gb(this.vs(26));
        c.shadowOffsetY = this.vs(8);
        path();
        c.fillStyle = 'rgba(0,0,0,' + drop.toFixed(3) + ')';
        c.fill();
        hRestore(c);
      }

      /* GLASS, GRADED. Deep indigo at the top into near-black, the way the
         cluster's glass is - and no scanline wash: it was the one texture in
         the interface that made a card read as a screenshot of an old
         monitor rather than as a pane in front of the road. */
      const g = c.createLinearGradient(0, Y, 0, Y + H);
      g.addColorStop(0, 'rgba(26,16,60,' + Math.min(1, a * 1.06).toFixed(3) + ')');
      g.addColorStop(0.5, 'rgba(12,6,34,' + a.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(5,2,16,' + Math.min(1, a * 1.06).toFixed(3) + ')');
      path();
      c.fillStyle = g;
      c.fill();

      c.save();
      path();
      c.clip();
      // light falling on the upper face, in the panel's colour
      const inner = c.createLinearGradient(0, Y, 0, Y + this.vs(60));
      inner.addColorStop(0, this._alpha(col, 0.16));
      inner.addColorStop(1, this._alpha(col, 0));
      c.fillStyle = inner;
      c.fillRect(X, Y, W, this.vs(60));
      const sheen = c.createLinearGradient(0, Y, 0, Y + H * 0.5);
      sheen.addColorStop(0, 'rgba(255,255,255,0.07)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = sheen;
      c.fillRect(X, Y, W, H * 0.5);
      hRestore(c);

      /* THE BEVEL: chrome along the top edge into the accent down the sides,
         a hairline and not a glowing tube - and a short bar of solid accent
         along the top from the cut corner, which is the panel's colour said
         once rather than drawn round everything. */
      const rim = c.createLinearGradient(0, Y, 0, Y + H);
      rim.addColorStop(0, 'rgba(240,236,255,0.70)');
      rim.addColorStop(0.35, this._alpha(col, 0.70));
      rim.addColorStop(1, this._alpha(col, 0.45));
      c.strokeStyle = rim;
      c.lineWidth = Math.max(1, this.vs(1.3));
      c.shadowColor = col;
      c.shadowBlur = gb(this.vs(5));
      path();
      c.stroke();
      c.shadowBlur = 0;
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(X + cut, Y - this.vs(1));
      c.lineTo(X + cut + W * 0.22, Y - this.vs(1));
      c.lineTo(X + cut + W * 0.22 - this.vs(4), Y + this.vs(3));
      c.lineTo(X + cut - this.vs(4), Y + this.vs(3));
      c.closePath();
      c.fill();
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
      c.shadowBlur = gb(this.vs(8));
      c.beginPath();
      c.moveTo(X, Y + L); c.lineTo(X, Y); c.lineTo(X + L, Y);
      c.moveTo(X + W - L, Y); c.lineTo(X + W, Y); c.lineTo(X + W, Y + L);
      c.moveTo(X + W, Y + H - L); c.lineTo(X + W, Y + H); c.lineTo(X + W - L, Y + H);
      c.moveTo(X + L, Y + H); c.lineTo(X, Y + H); c.lineTo(X, Y + H - L);
      c.stroke();
      hRestore(c);
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
      const { x, y, w, h, s: S } = DT;
      /* TWO INSTRUMENTS, TWO CELLS.
       The trace ran the full width of the glass and the gear numeral was
       printed on top of it, in the middle, which is exactly where the
       waveform is loudest - so the one number a driver reads at a glance was
       the one thing on the panel with a moving background. The panel is
       divided: the scope has the left of it and the gearbox has a cell of
       its own on the right, behind a rule that leans the way the glass does. */
      const SCOPE = 0.64;
      const col = car.boosting ? '#ff3ca8' : '#39e6ff';
      const flash = car.shiftFlash || 0;
      const rev = Math.max(0, Math.min(1, car.rpm || 0));

      /* THE GLASS is the instruments' plate - the same skewed, bevelled,
         graded panel every new readout stands on - with the accent down its
         leading edge in the colour of what the engine is doing. Two cached
         layers, one per colour; nothing on it is blurred. */
      this.plate(x, y, w, h, col, 1, S, 0.62);
      const L = x - w / 2, T = y + h / 2, Bm = y - h / 2;
      const x0 = L + w * SCOPE;              // where the gear cell starts, at the foot

      // the scope's cell, in screen space: a rectangle inside the lean
      const SX = this.vx(L + S + 3), SY = this.vy(T - 3);
      const SW = this.vs(x0 - (L + S + 3) - 2), SH = this.vs(h - 6);
      c.save();
      c.beginPath();
      c.rect(SX, SY, SW, SH);
      c.clip();
      // graticule
      c.strokeStyle = 'rgba(160,220,255,0.10)';
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 1; i < 6; i++) {
        const gx = SX + SW * (i / 6);
        c.moveTo(gx, SY); c.lineTo(gx, SY + SH);
      }
      const mid = SY + SH * 0.60;
      c.moveTo(SX, mid); c.lineTo(SX + SW, mid);
      c.stroke();

      /* The trace. Engine speed sets the pitch, throttle and wheelspin set how
         hard it is driven, and it scrolls with road speed - so it settles to a
         flat line at a standstill and screams at the limiter. */
      const load = Math.max(0, Math.min(1, car.engineLoad || 0));
      const amp = SH * (0.06 + 0.26 * load + 0.10 * (car.wheelSpinFx || 0)
        + 0.08 * (car.driftAmount || 0));
      const freq = 5 + rev * 26;
      const scroll = g.time * (2.0 + rev * 9.0);
      const N = 96;
      c.beginPath();
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const px = SX + SW * t;
        const ph = t * freq + scroll;
        // two beating partials plus a rasp that comes in with the revs: a
        // single sine reads as a test tone, not as an engine
        const v = Math.sin(ph) * 0.62
          + Math.sin(ph * 2.13 + 1.7) * 0.26 * (0.3 + rev)
          + Math.sin(ph * 5.7 + 0.4) * 0.14 * rev;
        // and it fades in from each end, as a scope trace does
        const env = Math.sin(t * Math.PI);
        if (i === 0) c.moveTo(px, mid - v * amp * env);
        else c.lineTo(px, mid - v * amp * env);
      }
      /* Lit without a blur: the same path stroked wide and faint, then as the
         line, then as a white filament down its middle. */
      c.lineJoin = 'round';
      c.strokeStyle = col;
      c.globalAlpha = 0.16;
      c.lineWidth = Math.max(2, this.vs(5));
      c.stroke();
      c.globalAlpha = 1;
      c.lineWidth = Math.max(1, this.vs(1.6));
      c.stroke();
      c.globalAlpha = 0.55;
      c.strokeStyle = '#ffffff';
      c.lineWidth = Math.max(1, this.vs(0.7));
      c.stroke();
      hRestore(c);

      /* THE GEAR CELL: its own darker ground behind a leaning rule, so the
         numeral is read against a flat surface rather than the waveform. */
      c.save();
      c.beginPath();
      c.moveTo(this.vx(x0 + S), this.vy(T - 1.5));
      c.lineTo(this.vx(L + w - 1.5), this.vy(T - 1.5));
      c.lineTo(this.vx(L + w - S - 1.5), this.vy(Bm + 1.5));
      c.lineTo(this.vx(x0), this.vy(Bm + 1.5));
      c.closePath();
      c.fillStyle = 'rgba(4,2,16,0.55)';
      c.fill();
      c.strokeStyle = 'rgba(150,200,255,0.34)';
      c.lineWidth = Math.max(1, this.vs(1));
      c.beginPath();
      c.moveTo(this.vx(x0 + S - 1), this.vy(T - 4));
      c.lineTo(this.vx(x0 + 1), this.vy(Bm + 4));
      c.stroke();
      hRestore(c);

      this.t('DRIVETRAIN', L + S + 8, T - 9, 9.5, 'rgba(160,220,255,0.80)', 'left', 'lab', 1, 0.22);

      /* The gearbox, in the instrument that is already showing what the
         gearbox is doing. It goes magenta for the beat after a shift and at
         the upshift point, and reads R and N as a gear lever would. */
      const gx = (x0 + S / 2 + L + w - S / 2) / 2;
      const hotGear = flash > 0.05 || rev >= 0.92;
      this.t('GEAR', gx, T - 9, 9, 'rgba(160,220,255,0.66)', 'center', 'lab', 1, 0.22);
      this.hero(gearLabel(car), gx, y - 5, 33 + flash * 6, hotGear ? '#ff6ac0' : '#ffffff',
        'center', 1, hotGear ? '#ff3ca8' : '#8a5cff', 'num');

      /* Revs along the scope's floor, with the shift point marked on it - so
         the trace above and the bar below are the same drivetrain, read two
         ways. The bar goes hot at the upshift, which is the cue to lift. */
      const bx = L + S + 3, bw = x0 - bx - 4, by = Bm + 6;
      this.gloss(bx + bw / 2, by, bw, 4, rev, rev > 0.90 ? '#ff2e88' : (rev > 0.78 ? '#ffb400' : '#39e6ff'));
      // the upshift point, so the bar means something
      c.save();
      c.fillStyle = 'rgba(255,255,255,0.6)';
      c.fillRect(this.vx(bx + bw * 0.90), this.vy(by + 4), Math.max(1, this.vs(1.4)), this.vs(8));
      hRestore(c);
    }

    /* ===================================================== THE NEW KIT ==
     *
     * Three primitives everything new is built from.
     *
     *   t()      text in the kit's faces, crisp. No shadow blur: a word
     *            that needs light under it gets it from the layer it sits on,
     *            which is drawn once, not from a blur redrawn every frame.
     *   tw()     how wide that text comes out, in virtual units.
     *   layer()  an offscreen canvas painted once per (key, size, pixel
     *            ratio) and blitted from then on. Every static part of an
     *            instrument goes in one - the face, the ticks, the figures,
     *            the frame - and every glow is either baked into one or is a
     *            sprite of its own.
     *
     * `alpha` MULTIPLIES what the context already has, so a group fade - the
     * menu's reveal, the cluster stepping back for a region card - reaches
     * everything inside it. The older primitives above SET it, which is why
     * they could never be faded as a group.
     */
    t(str, x, y, size, color, align, kind, alpha, track) {
      const c = this.ctx;
      const px = this.vs(size);
      const s = String(str);
      c.save();
      if (alpha !== undefined) c.globalAlpha *= Math.max(0, alpha);
      setFont(c, FACE[kind || 'lab'](px));
      if (track && 'letterSpacing' in c) c.letterSpacing = (track * px).toFixed(2) + 'px';
      c.textAlign = align || 'left';
      c.textBaseline = 'middle';
      c.fillStyle = color;
      if (tabular(kind || 'lab', s)) tabText(c, s, this.vx(x), this.vy(y), align || 'left');
      else c.fillText(s, this.vx(x), this.vy(y));
      hRestore(c);
    }

    /* Numerals in gold - pale highlight, amber body, burnt edge - with a
       hairline of dark round them so they hold over a lit road. */
    tGold(str, x, y, size, align) {
      const c = this.ctx;
      const px = this.vs(size);
      const sx = this.vx(x), sy = this.vy(y);
      const s = String(str);
      const al = align || 'left';
      c.save();
      setFont(c, FACE.num(px));
      c.textAlign = al;
      c.textBaseline = 'middle';
      c.lineJoin = 'round';
      c.strokeStyle = 'rgba(20,6,2,0.55)';
      c.lineWidth = Math.max(1, px * 0.10);
      tabText(c, s, sx, sy, al, true);
      const gr = c.createLinearGradient(0, sy - px * 0.42, 0, sy + px * 0.42);
      gr.addColorStop(0, '#fff6d2');
      gr.addColorStop(0.38, '#ffd25a');
      gr.addColorStop(0.62, '#ffad1f');
      gr.addColorStop(1, '#e06a12');
      c.fillStyle = gr;
      tabText(c, s, sx, sy, al);
      hRestore(c);
    }

    /* A headline with light round it and no blur: the same words stroked
       wide in the glow colour at a low opacity, twice, under the solid fill.
       It is what a neon tube's halo looks like at the distance a HUD is read
       from, for two strokes instead of a Gaussian over the bounding box. */
    hero(str, x, y, size, color, align, alpha, halo, kind, track) {
      const c = this.ctx;
      const px = this.vs(size);
      const sx = this.vx(x), sy = this.vy(y);
      const s = String(str);
      const al = align || 'center';
      const tab = tabular(kind || 'disp', s);
      c.save();
      if (alpha !== undefined) c.globalAlpha *= Math.max(0, alpha);
      setFont(c, FACE[kind || 'disp'](px));
      if (track && 'letterSpacing' in c) c.letterSpacing = (track * px).toFixed(2) + 'px';
      c.textAlign = al;
      c.textBaseline = 'middle';
      c.lineJoin = 'round';
      const h = halo || color;
      const base = c.globalAlpha;
      /* The halo is a property of the light, not of the letter: it reaches a
         fixed distance whatever the size of the word, so its widths are
         capped - uncapped, a 170-unit countdown figure wore a halo as wide
         as a stroke of the figure itself and read as a second, fatter copy. */
      c.strokeStyle = h;
      c.globalAlpha = base * 0.10;
      c.lineWidth = Math.min(px * 0.42, this.vs(15));
      if (tab) tabText(c, s, sx, sy, al, true); else c.strokeText(s, sx, sy);
      c.globalAlpha = base * 0.22;
      c.lineWidth = Math.min(px * 0.18, this.vs(6));
      if (tab) tabText(c, s, sx, sy, al, true); else c.strokeText(s, sx, sy);
      c.globalAlpha = base;
      c.fillStyle = color;
      if (tab) tabText(c, s, sx, sy, al); else c.fillText(s, sx, sy);
      hRestore(c);
    }

    tw(str, size, kind, track) {
      const c = this.ctx;
      const px = this.vs(size);
      const s = String(str);
      c.save();
      setFont(c, FACE[kind || 'lab'](px));
      if (track && 'letterSpacing' in c) c.letterSpacing = (track * px).toFixed(2) + 'px';
      const w = tabular(kind || 'lab', s) ? tabRun(c, s) : c.measureText(s).width;
      hRestore(c);
      return w / this.k;
    }

    /* A cached layer `wV` by `hV` virtual units, painted by `paint(c, w, h)`
       in CSS pixels with the pixel ratio already applied. Rebuilt when the
       window, the pixel ratio, the glow setting or the caller's own key
       changes, and at no other time.

       Everything before a `~` in the key names the SLOT, and the rest is
       what that slot currently holds: the dial face is one slot whose
       contents change when the scale does, so the old face is replaced
       rather than kept beside the new one. A key with no `~` is a slot of
       its own. (Not `#` - that is in every colour that goes into a key.) */
    layer(key, wV, hV, paint) {
      const L = this._layers || (this._layers = new Map());
      const full = key + '|' + this.k.toFixed(4) + '|' + this.dpr + '|' + GLOW.toFixed(2);
      const slot = key.split('~')[0];
      let e = L.get(slot);
      if (e && e.full === full) return e;
      const w = this.vs(wV), h = this.vs(hV);
      const cv = (e && e.cv) || global.document.createElement('canvas');
      cv.width = Math.max(1, Math.ceil(w * this.dpr));
      cv.height = Math.max(1, Math.ceil(h * this.dpr));
      const c = cv.getContext('2d');
      if (!c) return null;
      c.__f = '';
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      paint(c, w, h);
      e = { cv, w, h, full };
      L.delete(slot);
      L.set(slot, e);
      /* Bounded. Plates are keyed on their size, and a notification is as
         wide as its words, so the set of keys is open-ended; the oldest go
         first, which is the order a Map iterates in. */
      if (L.size > 120) {
        let n = L.size - 100;
        for (const k of L.keys()) { if (n-- <= 0) break; L.delete(k); }
      }
      return e;
    }

    /* A SKEWED GLASS PLATE, the ground every new readout stands on.
     *
     * A parallelogram leaning the way the type leans, dark glass graded from
     * top to bottom, a highlight along its upper face, and a bevelled edge
     * that runs from the accent colour through a chrome white - the detail
     * the reference bars are built on, and the one that separates a plate
     * that is ON the glass from a rectangle painted onto it. The accent is a
     * bar down the leading edge, so every plate says whose colour it is.
     *
     * Cached per size and colour; a plate that does not change is one blit. */
    plateLayer(w, h, accent, slant, fillA) {
      const W = Math.round(w), H = Math.round(h);
      const s = slant === undefined ? Math.round(H * 0.36) : slant;
      const a = fillA === undefined ? 0.82 : fillA;
      const pad = 8;
      const key = 'plate|' + W + '|' + H + '|' + accent + '|' + s + '|' + a;
      const e = this.layer(key, W + pad * 2, H + pad * 2, (c, cw, ch) => {
        const p = this.vs(pad);
        const X = p, Y = p, PW = this.vs(W), PH = this.vs(H), S = this.vs(s);
        const path = () => {
          c.beginPath();
          c.moveTo(X + S, Y);
          c.lineTo(X + PW, Y);
          c.lineTo(X + PW - S, Y + PH);
          c.lineTo(X, Y + PH);
          c.closePath();
        };
        // a soft drop under it, so it stands off the road
        c.save();
        c.shadowColor = 'rgba(0,0,0,0.55)';
        c.shadowBlur = gb(this.vs(6));
        c.shadowOffsetY = this.vs(2);
        path();
        c.fillStyle = 'rgba(6,2,18,' + (a * 0.9).toFixed(3) + ')';
        c.fill();
        c.restore();
        const gr = c.createLinearGradient(0, Y, 0, Y + PH);
        gr.addColorStop(0, 'rgba(30,18,70,' + a.toFixed(3) + ')');
        gr.addColorStop(0.55, 'rgba(14,8,38,' + a.toFixed(3) + ')');
        gr.addColorStop(1, 'rgba(6,3,20,' + Math.min(1, a + 0.06).toFixed(3) + ')');
        path();
        c.fillStyle = gr;
        c.fill();
        c.save();
        path();
        c.clip();
        const hi = c.createLinearGradient(0, Y, 0, Y + PH * 0.5);
        hi.addColorStop(0, 'rgba(255,255,255,0.13)');
        hi.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = hi;
        c.fillRect(X, Y, PW, PH * 0.5);
        // the accent down the leading edge
        c.fillStyle = accent;
        c.beginPath();
        c.moveTo(X + S, Y);
        c.lineTo(X + S + this.vs(4), Y);
        c.lineTo(X + this.vs(4), Y + PH);
        c.lineTo(X, Y + PH);
        c.closePath();
        c.fill();
        c.restore();
        const be = c.createLinearGradient(X, 0, X + PW, 0);
        be.addColorStop(0, this._alpha(accent, 0.95));
        be.addColorStop(0.45, 'rgba(232,226,255,0.50)');
        be.addColorStop(1, this._alpha(accent, 0.30));
        c.strokeStyle = be;
        c.lineWidth = Math.max(1, this.vs(1.1));
        path();
        c.stroke();
      });
      return e;
    }

    /* THE MENU BAR - the reference's bevelled bar, in the site's materials.
     *
     * Two of them. The SELECTED bar is synx-landing's primary button, the
     * PLAY row: violet glass lit from inside, a pink edge, a gold hairline
     * along its foot, scanlines across it, and the label in gold over it (see
     * `selLabel`). It keeps the reference's silhouette - the slant, and the
     * run of cells at its tail, gold now. A white band crosses it on the
     * site's own beat, drawn live by `barSweep`. The IDLE bar is the same shape
     * empty: dark glass with the site's cyan-to-violet lit edge, so a list of
     * them reads as a rack of slots with one of them lit.
     *
     * Both cached per size. A menu is drawn every frame and is the same
     * picture on nearly all of them. */
    barLayer(w, h, kind) {
      const W = Math.round(w), H = Math.round(h);
      const pad = 10;
      return this.layer('bar|' + kind + '|' + W + '|' + H, W + pad * 2, H + pad * 2, (c) => {
        const p = this.vs(pad);
        const X = p, Y = p, PW = this.vs(W), PH = this.vs(H), S = this.vs(Math.round(H * 0.42));
        const path = (inset) => {
          const i = inset || 0;
          c.beginPath();
          c.moveTo(X + S + i, Y + i);
          c.lineTo(X + PW - i, Y + i);
          c.lineTo(X + PW - S - i, Y + PH - i);
          c.lineTo(X + i, Y + PH - i);
          c.closePath();
        };
        if (kind === 'sel') {
          c.save();
          c.shadowColor = 'rgba(255,46,136,0.42)';
          c.shadowBlur = gb(this.vs(18));
          c.shadowOffsetY = this.vs(2);
          path();
          c.fillStyle = 'rgba(36,12,88,0.92)';
          c.fill();
          c.restore();
          // the site's lit gradient, top to foot
          const body = c.createLinearGradient(0, Y, 0, Y + PH);
          body.addColorStop(0, 'rgba(98,46,206,0.95)');
          body.addColorStop(0.55, 'rgba(54,22,132,0.95)');
          body.addColorStop(1, 'rgba(28,9,70,0.97)');
          path();
          c.fillStyle = body;
          c.fill();
          c.save();
          path();
          c.clip();
          // light from inside: pink at the leading end, amber behind the word
          const pk = c.createRadialGradient(X + PW * 0.10, Y + PH * 0.5, 0, X + PW * 0.10, Y + PH * 0.5, PW * 0.42);
          pk.addColorStop(0, 'rgba(255,46,136,0.22)');
          pk.addColorStop(1, 'rgba(255,46,136,0)');
          c.fillStyle = pk;
          c.fillRect(X, Y, PW, PH);
          c.save();
          c.translate(X + PW * 0.5, Y + PH * 0.5);
          c.scale(1, PH / PW * 2.2);
          const am = c.createRadialGradient(0, 0, 0, 0, 0, PW * 0.36);
          am.addColorStop(0, 'rgba(255,180,0,0.16)');
          am.addColorStop(1, 'rgba(255,180,0,0)');
          c.fillStyle = am;
          c.fillRect(-PW * 0.5, -PW * 0.5, PW, PW);
          c.restore();
          // the glass: a gloss on the upper half, a shade at the foot
          const gl = c.createLinearGradient(0, Y, 0, Y + PH);
          gl.addColorStop(0, 'rgba(255,255,255,0.20)');
          gl.addColorStop(0.44, 'rgba(255,255,255,0.03)');
          gl.addColorStop(0.45, 'rgba(255,255,255,0)');
          gl.addColorStop(1, 'rgba(4,0,16,0.22)');
          c.fillStyle = gl;
          c.fillRect(X, Y, PW, PH);
          // the site's scanline wash
          c.fillStyle = 'rgba(255,255,255,0.035)';
          const sl = Math.max(0.5, this.vs(0.6)), step = Math.max(2, this.vs(3));
          for (let sy = Y + step * 0.5; sy < Y + PH; sy += step) c.fillRect(X, sy, PW, sl);
          // the tail: a slanted break and three gold cells after it
          const tx = X + PW * 0.80;
          c.fillStyle = 'rgba(8,2,26,0.42)';
          c.beginPath();
          c.moveTo(tx + S * 0.55, Y); c.lineTo(tx + S * 0.55 + this.vs(4), Y);
          c.lineTo(tx - S * 0.45 + this.vs(4), Y + PH); c.lineTo(tx - S * 0.45, Y + PH);
          c.closePath();
          c.fill();
          for (let i = 0; i < 3; i++) {
            const cx0 = tx + this.vs(14) + i * this.vs(13);
            c.fillStyle = 'rgba(255,217,119,' + (0.30 + i * 0.17).toFixed(2) + ')';
            c.beginPath();
            c.moveTo(cx0 + S * 0.5, Y + PH * 0.26); c.lineTo(cx0 + S * 0.5 + this.vs(6), Y + PH * 0.26);
            c.lineTo(cx0 + this.vs(6) - S * 0.12, Y + PH * 0.74); c.lineTo(cx0 - S * 0.12, Y + PH * 0.74);
            c.closePath();
            c.fill();
          }
          // the gold hairline along the foot, out of nothing and back
          const hl = c.createLinearGradient(X, 0, X + PW, 0);
          hl.addColorStop(0, 'rgba(255,217,119,0)');
          hl.addColorStop(0.5, 'rgba(255,217,119,0.85)');
          hl.addColorStop(1, 'rgba(255,217,119,0)');
          c.fillStyle = hl;
          const hh = Math.max(1, this.vs(1.4));
          c.fillRect(X, Y + PH - hh - this.vs(1.2), PW, hh);
          c.restore();
          // the pink edge, and a breath of its light inside it
          c.strokeStyle = 'rgba(255,46,136,0.95)';
          c.lineWidth = Math.max(1, this.vs(1.5));
          c.lineJoin = 'miter';
          path();
          c.stroke();
          c.strokeStyle = 'rgba(255,150,205,0.26)';
          c.lineWidth = Math.max(1, this.vs(0.8));
          path(this.vs(2.6));
          c.stroke();
        } else {
          const gr = c.createLinearGradient(0, Y, 0, Y + PH);
          gr.addColorStop(0, 'rgba(20,8,50,0.66)');
          gr.addColorStop(1, 'rgba(7,3,26,0.82)');
          path();
          c.fillStyle = gr;
          c.fill();
          c.save();
          path();
          c.clip();
          c.fillStyle = 'rgba(255,255,255,0.05)';
          c.fillRect(X, Y, PW, PH * 0.45);
          c.restore();
          // the site's lit edge: cyan into violet, quiet
          const rim = c.createLinearGradient(X, 0, X + PW, 0);
          rim.addColorStop(0, 'rgba(57,230,255,0.50)');
          rim.addColorStop(0.55, 'rgba(139,92,246,0.42)');
          rim.addColorStop(1, 'rgba(139,92,246,0.18)');
          c.strokeStyle = rim;
          c.lineWidth = Math.max(1, this.vs(1.1));
          path();
          c.stroke();
        }
      });
    }

    /* THE SWEEP. The site's primary button carries a white band that crosses
       it every 4.8 s on an ease, skewed the way the bar leans; this is that
       band, clipped to the bar's own slanted shape. Live rather than cached -
       it moves - and it is one gradient fill. */
    barSweep(x, y, w, h, alpha, time) {
      const P = 4.8;
      const ph = ((time % P) + P) % P / P;
      // the site's cubic-bezier(0.4, 0, 0.2, 1), near enough
      const e = ph < 0.5 ? 2 * ph * ph : 1 - 2 * (1 - ph) * (1 - ph);
      const bw = w / 3;
      const bx = -w / 2 - bw * 1.3 + (w + bw * 2.6) * e;
      const c = this.ctx;
      const X = this.vx(x - w / 2), Y = this.vy(y + h / 2);
      const PW = this.vs(w), PH = this.vs(h), S = this.vs(Math.round(h * 0.42));
      c.save();
      c.globalAlpha *= Math.max(0, alpha);
      c.beginPath();
      c.moveTo(X + S, Y); c.lineTo(X + PW, Y);
      c.lineTo(X + PW - S, Y + PH); c.lineTo(X, Y + PH);
      c.closePath();
      c.clip();
      const L = this.vx(x + bx), R = L + this.vs(bw);
      const gr = c.createLinearGradient(L, 0, R, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.5, 'rgba(255,255,255,0.20)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gr;
      const sk = PH * 0.32;            // skewX(-18deg)
      c.beginPath();
      c.moveTo(L + sk, Y); c.lineTo(R + sk, Y);
      c.lineTo(R - sk, Y + PH); c.lineTo(L - sk, Y + PH);
      c.closePath();
      c.fill();
      hRestore(c);
    }

    /* THE WORD ON A LIT BAR, as the site sets it on PLAY: gold, in the
       display face, with light round it - the halo strokes `hero` draws, in
       amber, rather than a shadow blur redrawn every frame. */
    selLabel(str, x, y, size, alpha, track) {
      this.hero(str, x, y, size, '#ffe9a8', 'center', alpha, '#ffb400', 'num', track);
    }

    /* THE LIT ROW of a settings list - the menu bar's light without its
       body. A settings row has words at both ends, and a solid bar the width
       of the panel would put the value on the same colour as the highlight;
       so the violet starts strong at the label end and dies away before the
       value, with the pink edge and the gold foot drawn the same way and a
       gold wedge on the leading edge where the bar's own slant would be. */
    rowLayer(w, h) {
      const W = Math.round(w), H = Math.round(h);
      return this.layer('row|' + W + '|' + H, W + 8, H + 8, (c) => {
        const X = this.vs(4), Y = this.vs(4), PW = this.vs(W), PH = this.vs(H);
        const S = this.vs(Math.round(H * 0.42));
        const path = () => {
          c.beginPath();
          c.moveTo(X + S, Y); c.lineTo(X + PW, Y);
          c.lineTo(X + PW - S, Y + PH); c.lineTo(X, Y + PH);
          c.closePath();
        };
        const body = c.createLinearGradient(X, 0, X + PW, 0);
        body.addColorStop(0, 'rgba(98,46,206,0.78)');
        body.addColorStop(0.34, 'rgba(70,30,170,0.40)');
        body.addColorStop(0.72, 'rgba(46,18,120,0.14)');
        body.addColorStop(1, 'rgba(30,10,80,0.05)');
        path();
        c.fillStyle = body;
        c.fill();
        c.save();
        path();
        c.clip();
        const pk = c.createRadialGradient(X, Y + PH * 0.5, 0, X, Y + PH * 0.5, PW * 0.30);
        pk.addColorStop(0, 'rgba(255,46,136,0.30)');
        pk.addColorStop(1, 'rgba(255,46,136,0)');
        c.fillStyle = pk;
        c.fillRect(X, Y, PW, PH);
        const gl = c.createLinearGradient(0, Y, 0, Y + PH);
        gl.addColorStop(0, 'rgba(255,255,255,0.18)');
        gl.addColorStop(0.45, 'rgba(255,255,255,0.03)');
        gl.addColorStop(0.46, 'rgba(255,255,255,0)');
        gl.addColorStop(1, 'rgba(4,0,16,0.18)');
        c.fillStyle = gl;
        c.fillRect(X, Y, PW, PH);
        // the gold wedge on the leading edge
        const wd = this.vs(6);
        const gw = c.createLinearGradient(0, Y, 0, Y + PH);
        gw.addColorStop(0, '#fff3c4');
        gw.addColorStop(0.45, '#ffd977');
        gw.addColorStop(0.55, '#e0a640');
        gw.addColorStop(1, '#ffe9a8');
        c.fillStyle = gw;
        c.beginPath();
        c.moveTo(X + S, Y); c.lineTo(X + S + wd, Y);
        c.lineTo(X + wd, Y + PH); c.lineTo(X, Y + PH);
        c.closePath();
        c.fill();
        // the gold foot, fading with the light
        const ft = c.createLinearGradient(X, 0, X + PW, 0);
        ft.addColorStop(0, 'rgba(255,217,119,0.85)');
        ft.addColorStop(0.5, 'rgba(255,217,119,0.30)');
        ft.addColorStop(1, 'rgba(255,217,119,0)');
        c.fillStyle = ft;
        const hh = Math.max(1, this.vs(1.2));
        c.fillRect(X, Y + PH - hh - this.vs(1), PW, hh);
        c.restore();
        const rim = c.createLinearGradient(X, 0, X + PW, 0);
        rim.addColorStop(0, 'rgba(255,46,136,0.95)');
        rim.addColorStop(0.45, 'rgba(255,46,136,0.38)');
        rim.addColorStop(1, 'rgba(255,46,136,0.04)');
        c.strokeStyle = rim;
        c.lineWidth = Math.max(1, this.vs(1.2));
        path();
        c.stroke();
      });
    }

    /* A RACK OF ROWS with one lit. Every row is an idle bar in its slot, the
       lit bar slides between them on the damped position the caller keeps,
       and the labels go on last - gold on the lit one. `y0` is the first
       row's centre and `gap` the step down. Disabled rows are drawn quieter
       and say so with their weight, as they always did. */
    rack(items, index, y0, gap, selY, w, h, k, opts) {
      const o = opts || {};
      const off = o.disabled || [];
      const size = o.size || Math.round(h * 0.46);
      const label = (i) => String(items[i]);
      for (let i = 0; i < items.length; i++) {
        const rk = o.stagger ? o.stagger(i) : k;
        if (rk <= 0.002) continue;
        const dx = (1 - rk) * 24;
        this.blitLayer(this.barLayer(w, h, 'idle'), dx, y0 - i * gap, rk * (off[i] ? 0.55 : 0.9));
      }
      if (selY !== null && selY !== undefined && k > 0.002) {
        this.blitLayer(this.barLayer(w, h, 'sel'), 0, selY, k);
        this.barSweep(0, selY, w, h, k, this.uiClock || 0);
      }
      for (let i = 0; i < items.length; i++) {
        const rk = o.stagger ? o.stagger(i) : k;
        if (rk <= 0.002) continue;
        const sel = i === index;
        const dead = !!off[i];
        const dx = (1 - rk) * 24;
        const y = y0 - i * gap;
        // the slot's number, small, at the bar's leading end
        if (o.numbers !== false) {
          this.t(String(i + 1).padStart(2, '0'), dx - w / 2 + h * 0.62, y, size * 0.42,
            sel ? 'rgba(255,233,168,0.90)' : 'rgba(190,180,255,0.55)', 'left', 'numL', rk);
        }
        let s = size;
        const tw = this.tw(label(i), s, 'num', 0.12);
        const room = w - h * 2.4;
        if (tw > room) s = Math.max(12, s * room / tw);
        if (sel && !dead) {
          this.selLabel(label(i), dx, y, s, rk, 0.12);
          continue;
        }
        const col = dead ? INK.mute : sel ? '#ffe9a8' : 'rgba(236,232,255,0.82)';
        this.t(label(i), dx, y, s, col, 'center', 'num', rk * (dead ? 0.6 : 1), 0.12);
      }
    }

    /** Draw a plate with its centre at virtual (x, y). */
    plate(x, y, w, h, accent, alpha, slant, fillA) {
      this.blitLayer(this.plateLayer(w, h, accent, slant, fillA), x, y, alpha);
    }

    /* A GLOSSY BAR - the reference's bevelled tube. A dark track with a
       hairline, and a fill that runs from the colour's shadow to its light
       with a white band along its upper half and a bright head where it ends.
       Both halves are cached; the fill is shown through a clip, so a moving
       bar is one clip and two blits. `dir` -1 fills from the right. */
    gloss(x, y, w, h, f, col, alpha, dir) {
      const c = this.ctx;
      const W = Math.round(w), H = Math.max(2, Math.round(h * 2) / 2);
      const sl = Math.max(1, Math.round(H * 0.8));
      const track = this.layer('gtrack|' + W + '|' + H, W + 6, H + 6, (cc, cw, ch) => {
        const X = this.vs(3), Y = this.vs(3), PW = this.vs(W), PH = this.vs(H), S = this.vs(sl);
        cc.beginPath();
        cc.moveTo(X + S, Y); cc.lineTo(X + PW, Y); cc.lineTo(X + PW - S, Y + PH); cc.lineTo(X, Y + PH);
        cc.closePath();
        cc.fillStyle = 'rgba(8,4,24,0.72)';
        cc.fill();
        cc.strokeStyle = 'rgba(190,175,255,0.30)';
        cc.lineWidth = Math.max(1, this.vs(0.8));
        cc.stroke();
      });
      const full = this.layer('gfill|' + W + '|' + H + '|' + col, W + 6, H + 6, (cc, cw, ch) => {
        const X = this.vs(3), Y = this.vs(3), PW = this.vs(W), PH = this.vs(H), S = this.vs(sl);
        const p = () => {
          cc.beginPath();
          cc.moveTo(X + S, Y); cc.lineTo(X + PW, Y); cc.lineTo(X + PW - S, Y + PH); cc.lineTo(X, Y + PH);
          cc.closePath();
        };
        const gr = cc.createLinearGradient(X, 0, X + PW, 0);
        gr.addColorStop(0, this._alpha(col, 0.55));
        gr.addColorStop(1, col);
        p();
        cc.fillStyle = gr;
        cc.fill();
        cc.save();
        p();
        cc.clip();
        cc.fillStyle = 'rgba(255,255,255,0.42)';
        cc.fillRect(X, Y, PW, PH * 0.42);
        cc.fillStyle = 'rgba(0,0,0,0.22)';
        cc.fillRect(X, Y + PH * 0.72, PW, PH * 0.28);
        cc.restore();
      });
      const a = alpha === undefined ? 1 : alpha;
      if (a <= 0.002) return;
      this.blitLayer(track, x, y, a);
      const q = Math.max(0, Math.min(1, f));
      if (q > 0.002 && full) {
        const X0 = this.vx(x - W / 2), Y0 = this.vy(y + H / 2 + 3);
        const cw = this.vs(W) * q;
        c.save();
        c.beginPath();
        if (dir === -1) c.rect(X0 + this.vs(W) - cw, Y0, cw + this.vs(4), this.vs(H + 6));
        else c.rect(X0 - this.vs(4), Y0, cw + this.vs(4), this.vs(H + 6));
        c.clip();
        this.blitLayer(full, x, y, a);
        hRestore(c);
        // the head: one bright sliver where the fill stops
        const hx = dir === -1 ? X0 + this.vs(W) - cw : X0 + cw;
        c.save();
        c.globalAlpha *= a * 0.9;
        c.fillStyle = '#ffffff';
        c.fillRect(hx - this.vs(0.8), this.vy(y + H / 2), this.vs(1.6), this.vs(H));
        hRestore(c);
      }
    }

    /** Blit a layer with its centre at virtual (x, y), snapped to a device pixel. */
    blitLayer(e, x, y, alpha) {
      if (!e) return;
      const c = this.ctx, d = this.dpr;
      const px = Math.round((this.vx(x) - e.w / 2) * d) / d;
      const py = Math.round((this.vy(y) - e.h / 2) * d) / d;
      if (alpha !== undefined && alpha < 0.999) {
        c.save();
        c.globalAlpha *= Math.max(0, alpha);
        c.drawImage(e.cv, px, py, e.w, e.h);
        hRestore(c);
      } else {
        c.drawImage(e.cv, px, py, e.w, e.h);
      }
    }

    /* =================================================== THE CLUSTER ===
     *
     * See the note on CL at the top of the file for what it is and what it
     * replaced. This is how it is drawn.
     *
     * CACHED: the face (disc, ticks, figures, rails, sockets, the window and
     * its labels) - one layer, keyed on the scale and the unit, so fitting the
     * Forge engine re-numbers the dial and nothing else ever rebuilds it.
     *
     * SPRITES: the lit sector, the needle, the revs pill and a glow dot per
     * colour - each painted once with all the blur it wants, and blitted
     * through a clip at runtime.
     *
     * LIVE: the clip paths, ten boost cells, nine shift lights, the gear and
     * the readout. No shadow blur anywhere on the live path.
     */
    clusterFace(top, metric) {
      const R = this.vs(CL.r);
      const side = CL.r * 3.2;
      const { major, minor } = this.speedoScale(top, metric);
      const key = 'cl-face~' + top + (metric ? 'M' : 'I');
      return this.layer(key, side, side, (c, w, h) => {
        c.translate(w / 2, h / 2);
        const aOf = (v) => CL_A0 + (CL_A1 - CL_A0) * Math.max(0, Math.min(1, v / top));
        const hot = top * CL_HOT;
        const TAU = Math.PI * 2;

        /* THE GLASS. Deep navy into violet, lit from above, with a darker rim -
           it has to read as a lens over the road rather than as a hole in it,
           so it is translucent at the centre and nearly solid at the edge. */
        const disc = c.createRadialGradient(0, -R * 0.30, R * 0.06, 0, 0, R * 1.10);
        disc.addColorStop(0, 'rgba(38,26,96,0.80)');
        disc.addColorStop(0.55, 'rgba(17,10,52,0.88)');
        disc.addColorStop(1, 'rgba(6,3,22,0.95)');
        c.fillStyle = disc;
        c.beginPath();
        c.arc(0, 0, R * 1.10, 0, TAU);
        c.fill();
        /* The glass over it: one soft crescent of light across the upper
           left, clipped to the dial - the cheapest thing there is that turns
           a drawn circle into an object with a cover on it. */
        c.save();
        c.beginPath();
        c.arc(0, 0, R * 1.09, 0, TAU);
        c.clip();
        const sh = c.createLinearGradient(-R * 0.8, -R * 1.0, R * 0.2, R * 0.2);
        sh.addColorStop(0, 'rgba(255,255,255,0.13)');
        sh.addColorStop(0.5, 'rgba(255,255,255,0.03)');
        sh.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = sh;
        c.beginPath();
        c.ellipse(-R * 0.30, -R * 0.62, R * 1.05, R * 0.55, -0.42, 0, TAU);
        c.fill();
        c.restore();

        // the bezel: one lit hairline round the glass, violet into pink
        const bez = c.createLinearGradient(0, -R * 1.1, 0, R * 1.1);
        bez.addColorStop(0, 'rgba(200,170,255,0.85)');
        bez.addColorStop(0.5, 'rgba(120,90,255,0.55)');
        bez.addColorStop(1, 'rgba(255,70,170,0.75)');
        c.save();
        c.strokeStyle = bez;
        c.lineWidth = Math.max(1, R * 0.016);
        c.shadowColor = 'rgba(150,100,255,0.8)';
        c.shadowBlur = gb(R * 0.10);
        c.beginPath();
        c.arc(0, 0, R * 1.10, 0, TAU);
        c.stroke();
        c.restore();

        // a faint inner ring the figures sit inside
        c.save();
        c.strokeStyle = 'rgba(170,150,255,0.16)';
        c.lineWidth = Math.max(1, R * 0.008);
        c.beginPath();
        c.arc(0, 0, R * 0.56, CL_A0, CL_A1);
        c.stroke();
        c.restore();

        /* THE SCALE. Majors long and solid, minors short and quiet, all of it
           white - the one neutral on the instrument, so the light in the
           sector is the only colour the eye has to read. The last seventh is
           the warning colour and nothing else is. */
        for (let v = 0; v <= top + 0.001; v += minor) {
          const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
          const a = aOf(v);
          const warm = v >= hot - 1e-6;
          const r0 = isMajor ? R * 0.84 : R * 0.91;
          c.save();
          c.strokeStyle = warm ? '#ff4a6a' : '#f4f1ff';
          c.globalAlpha = isMajor ? 0.98 : 0.48;
          c.lineWidth = isMajor ? Math.max(1.5, R * 0.026) : Math.max(1, R * 0.011);
          c.lineCap = 'butt';
          if (isMajor) { c.shadowColor = warm ? '#ff2a3c' : 'rgba(210,200,255,0.9)'; c.shadowBlur = gb(R * 0.05); }
          c.beginPath();
          c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
          c.lineTo(Math.cos(a) * R * 0.995, Math.sin(a) * R * 0.995);
          c.stroke();
          c.restore();
          if (!isMajor) continue;
          c.save();
          c.fillStyle = warm ? '#ff9db0' : '#f4f1ff';
          c.globalAlpha = 0.96;
          c.font = FACE.lab(Math.round(R * 0.128));
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.shadowColor = 'rgba(0,0,0,0.55)';
          c.shadowBlur = gb(R * 0.04);
          c.fillText(String(Math.round(v)), Math.cos(a) * R * 0.69, Math.sin(a) * R * 0.69);
          c.restore();
        }
        // the warning band, outside the ticks
        c.save();
        c.strokeStyle = '#ff2a3c';
        c.lineWidth = Math.max(1.5, R * 0.028);
        c.shadowColor = '#ff2a3c';
        c.shadowBlur = gb(R * 0.10);
        c.beginPath();
        c.arc(0, 0, R * 1.035, aOf(hot), aOf(top));
        c.stroke();
        c.restore();

        /* THE PILLS' TRACKS. Empty glass with a hairline, so a pill at zero
           reads as an instrument at rest rather than as nothing. */
        const pillTrack = (from, to) => {
          const r = R * CL_PILL.r, hw = R * CL_PILL.w;
          const ccw = to < from;
          c.save();
          c.beginPath();
          c.arc(0, 0, r + hw, from, to, ccw);
          c.arc(0, 0, r - hw, to, from, !ccw);
          c.closePath();
          c.fillStyle = 'rgba(10,6,30,0.62)';
          c.fill();
          c.strokeStyle = 'rgba(170,150,255,0.36)';
          c.lineWidth = Math.max(1, R * 0.010);
          c.stroke();
          c.restore();
        };
        pillTrack(CL_PILL_L[0], CL_PILL_L[1]);
        pillTrack(CL_PILL_R[0], CL_PILL_R[1]);
        // the gear ladder's slots, as dividers in its track
        {
          const r = R * CL_PILL.r, hw = R * CL_PILL.w;
          c.save();
          c.strokeStyle = 'rgba(4,2,14,0.85)';
          c.lineWidth = Math.max(1, R * 0.012);
          for (let i = 1; i < CL_GEARS.length; i++) {
            const a = CL_PILL_R[0] + (CL_PILL_R[1] - CL_PILL_R[0]) * (i / CL_GEARS.length);
            c.beginPath();
            c.moveTo(Math.cos(a) * (r - hw), Math.sin(a) * (r - hw));
            c.lineTo(Math.cos(a) * (r + hw), Math.sin(a) * (r + hw));
            c.stroke();
          }
          c.restore();
        }

        /* THE OUTER RAILS - thin arcs and a few points of light outside the
           pills, which is most of what makes the reference read as a piece of
           equipment rather than as a dial. They carry nothing; they are the
           frame. */
        c.save();
        c.strokeStyle = 'rgba(140,110,255,0.42)';
        c.lineWidth = Math.max(1, R * 0.010);
        c.beginPath(); c.arc(0, 0, R * 1.335, Math.PI * (146 / 180), Math.PI * (214 / 180)); c.stroke();
        c.beginPath(); c.arc(0, 0, R * 1.335, Math.PI * (-34 / 180), Math.PI * (34 / 180)); c.stroke();
        c.strokeStyle = 'rgba(255,90,190,0.30)';
        c.beginPath(); c.arc(0, 0, R * 1.40, Math.PI * (218 / 180), Math.PI * (232 / 180)); c.stroke();
        c.beginPath(); c.arc(0, 0, R * 1.40, Math.PI * (308 / 180), Math.PI * (322 / 180)); c.stroke();
        c.fillStyle = 'rgba(160,130,255,0.75)';
        for (const deg of [140, 220, 320, 40]) {
          const a = Math.PI * (deg / 180);
          c.beginPath();
          c.arc(Math.cos(a) * R * 1.335, Math.sin(a) * R * 1.335, R * 0.022, 0, TAU);
          c.fill();
        }
        c.restore();

        // the shift lights' sockets
        c.save();
        c.fillStyle = 'rgba(120,100,220,0.30)';
        for (let i = 0; i < CL_LEDS; i++) {
          const a = CL_LED0 + (CL_LED1 - CL_LED0) * (i / (CL_LEDS - 1));
          c.beginPath();
          c.arc(Math.cos(a) * R * CL_LED_R, Math.sin(a) * R * CL_LED_R, R * 0.034, 0, TAU);
          c.fill();
        }
        c.restore();

        /* THE WINDOW. A trapezoid, wide at the top, cut into the gap the
           needle never reaches - the reading is the one number a player wants
           at a glance, so it is the biggest thing on the cluster and it sits
           on a dark ground of its own. */
        const T = CL_TRAP;
        const tp = () => {
          c.beginPath();
          c.moveTo(-R * T.wTop / 2, R * T.top);
          c.lineTo(R * T.wTop / 2, R * T.top);
          c.lineTo(R * T.wBot / 2, R * T.bot);
          c.lineTo(-R * T.wBot / 2, R * T.bot);
          c.closePath();
        };
        c.save();
        tp();
        const wg = c.createLinearGradient(0, R * T.top, 0, R * T.bot);
        wg.addColorStop(0, 'rgba(16,10,46,0.94)');
        wg.addColorStop(1, 'rgba(6,3,20,0.96)');
        c.fillStyle = wg;
        c.shadowColor = 'rgba(0,0,0,0.6)';
        c.shadowBlur = gb(R * 0.12);
        c.fill();
        c.restore();
        c.save();
        tp();
        const we = c.createLinearGradient(-R * T.wTop / 2, 0, R * T.wTop / 2, 0);
        we.addColorStop(0, 'rgba(255,70,170,0.85)');
        we.addColorStop(0.5, 'rgba(190,170,255,0.95)');
        we.addColorStop(1, 'rgba(90,200,255,0.85)');
        c.strokeStyle = we;
        c.lineWidth = Math.max(1, R * 0.016);
        c.shadowColor = 'rgba(160,110,255,0.9)';
        c.shadowBlur = gb(R * 0.08);
        c.stroke();
        c.restore();
        // a highlight along the window's top edge
        c.save();
        c.fillStyle = 'rgba(255,255,255,0.22)';
        c.fillRect(-R * T.wTop / 2 + R * 0.05, R * T.top + R * 0.02, R * T.wTop - R * 0.10, Math.max(1, R * 0.008));
        c.restore();

        // the labels under the pills, and the unit in the window
        const lab = (txt, x, y, align, col, px) => {
          c.save();
          c.font = FACE.lab(Math.round(px));
          if ('letterSpacing' in c) c.letterSpacing = (px * 0.16).toFixed(2) + 'px';
          c.textAlign = align;
          c.textBaseline = 'middle';
          c.fillStyle = col;
          c.fillText(txt, x, y);
          c.restore();
        };
        /* Beside the pills' lower ends and above the window's shoulders, so
           the live caption under each has a line of its own that clears the
           window's corner at every reading. */
        lab('RPM', -R * 1.42, R * 0.66, 'left', 'rgba(190,200,255,0.70)', R * 0.100);
        lab('GEAR', R * 1.42, R * 0.66, 'right', 'rgba(190,200,255,0.70)', R * 0.100);
        lab(metric ? 'KM/H' : 'MPH', R * 0.44, R * 1.14, 'center', 'rgba(255,110,190,0.92)', R * 0.092);
      });
    }

    /* THE LIT SECTOR, as one sprite: an annulus whose colour runs round the
       dial and whose light runs outward to the rim, with the digital checker
       through the middle of it that the reference carries. Blitted through a
       wedge from the start of the scale to the needle, it is the "glow behind
       the needle" for one clip and one drawImage. */
    clusterGlow(kind) {
      const R = this.vs(CL.r);
      const side = CL.r * 2.3;
      return this.layer('cl-glow-' + kind + '~', side, side, (c, w, h) => {
        c.translate(w / 2, h / 2);
        const ramp = kind === 'race'
          ? [[0, '#0b62ff'], [0.55, '#2fb8ff'], [1, '#9ff1ff']]
          : kind === 'boost'
            ? [[0, '#a23cff'], [0.45, '#ff2fb0'], [1, '#ffd0f0']]
            : [[0, '#6a3cff'], [0.45, '#d93cff'], [0.80, '#ff3c9e'], [1, '#ff2a4a']];
        const span = CL_A1 - CL_A0;
        let fill;
        if (c.createConicGradient) {
          fill = c.createConicGradient(CL_A0, 0, 0);
          const f = span / (Math.PI * 2);
          for (const [k, col] of ramp) fill.addColorStop(Math.min(1, k * f), col);
          fill.addColorStop(Math.min(1, f + 0.001), ramp[ramp.length - 1][1]);
          fill.addColorStop(1, ramp[0][1]);
        } else {
          fill = ramp[1][1];
        }
        c.fillStyle = fill;
        c.beginPath();
        c.arc(0, 0, R * 1.0, 0, Math.PI * 2);
        c.arc(0, 0, R * 0.22, 0, Math.PI * 2, true);
        c.fill();
        /* The checker: a field of small cells, some lifted and some sunk,
           densest at mid-radius. Seeded, so the pattern is the same every
           build and does not shimmer when the window is resized. */
        let s = 1234567;
        const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
        const cell = R * 0.072;
        for (let y = -R; y < R; y += cell) {
          for (let x = -R; x < R; x += cell) {
            const d = Math.hypot(x + cell / 2, y + cell / 2) / R;
            if (d < 0.36 || d > 0.86) continue;
            const r = rnd();
            const m = Math.sin(Math.PI * (d - 0.36) / 0.50);
            if (r < 0.30) {
              c.globalCompositeOperation = 'destination-out';
              c.fillStyle = 'rgba(0,0,0,' + (0.45 * m).toFixed(3) + ')';
              c.fillRect(x + 1, y + 1, cell - 2, cell - 2);
            } else if (r > 0.86) {
              c.globalCompositeOperation = 'lighter';
              c.fillStyle = 'rgba(255,200,240,' + (0.10 * m).toFixed(3) + ')';
              c.fillRect(x + 1, y + 1, cell - 2, cell - 2);
            }
          }
        }
        // the light runs outward: faint at the hub, strong at the rim
        c.globalCompositeOperation = 'destination-in';
        const fall = c.createRadialGradient(0, 0, R * 0.22, 0, 0, R * 1.0);
        fall.addColorStop(0, 'rgba(0,0,0,0)');
        fall.addColorStop(0.35, 'rgba(0,0,0,0.10)');
        fall.addColorStop(0.72, 'rgba(0,0,0,0.42)');
        fall.addColorStop(0.93, 'rgba(0,0,0,0.78)');
        fall.addColorStop(0.985, 'rgba(0,0,0,1)');
        fall.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = fall;
        c.fillRect(-w / 2, -h / 2, w, h);
        c.globalCompositeOperation = 'source-over';
      });
    }

    /* The needle, pointing along +x with the pivot at `pivot` from its left
       edge. Painted with its glow; rotated into place at runtime. */
    clusterNeedle(kind) {
      const R = this.vs(CL.r);
      const lenV = CL.r * 1.22, hV = CL.r * 0.34;
      const e = this.layer('cl-needle-' + kind + '~', lenV, hV, (c, w, h) => {
        const pivot = R * 0.16 + R * 0.08;
        c.translate(pivot, h / 2);
        const col = kind === 'hot' ? '#ff2a4a' : kind === 'race' ? '#38d6ff' : '#ff3ca8';
        c.shadowColor = col;
        c.shadowBlur = gb(R * 0.14);
        c.fillStyle = col;
        c.beginPath();
        c.moveTo(-R * 0.15, -R * 0.022);
        c.lineTo(R * 0.97, -R * 0.007);
        c.lineTo(R * 0.97, R * 0.007);
        c.lineTo(-R * 0.15, R * 0.022);
        c.closePath();
        c.fill();
        c.shadowBlur = 0;
        // the white filament down the business end
        c.fillStyle = '#fff4fb';
        c.beginPath();
        c.moveTo(R * 0.18, -R * 0.008);
        c.lineTo(R * 0.97, -R * 0.0045);
        c.lineTo(R * 0.97, R * 0.0045);
        c.lineTo(R * 0.18, R * 0.008);
        c.closePath();
        c.fill();
      });
      if (e) e.pivot = this.vs(CL.r * 0.24);
      return e;
    }

    /* The revs pill, full: cyan at the bottom through violet and magenta to
       the warning colour at the top, with a glossy highlight along its outer
       half - the bevelled-tube look of the reference bars. */
    clusterRevPill() {
      const R = this.vs(CL.r);
      const side = CL.r * 3.2;
      return this.layer('cl-revpill~', side, side, (c, w, h) => {
        c.translate(w / 2, h / 2);
        const r = R * CL_PILL.r, hw = R * CL_PILL.w;
        const [a0, a1] = CL_PILL_L;
        let fill;
        if (c.createConicGradient) {
          fill = c.createConicGradient(a0, 0, 0);
          const f = (a1 - a0) / (Math.PI * 2);
          fill.addColorStop(0, '#2fd8ff');
          fill.addColorStop(f * 0.45, '#8b5cf6');
          fill.addColorStop(f * 0.78, '#ff3ca8');
          fill.addColorStop(f * 0.95, '#ff2a3c');
          fill.addColorStop(f, '#ff2a3c');
          fill.addColorStop(1, '#2fd8ff');
        } else fill = '#8b5cf6';
        c.save();
        c.shadowColor = 'rgba(200,80,255,0.9)';
        c.shadowBlur = gb(R * 0.12);
        c.fillStyle = fill;
        c.beginPath();
        c.arc(0, 0, r + hw * 0.80, a0, a1);
        c.arc(0, 0, r - hw * 0.80, a1, a0, true);
        c.closePath();
        c.fill();
        c.restore();
        c.save();
        c.globalAlpha = 0.42;
        c.strokeStyle = '#ffffff';
        c.lineWidth = hw * 0.42;
        c.lineCap = 'butt';
        c.beginPath();
        c.arc(0, 0, r + hw * 0.36, a0 + 0.01, a1 - 0.01);
        c.stroke();
        c.restore();
      });
    }

    /* A soft dot of light in one colour, for the shift lights and the cells.
       A radial gradient IS a glow - there is nothing to blur. */
    glowDot(col) {
      const D = this._dots || (this._dots = {});
      const key = col + '|' + this.k.toFixed(4) + '|' + this.dpr;
      let e = D[col];
      if (e && e.key === key) return e;
      const px = Math.max(4, Math.ceil(this.vs(CL.r * 0.20) * this.dpr));
      const cv = (e && e.cv) || global.document.createElement('canvas');
      cv.width = px; cv.height = px;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.18, col);
      g.addColorStop(0.42, this._alpha(col, 0.38));
      g.addColorStop(1, this._alpha(col, 0));
      c.clearRect(0, 0, px, px);
      c.fillStyle = g;
      c.fillRect(0, 0, px, px);
      e = D[col] = { cv, key, s: px / this.dpr };
      return e;
    }

    /* The whole instrument. `quiet` is the region card's dimming. */
    cluster(g, quiet) {
      const c = this.ctx;
      const car = g.car;
      const q = quiet === undefined ? 1 : quiet;
      const metric = !!g.useMetric;

      // the scale is this car's, in this unit - see the long note on speedo
      const ceiling = metric ? car.ceilingKmh : car.ceilingMph;
      const raw = Math.max(metric ? 120 : 75, ceiling || (metric ? 215 : 134));
      const top = this.speedoScale(raw, metric).top;
      const shown = Math.max(0, metric ? car.speedKmh : car.speedMph);

      const unit = metric ? 1 : 0;
      if (this.spdUnit !== unit) {
        if (this.spdUnit !== undefined) {
          const conv = unit ? 1.609344 : 1 / 1.609344;
          this.peakSpeed = (this.peakSpeed || 0) * conv;
          this.spdShown = (this.spdShown || 0) * conv;
        }
        this.spdUnit = unit;
      }
      const dt = Math.min(0.05, this._dt || 0.016);
      if (this.spdShown === undefined || !isFinite(this.spdShown)) this.spdShown = shown;
      this.spdShown += (shown - this.spdShown) * (1 - Math.exp(-13 * dt));
      const value = Math.max(0, Math.min(top, this.spdShown));
      if (shown > (this.peakSpeed || 0)) this.peakSpeed = shown;
      const frac = value / top;
      const aOf = (v) => CL_A0 + (CL_A1 - CL_A0) * Math.max(0, Math.min(1, v / top));
      const R = this.vs(CL.r);
      const cx = this.vx(CL.x), cy = this.vy(CL.y);
      const race = !!g.raceModeActive;
      const hot = frac >= CL_HOT;

      c.save();
      c.globalAlpha *= q;

      this.blitLayer(this.clusterFace(top, metric), CL.x, CL.y);

      /* THE LIT SECTOR, through a wedge from the start of the scale to the
         needle. Its brightness rides the reading a little, so a car at rest
         has a dim dial and a car at the top of its range has a lit one. */
      if (frac > 0.003) {
        const kind = race ? 'race' : (car.boosting ? 'boost' : 'base');
        const gl = this.clusterGlow(kind);
        if (gl) {
          c.save();
          c.beginPath();
          c.moveTo(cx, cy);
          c.arc(cx, cy, R * 1.05, CL_A0, aOf(value));
          c.closePath();
          c.clip();
          c.globalAlpha *= 0.55 + 0.45 * Math.min(1, frac * 1.6);
          this.blitLayer(gl, CL.x, CL.y);
          hRestore(c);
        }
      }

      // the peak, as one bright tick on the rim
      const peak = Math.min(top, this.peakSpeed || 0);
      if (peak > top * 0.06 && peak > value + top * 0.015) {
        const pa = aOf(peak);
        c.save();
        c.globalAlpha *= 0.85;
        c.strokeStyle = '#ffffff';
        c.lineWidth = Math.max(1, R * 0.020);
        c.beginPath();
        c.moveTo(cx + Math.cos(pa) * R * 0.80, cy + Math.sin(pa) * R * 0.80);
        c.lineTo(cx + Math.cos(pa) * R * 1.06, cy + Math.sin(pa) * R * 1.06);
        c.stroke();
        hRestore(c);
      }

      /* THE REVS PILL, through a wedge from its bottom end to the revs. */
      const rev = Math.max(0, Math.min(1, car.rpm || 0));
      if (rev > 0.01) {
        const rp = this.clusterRevPill();
        if (rp) {
          const [a0, a1] = CL_PILL_L;
          c.save();
          c.beginPath();
          c.moveTo(cx, cy);
          c.arc(cx, cy, R * 1.5, a0, a0 + (a1 - a0) * rev);
          c.closePath();
          c.clip();
          this.blitLayer(rp, CL.x, CL.y);
          hRestore(c);
        }
      }

      /* THE GEAR LADDER, up the right-hand pill: R and N at its foot, one to
         seven above them, the engaged slot lit as a glossy cell with its
         letter white over it. It goes magenta for the beat after a shift and
         at the upshift point - the same two cues the shift lights give - so
         the eye that is already on the dial is told a shift happened and
         where the box went. */
      const flash = car.shiftFlash || 0;
      const gtxt = gearLabel(car);
      {
        const r = R * CL_PILL.r, hw = R * CL_PILL.w * 0.80;
        const [b0, b1] = CL_PILL_R;
        const n = CL_GEARS.length;
        const hotGear = flash > 0.05 || rev >= 0.92;
        const at = Math.max(0, CL_GEARS.indexOf(gtxt));
        for (let i = 0; i < n; i++) {
          const s0 = b0 + (b1 - b0) * (i / n), s1 = b0 + (b1 - b0) * ((i + 1) / n);
          const mid = (s0 + s1) / 2;
          const lit = i === at;
          if (lit) {
            const lo = Math.min(s0, s1) + 0.010, hi = Math.max(s0, s1) - 0.010;
            c.save();
            c.lineCap = 'butt';
            c.strokeStyle = hotGear ? '#ff3ca8' : (gtxt === 'R' ? '#ffb43c' : '#8a5cff');
            c.lineWidth = hw * 2;
            c.beginPath();
            c.arc(cx, cy, r, lo, hi);
            c.stroke();
            c.globalAlpha *= 0.20;
            c.strokeStyle = '#ffffff';
            c.lineWidth = hw * 0.6;
            c.beginPath();
            c.arc(cx, cy, r + hw * 0.40, lo, hi);
            c.stroke();
            hRestore(c);
            const d = this.glowDot(hotGear ? '#ff3ca8' : '#a66bff');
            c.save();
            c.globalAlpha *= 0.55;
            c.globalCompositeOperation = 'lighter';
            const sz = d.s * 1.5;
            c.drawImage(d.cv, cx + Math.cos(mid) * r - sz / 2, cy + Math.sin(mid) * r - sz / 2, sz, sz);
            hRestore(c);
          }
          /* The letter, upright, at the slot's centre - SIZED TO THE PITCH.
             Nine slots share 48 degrees at 1.235 radii, about 0.115 R apart -
             and at the foot of the arc, where it runs nearly vertical, only
             0.099 R of that is height. Orbitron's capitals stand 0.85 of their
             size, so the lit letter at 0.140 R was taller than its slot and
             sat on the R beneath it. At 0.100 and 0.084 two neighbours keep
             two units of clear glass between them even there. */
          c.save();
          setFont(c, FACE[lit ? 'num' : 'lab'](R * (lit ? 0.100 : 0.084)));
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          const lx = cx + Math.cos(mid) * r, ly = cy + Math.sin(mid) * r + R * 0.006;
          if (lit) {
            // a dark seat under the lit letter, so white holds on a lit cell
            c.fillStyle = 'rgba(30,0,40,0.75)';
            c.fillText(CL_GEARS[i], lx + R * 0.010, ly + R * 0.010);
          }
          c.fillStyle = lit ? '#ffffff' : 'rgba(190,180,255,0.46)';
          c.fillText(CL_GEARS[i], lx, ly);
          hRestore(c);
        }
      }

      /* THE SHIFT LIGHTS. Left to right with the revs, cyan into violet into
         magenta, and the whole row magenta at the upshift. Steady, not
         strobed - the row has to be readable in the corner of an eye, and it
         sits inside the interface's 3 Hz ceiling for the photosensitivity
         notice's sake. */
      for (let i = 0; i < CL_LEDS; i++) {
        const t = i / (CL_LEDS - 1);
        const on = rev > 0.46 + t * 0.46;
        if (!on) continue;
        const col = rev >= 0.92 ? '#ff2f6e' : (t > 0.66 ? '#ff3ca8' : (t > 0.33 ? '#a66bff' : '#39e6ff'));
        const a = CL_LED0 + (CL_LED1 - CL_LED0) * t;
        const d = this.glowDot(col);
        const lx = cx + Math.cos(a) * R * CL_LED_R, ly = cy + Math.sin(a) * R * CL_LED_R;
        c.drawImage(d.cv, lx - d.s / 2, ly - d.s / 2, d.s, d.s);
      }

      // the needle, then the hub over its tail
      const nd = this.clusterNeedle(race ? 'race' : (hot ? 'hot' : 'base'));
      if (nd) {
        c.save();
        c.translate(cx, cy);
        c.rotate(aOf(value));
        c.drawImage(nd.cv, -nd.pivot, -nd.h / 2, nd.w, nd.h);
        hRestore(c);
      }
      c.save();
      c.fillStyle = '#0d0828';
      c.beginPath();
      c.arc(cx, cy, R * 0.085, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = race ? '#7fe4ff' : '#c8b8ff';
      c.lineWidth = Math.max(1, R * 0.024);
      c.stroke();
      hRestore(c);

      /* THE READING, in the window. Fixed cells - the figures are tabular -
         so it does not shuffle as it changes; it warms toward magenta over
         the last of the car's range. */
      const read = String(Math.round(shown));
      const heat = Math.max(0, (frac - 0.70) / 0.30);
      const rc = race ? '#bff4ff' : mixHex2('#f1edff', '#ff7ac8', heat);
      this.t(read, CL.x - CL.r * 0.10, CL.y - CL.r * 1.085, CL.r * 0.40, rc, 'center', 'num');

      /* Under the revs, the upshift when it is due. Nothing otherwise:
         the core reports revs as a fraction of the limiter, so there is no
         honest figure to print there, and a made-up one is worse than none. */
      if (rev >= 0.92) {
        this.t('SHIFT', CL.x - CL.r * 1.42, CL.y - CL.r * 0.81, CL.r * 0.098, '#ff6aa8',
          'left', 'lab', 0.75 + 0.25 * Math.sin(g.time * 9), 0.12);
      }

      hRestore(c);
    }

    /* ======================================================= THE MAP ===
     *
     * The bottom-left corner, which used to hold a waveform. A racing game
     * that sends a player down a hundred and seventy kilometres of road and
     * never once shows them which way it bends next is asking them to learn
     * it by hitting it, and every finished racer answers that with the same
     * instrument: a small map that turns with the car.
     *
     * IT IS THE COURSE ITSELF. The centreline the physics drives on is
     * already in memory as plain typed arrays (NR.Track.C), so this is a
     * window onto the real road - about a kilometre ahead and a third of that
     * behind - rotated so that the car's heading is always up. The rival is
     * on it where the rival actually is, the region borders and the finish
     * are marked where they actually fall, and a stretch of tunnel is drawn
     * as a tunnel.
     *
     * The glass, the bezel and the integrity rail are one cached layer. The
     * road is three strokes - a wide soft one, a narrower one and a bright
     * core - which is what a glow looks like when nothing is blurred.
     */
    minimapFace() {
      const r = this.vs(MM.r);
      return this.layer('mm-face~', MM.r * 2.8, MM.r * 2.8, (c, w, h) => {
        c.translate(w / 2, h / 2);
        const TAU = Math.PI * 2;
        const disc = c.createRadialGradient(0, -r * 0.3, r * 0.05, 0, 0, r);
        disc.addColorStop(0, 'rgba(30,22,80,0.62)');
        disc.addColorStop(0.7, 'rgba(14,9,44,0.78)');
        disc.addColorStop(1, 'rgba(7,4,24,0.90)');
        c.fillStyle = disc;
        c.beginPath();
        c.arc(0, 0, r, 0, TAU);
        c.fill();
        // range rings, so distance on the map has a scale to be read against
        c.strokeStyle = 'rgba(160,140,255,0.14)';
        c.lineWidth = Math.max(1, r * 0.010);
        for (const k of [0.40, 0.72]) {
          c.beginPath();
          c.arc(0, r * MM.carY, r * k, 0, TAU);
          c.stroke();
        }
        const bez = c.createLinearGradient(0, -r, 0, r);
        bez.addColorStop(0, 'rgba(200,170,255,0.85)');
        bez.addColorStop(0.5, 'rgba(120,90,255,0.55)');
        bez.addColorStop(1, 'rgba(90,200,255,0.70)');
        c.save();
        c.strokeStyle = bez;
        c.lineWidth = Math.max(1, r * 0.018);
        c.shadowColor = 'rgba(150,100,255,0.8)';
        c.shadowBlur = gb(r * 0.10);
        c.beginPath();
        c.arc(0, 0, r, 0, TAU);
        c.stroke();
        c.restore();
        // ticks round the rim, every thirty degrees, the instrument's frame
        c.strokeStyle = 'rgba(200,190,255,0.40)';
        c.lineWidth = Math.max(1, r * 0.012);
        for (let i = 0; i < 12; i++) {
          const a = i * Math.PI / 6;
          c.beginPath();
          c.moveTo(Math.cos(a) * r * 1.05, Math.sin(a) * r * 1.05);
          c.lineTo(Math.cos(a) * r * 1.10, Math.sin(a) * r * 1.10);
          c.stroke();
        }
        // the integrity rail's track, on the side facing the middle of the frame
        const pr = r * MM.pill, hw = r * 0.060;
        c.beginPath();
        c.arc(0, 0, pr + hw, MM.p0, MM.p1, true);
        c.arc(0, 0, pr - hw, MM.p1, MM.p0, false);
        c.closePath();
        c.fillStyle = 'rgba(10,6,30,0.62)';
        c.fill();
        c.strokeStyle = 'rgba(170,150,255,0.34)';
        c.lineWidth = Math.max(1, r * 0.010);
        c.stroke();
        c.font = FACE.lab(Math.round(r * 0.12));
        if ('letterSpacing' in c) c.letterSpacing = (r * 0.12 * 0.16).toFixed(2) + 'px';
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        c.fillStyle = 'rgba(190,200,255,0.62)';
        c.fillText('BODY', r * 0.98, r * 0.84);
      });
    }

    minimap(g, quiet) {
      const T = g.track;
      const C = T && T.C;
      const c = this.ctx;
      const q = quiet === undefined ? 1 : quiet;
      const r = this.vs(MM.r);
      const cx = this.vx(MM.x), cy = this.vy(MM.y);
      c.save();
      c.globalAlpha *= q;
      this.blitLayer(this.minimapFace(), MM.x, MM.y);

      if (C && C.count > 4 && g.car) {
        const car = g.car;
        const fx = Math.sin(car.yaw || 0), fz = Math.cos(car.yaw || 0);
        const step = C.step || 6;
        const s = Math.max(0, g.distance || 0);
        /* About a kilometre ahead fills the map from the car to its top edge,
           which at racing speed is ten or fifteen seconds of road - the
           distance a corner has to be seen at to be driven rather than
           survived. */
        const scale = (r * (1 + MM.carY)) / MM.ahead;
        const ox = cx, oy = cy + r * MM.carY;
        const px = car.x || 0, pz = car.z || 0;
        const map = (X, Z, out) => {
          const dx = X - px, dz = Z - pz;
          out[0] = ox + (dx * fz - dz * fx) * scale;        // across, along the right vector
          out[1] = oy - (dx * fx + dz * fz) * scale;        // along, up the screen
          return out;
        };
        const P = this._mmP || (this._mmP = [0, 0]);
        const i0 = Math.max(0, Math.floor((s - MM.behind) / step));
        const i1 = Math.min(C.count - 1, Math.ceil((s + MM.ahead * 1.25) / step));
        const stride = Math.max(1, Math.round(18 / step));
        const iCar = Math.min(C.count - 1, Math.round(s / step));

        c.save();
        c.beginPath();
        c.arc(cx, cy, r * 0.985, 0, Math.PI * 2);
        c.clip();
        c.lineJoin = 'round';
        c.lineCap = 'round';
        const path = (a, b) => {
          c.beginPath();
          let first = true;
          for (let i = a; i <= b; i += stride) {
            map(C.x[i], C.z[i], P);
            if (first) { c.moveTo(P[0], P[1]); first = false; } else c.lineTo(P[0], P[1]);
          }
          map(C.x[b], C.z[b], P);
          c.lineTo(P[0], P[1]);
        };
        // behind: a quiet line, because it is history
        if (iCar > i0) {
          path(i0, iCar);
          c.strokeStyle = 'rgba(150,140,220,0.30)';
          c.lineWidth = r * 0.075;
          c.stroke();
        }
        // ahead: the road, as light
        if (i1 > iCar) {
          path(iCar, i1);
          c.strokeStyle = 'rgba(255,60,168,0.20)';
          c.lineWidth = r * 0.17;
          c.stroke();
          c.strokeStyle = 'rgba(255,90,190,0.55)';
          c.lineWidth = r * 0.085;
          c.stroke();
          c.strokeStyle = '#ffe2f4';
          c.lineWidth = Math.max(1, r * 0.030);
          c.stroke();
          /* Tunnels, as a dark core through the light: the one stretch of road
             where the next corner cannot be seen however far ahead it is. */
          if (C.tunnel) {
            c.strokeStyle = 'rgba(12,6,34,0.85)';
            c.lineWidth = Math.max(1, r * 0.032);
            let open = false;
            c.beginPath();
            for (let i = iCar; i <= i1; i += stride) {
              const tun = !!C.tunnel[i];
              map(C.x[i], C.z[i], P);
              if (tun && !open) { c.moveTo(P[0], P[1]); open = true; }
              else if (tun) c.lineTo(P[0], P[1]);
              else open = false;
            }
            c.stroke();
          }
        }
        /* Where the route changes hands - a region border on a tour, the
           finish on a race - as a bar across the road. */
        const mark = (sAt, col) => {
          if (!(sAt > s - MM.behind && sAt < s + MM.ahead * 1.25)) return;
          const i = Math.max(1, Math.min(C.count - 2, Math.round(sAt / step)));
          map(C.x[i], C.z[i], P);
          const ax = P[0], ay = P[1];
          map(C.x[i + 1], C.z[i + 1], P);
          let tx = P[0] - ax, ty = P[1] - ay;
          const l = Math.hypot(tx, ty) || 1;
          tx /= l; ty /= l;
          const half = r * 0.13;
          c.strokeStyle = col;
          c.lineWidth = Math.max(1.5, r * 0.035);
          c.beginPath();
          c.moveTo(ax - ty * half, ay + tx * half);
          c.lineTo(ax + ty * half, ay - tx * half);
          c.stroke();
        };
        if (g.freeRoam && g.regionEdges) {
          for (let i = 1; i < g.regionEdges.length - 1; i++) mark(g.regionEdges[i], '#ffd977');
        }
        if (g.finishAt) mark(g.finishAt, '#ffffff');

        /* The rival, where it really is - and pinned to the rim, pointing,
           when it is further away than the map reaches. */
        if (g.rival && !g.soloRun && g.rival.x !== undefined) {
          map(g.rival.x, g.rival.z, P);
          let rx = P[0] - cx, ry = P[1] - cy;
          const d = Math.hypot(rx, ry);
          const lim = r * 0.86;
          const out = d > lim;
          if (out) { rx *= lim / d; ry *= lim / d; }
          const col = (g.place === 1) ? '#ff3ca8' : '#ff3ca8';
          const dot = this.glowDot(col);
          c.drawImage(dot.cv, cx + rx - dot.s / 2, cy + ry - dot.s / 2, dot.s, dot.s);
          c.fillStyle = '#ffffff';
          c.beginPath();
          c.arc(cx + rx, cy + ry, r * (out ? 0.035 : 0.045), 0, Math.PI * 2);
          c.fill();
        }
        hRestore(c);

        // the car: an arrow at the origin, always pointing up the map
        const a = r * 0.075;
        const glow = this.glowDot('#7fe4ff');
        c.drawImage(glow.cv, ox - glow.s * 0.6, oy - glow.s * 0.6, glow.s * 1.2, glow.s * 1.2);
        c.beginPath();
        c.moveTo(ox, oy - a * 1.35);
        c.lineTo(ox + a, oy + a);
        c.lineTo(ox, oy + a * 0.45);
        c.lineTo(ox - a, oy + a);
        c.closePath();
        c.fillStyle = '#ffffff';
        c.fill();
        c.strokeStyle = '#2fd8ff';
        c.lineWidth = Math.max(1, r * 0.016);
        c.stroke();
      }

      /* BODY INTEGRITY, on the rail beside the map. It costs top end - see
         the note on the old readout below - so when it does, the rail says
         how much. */
      const dmg = g.damage && g.damage.total > 0.02 ? Math.min(1, g.damage.total) : 0;
      {
        const pr = r * MM.pill, hw = r * 0.046;
        const left = 1 - dmg;
        const col = dmg > 0.66 ? '#ff3c6e' : dmg > 0.33 ? '#ffb400' : '#39e6ff';
        const a1 = MM.p0 + (MM.p1 - MM.p0) * left;
        c.save();
        c.strokeStyle = col;
        c.lineWidth = hw * 2;
        c.lineCap = 'butt';
        c.globalAlpha *= 0.92;
        c.beginPath();
        c.arc(cx, cy, pr, a1, MM.p0, false);
        c.stroke();
        c.globalAlpha *= 0.45;
        c.strokeStyle = '#ffffff';
        c.lineWidth = hw * 0.6;
        c.beginPath();
        c.arc(cx, cy, pr + hw * 0.4, a1, MM.p0, false);
        c.stroke();
        hRestore(c);
        const loss = Math.round((1 - 1 / Math.sqrt(1 + 0.42 * dmg)) * 100);
        if (loss >= 1) {
          this.t('-' + loss + '% TOP END', MM.x + MM.r * 1.02, MM.y - MM.r * 1.02, MM.r * 0.12,
            col, 'left', 'lab', dmg > 0.66 ? 0.55 + 0.45 * Math.sin(g.time * 5) : 0.9, 0.12);
        }
      }
      hRestore(c);
    }

    /* ================================================== THE SPEEDOMETER ==
     *
     * WHAT IT REPLACED, AND WHY A SPRITE COULD NOT BE FIXED.
     *
     * It shipped as two atlas sprites called `speed`: one drawn at 7% opacity
     * as a background and the same bitmap drawn over it with `drawImage`'s
     * source rectangle CLIPPED to the fraction of top speed the car was
     * doing. That is not a dial. It is a picture of a dial with a hard
     * vertical edge travelling across it, so the "needle" is a straight cut
     * through the artwork, the numbers on the face are painted into a 180x102
     * bitmap that is upscaled on every machine with more than a 720p window,
     * and the scale cannot re-draw itself when the car's ceiling changes -
     * which it does, twice, over the campaign.
     *
     * Nothing about that can be repaired by drawing the same sprite better.
     * The instrument has to know what it is showing, so it is drawn.
     *
     * WHAT IS ON IT
     *
     *   THE SCALE re-derives itself from the ceiling the solver will actually
     *   enforce on this car as it is fitted right now, in the unit the player
     *   chose - so fitting the Forge rebuild in Chapter 6 re-numbers the dial
     *   rather than pegging the needle at the end of its travel for the whole
     *   of Chapter 7. Majors are a round number of the unit, never a fraction
     *   of the top speed, because 26.8 MPH is not a number anybody can read a
     *   dial by.
     *
     *   THE NEEDLE has mass. It is driven towards the speed rather than set to
     *   it, hard enough to keep up and soft enough that a kerb strike reads as
     *   a flick rather than a jump - the single cheapest thing that separates
     *   an instrument from a bar chart.
     *
     *   THE SHIFT LIGHTS are the arc over the top of the bezel. They are the
     *   same drivetrain the DRIVETRAIN panel's rev bar is reading, and they
     *   are here because this is where the eye already is at the moment the
     *   question "do I lift?" is being asked. Dim until three quarters, amber,
     *   then the whole strip goes magenta at the upshift.
     *
     *   THE PEAK MARK is the fastest this run, left on the scale. It costs one
     *   tick and it is the reason a run has a shape.
     *
     * AND IT IS CACHED. Everything that cannot change between two frames - the
     * bezel, the dish, the glass, forty-odd ticks, its numerals and the unit -
     * is rendered once into an offscreen canvas and blitted, because this file
     * is on the CPU's critical path and re-rasterising eleven numerals sixty
     * times a second to show a number that has not changed is exactly the kind
     * of cost the rest of this file already goes to some trouble to avoid.
     * The cache is keyed on everything the face depends on, so there is no way
     * to change one of them and be shown a stale dial.
     */

    /* THE SCALE, DECIDED ONCE.
     *
     * Two things read this - the cached face draws the ticks and the live half
     * works out where the needle goes - and if they ever disagreed by a single
     * unit the needle would point between the numbers. It was computed twice,
     * which is the shape of that bug waiting to happen, so it is one function.
     *
     * MAJORS COME OFF A LADDER, NOT OFF THE CEILING. A step chosen as a
     * fraction of the top speed gives you a dial labelled 26.8; a step chosen
     * from round numbers gives you a dial. The ladder is walked until the
     * whole scale fits in eight labels, because ten of them at this size
     * collide - which is exactly what the rebuilt engine's 225 mph dial did,
     * printing "100 125" as one word across the top of the instrument.
     *
     * The top is then rounded UP to a whole major, so the scale ends on a
     * labelled tick rather than three-fifths of the way between two.
     */
    speedoScale(raw, metric) {
      const ladder = metric ? [20, 25, 40, 50, 100] : [10, 20, 25, 50];
      let major = ladder[ladder.length - 1];
      for (const step of ladder) {
        if (Math.ceil(raw / step) <= 8) { major = step; break; }
      }
      const top = Math.max(major, Math.ceil(raw / major) * major);
      return { top, major, minor: major / (major % 4 === 0 ? 4 : 5) };
    }

    /* ==================================================== THE BOOST METER ==
     *
     * The other thing on this screen that was a bitmap being stretched.
     *
     * It shipped as three sprites out of atlas205 - a 512x64 border, a 512x64
     * fill clipped to the reserve, and a small `turbo` badge - drawn at their
     * authored size dead centre along the bottom of the frame. At 1080p that
     * is a 512-pixel-wide texture covering 768 pixels of screen, so its edges
     * are soft, its corners are rounded by the upscale, and the "fill" is the
     * same soft artwork with a hard vertical cut through it. It is the single
     * largest object in the interface and it was the least sharp thing in the
     * frame.
     *
     * AND IT HAD FOUR STATES DRAWN FOUR WAYS. Normal boost was the sprite;
     * raceMode's blue reserve was a hand-rolled segmented bar drawn over the
     * top of the sprite because the shipped atlas bakes its fuel segments red
     * and a tint cannot remove red; spent-and-recharging was the sprite plus a
     * caption; and full was the sprite plus a different bracket. One meter,
     * four renderers, and only one of them looked like the rest of the game.
     *
     * So it is one meter with four readings. The segments are drawn, so they
     * are sharp at every resolution and their colour is a property of the
     * state rather than of an atlas; the frame is the same cut-cornered,
     * lit-edged panel the DRIVETRAIN readout and every DOM card in the game
     * use; and the caption under it says which of the four things is true.
     *
     * WHY SEGMENTS RATHER THAN A CONTINUOUS BAR. The reserve is spent in
     * discrete bursts and it LATCHES when it empties - it will not fire again
     * until there is a burn's worth back in it, see car.boostLocked - so what
     * the player needs to read is "how many goes have I got", which is a count
     * and not a length.
     */
    boostMeter(g, quiet, layout) {
      const L = layout || BST;
      const c = this.ctx;
      const car = g.car;
      const q = quiet === undefined ? 1 : quiet;
      const fill = Math.max(0, Math.min(1, car.boost || 0));
      /* raceMode, ON THE RESERVE IT FEEDS. While it is live the bar is not
         only tinted - it is SHEATHED: a field of blue light behind it, a blue
         sleeve just outside its edge with a streak running along it, and the
         whole run of cells in the blue reserve's colours. The meter on the
         flank says raceMode is up; this says it where the eye already is
         when the boost is being spent. */
      const rmOn = !!(g.raceMode && g.raceMode.active);
      const blue = !!g.raceModeBlueFuel || rmOn;

      /* WHAT THE METER IS SAYING, decided once. Four states, in the order they
         take precedence: a burn in progress beats everything, then the latch,
         then a full reserve, then simply having some. */
      const arm = 0.34;                       // the latch's re-arm threshold
      let state, edge, hot, cool, caption;
      if (car.boosting) {
        state = 'live';
        edge = blue ? '#45d7ff' : PINK;
        hot = blue ? '#a8f4ff' : '#ff8fd0';
        cool = blue ? '#078cff' : PINK;
        caption = blue ? 'SYNCHRONIZED' : 'BOOSTING';
      } else if (car.boostLocked) {
        state = 'charging';
        edge = '#ff8a3a';
        hot = '#ffd9a8';
        cool = '#c85f18';
        caption = 'CHARGING  ' + Math.round(Math.min(1, fill / arm) * 100) + '%';
      } else if (fill > 0.98) {
        state = 'ready';
        edge = blue ? '#38bfff' : CYAN;
        hot = '#ffffff';
        cool = blue ? '#078cff' : CYAN;
        /* THE KEY IS ASKED FOR, NOT SPELLED OUT.
           This said SHIFT. Boost has been bound to B for as long as the
           CONTROLS screen has existed, so the one place in the game that
           tells a player which key to press was telling them the wrong one -
           and it would have gone on being wrong for anybody who rebound it
           anyway. NR.bindLabel renders whatever the action is actually on,
           the same way the CONTROLS rows do. */
        /* An action with no key left on it is not offered one: the meter
           still says the boost is there to spend, on a pad or after a
           rebind, and does not name a key that does nothing. */
        const bk = keyFor(g, 'boost');
        caption = blue ? 'BLUE RESERVE  //  FULL'
          : 'BOOST READY' + (bk ? '  //  ' + bk : '');
      } else {
        state = 'part';
        edge = blue ? '#38bfff' : 'rgba(120,190,240,0.55)';
        hot = blue ? '#6eeaff' : '#ff6fb4';
        cool = blue ? '#078cff' : '#b3277a';
        caption = blue ? 'BLUE RESERVE' : 'BOOST';
      }
      if (rmOn && state !== 'charging') caption = 'raceMode  //  ' + caption;

      /* A burn is the one thing here that pulses, at four hertz - fast enough
         to read as urgent, slow enough to sit inside the 3 Hz-ish ceiling the
         rest of this interface keeps for the photosensitivity notice's sake.
         READY breathes instead, much slower, because it is an invitation
         rather than an alarm. */
      const pulse = state === 'live' ? 0.80 + 0.20 * Math.sin(g.time * 26)
        : state === 'ready' ? 0.86 + 0.14 * Math.sin(g.time * 3)
        : state === 'charging' ? 0.72 + 0.28 * Math.sin(g.time * 6)
        : 1;

      /* THE BAR, WITHOUT A SINGLE BLUR.
       *
       * It was a cut-cornered housing with a glowing edge and twenty-four
       * segments each filled under its own shadow blur - twenty-six blurred
       * passes a frame for one meter. It is now the cluster's language: a dark
       * glass track, slanted cells that run from the colour's shadow to its
       * light with a gloss along their top half, and the light itself a dot at
       * the head of the fill. Same four states, same latch, same caption. */
      const X = this.vx(L.x - L.w / 2), Y = this.vy(L.y + L.h / 2);
      const W = this.vs(L.w), H = this.vs(L.h);
      const S = H * 0.7;
      // the field of blue light under the whole bar, breathing slowly
      if (rmOn) {
        const d = this.glowDot('#1f8fff');
        const breathe = 0.78 + 0.22 * Math.sin(g.time * 2.4);
        c.save();
        c.globalAlpha *= q * 0.85 * breathe;
        c.globalCompositeOperation = 'lighter';
        c.drawImage(d.cv, X - W * 0.12, Y - H * 2.6, W * 1.24, H * 6.2);
        hRestore(c);
      }
      c.save();
      c.globalAlpha *= q;
      c.beginPath();
      c.moveTo(X + S, Y - this.vs(2));
      c.lineTo(X + W + this.vs(2), Y - this.vs(2));
      c.lineTo(X + W - S + this.vs(2), Y + H + this.vs(2));
      c.lineTo(X - this.vs(2), Y + H + this.vs(2));
      c.closePath();
      c.fillStyle = 'rgba(8,4,24,0.72)';
      c.fill();
      c.strokeStyle = state === 'part' ? 'rgba(190,175,255,0.32)' : this._alpha(edge, 0.75 * pulse);
      c.lineWidth = Math.max(1, this.vs(1));
      c.stroke();

      const pad = this.vs(1.5);
      const inner = W - pad * 2;
      const gap = this.vs(2);
      const seg = (inner - gap * (L.n - 1)) / L.n;
      const live = fill * L.n;
      const sl = Math.min(seg * 0.6, S * 0.8);
      for (let i = 0; i < L.n; i++) {
        const k = Math.max(0, Math.min(1, live - i));
        const sx = X + pad + i * (seg + gap);
        const t = i / (L.n - 1);
        const cell = () => {
          c.beginPath();
          c.moveTo(sx + sl, Y);
          c.lineTo(sx + seg, Y);
          c.lineTo(sx + seg - sl, Y + H);
          c.lineTo(sx, Y + H);
          c.closePath();
        };
        if (k <= 0.001) {
          c.globalAlpha = q * 0.30;
          c.fillStyle = 'rgba(110,90,190,0.55)';
          cell();
          c.fill();
          continue;
        }
        /* THE RUN RAMPS ALONG ITS OWN LENGTH rather than switching colour at
           one segment - a reserve filling up, not two meters side by side.
           Under raceMode it starts from a deep electric blue, not violet, so
           the whole bar reads as the blue reserve and not only its tip. */
        const col = mixHex2(rmOn ? '#1d4dff' : VIOLET, cool, Math.min(1, t / 0.7));
        const lit = t > 0.80 ? mixHex2(cool, hot, (t - 0.80) / 0.20) : col;
        c.globalAlpha = q * (0.45 + 0.55 * k) * pulse;
        c.fillStyle = lit;
        cell();
        c.fill();
        c.globalAlpha = q * 0.36 * k;
        c.fillStyle = '#ffffff';
        c.fillRect(sx + sl * 0.5, Y, seg - sl * 0.5, H * 0.38);
      }
      // the light at the head of the fill
      if (fill > 0.01 && (state === 'live' || state === 'ready')) {
        const d = this.glowDot(edge);
        const hx = X + pad + inner * Math.min(1, fill);
        c.globalAlpha = q * 0.9 * pulse;
        c.globalCompositeOperation = 'lighter';
        c.drawImage(d.cv, hx - d.s * 0.6, Y + H / 2 - d.s * 0.6, d.s * 1.2, d.s * 1.2);
        c.globalCompositeOperation = 'source-over';
      }
      hRestore(c);

      /* THE SLEEVE: the bar's own slanted outline, 4.5 units further out,
         in raceMode's blue - and a streak of white running along it left to
         right once a second and a bit, the reserve being drawn through. Two
         strokes and a gradient a frame, no blur. */
      if (rmOn) {
        const o = this.vs(4.5);
        const sleeve = () => {
          c.beginPath();
          c.moveTo(X + S - o * 0.4, Y - o);
          c.lineTo(X + W + o, Y - o);
          c.lineTo(X + W - S + o * 0.4, Y + H + o);
          c.lineTo(X - o, Y + H + o);
          c.closePath();
        };
        c.save();
        c.globalAlpha *= q;
        c.lineJoin = 'miter';
        c.strokeStyle = 'rgba(69,215,255,0.80)';
        c.lineWidth = Math.max(1, this.vs(1.3));
        sleeve();
        c.stroke();
        const ph = (g.time * 0.85) % 1.4 - 0.2;
        const x0 = X - o, x1 = X + W + o, sx = x0 + (x1 - x0) * ph;
        const band = Math.max(this.vs(40), (x1 - x0) * 0.16);
        const gr = c.createLinearGradient(sx - band, 0, sx + band, 0);
        gr.addColorStop(0, 'rgba(255,255,255,0)');
        gr.addColorStop(0.5, 'rgba(225,250,255,0.95)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        c.strokeStyle = gr;
        c.lineWidth = Math.max(1.5, this.vs(2.2));
        sleeve();
        c.stroke();
        hRestore(c);
      }

      /* THE LATCH, MARKED ON THE METER ITSELF.
         The reserve will not fire again until it is back past `arm`, and
         without a mark on the bar that is a rule the player can only learn by
         being refused. One hairline, and CHARGING nn% is measured against it. */
      if (state === 'charging' || (state === 'part' && fill < arm)) {
        const ax = X + pad + inner * arm;
        c.save();
        c.globalAlpha *= q * 0.85;
        c.fillStyle = '#ffd9a8';
        c.fillRect(ax, Y - this.vs(3), Math.max(1, this.vs(1.4)), H + this.vs(6));
        hRestore(c);
      }

      /* The reading: under the bar - or OVER it, from the seat, where under
         it is the rim of the wheel. */
      const capY = L.capAbove ? L.y + L.h * 0.5 + 10 : L.y - L.h * 0.5 - 11;
      // a part-filled reserve is said quietly - unless raceMode is on it
      const quietCap = state === 'part' && !rmOn;
      this.t(caption, L.x, capY, (L.capSize || 10) * 1.05,
        quietCap ? INK.mute : (state === 'part' ? '#8fe3ff' : edge), 'center', 'lab',
        q * (quietCap ? 0.8 : 0.95), 0.2);
    }

    /* ===================================================== THE RADIO BOX ==
     *
     * The radio, back on the glass and always there: a slim strip under the
     * boost bar with the station, its frequency, the song and a level meter
     * that is the song's own spectrum (Audio.musicLevels). It is the old
     * SYNX FM panel's job in a sixth of its height. When a song changes the
     * strip says NOW PLAYING for a beat and the new title slides in, so the
     * cue that used to float by the map is the strip itself now.
     *
     * Chase view only. From the seat this part of the glass is the wheel,
     * and the seat keeps its own cue under the clock (see songCue). */
    radioBox(g) {
      const a = g.audio;
      const np = a && a.nowPlaying ? a.nowPlaying() : null;
      if (!np) return;
      const dt = Math.min(0.05, this._dt || 0.016);
      if (np.key !== this.radioKey) { this.radioKey = np.key; this.radioT = 0; }
      this.radioT = (this.radioT === undefined ? 9 : this.radioT) + dt;
      const st = this.radioT;
      const fresh = st < 2.6;
      const W = 300, H = 24, x = 0, y = BST.y - 47;
      const col = np.onAir ? '#39e6ff' : '#ffb43c';
      this.plate(x, y, W, H, col, 0.96, 9, 0.80);
      const L = x - W / 2;
      // the on-air light, breathing while the station is live
      const beat = np.onAir ? 0.55 + 0.45 * Math.sin(g.time * 3.1) : 0.85;
      const d = this.glowDot(col);
      const c = this.ctx;
      c.save();
      c.globalAlpha *= beat;
      c.drawImage(d.cv, this.vx(L + 15) - d.s * 0.36, this.vy(y) - d.s * 0.36, d.s * 0.72, d.s * 0.72);
      hRestore(c);
      // the station and its frequency - or, for a beat after a change, the news
      const head = fresh ? 'NOW PLAYING' : (np.station || 'SYNX FM');
      this.t(head, L + 24, y + 1, 8.5, fresh ? '#ffffff' : col, 'left', 'lab',
        fresh ? 0.75 + 0.25 * Math.sin(g.time * 8) : 0.92, 0.2);
      let tx = L + 24 + this.tw(head, 8.5, 'lab', 0.2) + 8;
      if (np.onAir && np.freq) {
        // the dial position is data, so it is in the data face, in the gold
        const fq = np.freq.toFixed(1);
        this.t(fq, tx, y + 1, 12, '#ffd977', 'left', 'numL');
        tx += this.tw(fq, 12, 'numL') + 8;
      }
      // a hairline between who and what
      c.save();
      c.fillStyle = 'rgba(200,210,255,0.28)';
      c.fillRect(this.vx(tx), this.vy(y + 6), Math.max(1, this.vs(1)), this.vs(12));
      hRestore(c);
      tx += 8;
      /* The song, fitted to the room left before the meter. A title is read,
         so it is in the reading face - which also gets nearly half as many
         characters again into the room the display face would. */
      const room = (x + W / 2 - 52) - tx;
      let title = String(np.title || '');
      if (this.tw(title, 13, 'row', 0.04) > room) {
        while (title.length > 2 && this.tw(title + '…', 13, 'row', 0.04) > room) title = title.slice(0, -1);
        title += '…';
      }
      const slide = fresh ? (1 - Math.min(1, st / 0.45)) : 0;
      this.t(title, tx + slide * 14, y + 1.5, 13, '#ffffff', 'left', 'row', 1 - slide * 0.85, 0.04);
      // the meter: the song's own spectrum, nine bars, cyan into magenta
      const bars = this.radioBars || (this.radioBars = new Float32Array(9));
      if (a.musicLevels) a.musicLevels(bars);
      const bx0 = x + W / 2 - 46;
      c.save();
      for (let i = 0; i < bars.length; i++) {
        const v = Math.max(0.06, Math.min(1, bars[i] || 0));
        const h = 2 + v * 11;
        c.fillStyle = mixHex2('#39e6ff', '#ff3ca8', i / (bars.length - 1));
        c.globalAlpha = 0.45 + 0.55 * v;
        c.fillRect(this.vx(bx0 + i * 4.4), this.vy(y - 6 + h), this.vs(2.6), this.vs(h));
      }
      hRestore(c);
    }

    /* ================================================ FOCUS, ON THE GLASS ==
     *
     * THE TOP-LEFT CORNER, AS raceMode HAS THE RIGHT FLANK - the same three
     * lines in the same type, mirrored, so the two abilities the player
     * spends read as a pair: the state over the name, the name with its key
     * (or its seconds) beside it, and the reserve as a tube under both.
     *
     *   READY     silver, breathing, the key it is on
     *   CHARGING  dimmed, and the seconds until it can be called
     *   LIVE      white, the seconds it has left and the rate the world is
     *             running at, the tube draining
     *
     * It used to be a chip beside the boost bar, where its CHARGING caption
     * was printed through its own keycap, and a banner under the clock that
     * collided with the seat's song cue. One instrument in one corner says
     * all of it. The corner is the canvas's in every mode: the route rail
     * starts at x -380, SAVED is drawn right of that, and the story cards on
     * this flank are held below y 292 (see #storyRaceMeta in style.css).
     * Silver rather than any race colour, because FOCUS is the one thing in
     * the game that is black and white. */
    focusMeter(g) {
      const F = g.focus;
      const lesson = g.state === 'story' && !!(g.story && g.story.mode === 'tutorial');
      if (!F || !(lesson || g.state === 'racing' || g.state === 'countdown')) return;
      const LX = FOCUS_HUD.x, ry = FOCUS_HUD.y, BW = FOCUS_HUD.w;
      const live = F.on || F.k > 0.05;
      const min = F.min || 0.24;
      const ready = !live && F.reserve >= min;
      const breathe = ready ? 0.80 + 0.20 * Math.sin(g.time * 2.6) : 1;
      const col = live ? '#ffffff' : (ready ? '#dfe3ff' : 'rgba(196,200,236,0.66)');
      const key = (keyFor(g, 'focus') || '').split('  /  ')[0];
      const tail = live ? Math.max(0, F.left || 0).toFixed(1) + 's'
        : (ready ? key : Math.max(1, Math.ceil(F.readyIn || 0)) + 's');
      const rate = Math.max(1, Math.round((F.scale || 1) * 100)) / 100;
      /* Online the world's clock is shared and is not FOCUS's to slow (see
         Game.updateFocus), so the line that reads the rate offline reads what
         FOCUS is doing instead: the read-ahead on the other cars. */
      const state = live ? (F.online ? 'PRECOG  //  LINK' : 'TIME  ×' + rate.toFixed(2))
        : (ready ? 'READY' : 'CHARGING');
      this.t(state, LX, ry + 24, 10, live ? INK.key : INK.mute, 'left', 'lab', 0.9, 0.22);
      this.t('FOCUS', LX, ry + 2, 17, col, 'left', 'num', breathe);
      if (tail) {
        this.t(tail, LX + this.tw('FOCUS', 17, 'num') + 9, ry + 2, 17,
          live || ready ? '#ffffff' : 'rgba(225,228,255,0.78)', 'left', 'num', breathe);
      }
      this.gloss(LX + BW / 2, ry - 15, BW, 6, F.reserve, live ? '#ffffff' : '#c7ccf2', ready || live ? 1 : 0.62);
      /* The threshold, as a notch in the tube: where the reserve has to reach
         before FOCUS can be called. A charge the player can see coming is a
         charge they can plan a corner around. */
      if (!live) {
        const c = this.ctx, nx = this.vx(LX + BW * min);
        c.save();
        c.fillStyle = F.reserve >= min ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.85)';
        c.fillRect(nx - this.vs(0.6), this.vy(ry - 15 + 6), this.vs(1.2), this.vs(12));
        hRestore(c);
      }
    }

    /* ===================================================== PRECOG, ONLINE ==
     *
     * WHAT FOCUS IS IN A SHARED RACE. Offline it slows the world; online the
     * world is everybody's and the server times it in real seconds, so it
     * cannot (see Game.updateFocus). What it can do without touching anybody
     * else is let this driver see further than the wire does.
     *
     * Every other car on screen is drawn where it WAS: the netcode plays the
     * field back a playout delay behind the present (55-320 ms - see
     * NetClient::sample in crates/synx-core/src/net.rs), because a car drawn
     * from samples it already has glides and a car drawn at the present has
     * to guess and snap. That delay is the price of smooth, and at 100 u/s it
     * is ten metres. PRECOG pays it back on the glass rather than in the
     * picture: from the pose that is drawn, the same road-following motion is
     * carried forward over the delay - a diamond where the car actually is
     * now - and on for most of a second more, a trail fading to where it is
     * going. The cars themselves are untouched, so nothing about their motion
     * changes and nothing is sent: it is read-only, local, and symmetric,
     * because every driver in the room has the same key.
     *
     * The prediction follows the ROAD, not the heading. A straight line off
     * the car's nose leaves the tarmac in the first bend; arc length and the
     * offset from the centreline do not, and a lateral drift is let die over
     * half a second because a car crossing the road is almost always about to
     * stop crossing it. Drawn under the instruments, in FOCUS's white. */
    drawPrecog(g) {
      const F = g.focus;
      if (!F || !F.online || !(F.k > 0.02) || g.state !== 'racing') return;
      const field = g.storyExtraRacers, vp = g.vpClean, track = g.track;
      if (!field || !field.length || !vp || !track || !g.car) return;
      const net = global.NR && global.NR.Net;
      const st = net && net.stats ? net.stats() : null;
      const lag = Math.max(0.03, Math.min(0.4, ((st && st.delay) || 100) / 1000));
      const AHEAD = 0.75, N = 18, T_LAT = 0.5;
      const P = g._projClean, ppu = (P ? Math.abs(P[5]) : 1.4) * this.h * 0.5;
      const len = track.length || 0;
      const at = this._pcAt || (this._pcAt = {});
      const pts = this._pcPts || (this._pcPts = new Float32Array((N + 1) * 4));
      const fade = Math.min(1, F.k * 1.6);
      const c = this.ctx;
      const myS = g.car.sTrack || 0;
      for (const e of field) {
        const car = e && e.car;
        if (!car) continue;
        /* Anchored on where the car is DRAWN. Its `sTrack` and `lateral` are
           the solver's start-of-frame projection - a frame of travel behind
           its own position, a unit at speed - so a trail started from them
           begins a car's quarter-length off the car. */
        const pr = track.project(car.x || 0, car.z || 0, car.sTrack || 0,
          this._pcProj || (this._pcProj = {}));
        const s0 = pr.sExact;
        // a car half a course away is a dot; one beside us is in the mirror
        const ds = s0 - myS;
        if (ds < -40 || ds > 520) continue;
        track.at(Math.max(0, Math.min(len - 2, s0)), at);
        const yr = at.yaw, ry0 = at.y;
        const vx = car.vx || 0, vz = car.vz || 0;
        const u = Math.max(0, vx * Math.sin(yr) + vz * Math.cos(yr));
        const w = vx * Math.cos(yr) - vz * Math.sin(yr);
        const lat0 = pr.lateral, h0 = (car.y || 0) - ry0;
        const edge = (track.outerHalf || track.halfWidth || 12) - 1.2;
        let n = 0;
        for (let i = 0; i <= N; i++) {
          const t = (lag + AHEAD) * i / N;
          const s = Math.max(0, Math.min(len - 2, s0 + u * t));
          track.at(s, at);
          const lat = Math.max(-edge, Math.min(edge, lat0 + w * T_LAT * (1 - Math.exp(-t / T_LAT))));
          const x = at.x + lat * Math.cos(at.yaw);
          const z = at.z - lat * Math.sin(at.yaw);
          const y = at.y + 0.18 + h0 * Math.exp(-3 * t);
          const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
          if (cw < 0.5) break;
          const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
          const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
          pts[n * 4] = (cx / cw * 0.5 + 0.5) * this.w;
          pts[n * 4 + 1] = (0.5 - cy / cw * 0.5) * this.h;
          pts[n * 4 + 2] = t;
          pts[n * 4 + 3] = ppu / cw;
          n++;
        }
        if (n < 2) continue;
        const near = Math.min(1, Math.max(0.25, 1 - (Math.abs(ds) - 160) / 360));
        c.save();
        c.lineCap = 'round';
        c.strokeStyle = '#ffffff';
        c.fillStyle = '#ffffff';
        /* The trail: solid while it is the past the wire has not shown yet,
           thinning and fading once it is the future. One stroke a segment,
           because each segment has its own width and alpha - and unblurred,
           because a shadow is a blur pass per stroke and there are fifty. */
        /* Twice: a dark hairline under, then the white - the monochrome
           print makes the lit road nearly white itself, and a white line on
           it alone is a line nobody sees. Same reason the numerals carry a
           dark edge (see tGold). */
        for (let pass = 0; pass < 2; pass++) {
          c.strokeStyle = pass ? '#ffffff' : 'rgba(6,6,14,0.55)';
          for (let i = 1; i < n; i++) {
            const a = i - 1, b = i;
            const t = pts[b * 4 + 2];
            const fut = Math.max(0, (t - lag) / AHEAD);
            const w = Math.max(1, Math.min(this.vs(7), pts[b * 4 + 3] * 0.32 * (1 - 0.6 * fut)));
            c.globalAlpha = fade * near * (t <= lag ? 0.6 : 0.6 * (1 - fut) * (1 - fut) + 0.06);
            c.lineWidth = pass ? w : w + Math.max(1.5, this.vs(2.2));
            c.beginPath();
            c.moveTo(pts[a * 4], pts[a * 4 + 1]);
            c.lineTo(pts[b * 4], pts[b * 4 + 1]);
            c.stroke();
          }
        }
        c.strokeStyle = '#ffffff';
        /* The car where it really is: the first sample at or past the delay,
           a diamond as wide as half the car at that depth. */
        let k = 0;
        while (k < n - 1 && pts[k * 4 + 2] < lag) k++;
        if (pts[k * 4 + 2] >= lag - 1e-6) {
          const px = pts[k * 4], py = pts[k * 4 + 1];
          const r = Math.max(this.vs(4), Math.min(this.vs(16), pts[k * 4 + 3] * 0.9));
          c.globalAlpha = fade * near * 0.95;
          c.lineWidth = Math.max(1, this.vs(1.6));
          c.shadowColor = 'rgba(255,255,255,0.8)';
          c.shadowBlur = gb(this.vs(8));
          c.beginPath();
          c.moveTo(px, py - r); c.lineTo(px + r, py); c.lineTo(px, py + r); c.lineTo(px - r, py);
          c.closePath();
          c.stroke();
          c.globalAlpha = fade * near * 0.35;
          c.fill();
          // and who it is, small, over the mark
          hRestore(c);
          const nm = String(e.name || '').toUpperCase().slice(0, 14);
          if (nm) {
            this.t(nm, (px - this.w / 2) / this.k, (this.h / 2 - (py - r - this.vs(6))) / this.k,
              9, '#ffffff', 'center', 'lab', fade * near * 0.85, 0.2);
          }
          continue;
        }
        hRestore(c);
      }
    }

    /* THE TOW, read out under the position block - because the draft is about
       the car the position block is about. A word, five chevrons that fill as
       the slingshot builds, and the slingshot itself when it is ready to fire.
       It is only there while it is true. */
    draftChip(g) {
      const D = g.draft;
      if (!D || g.state !== 'racing') return;
      const on = Math.max(Math.min(1, D.k * 3), D.ready ? 1 : 0, D.fired);
      if (on <= 0.02) return;
      /* WITHIN THE RIVAL READOUT'S OWN COLUMN, x -330..-170: the toast stack
         is clamped wide enough to reach x -396 one line below this, and the
         clock's column owns the middle, so a chip that ran on past the gap
         rail's end was one wide notice away from being drawn under it. One
         word, the five chevrons, and the column's width; READY is said by
         the chevrons going mint and by the notice that fires with it. */
      const x = RIVAL_X, y = 206;
      const col = D.ready ? MINT : '#9fe7ff';
      const pulse = D.ready ? 0.75 + 0.25 * Math.sin(g.time * 9) : 1;
      const word = D.ready ? 'SLINGSHOT' : 'SLIPSTREAM';
      this.t(word, x, y, 10, col, 'left', 'lab', on * pulse, 0.2);
      const c = this.ctx;
      const cx0 = x + this.tw(word, 10, 'lab', 0.2) + 10;
      c.save();
      c.globalAlpha *= on;
      for (let i = 0; i < 5; i++) {
        const lit = D.build * 5 > i + 0.15;
        const px = this.vx(cx0 + i * 11), py = this.vy(y), s = this.vs(5.5);
        c.beginPath();
        c.moveTo(px, py - s); c.lineTo(px + s * 0.9, py); c.lineTo(px, py + s);
        c.lineTo(px + s * 0.45, py); c.closePath();
        c.fillStyle = lit ? col : 'rgba(190,200,240,0.24)';
        c.fill();
      }
      hRestore(c);
    }

    /** A neon rule with a diamond at each end. */
    rule(x, y, w, color, alpha) {
      const c = this.ctx;
      c.save();
      if (alpha !== undefined) c.globalAlpha = alpha;
      c.strokeStyle = color || CYAN;
      c.lineWidth = Math.max(1, this.vs(2));
      c.shadowColor = color || CYAN;
      c.shadowBlur = gb(this.vs(12));
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
      hRestore(c);
    }

    /** The perspective grid the whole genre is built on. */
    /* THE HORIZON GRID, AND THE HALF OF IT THAT NEVER MOVES.
     *
     * Twenty-nine rays converging on a vanishing point, and twelve
     * horizontals scrolling toward the viewer. Every one of the forty-one was
     * stroked with `shadowBlur` set, which in a 2D context means the shape is
     * rasterised, blurred into a scratch surface and composited - per stroke,
     * every frame, for as long as the title screen is up.
     *
     * The twenty-nine rays are the same twenty-nine rays on every frame: they
     * are a function of the window and of the horizon line, and of nothing
     * else. So they are drawn ONCE into an offscreen buffer and blitted, and
     * the only blurred strokes left in the frame are the twelve that actually
     * move. On the machines this is for, that is the difference between the
     * title screen costing four milliseconds of processor and costing one.
     *
     * Rebuilt when the window changes size, when the horizon moves (the
     * loading screen and the menu use different ones) or when the HUD GLOW
     * row changes the blur radius - all three are in the key.
     */
    /* THE BUFFER IS BOUNDED, and that is not a detail.
     *
     * A cache the size of the window times the device pixel ratio is
     * thirty-three megabytes on a 4K panel at 2x - held for the life of the
     * process, to hold twenty-nine straight lines, on the very machines this
     * whole exercise is about not being wasteful on.
     *
     * A ray is a straight line with a soft glow on it, which is the one kind
     * of shape that survives being drawn small and scaled up: there is no
     * detail in it to lose. So it is rendered at no more than 1920 device
     * pixels across and blitted to fit, which caps the cost at about eight
     * megabytes whatever the display is and is, at the resolutions this can
     * actually be seen at, indistinguishable from drawing it full size. */
    gridRays(hy, colour) {
      const key = this.w + 'x' + this.h + ':' + Math.round(hy) + ':' + GLOW.toFixed(2);
      if (this._rayKey === key && this._rayBuf) return this._rayBuf;
      const scale = Math.max(0.5, Math.min(this.dpr, 1920 / Math.max(1, this.w)));
      const buf = this._rayBuf || (this._rayBuf = global.document.createElement('canvas'));
      const W = Math.max(1, Math.round(this.w * scale));
      const H = Math.max(1, Math.round(this.h * scale));
      if (buf.width !== W) buf.width = W;
      if (buf.height !== H) buf.height = H;
      const bc = buf.getContext('2d');
      if (!bc) { this._rayBuf = null; return null; }
      bc.setTransform(scale, 0, 0, scale, 0, 0);
      bc.clearRect(0, 0, this.w, this.h);
      bc.strokeStyle = colour;
      bc.lineWidth = Math.max(1, this.vs(1.2));
      bc.shadowColor = colour;
      bc.shadowBlur = gb(this.vs(6));
      const bottom = this.h;
      for (let i = -14; i <= 14; i++) {
        bc.beginPath();
        bc.moveTo(this.vx(0), hy);
        bc.lineTo(this.vx(i * 110), bottom);
        bc.stroke();
      }
      this._rayKey = key;
      return buf;
    }

    gridFloor(g, yHorizon, alpha) {
      const c = this.ctx;
      const a0 = alpha === undefined ? 0.5 : alpha;
      const hy = this.vy(yHorizon);
      const bottom = this.h;
      c.save();
      // verticals converging on the vanishing point, from the cache
      const rays = this.gridRays(hy, VIOLET);
      if (rays) {
        c.globalAlpha = a0;
        /* Blitted in CSS pixels, so the buffer's own resolution - which is
           capped, see gridRays - is a detail of the cache rather than
           something the caller has to know about. The context's transform is
           already the device pixel ratio, so drawing it at (0, 0, w, h)
           stretches whatever is in the buffer across the whole frame. */
        c.drawImage(rays, 0, 0, this.w, this.h);
      } else {
        c.globalAlpha = a0;
        c.strokeStyle = VIOLET;
        c.lineWidth = Math.max(1, this.vs(1.2));
        c.shadowColor = VIOLET;
        c.shadowBlur = gb(this.vs(6));
        for (let i = -14; i <= 14; i++) {
          c.beginPath();
          c.moveTo(this.vx(0), hy);
          c.lineTo(this.vx(i * 110), bottom);
          c.stroke();
        }
      }
      // horizontals, scrolling toward the viewer
      c.strokeStyle = VIOLET;
      c.lineWidth = Math.max(1, this.vs(1.2));
      c.shadowColor = VIOLET;
      c.shadowBlur = gb(this.vs(6));
      const t = (g.time * 0.35) % 1;
      for (let i = 0; i < 12; i++) {
        const f = (i + t) / 12;
        const ly = hy + (bottom - hy) * f * f;
        c.globalAlpha = a0 * (0.25 + f * 0.75);
        c.beginPath();
        c.moveTo(0, ly);
        c.lineTo(this.w, ly);
        c.stroke();
      }
      hRestore(c);
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
      hRestore(c);
    }

    /** Key cap, for the controls card. A real key: a glass top with light on
        its upper face, a darker lip along its foot that gives it height, and
        a chrome hairline round it - cached per size, so a screen of twenty
        caps is twenty blits and twenty words. Same width as it always was;
        the rows lay their caps out by what this returns. */
    keycap(txt, x, y, size) {
      /* The site's keycap face: the display face's semibold, tracked a
         little. Measured in exactly what it is drawn in, below, or the cap
         is cut to one face and the word set in another. */
      const w = this.tw(txt, size * 0.54, 'lab', 0.06) + size * 0.85;
      const h = size * 1.15;
      const W = Math.round(w), H = Math.round(h);
      const cap = this.layer('cap|' + W + '|' + H, W + 8, H + 8, (cc) => {
        const p = this.vs(4), PW = this.vs(W), PH = this.vs(H);
        const r = Math.min(this.vs(4), PH * 0.2);
        const lip = PH * 0.16;
        const rr = (X, Y, w2, h2) => {
          cc.beginPath();
          cc.moveTo(X + r, Y); cc.lineTo(X + w2 - r, Y);
          cc.quadraticCurveTo(X + w2, Y, X + w2, Y + r);
          cc.lineTo(X + w2, Y + h2 - r);
          cc.quadraticCurveTo(X + w2, Y + h2, X + w2 - r, Y + h2);
          cc.lineTo(X + r, Y + h2);
          cc.quadraticCurveTo(X, Y + h2, X, Y + h2 - r);
          cc.lineTo(X, Y + r);
          cc.quadraticCurveTo(X, Y, X + r, Y);
          cc.closePath();
        };
        // the key's side, which is what the top sits on
        rr(p, p, PW, PH);
        cc.fillStyle = 'rgba(6,3,20,0.92)';
        cc.fill();
        // the top
        const top = cc.createLinearGradient(0, p, 0, p + PH - lip);
        top.addColorStop(0, 'rgba(78,62,150,0.96)');
        top.addColorStop(0.5, 'rgba(40,28,92,0.96)');
        top.addColorStop(1, 'rgba(24,16,60,0.96)');
        rr(p, p, PW, PH - lip);
        cc.fillStyle = top;
        cc.fill();
        cc.save();
        rr(p, p, PW, PH - lip);
        cc.clip();
        cc.fillStyle = 'rgba(255,255,255,0.16)';
        cc.fillRect(p, p, PW, (PH - lip) * 0.42);
        cc.restore();
        const rim = cc.createLinearGradient(0, p, 0, p + PH);
        rim.addColorStop(0, 'rgba(236,232,255,0.75)');
        rim.addColorStop(0.6, 'rgba(150,130,240,0.45)');
        rim.addColorStop(1, 'rgba(57,230,255,0.55)');
        cc.strokeStyle = rim;
        cc.lineWidth = Math.max(1, this.vs(1));
        rr(p, p, PW, PH);
        cc.stroke();
      });
      this.blitLayer(cap, x + w / 2, y);
      this.t(txt, x + w / 2 + size * 0.016, y + size * 0.07, size * 0.54, '#ffffff', 'center', 'lab',
        undefined, 0.06);
      return w;
    }

    /* The screen the menus are pretending to be on.

       Scanlines across the whole frame rather than only inside a panel, a
       phosphor tint, a soft edge falloff and a slow horizontal roll. Cheap, and
       it is what ties the panels, the chrome headline and the grid floor
       together into one object instead of three effects sharing a canvas. */
    /* THE SCANLINES, AS ONE FILL RATHER THAN THREE HUNDRED.
     *
     * The strip was drawn a line at a time: `for (y = 0; y < h; y += step)
     * fillRect(0, y, w, 1)`. At 1080p that is 216 rectangle fills every
     * frame, each the full width of the window, on every menu screen in the
     * game - and it is the same picture every time, because nothing about it
     * moves.
     *
     * A repeating pattern is the same image in one fill. The tile is one
     * pixel wide and `step` tall with its first row opaque, built once and
     * rebuilt only when the window changes size; the strength the caller
     * asks for rides on globalAlpha instead of being baked in, so the pause
     * screen's lighter version costs nothing extra either.
     *
     * The pattern is in USER space, which is already scaled by the device
     * pixel ratio - exactly as the fillRect it replaces was - so the line
     * weight is unchanged on every display. */
    scanPattern(step) {
      if (this._scanPat && this._scanStep === step) return this._scanPat;
      const tile = this._scanTile || (this._scanTile = global.document.createElement('canvas'));
      tile.width = 1;
      tile.height = Math.max(2, step);
      const tc = tile.getContext('2d');
      if (!tc) return null;
      tc.clearRect(0, 0, 1, tile.height);
      tc.fillStyle = '#000';
      tc.fillRect(0, 0, 1, 1);
      this._scanStep = step;
      this._scanPat = this.ctx.createPattern(tile, 'repeat');
      return this._scanPat;
    }

    crt(g, strength) {
      const c = this.ctx;
      const k = strength === undefined ? 1 : strength;
      c.save();
      // scanlines
      const step = Math.max(2, Math.round(this.vs(3)));
      const pat = this.scanPattern(step);
      /* Half the strength it was. At 0.20 the lines were the most visible
         texture on every menu - over the title screen they dimmed the attract
         drive by a fifth and read as an old monitor rather than as a finish -
         and the panels in front of them no longer carry a wash of their own. */
      if (pat) {
        c.globalAlpha = 0.10 * k;
        c.fillStyle = pat;
        c.fillRect(0, 0, this.w, this.h);
        c.globalAlpha = 1;
      } else {
        // a context that would not give us a pattern still gets its strip
        c.fillStyle = 'rgba(0,0,0,' + (0.10 * k) + ')';
        for (let y = 0; y < this.h; y += step) c.fillRect(0, y, this.w, 1);
      }
      // a bright band rolling slowly down the tube
      const roll = ((g.time * 0.08) % 1.4) * this.h - this.h * 0.2;
      const gr = c.createLinearGradient(0, roll - this.vs(90), 0, roll + this.vs(90));
      gr.addColorStop(0, 'rgba(120,220,255,0)');
      gr.addColorStop(0.5, 'rgba(120,220,255,' + (0.035 * k) + ')');
      gr.addColorStop(1, 'rgba(120,220,255,0)');
      c.fillStyle = gr;
      c.fillRect(0, roll - this.vs(90), this.w, this.vs(180));
      /* Corner falloff, so the picture sits inside a tube.
         The gradient is a function of the window and of nothing else, so it
         is built once per size rather than once per frame - a radial gradient
         with two stops is not free to construct, and this one was being
         constructed sixty times a second to produce the same object. The
         strength rides on globalAlpha for the same reason the strip's does. */
      if (!this._vig || this._vigW !== this.w || this._vigH !== this.h) {
        this._vigW = this.w; this._vigH = this.h;
        const rad = c.createRadialGradient(
          this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.30,
          this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.72);
        rad.addColorStop(0, 'rgba(0,0,0,0)');
        rad.addColorStop(1, 'rgba(2,0,10,1)');
        this._vig = rad;
      }
      c.globalAlpha = 0.55 * k;
      c.fillStyle = this._vig;
      c.fillRect(0, 0, this.w, this.h);
      hRestore(c);
    }

    scrim(a) {
      const c = this.ctx;
      c.save();
      c.fillStyle = 'rgba(6,0,18,' + a + ')';
      c.fillRect(0, 0, this.w, this.h);
      hRestore(c);
    }

    // ------------------------------------------------------------- draw --
    draw(g, dt) {
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.w, this.h);
      this.glyphFrame();
      /* The interface's own clock, in real seconds: what the menus' sweep
         runs on, so it keeps the site's beat under a pause and under FOCUS,
         both of which stop or slow the race's clock. */
      this.uiClock = (global.performance ? global.performance.now() : Date.now()) / 1000;

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
          /* WHERE THE ENTRANCE STARTS FROM, which was the last place the two
             halves of this still disagreed.
             A race with lights has already faded the instruments up to the
             ghost while the countdown ran, so the reveal carries on from
             there and the whole thing reads as one movement. A race WITHOUT
             lights has drawn nothing at all yet - every story chapter hands
             control back straight into 'racing', and so does a rewind and
             every cinematic that ends mid-route - and starting ITS reveal at
             the ghost put the entire interface on screen at a quarter opacity
             in a single frame and then faded the remaining three quarters in.
             Same animation, two different openings. That is what "the reveal
             is not consistent between the modes" looks like from the seat. */
          this.revealFrom = from === 'countdown' ? HUD_GHOST : 0;
          /* ...and the speedometer's peak mark, which is a property of a RUN
             and not of a session. Cleared on the same condition the entrance
             is, so a resumed pause keeps the mark it earned and a fresh start
             does not inherit the last route's. */
          this.peakSpeed = 0;
          this.spdShown = 0;
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
        /* A benchmark run shows the WORLD, not the title screen over it.

           The grade stays - it is part of what is being measured - but the
           wordmark and the three rows come off for the WHOLE run, calibration
           and report included. `benchDriving` was the wrong flag for this: it
           is only true while the three scenes are being driven, so START,
           OPTIONS and QUIT were still sitting there during the preset ladder
           in front of them and under the result card behind them - three
           controls that do nothing, on a screen that is busy. See js/bench.js. */
        case 'menu':
          if (!g.benchActive) this.drawMenu(g);
          this.crt(g, 1);
          break;
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
          const from0 = this.revealFrom === undefined ? HUD_GHOST : this.revealFrom;
          if (up < 1) this.veil(from0 + (1 - from0) * ease(up));
          break;
        }
        /* A modal replaces the instruments; it does not sit on top of them.
           Drawing both left the speedometer, the score, the clock and the
           DRIVETRAIN panel showing round the edges of the finish card at a quarter
           opacity - close enough to read, far enough from anything to look
           like a mistake, and the reason the card felt like it was overlapping
           something rather than being the screen. */
        /* The prologue's drive is the story's, and the story's cards are its
           instruments - with one exception: FOCUS is taught on that road, so
           its meter is up there too, in the corner it has in every race. */
        case 'story':
          if (g.story && g.story.mode === 'tutorial') this.focusMeter(g);
          break;
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
      /* THE ADAPTIVE SCALER, WHEN IT IS DOING SOMETHING.
       *
       * A renderer that quietly changes its own resolution and does not say
       * so is a renderer people report as "it goes blurry sometimes". The
       * plate grows a third line the moment the scaler is below full and
       * loses it again the moment it is back, so the reading is always the
       * truth about the frame being looked at - and on a machine that is
       * keeping up there is nothing extra to read.
       *
       * It is only ever shown beside the frame rate, which is the row that
       * asked to see how the game is performing. See Game.adaptResolution. */
      const dyn = g.dynScale === undefined ? 1 : g.dynScale;
      const scaled = dyn < 0.995;
      c.fillRect(this.vx(-628), this.vy(scaled ? 328 : 344),
        this.vs(150), this.vs(scaled ? 62 : 46));
      hRestore(c);
      this.label(now + ' FPS', -620, 330, 20, hue(now), 'left', 900);
      this.label('MIN ' + low, -620, 310, 13, hue(low), 'left', 700, 0.85);
      if (scaled) {
        this.label('RES ' + Math.round(dyn * (g.renderScale || 1) * 100) + '%', -620, 294, 13,
          '#8b5cf6', 'left', 700, 0.9);
      }
    }

    /* THE FALLBACK LOADING SCREEN.
     *
     * The cold open in js/ignition.js is what a player normally sees while the
     * game comes up, and it covers this completely - see the gate in
     * Game.draw. This is what is left when the cold open declined to run: a
     * machine with no 2D context of its own, or somebody who has asked for
     * reduced motion and should not be shown a shaking needle.
     *
     * It reads the SAME number the cold open does. It used to read
     * `g.loadProgress`, which is the scene loader's own fraction and therefore
     * sits at zero for the whole of the archive read - the first third of the
     * wait - and then races. NR.Boot is the whole boot, weighted, and every
     * phase reports into it. See js/boot.js. */
    drawLoading(g) {
      const c = this.ctx;
      c.save();
      c.fillStyle = '#05010f';
      c.fillRect(0, 0, this.w, this.h);
      hRestore(c);
      this.gridFloor(g, -150, 0.22);
      this.chrome('SYNX', 0, 78, 62, PINK);
      this.t('SYNTHWAVE  eXTREME  RACING', 0, 22, 16, '#cdeeff', 'center', 'lab', 0.95, 0.42);

      const B = global.NR.Boot;
      const p = Math.max(0, Math.min(1, B ? B.progress : (g.loadProgress || 0)));
      this.t(B ? B.label : 'LOADING', 0, -40, 15, CYAN, 'center', 'lab', 0.92, 0.2);
      // the title screen's glossy tube, filling
      this.gloss(0, -90, 360, 10, p, '#ff4f9a', 1);
      this.tGold(Math.round(p * 100) + '%', 0, -130, 30, 'center');
      if (B && B.detail) this.t(B.detail, 0, -168, 13, INK.mute, 'center', 'body', 0.7);
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

      /* SHADE UNDER THE TYPE. The title stands on the attract drive, and the
         drive is lit: a headlamp pool, a white verge and a pale road, any of
         which can end up behind CONTROLS - and white on white is not a menu.
         A soft pool of dark behind the column and a band along the foot for
         the hints, both feathered to nothing, so it reads as the picture
         being graded rather than as a panel being put over it. */
      {
        const c = this.ctx;
        c.save();
        c.translate(this.vx(0), this.vy(30));
        c.scale(this.vs(430), this.vs(320));
        const pool = c.createRadialGradient(0, 0, 0, 0, 0, 1);
        pool.addColorStop(0, 'rgba(4,1,12,0.40)');
        pool.addColorStop(0.62, 'rgba(4,1,12,0.20)');
        pool.addColorStop(1, 'rgba(4,1,12,0)');
        c.fillStyle = pool;
        c.fillRect(-1, -1, 2, 2);
        c.restore();
        const top = this.vy(-282);
        const band = c.createLinearGradient(0, top, 0, this.h);
        band.addColorStop(0, 'rgba(4,1,12,0)');
        band.addColorStop(0.55, 'rgba(4,1,12,0.55)');
        band.addColorStop(1, 'rgba(4,1,12,0.78)');
        c.save();
        c.fillStyle = band;
        c.fillRect(0, top, this.w, this.h - top);
        hRestore(c);
      }

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
      /* One sweep every six seconds, taking a second and a bit of it. Long
         enough apart that it reads as a highlight catching the logo rather
         than as an animation looping on it. */
      const cyc = (g.time % 6.2) / 1.15;
      this.chrome('SYNX', 0, titleY + bob, 96, PINK, undefined, cyc <= 1 ? cyc : -1);
      /* The line under the name, tracked wide in the text face. It was the
         display face spelled out with spaces between the letters - wider than
         the logo it sits under and glowing as hard as it. */
      this.t('SYNTHWAVE  eXTREME  RACING', 0, subtitleY + bob, 16, '#cdeeff', 'center', 'lab', 0.95, 0.42);
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
      // the bar arrives with the row it is on, not before it
      const cur = g.menuItems[g.menuIndex];
      const selK = cur ? ease(Math.min(1, cur.typed / Math.max(1, cur.label.length))) : 1;

      /* THE ROWS ARE BARS NOW - a rack of dark glass slots with the lit one
         gliding between them, after the reference's bevelled bars. They used
         to be three words in glowing type with a pink box and amber brackets
         round the chosen one, which is a web page's idea of a menu.

         EACH ROW STILL ARRIVES WHOLE, sliding the last few units into its
         slot on the same cascade it always used (see the menu loop in
         js/game.js), and the hit test is unchanged: 440 by 62 is inside the
         box Game.menuItemAt has always tested. */
      this.rack(items.map((it) => it.label), g.menuIndex, menuTop, menuGap, this.menuSelY,
        440, 62, selK, {
          size: 30,
          stagger: (i) => {
            const it = items[i];
            return ease(Math.max(0, Math.min(1, it.typed / Math.max(1, it.label.length))));
          },
        });

      // best time, as an instrument readout
      const by = menuTop - items.length * menuGap - 8;
      if (g.record != null) {
        this.plate(0, by, 300, 40, CYAN, 1, 12, 0.80);
        this.t('BEST', -112, by, 10.5, INK.mute, 'left', 'lab', 1, 0.24);
        this.t(fmtClock(g.record), 22, by, 23, '#ffffff', 'center', 'num');
      }

      /* ...and where the game lives, on the same line as the control hints.
         On its own line under them it would sit at -348, which is three units
         outside the bracket frame this screen is drawn inside - and above them
         it has the BEST panel to argue with. The footer is the one band on
         this screen that is already nothing but small print. */
      /* WHAT IS ACTUALLY BEHIND START. The terminal has offered three doors
         since multiplayer shipped and this line named two of them, so the one
         mode a player would have to be told about was the one the title
         screen did not mention. */
      /* IN THREE PARTS, the way every other screen's foot is set: what is
         behind START on the left, the keys in the middle as KEYS - the same
         caps the controls card uses - and where the game lives on the right.
         It was one line of 500-weight type at sixty per cent, which over the
         lit road was the least legible thing in the game. */
      {
        const fy = -330;
        this.label('START  //  STORY  /  MULTIPLAYER  /  FREE ROAM', -586, fy, 12,
          INK.body, 'left', 600, 0.92);
        this.label('SYNX-RACING.VERCEL.APP', 586, fy, 12, INK.mute, 'right', 600, 0.92);
        const KS = 20, GAP = 9, SP = 28;
        const kw = (t) => this.textWidth(t, KS * 0.62, 700) + KS * 0.85;
        const lw = (t) => this.textWidth(t, 12, 700);
        const total = kw('ARROWS') + GAP + lw('SELECT') + SP + kw('ENTER') + GAP + lw('CONFIRM');
        let x = -total / 2;
        x += this.keycap('ARROWS', x, fy, KS) + GAP;
        this.label('SELECT', x, fy, 12, INK.body, 'left', 700, 0.92);
        x += lw('SELECT') + SP;
        x += this.keycap('ENTER', x, fy, KS) + GAP;
        this.label('CONFIRM', x, fy, 12, INK.body, 'left', 700, 0.92);
      }

      const frameW = Math.min(1230, this.vw - 30);
      const frameH = Math.min(690, this.vh - 30);
      this.brackets(0, 0, frameW, frameH, 'rgba(139,92,246,0.55)', 34, 0.8);
      this.sweep(g, 1);
      if (reveal < 1) hRestore(c);
    }

    // ------------------------------------------------------------ HUD ----
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
      // whether the region card is up - the toast stack steps down for it
      this.bannerUp = !!(g.freeRoam && g.freeRoamBanner);
      if (g.freeRoam && g.freeRoamBanner) {
        const b = g.freeRoamBanner, LIFE = 5.4;
        const a = Math.min(Math.min(1, b.t * 2.6), Math.max(0, LIFE - b.t));
        quiet = 1 - Math.max(0, Math.min(1, a)) * 0.76;
      }

      /* ------------------------------------------ FROM THE DRIVING SEAT --
       *
       * THE CAR HAS INSTRUMENTS OF ITS OWN NOW. From the seat the dash
       * cluster reads the speed, the revs, the gear and the reserve (see
       * CabCluster in js/scene.js), and the boost control on the pod lights
       * when it is pressed - so the overlay's dial, drivetrain scope, boost
       * bar, radio panel and flags were a second set of the same instruments
       * printed over the first, across the lower third of the one view where
       * that third is the car.
       *
       * So in the seat they step back and what is left is what the car
       * cannot tell you: the clock, the run, the rival, the score. Those stay
       * high on the glass where they were, the clock joins them under the
       * route rail, a new song is named once as it starts, and a slide is
       * read out in one line above the wheel rim. It is a CROSSFADE rather
       * than a switch, on its own clock, because the camera moving into the
       * seat is itself a move (see Game.frameCam) and an interface that
       * snapped halfway through it would be the only thing in the frame
       * that cut. */
      const inSeat = !!(g.inCar && g.inCar());
      const dtH = Math.min(0.05, this._dt || 0.016);
      this.povK = this.povK === undefined ? (inSeat ? 1 : 0)
        : this.povK + ((inSeat ? 1 : 0) - this.povK) * (1 - Math.exp(-7 * dtH));
      if (Math.abs(this.povK - (inSeat ? 1 : 0)) < 0.002) this.povK = inSeat ? 1 : 0;
      const pk = this.povK, ck = 1 - pk;

      // FOCUS online, on the road itself - first, so every instrument is over it
      this.drawPrecog(g);

      if (ck > 0.001) {
        /* THE CLUSTER: speed, revs, the shift lights and the gear ladder in
           one instrument in the bottom-right corner. See CL. */
        this.cluster(g);

        /* THE DRIVETRAIN PANEL, bottom left: the engine's trace, the gear as
           the big figure, the revs along its floor. It is the instrument this
           game has always had and nobody else does. See Hud.catScope. */
        this.catScope(g);

        /* THE BOOST BAR, bottom centre, in its twenty-four cells - the one
           place the reserve is shown, and the count the story chapters were
           tuned against ("how many goes have I got"). See Hud.boostMeter. */
        this.boostMeter(g, 1, BST);

        // ...and the radio, under the bar. See Hud.radioBox.
        this.radioBox(g);

        /* ...and the map, over the DRIVETRAIN panel. See Hud.minimap. */
        this.minimap(g);

        /* Nothing else is on the canvas yet, so this fades exactly the group
           above and nothing after it. */
        if (pk > 0.001) this.veil(ck);
      }
      if (pk > 0.001) this.drawSeatHud(g, pk);

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
        const col = lead ? MINT : PINK;
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
        /* SET AS A RACE POSITION IS SET: the place as a big figure, the
           ordinal small and high beside it, the field under that, and the gap
           as the second-largest number on this side - the two things a player
           glances up for, in the order they want them. */
        this.t(raceTotal > 2 ? 'POSITION  //  ' + raceTotal + ' CARS' : 'POSITION', RX, 285, 10.5,
          INK.mute, 'left', 'lab', 1, 0.22);
        const suffix = racePlace === 1 ? 'ST' : (racePlace === 2 ? 'ND' : (racePlace === 3 ? 'RD' : 'TH'));
        const pn = String(racePlace);
        this.t(pn, RX - 3, 251, 48, '#ffffff', 'left', 'num');
        const pw = this.tw(pn, 48, 'num');
        this.t(suffix, RX + pw - 1, 263, 16, col, 'left', 'num');
        this.t('/' + raceTotal, RX + pw, 242, 14, INK.mute, 'left', 'numL');
        /* Past a kilometre it is read in kilometres. This used to cap at
           '999+' and then put the sign in front, which printed "+999+ M" -
           two plus signs on the one number on this side that is a delta. */
        const txt = gap >= 1000 ? Math.min(99.9, gap / 1000).toFixed(1) + ' KM'
          : gap.toFixed(0) + ' M';
        const gx = RX + 84;
        // which way the gap runs, as an arrow rather than as a sign alone
        {
          const c = this.ctx, ax = this.vx(gx + 5), ay = this.vy(254), s = this.vs(5.5);
          c.save();
          c.fillStyle = col;
          c.beginPath();
          if (lead) { c.moveTo(ax, ay - s); c.lineTo(ax + s, ay + s * 0.8); c.lineTo(ax - s, ay + s * 0.8); }
          else { c.moveTo(ax, ay + s); c.lineTo(ax + s, ay - s * 0.8); c.lineTo(ax - s, ay - s * 0.8); }
          c.closePath();
          c.fill();
          hRestore(c);
        }
        this.t((lead ? '+' : '-') + txt, gx + 16, 254, 21, col, 'left', 'num');
        this.t(lead ? 'AHEAD' : 'BEHIND', gx + 16, 236, 9.5, INK.mute, 'left', 'lab', 1, 0.24);
        /* The rail: where the two cars are relative to each other, with this
           car as the notch in the middle. From the seat the BODY readout
           hangs under this group, so there the rail tucks up under the
           number - see BODY INTEGRITY below. */
        const c = this.ctx;
        const tuck = pk * 6;
        const bw = RIVAL_W, bx = RX, by = 224 + tuck;
        c.save();
        c.fillStyle = 'rgba(255,255,255,0.14)';
        c.fillRect(this.vx(bx), this.vy(by) - this.vs(1), this.vs(bw), this.vs(2));
        const f = Math.max(-1, Math.min(1, (g.rivalGap || 0) / 200));
        const mid = bx + bw * 0.5;
        c.fillStyle = 'rgba(255,255,255,0.75)';
        c.fillRect(this.vx(mid) - this.vs(0.75), this.vy(by + 4), this.vs(1.5), this.vs(8));
        const mx = this.vx(mid + f * bw * 0.5), my = this.vy(by);
        const dot = this.glowDot(col);
        c.drawImage(dot.cv, mx - dot.s * 0.45, my - dot.s * 0.45, dot.s * 0.9, dot.s * 0.9);
        c.fillStyle = col;
        c.beginPath();
        c.moveTo(mx, my - this.vs(5));
        c.lineTo(mx + this.vs(4), my);
        c.lineTo(mx, my + this.vs(5));
        c.lineTo(mx - this.vs(4), my);
        c.closePath();
        c.fill();
        hRestore(c);
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
        /* CLEAR OF THE COMBO ABOVE IT.
           The score stack on this flank ends with the multiplier at y=216, and
           26-point type on that baseline reaches down to 203. This group's
           state word sits at ry+26, so at ry=176 the word CHARGING was drawn
           one unit under the bottom of the x6 - they touched, and read as one
           line saying "x6 CHARGING". Twenty-six units lower leaves a clear
           band between the two instruments, which is what says they are two
           instruments. */
        const rx = 570, ry = 150;
        const ready = !rm.active && rm.cooldown <= 0;
        const col = rm.active ? '#45d7ff' : (ready ? MINT : '#9a8cff');
        /* THE KEY, NOT THE LETTER R. This widget is the merge of three that
           each drew their own meter, and the wording it inherited had the
           key typed into it - so moving RACE MODE off R left the one place
           that tells the player how to spend it pointing at the old key. */
        const rk = keyFor(g, 'raceMode');
        const tail = rm.active ? rm.timer.toFixed(1) + 's'
          : (ready ? (rk || '') : Math.ceil(rm.cooldown) + 's');
        /* One bar, three meanings, and it always fills toward the right:
           ACTIVE counts the window down, COOLDOWN counts the wait back up,
           READY is full. A meter that emptied for one and filled for another
           is a meter the player has to think about. */
        const f = rm.active ? Math.max(0, rm.timer / Math.max(1, rm.window))
          : (ready ? 1 : 1 - rm.cooldown / Math.max(1, rm.rest));
        const pulse = ready ? 0.72 + 0.28 * Math.sin(g.time * 4) : 1;
        this.t(rm.active ? 'SYNCHRONIZED' : ready ? 'READY' : 'CHARGING',
          rx, ry + 24, 10, INK.mute, 'right', 'lab', 0.9, 0.22);
        const tw = tail ? this.tw(tail, 17, 'num') + 8 : 0;
        this.t('raceMode', rx - tw, ry + 2, 17, col, 'right', 'num', pulse);
        if (tail) this.t(tail, rx, ry + 2, 17, '#ffffff', 'right', 'num', pulse);
        this.gloss(rx - 75, ry - 15, 150, 6, f, col);
        /* ...and the reserve, which only Chapter 6 and 7 hand out. It is a
           second, shorter bar under the first rather than a second widget. */
        if (rm.reserveLive) {
          this.t('BLUE RESERVE', rx - 158, ry - 15, 10, '#75e8ff', 'right', 'lab', 0.9, 0.18);
        }
      }

      // ...and FOCUS, its mirror in the top-left corner. See Hud.focusMeter.
      this.focusMeter(g);

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
        this.t('SCORE', sx, 285, 10.5, INK.mute, 'right', 'lab', 1, 0.22);
        /* GOLD, the way the reference's bars are rimmed: a vertical ramp from
           a pale highlight through the amber the score has always been to a
           burnt edge, which reads as metal where a flat amber reads as paint. */
        this.tGold(String(Math.round(this.scoreShown)), sx, 254, 34, 'right');
        if (g.combo > 1) {
          /* THE MULTIPLIER IS A BADGE, not a second number: a magenta plate
             with the figure on it, which says "this multiplies" without a
             word and cannot be read as part of the score above it. */
          const p = 0.80 + 0.20 * Math.sin(g.time * 7);
          const txt = 'x' + g.combo;
          const bw = Math.max(40, this.tw(txt, 17, 'num') + 26);
          this.plate(sx - bw / 2, 222, bw, 24, PINK, p, 8, 0.90);
          this.t(txt, sx - bw / 2 + 2, 222, 17, '#ffffff', 'center', 'num', p);
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
      /* In the chase view this is the rail beside the map - see Hud.minimap.
         From the seat the map is not drawn (the left flank is the door and
         the dash), so there it is a bar over the rim, RIGHT of the boost
         meter - the reserves and the state of the car in the one band the eye
         already reads from in there, crossfaded with the rest of the seat's
         layer. It used to hang under the rival readout, which is the
         slipstream's slot (see draftChip): the two were drawn through each
         other whenever a damaged car sat in a tow. Right, not left, because
         the story's dialogue card owns the left flank down to y -88 on a
         small window. */
      if (g.damage && g.damage.total > 0.02 && pk > 0.001 &&
          (g.state === 'racing' || g.state === 'countdown')) {
        const d = Math.min(1, g.damage.total);
        const col = d > 0.66 ? '#ff3c6e' : (d > 0.33 ? AMBER : CYAN);
        /* What it is costing, in the only currency this game has. Below about
           a tenth it rounds to nothing and saying "-0%" is worse than saying
           nothing at all. */
        const loss = Math.round((1 - 1 / Math.sqrt(1 + 0.42 * d)) * 100);
        const BW = 116, bx = SEAT_BST.x + SEAT_BST.w / 2 + 34 + BW / 2, by = SEAT_BST.y;
        this.t('BODY', bx - BW / 2, by + 11, 10, INK.mute, 'left', 'lab', 0.9 * pk, 0.2);
        this.gloss(bx, by, BW, 5, 1 - d, col, 0.92 * pk);
        if (loss >= 1) {
          this.t('-' + loss + '% TOP END', bx + BW / 2, by - 11, 9.5, col, 'right', 'lab',
            pk * (d > 0.66 ? 0.55 + 0.45 * Math.sin(g.time * 5) : 0.85), 0.12);
        }
      }

      /* THE AUTOSAVE MARK.
         It is deliberately the smallest thing on the screen: what the player
         needs to know is that it happened, not to be told about it. Two
         seconds, on the rail the progress bar already owns, in the same green
         the tour's own confirmations use.

         ABOVE THE RAIL, NOT UNDER IT. It used to sit at y 300, which is the
         line UNDER the rail - and that line already has two tenants: the
         distance readout on the right, and, in Free Roam, the route banner on
         the left at x -450. SAVED is drawn at x -452 and left aligned, so the
         two were printed through each other on the one screen where the mark
         fires most: a tour autosaves as it goes, and every one of them landed
         on top of FREE ROAM // THE SPINE.

         The band above the rail is empty in every mode, which is the whole
         reason to use it - a mark that has to dodge one tenant today would
         only have to dodge the next one later. */
      if (g.autosave && g.autosave.notify > 0 &&
          (g.state === 'racing' || g.state === 'countdown')) {
        const a = Math.min(1, g.autosave.notify / 0.5);
        this.t('SAVED', -380, 338, 10, MINT, 'left', 'lab', a * 0.9, 0.24);
      }

      // Run progress: a thin rail across the top with a marker for the car.
      // A 22 km course needs some sense of how much of it is left.
      if (g.state === 'racing' || g.state === 'countdown') {
        const c = this.ctx;
        const w = 760, y = 326;
        const f = Math.max(0, Math.min(1, g.progress || 0));
        const X0 = this.vx(-w / 2), W = this.vs(w), Y = this.vy(y);
        c.save();
        c.fillStyle = 'rgba(255,255,255,0.13)';
        c.fillRect(X0, Y - this.vs(1), W, this.vs(2));
        /* The road behind, as light running from cyan into the magenta of the
           marker - the same ramp the cluster's sector uses, so the two read
           as one instrument family. One gradient a frame, no blur. */
        if (f > 0.001) {
          const gr = c.createLinearGradient(X0, 0, X0 + W, 0);
          gr.addColorStop(0, '#2fd8ff');
          gr.addColorStop(0.55, '#8b5cf6');
          gr.addColorStop(1, '#ff3ca8');
          c.fillStyle = gr;
          c.fillRect(X0, Y - this.vs(1.5), W * f, this.vs(3));
        }
        /* Checkpoint ticks - or, on a Free Roam tour, the six handovers
           between the seven regions. Fifths of a hundred and twenty-seven
           kilometres mean nothing to anybody; the country changing does, and
           it is what a player on this rail is counting down to. */
        const tick = (q, done) => {
          c.fillStyle = done ? 'rgba(255,255,255,0.70)' : 'rgba(255,220,140,0.75)';
          c.fillRect(this.vx(-w / 2 + w * q) - this.vs(0.75), Y - this.vs(5), this.vs(1.5), this.vs(10));
        };
        if (g.freeRoam && g.regionEdges) {
          const span = Math.max(1, g.finishAt - g.startAt);
          for (let i = 1; i < g.regionEdges.length; i++) {
            const q = (g.regionEdges[i] - g.startAt) / span;
            if (q <= 0.004 || q >= 0.996) continue;
            tick(q, q <= f);
          }
        } else {
          for (let i = 1; i < 5; i++) tick(i / 5, i / 5 <= f);
        }
        // the finish, as a flag of two squares at the end of the rail
        c.fillStyle = 'rgba(255,255,255,0.85)';
        c.fillRect(X0 + W + this.vs(4), Y - this.vs(5), this.vs(4), this.vs(4));
        c.fillRect(X0 + W + this.vs(8), Y - this.vs(1), this.vs(4), this.vs(4));
        c.fillRect(X0 + W + this.vs(4), Y + this.vs(3), this.vs(4), this.vs(2));
        // the car on it: a light and a diamond
        const mx = X0 + W * f;
        const dot = this.glowDot('#ff3ca8');
        c.drawImage(dot.cv, mx - dot.s * 0.55, Y - dot.s * 0.55, dot.s * 1.1, dot.s * 1.1);
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(mx, Y - this.vs(6));
        c.lineTo(mx + this.vs(5), Y);
        c.lineTo(mx, Y + this.vs(6));
        c.lineTo(mx - this.vs(5), Y);
        c.closePath();
        c.fill();
        hRestore(c);
        const left = Math.max(0, (g.finishAt - g.distance)) * 0.733 / 1000;
        const lt = left.toFixed(2);
        this.t('KM TO GO', w / 2, y - 18, 10.5, INK.mute, 'right', 'lab', 1, 0.2);
        this.t(lt, w / 2 - this.tw('KM TO GO', 10.5, 'lab', 0.2) - 6, y - 18, 15, '#ffffff', 'right', 'num');
        if (g.level) {
          const mode = g.freeRoam ? 'FREE ROAM' : 'ROUTE';
          this.t(mode, -w / 2, y - 18, 10.5, '#ff6ab8', 'left', 'lab', 1, 0.2);
          this.t(g.level.name, -w / 2 + this.tw(mode, 10.5, 'lab', 0.2) + 10, y - 18, 12.5,
            INK.key, 'left', 'lab', 1, 0.14);
        }
      }

      /* THE RACE CLOCK, on a plate under the middle of the rail - in both
         views, because it is the one readout every view wants in the same
         place. The record rides under it, and says nothing at all on a route
         nobody has finished. */
      if (g.state === 'racing' || g.state === 'countdown' || g.state === 'startcard') {
        this.plate(0, 282, 214, 34, '#ff3ca8', 1, 10, 0.80);
        this.t('TIME', -84, 282, 9.5, INK.mute, 'left', 'lab', 1, 0.24);
        this.t(fmtClock(g.raceTime), 16, 282, 23, '#ffffff', 'center', 'num');
        if (g.record != null) {
          this.t('BEST  ' + fmtClock(g.record), 0, 257, 10.5, INK.mute, 'center', 'lab', 0.95, 0.16);
        }
        this.songCue(g);
        this.draftChip(g);
      }

      /* AND NOW THE WHOLE CLUSTER STEPS BACK, in one operation.
         It used to be threaded as a quiet multiplier through the individual
         draws - and only through SOME of them. The speedometer, the boost
         meter and the rival readout dimmed for the handover card; the clock,
         the TIME label, the DRIVETRAIN scope, the flags and the record did
         not. Half an interface stepping back for a card and the other half
         standing its ground is worse than neither, and it is what the report
         meant by the reveal not being consistent.

         veil() scales what is already on the canvas, so it cannot miss an
         element the way a threaded argument can: anything drawn above this
         line dims, anything below it does not, and the card itself is below
         it. Nothing has to remember to opt in. */
      if (quiet < 0.999) this.veil(quiet);

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
          /* It arrives: the plate slides the last few units in from the left
             while it fades up, on the same curve every arriving card uses. */
          const ink = overshoot(Math.min(1, b.t * 2.4));
          const dx = (1 - ink) * -26;
          this.plate(dx, 214, 560, 98, '#ffb400', a, 22, 0.80);
          this.t(b.kicker, dx, 245, 11, '#ffd38a', 'center', 'lab', a * 0.95, 0.30);
          this.hero(b.title, dx, 214, 32, '#ffffff', 'center', a, '#ff9a3c');
          this.t(b.note, dx, 186, 12, INK.body, 'center', 'body', a * 0.9, 0.04);
        }
      }

      /* Drift meter: only present while the rear is actually sliding, so it
         never clutters a clean lap.

         Off to the left, not in the middle. Dead centre and a hundred and
         fifty units down is exactly where the chase camera puts the car, so
         the word DRIFT was printed across the roof of the thing the player is
         watching - at the one moment in the game when they most need to see
         it. */
      /* FROM THE SEAT IT IS ONE LINE, just above the boost meter over the
         rim, where the eye is while the car is sideways - the stacked version
         below sits on the dash and the left pillar from in there. High enough
         that its shade band clears the meter's reading (SEAT_BST). */
      if (car.driftAmount > 0.04 && pk > 0.001) {
        const a = Math.min(1, car.driftAmount * 1.6) * pk;
        const deg = Math.abs(car.bodySlip || 0) * 57.2958;
        const y = -32;
        const bank = g.driftBank > 40 ? '+' + Math.round(g.driftBank * g.combo) : '';
        const ang = deg.toFixed(0) + '°', GAP = 12;
        // measured, so the line is centred whatever the numbers are
        const w0 = this.tw('DRIFT', 19, 'num'), w1 = this.tw(ang, 16, 'numL');
        const w2 = bank ? this.tw(bank, 19, 'num') : 0;
        const span = w0 + GAP + w1 + (bank ? GAP + w2 : 0);
        let x = -span / 2;
        /* A BAND OF SHADE UNDER IT. From the seat this line is over the road
           just ahead of the bonnet, which is the brightest thing in a lit
           frame, and pink on pale tarmac is a word nobody can read. Feathered
           at both ends so it is a shadow and not a box. */
        {
          const c = this.ctx, bw = span + 90, x0 = this.vx(-bw / 2), x1 = this.vx(bw / 2);
          const sh = c.createLinearGradient(x0, 0, x1, 0);
          sh.addColorStop(0, 'rgba(6,2,18,0)');
          sh.addColorStop(0.18, 'rgba(6,2,18,0.55)');
          sh.addColorStop(0.82, 'rgba(6,2,18,0.55)');
          sh.addColorStop(1, 'rgba(6,2,18,0)');
          c.save();
          c.globalAlpha = a;
          c.fillStyle = sh;
          c.fillRect(x0, this.vy(y + 16), x1 - x0, this.vs(38));
          hRestore(c);
        }
        this.hero('DRIFT', x, y, 19, '#ff7ac4', 'left', a, PINK, 'num');
        x += w0 + GAP;
        this.t(ang, x, y, 16, '#ffffff', 'left', 'numL', a);
        x += w1 + GAP;
        if (bank) this.t(bank, x, y, 19, '#7fe9ff', 'left', 'num', a);
        // the slide's size, as a rule under the line that grows with it
        const c = this.ctx;
        c.save();
        c.globalAlpha = a * 0.85;
        c.fillStyle = PINK;
        c.shadowColor = PINK;
        c.shadowBlur = gb(this.vs(8));
        const rw = 36 + 150 * Math.min(1, car.driftAmount);
        c.fillRect(this.vx(-rw / 2), this.vy(y - 14), this.vs(rw), this.vs(2));
        hRestore(c);
      }
      if (car.driftAmount > 0.04 && ck > 0.001) {
        const a = Math.min(1, car.driftAmount * 1.6) * ck;
        const x = -246, y = -116;
        /* A TAG, NOT A SHOUT. The word on a magenta-edged plate with the
           angle it is carrying beside it, the slide's size as a row of cells
           under that, and the bank it is building as the number underneath -
           the same plate and cells the rest of the instruments are made of. */
        const deg = Math.abs(car.bodySlip || 0) * 57.2958;
        const ang = deg.toFixed(0) + '°';
        this.plate(x, y, 176, 38, PINK, a, 12, 0.78);
        this.hero('DRIFT', x - 16, y, 22, '#ff8acb', 'center', a, PINK, 'num');
        this.t(ang, x + 52, y, 18, '#ffffff', 'center', 'numL', a);
        const c = this.ctx;
        c.save();
        c.globalAlpha *= a;
        const n = 8, lit = Math.min(n, car.driftAmount * n);
        for (let i = 0; i < n; i++) {
          const k = Math.max(0, Math.min(1, lit - i));
          const cx = this.vx(x - 76 + i * 19.5), cy = this.vy(y - 30);
          const w = this.vs(14), h = this.vs(5), s = this.vs(3);
          c.globalAlpha = a * (k > 0 ? 0.35 + 0.65 * k : 0.22);
          c.fillStyle = k > 0 ? mixHex2('#b03cff', '#ff3ca8', i / (n - 1)) : 'rgba(150,130,230,0.7)';
          c.beginPath();
          c.moveTo(cx + s, cy - h / 2);
          c.lineTo(cx + w, cy - h / 2);
          c.lineTo(cx + w - s, cy + h / 2);
          c.lineTo(cx, cy + h / 2);
          c.closePath();
          c.fill();
        }
        hRestore(c);
        // and the bank it is building, which pays out when the slide lands
        if (g.driftBank > 40) {
          this.t('+' + Math.round(g.driftBank * g.combo), x, y - 58, 24, '#7fe9ff', 'center', 'num', a);
        }
      }

      // Off-road warning, framed rather than bare text
      if (car.offroad && g.state === 'racing') {
        const p2 = 0.4 + 0.6 * Math.sin(g.time * 12);
        this.brackets(0, 0, 1180, 640, PINK, 40, p2 * 0.5);
      }

      // No lap-progress bar: the shipped HUD has none, and the one drawn here
      // sat across the top of the screen.
      /* Above the boost bar behind the car; from the seat that height is the
         dash and its own screen, so there the warning sits on the glass over
         the drift line's shade band (-16..-54) and under the toast stack's
         lowest slot (53..83). */
      if (car.offroad && g.state === 'racing') {
        const p3 = 0.55 + 0.45 * Math.sin(g.time * 12);
        const oy = pk > 0.5 ? 4 : -232;
        this.plate(0, oy, 196, 36, PINK, p3, 12, 0.82);
        this.hero('OFF ROAD', 0, oy, 20, '#ffffff', 'center', p3, PINK, 'num');
      }
      /* Pointed back down the road. The route behind the car is a wall now, so
         a player who has spun has to be told which way out is - otherwise they
         drive into an invisible one and conclude the game is stuck. */
      this.wrongWayUp = (car.wrongWay || 0) > 0.55 && g.state === 'racing';
      if (this.wrongWayUp) {
        const wp = 0.5 + 0.5 * Math.sin(g.time * 9);
        this.plate(0, 86, 330, 74, '#ff7a2a', 0.92, 22, 0.80);
        this.hero('WRONG WAY', 0, 94, 30, '#ffffff', 'center', 0.55 + 0.45 * wp, '#ff7a2a');
        this.t('TURN AROUND', 0, 64, 11, '#ffc08a', 'center', 'lab', 0.9, 0.30);
        this.brackets(0, 0, 1180, 640, '#ff7a2a', 40, wp * 0.35);
      }
    }

    /* ------------------------------------------------ THE SEAT'S LAYER --
     *
     * What the overlay still has to say once the car's own dash is saying
     * the rest - see the note at the top of drawHud. `k` is how far into the
     * seat the view has come, 0..1, and every alpha here is multiplied by it.
     *
     * All of it sits in the band above the header rail and under the route
     * rail, which from the seat is the roof lining - dark, still, and the one
     * part of the frame that is never the road.
     */
    drawSeatHud(g, k) {
      const dt = Math.min(0.05, this._dt || 0.016);

      // the reserve, over the rim - see SEAT_BST
      this.boostMeter(g, k, SEAT_BST);

      /* THE CLOCK is the shared plate under the route rail now, and the song
         is the shared cue under it - both drawn for both views by drawHud.
         They used to be drawn here for the seat only, in different faces
         from the chase view's. */
      void dt;
    }

    /* A NEW SONG IS NAMED ONCE, as it starts, and then leaves the glass to
     * the road.
     *
     * It used to be a permanent panel above the speedometer in the chase
     * view - a spectrum, a tuner and a title, for the whole of every run -
     * and from the seat a line that came and went. A song's name is the
     * least urgent thing in the frame, so both views now do what the seat
     * did: say it for four seconds under the clock, on a slim plate with the
     * station's light breathing beside it, and go. Not over the region card,
     * which is the one thing on screen it would be competing with. */
    songCue(g) {
      /* From the seat only. Behind the car the radio is the strip under the
         boost bar now, and it announces a new song itself - see radioBox. */
      if (!(g.inCar && g.inCar())) return;
      const dt = Math.min(0.05, this._dt || 0.016);
      const a = g.audio;
      const np = a && a.nowPlaying ? a.nowPlaying() : null;
      if (np && np.key !== this.seatSongKey) { this.seatSongKey = np.key; this.seatSongT = 0; }
      this.seatSongT = (this.seatSongT === undefined ? 1e3 : this.seatSongT) + dt;
      const SONG = 4.6, st = this.seatSongT;
      if (!np || st >= SONG || g.freeRoamBanner) return;
      const s = Math.min(1, st / 0.35) * Math.min(1, (SONG - st) / 0.7);
      const ink = overshoot(Math.min(1, st / 0.45));
      const col = np.onAir ? CYAN : AMBER;
      const head = np.onAir ? 'NOW PLAYING  //  ' + np.station + '  ' + np.freq.toFixed(1) : 'NOW PLAYING';
      const w = Math.round((Math.max(this.tw(head, 9.5, 'lab', 0.22), this.tw(np.title, 16, 'num')) + 64) / 8) * 8;
      /* WHERE IT IS SAID depends on where the eye is. Behind the car it is the
         radio, so it sits by the map in the bottom-left corner, out of the
         column the clock and the notifications already share; from the seat
         the bottom of the glass is the dash, so there it hangs under the
         clock as it always did. */
      const seat = !!(g.inCar && g.inCar());
      const x = (seat ? 0 : MM.x - MM.r - 8 + w / 2) + (1 - ink) * (seat ? 18 : -30);
      const y = seat ? 222 : MM.y + MM.r + 38;
      this.plate(x, y, w, 38, col, s, 12, 0.78);
      // the station's light, breathing while it is on the air
      const beat = np.onAir ? 0.55 + 0.45 * Math.sin(g.time * 3.1) : 0.9;
      const d = this.glowDot(col);
      const lx = this.vx(x - w / 2 + 24), ly = this.vy(y);
      const c = this.ctx;
      c.save();
      c.globalAlpha *= s * beat;
      c.drawImage(d.cv, lx - d.s * 0.4, ly - d.s * 0.4, d.s * 0.8, d.s * 0.8);
      hRestore(c);
      this.t(head, x + 8, y + 8, 9.5, col, 'center', 'lab', s * 0.92, 0.22);
      this.t(np.title, x + 8, y - 8, 16, '#ffffff', 'center', 'num', s);
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
      const B = global.NR.PAD_BUTTONS || {};
      const live = !!(pad && pad.active);

      // local unit -> HUD unit -> canvas pixel, in one step
      const S = (n) => this.vs(n * scale);
      const X = (x) => this.vx(cx + x * scale);
      /* LOCAL +Y POINTS DOWN, and the HUD's points up.
         The geometry is written the way a drawing is - triggers at the top
         with a negative y - so the flip happens here, once, rather than every
         literal in the path being negated and one of them being missed. */
      const Y = (y) => this.vy(cy - y * scale);

      /* Dimmed when nothing is attached, but only by a third - this is still
         the reference for a pad about to be plugged in, and at a third it was
         a smudge rather than a diagram. */
      const alpha = live ? 1 : 0.62;
      const rim = live ? 'rgba(57,230,255,' : 'rgba(150,180,222,';
      const on = AMBER;
      const held = (i) => !!(pad && i !== undefined && pad.held(i));
      const font = (px) => '900 ' + S(px) + 'px "Orbitron", system-ui, sans-serif';
      const text = (str, x, y, px, col) => {
        c.fillStyle = col;
        setFont(c, font(px));
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(str, X(x), Y(y) + S(0.4));
      };

      c.save();
      c.globalAlpha = alpha;
      c.lineJoin = 'round';
      c.lineCap = 'round';

      /* ============================================== THE SHELL, AS ONE PATH
       *
       * A modern pad seen from the front: a top edge that rises into two
       * shoulders, flanks that fall away into grips hanging down and out, and a
       * belly that dips between the hands. Written as the RIGHT half, from the
       * top centre round to the bottom centre, and mirrored - so the two sides
       * cannot disagree, and a change to the shape is a change to one list.
       *
       * `k` and `oy` inset it: the faceplate line inside the rim is the same
       * outline drawn smaller, which is what makes the body read as a moulding
       * with an edge rather than as a flat cut-out. */
      const HALF = [
        // [c1x, c1y, c2x, c2y, x, y] from the previous point
        [26, -38, 52, -42, 78, -47],        // top edge, rising to the shoulder
        [100, -51, 121, -45, 128, -26],     // the shoulder rolls over
        [134, -8, 137, 18, 134, 40],        // outer flank
        [131, 62, 119, 80, 101, 81],        // the end of the grip
        [85, 82, 74, 72, 66, 60],           // inside of the grip
        [58, 50, 46, 44, 30, 44],           // into the belly
        [18, 44, 8, 46, 0, 46],             // bottom centre
      ];
      const shell = (k, oy) => {
        const px = (x) => X(x * k), py = (y) => Y(y * k + oy);
        c.beginPath();
        c.moveTo(px(0), py(-38));
        for (const s of HALF) c.bezierCurveTo(px(s[0]), py(s[1]), px(s[2]), py(s[3]), px(s[4]), py(s[5]));
        // ...and back up the left side, the same curves mirrored and reversed
        for (let i = HALF.length - 1; i >= 0; i--) {
          const s = HALF[i];
          const prev = i > 0 ? HALF[i - 1] : [0, 0, 0, 0, 0, -38];
          c.bezierCurveTo(px(-s[2]), py(s[3]), px(-s[0]), py(s[1]), px(-prev[4]), py(prev[5]));
        }
        c.closePath();
      };

      /* =================================== TRIGGERS AND BUMPERS, CLEAR OF IT
       *
       * They used to be four pills stacked flat on the shoulder line: each
       * trigger sat flush on its bumper and the shell's outline ran straight
       * through both bumpers, so LT/LB and RT/RB read as one overlapping
       * lump. Now each is its own part with air around it:
       *
       *   the BUMPER is a band that follows the curve of the shoulder, two
       *   units off the shell along its whole length;
       *   the TRIGGER stands above and behind it, two units clear of the
       *   bumper, and fills from the bottom as it is squeezed.
       *
       * Drawn first, so the shell's glow falls over their feet. */
      const trigger = (sx, v, lbl) => {
        const w = 32, h = 17, x = 88 * sx, top = -80;
        const x0 = X(x - w / 2), y0 = Y(top);
        const ww = S(w), hh = S(h);
        c.beginPath();
        if (c.roundRect) c.roundRect(x0, y0, ww, hh, [S(8), S(8), S(2.5), S(2.5)]);
        else c.rect(x0, y0, ww, hh);
        const face = c.createLinearGradient(0, y0, 0, y0 + hh);
        face.addColorStop(0, 'rgba(34,16,72,0.97)');
        face.addColorStop(1, 'rgba(12,5,30,0.97)');
        c.fillStyle = face;
        c.fill();
        if (v > 0.02) {
          c.save();
          c.clip();
          const f = Math.min(1, v);
          c.fillStyle = 'rgba(255,180,0,0.82)';
          c.shadowColor = on;
          c.shadowBlur = gb(S(10));
          c.fillRect(x0, y0 + hh * (1 - f), ww, hh * f);
          hRestore(c);
        }
        c.strokeStyle = v > 0.02 ? on : rim + '0.62)';
        c.lineWidth = Math.max(1, S(1.1));
        c.stroke();
        // the ribbing across the face, which is what a trigger is to a thumb
        c.strokeStyle = 'rgba(200,215,255,0.10)';
        c.lineWidth = Math.max(1, S(0.7));
        c.beginPath();
        for (let r = 0; r < 2; r++) {
          const ry = top + 4 + r * 2.4;
          c.moveTo(X(x - w * 0.28), Y(ry));
          c.lineTo(X(x + w * 0.28), Y(ry));
        }
        c.stroke();
        text(lbl, x, top + h * 0.6, 7, v > 0.5 ? '#1a0d00' : rim + '0.95)');
      };
      /* The bumper's centre line, riding seven units off the shoulder. A band
         is a stroked curve: one wide stroke in the rim colour, one a little
         narrower in the face colour, and the ends come out round for free. */
      const bumper = (sx, lit, lbl) => {
        c.beginPath();
        c.moveTo(X(60 * sx), Y(-51.5));
        c.bezierCurveTo(X(82 * sx), Y(-56.5), X(107 * sx), Y(-58.5), X(118.5 * sx), Y(-47.5));
        c.strokeStyle = lit ? on : rim + '0.62)';
        c.lineWidth = S(10.4);
        if (lit) { c.shadowColor = on; c.shadowBlur = gb(S(10)); }
        c.stroke();
        c.shadowBlur = 0;
        c.strokeStyle = lit ? 'rgba(255,190,40,0.95)' : 'rgba(22,10,50,0.98)';
        c.lineWidth = S(8.2);
        c.stroke();
        // a highlight along the top of the band, where the light catches it
        c.beginPath();
        c.moveTo(X(66 * sx), Y(-55.2));
        c.bezierCurveTo(X(84 * sx), Y(-59.4), X(104 * sx), Y(-60.4), X(114 * sx), Y(-54));
        c.strokeStyle = lit ? 'rgba(255,240,200,0.55)' : 'rgba(210,225,255,0.16)';
        c.lineWidth = Math.max(1, S(0.9));
        c.stroke();
        text(lbl, 93 * sx, -55.2, 6.2, lit ? '#1a0d00' : rim + '0.95)');
      };
      trigger(-1, pad ? pad.value(B.LT) : 0, 'LT');
      trigger(1, pad ? pad.value(B.RT) : 0, 'RT');
      bumper(-1, held(B.LB), 'LB');
      bumper(1, held(B.RB), 'RB');

      // ------------------------------------------------------------ body --
      // a shadow under it, offset rather than blurred - depth for free
      shell(1, 3.5);
      c.fillStyle = 'rgba(0,0,0,0.34)';
      c.fill();

      shell(1, 0);
      const grad = c.createLinearGradient(0, Y(-48), 0, Y(82));
      grad.addColorStop(0, 'rgba(40,20,86,0.96)');
      grad.addColorStop(0.45, 'rgba(22,10,54,0.96)');
      grad.addColorStop(1, 'rgba(10,4,28,0.96)');
      c.fillStyle = grad;
      c.fill();
      c.strokeStyle = rim + '0.80)';
      c.lineWidth = Math.max(1, S(1.6));
      if (live) { c.shadowColor = CYAN; c.shadowBlur = gb(S(10)); }
      c.stroke();
      c.shadowBlur = 0;

      // the faceplate: the same outline, inset, as a moulding line
      shell(0.9, 2.5);
      c.strokeStyle = rim + '0.20)';
      c.lineWidth = Math.max(1, S(0.9));
      c.stroke();

      /* A sheen across the top of the shell - one soft ellipse clipped to it,
         the single cheapest thing that turns a filled outline into an object
         with a surface. */
      c.save();
      shell(1, 0);
      c.clip();
      const sheen = c.createRadialGradient(X(0), Y(-44), 0, X(0), Y(-44), S(118));
      sheen.addColorStop(0, 'rgba(190,170,255,0.20)');
      sheen.addColorStop(1, 'rgba(190,170,255,0)');
      c.fillStyle = sheen;
      c.fillRect(X(-140), Y(-52), S(280), S(136));
      hRestore(c);

      // the grips' texture: a few short arcs where the palms go
      c.strokeStyle = rim + '0.14)';
      c.lineWidth = Math.max(1, S(0.8));
      c.beginPath();
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const gx = (108 + i * 4.2) * sx, gy = 44 + i * 5.5;
          c.moveTo(X(gx - 7 * sx), Y(gy + 3));
          c.quadraticCurveTo(X(gx), Y(gy - 1.5), X(gx + 5 * sx), Y(gy - 7));
        }
      }
      c.stroke();

      // ---------------------------------------------------- the elements --
      /* A stick: a dark well sunk into the shell, and the cap sitting in it
         where the player is actually holding it. The travel is exaggerated so
         a small real movement is legible - this is a readout, not a scale
         drawing, and a stick that moves two pixels tells nobody anything. */
      const stick = (x, y, ax, ay, pressed) => {
        c.beginPath();
        c.arc(X(x), Y(y), S(17), 0, Math.PI * 2);
        c.fillStyle = 'rgba(3,1,12,0.92)';
        c.fill();
        c.strokeStyle = rim + '0.46)';
        c.lineWidth = Math.max(1, S(1.1));
        c.stroke();
        c.beginPath();
        c.arc(X(x), Y(y), S(13.8), 0, Math.PI * 2);
        c.strokeStyle = 'rgba(160,180,240,0.12)';
        c.lineWidth = Math.max(1, S(0.8));
        c.stroke();
        const dx = (pad ? pad.axis(ax) : 0) * 7.5;
        const dy = (pad ? pad.axis(ay) : 0) * 7.5;
        const moved = Math.hypot(dx, dy) > 1.2;
        const px = X(x + dx), py = Y(y + dy), r = S(10.6);
        const cap = c.createRadialGradient(px - r * 0.35, py - r * 0.4, r * 0.1, px, py, r);
        if (pressed) {
          cap.addColorStop(0, 'rgba(255,220,120,0.98)');
          cap.addColorStop(1, 'rgba(255,170,0,0.92)');
        } else if (moved) {
          cap.addColorStop(0, 'rgba(150,245,255,0.75)');
          cap.addColorStop(1, 'rgba(40,150,200,0.55)');
        } else {
          cap.addColorStop(0, 'rgba(96,84,160,0.95)');
          cap.addColorStop(1, 'rgba(30,18,70,0.95)');
        }
        c.beginPath();
        c.arc(px, py, r, 0, Math.PI * 2);
        c.fillStyle = cap;
        c.fill();
        c.strokeStyle = pressed ? on : (moved ? CYAN : rim + '0.70)');
        c.lineWidth = Math.max(1, S(1.3));
        if (pressed || moved) { c.shadowColor = pressed ? on : CYAN; c.shadowBlur = gb(S(12)); }
        c.stroke();
        c.shadowBlur = 0;
        // the dished top of the cap, the ring a thumb sits in
        c.beginPath();
        c.arc(px, py, S(6.6), 0, Math.PI * 2);
        c.strokeStyle = pressed ? 'rgba(90,40,0,0.5)' : 'rgba(210,225,255,0.22)';
        c.lineWidth = Math.max(1, S(0.9));
        c.stroke();
      };

      /* A face button in its own colour - the one piece of every pad a player
         recognises across the room. It lights in that colour too, so the
         diagram answers "which one did I press" before the letter is read. */
      const face = (x, y, lit, label, col) => {
        const r = 8.2;
        c.beginPath();
        c.arc(X(x), Y(y), S(r), 0, Math.PI * 2);
        c.fillStyle = lit ? col : 'rgba(8,3,22,0.94)';
        if (lit) { c.shadowColor = col; c.shadowBlur = gb(S(12)); }
        c.fill();
        c.shadowBlur = 0;
        c.strokeStyle = col;
        c.globalAlpha = alpha * (lit ? 1 : 0.75);
        c.lineWidth = Math.max(1, S(1.2));
        c.stroke();
        c.globalAlpha = alpha;
        text(label, x, y, 8.2, lit ? '#10061e' : col);
      };

      /* The small round ones - view, menu and the guide - carry the marks a
         pad prints on them rather than words, because that is how the pad in
         the player's hands is labelled. */
      const small = (x, y, r, lit) => {
        c.beginPath();
        c.arc(X(x), Y(y), S(r), 0, Math.PI * 2);
        c.fillStyle = lit ? 'rgba(255,180,0,0.88)' : 'rgba(8,3,22,0.94)';
        if (lit) { c.shadowColor = on; c.shadowBlur = gb(S(10)); }
        c.fill();
        c.shadowBlur = 0;
        c.strokeStyle = lit ? on : rim + '0.60)';
        c.lineWidth = Math.max(1, S(1.1));
        c.stroke();
        return lit ? '#1a0d00' : rim + '0.85)';
      };

      stick(-64, -10, 0, 1, held(B.LS));
      stick(32, 18, 2, 3, held(B.RS));

      /* The d-pad as a cross, in a well of its own. Each arm lights alone, so
         a diagonal shows as the two arms it is. */
      {
        const px = -32, py = 18, a = 4.6, reach = 13;
        c.beginPath();
        c.arc(X(px), Y(py), S(16), 0, Math.PI * 2);
        c.fillStyle = 'rgba(3,1,12,0.92)';
        c.fill();
        c.strokeStyle = rim + '0.40)';
        c.lineWidth = Math.max(1, S(1));
        c.stroke();
        const cross = [[-a, -reach], [a, -reach], [a, -a], [reach, -a], [reach, a], [a, a],
          [a, reach], [-a, reach], [-a, a], [-reach, a], [-reach, -a], [-a, -a]];
        c.beginPath();
        cross.forEach(([u, v], i) => (i ? c.lineTo : c.moveTo).call(c, X(px + u), Y(py + v)));
        c.closePath();
        c.fillStyle = 'rgba(52,36,104,0.96)';
        c.fill();
        c.strokeStyle = rim + '0.62)';
        c.lineWidth = Math.max(1, S(1.1));
        c.stroke();
        const arm = (lit, x0, y0, w, h, tri) => {
          if (lit) {
            c.fillStyle = 'rgba(255,180,0,0.92)';
            c.shadowColor = on;
            c.shadowBlur = gb(S(10));
            c.fillRect(X(px + x0), Y(py + y0), S(w), S(h));
            c.shadowBlur = 0;
          }
          // the arrow pressed into each arm
          c.beginPath();
          c.moveTo(X(px + tri[0]), Y(py + tri[1]));
          c.lineTo(X(px + tri[2]), Y(py + tri[3]));
          c.lineTo(X(px + tri[4]), Y(py + tri[5]));
          c.closePath();
          c.fillStyle = lit ? '#1a0d00' : 'rgba(200,215,255,0.30)';
          c.fill();
        };
        // x0/y0 are the arm's top-left in LOCAL units (y down)
        arm(held(B.UP), -a, -reach, a * 2, reach - a, [0, -reach + 2.6, -2.4, -reach + 6, 2.4, -reach + 6]);
        arm(held(B.DOWN), -a, a, a * 2, reach - a, [0, reach - 2.6, -2.4, reach - 6, 2.4, reach - 6]);
        arm(held(B.LEFT), -reach, -a, reach - a, a * 2, [-reach + 2.6, 0, -reach + 6, -2.4, -reach + 6, 2.4]);
        arm(held(B.RIGHT), a, -a, reach - a, a * 2, [reach - 2.6, 0, reach - 6, -2.4, reach - 6, 2.4]);
      }

      /* Face buttons, in the standard diamond. A IS AT THE BOTTOM and Y at the
         top - local +y points down, so the two were swapped when this was
         first written and the diagram was quietly telling every player that
         boost was the top button. */
      const fx = 64, fy = -10, sp = 14;
      face(fx, fy + sp, held(B.A), 'A', '#5affc0');
      face(fx + sp, fy, held(B.B), 'B', '#ff5a7a');
      face(fx - sp, fy, held(B.X), 'X', '#4db8ff');
      face(fx, fy - sp, held(B.Y), 'Y', '#ffd23f');

      // BACK (view): two overlapping windows
      {
        const ink = small(-21, -9, 5.2, held(B.BACK));
        c.strokeStyle = ink;
        c.lineWidth = Math.max(1, S(0.8));
        c.strokeRect(X(-23.6), Y(-11.2), S(3.6), S(2.8));
        c.strokeRect(X(-21.8), Y(-9.6), S(3.6), S(2.8));
      }
      // START (menu): three lines
      {
        const ink = small(21, -9, 5.2, held(B.START));
        c.strokeStyle = ink;
        c.lineWidth = Math.max(1, S(0.8));
        c.beginPath();
        for (let i = -1; i <= 1; i++) {
          c.moveTo(X(18.8), Y(-9 + i * 1.5));
          c.lineTo(X(23.2), Y(-9 + i * 1.5));
        }
        c.stroke();
      }
      // the guide: a ring with the game's mark in it
      {
        const ink = small(0, -27, 6.6, held(B.GUIDE));
        text('X', 0, -27, 6.6, ink);
      }
      // ...and what the two small ones are called, above them
      text('BACK', -21, -18.4, 4.4, rim + '0.72)');
      text('START', 21, -18.4, 4.4, rim + '0.72)');

      hRestore(c);
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
        c.shadowBlur = gb(this.vs(12));
        c.fill();
        hRestore(c);
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
          ? 'STANDARD LAYOUT - PRESS ANYTHING TO TEST IT'
          : 'LAYOUT NOT RECOGNISED - STEERING AND TRIGGERS ONLY',
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
      this.t('SYNX GRID  //  SYSTEM', 0, 314, 13, 'rgba(120,225,255,0.80)', 'center', 'lab', 1, 0.32);
      this.chrome('CONTROLS', 0, 282, 42, PINK);
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
          /* The page you are on is the lit bar; the others are its empty
             slots. With the strip itself focused the lit one breathes, which
             is the difference between "this page" and "this control". */
          this.blitLayer(this.barLayer(TW, 32, 'idle'), cx, TY, 0.9);
          if (live) {
            this.blitLayer(this.barLayer(TW, 32, 'sel'), cx, TY,
              sel ? 0.82 + 0.18 * Math.sin(g.time * 5) : 0.78);
            if (sel) this.barSweep(cx, TY, TW, 32, 1, this.uiClock || 0);
            this.selLabel(names[t], cx, TY, 15, 1, 0.14);
          } else {
            this.t(names[t], cx, TY, 15, 'rgba(200,196,240,0.62)', 'center', 'num', 1, 0.14);
          }
        }
      }
      /* The key legend, beside the title rather than under it. The band it
         used to occupy is the tab strip's now, and a legend is the one thing
         on this screen that can go anywhere - it is read once and then never
         again. */
      /* Tab 0 is KEYBOARD and is the only page with anything bindable on
         it. This used to read `tab === 1`, which put the rebinding legend
         on the gamepad page and the ordinary one on the page that does the
         rebinding. */
      this.label(tab === 0
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
      /* The selection band. On the GAMEPAD page it runs from the label column
         to twelve units inside the panel's right edge (560) - at 620 it ran
         four units PAST it, a lit bar sticking out of the side of the card. */
      const ROW_W = padTab ? 604 : 970;

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
           line takes the gap above it, and the legend the column beside it.
           The pad runs from its trigger tops at local -80 to its grips at 81
           and 136 either side, so at 1.58 about -207 it occupies -81 to -335
           and -515 to -85: eleven units under the band, twenty-one above the
           panel's edge and a hundred and thirty clear of the legend. */
        this.drawPadStatus(g, -300, 168);
        this.drawPadDiagram(g, -300, -207, 1.58);
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
          this.t(r.group, LX, gy, 12, 'rgba(176,150,255,0.95)', 'left', 'lab', 1, 0.3);
          c.save();
          c.strokeStyle = 'rgba(139,92,246,0.30)';
          c.lineWidth = Math.max(1, this.vs(1));
          c.beginPath();
          const gx = LX + this.tw(r.group, 12, 'lab', 0.3) + 16;
          // ...to the end of THIS page's column, not to a number that happens
          // to be the right edge of the widest one
          c.moveTo(this.vx(gx), this.vy(gy) - this.vs(4));
          c.lineTo(this.vx(LX + ROW_W - 32), this.vy(gy) - this.vs(4));
          c.stroke();
          hRestore(c);
        }

        if (sel) {
          /* The selection. One bar the full width of the row with a solid
             accent down its leading edge, rather than a box around the label:
             a full-width band is what tells the eye which ROW is live when the
             thing being changed is over on the other side of the panel. */
          const bandX = padTab ? (LX - 16 + ROW_W / 2) : 0;
          this.blitLayer(this.rowLayer(ROW_W, 32), bandX, y);
          this.t(r.label, LX + 17.5, y - 1.5, 21, 'rgba(20,4,48,0.60)', 'left', 'row', 1, 0.06);
        }

        /* The row's name is read, so it is in the site's reading face at
           one weight whether or not it is live - a row that changed face
           on selection would jump sideways under the cursor. */
        this.t(r.label, LX + 16, y, 21,
          sel ? '#ffe9a8' : 'rgba(214,210,240,0.78)', 'left', 'row', 1, 0.06);

        /* A BINDING ROW.
           No option list, no meter, no chevrons - the value is a key, and the
           only thing that can be done to it is to press a different one. It is
           drawn as a cap so it reads as a key rather than as a word, and the
           row being listened for says so in place of the cap. */
        if (r.bind) {
          const NR2 = global.NR;
          const capturing = g.bindCapture === r.bind;
          const list = (g.settings.binds && g.settings.binds[r.bind]) || [];
          if (capturing) {
            const p2 = 0.45 + 0.55 * Math.sin(g.time * 8);
            this.plate(VX + 40, y, 300, 28, AMBER, 1, 10, 0.86);
            this.t('PRESS A KEY   //   ESC CANCELS', VX + 40, y, 15, '#ffd25a',
              'center', 'lab', p2, 0.12);
          } else if (!list.length) {
            this.t('-', VX + 40, y, 22, 'rgba(255,90,120,0.85)', 'center', 'num');
            this.t('UNBOUND', VX + 150, y, 12, 'rgba(255,90,120,0.60)', 'center', 'lab', 1, 0.24);
          } else {
            let cx = VX - 60;
            for (let bi = 0; bi < list.length; bi++) {
              if (bi) { this.t('/', cx + 8, y, 17, 'rgba(176,150,255,0.85)', 'left', 'numL'); cx += 22; }
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
          /* Inside whatever the meter leaves. At a fixed 132 the right one
             landed on the meter's first cells on the MOUSE page and on the
             switch on the GAMEPAD page, where the value column moves right. */
          const meterL = r.opts.length > 2 ? 430 - (r.opts.length - 1) * 7.5 - 8 : 410;
          const cd = Math.min(132, meterL - 16 - VX);
          this.t('‹', VX - cd, y, 28, '#ffd25a', 'center', 'num', pulse);
          this.t('›', VX + cd, y, 28, '#ffd25a', 'center', 'num', pulse);
          this.t(val, VX + 1.5, y - 1.5, 17, 'rgba(20,4,48,0.60)', 'center', 'num', 1, 0.05);
        }
        this.t(val, VX, y, 17, sel ? '#ffffff' : 'rgba(140,232,255,0.82)', 'center',
          sel ? 'num' : 'lab', 1, 0.05);

        /* The meter. Graded settings get a segment per step so the position in
           the range is readable at a glance; two-state ones get a switch,
           because a two-segment meter reads as a broken slider. Slanted cells
           like the boost gauge's, gold on the live row and cyan elsewhere,
           with a highlight across the top of each lit one instead of a blur. */
        if (r.opts.length > 2) {
          c.save();
          const n = r.opts.length, cur = g.settings[r.key];
          const top = this.vy(y) - this.vs(7), bot = this.vy(y) + this.vs(7);
          const lean = this.vs(3);
          for (let k = 0; k < n; k++) {
            const bx = this.vx(430 + (k - (n - 1) / 2) * 15);
            const lit = k <= cur;
            c.beginPath();
            c.moveTo(bx - this.vs(4) + lean, top); c.lineTo(bx + this.vs(4) + lean, top);
            c.lineTo(bx + this.vs(4) - lean, bot); c.lineTo(bx - this.vs(4) - lean, bot);
            c.closePath();
            c.fillStyle = lit ? (sel ? '#ffb43c' : '#39e6ff') : 'rgba(170,160,230,0.16)';
            c.fill();
            if (lit) {
              c.fillStyle = 'rgba(255,255,255,0.45)';
              c.fillRect(bx - this.vs(4) + lean * 0.6, top, this.vs(8), this.vs(5));
            }
          }
          hRestore(c);
        } else {
          /* A pill with a knob in it, lit when on - a switch, not a box. */
          const on = g.settings[r.key] === 1;
          const tw = 40, th = 18;
          const X = this.vx(430) - this.vs(tw / 2), Y = this.vy(y) - this.vs(th / 2);
          const R = this.vs(th / 2);
          const lit = sel ? '#ffb43c' : '#39e6ff';
          c.save();
          c.beginPath();
          c.arc(X + R, Y + R, R, Math.PI / 2, Math.PI * 1.5);
          c.arc(X + this.vs(tw) - R, Y + R, R, -Math.PI / 2, Math.PI / 2);
          c.closePath();
          c.fillStyle = on ? this._alpha(lit, 0.34) : 'rgba(8,4,24,0.78)';
          c.fill();
          c.strokeStyle = on ? lit : 'rgba(190,175,255,0.40)';
          c.lineWidth = Math.max(1, this.vs(1.2));
          c.stroke();
          const kx = on ? X + this.vs(tw) - R : X + R;
          c.beginPath();
          c.arc(kx, Y + R, R - this.vs(3), 0, Math.PI * 2);
          c.fillStyle = on ? '#ffffff' : 'rgba(200,196,240,0.55)';
          c.fill();
          hRestore(c);
        }
      }

      // the exit row, drawn as a button rather than as another setting
      {
        const y = L.exitY;
        const sel = g.controlIndex >= rows.length;
        this.blitLayer(this.barLayer(400, 44, sel ? 'sel' : 'idle'), 0, y);
        if (sel) {
          this.barSweep(0, y, 400, 44, 1, this.uiClock || 0);
          this.selLabel('SAVE AND BACK', 0, y, 19, 1, 0.16);
        } else {
          this.t('SAVE AND BACK', 0, y, 19, 'rgba(236,232,255,0.82)', 'center', 'num', 1, 0.16);
        }
        /* RESET is not a setting, so it is not in the list. It sits beside the
           way out, on the page it belongs to, and it is the only thing on this
           screen that can undo a player who has bound the accelerator to the
           pause key and back again.

           THE PAGE IT BELONGS TO IS THE KEYBOARD ONE. It resets key
           BINDINGS - see Game.resetBinds - and it was being drawn on the
           gamepad page, where there are no bindings and where the button
           therefore changed something the player could not see. */
        if (tab === 0) {
          this.blitLayer(this.barLayer(220, 34, 'idle'), 360, y);
          this.t('R   RESET CONTROLS', 360, y, 15, 'rgba(214,210,240,0.80)', 'center', 'lab', 1, 0.08);
        }
      }

      /* The explanation for whatever is selected.

         A settings screen that only names its settings makes the player guess
         what each one costs, and the whole point of the screen is to let them
         make that trade deliberately. It sits in a fixed band so the layout
         does not move as the selection does. */
      {
        const r = rows[g.controlIndex];
        /* The strip's own description, which still described the two-page
           options screen this replaced - GRAPHICS + AUDIO and CONTROLS - on
           a strip that reads KEYBOARD, GAMEPAD and MOUSE. */
        const hint = g.controlIndex < 0
          ? 'Three pages. KEYBOARD rebinds every key the car answers to; GAMEPAD tunes the controller and tests it live; MOUSE sets up free look.'
          : (r ? r.hint : 'Keep the changes and return to the title.');
        const hy = L.hintY, hh = L.hintH || 46;
        // the explanation sits on the instruments' glass plate
        this.plate(0, hy, 1000, hh, CYAN, 1, 14, 0.72);
        this.wrapLabel(hint || '', 0, hy, 16, INK.body, 600, 2);
      }

      this.sweep(g, 0.6);
    }

    /** Measure a label the same way `label` draws one. */
    textWidth(txt, size, weight) {
      const c = this.ctx;
      c.save();
      setFont(c, uiFont(this.vs(size), weight));
      const w = c.measureText(txt).width / this.k;
      hRestore(c);
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
      /* ASKED OF THE INPUT LAYER, not of the settings blob. The blob was a
         second opinion, and it differed from the game in the one case that
         matters: a row the player had CLEARED fell through to the default
         here and the card went on printing a key that no longer did
         anything. keyLabel of nothing is the em dash, which is what an
         unbound row on the CONTROLS screen shows too. */
      const NRk = global.NR;
      const cap = (action) => NRk.keyLabel(NRk.boundKeys(g, action)[0]);
      const rows = [
        ['GAS / BRAKE', [cap('throttle'), cap('brake')], 110],
        ['STEER', [cap('left'), cap('right')], 56],
        ['DRIFT', [cap('ebrake'), '+', cap('left') + ' / ' + cap('right')], 2],
        ['BOOST', [cap('boost')], -52],
        /* WHAT R ACTUALLY DOES HERE, which is not the same everywhere.
           Inside a chapter it is RACE MODE and nothing else - the restart half
           is off, because a mis-hit would throw away a run that can be thirty
           kilometres long. See Game.quickRestartAllowed. A card that promises
           RESTART on a key that will not restart is worse than a card that
           does not mention it. */
        [g.quickRestartAllowed && !g.quickRestartAllowed() ? 'PAUSE' : 'PAUSE / RESTART',
          [cap('pause'), cap('raceMode')], -106],
      ];
      for (let ri = 0; ri < rows.length; ri++) {
        const [name, keys, y] = rows[ri];
        // staggered, so the card deals its rows rather than stamping them
        const rk = ease(Math.min(1, Math.max(0, (k * 0.30 - ri * 0.035) / 0.19)));
        if (rk <= 0.002) continue;
        this.ctx.save();
        this.ctx.globalAlpha = rk;
        // a dim slot behind each action, so the card reads as a rack of rows
        this.blitLayer(this.barLayer(820, 44, 'idle'), -(1 - rk) * 24, y, 0.55);
        this.t(name, -370 - (1 - rk) * 24, y, 24, INK.key, 'left', 'num', 1, 0.03);
        let x = -70;
        for (const kc of keys) {
          if (kc === '+') { this.t('+', x + 10, y, 24, 'rgba(176,150,255,0.9)', 'left', 'num'); x += 34; continue; }
          x += this.keycap(kc, x, y, 30) + 14;
        }
        hRestore(this.ctx);
      }
      this.t('PRESS SPACE BAR TO CONTINUE   //   CONTROLS TO REBIND',
        0, -168, T.body, '#ffd25a', 'center', 'lab',
        (0.45 + 0.55 * Math.sin(g.time * 4)) * k, 0.14);
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
      hRestore(c);
    }

    /* THE LIGHTS, in the cluster's language: a big italic figure inside a
       ring that sweeps round once per second, with the ring's light running
       from violet into magenta, and GO in mint with a shockwave. The shipped
       countdown sprites were the last bitmap type on the race screen. No blur:
       every ring is a wide faint stroke under a narrow bright one. */
    drawCountdown(g) {
      const n = Math.ceil(g.countdown);
      const c = this.ctx;
      const cx = this.vx(0), cy = this.vy(83);
      const ring = (r, a0, a1, col, w, alpha) => {
        c.save();
        c.globalAlpha *= alpha;
        c.strokeStyle = col;
        c.lineCap = 'round';
        c.globalAlpha *= 0.22;
        c.lineWidth = this.vs(w * 4);
        c.beginPath(); c.arc(cx, cy, this.vs(r), a0, a1); c.stroke();
        c.globalAlpha /= 0.22;
        c.lineWidth = this.vs(w);
        c.beginPath(); c.arc(cx, cy, this.vs(r), a0, a1); c.stroke();
        hRestore(c);
      };
      if (n <= 0) {
        // a shockwave ring on the green light
        const t = Math.min(1, -g.countdown * 2.2);
        ring(70 + t * 330, 0, Math.PI * 2, MINT, 5 * (1 - t) + 0.5, 1 - t);
        this.hero('GO', 0, 83, 150, '#eafff6', 'center', 1 - t * 0.6, MINT, 'num');
        return;
      }
      if (n <= 3) {
        const frac0 = 1 - (g.countdown - Math.floor(g.countdown));
        const pop = 1 + (1 - Math.min(1, frac0 * 5)) * 0.18;
        // a pool of dark behind it, so it holds over a lit road
        const glow = c.createRadialGradient(cx, cy, this.vs(20), cx, cy, this.vs(240));
        glow.addColorStop(0, 'rgba(2,0,10,0.62)');
        glow.addColorStop(0.55, 'rgba(2,0,10,0.32)');
        glow.addColorStop(1, 'rgba(2,0,10,0)');
        c.save();
        c.fillStyle = glow;
        c.fillRect(0, 0, this.w, this.h);
        hRestore(c);
        ring(132, 0, Math.PI * 2, 'rgba(170,150,255,0.5)', 1.2, 0.55);
        const col = n === 1 ? '#ff3ca8' : n === 2 ? '#c03cff' : '#7a5cff';
        ring(132, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac0, col, 4, 1);
        this.hero(String(n), 0, 80, 170 * pop, '#ffffff', 'center', 1, col, 'num');
        /* THE LAUNCH, TAUGHT ON THE GRID. The count says when to get on the
           throttle - on the last number - and then says what the player has
           done about it, so the rule is learned by the second start rather
           than read in a manual. See Game.judgeLaunch. */
        const L = g.launch;
        const held = L && L.pressAt !== null;
        let cap = n === 1 ? 'GO FOR LAUNCH' : (n === 2 ? 'LAUNCH ON 1' : 'GET SET');
        let capCol = INK.body;
        if (held && L.pressAt > 1.05) { cap = 'TOO EARLY // WHEELSPIN'; capCol = '#ff8a4a'; }
        else if (held) { cap = 'LAUNCH ARMED'; capCol = MINT; }
        this.t(cap, 0, 6, 13, capCol, 'center', 'lab', 0.9, 0.42);
        return;
      }
      /* NO FADE AT ALL, on any count - the digit is solid for the whole of
         its second and darkens the frame behind itself to sit on. A count
         past three is the same figure without the caption. */
      const frac = 1 - (g.countdown - Math.floor(g.countdown));
      ring(132, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac, '#7a5cff', 4, 1);
      this.hero(String(n), 0, 80, 170, '#ffffff', 'center', 1, '#7a5cff', 'num');
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

      /* WHERE THE ROWS ACTUALLY WENT, published for the pointer.
       *
       * A hit-test has to agree with the drawing or the mouse highlights the
       * wrong row - and on a card whose rows move, it cannot agree by having
       * the numbers typed into it twice. The pause and confirm cards get away
       * with it because their lists are at a fixed height; the FINISH card
       * does not. Its `baseY` is computed from how much went on the card above
       * it - the verdict, the split times, whether a route unlocked - so it
       * lands somewhere different on a win, a loss and a personal best, and
       * nothing outside this method can know where.
       *
       * So the list says. One record, because the screens that use it are
       * modal and only ever one is up. See Game.finishItemAt. */
      this.listRows = { baseY, gap, n: items.length, width, half: gap * 0.48 };

      /* THE RACK: the same bars as the title screen - an idle slot per row,
         the lit bar where the selection actually is, the labels last.

         A ROW THAT CANNOT DO ANYTHING SAYS SO. `opts.disabled` is one flag
         per row. A disabled row is still drawn and still takes its place in
         the list - taking it out would move every row under it and make the
         card change shape depending on where the player happens to be - but
         its slot is dimmer and its label muted, which is the difference
         between a choice and a label.

         Rows stagger in behind the panel, forty-five milliseconds apart: the
         difference between a menu appearing and a menu being dealt. */
      const h = Math.max(34, Math.round(gap * 0.80));
      this.rack(items, index, baseY, gap, this.selY, width, h, 1, {
        disabled: o.disabled,
        size: Math.round(Math.min(h * 0.50, size * 0.80)),
        stagger: (i) => ease(Math.min(1, Math.max(0, ((this.enter || 1) * 0.30 - i * 0.045) / 0.20))),
      });
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
      /* Four units higher than it was, all of it: the saved line under this
         block sat on the top edge of the first row's selection brackets, so
         the one reassurance on the card was printed on the frame of RESUME. */
      if (g.level) {
        this.label(g.level.name, 0, 116, T.body, INK.body, 'center', 700, k);
        const done = Math.round((g.progress || 0) * 100);
        this.label(done + '%  OF THE ROUTE', -104, 89, T.cap, INK.mute, 'center', 600, k);
        this.label(fmtClock(g.raceTime), 104, 89, T.cap, INK.mute, 'center', 600, k);
        /* A progress rail rather than a percentage on its own. Two hundred and
           forty units of bar say the same thing the number does and say it at
           a glance, which is what a pause screen is read at. */
        this.meterBar(0, 66, 320, Math.max(0, Math.min(1, g.progress || 0)), CYAN, k);
      }
      /* WHEN THE RUN WAS LAST WRITTEN. The pause screen is where a player
         decides whether it is safe to stop, and that decision needs this. */
      if (g.autosave && g.autosave.lastAt) {
        const secs = Math.max(0, (Date.now() - g.autosave.lastAt) / 1000);
        const when = secs < 12 ? 'JUST NOW'
          : secs < 90 ? Math.round(secs) + ' SECONDS AGO'
          : Math.round(secs / 60) + ' MINUTES AGO';
        this.label('PROGRESS SAVED  ' + when, 0, 42, T.micro, '#5affc0', 'center', 800, k * .8);
      }
      /* THE CARD TAKES THREE ROWS OR FOUR.
         A chapter offers RESTART FROM CHECKPOINT and a plain race has no
         checkpoint to offer - see Game.pauseRowsFor - so the list here is not
         a fixed height. At the three-row spacing a fourth row lands at -204
         against a footer at -210 and they are drawn through each other, so the
         four-row case closes the gap and starts a little higher. The bar is
         wider too: RESTART FROM CHECKPOINT is twenty-three characters, and
         menuList would otherwise shrink the whole list to fit it into a bar
         built for RESUME. */
      const wide = g.pauseItems.length > 3;
      const dis = g.pauseDisabled || [];
      this.menuList(g.pauseItems, g.pauseIndex, wide ? -14 : -12, wide ? 54 : 64, dt,
        wide ? { width: 440, disabled: dis } : { disabled: dis });
      /* ...and WHY it is dead, because a greyed row with no reason beside it
         is a row the player assumes is broken. It only appears while the row
         that needs it is the one under the bar. */
      if (dis[g.pauseIndex]) {
        this.label('NO CHECKPOINT REACHED YET', 0, (wide ? -14 : -12) - g.pauseItems.length * (wide ? 54 : 64) + 22,
          T.micro, '#ff9a6a', 'center', 800, 0.9 * k);
      }
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
        c.shadowBlur = gb(this.vs(10));
        c.fillRect(X, Y - H / 2, W * q, H);
        // the head of the fill, brighter, so the eye finds where it is
        c.fillStyle = '#ffffff';
        c.fillRect(X + W * q - this.vs(1.5), Y - H / 2 - this.vs(1.5),
          this.vs(3), H + this.vs(3));
      }
      hRestore(c);
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
      this.t(fmtClock(g.raceTime), 0, y, 66, '#ffffff', 'center', 'num');
      y -= 46;
      if (g.newRecord) {
        const p = 0.55 + 0.45 * Math.sin(g.time * 8);
        this.neon('NEW RECORD', 0, y, 28, AMBER, 'center', 900, p);
      } else if (g.record != null) {
        this.label('BEST', -76, y, 15, CYAN, 'center', 700);
        this.t(fmtClock(g.record), 30, y, 24, '#ffffff', 'center', 'num');
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
        this.tGold(cells[i][1], x, y - 30, 32, 'center');
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
      /* ONE STEP DOWN THE TYPE SCALE, on the road. A notice was set at the
         VALUE size in a 42-unit panel, which made the word PROGRESS SAVED
         the loudest thing on screen - louder than the speed, the gap and
         the clock, none of which it is more important than. It is a notice:
         it is seen because it arrives and moves, not because it is big. */
      /* ...and on the road it steps DOWN out of the way of the region card
         while one is up: the card spans 162..266 and the start of a run is
         exactly when both it and the launch's notice arrive. */
      const BASE = front ? 300 : (this.bannerUp ? 128 : 182);
      const GAP = front ? 44 : 38;
      const H = front ? 34 : 30;
      for (let i = this.toasts.length - 1; i >= 0; i--) {
        const t = this.toasts[i];
        t.t += dt;
        if (t.t > 2.0) { this.toasts.splice(i, 1); continue; }
        if (visible === false) continue;
        /* Two at most on the front end (see above) - and on the road while
           WRONG WAY is up, whose plate spans y 49..123: the third slot is
           106, and a notice drawn across the one instruction that matters
           most at that moment is worse than a notice that waits. */
        if ((front || (this.wrongWayUp && state === 'racing')) && i > 1) continue;
        const a = t.t < 0.2 ? t.t / 0.2 : (t.t > 1.5 ? (2.0 - t.t) / 0.5 : 1);
        /* IT ARRIVES FROM SOMEWHERE.
           A notification that fades up in place is a caption; one that drops
           the last few units into its slot and settles is an object being put
           down, and it costs one eased term. The stack also slides: each
           toast damps toward the slot it currently occupies, so when the one
           above it expires the rest move up rather than jumping. */
        /* A TAG THAT SLIDES IN, not a box that fades up. It arrives from the
           left with a little overshoot, sits on a skewed plate edged in its
           own colour with the words in white on it, and leaves to the right -
           so a stack of three reads as three events with a direction, and
           none of them is the size of the speed readout. */
        const ink = overshoot(Math.min(1, t.t / 0.34));
        const leave = t.t > 1.5 ? (t.t - 1.5) / 0.5 : 0;
        const dx = (1 - ink) * -42 + leave * leave * 30;
        const slot = BASE - i * GAP;
        t.y = t.y === undefined ? slot : t.y + (slot - t.y) * Math.min(1, dt * 14);
        const y = t.y;
        let size = front ? 20 : 17;
        let w = Math.max(front ? 200 : 168, this.tw(t.text, size, 'num', 0.03) + 70);
        if (w > MAX_W) {
          size = Math.max(13, size * (MAX_W - 70) / Math.max(1, w - 70));
          w = MAX_W;
        }
        // in steps, so a plate of a given width is built once and reused
        w = Math.ceil(w / 8) * 8;
        this.plate(dx, y, w, H, t.color, a, 12, 0.84);
        this.t(t.text, dx + 5, y + 0.5, size, '#ffffff', 'center', 'num', a, 0.03);
      }
    }
  }

  global.NR.Hud = Hud;
  /* WHERE THE GAP READOUT IS, for anything that has to keep off it.
     The DOM panels are positioned in viewport units and this group is drawn on
     the canvas in the 1280x720 virtual space, so nothing can tell whether one
     covers the other without resolving both - which is what --probe cards
     does. It asks here rather than restating the numbers, so moving the group
     moves the test with it. Virtual units, +y up: see vx/vy on the Hud. */
  global.NR.HUD_RIVAL = { x: RIVAL_X, w: RIVAL_W, top: 292, bottom: 219 };
  global.NR.MENU_LAYOUT = ML;
  global.NR.fmtTime = fmtTime;
})(window);
