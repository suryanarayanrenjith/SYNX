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

  let veil = null, writer = null, at = 0;
  let rows = [], lines = [];
  let rail = null, fill = null, stamp = null;
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
    // the two offset slices are ::before/::after, and they need the string
    mark.setAttribute('data-text', 'SYNX');
    term.appendChild(mark);
    /* The wordmark on its own is a logo. The line under it is what the logo is
       FOR, and it is the same line the title screen carries a moment later -
       so the two screens read as one thing arriving rather than as a splash
       followed by a menu. */
    const tag = doc.createElement('p');
    tag.className = 'intro-tag';
    tag.textContent = 'SYNTHWAVE eXTREME RACING';
    term.appendChild(tag);

    /* EVERY LINE STAYS, AND EACH ONE IS SIGNED OFF.
     *
     * There used to be one paragraph that was emptied and retyped four times,
     * which is a status line rather than a boot: three quarters of what the
     * machine had reported was gone by the time the fourth line arrived, and
     * nothing on screen said any of it had succeeded. A ledger that fills up,
     * with an OK landing on each row as it completes, is what a system coming
     * up actually looks like - and it is the same four strings.
     *
     * The tag is a sibling rather than a ::after on the row, because the
     * typewriter's caret is already a ::after and two of them on one element
     * is one of them not existing. */
    const list = doc.createElement('div');
    list.className = 'intro-lines';
    rows = []; lines = [];
    for (let i = 0; i < BOOT.length; i++) {
      const row = doc.createElement('div');
      row.className = 'intro-row';
      const p = doc.createElement('p');
      p.className = 'intro-line';
      const ok = doc.createElement('b');
      ok.className = 'intro-ok';
      ok.textContent = 'OK';
      row.appendChild(p);
      row.appendChild(ok);
      list.appendChild(row);
      rows.push(row);
      lines.push(p);
    }
    term.appendChild(list);
    veil.appendChild(term);

    /* THE RAIL. Four boot lines with nothing under them is four sentences;
       four boot lines over a bar that fills as each one lands is a machine
       coming up, and it costs one element. It is honest, too - it is the
       count of lines that have actually been printed, not a timer pretending
       to be one. */
    rail = doc.createElement('div');
    rail.className = 'intro-rail';
    fill = doc.createElement('i');
    rail.appendChild(fill);
    term.appendChild(rail);
    if (fill) fill.style.transform = 'scaleX(0)';

    /* ...and the stamp that lands on the last line. A sequence that simply
       stops has no end; one that says the word and THEN wipes has a beat, and
       the beat is what the camera move comes in on. */
    stamp = doc.createElement('b');
    stamp.className = 'intro-ready';
    stamp.textContent = 'SYSTEMS NOMINAL';
    term.appendChild(stamp);

    const hint = doc.createElement('p');
    hint.className = 'intro-skip';
    hint.textContent = 'PRESS ANYTHING TO SKIP';
    veil.appendChild(hint);

    doc.body.appendChild(veil);
  }

  function nextLine() {
    if (done || !lines.length) return;
    if (at >= BOOT.length) { arrive(); return; }
    const i = at++;
    const line = lines[i];
    const text = BOOT[i];
    if (fill) fill.style.transform = 'scaleX(' + (at / BOOT.length) + ')';
    /* FASTER THAN IT WAS, because it is no longer waiting for anything.

       These lines used to be printed over a load: the pack, the core and the
       course were all still arriving underneath them, and the sequence was
       paced so that a slow machine had something to read. The loading has
       moved in front of the photosensitivity notice now - see js/ignition.js
       - so by the time this runs the game is BUILT, and four lines paced for
       a wait are four lines the player is waiting for.

       A hundred and thirty characters a second, and a shorter gap: the whole
       terminal is about two seconds instead of four, which is a title
       sequence rather than a progress report. */
    writer = NR.UI.type(line, text, {
      cps: 132,
      done: () => {
        if (rows[i]) rows[i].classList.add('is-done');
        timer = setTimeout(nextLine, 118);
      },
    });
  }

  /* The beat between the last line and the wipe. */
  function arrive() {
    if (done) return;
    if (stamp) stamp.classList.add('is-on');
    if (veil) veil.classList.add('intro-armed');
    timer = setTimeout(lift, 420);
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
  /* Still here, and still needed, but it should almost never be reached now:
     the cold open in front of the photosensitivity notice does not end until
     the game has loaded, so by the time the notice has been read and this has
     typed, `startIntro` has been ready for several seconds. What is left is
     the case where a player skips the cold open - the load is not skipped by
     that and can still be in flight here. */
  const WAIT_MS = 12000;
  /* ...AND A MUCH SHORTER ONE FOR THE MUSIC.
   *
   * The theme is deliberately silent through the cold open and the
   * photosensitivity notice so that it can start WITH the opening shot - see
   * onMusic in js/game.js. That only pays off if it can actually start on the
   * frame it is asked to, and a media element cannot until it has buffered.
   *
   * On a cold cache that buffer very often lands a few hundred milliseconds
   * after this point, so the shot began in silence and the score arrived over
   * the middle of it, which is the whole of the "the music is out of sync"
   * report. Waiting a beat for it costs nothing anybody can perceive - the
   * boot lines are still on screen - and it is what makes the first bar and
   * the first frame the same moment.
   *
   * It is a short wait and it is capped, because a track that is not coming
   * must not be able to hold the game on a black screen. Past the cap the
   * shot starts anyway and the music joins it, exactly as it used to. */
  const MUSIC_WAIT_MS = 1400;
  let waitedFrom = 0, musicFrom = 0;

  /** Is the score able to start this frame, or is there nothing to wait for? */
  function scoreReady(g) {
    const a = g && g.audio;
    if (!a || !a.trackReady) return true;
    if (a.muted) return true;            // no music at all; nothing to sync to
    /* A SUSPENDED CONTEXT IS THE WORST CASE, not a harmless one.
       Once the element is wired into the graph its stream is consumed whether
       or not the context is running, so cueing a track into a suspended
       context does not delay the music - it plays it, silently, and hands
       back a song that is several seconds in by the time the browser lets the
       sound out. That is out of sync in the most literal way there is. */
    if (!a.running) return false;
    return a.trackReady('menu');
  }

  function lift() {
    if (done) return;
    const g = global.__nr;
    const ready = g && g.startIntro && g.scene && g.scene.ready;
    if (!ready) {
      if (!waitedFrom) waitedFrom = Date.now();
      if (Date.now() - waitedFrom < WAIT_MS) {
        timer = setTimeout(lift, 120);
        return;
      }
    } else if (!scoreReady(g)) {
      if (!musicFrom) musicFrom = Date.now();
      if (Date.now() - musicFrom < MUSIC_WAIT_MS) {
        timer = setTimeout(lift, 60);
        return;
      }
    }
    veil.classList.add('intro-lift');
    /* The same frame, on purpose: the wipe, the camera move and the first bar
       of the theme. Starting any of the three after the others reads as three
       sequences rather than one. */
    if (g && g.startIntro) g.startIntro();
    timer = setTimeout(finish, 900);
  }

  function finish() {
    done = true;
    running = false;
    /* WHEREVER THIS ENDED, THE MUSIC STARTS. The lift has usually done it
       already and releaseMusic is a no-op then; what this catches is the
       player who skipped, for whom nothing else ever would. */
    const gm = global.__nr;
    if (gm && gm.releaseMusic) gm.releaseMusic();
    if (writer) writer.stop();
    global.clearTimeout(timer);
    for (const type of EVENTS) doc.removeEventListener(type, onAny, true);
    if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
    veil = null;
    /* AND THE TITLE SCREEN DOES NOT GET THE PRESS THAT CLOSED THIS.

       Spamming ENTER through the opening used to walk the player several
       screens into the game. The reason was not the menu being too eager: it
       was that this sequence listened for a key WITHOUT CONSUMING IT. One
       press did two things - it skipped the intro, and the same event went
       on to the input layer underneath, which was already sitting in the
       title menu with START selected. A second press opened the mode
       terminal, a third chose STORY, and a player who held the key down went
       from the SYNX logo to a chapter list without seeing either screen.

       Two halves to the fix, and both are needed. The listeners below now
       CONSUME what they read - see EVENTS and the note on it - so nothing
       behind this modal ever sees a press while it is up. And the gate is
       shut behind it for longer than the wipe takes, so the release of
       whatever dismissed it, and anything still arriving from a held key,
       lands on a menu that is not listening yet. See NR.Gate in js/ui.js. */
    if (NR.Gate) NR.Gate.lock(520);
  }

  /* WHAT THIS MODAL TAKES, AND TAKES AWAY FROM EVERYTHING ELSE.

     keydown is the one that skips. The other three are here because they are
     the ones that would otherwise reach the screen underneath on their own:
     a keyup from a press that arrived before this opened, and the click that
     a pointerdown/pointerup pair turns into. Taken at the capture phase, so
     they are stopped before any of the game's own window listeners see them,
     and TAB is left alone because focus still has to be able to move. */
  const EVENTS = ['keydown', 'keyup', 'pointerdown', 'pointerup'];

  function onAny(e) {
    if (e && e.type === 'keydown' && e.key === 'Tab') return;
    if (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      // only a press starts the skip; the matching release is merely eaten
      if (e.type === 'keyup' || e.type === 'pointerup') return;
    }
    skip();
  }

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
    if (!NR.UI || NR.UI.reduced()) {
      done = true;
      /* ...and the score still starts. There is no veil to lift here and so
         nothing that would otherwise have released the hold, which left a
         reduced-motion player on a silent title screen. */
      const gm = global.__nr;
      if (gm && gm.releaseMusic) gm.releaseMusic();
      // ...and the gate still shuts, or reduced motion becomes a fast path
      // into the mode terminal for anybody holding ENTER. See finish().
      if (NR.Gate) NR.Gate.lock(420);
      return;
    }
    running = true;
    build();
    for (const type of EVENTS) doc.addEventListener(type, onAny, true);
    timer = setTimeout(nextLine, 260);
  }

  NR.Intro = { begin, skip, get running() { return running; } };
})(window);
