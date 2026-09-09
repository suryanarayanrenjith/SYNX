/* SYNX DRIVER TERMINAL — the door behind START
 *
 * The title screen used to hand START straight to the campaign, and Free Roam
 * had to be reached from somewhere: first as a third row on the title, then as
 * an eighth tile in the Story hub. Both were the same mistake in two places -
 * a mode advertised from inside another mode.
 *
 * So START is a door now, and this is what is behind it: three cards, one
 * decision. STORY MODE, which reads the save and offers to start, continue or
 * replay it; MULTIPLAYER, which is four cars on any of the seven routes over a
 * link to the grid; and FREE ROAM, which is LOCKED until the campaign is
 * finished, because the open road is what finishing it is for.
 *
 * MULTIPLAYER is deliberately NOT gated. The campaign is a story and finishing
 * it is what earns the open road; racing somebody else is not a reward, it is
 * a mode, and locking it behind seven chapters would mean two people who
 * bought the game on the same day could not race each other until one of them
 * had finished it.
 *
 * The gate is read off the story save through NR.campaignComplete() rather
 * than off a StoryManager, because this screen is painted before a chapter has
 * ever been entered - and because a save is the only thing that actually
 * remembers.
 */
(function (global) {
  'use strict';

  const NR = global.NR;
  if (!NR || !NR.Game || NR.ModeSelect) return;

  const doc = global.document;
  const UNITS_TO_KM = 0.000733;

  /* No campaign on the page at all - a capture harness, say - is not the same
     thing as an unfinished one. There is nothing to finish, so nothing is
     gated. */
  function campaignComplete() {
    return NR.campaignComplete ? !!NR.campaignComplete() : true;
  }

  function chaptersCleared() {
    try {
      const raw = global.NR.Save.getJSON('synx.story.v2', null);
      if (raw && Array.isArray(raw.completedChapters)) {
        return new Set(raw.completedChapters.map(Number)).size;
      }
    } catch (e) { /* private mode, or no save yet */ }
    return 0;
  }

  const RATINGS = ['UNRANKED', 'ROOKIE', 'STREET', 'VECTOR', 'CIRCUIT',
    'GRID ELITE', 'APEX', 'HORIZON'];

  class ModeSelect {
    constructor(game) {
      this.g = game;
      this.shown = false;
      this.ui = this.bindDom();
      if (this.ui.root) {
        global.addEventListener('keydown', (e) => this.onKey(e), true);
      }
      /* The footer's BACK control. ESC still does it; this is the same thing
         for everyone who is not holding a keyboard, and it is bound once here
         rather than rebuilt with the cards because it never changes. */
      if (this.ui.back) this.ui.back.addEventListener('click', () => this.back());
    }

    bindDom() {
      const id = (n) => doc.getElementById(n);
      return {
        root: id('modeSelectRoot'), panel: id('modeSelect'),
        status: id('modeStatus'), rating: id('modeRating'),
        cleared: id('modeCleared'), open: id('modeOpen'),
        cards: id('modeCards'), back: id('modeBack'),
      };
    }

    /* The title menu reads the arrow keys for its own rows, so the terminal
       takes the whole tick rather than filtering it - the same arrangement
       js/story.js has for the hub. */
    isExclusive() { return this.shown; }

    // ------------------------------------------------------------ flow ----

    open() {
      const g = this.g;
      /* Without the markup there is no terminal, and START has to keep
         working: it goes where it always went. */
      if (!this.ui.root || !this.ui.cards) {
        if (g.story) g.story.enterStory();
        return;
      }
      if (g.story && g.story.mode !== 'none') g.story.onMainMenu();
      g.exitFreeRoam();
      this.shown = true;
      g.state = 'modeselect';
      g.cursorHiddenForRun = false;
      g.syncCursorVisibility();
      g.storyHideRival = true;
      g.fadeTo(0);
      this.ui.root.setAttribute('aria-hidden', 'false');
      doc.body.classList.add('modeselect-open');
      this.build();
      g.audio.playTrack('menu');
      // ...and the line under the title arrives a character at a time
      if (NR.UI && this.ui.status) NR.UI.type(this.ui.status, this.ui.status.textContent);
    }

    close() {
      this.shown = false;
      if (this.ui.root) this.ui.root.setAttribute('aria-hidden', 'true');
      doc.body.classList.remove('modeselect-open');
    }

    /** ESC, and the card that says so. Back to the title screen. */
    back() {
      this.g.audio.uiMove();
      this.close();
      this.g.storyHideRival = false;
      this.g.toMenu();
    }

    chooseStory() {
      const g = this.g;
      g.audio.select();
      this.close();
      if (g.story) g.story.enterStory();
      else g.toMenu();
    }

    /* THE GRID, WOKEN EARLY.
     *
     * A server that has been idle takes a moment to come back, and the worst
     * place to spend that moment is after the player has committed. So the
     * request goes out the moment this card is so much as LOOKED at - focused,
     * hovered, or arrowed onto - and by the time they have read it, pressed
     * it, typed a name and picked a route, the link is usually already up.
     *
     * It is idempotent and rate limited inside NR.Net, so a player who sweeps
     * the mouse across all three cards sends one request, not thirty. */
    warmGrid() {
      if (!NR.Net || this._warmed) return;
      this._warmed = true;
      NR.Net.wake(() => {}).catch(() => { /* the lobby says so properly */ });
    }

    chooseMultiplayer() {
      const g = this.g;
      g.audio.select();
      this.close();
      if (g.multiplayer) g.multiplayer.open('modes');
      else g.toMenu();
    }

    chooseFreeRoam(card) {
      const g = this.g;
      if (!campaignComplete()) {
        /* Refused, and it says why rather than doing nothing. */
        g.audio.crash(0.2);
        if (card) {
          card.classList.remove('shake');
          void card.offsetWidth;
          card.classList.add('shake');
        }
        return;
      }
      g.audio.select();
      this.close();
      if (g.freeRoamUi) g.freeRoamUi.open('modes');
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
      if (!root) return;
      /* WHERE THE POINTER IS, NOT WHERE IT LAST CROSSED SOMETHING.
       *
       * The previous version asked `e.target` on a pointermove over the CARD
       * CONTAINER, which fixed the stale-:hover half of this and left the
       * other half exactly as broken: a panel built underneath a cursor that
       * is already sitting still receives no move, so the card under it stays
       * dark until the player moves the mouse off it and back - or clicks
       * somewhere else first, which is how it was reported.
       *
       * The pointer's position is therefore tracked on the DOCUMENT, all the
       * time, and the hover is recomputed from `elementFromPoint` - which does
       * not care whether anything was crossed. That makes `resync` callable
       * from anywhere, and the important caller is the one that runs the
       * moment the panel is shown. */
      root.__synxSel = selector;
      if (!this.constructor.__ptr) {
        const P = this.constructor.__ptr = { x: -1, y: -1 };
        const track = (e) => { P.x = e.clientX; P.y = e.clientY; };
        doc.addEventListener('pointermove', track, true);
        doc.addEventListener('pointerdown', track, true);
      }
      if (root.__synxHover) return;
      root.__synxHover = true;
      const resync = () => {
        const P = this.constructor.__ptr;
        const cards = root.querySelectorAll(root.__synxSel);
        let over = null;
        if (this.shown && P.x >= 0) {
          const el = doc.elementFromPoint(P.x, P.y);
          over = el && el.closest ? el.closest(root.__synxSel) : null;
        }
        for (let i = 0; i < cards.length; i++) {
          const c = cards[i];
          c.classList.toggle('is-hover', c === over && !c.classList.contains('locked'));
        }
      };
      root.__synxResync = resync;
      doc.addEventListener('pointermove', resync, true);
      doc.addEventListener('pointerdown', resync, true);
      root.addEventListener('pointerleave', resync);
    }

    /* Recompute every hover from where the pointer actually is. Called after
       the cards are built and again on the frame the panel becomes visible,
       because both of those change what is under a cursor that has not
       moved. */
    resyncHover() {
      const r = this.ui.cards;
      if (r && r.__synxResync) r.__synxResync();
    }

    // ------------------------------------------------------------- ui -----

    build() {
      const g = this.g;
      const done = chaptersCleared();
      const last = NR.STORY_LAST_CHAPTER || 7;
      const unlocked = campaignComplete();
      const chapters = NR.STORY_CHAPTERS;
      const save = g.storySave;
      const current = save ? Math.min(last, Math.max(1, save.currentChapter | 0)) : 1;
      const started = !!(save && (save.hasSeenPrologue || done > 0));

      if (this.ui.rating) this.ui.rating.textContent = RATINGS[Math.min(done, RATINGS.length - 1)];
      if (this.ui.cleared) this.ui.cleared.textContent = done + ' / ' + last;
      if (this.ui.open) {
        this.ui.open.textContent = unlocked ? 'OPEN' : 'LOCKED';
        this.ui.open.classList.toggle('is-locked', !unlocked);
      }
      if (this.ui.status) {
        this.ui.status.textContent = unlocked
          ? 'The campaign is behind you and the whole road is open. Drive the story again for the chapters, or take the open route and drive all seven regions end to end.'
          : 'Seven chapters, one rival at a time. The open route unlocks when the last of them is behind you — everything between the seawall and the horizon, in one unbroken run.';
      }

      const cards = this.ui.cards;
      cards.textContent = '';
      /* The open-route card paints itself from the routes' own palettes, and
         the multiplayer card counts them for its subtitle, so both are read
         once here. */
      const swatchOf = NR.freeRoamSwatch;
      const levelsOf = g.levels || [];

      const card = (opts) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'mode-card synx-cut' + (opts.locked ? ' locked' : '')
          + (opts.primary ? ' primary' : '');
        b.setAttribute('data-mode', opts.key);
        if (opts.locked) b.setAttribute('aria-disabled', 'true');
        b.append(opts.art);
        if (opts.locked) {
          const lock = doc.createElement('i');
          lock.className = 'mode-lock';
          lock.setAttribute('aria-hidden', 'true');
          b.append(lock);
        }
        const kicker = doc.createElement('small');
        const title = doc.createElement('b');
        const note = doc.createElement('span');
        const state = doc.createElement('u');
        kicker.textContent = opts.kicker;
        title.textContent = opts.title;
        note.textContent = opts.note;
        state.textContent = opts.state;
        b.append(kicker, title, note, state);
        /* Focus is the keyboard's highlight; the pointer's is bindHover's,
           and the two are separate classes so neither can clear the other. */
        b.addEventListener('focus', () => b.classList.add('is-highlighted'));
        b.addEventListener('blur', () => b.classList.remove('is-highlighted'));
        b.addEventListener('click', () => opts.act(b));
        cards.appendChild(b);
        return b;
      };

      // ------------------------------------------------------ story mode --
      const portrait = doc.createElement('img');
      portrait.src = NR.Pak.url('sprites/PlayerBattleCard.jpeg');
      portrait.alt = '';
      portrait.className = 'mode-art';
      const chapterName = chapters && chapters[current] ? chapters[current].title : '';
      const storyCard = card({
        key: 'story', art: portrait, primary: true,
        kicker: 'CAMPAIGN // WELCOME TO THE NIGHT',
        title: 'STORY MODE',
        note: last + ' CHAPTERS  //  SEVEN RIVALS  //  ONE MODEL THAT CANNOT PREDICT YOU',
        state: unlocked ? 'COMPLETE — REPLAY ANY CHAPTER'
          : (started
            ? 'CONTINUE — CHAPTER ' + String(current).padStart(2, '0')
              + (chapterName ? ' — ' + chapterName : '')
            : 'NEW GAME — CHAPTER 01'),
        act: () => this.chooseStory(),
      });

      // ------------------------------------------------------ multiplayer --
      /* Between the campaign and the open route, because that is the order a
         player meets them in: the story is what the game is, multiplayer is
         who else is on the road, and Free Roam is what is left when both are
         behind you. */
      /* THE COVER FOR MULTIPLAYER.
       *
       * It used to be the open-route card's gradient with a grid laid over
       * it, which is to say: the picture for a different mode, plus a
       * texture. It told the player nothing. There is no screenshot to use -
       * the race has not happened - but the mode has exactly one idea in it
       * and it is drawable: FOUR CARS ABREAST ON ONE ROAD.
       *
       * So that is what this is. A road running to a vanishing point, and
       * four sets of tail lights on it at four different distances, in the
       * four seat colours the lobby and the standings use. A player who has
       * been in a room recognises those colours; a player who has not still
       * reads "four cars, one road" without having to be told.
       *
       * Built from elements rather than pseudo-elements because there are six
       * layers and two pseudo-elements is two. Pure CSS: no asset to ship, it
       * scales to any card size, and it costs nothing to load. */
      const netArt = doc.createElement('i');
      netArt.className = 'mode-art mode-art-net';
      netArt.setAttribute('aria-hidden', 'true');
      const layer = (cls) => {
        const n = doc.createElement('u');
        n.className = cls;
        netArt.appendChild(n);
        return n;
      };
      layer('net-sky');
      layer('net-road');
      layer('net-lanes');
      /* Four cars, near to far. The one in front is the player's seat colour
         in the lobby, so the card and the room agree with each other. */
      for (let i = 0; i < 4; i++) layer('net-car net-car-' + i);
      layer('net-haze');
      const netCard = card({
        key: 'multiplayer', art: netArt,
        kicker: 'NETWORK LINK // THE GRID',
        title: 'MULTIPLAYER',
        note: 'UP TO FOUR CARS  //  ANY OF THE ' + (levelsOf.length || 7) + ' ROUTES  //  ONE ROAD',
        state: 'OPEN A ROOM, OR JOIN ONE WITH A CODE',
        act: () => this.chooseMultiplayer(),
      });
      // Woken on sight rather than on click. See warmGrid.
      netCard.addEventListener('focus', () => this.warmGrid());
      netCard.addEventListener('pointerenter', () => this.warmGrid());

      // -------------------------------------------------------- free roam --
      const art = doc.createElement('i');
      art.className = 'freeroam-art mode-art';
      const swatch = swatchOf;
      const levels = levelsOf;
      if (swatch && levels.length) {
        const first = levels[0].palette || {};
        const tail = levels[levels.length - 1].palette || {};
        art.style.setProperty('--r1', swatch(first.sign));
        art.style.setProperty('--r2', swatch(tail.cap, 0.9));
        art.style.setProperty('--r3', swatch(tail.grid));
      }
      const km = levels.length && g.freeRoamEnd !== undefined
        ? ((g.freeRoamEnd - levels[0].from) * UNITS_TO_KM).toFixed(1) : '126.8';
      const freeCard = card({
        key: 'freeroam', art: art, locked: !unlocked,
        kicker: unlocked ? 'OPEN ROUTE' : 'OPEN ROUTE // SEALED',
        title: 'FREE ROAM',
        note: 'ALL ' + (levels.length || 7) + ' REGIONS  //  ' + km
          + ' KM  //  NO CHAPTER, NO CUTSCENE, NO SEAM',
        state: unlocked
          ? 'ONE UNBROKEN RUN — SEAWALL TO HORIZON'
          : 'LOCKED — FINISH THE STORY  (' + done + ' / ' + last + ')',
        act: (b) => this.chooseFreeRoam(b),
      });

      /* Whichever card is the news. Before the campaign is finished that is
         the chapter waiting to be driven; after it, it is the road that just
         opened. */
      this.bindHover(this.ui.cards, '.mode-card');
      const first = unlocked ? freeCard : storyCard;
      global.setTimeout(() => { first.focus(); this.resyncHover(); }, 0);
      // ...and immediately, for the frame before that timeout lands
      this.resyncHover();
      this.cards = [storyCard, netCard, freeCard];
    }

    // ---------------------------------------------------------- input -----

    buttons() {
      return this.ui.panel ? Array.from(this.ui.panel.querySelectorAll('button')) : [];
    }

    move(step) {
      const b = this.buttons();
      if (!b.length) return;
      const i = Math.max(0, b.indexOf(doc.activeElement));
      const n = b[(i + step + b.length) % b.length];
      if (n) { n.focus(); this.g.audio.uiMove(); }
    }

    onKey(e) {

      /* A press that arrived within a moment of this screen opening was

         meant for the screen before it. See NR.Gate in js/ui.js: without

         this, two quick taps on ENTER walk through three screens. */

      if (NR.Gate && !NR.Gate.open()) return;
      if (!this.shown) return;
      /* ...and a committing key shuts the gate behind itself, now that this
         screen has established the key is for it. Moving between screens is
         covered by the state change; this is what stops a held ENTER
         skipping four lines of a cutscene in a third of a second. Arrows and
         TAB are deliberately not here: they move a selection rather than
         commit to it, and holding one is how a long list gets read. */
      if (NR.Gate && /^(enter| |escape|backspace)$/i.test(e.key)) NR.Gate.lock();
      const k = e.key.toLowerCase();
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (k === 'arrowright' || k === 'arrowdown' || k === 'd' || k === 's') { stop(); this.move(1); }
      else if (k === 'arrowleft' || k === 'arrowup' || k === 'a' || k === 'w') { stop(); this.move(-1); }
      else if (k === 'tab') { stop(); this.move(e.shiftKey ? -1 : 1); }
      else if (k === 'enter' || k === ' ') {
        stop();
        const a = doc.activeElement;
        if (a && a.tagName === 'BUTTON') a.click();
      } else if (k === 'escape' || k === 'backspace') { stop(); this.back(); }
    }

    /* The camera keeps flying down the road behind the terminal, so the choice
       is made over the thing being chosen. */
    tick(dt) {
      const g = this.g;
      g.time += dt;
      g.scene.time = g.time;
      g.fade += (g.fadeTarget - g.fade) * Math.min(1, dt * 3);
      g.idleFlyby(dt);
      g.audio.update(g.car, dt, false);
    }
  }

  NR.ModeSelect = ModeSelect;

  const GP = NR.Game.prototype;

  const oldLoad = GP.load;
  GP.load = async function () {
    await oldLoad.call(this);
    if (!this.modeSelect) this.modeSelect = new ModeSelect(this);
    /* Last word on the START row. js/story.js binds it to the campaign in
       attach(); the terminal is what the campaign is now reached through, so
       this rebinds it after that has happened. */
    if (this.menuItems && this.menuItems[0] && this.modeSelect.ui.root) {
      this.menuItems[0].act = () => this.modeSelect.open();
    }
  };

  const oldUpdate = GP.update;
  GP.update = function (dt) {
    if (this.modeSelect && this.modeSelect.isExclusive()) {
      this.modeSelect.tick(dt);
      return;
    }
    oldUpdate.call(this, dt);
  };

  global.__SYNX_MODESELECT__ = {
    name: 'DRIVER TERMINAL',
    modes: ['STORY MODE', 'MULTIPLAYER', 'FREE ROAM'],
    gate: 'campaign complete (FREE ROAM only)',
  };
})(window);
