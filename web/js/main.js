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

  /* ------------------------------------------------------------ advisory --
   *
   * The photosensitivity and beta notice. It is markup that is already on the
   * page when this runs, so it has painted long before the renderer exists -
   * which is the point: the machines most likely to need to read it are the
   * ones where the next step fails.
   *
   * IT DOES NOT BLOCK THE LOAD. The pack, the core and the first frame all
   * continue behind it; dismissing it only takes the cover away. A warning
   * that also cost fifteen seconds of loading would train people to hammer
   * through it, which defeats the purpose of showing it.
   *
   * DISMISSED BY A BUTTON, NOT BY ANY KEY.
   *
   * It used to go away on the first key, click or tap that reached the window,
   * and the prompt said PRESS ANY KEY. Two things were wrong with that. The
   * first is that a warning nobody can fail to skip is a warning nobody reads:
   * a hand resting on a pad, a stray click landing as the window takes focus,
   * and it is gone before the title has finished arriving. The second is that
   * the page hides the system cursor - the game draws its own - so on a fresh
   * launch there was a button on screen and no pointer to press it with.
   *
   * So: one CONTINUE button, focused, reachable by ENTER and SPACE because it
   * is a real button, by a pad because a pad is polled, and by the mouse
   * because the cursor is installed before this is shown. Nothing else
   * dismisses it.
   *
   * There is still no "do not show again". It is shown once per launch, every
   * launch, and a warning with an off switch is a warning that is off.
   */
  function advisory() {
    const el = document.getElementById('advisory');
    if (!el) return;
    /* The per-glyph stagger. The rule is in the stylesheet; the index is here
       because CSS cannot count children into a custom property, and writing
       sixteen nth-child rules by hand is sixteen things to get wrong. */
    const glyphs = el.querySelectorAll('.adv-title span');
    for (let i = 0; i < glyphs.length; i++) glyphs[i].style.setProperty('--i', i);

    /* THE COPY ARRIVES AS IF IT WERE BEING SENT.
     *
     * The paragraphs are typed one after another rather than all being present
     * at once, which is the difference between a page of legal text and a
     * terminal telling you something. It is a warning, so it is deliberately
     * NOT fast: about ninety characters a second, four seconds for the whole
     * notice, which is roughly how long it takes to read anyway.
     *
     * Every line is in the markup as real text before any of this runs, so a
     * reader that does not execute scripts, and a screenshot taken before the
     * reveal finishes, both still carry the whole warning. The typewriter
     * empties each line and puts it back; it never invents one. */
    const btn = document.getElementById('advGo');

    /* THE BUTTON IS NOT ARMED UNTIL THE WARNING HAS FINISHED ARRIVING.
     *
     * It is a safety notice. A control that can be pressed before the text has
     * appeared is a control for not reading it, and on a fast machine the
     * whole thing can be dismissed before the second paragraph exists. So it
     * starts genuinely disabled - greyed, not focusable, not clickable - and
     * arms itself the moment the last character lands. */
    const arm = () => {
      if (!btn) return;
      btn.disabled = false;
      btn.classList.add('is-armed');
      try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); }
    };
    if (btn) {
      btn.disabled = true;
      btn.classList.remove('is-armed');
    }
    const lines = [].slice.call(el.querySelectorAll('.adv-sub, .adv-body p'));
    const text = lines.map((n) => n.textContent.replace(/\s+/g, ' ').trim());
    /* THE EMPHASIS SURVIVES THE TYPEWRITER.

       Two of these lines put the part that matters most in bold - "rapidly
       flashing lights", "consult a doctor before playing" - and a typewriter
       is a textContent assignment, which throws every element inside the
       paragraph away. The first version typed the warning beautifully and
       flattened exactly the words it exists to stress.

       So the markup is kept and put back the moment each line finishes. The
       line types as plain text, which is the only way it can type at all,
       and is a formatted paragraph again from the frame it completes.

       The only thing ever written back is the markup this same node was
       serving a moment earlier, read out of index.html at load. Nothing from
       a player, a save file or the network is anywhere on this path. */
    const html = lines.map((n) => n.innerHTML);
    let writer = null, at = 0, revealed = false;
    const settle = (i) => {
      lines[i].innerHTML = html[i];
      lines[i].classList.remove('adv-wait', 'ui-typing');
      lines[i].style.minHeight = '';
    };
    const revealAll = () => {
      if (revealed) return;
      revealed = true;
      if (writer) writer.stop();
      for (let i = 0; i < lines.length; i++) settle(i);
      el.classList.add('adv-read');
      // ...and only now may the notice be dismissed
      arm();
    };
    const next = () => {
      if (revealed || at >= lines.length) { revealAll(); return; }
      const line = lines[at], i = at;
      line.classList.remove('adv-wait');
      writer = NR.UI.type(line, text[i], {
        cps: i === 0 ? 34 : 96,
        done: () => { settle(i); at++; next(); },
      });
    };
    if (window.NR && NR.UI && !NR.UI.reduced()) {
      /* THE CARD MUST NOT CHANGE SHAPE WHILE IT IS BEING READ.

         Emptying a paragraph collapses it, so the whole card was two lines
         shorter until the copy had finished arriving - and everything below
         it, the beta note and CONTINUE included, walked down the screen as
         each line landed. A button that moves while the pointer is on its
         way to it is a button you miss.

         Measured rather than guessed: the height each line is about to have
         is the height it has right now, before it is emptied, because the
         markup already holds the finished text. */
      for (const line of lines) {
        line.style.minHeight = line.getBoundingClientRect().height + 'px';
        line.textContent = '';
        line.classList.add('adv-wait');
      }
      // after the title has finished landing, so the two are not competing
      setTimeout(next, 760);
    } else {
      revealAll();
    }


    let done = false;
    const go = () => {
      if (done || !revealed) return;
      done = true;
      el.classList.add('gone');
      window.removeEventListener('keydown', swallow, true);
      window.removeEventListener('keyup', swallow, true);
      /* Removed rather than hidden, once the fade is over. It is a full-screen
         element with a stacking context and three animated layers; leaving it
         parked over the game costs a composite every frame for something
         nobody will see again this session. */
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 600);
      /* Hand focus back to the page so the game's own key handling resumes on
         the very next press rather than the one after it. */
      try { document.body.focus({ preventScroll: true }); } catch (e) { /* older webview */ }
      /* ...but not on the SAME press. Whatever dismissed this is still being
         held, and the title screen is one frame away; without a settle window
         the release lands on the menu as a confirm. See NR.Gate. */
      if (NR.Gate) NR.Gate.lock(320);
      if (NR.Intro && NR.Intro.begin) NR.Intro.begin();
    };

    /* NOTHING BEHIND THE NOTICE MAY SEE A KEY.
     *
     * This is the bug that made ENTER open the mode select from the warning
     * screen. The notice was a DOM overlay with a focused button and no key
     * handling of its own, so one press did two things: the browser activated
     * CONTINUE, and the very same event carried on to the window listeners
     * underneath - the game's own input layer and all four screen handlers.
     * The notice came down and the menu confirmed START in the same frame, so
     * the player went straight to a chapter list and the opening sequence
     * never ran at all.
     *
     * A modal has to be modal. Everything is taken at the capture phase and
     * stopped there; TAB is the one exception, because focus still has to be
     * able to move inside the dialog. What the keys DO is decided here rather
     * than by the button's default action, which is what stops the browser
     * turning a press into a click that nothing has consumed. */
    const swallow = (e) => {
      if (e.key === 'Tab') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'keydown') return;
      /* The first press finishes the text; only a press after that leaves.
         Someone who reads faster than ninety characters a second should not
         have to wait, and someone reaching for the button should not lose the
         sentence they were halfway through. */
      if (!revealed) { revealAll(); return; }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') go();
    };
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', swallow, true);

    /* Clicking the notice finishes the reveal. The button is disabled until
       that has happened, so it cannot be the thing that was clicked. */
    el.addEventListener('pointerdown', (e) => {
      if (!revealed) { e.preventDefault(); revealAll(); }
    });
    if (btn) btn.addEventListener('click', go);

    /* A gamepad has no DOM event to listen for, so it is polled - only while
       the notice is up, and it stops the moment it is dismissed. A pad press
       is the one input that still acts on its own, because a pad cannot tab to
       a button; it reveals first and leaves second, exactly as a key does. */
    const pad = () => {
      if (done) return;
      const list = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const g of list) {
        if (!g || !g.buttons) continue;
        for (const b of g.buttons) {
          if (b && b.pressed) { if (!revealed) revealAll(); else go(); return; }
        }
      }
      requestAnimationFrame(pad);
    };
    if (navigator.getGamepads) requestAnimationFrame(pad);
    /* The one way in that is not a player: the harness drives the game with no
       input layer at all, and a modal it cannot see would make every automated
       run a screenshot of this screen. It skips the reveal as well, which is
       why this reveals before it leaves. */
    window.NR.dismissAdvisory = () => { revealAll(); go(); };
  }

  function installPointerFx() {
    const cursor = document.getElementById('synxCursor');
    const fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (!cursor || !fine) {
      /* No drawn cursor means the page must stop hiding the real one. Every
         fine-pointer surface is cursor:none so the game can draw its own; if
         it is not going to, that rule leaves a player with no pointer at all
         on the one screen that has a button on it. */
      document.body.classList.add('native-cursor');
      return;
    }

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

    /* THE NOTICE COMES UP FIRST, and the load runs behind it. See `advisory`. */
    /* Before the advisory, not after the load: the notice has a button on
       it and the page hides the system pointer. See installPointerFx. */
    installPointerFx();
    advisory();

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
        /* The typefaces are declared in css/style.css now, against the same
           two loose files launcher.css already uses - so they are not in the
           pack, not installed at runtime, and present before this even runs. */
        return NR.loadCore('wasm/synx_core.wasm?v=rust-1');
      })
      .then(function () {
        const game = new NR.Game({
          canvas: document.getElementById('glCanvas'),
          hudCanvas: document.getElementById('hudCanvas'),
          gameData: window.NR_GAME || {},
        });
        window.__nr = game;
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

        /* ...and the benchmark, if the launcher asked for one. Everything
           about that decision lives in js/bench.js, including what to do
           when it cannot run - see autorun.

           THROUGH window.__nr, NOT THROUGH `game`. The game is declared in the
           PREVIOUS link of this chain and is not in scope here - referencing it
           threw ReferenceError at exactly this point, after the advisory had
           been dismissed and the opening cutscene skipped and before the sweep
           could start. That is the whole of why the button appeared to do
           nothing and why the warning screen stopped appearing afterwards. */
        if (NR.Bench && NR.Bench.autorun && window.__nr) NR.Bench.autorun(window.__nr);
      })
      .catch(function (e) {
        fatal((e && e.message) ? e.message : String(e));
      });
  });
})();
