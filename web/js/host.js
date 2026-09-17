/* SYNX - the desktop host bridge.
 *
 * The game runs inside a native window rather than a browser tab, and three
 * things behave differently because of that. This file owns all three, and it
 * degrades to sensible browser behaviour when the host is not there, so the
 * page still runs under a plain server for development.
 *
 *   QUIT      A tab can be closed; an application has to be quit. The title
 *             screen's QUIT row ends the process, which means releasing the GPU
 *             context and the audio device, not merely hiding a window.
 *
 *   FULLSCREEN  The DOM Fullscreen API resizes the document inside a webview
 *             and leaves the host window exactly where it was, so F did
 *             nothing visible. Fullscreen is a property of the window, so it is
 *             asked of the window.
 *
 *   THE SAVE  See below. It is a file.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};
  const T = global.__TAURI__;
  const invoke = T && T.core && T.core.invoke;

  /** True when running inside the desktop host rather than a browser. */
  const native = !!invoke;

  /* --------------------------------------------------------------- SAVE ---
   *
   * A real file, not `localStorage`.
   *
   * `localStorage` in a webview lives inside a WebView2 cache directory: a
   * path the player cannot find, cannot back up, and that Windows, Edge or any
   * "clear browsing data" sweep may empty without asking. Seven chapters of
   * campaign is too much to keep somewhere like that.
   *
   * So the save is a file the player owns:
   *
   *     %APPDATA%\com.synx.racing\synx-save.json
   *
   * written atomically, with the last good copy kept beside it. `NR.Save` is
   * the only thing the game talks to, and it is deliberately SYNCHRONOUS,
   * because the game reads its settings and its records from inside the frame
   * loop and an async read there would be a rewrite of six files. The file is
   * loaded once into memory before the game is constructed, reads are served
   * from that, and writes go to memory immediately and to disk on a short
   * debounce - so finishing a chapter, which writes several keys at once, is
   * one file write rather than five.
   *
   * Under a plain web server there is no host to write files, so it falls back
   * to `localStorage` and development keeps working.
   */

  /* How long to sit on a change before writing. Long enough that the several
     keys written at the end of a chapter coalesce into one file write, short
     enough that a player who alt-F4s a second later still keeps them. */
  const FLUSH_MS = 400;

  const Save = {
    /** Every key, in memory. The file is a mirror of this, not the other way. */
    _mem: Object.create(null),
    /** True when memory has something the file does not. */
    _dirty: false,
    _timer: 0,
    /** Where the file is, once the host has said. Shown in the options screen. */
    path: '',

    /* Read the file once, into memory.
     *
     * Must resolve before the game is constructed, because everything after
     * this point reads settings synchronously from inside the frame loop.
     * Never rejects: a save that cannot be read is an empty save plus a
     * console line, not a game that refuses to start. */
    load() {
      if (!invoke) {
        try {
          const raw = global.localStorage && global.localStorage.getItem('synx.save.v1');
          if (raw) Save._mem = JSON.parse(raw) || Object.create(null);
        } catch (e) { /* private mode, or something unparseable */ }
        return Promise.resolve(false);
      }
      return invoke('save_load').then((data) => {
        Save._mem = (data && typeof data === 'object') ? data : Object.create(null);
        return true;
      }).catch(() => false);
    },

    /** A string, or null. Reads never touch the disk. */
    get(key) {
      const v = Save._mem[key];
      return (v === undefined || v === null) ? null : String(v);
    },

    set(key, value) {
      if (value === undefined || value === null) return Save.remove(key);
      Save._mem[key] = String(value);
      Save._touch();
    },

    /* JSON with a default, because every caller of this wants one and the
       alternative is the same three lines of try/catch at each of them. A
       stored value that will not parse is treated as absent: it is a corrupt
       entry, and the default is a better answer than an exception thrown in
       the middle of a frame. */
    getJSON(key, fallback) {
      const raw = Save._mem[key];
      if (raw === undefined || raw === null) return fallback;
      if (typeof raw === 'object') return raw;
      try { return JSON.parse(raw); }
      catch (e) { return fallback; }
    },

    setJSON(key, value) {
      Save._mem[key] = value;
      Save._touch();
    },

    remove(key) {
      if (!(key in Save._mem)) return;
      delete Save._mem[key];
      Save._touch();
    },

    _touch() {
      Save._dirty = true;
      if (Save._timer) return;
      Save._timer = global.setTimeout(() => { Save._timer = 0; Save.flush(); }, FLUSH_MS);
    },

    /* Write now.
     *
     * Called on the debounce, and directly on the way out of the process,
     * where there is no time for a promise to settle - so the write is fired
     * and not waited on. Losing the last four hundred milliseconds of a
     * settings change is acceptable; blocking the window from closing is not.
     */
    flush() {
      if (!Save._dirty) return;
      Save._dirty = false;
      if (Save._timer) { global.clearTimeout(Save._timer); Save._timer = 0; }
      if (!invoke) {
        try {
          if (global.localStorage) {
            global.localStorage.setItem('synx.save.v1', JSON.stringify(Save._mem));
          }
        } catch (e) { /* quota, or private mode */ }
        return;
      }
      try { invoke('save_store', { data: Save._mem }); }
      catch (e) { /* the host is going away; the .bak is the safety net */ }
    },

    /** Erase it. The game confirms before calling this. */
    clear() {
      Save._mem = Object.create(null);
      Save._dirty = false;
      if (Save._timer) { global.clearTimeout(Save._timer); Save._timer = 0; }
      if (!invoke) {
        try { if (global.localStorage) global.localStorage.removeItem('synx.save.v1'); }
        catch (e) { /* nothing to do */ }
        return Promise.resolve(true);
      }
      return invoke('save_clear').then(ok => !!ok).catch(() => false);
    },
  };

  /* --------------------------------------------------------------- HOST ---
   *
   * Everything that is a property of the WINDOW or the PROCESS rather than of
   * the document. Each of these has a browser fallback that is the closest
   * honest equivalent, so the same page runs under `python -m http.server`.
   */
  const Host = {
    native,

    /* What the host said about itself: platform, arch, cores, version,
       whether the save directory is writable, and which renderer the window
       actually got. Null until `load` has run, and left null in a browser -
       every reader checks. */
    info: null,

    /* Show the window.
     *
     * The window is created hidden and revealed here, once the first frame is
     * ready, because a native window that appears white and then paints looks
     * broken in a way a browser tab never does. Called on the failure path
     * too: a host that stays hidden waiting for a frame that will never come
     * looks like a hang. */
    ready() {
      if (!invoke) return;
      try { invoke('ready'); } catch (e) { /* already shown */ }
    },

    /** End the process. A real exit, not a hidden window. */
    quit() {
      Save.flush();
      if (!invoke) return;
      try { invoke('quit_app'); } catch (e) { /* going away anyway */ }
    },

    /* Fullscreen, asked of the window that owns it.
     *
     * The DOM Fullscreen API resizes the document INSIDE the webview and
     * leaves the host window where it was, which is why F used to do nothing
     * visible. Under a plain browser there is no host window and the DOM API
     * is the right answer, so both are here. */
    setFullscreen(on) {
      if (invoke) {
        try { return invoke('set_fullscreen', { on: !!on }).catch(() => !!on); }
        catch (e) { return Promise.resolve(!!on); }
      }
      try {
        const d = global.document;
        if (on && d.documentElement.requestFullscreen) d.documentElement.requestFullscreen();
        else if (!on && d.exitFullscreen && d.fullscreenElement) d.exitFullscreen();
      } catch (e) { /* refused without a gesture */ }
      return Promise.resolve(!!on);
    },

    isFullscreen() {
      if (invoke) {
        try { return invoke('is_fullscreen').catch(() => false); }
        catch (e) { return Promise.resolve(false); }
      }
      return Promise.resolve(!!(global.document && global.document.fullscreenElement));
    },

    toggleFullscreen() {
      return Host.isFullscreen().then(on => Host.setFullscreen(!on));
    },

    /** Load the save, then ask the host what it is. Must resolve before the
        game is constructed. */
    load() {
      return Save.load().then(() => {
        if (!invoke) return false;
        return invoke('host_info').then(i => {
          Host.info = i;
          Save.path = (i && i.save_path) || '';
          return true;
        }).catch(() => false);
      });
    },
  };

  if (invoke) {
    // A last flush on the way out, for a window closed by its title bar rather
    // than by the menu.
    global.addEventListener('beforeunload', () => { Save.flush(); });
    global.addEventListener('blur', () => { if (Save._dirty) Save.flush(); });
  }

  NR.Host = Host;
  NR.Save = Save;
})(window);
