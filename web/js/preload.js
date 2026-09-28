/* SYNX // THE PRELOADER, AND THE GATE IN FRONT OF THE COLD OPEN.
 *
 * ============================================================ WHAT IT IS FOR
 *
 * Two jobs, and the second one is the interesting one.
 *
 *   IT COVERS THE LOAD, and it is the one screen in this game that is
 *   guaranteed not to stutter while it does. Every pixel of it is markup
 *   styled inline in index.html; every moving thing on it is a CSS animation
 *   on `transform` or `opacity`, which a compositing browser advances from
 *   its own thread. The main thread can block for half a second inflating an
 *   archive or linking a shader and the horizon keeps moving at sixty. That
 *   is the whole reason it exists - see the note above #preload in
 *   index.html for what it replaced and why that had to go.
 *
 *   AND IT DECIDES WHEN THE GAME IS ACTUALLY READY, which is not the same
 *   question as whether the load has finished.
 *
 * ============================================ WHY "LOADED" IS NOT "READY"
 *
 * `load()` resolving means every asset is resident and the first frame has
 * been drawn. It does not mean the machine is in a state to be shown
 * anything: on the frames immediately after a cold load the browser is still
 * finishing texture uploads it deferred, the driver is still compiling the
 * last of the shader variants it linked lazily, the garbage collector is
 * catching up on forty-two megabytes of decode, and the first two or three
 * frames after the world exists are routinely four or five times the length
 * of the ones after them.
 *
 * Handing the cold open over at that exact moment is handing it the worst
 * three frames of the entire session - which is precisely what the player
 * reported: an opening that sticks at the start and then runs perfectly.
 *
 * So the handover waits for EVIDENCE. `smooth` counts consecutive frames that
 * came in under a threshold and only lets go once there have been enough of
 * them in a row; one slow frame resets the count. On a fast machine that is
 * a quarter of a second and nobody notices. On a slow one it is a second or
 * two of a loader that is still visibly alive, followed by a cold open that
 * runs properly - which is a far better trade than the reverse.
 *
 * IT IS BOUNDED, because a gate with no ceiling is a hang. After the
 * deadline it hands over regardless: a rough cold open is still better than
 * no game.
 *
 * ================================================== WHAT SCRIPT ACTUALLY DOES
 *
 * Almost nothing, deliberately. It writes a scale on the rail, a percentage
 * and a caption. All three stop when the thread stops - which is honest, and
 * is why the motion around them is not script's to write.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});
  const doc = global.document;

  let root = null, fill = null, label = null, pct = null, note = null;
  let raf = 0, gone = false, shownPct = -1, shownLabel = '';

  /* THE SMOOTHNESS GATE.
   *
   * `FRAMES` consecutive frames under `FRAME_MS` before the cold open is
   * allowed to start. Twelve at 24 ms is a fifth of a second of genuinely
   * steady output, which is enough to be sure the post-load settling is over
   * and short enough that a capable machine never sees the wait.
   *
   * 24 ms rather than 17: the gate is asking "has this machine stopped
   * hitching", not "is it holding sixty". A laptop that runs the game at 45
   * frames a second is perfectly able to play the cold open and must not be
   * held on a loading screen for failing a test it was never going to pass.
   */
  const FRAMES = 12;
  const FRAME_MS = 24;
  /* ...and the ceiling on waiting for them. Three seconds of a machine that
     never settles, and then it goes anyway. */
  const GATE_MS = 3000;

  function grab() {
    if (root !== null) return root;
    root = doc.getElementById('preload') || false;
    if (!root) return false;
    fill = doc.getElementById('plFill');
    label = doc.getElementById('plLabel');
    pct = doc.getElementById('plPct');
    note = doc.getElementById('plNote');
    return root;
  }

  /** The three things script owns, written only when they have changed. */
  function paint() {
    const B = NR.Boot;
    if (!B || !grab()) return;
    const p = Math.max(0, Math.min(1, B.progress || 0));
    const whole = Math.round(p * 100);
    if (whole !== shownPct) {
      shownPct = whole;
      if (fill) fill.style.setProperty('--p', p.toFixed(4));
      if (pct) pct.textContent = whole + '%';
    }
    const cap = B.label || '';
    if (cap !== shownLabel) {
      shownLabel = cap;
      if (label) label.textContent = cap;
    }
    if (note) {
      const d = B.detail || '';
      if (note.textContent !== d) note.textContent = d;
    }
  }

  function tick() {
    if (gone) return;
    paint();
    raf = global.requestAnimationFrame(tick);
  }

  /** Put it up. It is already in the document; this only starts the readout. */
  function begin() {
    if (!grab()) return;
    /* The window may open on this. The host builds its window hidden and
       reveals it when the page says it has drawn something, and this is the
       first thing there is to draw - so the player sees the game's name
       within a frame of launching it rather than a black rectangle for as
       long as the archive takes. */
    try { if (NR.Host && NR.Host.ready) NR.Host.ready(); } catch (e) { /* a browser */ }
    paint();
    raf = global.requestAnimationFrame(tick);
  }

  /**
   * Wait until this machine is producing steady frames, then call `done`.
   *
   * See the note at the top of the file: this is the difference between the
   * cold open playing on a settled machine and playing on the three worst
   * frames of the session.
   */
  function whenSmooth(done) {
    if (!doc || !global.requestAnimationFrame) { done(); return; }
    let run = 0, last = 0;
    const started = global.performance ? global.performance.now() : Date.now();
    const step = (now) => {
      if (gone) return;
      paint();
      if (last) {
        const dt = now - last;
        if (dt <= FRAME_MS) run++; else run = 0;
      }
      last = now;
      const waited = now - started;
      if (run >= FRAMES || waited >= GATE_MS) { done(); return; }
      global.requestAnimationFrame(step);
    };
    global.requestAnimationFrame(step);
  }

  /**
   * Take it down.
   *
   * The screen underneath is already running - the cold open starts BEFORE
   * this is called, so what the player sees is the loader dissolving off a
   * tachometer that is already sweeping, rather than a cut to a fresh screen.
   * `cb` fires once the element has actually gone.
   */
  function finish(cb) {
    if (gone) { if (cb) cb(); return; }
    gone = true;
    global.cancelAnimationFrame(raf);
    if (!grab()) { if (cb) cb(); return; }
    /* One last read, so the bar is full and the caption is the last one
       rather than whatever it was two frames ago. */
    if (fill) fill.style.setProperty('--p', '1');
    if (pct) pct.textContent = '100%';
    root.classList.add('pl-out');
    global.setTimeout(() => {
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = false;
      if (cb) cb();
    }, 560);
  }

  /** Straight off, for the harness and for any path that has no opening. */
  function kill() {
    gone = true;
    global.cancelAnimationFrame(raf);
    if (grab() && root.parentNode) root.parentNode.removeChild(root);
    root = false;
  }

  NR.Preload = { begin, whenSmooth, finish, kill, get gone() { return gone; } };
})(window);
