/* SYNX FREE ROAM — the open route
 *
 * The campaign is a series of chapters, and a chapter is a route cut to the
 * length of a story beat. This is the screen in front of the other thing the
 * course has always been able to do and has never been asked for: ONE drive,
 * from the seawall at arc length 60 to the last gantry at 173,000, straight
 * through all seven regions without a loading screen between any of them.
 *
 * The run itself lives in js/game.js - enterFreeRoam() and the handful of
 * methods under it, which own the region handover and the palette blend that
 * makes the seams invisible. This file owns three things and nothing else:
 *
 *   the screen        a route picker built out of the same cut-corner panels,
 *                     corner ticks and Orbitron the Story hub is built from,
 *                     so it reads as another room in the same building
 *   the region art    each tile is painted from the route's OWN palette, read
 *                     out of Game.levels and tonemapped the way the renderer
 *                     tonemaps it, so a tile is a swatch of the place rather
 *                     than a stock image of one
 *   the exclusivity   while the screen is up the game is not driving, so this
 *                     wraps update() and flies the idle camera instead, the
 *                     same way js/story.js does for the hub
 */
(function (global) {
  'use strict';

  const NR = global.NR;
  if (!NR || !NR.Game || NR.FreeRoamUi) return;

  const doc = global.document;
  const PREF_KEY = 'synx.freeroam.pref.v1';
  const UNITS_TO_KM = 0.000733;

  /* Who else is out there. A tour is an open route by default - the point of
     the mode is the road, not a duel - but the campaign's Driver is right
     here, so asking for one costs nothing and gives the drive a shape. */
  const OPPONENTS = [
    { diff: -1, label: 'NONE', note: 'OPEN ROUTE // NOBODY ELSE OUT THERE' },
    { diff: 0, label: 'RIVAL // EASY', note: 'A CAR TO FOLLOW' },
    { diff: 1, label: 'RIVAL // MEDIUM', note: 'A CAR TO CHASE' },
    { diff: 2, label: 'RIVAL // HARD', note: 'A CAR THAT KNOWS THE LINE' },
    /* The car Ryker finished the campaign in, on the road he finished it on.
       Same profile as Chapter 7's R-IX - no assist, no mistakes, and a driver
       that means to be up the road rather than beside you. */
    { diff: 3, label: 'R-IX // IMPOSSIBLE', note: 'THE ONE THAT HUNTED YOU' },
  ];

  /* One line per region, saying what the country is. The route names are the
     game's own and come out of Game.levels; this is the part a name cannot
     carry. Kept to two short clauses because a tile is 250 pixels wide and a
     third line pushes the distance off the bottom of it. */
  const REGION_NOTE = [
    'SEAWALL NEON // COAST AT DUSK',
    'FREIGHT RAMPS // CANYON TUNNELS',
    'MESA TERRACES // OPEN SKY',
    'MIDNIGHT CITY // WET TARMAC',
    'DEAD DISTRICT // ASH AND LAVA',
    'CLOSED COURSE // PRODUCTION HALL',
    'ELEVATED DECK // MEGACITY SPAN',
  ];

  function readPref() {
    try {
      const v = parseInt(global.NR.Save.get(PREF_KEY), 10);
      if (v >= 0 && v < OPPONENTS.length) return v;
    } catch (e) { /* private mode */ }
    return 0;
  }
  function writePref(v) {
    try { global.NR.Save.set(PREF_KEY, String(v)); }
    catch (e) { /* private mode */ }
  }

  function fmtTime(t) {
    if (t == null || !isFinite(t)) return '--:--';
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  /* A palette colour, as CSS.
   *
   * The palettes in js/game.js are linear HDR emissives: several channels sit
   * above 1 and the whole set is written to be bloomed, not to be read. A
   * Reinhard shoulder over all three channels is the honest tonemap and it is
   * the wrong tool here - it desaturates everything toward the same pastel,
   * which is how seven very different routes came out as seven mauve tiles.
   *
   * So the brightest channel is normalised to 1 and the HUE is kept: exposure
   * is thrown away, the colour is not, and a lighter gamma than the display's
   * keeps it as saturated on the tile as the neon is in the frame. */
  function css(c, gain) {
    if (!c) return 'rgb(96,84,150)';
    const g = gain === undefined ? 1 : gain;
    const peak = Math.max(0.001, c[0], c[1], c[2]);
    const ch = (v) => Math.round(255 * Math.min(1,
      Math.pow(Math.max(0, v) / peak, 1 / 1.5) * g));
    return 'rgb(' + ch(c[0]) + ',' + ch(c[1]) + ',' + ch(c[2]) + ')';
  }

  class FreeRoamUi {
    constructor(game) {
      this.g = game;
      this.shown = false;
      this.from = 'menu';
      this.opponent = readPref();
      this.ui = this.bindDom();
      if (this.ui.root) {
        global.addEventListener('keydown', (e) => this.onKey(e), true);
      }
      /* The footer's BACK control, for everyone not holding a keyboard. Its
         label is set in build(), because where it goes depends on where the
         screen was opened from. */
      if (this.ui.back) this.ui.back.addEventListener('click', () => this.back());
    }

    bindDom() {
      const id = (n) => doc.getElementById(n);
      return {
        root: id('freeRoamRoot'), panel: id('freeRoam'),
        status: id('freeRoamStatus'), length: id('freeRoamLength'),
        count: id('freeRoamCount'), best: id('freeRoamBest'),
        routes: id('freeRoamRoutes'), actions: id('freeRoamActions'),
        back: id('freeRoamBack'),
      };
    }

    /* While the screen is up the game is not driving. js/game.js's update()
       reads the arrow keys for its own title menu and would fight the panel
       for them, so the whole tick is replaced rather than filtered - which is
       exactly what js/story.js does for the Story hub. */
    isExclusive() { return this.shown; }

    // ------------------------------------------------------------ flow ----

    open(from) {
      const g = this.g;
      if (!this.ui.root) return false;
      /* THE GATE, ENFORCED WHERE IT MATTERS.
         js/modeselect.js draws the lock and refuses the card, which is where a
         player meets it. This is the same rule at the door itself, so nothing
         that gets a reference to this screen can walk past it. */
      if (NR.campaignComplete && !NR.campaignComplete()) {
        g.audio.crash(0.2);
        return false;
      }
      this.from = from === 'modes' ? 'modes' : 'menu';
      /* The Story hub owns the DOM it put up; asking it to stand down is the
         only correct way to take the screen off it. */
      if (g.story && g.story.mode !== 'none') g.story.onMainMenu();
      /* A tour that was abandoned through the pause menu leaves the renderer
         on whichever region it died in. Put it back before painting a screen
         that flies the idle camera over it. */
      g.exitFreeRoam();
      this.shown = true;
      g.state = 'freeroam';
      g.cursorHiddenForRun = false;
      g.syncCursorVisibility();
      g.storyHideRival = true;         // empty road behind the panel
      g.fadeTo(0);
      this.ui.root.setAttribute('aria-hidden', 'false');
      doc.body.classList.add('freeroam-open');
      this.build();
      g.audio.playTrack('menu');
      return true;
    }

    close() {
      this.shown = false;
      if (this.ui.root) this.ui.root.setAttribute('aria-hidden', 'true');
      doc.body.classList.remove('freeroam-open');
    }

    /** Back to wherever this screen was opened from. */
    back() {
      const g = this.g;
      g.audio.uiMove();
      this.close();
      if (this.from === 'modes' && g.modeSelect) {
        g.modeSelect.open();
        return;
      }
      g.storyHideRival = false;
      g.toMenu();
    }

    /* Take the tour, starting on region `i`.
     *
     * A tour prebuilds Aurora Forge's hall and Neon Horizon's megacity so that
     * neither of them lands as a stutter in the middle of a hundred and
     * twenty-seven kilometres. That is a second or two of geometry, and it is
     * synchronous, so the frame it happens on never gets painted: pressed
     * without warning, DRIVE looks like it hung. The tile is marked taken and
     * given two frames to actually reach the screen before the freeze starts,
     * which turns a hang into a wait. */
    drive(i, tile) {
      const g = this.g;
      if (this.starting) return;
      this.starting = true;
      g.audio.select();
      const state = tile && tile.querySelector('u');
      if (state) state.textContent = 'BUILDING THE ROAD…';
      if (tile) tile.classList.add('is-starting');
      const go = () => {
        this.starting = false;
        this.close();
        g.enterFreeRoam({ region: i, rival: OPPONENTS[this.opponent].diff });
      };
      /* Whichever comes first. A tab that is not being composited - or a
         harness with a stub for a frame callback - never gets a rAF, and a
         DRIVE that silently does nothing is worse than one that skips the
         courtesy frame. */
      let fired = false;
      const once = () => { if (!fired) { fired = true; go(); } };
      if (global.requestAnimationFrame) {
        global.requestAnimationFrame(() => global.requestAnimationFrame(once));
      }
      global.setTimeout(once, 140);
    }

    cycleOpponent(step) {
      const n = OPPONENTS.length;
      this.opponent = (this.opponent + (step || 1) + n) % n;
      writePref(this.opponent);
      this.g.audio.uiMove();
      this.build(true);
    }


    /* THE POINTER, ASKED DIRECTLY.
     *
     * pointerenter/pointerleave only fire when the pointer CROSSES a border.
     * These panels are built underneath a cursor that is already sitting
     * still - the player clicked START and did not move the mouse - so the
     * card under it never receives an enter and never lights up, and the
     * browser's own :hover is stale for the same reason. Moving the mouse out
     * and back in fixes it, which is exactly the "click the gap between the
     * cards and then it works" this replaces.
     *
     * So the highlight is not bookkept from crossings at all: every pointer
     * move asks what is under the pointer and sets one class from the answer.
     * It is idempotent, it cannot get out of step, and it is one listener
     * rather than four per card. */
    bindHover(root, selector) {
      if (!root || root.__synxHover) return;
      root.__synxHover = true;
      const sync = (e) => {
        if (!this.shown) return;
      /* ...and a committing key shuts the gate behind itself, now that this
         screen has established the key is for it. Moving between screens is
         covered by the state change; this is what stops a held ENTER
         skipping four lines of a cutscene in a third of a second. Arrows and
         TAB are deliberately not here: they move a selection rather than
         commit to it, and holding one is how a long list gets read. */
      if (NR.Gate && /^(enter| |escape|backspace)$/i.test(e.key)) NR.Gate.lock();
        const over = e && e.target && e.target.closest ? e.target.closest(selector) : null;
        const cards = root.querySelectorAll(selector);
        for (let i = 0; i < cards.length; i++) {
          const c = cards[i];
          const on = c === over && !c.classList.contains('locked');
          c.classList.toggle('is-hover', on);
        }
      };
      root.addEventListener('pointermove', sync);
      root.addEventListener('pointerdown', sync);
      root.addEventListener('pointerleave', () => {
        const cards = root.querySelectorAll(selector);
        for (let i = 0; i < cards.length; i++) cards[i].classList.remove('is-hover');
      });
    }

    // ------------------------------------------------------------- ui -----

    /** Rebuild the panel. `keepFocus` restores the row that was under it. */
    build(keepFocus) {
      const g = this.g;
      const levels = g.levels || [];
      const edges = g.regionEdges || levels.map(l => l.from);
      const end = g.freeRoamEnd === undefined ? (levels.length ? levels[levels.length - 1].to : 0) : g.freeRoamEnd;
      const start = levels.length ? levels[0].from : 0;
      const focusId = keepFocus && doc.activeElement ? doc.activeElement.getAttribute('data-fr') : null;
      const km = (u) => (Math.max(0, u) * UNITS_TO_KM).toFixed(1);

      let best = null;
      try {
        const v = parseFloat(global.NR.Save.get('synx.freeroam.record.v1'));
        if (isFinite(v)) best = v;
      } catch (e) { /* private mode */ }

      if (this.ui.length) this.ui.length.textContent = km(end - start) + ' KM';
      if (this.ui.count) this.ui.count.textContent = String(levels.length);
      if (this.ui.best) this.ui.best.textContent = fmtTime(best);
      if (this.ui.status) {
        this.ui.status.textContent =
          'Every route in the game is one road. Free Roam drives it end to end - '
          + levels.length + ' regions, ' + km(end - start)
          + ' kilometres, no chapter, no cutscene, and no seam where one route becomes the next. '
          + 'Start at the seawall for the full tour, or get on wherever you like; a run always ends at the horizon.';
      }

      /* ---------------------------------------------------------- routes -- */
      const list = this.ui.routes;
      if (!list) return;
      list.textContent = '';

      const tile = (opts) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'freeroam-route synx-cut' + (opts.tour ? ' freeroam-tour' : '');
        b.setAttribute('data-fr', opts.key);
        const art = doc.createElement('i');
        art.className = 'freeroam-art';
        art.style.setProperty('--r1', opts.c1);
        art.style.setProperty('--r2', opts.c2);
        art.style.setProperty('--r3', opts.c3);
        const kicker = doc.createElement('small');
        const title = doc.createElement('b');
        const note = doc.createElement('span');
        const state = doc.createElement('u');
        kicker.textContent = opts.kicker;
        title.textContent = opts.title;
        note.textContent = opts.note;
        state.textContent = opts.state;
        b.append(art, kicker, title, note, state);
        b.addEventListener('focus', () => b.classList.add('is-highlighted'));
        b.addEventListener('blur', () => b.classList.remove('is-highlighted'));
        b.addEventListener('click', () => opts.act(b));
        list.appendChild(b);
        return b;
      };

      /* The tour itself, across the top and full width, because it is the
         mode and the seven below it are ways into the middle of it. */
      const first = levels[0] && levels[0].palette;
      const last = levels[levels.length - 1] && levels[levels.length - 1].palette;
      tile({
        key: 'tour', tour: true,
        c1: css(first && first.sign), c2: css(last && last.cap, 0.9),
        c3: css(last && last.grid),
        kicker: 'THE WHOLE ROAD',
        title: 'GRAND TOUR',
        note: 'SEAWALL TO HORIZON  //  ALL ' + levels.length + ' REGIONS, END TO END',
        state: km(end - start) + ' KM  ·  ' + OPPONENTS[this.opponent].label,
        act: (b) => this.drive(0, b),
      });

      for (let i = 0; i < levels.length; i++) {
        const L = levels[i];
        const p = L.palette || {};
        /* Where this leg starts is the route's own line; where it ENDS is the
           next handover, which for the last one is the finish. */
        const leg = (i + 1 < edges.length ? edges[i + 1] : end) - L.from;
        tile({
          key: 'r' + i,
          /* The horizon glow, the sky and the grid, in that order. Ashfall
             takes its lava for the glow rather than its road sign: the basin
             is the one thing on that route nothing else in the game looks
             like, and a blue-white sign would have made it Sunset Zero. */
          c1: css(p.lava || p.sign), c2: css(p.cap, 0.92), c3: css(p.grid),
          kicker: 'REGION ' + String(i + 1).padStart(2, '0'),
          title: L.name,
          note: REGION_NOTE[i] || '',
          state: 'LEG ' + km(leg) + ' KM  ·  ' + (i === 0
            ? 'START OF THE ROAD'
            : km(end - L.from) + ' KM TO THE HORIZON'),
          act: (b) => this.drive(i, b),
        });
      }

      /* --------------------------------------------------------- actions -- */
      const acts = this.ui.actions;
      if (!acts) return;
      acts.textContent = '';
      const action = (key, small, label, fn, cls) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'story-action synx-cut' + (cls ? ' ' + cls : '');
        b.setAttribute('data-fr', key);
        const s = doc.createElement('small');
        const t = doc.createElement('b');
        s.textContent = small;
        t.textContent = label;
        b.append(s, t);
        b.addEventListener('click', fn);
        acts.appendChild(b);
        return b;
      };
      /* RESUME, WHEN THERE IS SOMETHING TO RESUME.
         The autosave writes a tour every twelve seconds and at every border;
         without a way back into it that file is a file nobody ever opens. It
         is the first action and it says where and when, because "RESUME" on
         its own does not tell the player whether it is worth taking. */
      const saved = global.NR.Autosave && global.NR.Autosave.read();
      if (saved && saved.freeRoam) {
        const km = ((saved.s - 60) * 0.000733).toFixed(1);
        const mins = Math.max(1, Math.round((Date.now() - (saved.at || 0)) / 60000));
        const when = mins < 60 ? mins + ' MIN AGO'
          : Math.round(mins / 60) + ' HR AGO';
        action('resume', km + ' KM IN  ·  ' + when,
          'RESUME TOUR  //  ' + (saved.name || ''), () => {
            this.close();
            this.g.resumeFreeRoam(saved);
          }, 'primary');
      }
      const group = (label) => {
        const h = doc.createElement('small');
        h.className = 'mp-group';
        h.textContent = label;
        acts.appendChild(h);
      };

      group('THE DRIVE');
      const opp = OPPONENTS[this.opponent];
      action('opponent', opp.note, 'OPPONENT: ' + opp.label,
        () => this.cycleOpponent(1), saved && saved.freeRoam ? '' : 'primary');
      group('ELSEWHERE');
      action('controls', 'TUNE THE LINK', 'CONTROLS', () => {
        this.close();
        this.g.storyHideRival = false;
        this.g.toMenu();
        this.g.state = 'controls';
        this.g.controlIndex = 0;
      });
      action('back', this.from === 'modes' ? 'BACK TO MODE SELECT' : 'BACK TO TITLE',
        this.from === 'modes' ? 'SELECT MODE' : 'MAIN MENU', () => this.back());

      /* The footer said "ESC BACK" while the button beside it named an actual
         destination - two labels for one key, only one of which answered the
         question. */
      if (this.ui.back) {
        const b = this.ui.back.querySelector('b');
        if (b) b.textContent = this.from === 'modes' ? 'MODE SELECT' : 'MAIN MENU';
      }
      const hints = doc.getElementById('freeRoamHints');
      if (hints) {
        hints.textContent = '';
        const rows = [
          ['ARROWS', 'SELECT'],
          ['ENTER', 'DRIVE'],
          ['ESC', this.from === 'modes' ? 'MODE SELECT' : 'MAIN MENU'],
        ];
        for (const [k, what] of rows) {
          const sp = doc.createElement('span');
          const b = doc.createElement('b');
          b.textContent = k;
          sp.append(b, ' ' + what);
          hints.appendChild(sp);
        }
      }

      /* Does this list actually overflow? Only then is the scroll affordance
         wanted - see the note by #freeRoamRoutes.is-scroll. Measured after a
         frame, because the tiles have just been appended and the browser has
         not laid them out yet. */
      const syncScroll = () => {
        if (!list.isConnected) return;
        list.classList.toggle('is-scroll', list.scrollHeight - list.clientHeight > 4);
      };
      global.setTimeout(syncScroll, 0);
      if (!list.__synxScrollBound) {
        list.__synxScrollBound = true;
        global.addEventListener('resize', syncScroll);
      }

      this.bindHover(list, '.freeroam-route');
      this.bindHover(acts, '.story-action');
      const restore = focusId && list.parentNode
        ? this.ui.panel.querySelector('[data-fr="' + focusId + '"]') : null;
      const target = restore || list.firstChild;
      if (target) global.setTimeout(() => target.focus(), 0);
    }

    // ---------------------------------------------------------- input -----

    buttons() {
      return this.ui.panel ? Array.from(this.ui.panel.querySelectorAll('button')) : [];
    }

    /* Arrows walk the tiles the way the eye expects rather than in DOM order:
       the nearest button in the direction asked for, ties broken by how far it
       sits off the axis. Lifted from the Story hub deliberately - two grids of
       cut-corner tiles in the same build should not navigate differently. */
    move(dx, dy) {
      const buttons = this.buttons();
      if (!buttons.length) return;
      const cur = buttons.indexOf(doc.activeElement);
      if (cur < 0) { buttons[0].focus(); return; }
      const a = buttons[cur].getBoundingClientRect();
      const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
      let best = null, bestScore = Infinity;
      for (const b of buttons) {
        if (b === buttons[cur]) continue;
        const r = b.getBoundingClientRect();
        const bx = r.left + r.width / 2, by = r.top + r.height / 2;
        const along = (bx - ax) * dx + (by - ay) * dy;
        if (along <= 6) continue;
        const off = Math.abs((bx - ax) * dy - (by - ay) * dx);
        const score = along + off * 2.4;
        if (score < bestScore) { bestScore = score; best = b; }
      }
      if (!best) best = buttons[(cur + (dx + dy > 0 ? 1 : buttons.length - 1)) % buttons.length];
      best.focus();
      this.g.audio.uiMove();
    }

    onKey(e) {

      /* A press that arrived within a moment of this screen opening was

         meant for the screen before it. See NR.Gate in js/ui.js: without

         this, two quick taps on ENTER walk through three screens. */

      if (NR.Gate && !NR.Gate.open()) return;
      if (!this.shown) return;
      const k = e.key.toLowerCase();
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      const active = doc.activeElement;
      if (k === 'arrowright') { stop(); this.move(1, 0); }
      else if (k === 'arrowleft') { stop(); this.move(-1, 0); }
      else if (k === 'arrowdown') { stop(); this.move(0, 1); }
      else if (k === 'arrowup') { stop(); this.move(0, -1); }
      else if (k === 'tab') {
        stop();
        const b = this.buttons();
        const i = Math.max(0, b.indexOf(active));
        const n = b[(i + (e.shiftKey ? b.length - 1 : 1)) % b.length];
        if (n) { n.focus(); this.g.audio.uiMove(); }
      } else if (k === 'enter' || k === ' ') {
        stop();
        if (active && active.tagName === 'BUTTON') active.click();
      } else if (k === 'escape' || k === 'backspace') { stop(); this.back(); }
    }

    /* One frame with the panel up. The camera keeps flying down the road
       behind it, so the screen is a window onto the thing it is offering. */
    tick(dt) {
      const g = this.g;
      g.time += dt;
      g.scene.time = g.time;
      g.fade += (g.fadeTarget - g.fade) * Math.min(1, dt * 3);
      g.idleFlyby(dt);
      g.audio.update(g.car, dt, false);
    }
  }

  NR.FreeRoamUi = FreeRoamUi;
  /* js/modeselect.js paints its FREE ROAM card out of the same two palettes;
     one tonemap, used in both places. */
  NR.freeRoamSwatch = css;

  const GP = NR.Game.prototype;

  const oldLoad = GP.load;
  GP.load = async function () {
    await oldLoad.call(this);
    if (!this.freeRoamUi) this.freeRoamUi = new FreeRoamUi(this);
  };

  const oldUpdate = GP.update;
  GP.update = function (dt) {
    if (this.freeRoamUi && this.freeRoamUi.isExclusive()) {
      this.freeRoamUi.tick(dt);
      return;
    }
    oldUpdate.call(this, dt);
  };

  /* What the harnesses assert against, in the shape the other chapters
     publish theirs. */
  global.__SYNX_FREEROAM__ = {
    name: 'FREE ROAM',
    prefKey: PREF_KEY,
    recordKey: 'synx.freeroam.record.v1',
    opponents: OPPONENTS.map(o => o.label),
    regionNotes: REGION_NOTE,
  };
})(window);
