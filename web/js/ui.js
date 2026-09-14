/* SYNX // shared interface pieces.
 *
 * Two things live here, and they are here rather than in the screen that first
 * needed them because every screen needs them:
 *
 *   NR.UI.alert   a modal card that says one thing and offers one or two ways
 *                 out. Used for the network warnings, and for anything else
 *                 that has to stop the player rather than scroll past them.
 *   NR.UI.type    the typewriter. Text that arrives a character at a time is
 *                 the single cheapest thing that makes an interface feel like
 *                 hardware rather than a document, and doing it in one place
 *                 means it obeys prefers-reduced-motion everywhere at once.
 *
 * THE RULES THIS FILE KEEPS, because they are easy to get wrong once and then
 * wrong in eleven places:
 *
 *   NOTHING FLASHES. The game ships behind a photosensitivity notice; an
 *   interface that strobes after the player has accepted that notice is worse
 *   than one that never warned them. Every animation here is under 3 Hz.
 *
 *   REDUCED MOTION IS OBEYED. Not softened - obeyed. The typewriter prints the
 *   whole string at once and the card appears rather than arriving.
 *
 *   THE KEYBOARD NEVER GETS LOST. A modal takes focus, remembers what had it,
 *   traps TAB while it is up, and hands focus back on the way out.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});
  const doc = global.document;

  const reduced = () => {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  };

  /* ------------------------------------------------------- the typewriter --
   *
   * Driven off requestAnimationFrame and the clock rather than setInterval per
   * character: a 40 ms timer per glyph on a 30 fps frame drops half of them
   * into the same paint anyway, and drifts. Reading elapsed time and slicing
   * the string to match is exact at any frame rate and costs one assignment.
   *
   * Returns a handle with `skip` (finish now) and `stop` (leave it where it
   * is), because the caller usually wants a click anywhere to complete it.
   */
  function type(el, text, opts) {
    const o = opts || {};
    const cps = o.cps || 52;
    const str = String(text == null ? '' : text);
    if (!el) return { skip() {}, stop() {}, done: true };
    if (reduced() || o.instant) {
      el.textContent = str;
      if (o.done) o.done();
      return { skip() {}, stop() {}, done: true };
    }
    let raf = 0, start = 0, killed = false;
    const handle = {
      done: false,
      skip() {
        if (killed || handle.done) return;
        handle.done = true;
        if (raf) global.cancelAnimationFrame(raf);
        el.textContent = str;
        el.classList.remove('ui-typing');
        if (o.done) o.done();
      },
      stop() {
        killed = true;
        if (raf) global.cancelAnimationFrame(raf);
        el.classList.remove('ui-typing');
      },
    };
    el.textContent = '';
    /* The caret is a class rather than a character appended to the text: a
       glyph would be selected and copied with the message, and would have to
       be stripped back off before every measurement of it. */
    el.classList.add('ui-typing');
    const step = (now) => {
      if (killed) return;
      if (!start) start = now;
      const n = Math.floor(((now - start) / 1000) * cps) + (o.delay ? 0 : 1);
      if (n >= str.length) { handle.skip(); return; }
      el.textContent = str.slice(0, Math.max(0, n));
      raf = global.requestAnimationFrame(step);
    };
    raf = global.requestAnimationFrame(step);
    return handle;
  }

  /* ------------------------------------------------------------ the modal --
   *
   * One card at a time. A second call while one is up replaces it rather than
   * stacking, because two modals over each other is a dead end for anyone
   * driving with a pad - the one underneath cannot be reached and the one on
   * top does not know it is not alone.
   */
  let live = null;

  function close(result) {
    if (!live) return;
    const it = live;
    live = null;
    if (it.writer) it.writer.stop();
    doc.removeEventListener('keydown', it.onKey, true);
    it.root.classList.add('ui-gone');
    /* Removed rather than hidden: it is a full-screen element with its own
       stacking context, and leaving it parked over the game costs a composite
       every frame for something nobody can see. */
    global.setTimeout(() => { if (it.root.parentNode) it.root.parentNode.removeChild(it.root); }, 240);
    if (it.was && it.was.focus) { try { it.was.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    if (it.onClose) it.onClose(result);
  }

  /** @param {{kind?:string, title:string, body:string, note?:string,
   *           actions?:Array<{label:string, value?:string, primary?:boolean}>,
   *           dismissible?:boolean, onClose?:function}} spec */
  function alert(spec) {
    const s = spec || {};
    if (live) close(null);

    const root = doc.createElement('div');
    root.className = 'ui-modal ui-' + (s.kind || 'info');
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-modal', 'true');

    const card = doc.createElement('div');
    card.className = 'ui-card';

    const rule = doc.createElement('div');
    rule.className = 'ui-rule';
    rule.appendChild(doc.createElement('i'));
    const tag = doc.createElement('span');
    tag.textContent = s.tag || (s.kind === 'error' ? 'LINK FAILURE'
      : s.kind === 'warn' ? 'ADVISORY' : 'NOTICE');
    rule.appendChild(tag);
    rule.appendChild(doc.createElement('i'));
    card.appendChild(rule);

    const h = doc.createElement('h2');
    h.className = 'ui-title';
    h.textContent = s.title || '';
    card.appendChild(h);

    const p = doc.createElement('p');
    p.className = 'ui-body';
    card.appendChild(p);

    if (s.note) {
      const n = doc.createElement('p');
      n.className = 'ui-note';
      n.textContent = s.note;
      card.appendChild(n);
    }

    const row = doc.createElement('div');
    row.className = 'ui-actions';
    const acts = (s.actions && s.actions.length) ? s.actions : [{ label: 'OK', primary: true }];
    let primary = null;
    for (const a of acts) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'ui-btn' + (a.primary ? ' is-primary' : '');
      b.textContent = a.label;
      b.addEventListener('click', () => close(a.value === undefined ? a.label : a.value));
      row.appendChild(b);
      if (a.primary && !primary) primary = b;
    }
    card.appendChild(row);
    root.appendChild(card);

    /* A click anywhere finishes the typewriter first and only dismisses on the
       second one. Someone who clicks to read faster has not asked to leave. */
    root.addEventListener('mousedown', (e) => {
      if (live && live.writer && !live.writer.done) { live.writer.skip(); return; }
      if (e.target === root && s.dismissible !== false) close(null);
    });

    const onKey = (e) => {
      if (!live) return;
      if (e.key === 'Escape' && s.dismissible !== false) { e.preventDefault(); close(null); return; }
      if (live.writer && !live.writer.done && e.key !== 'Tab') { live.writer.skip(); }
      if (e.key === 'Tab') {
        // the focus trap: two ends of a list, wrapped
        const all = card.querySelectorAll('button');
        if (!all.length) return;
        const first = all[0], last = all[all.length - 1];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    doc.addEventListener('keydown', onKey, true);

    doc.body.appendChild(root);
    live = { root, onKey, was: doc.activeElement, onClose: s.onClose, writer: null };
    live.writer = type(p, s.body || '', { cps: s.cps || 58 });
    const target = primary || card.querySelector('button');
    if (target) { try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } }
    return { close };
  }

  /** Is one up right now? Callers use this to avoid stacking their own. */
  function busy() { return !!live; }

  /* ------------------------------------------------------- the gate --
   *
   * WHY A SCREEN CHANGE HAS TO SWALLOW THE NEXT FEW MILLISECONDS OF INPUT.
   *
   * Every screen in this game answers ENTER, and they answer it in three
   * different places: the canvas menus poll a per-frame pressed set, the
   * DOM screens listen for keydown, and the story director has its own
   * handler. None of them knows the others exist.
   *
   * So a player pressing ENTER quickly does this: the first press starts
   * STORY, which opens the chapter list; the second press lands on the
   * chapter list, which was not on screen when the finger went down and has
   * no idea the press was meant for the title; and the third is already
   * somewhere else again. Two taps and the game is three screens deep in a
   * place nobody chose. It reads as the game glitching out, and it is
   * really just three listeners sharing one keyboard with no handover.
   *
   * The handover is this. A screen change locks the gate for a moment, and
   * every one of those three readers asks the gate first. It is short - a
   * fifth of a second, about the time a deliberate second press takes - so
   * it costs a fast player nothing and costs a spammed key everything.
   */
  let until = 0;
  const Gate = {
    /** Swallow input for `ms`. Called on every state change; see js/game.js. */
    lock(ms) { until = Math.max(until, performance.now() + (ms || 190)); },
    /** True when input should be acted on. */
    open() { return performance.now() >= until; },
    /** Let it through again at once - for a screen that WANTS the next key. */
    clear() { until = 0; },
  };
  NR.Gate = Gate;

  /* ------------------------------------------------------ SCREEN CHANGES --
   *
   * Hiding a full-screen root is a one-liner - set aria-hidden, the
   * stylesheet sets display:none - and that one line is a hard cut. The
   * panel inside it has an entrance and no exit, so going INTO a screen was
   * a move and coming OUT of it was a jump, which is what makes an interface
   * feel like a set of pages rather than one thing.
   *
   * This is the exit, and it is deliberately small: mark the element, let the
   * stylesheet fade it, THEN hide it. One place, so every screen leaves the
   * same way and none of them can be forgotten.
   *
   * It is safe to call twice, and safe to call on a screen that is already
   * hidden. Anything that re-opens the screen mid-fade cancels the exit,
   * because a card that is fading out while it is being asked to come back
   * is the worst possible answer.
   */
  const LEAVE_MS = 180;
  NR.Screen = {
    hide(el) {
      if (!el) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (reduced()) { el.setAttribute('aria-hidden', 'true'); return; }
      el.classList.add('is-leaving');
      global.clearTimeout(el.__leave);
      el.__leave = global.setTimeout(() => {
        el.__leave = 0;
        el.classList.remove('is-leaving');
        el.setAttribute('aria-hidden', 'true');
      }, LEAVE_MS);
    },
    show(el) {
      if (!el) return;
      global.clearTimeout(el.__leave);
      el.__leave = 0;
      el.classList.remove('is-leaving');
      el.setAttribute('aria-hidden', 'false');
    },
  };

  NR.UI = { alert, close, busy, type, reduced };
})(window);
