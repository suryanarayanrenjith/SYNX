/* SYNX - the launcher.
 *
 * One screen, four tabs, and a PLAY button that builds the game window out of
 * the answers. The rows are not written here: they come from js/settings.js,
 * which the in-game options screen reads from as well, so the two cannot
 * disagree about what a setting is called or what its values are.
 *
 * WHAT THIS OWNS AND WHAT IT DOES NOT
 *
 * It owns the WINDOW - mode, monitor, size, renderer - because none of those
 * can be changed once a webview has a GPU context, and it owns them alone.
 * Everything else on this screen is a mirror of the in-game options: the same
 * schema, the same save key, the same indices. Changing the music volume here
 * and then changing it again in the game is not two settings, it is one
 * setting reached from two places.
 *
 * NO WEBGL, DELIBERATELY
 *
 * The background is CSS. A launcher that creates a 3D context to look
 * impressive is a launcher that fails to open on precisely the machine whose
 * owner came here to select the software renderer, and "the settings screen
 * for the graphics problem will not start because of the graphics problem" is
 * not a bug anyone should have to report.
 */
(function (global) {
  'use strict';

  const doc = global.document;
  const S = global.NR && global.NR.Settings;
  const T = global.__TAURI__;
  const invoke = T && T.core && T.core.invoke;

  /* Running under a plain web server rather than the desktop host - which is
     how this page is developed and how the smoke test reaches it. Everything
     still works except actually opening a window, and the screen says so
     rather than pretending the button did something. */
  const native = !!invoke;

  /* The pages. The SCHEMA decides which row is on which - every launcher row
     carries a `tab` - so this is only their names and their order. Deriving
     the page from a row's group header, which is what this did first, meant a
     new group silently landed on whichever page the lookup table happened to
     default to. */
  const TABS = ['DISPLAY', 'GRAPHICS', 'SOUND + REPLAY'];

  /** Whatever was thrown, as something a person can read. */
  function msgOf(e) {
    if (!e) return 'no reason given';
    if (typeof e === 'string') return e;
    if (e.message) return e.message;
    try { return JSON.stringify(e); } catch (x) { return String(e); }
  }

  class Launcher {
    constructor() {
      this.ui = {
        tabs: doc.getElementById('tabs'),
        rows: doc.getElementById('rows'),
        hint: doc.getElementById('hint'),
        note: doc.getElementById('note'),
        play: doc.getElementById('play'),
        bench: doc.getElementById('bench'),
        quit: doc.getElementById('quit'),
        reset: doc.getElementById('reset'),
        save: doc.getElementById('save'),
        alert: doc.getElementById('alert'),
        alertTitle: doc.getElementById('alertTitle'),
        alertPath: doc.getElementById('alertPath'),
        alertBody: doc.getElementById('alertBody'),
        alertOpen: doc.getElementById('alertOpen'),
        alertDismiss: doc.getElementById('alertDismiss'),
        diag: doc.getElementById('diag'),
        version: doc.getElementById('version'),
        graphics: doc.getElementById('graphics'),
      };
      this.tab = 0;
      this.monitors = [];
      this.sizes = [];
      this.startedGpu = true;
      this.busy = false;
      /* Two objects, two save keys: the window answers the host reads, and the
         game settings the game reads. They are edited on one screen and that
         is the only thing they have in common. */
      this.win = {};
      this.game = {};
    }

    async boot() {
      if (!S) { this.fail('js/settings.js did not load; nothing to show.'); return; }

      if (native) {
        try {
          const view = await invoke('launcher_view');
          this.win = view.settings || {};
          this.monitors = view.monitors || [];
          this.sizes = view.sizes || [];
          this.startedGpu = !!view.started_gpu;
          this.ui.version.textContent = 'v' + (view.version || '1.0.0');
          this.ui.graphics.textContent = view.graphics || '-';
        } catch (e) {
          this.bootDone();
          this.fail('The host did not answer: ' + (e && e.message ? e.message : e));
          return;
        }
        try {
          const save = await invoke('save_load');
          const raw = save && save[S.KEY];
          this.game = this.parseSettings(raw);
        } catch (e) { this.game = {}; }
      } else {
        // Development, or the smoke harness. Read and write localStorage so
        // the screen is fully exercisable without the desktop host.
        this.win = this.readLocal(S.LAUNCHER_KEY, {});
        this.game = this.readLocal(S.KEY, {});
        this.monitors = [{ name: 'DISPLAY (BROWSER)', width: 1920, height: 1080, scale: 1, primary: true }];
        this.sizes = [[1280, 720], [1600, 900], [1920, 1080]];
        this.ui.version.textContent = 'dev';
        this.ui.graphics.textContent = 'browser';
      }

      /* Open on a named page when one is asked for: launcher.html#graphics.
         It is two lines, it makes the screen linkable, and it is how the build
         captures each page for a look without having to drive a click. */
      const want = TABS.indexOf(String(global.location.hash || '').replace('#', '').toUpperCase());
      if (want >= 0) this.tab = want;

      this.applyDefaults();
      /* ...and whatever the benchmark measured last time, applied once. It
         runs after applyDefaults so it is writing over a complete settings
         object rather than a half-built one. See applyBench. */
      this.readBench().then((rec) => {
        if (this.applyBench(rec)) this.render();
      }).catch(() => {});
      this.buildTabs();
      this.bind();
      this.render();

      /* SHOW THE WINDOW.
       *
       * It is built hidden so the player never sees an unstyled page, and it
       * is THIS call that reveals it - not a timer. The host has a four-second
       * fallback for the case where this line is never reached, and relying on
       * that fallback was the whole of the launcher's first version: it opened
       * a blank window and filled it four seconds later. */
      if (native) invoke('ready').catch(() => {});

      /* ...and the card comes off. Not before: the rows have only just been
         built, and taking it away any earlier shows the very half-drawn
         screen it is there to cover. The diagnostics below are slower still
         and are allowed to land underneath it - they fill in two lines of
         small print and nothing the player is waiting to click. */
      this.bootDone();

      // ...and only now, once there is something on screen, the diagnostics:
      // they cost a subprocess or two and must never delay the first paint.
      this.loadDiagnostics();

      // Focus PLAY, because it is what almost everyone is here to press.
      global.setTimeout(() => this.ui.play.focus(), 60);
    }

    /** Take the opening card down, once there is a screen behind it. */
    bootDone() {
      const el = doc.getElementById('boot');
      if (!el || el.classList.contains('gone')) return;
      el.classList.add('gone');
      /* Removed rather than left hidden: it is a full-screen element with
         its own stacking context over a screen that is now interactive. */
      global.setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 520);
    }

    /* The settings blob, whatever shape it is in.
       The desktop host stores real JSON; the browser fallback and older saves
       store a JSON document inside a JSON string. Both have to load. */
    parseSettings(raw) {
      if (!raw) return {};
      if (typeof raw === 'object') return Object.assign({}, raw);
      try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
    }

    readLocal(key, fallback) {
      try {
        const raw = global.localStorage && global.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) || fallback) : fallback;
      } catch (e) { return fallback; }
    }

    /** Fill in anything the save does not carry, from the schema. */
    applyDefaults() {
      // Every row that lives in the GAME's blob, whichever screen shows it -
      // RENDER SCALE is only on this screen and is still the game's setting.
      for (const r of S.ROWS) {
        if (S.isHostKey(r.key)) continue;
        if (typeof this.game[r.key] !== 'number') this.game[r.key] = r.def;
      }
      const w = this.win;
      if (typeof w.mode !== 'string') w.mode = 'borderless';
      if (typeof w.gpu !== 'boolean') w.gpu = true;
      if (typeof w.vsync !== 'boolean') w.vsync = true;
      if (typeof w.always_on_top !== 'boolean') w.always_on_top = false;
      if (typeof w.monitor !== 'number') w.monitor = 0;
      if (typeof w.width !== 'number') w.width = 1600;
      if (typeof w.height !== 'number') w.height = 900;
      w.monitor = Math.max(0, Math.min(w.monitor, Math.max(0, this.monitors.length - 1)));
    }

    // -------------------------------------------------------------- rows --

    /* Reading and writing a row is one function each, because a row's value
       lives in one of two objects depending on which key it is, and every
       call site getting that right independently is how the two drift. */
    valueOf(row) {
      const w = this.win;
      switch (row.key) {
        case 'mode': return ['windowed', 'borderless', 'fullscreen'].indexOf(w.mode) + 0;
        case 'monitor': return w.monitor;
        case 'size': return Math.max(0, this.sizeIndex());
        case 'gpu': return w.gpu ? 1 : 0;
        case 'vsync': return w.vsync ? 1 : 0;
        case 'always_on_top': return w.always_on_top ? 1 : 0;

        default: return this.game[row.key] | 0;
      }
    }

    setValue(row, i) {
      const w = this.win;
      switch (row.key) {
        case 'mode': w.mode = ['windowed', 'borderless', 'fullscreen'][i] || 'borderless'; break;
        case 'monitor':
          w.monitor = i;
          // A different display has a different size ladder; keep the chosen
          // size legal rather than silently building a window off the edge.
          this.clampSize();
          break;
        case 'size': {
          const s = this.sizes[i];
          if (s) { w.width = s[0]; w.height = s[1]; }
          break;
        }
        case 'gpu': w.gpu = i === 1; break;
        case 'vsync': w.vsync = i === 1; break;
        case 'always_on_top': w.always_on_top = i === 1; break;

        default: this.game[row.key] = i; break;
      }
    }

    sizeIndex() {
      for (let i = 0; i < this.sizes.length; i++) {
        if (this.sizes[i][0] === this.win.width && this.sizes[i][1] === this.win.height) return i;
      }
      return -1;
    }

    clampSize() {
      if (this.sizeIndex() >= 0 || !this.sizes.length) return;
      // Nearest that still fits, rather than the first: a player on 1440p who
      // unplugs a 4K screen should land on 1440p, not on 1280x720.
      let best = this.sizes[0];
      for (const s of this.sizes) if (s[0] <= this.win.width) best = s;
      this.win.width = best[0];
      this.win.height = best[1];
    }

    /** The options a row offers, which for three of them are runtime lists. */
    optsFor(row) {
      if (row.key === 'monitor') {
        return this.monitors.map((m, i) => {
          const tag = m.primary ? ' ·' : '';
          return (i + 1) + '. ' + m.width + '×' + m.height + tag;
        });
      }
      if (row.key === 'size') return this.sizes.map((s) => s[0] + ' × ' + s[1]);
      return row.opts || [];
    }

    /** Rows that are shown but cannot be used in the current combination. */
    dimmed(row) {
      if (row.key === 'size') return this.win.mode !== 'windowed';
      // Nothing to reconstruct when the frame is already at or above native.
      if (row.key === 'upscaler') {
        const rs = S.RENDER_SCALES[this.game.resolution];
        return !rs || rs.scale >= 1;
      }
      if (row.key === 'monitor') return this.monitors.length < 2;
      return false;
    }

    // -------------------------------------------------------------- view --

    buildTabs() {
      const t = this.ui.tabs;
      t.textContent = '';
      TABS.forEach((label, i) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'tab';
        b.setAttribute('role', 'tab');
        b.textContent = label;
        b.setAttribute('aria-selected', String(i === this.tab));
        b.addEventListener('click', () => { this.tab = i; this.render(); });
        t.appendChild(b);
      });
    }

    /* REDRAWN IN PLACE, NOT RESET.
     *
     * Every row change comes back through here, because a row can enable or
     * disable another one and the only honest way to show that is to rebuild
     * the list. Rebuilding used to throw the view away with it: the list was
     * emptied, the scroll was forced to zero, and the focused arrow stopped
     * existing - so changing anything below the fold in GRAPHICS threw the
     * player back to the top of the tab and took the keyboard with it.
     *
     * The tab is the only thing that should ever move the view, so the
     * scroll position and the focused control are carried across the
     * rebuild, and the reset happens when - and only when - the tab
     * actually changed. */
    render() {
      const kids = this.ui.tabs.children;
      for (let i = 0; i < kids.length; i++) {
        kids[i].setAttribute('aria-selected', String(i === this.tab));
      }
      const host = this.ui.rows;
      const tabMoved = this._shownTab !== this.tab;
      const keepTop = tabMoved ? 0 : host.scrollTop;
      /* Which control had the keyboard, as a row key and a side, so it can
         be found again on an element that does not exist yet. */
      let keepKey = null, keepSide = null;
      const act = doc.activeElement;
      if (!tabMoved && act && host.contains(act)) {
        const owner = act.closest ? act.closest('.row') : null;
        if (owner && owner.dataset) {
          keepKey = owner.dataset.key || null;
          keepSide = act.classList && act.classList.contains('row') ? 'row'
            : (act.previousSibling ? 'inc' : 'dec');
        }
      }
      host.textContent = '';

      for (const row of S.rowsFor('launcher')) {
        if (row.tab !== this.tab) continue;
        if (row.group) {
          const h = doc.createElement('small');
          h.className = 'grp';
          h.textContent = row.group;
          host.appendChild(h);
        }
        host.appendChild(this.rowEl(row));
      }
      this.setHint('');
      this._shownTab = this.tab;
      // ...and put the view back where the player left it
      host.scrollTop = keepTop;
      if (keepKey) {
        const back = host.querySelector('.row[data-key="' + keepKey + '"]');
        if (back) {
          let target = back;
          if (keepSide === 'dec' || keepSide === 'inc') {
            const btns = back.querySelectorAll('button');
            const want = btns[keepSide === 'dec' ? 0 : 1];
            /* An arrow that has just gone disabled cannot hold focus, and
               leaving it on the body is what makes the next key press go
               nowhere. The row itself is the fallback: it advances too. */
            if (want && !want.disabled) target = want;
          }
          try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
          host.scrollTop = keepTop;
        }
      }
    }

    rowEl(row) {
      const opts = this.optsFor(row);
      const el = doc.createElement('div');
      el.className = 'row' + (this.dimmed(row) ? ' dim' : '');
      // the handle render() uses to find this row again after a rebuild
      el.dataset.key = row.key;

      const left = doc.createElement('span');
      const lbl = doc.createElement('b');
      lbl.className = 'lbl';
      lbl.textContent = row.label;
      left.appendChild(lbl);
      if (row.key === 'gpu' && !this.startedGpu === (this.win.gpu)) {
        // the renderer differs from the one this process started on
        const s = doc.createElement('i');
        s.className = 'sub';
        s.textContent = 'CHANGING THIS RESTARTS THE GAME';
        left.appendChild(s);
      }
      el.appendChild(left);

      const val = doc.createElement('span');
      val.className = 'val';
      const dec = doc.createElement('button');
      const txt = doc.createElement('b');
      const inc = doc.createElement('button');
      dec.type = inc.type = 'button';
      dec.textContent = '‹';
      inc.textContent = '›';
      dec.setAttribute('aria-label', row.label + ' previous');
      inc.setAttribute('aria-label', row.label + ' next');
      txt.className = 'txt';

      const i = Math.max(0, Math.min(this.valueOf(row), opts.length - 1));
      txt.textContent = opts[i] === undefined ? '-' : opts[i];
      if (i === 0 && /^(OFF|BILINEAR|UNCAPPED)$/.test(String(opts[0]))) el.classList.add('is-off');
      dec.disabled = i <= 0;
      inc.disabled = i >= opts.length - 1;

      const step = (d) => {
        const n = Math.max(0, Math.min(i + d, opts.length - 1));
        if (n === i) return;
        this.setValue(row, n);
        this.onChanged(row);
      };
      dec.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
      inc.addEventListener('click', (e) => { e.stopPropagation(); step(1); });
      // The row itself advances, which is what a player expects from a list
      // of two, and wraps so a toggle is never a dead click.
      el.addEventListener('click', () => {
        const n = opts.length ? (i + 1) % opts.length : 0;
        this.setValue(row, n);
        this.onChanged(row);
      });
      el.addEventListener('pointerenter', () => this.setHint(row.hint));
      el.addEventListener('focusin', () => this.setHint(row.hint));

      val.append(dec, txt, inc);
      el.appendChild(val);
      return el;
    }

    /* THE PRESET DOES NOT REWRITE THE ROWS UNDER IT, and that is deliberate.
     *
     * The obvious behaviour - a preset that stamps every switch below it - is
     * not what the game does. In js/game.js the preset and the switches
     * COMPOSE: a feature runs when the preset provides it AND the row asks for
     * it (`q.volumetric && st.volumetrics === 1`), so a row can decline
     * something the preset offers but cannot conjure one it does not.
     *
     * Rewriting the rows here would make this screen and the options screen
     * two different machines wearing the same labels, and the player would
     * discover it the first time they set a preset in one place and a switch
     * in the other. One behaviour, in one place. */
    onChanged(row) {
      this.setHint(row.hint);
      this.render();
      this.persist();
    }

    setHint(text) {
      this.ui.hint.textContent = text || '';
    }

    note(text, isError) {
      this.ui.note.textContent = text || '';
      this.ui.note.classList.toggle('err', !!isError);
    }

    fail(text) {
      this.note(text, true);
      this.ui.play.disabled = true;
    }


    /* ------------------------------------------------------- diagnostics --
     *
     * Two jobs, and the second is the one that matters.
     *
     * The first is a line under the footer saying what this machine is. It
     * costs nothing and it is the first question anyone asks about a bug
     * report, so it may as well already be on screen.
     *
     * The second is the ALERT BAND, and it is hidden unless there is something
     * to say. A launcher that always shows a diagnostics panel is a launcher
     * whose player has learned to ignore it, and the one time it carries the
     * answer it has already become furniture. It appears when a previous run
     * left a report behind - which, because the host writes one from a
     * breadcrumb, includes the case where the graphics driver took the whole
     * process down and nothing got the chance to write anything.
     */
    async loadDiagnostics() {
      if (!native) {
        this.ui.diag.textContent = 'running in a browser - no host diagnostics';
        return;
      }
      try {
        const sys = await invoke('diag_system');
        this.system = sys;
        this.ui.diag.textContent = [
          sys.os_version,
          sys.arch,
          sys.cores + ' cores',
          sys.memory,
          'webview ' + sys.webview,
          sys.graphics,
        ].filter(Boolean).join('   ·   ');
      } catch (e) {
        this.ui.diag.textContent = 'the host could not describe this machine: ' + msgOf(e);
      }

      try {
        const path = await invoke('diag_previous');
        if (path) this.showAlert('THE LAST RUN DID NOT FINISH', path,
          'SYNX wrote a report the last time it failed to start. It says what this '
          + 'machine is, how far the launch got, and what to try. If the game is '
          + 'working now you can dismiss this.');
      } catch (e) { /* nothing to report is the normal case */ }
    }

    showAlert(title, path, body) {
      this.ui.alertTitle.textContent = title;
      this.ui.alertPath.textContent = path || '';
      this.ui.alertBody.textContent = body || '';
      this.ui.alertOpen.hidden = !path;
      this.ui.alert.hidden = false;
    }

    /** Record a step in the host's in-memory trace. Writes nothing. */
    trace(line) {
      if (native) invoke('diag_note', { line: String(line) }).catch(() => {});
    }

    /* Ask the host to write a report, and put the path in front of the player.
     *
     * This is the only thing on this screen that creates a file, which is what
     * keeps a working installation from accumulating logs it will never need. */
    async report(reason, details) {
      if (!native) { this.note(reason, true); return; }
      try {
        const path = await invoke('diag_report', { reason: reason, details: details || null });
        if (path) {
          this.showAlert('SYNX COULD NOT START', path, reason);
        } else {
          this.note(reason + ' (and the report could not be written either)', true);
        }
      } catch (e) {
        this.note(reason, true);
      }
    }

    /* ------------------------------------------------------- the preflight -
     *
     * WHAT THE GAME NEEDS, CHECKED BEFORE IT IS ASKED FOR.
     *
     * Almost every "it will not start" is one of two things: the webview
     * cannot make a WebGL2 context at all, or it makes one on a software
     * rasteriser the player did not choose and the game then runs at four
     * frames a second. Both are invisible from here until the game has already
     * been handed the window.
     *
     * So a throwaway canvas is asked for a context, its vendor and renderer
     * strings are read, and the answer is recorded. This is the one place the
     * launcher touches WebGL, and it is deliberately AFTER the screen is up
     * and only on the way out - if the driver dies during it, the window the
     * player is looking at is already drawn and the host's breadcrumb names
     * the step.
     *
     * It never blocks PLAY on its own opinion. A machine that reports nothing
     * useful still gets to try; the check exists to explain a failure, not to
     * pre-empt one.
     */
    preflight() {
      const out = { webgl2: false, vendor: '', renderer: '', software: null, error: '' };
      let c = null;
      try {
        c = doc.createElement('canvas');
        c.width = c.height = 4;
        const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
        if (!gl) {
          out.error = 'this webview cannot create a WebGL2 context';
          return out;
        }
        out.webgl2 = true;
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          out.vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
          out.renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
        } else {
          out.vendor = String(gl.getParameter(gl.VENDOR) || '');
          out.renderer = String(gl.getParameter(gl.RENDERER) || '');
        }
        /* SwiftShader, llvmpipe and Direct3D's WARP are the three software
           rasterisers this game can end up on. Naming them matters: "the game
           is very slow" and "your driver refused and you are on a software
           renderer" are the same symptom and completely different fixes. */
        out.software = /swiftshader|llvmpipe|softpipe|warp|microsoft basic/i
          .test(out.vendor + ' ' + out.renderer);
        out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) {
        out.error = msgOf(e);
      } finally {
        if (c) { c.width = c.height = 0; c = null; }
      }
      return out;
    }

    // ------------------------------------------------------------- flow ---

    bind() {
      this.ui.play.addEventListener('click', () => this.play());
      this.ui.quit.addEventListener('click', () => this.quit());
      this.ui.reset.addEventListener('click', () => this.defaults());
      if (this.ui.bench) {
        this.ui.bench.addEventListener('click', () => this.benchmark());
      }
      this.ui.save.addEventListener('click', () => this.saveNow());
      this.ui.alertOpen.addEventListener('click', () => {
        if (native) invoke('diag_open').catch(() => {});
      });
      this.ui.alertDismiss.addEventListener('click', async () => {
        if (native) { try { await invoke('diag_clear'); } catch (e) { /* already gone */ } }
        this.ui.alert.hidden = true;
      });
      global.addEventListener('keydown', (e) => {
        const k = (e.key || '').toLowerCase();
        if (k === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.saveNow(); }
        else if (k === 'enter' && doc.activeElement === doc.body) { e.preventDefault(); this.play(); }
        else if (k === 'escape') { e.preventDefault(); this.quit(); }
        else if (k === 'tab') { /* the browser's own order is correct here */ }
      });
    }

    /** Write both blobs back. Debounced only by how slowly a person clicks. */
    /* WRITE BOTH BLOBS, ONE WRITE AT A TIME.
     *
     * A save is four round trips to the host - store the window answers, read
     * the whole save back, merge the game settings in, write it out - and a
     * click can arrive in the middle of any of them. Two overlapping saves
     * both read the file BEFORE either wrote it, so the second one's merge is
     * built on stale content and the first one's change is silently gone. A
     * player holding an arrow key on a volume row is exactly that case.
     *
     * So writes are chained rather than fired: each waits for the one before,
     * and a change that arrives while a write is in flight simply queues. The
     * chain is the promise itself, which is the smallest correct mutex there
     * is - there is no lock to forget to release. */
    persist() {
      this._queue = (this._queue || Promise.resolve())
        .then(() => this._write())
        .catch(() => {});
      return this._queue;
    }

    async _write() {
      if (native) {
        await invoke('launcher_store', { settings: this.win });
        const save = await invoke('save_load');
        const merged = Object.assign({}, save || {});
        merged[S.KEY] = this.game;
        const ok = await invoke('save_store', { data: merged });
        if (!ok) throw new Error('the host refused to write the save file');
        this.dirty = false;
      } else {
        global.localStorage.setItem(S.LAUNCHER_KEY, JSON.stringify(this.win));
        global.localStorage.setItem(S.KEY, JSON.stringify(this.game));
        this.dirty = false;
      }
    }

    /* The SAVE button. Everything here already saves as you change it, so this
       is not what makes a setting stick - it is what lets a player SEE that it
       has, and the one place a write failure can be reported at the moment it
       happens rather than being discovered on the next launch. */
    async saveNow() {
      this.note('SAVING...');
      try {
        await this.persist();
        this.note('Saved. These settings are what the game will start with.');
      } catch (e) {
        this.note('Could not save: ' + (e && e.message ? e.message : e), true);
      }
    }

    defaults() {
      this.game = S.defaults();
      this.win = {
        mode: 'borderless', width: 1600, height: 900, monitor: 0, gpu: true,
        always_on_top: false, vsync: true,
      };
      this.applyDefaults();
      this.render();
      this.persist();
      this.note('Everything is back to its default.');
    }

    /* PLAY: save, check, then go.
     *
     * SAVING FIRST IS NOT BELT AND BRACES. Every row already writes as it is
     * changed, but the last one may still be in flight when PLAY is pressed -
     * and `persist` returns the tail of that chain, so awaiting it here means
     * the game starts with exactly what is on screen. If that write fails,
     * this is the moment to say so: after the window has navigated there is
     * no launcher left to say it on. */
    async play() {
      if (this.busy) return;
      this.busy = true;
      this.ui.play.disabled = true;
      this.note('SAVING...');

      try {
        await this.persist();
      } catch (e) {
        this.busy = false;
        this.ui.play.disabled = false;
        await this.report('Your settings could not be saved, so the game was not started: '
          + msgOf(e), { stage: 'save', settings: this.win });
        return;
      }

      if (!native) {
        this.note('No desktop host here - this page is running in a browser, so there is no window to build. Open index.html to play.', true);
        this.busy = false;
        this.ui.play.disabled = false;
        return;
      }

      /* The graphics check. Recorded either way, and only ever a REASON for a
         failure rather than a veto on trying - a machine that reports nothing
         useful still gets to play. */
      this.note('CHECKING GRAPHICS...');
      const pre = this.preflight();
      this.trace('preflight: ' + JSON.stringify(pre));

      if (!pre.webgl2) {
        this.busy = false;
        this.ui.play.disabled = false;
        await this.report(
          'This webview cannot create a 3D context, so the game has nothing to draw with. '
          + (this.win.gpu
            ? 'Set RENDERER to SOFTWARE on the DISPLAY page and try again - it is slow, and it works.'
            : 'It is already on SOFTWARE, which means the webview itself is not able to render. '
              + 'The report says what is installed.'),
          { stage: 'preflight', preflight: pre, settings: this.win });
        return;
      }
      if (pre.software && this.win.gpu) {
        /* Not a failure: it will run. But it will run at a few frames a second
           and the player deserves to know that is what is happening rather
           than concluding the game is broken. */
        this.note('Running on a software renderer (' + (pre.renderer || 'unknown')
          + ') - expect very low frame rates.', true);
      }

      this.note('STARTING...');
      this.trace('launching with ' + JSON.stringify(this.win));
      try {
        // A renderer change relaunches the process, so this call may never
        // return; that is a success, not a hang.
        await invoke('launch_game', { settings: this.win });
      } catch (e) {
        this.busy = false;
        this.ui.play.disabled = false;
        await this.report('The game window could not be opened: ' + msgOf(e),
          { stage: 'launch', preflight: pre, settings: this.win });
      }
    }

    /* THE BENCHMARK, WHICH IS A MEASUREMENT RATHER THAN A RECOMMENDATION.
     *
     * There are eleven graphics rows on this screen and a preset above them.
     * Nobody who has not read the renderer knows what ambient occlusion costs
     * on their own card, and the honest answer to "which of these should I
     * use" is not an opinion - it is a number, measured on this machine, with
     * this game, at this resolution.
     *
     * So this hands over to the game, which runs a fixed pass at each preset
     * and writes down what it actually held - see js/bench.js. The result is
     * picked up and applied the next time this screen opens.
     */
    async benchmark() {
      if (this.busy) return;
      this.note("BENCHMARKING - the game will run a short pass at each preset.");
      try {
        await this.writeBench({ pending: true, when: Date.now() });
      } catch (e) {
        this.note("Could not ask for a benchmark: " + msgOf(e), true);
        return;
      }
      this.play();
    }

    /** The benchmark record, which lives beside the settings in the save. */
    async writeBench(v) {
      if (native) {
        const save = await invoke("save_load");
        const merged = Object.assign({}, save || {});
        merged[S.BENCH_KEY] = v;
        await invoke("save_store", { data: merged });
      } else {
        global.localStorage.setItem(S.BENCH_KEY, JSON.stringify(v));
      }
    }

    /** ...and reading it back, from wherever this screen is running. */
    async readBench() {
      try {
        /* EITHER SHAPE. This screen writes the record as an object through
           save_store; the GAME writes it back through Save.setJSON, which
           stores a JSON string. Both are legitimate entries in the same save
           and this is the one place that has to read both - a reader that
           assumes the object silently ignores every result the benchmark ever
           produced, which is the interesting half of the record. */
        const parse = (v) => {
          if (!v) return null;
          if (typeof v === "object") return v;
          try { return JSON.parse(v); } catch (e) { return null; }
        };
        if (native) {
          const save = await invoke("save_load");
          return parse(save && save[S.BENCH_KEY]);
        }
        return parse(global.localStorage.getItem(S.BENCH_KEY));
      } catch (e) { return null; }
    }

    /* WHAT THE LAST BENCHMARK FOUND, APPLIED.
     *
     * Applied once and then marked, because a measurement that re-applies
     * itself on every open is a screen that will not let the player change
     * their mind - and the point of measuring is to give them somewhere to
     * start, not to take the choice away. */
    applyBench(rec) {
      const LADDER = ["LOW", "MEDIUM", "HIGH", "ULTRA"];
      if (!rec || !rec.results || !rec.results.length || rec.applied) return false;
      const idx = LADDER.indexOf(rec.preset);
      if (idx < 0) return false;
      this.game.quality = idx;
      let at = null;
      for (const r of rec.results) if (r.preset === rec.preset) at = r;
      const fps = at ? Math.round(at.fps) + " fps at the 95th percentile" : "measured";
      const held = rec.held ? "" : ", which is the best this machine held";
      this.note("BENCHMARK: " + rec.preset + " - " + fps + held + ". Applied.");
      rec.applied = true;
      this.writeBench(rec).catch(() => {});
      this.persist();
      return true;
    }

    quit() {
      if (native) invoke('quit_app').catch(() => {});
      else global.close();
    }
  }

  const app = new Launcher();
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', () => app.boot());
  } else {
    app.boot();
  }
  // what the smoke harness asserts against
  global.__SYNX_LAUNCHER__ = app;
})(window);
