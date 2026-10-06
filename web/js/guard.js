/* SYNX // THE PRODUCTION GUARD.
 *
 * Loaded FIRST, by the game and by the launcher, before any other script.
 *
 * # One question, answered once
 *
 * Is this a development session? `NR.DEV` holds the answer, and it is fixed
 * the moment this file runs:
 *
 *   YES under a debug build of the host, or a test build made with
 *       `--features harness` - the host says so before any page script runs
 *       (see `dev_flag` in src-tauri/src/main.rs);
 *   YES in a plain browser on this machine - localhost, 127.0.0.1, a file -
 *       which is where every tool in tools/ runs the game;
 *   NO everywhere else. Which is to say: in the game a player installs.
 *
 * Every development hook in the game is published only when it is YES - the
 * live game handle on `window`, the descriptors the test harness asserts
 * against, the load-timing table, the URL switches that A/B a renderer
 * feature. A shipped build has none of them, rather than having them and
 * hoping nobody looks.
 *
 * # And in production, the browser stays out of the game
 *
 * The game runs in a webview, and a webview is a browser underneath: it has a
 * right-click menu, an inspector and a page full of keyboard shortcuts, every
 * one of which is either a way into the game's internals or a way to throw a
 * race away mid-lap - F5 reloads the page, Ctrl+P opens a print dialog over
 * the road. In a shipped build all of them are switched off here, on every
 * platform: the host also turns WebView2's own menu and keys off natively on
 * Windows (lock_webview2 in main.rs), and this is what covers WebKitGTK and
 * WKWebView, and covers Windows twice.
 *
 * ONLY `preventDefault`, NEVER `stopPropagation`. Cancelling the browser's
 * default is all that is needed to stop it acting, and the game still hears
 * every key - a player who binds a function key to something keeps it.
 */
(function (global) {
  'use strict';
  const NR = global.NR || (global.NR = {});

  const loc = global.location || null;
  const hostName = loc ? String(loc.hostname || '') : '';
  const inHost = !!(global.__TAURI_INTERNALS__ || global.__TAURI__);
  const onThisMachine = !loc || loc.protocol === 'file:'
    || hostName === 'localhost' || hostName === '127.0.0.1'
    || hostName === '[::1]' || hostName === '::1';
  const dev = global.SYNX_DEV === true || (!inHost && onThisMachine);

  // fixed once, here: nothing later in the session can flip it
  Object.defineProperty(NR, 'DEV', { value: dev, enumerable: true, writable: false, configurable: false });
  if (dev) return;

  const doc = global.document;
  if (!doc || !doc.addEventListener) return;

  /** Is this a browser shortcut rather than something the game listens for? */
  function browserKey(e) {
    const k = String(e.key || '');
    const low = k.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    // the inspector, the page source, and the help and caret-browsing prompts
    if (k === 'F12' || k === 'F1' || k === 'F7') return true;
    if (mod && e.shiftKey && (low === 'i' || low === 'j' || low === 'c' || low === 'k' || low === 'm')) return true;
    if (e.metaKey && e.altKey && (low === 'i' || low === 'j' || low === 'c' || low === 'u')) return true;
    if (mod && low === 'u') return true;
    // reloading, which ends the race; finding, printing, saving, opening
    if (k === 'F5' || k === 'F3') return true;
    if (mod && (low === 'r' || low === 'f' || low === 'g' || low === 'p' || low === 's'
      || low === 'o' || low === 'h' || low === 'j' || low === 'n' || low === 'd')) return true;
    if (mod && e.shiftKey && (k === 'Delete' || low === 'delete')) return true;
    // zoom, which re-lays the whole interface out from under the player
    if (mod && (k === '+' || k === '-' || k === '=' || k === '0' || k === '_')) return true;
    // history: the game is one page, and there is nothing behind it
    if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home')) return true;
    if (/^Browser/.test(k)) return true;
    return false;
  }

  doc.addEventListener('keydown', (e) => { if (browserKey(e)) e.preventDefault(); }, true);

  /* The right-click menu: gone, except over a text field, where cut, copy and
     paste are what a player typing a name or a server address expects. */
  doc.addEventListener('contextmenu', (e) => {
    const t = e.target;
    const editable = t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (!editable) e.preventDefault();
  }, true);

  // ctrl + wheel is zoom, and pinch on a trackpad arrives as exactly that
  global.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); },
    { passive: false, capture: true });

  // an image or a link dragged out of the window is the page leaving with it
  doc.addEventListener('dragstart', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'IMG' || t.tagName === 'A')) e.preventDefault();
  }, true);
})(typeof window !== 'undefined' ? window : globalThis);
