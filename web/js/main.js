/* SYNX — bootstrap.
 *
 * Boots straight into the game: no configuration dialog, no title gate.
 *
 * The one thing that happens before anything else is loading the Rust
 * simulation core. Nothing below it can be constructed without one - Track,
 * Vehicle and Driver all live in WebAssembly now - so the game is not built
 * until the module has instantiated and reported an ABI this build understands.
 */
(function () {
  'use strict';

  /* WHAT THE GAME KNOWS ABOUT ITS OWN GRAPHICS.
   *
   * A failure to start is nearly always the 3D context, and the two strings
   * that explain it - the vendor and the renderer - can only be read from a
   * page. The host cannot see them, so they are collected here and handed over
   * with the failure. `WEBGL_debug_renderer_info` is what turns "ANGLE" into
   * "ANGLE (NVIDIA GeForce RTX 3060 Direct3D11)", which is the difference
   * between a report that identifies a driver and one that does not. */
  function graphicsFacts() {
    const out = { webgl2: false, vendor: '', renderer: '', ua: navigator.userAgent };
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (gl) {
        out.webgl2 = true;
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        out.vendor = String(gl.getParameter(d ? d.UNMASKED_VENDOR_WEBGL : gl.VENDOR) || '');
        out.renderer = String(gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
        out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
      out.screen = (window.screen && (screen.width + 'x' + screen.height)) || '';
      out.dpr = window.devicePixelRatio || 1;
    } catch (e) { out.error = String(e && e.message ? e.message : e); }
    return out;
  }

  function fatal(msg) {
    const el = document.getElementById('fatal');
    const m = document.getElementById('fatalMsg');
    if (m) m.textContent = msg;
    if (el) el.classList.remove('hidden');
    console.error(msg);

    /* TELL THE HOST, WHICH IS THE ONLY THING THAT CAN WRITE A FILE.
     *
     * The card on screen says what happened to whoever is looking at it right
     * now. The report is for the conversation afterwards - it carries the
     * machine, the driver strings, and how far the launch got - and it is
     * written HERE rather than on a timer because this is the only moment the
     * game knows it has failed. A run that reaches the title screen writes
     * nothing at all. */
    try {
      const T = window.__TAURI__;
      const invoke = T && T.core && T.core.invoke;
      if (invoke) {
        invoke('diag_report', {
          reason: 'The game could not start: ' + msg,
          details: { stage: 'front end', graphics: graphicsFacts() },
        }).then(function (path) {
          if (path && m) {
            m.textContent = msg + String.fromCharCode(10, 10)
              + 'A report was written to:' + String.fromCharCode(10) + path;
          }
        }).catch(function () { /* the card is still on screen */ });
      }
    } catch (e) { /* never let reporting a failure become one */ }

    // Show the window even on a failure: a host that stays hidden waiting for
    // a first frame that will never arrive looks like a hang, and the player
    // deserves to see what went wrong.
    if (window.NR && window.NR.Host) window.NR.Host.ready();
  }

  /* A velocity-responsive presentation cursor. It never alters the user's
     system mouse settings: it only gives the in-game pointer a short,
     accelerated follow and a directional neon wake on fine-pointer devices. */
  function installPointerFx() {
    const cursor = document.getElementById('synxCursor');
    const fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (!cursor || !fine) return;

    let x = 0, y = 0, targetX = 0, targetY = 0;
    let lastX = 0, lastY = 0, lastTime = 0;
    let speed = 0, angle = 0, frame = 0, ready = false, lastFrame = 0;

    const render = (now) => {
      const dt = Math.min(0.04, Math.max(0.008, (now - lastFrame || 16) / 1000));
      lastFrame = now;
      const dx = targetX - x, dy = targetY - y;
      const distance = Math.hypot(dx, dy);
      /* An exponential response is stable at every frame rate. Velocity only
         nudges responsiveness, so the cursor stays direct instead of feeling
         like a spring that overshoots or catches up in visible steps. */
      const follow = 1 - Math.exp(-dt * (31 + Math.min(16, speed / 180)));
      x += dx * follow;
      y += dy * follow;
      speed *= Math.exp(-dt * 11);
      const scale = 1 + Math.min(0.09, speed / 13000);
      cursor.style.setProperty('--cursor-speed', String(1 + Math.min(0.72, speed / 2500)));
      cursor.style.setProperty('--cursor-opacity', String(0.14 + Math.min(0.30, speed / 5600)));
      cursor.style.setProperty('--cursor-angle', angle + 'deg');
      cursor.style.transform = 'translate3d(' + (x - 4) + 'px,' + (y - 3) + 'px,0) scale(' + scale + ')';
      if (distance > 0.04 || speed > 5) frame = window.requestAnimationFrame(render);
      else frame = 0;
    };

    const move = (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      const now = e.timeStamp || performance.now();
      if (!ready) { x = targetX = lastX = e.clientX; y = targetY = lastY = e.clientY; ready = true; }
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      const elapsed = Math.max(8, now - lastTime || 16);
      const instant = Math.hypot(dx, dy) * 1000 / elapsed;
      if (dx || dy) angle = Math.atan2(dy, dx) * 180 / Math.PI;
      speed = Math.min(2200, speed * 0.20 + instant * 0.80);
      targetX = e.clientX; targetY = e.clientY;
      lastX = targetX; lastY = targetY; lastTime = now;
      cursor.classList.add('show');
      if (!frame) frame = window.requestAnimationFrame(render);
    };

    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', () => cursor.classList.add('pressed'), { passive: true });
    window.addEventListener('pointerup', () => cursor.classList.remove('pressed'), { passive: true });
    document.addEventListener('pointerleave', () => cursor.classList.remove('show'));
    window.addEventListener('blur', () => cursor.classList.remove('show'));
  }

  window.addEventListener('DOMContentLoaded', function () {
    const NR = window.NR;
    if (!NR || !NR.Game || !NR.loadCore) {
      fatal('Game scripts failed to load.');
      return;
    }

    /* Two things have to exist before the game does.

       THE SAVE, because Story Mode reads it the moment it is constructed.
       THE ASSET PACK, because every texture, sprite and sound resolves through
       it - and a pack that arrived late would leave half the game loading from
       the archive and half from loose paths.

       Neither depends on the other, so they run together. */
    Promise.all([
      NR.Host ? NR.Host.load() : Promise.resolve(false),
      NR.Pak.load('data/synx.pak?v=rust-1'),
    ])
      .then(function () {
        // the handful of portraits the title and hub markup carries statically
        NR.Pak.resolveDom();
        // ...and the typefaces, which the stylesheet cannot resolve for itself
        NR.Pak.installFonts([
          { family: 'Orbitron', weight: 600, file: 'assets/fonts/Orbitron-600.ttf' },
          { family: 'Orbitron', weight: 900, file: 'assets/fonts/Orbitron-900.ttf' },
        ]);
        return NR.loadCore('wasm/synx_core.wasm?v=rust-1');
      })
      .then(function () {
        const game = new NR.Game({
          canvas: document.getElementById('glCanvas'),
          hudCanvas: document.getElementById('hudCanvas'),
          gameData: window.NR_GAME || {},
        });
        window.__nr = game;
        installPointerFx();
        game.run();
        return game.load();
      })
      .then(function () {
        /* Everything that wanted an asset has one, so the archive's own buffer
           can go. The blobs cut from it stay - the radio streams from them for
           the whole session - but the forty-five megabytes they were sliced
           out of do not need to stay resident as well. */
        const freed = NR.Pak.compact();
        if (freed) console.info('SYNX: released ' + (freed / 1048576).toFixed(1) + ' MB of pack buffer');
        /* The window has been hidden since launch so the player never sees an
           unstyled page or a white flash. The first real frame has been drawn
           by the time load() resolves, so this is where it may be shown. */
        if (NR.Host) NR.Host.ready();
      })
      .catch(function (e) {
        fatal((e && e.message) ? e.message : String(e));
      });
  });
})();
