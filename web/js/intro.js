/* SYNX // COLD START.
 *
 * The sequence between dismissing the advisory and the title screen being
 * usable. It exists for one reason: the first ten seconds are the only ten
 * seconds where every player is looking at the screen and nothing is being
 * asked of them, and this game has a renderer worth those ten seconds -
 * cascaded shadows, screen-space reflections, ground-truth ambient occlusion,
 * a volumetric pass on the headlights and a bloom pyramid over all of it. A
 * title screen that opens on a static three-quarter view shows none of it.
 *
 * WHAT IT IS, IN THREE PARTS.
 *
 *   THE VEIL.       Black, with the boot line typing across it, lifted by a
 *                   horizontal wipe rather than a fade. A wipe reads as a
 *                   machine doing something; a fade reads as a loading screen.
 *
 *   THE MOVE.       The camera itself - see `introCamera` in js/game.js. It
 *                   starts low and ahead of the car, swings back and up, and
 *                   lands exactly in the chase pose. Nothing about it is
 *                   pre-rendered: it is the game's own camera in the game's
 *                   own world, which is the entire point.
 *
 *   THE ASSEMBLY.   The wordmark and the rows arrive as the move lands, so the
 *                   interface appears to settle out of the shot rather than be
 *                   switched on over it.
 *
 * SKIPPABLE FROM THE FIRST FRAME. Anything at all - key, click, pad - takes
 * the whole thing down and hands over a title screen in its settled state.
 * A player on their ninetieth launch does not owe this six seconds.
 *
 * SHOWN ONCE PER SESSION, on the way in from the advisory. It is not on the
 * path back to the menu from a race: an intro you have to sit through every
 * time you quit to the title is not an intro, it is a toll.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});
  const doc = global.document;

  /* The boot lines. Deliberately real: every one of them names something the
     player can go and look at, and the last is the frame budget the renderer
     is actually holding. Nothing here is invented for the look of it. */
  const BOOT = [
    'SYNX CORE // WEBASSEMBLY SIMULATION ONLINE',
    'RENDERER // WEBGL2 . DEFERRED LIGHTING . 6-LEVEL BLOOM',
    'SHADOWS // 3 CASCADES . SSR . GTAO . VOLUMETRIC BEAMS',
    'ROUTE // 175 KM OF COURSE RESIDENT',
  ];

  let veil = null, line = null, writer = null, at = 0;
  let running = false, done = false, timer = 0;

  function build() {
    veil = doc.createElement('div');
    veil.className = 'intro-veil';
    veil.setAttribute('aria-hidden', 'true');

    const bars = doc.createElement('div');
    bars.className = 'intro-bars';
    veil.appendChild(bars);

    const term = doc.createElement('div');
    term.className = 'intro-term';
    const mark = doc.createElement('div');
    mark.className = 'intro-mark';
    mark.textContent = 'SYNX';
    term.appendChild(mark);
    line = doc.createElement('p');
    line.className = 'intro-line';
    term.appendChild(line);
    veil.appendChild(term);

    const hint = doc.createElement('p');
    hint.className = 'intro-skip';
    hint.textContent = 'PRESS ANYTHING TO SKIP';
    veil.appendChild(hint);

    doc.body.appendChild(veil);
  }

  function nextLine() {
    if (done || !line) return;
    if (at >= BOOT.length) { lift(); return; }
    const text = BOOT[at++];
    writer = NR.UI.type(line, text, { cps: 78, done: () => { timer = setTimeout(nextLine, 220); } });
  }

  /* The veil comes off and the camera move starts in the same frame, so the
     first thing under the wipe is already moving. Starting the move after the
     wipe finishes reads as two sequences rather than one.

     BUT ONLY ONCE THERE IS SOMETHING UNDER IT.

     The boot lines take about two and a half seconds and the game takes as
     long as it takes - a 40 MB pack, the wasm core, the course, and the
     dressing built on top of it. Whichever finishes first is a property of
     the machine, not of the design, and the first version simply assumed it
     was the loading: it read window.__nr, found nothing, and lifted the veil
     off a half-built world with no camera move at all.

     So the veil waits. That is also the better answer for what it is: a
     black screen with a terminal on it is a perfectly good thing to be
     looking at while a game loads, and a partially dressed course is not.
     The cap is there because a veil that waits forever is a hang - past it
     the notice comes off regardless and the player gets whatever is ready. */
  const WAIT_MS = 12000;
  let waitedFrom = 0;
  function lift() {
    if (done) return;
    const g = global.__nr;
    const ready = g && g.startIntro && g.scene && g.scene.ready;
    if (!ready) {
      if (!waitedFrom) waitedFrom = Date.now();
      if (Date.now() - waitedFrom < WAIT_MS) {
        if (line) line.textContent = BOOT[BOOT.length - 1];
        timer = setTimeout(lift, 120);
        return;
      }
    }
    veil.classList.add('intro-lift');
    if (g && g.startIntro) g.startIntro();
    timer = setTimeout(finish, 900);
  }

  function finish() {
    done = true;
    running = false;
    if (writer) writer.stop();
    global.clearTimeout(timer);
    doc.removeEventListener('keydown', onAny, true);
    doc.removeEventListener('pointerdown', onAny, true);
    if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
    veil = null;
  }

  function onAny() { skip(); }

  /** Take the whole sequence down and settle the title screen at once. */
  function skip() {
    if (!running && done) return;
    const g = global.__nr;
    if (g && g.endIntro) g.endIntro();
    finish();
  }

  function begin() {
    if (running || done) return;
    /* A player who has reduced motion turned on has asked not to be taken on
       a camera move. They get the title screen, settled, immediately. */
    if (!NR.UI || NR.UI.reduced()) { done = true; return; }
    running = true;
    build();
    doc.addEventListener('keydown', onAny, true);
    doc.addEventListener('pointerdown', onAny, true);
    timer = setTimeout(nextLine, 260);
  }

  NR.Intro = { begin, skip, get running() { return running; } };
})(window);
