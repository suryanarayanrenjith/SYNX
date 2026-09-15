/* SYNX // STAGING.
 *
 * The card that covers a mode change, and the one thing about it that
 * matters: IT KEEPS MOVING WHILE THE MAIN THREAD DOES NOT.
 *
 * # The problem this is for
 *
 * Choosing STORY, MULTIPLAYER or FREE ROAM is not a menu transition. Behind
 * each of them is a chapter being built, a route being baked, a grid of
 * dressing being instanced and, at the end of it, a first frame - hundreds of
 * milliseconds of synchronous work on the only thread the page has. For that
 * whole time the last frame of the menu sits there, frozen, and the game looks
 * like it has hung. It has not; it is working; there is simply nothing on
 * screen that says so.
 *
 * # Why a spinner would not have fixed it
 *
 * The obvious answer is to put something animated on top. It does not work:
 * anything driven by requestAnimationFrame, by setInterval, or by a script of
 * any kind runs on exactly the thread that is blocked, so a spinner shown over
 * a stall is a spinner that stops the instant the stall begins. That is worse
 * than the frozen menu, because now the player has been shown something that
 * is visibly broken.
 *
 * # What actually works
 *
 * Every moving thing on this card is a CSS animation on `transform` or
 * `opacity` and NOTHING else. Those two properties are the ones a compositing
 * browser can animate off the main thread entirely: once the animation is
 * running, the compositor keeps advancing it from its own thread, at its own
 * rate, whether or not script is executing. So the needle sweeps, the rail
 * travels and the card breathes THROUGH the stall, at a smooth sixty, while
 * the main thread is flat out building a chapter.
 *
 * This is also why there is no progress number on it. A percentage would have
 * to be written by script, script is blocked, and a progress bar that stops at
 * 40% is precisely the thing this exists to avoid. What it shows instead is
 * honest in a different way: motion that means "working", and it stops when
 * the work does.
 *
 * # The two frames
 *
 * `cover` does not run the work in the same tick that shows the card - a
 * style change and the layout it causes are not on screen until the frame
 * after next. So it shows, waits two frames for the browser to have actually
 * painted it and started the animations on the compositor, and only then calls
 * the work. Getting this wrong means the card is created, the thread blocks
 * before it is ever painted, and the player sees the frozen menu followed by a
 * flash of a card that is already leaving.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});
  const doc = global.document;

  let card = null, since = 0, hideTimer = 0;
  /* How long it stays up once the work is done. A cover that vanishes the
     instant it appears is a flash, which reads as a fault; a third of a second
     reads as a transition. */
  const MIN_MS = 340;

  function build(label, sub) {
    if (!card) {
      card = doc.createElement('div');
      card.className = 'stage-cover';
      card.setAttribute('aria-hidden', 'true');
      /* The same panel language as every other screen in the game - a kicker,
         a cut-cornered frame, corner ticks - so a mode change reads as the
         grid doing something rather than as a loading interstitial that
         belongs to a different program. None of it is animated: it is painted
         once and then only transform and opacity move. See the note above. */
      card.innerHTML =
        '<div class="stage-inner synx-cut">'
        + '<small class="stage-kicker">SYNX GRID // STAGING</small>'
        + '<div class="stage-dial"><i class="stage-arc"></i><i class="stage-arc stage-arc-in"></i>'
        + '<i class="stage-needle"></i></div>'
        + '<b class="stage-label"></b>'
        + '<small class="stage-sub"></small>'
        + '<div class="stage-rail"><i></i></div>'
        + '</div>';
      doc.body.appendChild(card);
    }
    card.querySelector('.stage-label').textContent = label || 'STAND BY';
    card.querySelector('.stage-sub').textContent = sub || 'BUILDING THE ROUTE';
    return card;
  }

  function show(label, sub) {
    if (!doc || !doc.body) return null;
    global.clearTimeout(hideTimer);
    const el = build(label, sub);
    el.classList.remove('is-out');
    /* Read a layout property between removing the class and adding the other
       one, so the browser cannot collapse the two into a single style
       recalculation and skip the transition entirely. */
    void el.offsetWidth;
    el.classList.add('is-on');
    since = global.performance ? global.performance.now() : Date.now();
    return el;
  }

  function hide() {
    if (!card) return;
    const now = global.performance ? global.performance.now() : Date.now();
    const left = Math.max(0, MIN_MS - (now - since));
    global.clearTimeout(hideTimer);
    hideTimer = global.setTimeout(() => {
      if (!card) return;
      card.classList.remove('is-on');
      card.classList.add('is-out');
    }, left);
  }

  /**
   * Put the card up, let it paint, run `work`, take the card down.
   *
   * `work` is called once, synchronously, two frames after the card is shown.
   * It may block for as long as it likes; that is what the card is for. It is
   * always called - a failure to show the card is not allowed to be a failure
   * to change mode - and the card always comes down, including when the work
   * throws, because a cover left over a working game is far worse than no
   * cover at all.
   */
  function cover(label, sub, work) {
    if (typeof work !== 'function') return;
    if (!show(label, sub)) { work(); return; }
    const go = () => {
      try { work(); } finally { hide(); }
    };
    /* Two frames. One is not enough: the first only guarantees the style has
       been recalculated, and it is the second that guarantees a composited
       frame has actually been produced with the animations running on it. */
    global.requestAnimationFrame(() => global.requestAnimationFrame(go));
  }

  NR.Staging = { cover, show, hide };
})(window);
