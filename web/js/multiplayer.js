/* SYNX MULTIPLAYER — four cars, one road.
 *
 * The third door behind START, between the campaign and the open route. This
 * file owns three things and nothing else:
 *
 *   THE SCREEN    a lobby built out of the same cut-corner panels, corner
 *                 ticks and Orbitron as the Story hub and the open-route
 *                 screen, so it reads as another room in the same building.
 *   THE ROOM      creating one, joining one by its code, picking any of the
 *                 seven routes, and saying you are ready.
 *   THE RACE      putting the other cars on the road, publishing your own, and
 *                 showing the result the server decided.
 *
 * WHAT IT DOES NOT OWN
 * --------------------
 *   the socket        js/net.js
 *   the netcode       crates/synx-core/src/net.rs, behind NR.NetCore
 *   where a car is    the same, and never this file
 *
 * WHY THE OTHER CARS ARE ORDINARY CARS
 * ------------------------------------
 * A remote player is a real `NR.Vehicle` in the simulation core, exactly like
 * the campaign's rival. It is simply never STEPPED: instead of a solver, its
 * pose is written each frame by the interpolator from the last two states the
 * server sent. Everything downstream then works unchanged - the renderer draws
 * it, the headlight rig lights it, the collision resolver hits it, the tyre
 * smoke comes off it - because as far as any of them can tell it is just
 * another car. That is the whole reason this file is short.
 */
(function (global) {
  'use strict';

  const NR = global.NR;
  if (!NR || !NR.Game || NR.Multiplayer) return;

  const doc = global.document;
  const M4 = NR.M4;

  /** Which cars a room can hold. Mirrors MAX_PLAYERS in the wire protocol. */
  const MAX_PLAYERS = 4;

  /* THE CAR. There is one, and it is not a setting.
     Multiplayer does not read the save: two players at different points in the
     campaign would otherwise arrive at the same start line in different cars.
     The room used to choose between the street car and the Chapter 6 rebuild,
     which fixed that within a room and reintroduced it between rooms - the
     same four drivers got a different race depending on a control one of them
     had touched, and a time set in one room meant nothing beside a time set in
     another. So: everybody is in the street car, always. The server enforces
     it; this is only what the screen says about it. */
  const CAR = { label: 'STOCK', note: 'THE STREET CAR  //  290 KM/H  //  NO RACE MODE' };

  /* Why the server pushed your car back, in words a player can act on. The
     honest cause of most of these is a bad connection rather than anything
     else, and saying so is the difference between a game that feels broken and
     one that feels like it is telling the truth. */
  const CORRECTION_TEXT = {
    1: 'LINK CORRECTION  //  SPEED',
    2: 'LINK CORRECTION  //  OFF COURSE',
    3: 'LINK CORRECTION  //  POSITION',
    4: 'LINK CORRECTION  //  ALTITUDE',
    5: 'LINK CORRECTION  //  CLOCK',
    6: 'LINK CORRECTION  //  CHECKPOINT',
    7: 'LINK CORRECTION  //  TOO FAST',
    8: 'LINK CORRECTION  //  BAD DATA',
  };

  /* WHY A REFUSAL GETS ITS OWN SCREEN.
   *
   * Waiting and being turned away look identical if you only change the
   * words: both leave the player on the connecting screen reading a line of
   * status text. But they are opposite situations. Waiting is fixed by
   * waiting; being refused is never fixed by waiting, and offering RETRY
   * LINK for a version mismatch invites somebody to press it twenty times
   * before concluding the game is broken.
   *
   * So a refusal says what happened, what it means, and only offers the
   * actions that can actually change the outcome. */
  const REFUSAL_PANELS = {
    'wire-mismatch': {
      title: 'DIFFERENT WIRE FORMAT',
      body: 'That server and this copy of SYNX were built from different versions of '
        + 'the network protocol, so they cannot agree on what a car looks like. '
        + 'Updating the game to the current release fixes it.',
      retry: false,
    },
    'protocol-mismatch': {
      title: 'DIFFERENT PROTOCOL',
      body: 'That server speaks a newer or older protocol than this build. '
        + 'Updating the game to the current release fixes it.',
      retry: false,
    },
    'bad-origin': {
      title: 'REFUSED AT THE DOOR',
      body: 'That server does not serve clients running from here. If you are running '
        + 'the game from a browser rather than the desktop app, that is why.',
      retry: false,
    },
    'server-full': {
      title: 'THE GRID IS FULL',
      body: 'Every seat on that server is taken. It is worth trying again in a minute; '
        + 'races end all the time.',
      retry: true,
    },
    'rate-limited': {
      title: 'TOO MANY ATTEMPTS',
      body: 'That server is refusing new connections from here for a moment. '
        + 'Waiting half a minute clears it.',
      retry: true,
    },
  };

  const UNITS_TO_KM = 0.000733;

  function fmtTime(ms) {
    if (ms == null || !isFinite(ms)) return '--:--';
    const t = ms / 1000;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  class Multiplayer {
    constructor(game) {
      this.g = game;
      this.shown = false;
      this.from = 'menu';
      /** 'name' | 'connecting' | 'browse' | 'room' */
      this.view = 'connecting';
      this.status = '';
      /** The server's refusal code, when the last attempt was turned away. */
      this.refusal = '';
      this.rooms = [];
      this.notices = [];
      /** One `NR.Vehicle` per remote seat, made on demand. */
      this.cars = [];
      /** True between the lights and the results. */
      this.racing = false;
      this.crossed = false;
      this.results = null;
      this.pending = null;
      this._hudAt = 0;
      this._lastCorrection = 0;

      /** The dialog's pending promise, while one is open. */
      this._dialog = null;
      /** The room-list poll, while the browse view is on screen. */
      this._poll = 0;
      /** The last room list, as one string, to skip rebuilds that change nothing. */
      this._roomsSig = '';
      /** What had the keyboard when the last rebuild started. */
      this._focusKey = '';
      /** What Net.probe found, when a server address was last accepted. */
      this._probed = null;

      this.ui = this.bindDom();
      if (this.ui.root) {
        global.addEventListener('keydown', (e) => this.onKey(e), true);
        /* The footer's BACK control. It is deliberately wired to escape()
           rather than back(): in a room, one press should leave the room and
           not the whole link, which is exactly what ESC already does, and two
           controls that look the same must not do different things. */
        if (this.ui.back) this.ui.back.addEventListener('click', () => this.escape());
      }
      this.bindDialog();
      this.bindNet();
    }

    bindDom() {
      const id = (n) => doc.getElementById(n);
      return {
        root: id('multiplayerRoot'), panel: id('multiplayer'),
        status: id('mpStatus'), name: id('mpName'), link: id('mpLink'), ping: id('mpPing'),
        main: id('mpMain'), side: id('mpSide'),
        nameRoot: id('mpNameRoot'), nameInput: id('mpNameInput'),
        nameOk: id('mpNameOk'), nameHint: id('mpNameHint'),
        hud: id('mpHud'), hudRows: id('mpHudRows'), hudBanner: id('mpHudBanner'),
        resultsRoot: id('mpResultsRoot'), resultsTitle: id('mpResultsTitle'),
        resultsRows: id('mpResultsRows'), resultsNote: id('mpResultsNote'),
        resultsAgain: id('mpResultsAgain'), resultsLeave: id('mpResultsLeave'),
        podium: id('mpPodium'), verdict: id('mpVerdict'),
        hints: id('mpHints'), back: id('mpBack'), toasts: id('mpToasts'),
        dialogRoot: id('mpDialogRoot'), dialogKicker: id('mpDialogKicker'),
        dialogTitle: id('mpDialogTitle'), dialogBody: id('mpDialogBody'),
        dialogInput: id('mpDialogInput'), dialogHint: id('mpDialogHint'),
        dialogChoices: id('mpDialogChoices'),
        dialogOk: id('mpDialogOk'), dialogCancel: id('mpDialogCancel'),
      };
    }

    // ------------------------------------------------------------- events --

    bindNet() {
      const net = NR.Net;
      if (!net) return;
      net.on('state', () => { this.paintChrome(); if (this.shown) this.build(); });
      net.on('welcome', () => {
        if (this.shown && this.view === 'connecting') this.setView('browse');
        // Ask immediately as well as on the poll: an empty list that fills in
        // three seconds reads as "there is nothing here".
        NR.Net.listRooms();
        this.syncPoll();
      });
      net.on('room', (m, first) => {
        this.setView('room');
        if (first) this.notice('joined ' + m.code);
        if (this.shown) this.build();
        this.paintHud();
      });
      /* A POLL THAT CHANGES NOTHING MUST DO NOTHING.
       *
       * The list is re-fetched every three seconds, and almost every fetch
       * comes back identical. Rebuilding the view on each one would throw away
       * and recreate several dozen elements twelve hundred times an hour, take
       * the keyboard focus with it, cancel any hover, and make the panel feel
       * like it is flickering at the player. Comparing first is one string
       * compare against all of that. */
      net.on('rooms', (list) => {
        const sig = (list || []).map(r => r.code + r.players + r.phase + r.map).join('|');
        const same = sig === this._roomsSig;
        this.rooms = list;
        this._roomsSig = sig;
        if (!same && this.shown && this.view === 'browse') this.build();
      });
      net.on('countdown', (m) => this.onCountdown(m));
      net.on('results', (m) => this.onResults(m));
      /* A NOTICE THE PLAYER HAS TO ACT ON IS NOT A TOAST.
       *
       * Almost everything the server says is news - somebody joined, the host
       * changed the route - and a line that fades is right for news. Being the
       * reason nobody can start is not news: it is a job, addressed to one
       * person, and it was previously delivered as a toast that faded while
       * they were looking at the road. It gets a dialog with the button that
       * fixes it. */
      net.on('notice', (m) => {
        this.notice(m.text);
        if (m.kind === 'you-are-blocking' && this.shown && !this._dialog) {
          const mine = NR.Net.room && NR.Net.room.players.find(p => p.slot === NR.Net.slot);
          if (mine && mine.ready) return;
          this.dialog({
            kicker: 'SYNX GRID // THE ROOM IS WAITING',
            title: 'THE HOST WANTS TO START',
            body: 'Everybody else is ready. The race cannot begin until you say you are.',
            ok: 'I AM READY',
            cancel: 'NOT YET',
          }).then((yes) => {
            if (yes !== true) return;
            NR.Net.setReady(true);
            this.notice('you are ready');
          });
        }
      });
      net.on('chat', (m) => this.notice(m.name + ': ' + m.text));
      net.on('error', (m) => {
        this.notice(m.message);
        /* A join that was refused leaves the player looking at the lobby with
           nothing changed, which reads as the click not having registered.
           The list is re-asked so a room that filled up or closed stops being
           offered. */
        if (m.code === 'no-such-room' || m.code === 'room-full' || m.code === 'join-refused') {
          NR.Net.listRooms();
        }
        if (this.shown) this.build();
      });
      /* THE SERVER SAID GOODBYE.
       *
       * Being removed by the host, or the room closing under you. `net` has
       * already forgotten the room by the time this runs, so the view has to
       * follow it: `abandon` only unwinds a RACE, and in a lobby it returns
       * immediately - which used to leave the player looking at a room screen
       * for a room they were no longer in, with buttons that did nothing.
       *
       * The reason is worth keeping on screen rather than flashing past in a
       * toast: "the host removed you" is something the player will otherwise
       * conclude was a bug. */
      net.on('bye', (m) => {
        const removed = m.code === 'kicked' || m.code === 'removed';
        if (this.racing || this.results) {
          this.abandon(m.message);
        } else {
          this.setView('browse');
          NR.Net.listRooms();
          if (this.shown) this.build();
        }
        this.notice(m.message);
        if (removed && this.shown) {
          this.dialog({
            kicker: 'SYNX GRID // REMOVED',
            title: 'THE HOST REMOVED YOU',
            body: (m.message || 'You were removed from that room.')
              + ' That code will not let you back in while the room is open.',
            ok: 'BACK TO THE LOBBY',
            cancel: false,
          });
        }
      });
      net.on('close', () => { if (this.racing) this.notice('lost the grid; reconnecting'); });
      net.on('reconnecting', (m) => this.notice('reconnecting in ' + Math.round(m.inMs / 100) / 10 + 's'));
    }

    /* What the grid just said.
     *
     * A toast rather than a line appended to a log in the side column. The log
     * grew downwards under the buttons, which meant the actions moved every
     * time the server mentioned that somebody had joined - and a control that
     * moves while you are reaching for it is worse than no feedback at all.
     * These stack in their own corner, expire on their own, and never push
     * anything. */
    notice(text) {
      if (!text) return;
      const line = String(text).slice(0, 120);
      /* KEPT, as well as flashed.
       *
       * A toast is the right way to say something the moment it happens and
       * the wrong way to be the only record of it: look away for five seconds
       * and somebody joined, said ready and left again with no trace. The
       * lobby keeps the last several and prints them, so "did anybody actually
       * leave?" is answerable by reading rather than by guessing. */
      this.notices.unshift({ text: line, at: Date.now() });
      if (this.notices.length > 8) this.notices.length = 8;
      if (this.shown && this.view !== 'name') this.paintLog();
      if (this.racing && this.g.hud) {
        this.g.hud.toast(line.toUpperCase().slice(0, 40), '#39e6ff');
      }
      const host = this.ui.toasts;
      if (!host) return;
      const t = el('p', 'mp-toast', line);
      host.appendChild(t);
      // Oldest first, so the newest is always the one that survives a burst.
      while (host.children.length > 4) host.removeChild(host.firstChild);
      global.setTimeout(() => {
        t.classList.add('is-going');
        global.setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
      }, 5200);
    }

    /* WHAT HAS HAPPENED IN HERE.
     *
     * Appended to the side column rather than given its own panel, and rebuilt
     * in place rather than through `build`, so a player joining does not
     * destroy and recreate every control on the screen. */
    paintLog() {
      const side = this.ui.side;
      if (!side) return;
      let log = side.querySelector('.mp-log');
      if (!this.notices.length) {
        if (log) log.remove();
        return;
      }
      if (!log) {
        log = el('div', 'mp-log');
        side.appendChild(log);
      }
      log.textContent = '';
      log.appendChild(el('small', 'mp-group', 'WHAT JUST HAPPENED'));
      for (const n of this.notices) log.appendChild(el('p', null, n.text));
    }

    clearNotices() {
      this.notices = [];
      const host = this.ui.toasts;
      while (host && host.firstChild) host.removeChild(host.firstChild);
      const log = this.ui.side && this.ui.side.querySelector('.mp-log');
      if (log) log.remove();
    }

    // -------------------------------------------------------------- flow ---

    isExclusive() { return this.shown; }

    open(from) {
      const g = this.g;
      if (!this.ui.root) return false;
      this.from = from === 'modes' ? 'modes' : 'menu';
      if (g.story && g.story.mode !== 'none') g.story.onMainMenu();
      g.exitFreeRoam();
      this.shown = true;
      g.state = 'multiplayer';
      g.cursorHiddenForRun = false;
      g.syncCursorVisibility();
      g.storyHideRival = true;
      g.fadeTo(0);
      this.ui.root.setAttribute('aria-hidden', 'false');
      doc.body.classList.add('multiplayer-open');
      g.audio.playTrack('menu');

      /* The name first, because everything else needs one - and because being
         asked who you are is a better first frame of a multiplayer mode than a
         spinner. */
      if (!NR.Net.named) {
        this.setView('name');
        this.build();
        global.setTimeout(() => { if (this.ui.nameInput) this.ui.nameInput.focus(); }, 60);
        return true;
      }
      this.setView(NR.Net.inRoom ? 'room' : (NR.Net.online ? 'browse' : 'connecting'));
      this.build();
      // installed once, on the first visit, and left running afterwards:
      // a link can die long after this screen has been closed
      this.watchLink();
      // the status line is typed on the way in, once - see modeselect.js
      if (NR.UI && this.ui.status) {
        NR.UI.type(this.ui.status, this.ui.status.textContent || this.status || "");
      }
      this.link();
      this.syncPoll();
      return true;
    }

    /* Put every panel this mode owns away. Screens only - see `teardown` for
       the half that matters. */
    close() {
      this.shown = false;
      const u = this.ui;
      for (const el of [u.root, u.nameRoot, u.hud, u.resultsRoot, u.dialogRoot]) {
        if (el) el.setAttribute('aria-hidden', 'true');
      }
      doc.body.classList.remove('multiplayer-open');
    }

    /* THE ONE WAY OUT.
     *
     * Every path that leaves multiplayer goes through here: the back button,
     * Escape, the results board, abandoning mid-race, and the game's own
     * `toMenu` however it was reached. There used to be several, each
     * remembering a different subset of what had to be undone, and the bug
     * that produced was always the same shape - the screens went away, the
     * socket did not, and the server went on holding a seat in a room for a
     * driver who was looking at the title screen. A room like that does not
     * close: it sits in the log with a player in it until a timeout nobody is
     * watching finally expires.
     *
     * So this is idempotent, it is total, and it is the only door. Calling it
     * twice is harmless; calling it when nothing is open is harmless. What it
     * must never do is leave one of these three behind - the socket, the seat,
     * or the simulation state the race installed into the game object.
     */
    teardown() {
      const g = this.g;

      // 1. THE RACE. Whatever the game is holding on multiplayer's behalf.
      this.racing = false;
      this.results = null;
      this.crossed = false;
      this.pending = null;
      this.cars = [];
      g.storyExtraRacers = [];
      g.soloRun = false;
      g.storyHideRival = false;
      g.blockQuickRestart = false;

      // 2. THE LINK. `disconnect` gives up the seat before it closes the
      //    socket, so the server is told this is a departure rather than
      //    being left to infer one from silence.
      NR.Net.disconnect('left');

      // 3. THE SCREENS, and the lobby state that only meant anything while
      //    they were up.
      this.notices = [];
      this.rooms = [];
      this._roomsSig = '';
      this._focusKey = '';
      this.refusal = '';
      this.status = '';
      this.clearNotices();
      this.closeDialog(null);
      this.close();
      this.syncPoll();
    }

    back() {
      const g = this.g;
      g.audio.uiMove();
      const to = this.from;
      this.teardown();
      if (to === 'modes' && g.modeSelect) { g.modeSelect.open(); return; }
      g.toMenu();
    }

    /* IS THERE AN INTERNET AT ALL?
     *
     * `navigator.onLine` is a weak signal and is treated as one: false is
     * trustworthy - the machine knows it has no route - while true only means
     * a network interface is up, which a captive portal or a dead uplink also
     * satisfies. So it is used to say NO early and never to say yes.
     *
     * Saying no early matters here more than it usually would. The wake path
     * deliberately waits thirty seconds per attempt because a free host takes
     * most of a minute to come out of sleep, so a player with the wifi off
     * used to sit and watch "waking the grid" count up to half a minute before
     * being told anything at all. */
    offline() {
      try {
        return global.navigator && global.navigator.onLine === false;
      } catch (e) { return false; }
    }

    /* THE POPUP, AND WHEN IT IS WORTH ONE.
     *
     * The connecting screen already carries the status line and the refusal
     * box, and a modal on top of a screen that is already explaining itself is
     * noise. This is for the two cases the screen cannot handle: there is no
     * network at all, and the link died under a player who was doing something
     * else at the time. */
    warn(kind, title, body, note, retry) {
      if (!NR.UI || NR.UI.busy()) return;
      const actions = [];
      if (retry) actions.push({ label: 'TRY AGAIN', value: 'retry', primary: true });
      actions.push({ label: retry ? 'BACK' : 'OK', value: 'close', primary: !retry });
      NR.UI.alert({
        kind, title, body, note, actions,
        onClose: (r) => {
          if (r === 'retry') this.link();
          else if (r === 'close' && retry && this.shown && !NR.Net.online) this.back();
        },
      });
    }

    /** Wake the server if it is asleep, then register and connect. */
    link() {
      if (NR.Net.online || NR.Net.state === 'connecting' || NR.Net.state === 'registering') return;
      this.setView('connecting');
      /* Cleared on every attempt. A refusal describes the attempt that earned
         it, and leaving a stale one on screen while the next one is in flight
         reads as the new attempt having already failed. */
      this.refusal = '';

      if (this.offline()) {
        this.status = 'this machine is not connected to a network';
        this.refusal = 'offline';
        this.build();
        this.warn('warn', 'NO NETWORK',
          'This machine reports no connection, so there is nothing to reach. '
          + 'Everything else in SYNX runs offline - the campaign, free roam and '
          + 'the time trials are all local.',
          'Reconnect and press TRY AGAIN. The grid will be waiting.', true);
        return;
      }

      this.status = 'reaching the grid';
      this.build();
      NR.Net.wake((p) => {
        const s = Math.round(p.elapsed / 1000);
        this.status = p.state === 'ready'
          ? 'grid awake'
          : (s < 4 ? 'reaching the grid'
            : 'waking the grid — ' + s + 's' + (s > 20 ? ' (a sleeping server takes about a minute)' : ''));
        if (this.shown && this.view === 'connecting') this.build();
      }).then(() => {
        this.status = 'opening the link';
        if (this.shown) this.build();
        return NR.Net.connect();
      }).then(() => {
        this.status = '';
        NR.Net.listRooms();
        this.setView('browse');
        if (this.shown) this.build();
      }).catch((e) => {
        this.status = (e && e.message) || 'could not reach the grid';
        this.refusal = (e && e.code) || '';
        if (this.shown) this.build();
        /* THE SERVER IS THERE OR IT IS NOT, and the player cannot tell which
           from a status line they have already stopped reading. The address is
           named because the most common cause by far is a custom one that has
           been typed in and is wrong. */
        if (this.shown) {
          this.warn('error', 'THE GRID DID NOT ANSWER',
            'SYNX could not open a link to the server. It may be asleep, it may '
            + 'be down, or this network may be blocking the connection.',
            'Server: ' + (NR.Net.server || 'the default grid') + '\n'
            + (this.status || 'no reason given'), true);
        }
      });
    }

    /* THE LINK CAN ALSO DIE WHILE NOBODY IS LOOKING AT THIS SCREEN, which is
       the case that most needs telling: a player halfway down a straight with
       three other cars around them, and then nothing. Wired to the browser's
       own connection events and to the net layer's, so both a pulled cable and
       a server that walks away are covered. */
    watchLink() {
      if (this._watching) return;
      this._watching = true;
      const drop = () => {
        if (!this.shown && !NR.Net.inRoom) return;
        this.warn('error', 'LINK LOST',
          'The connection to the grid has gone. Any race in progress has ended '
          + 'for this car; the others are still out there.',
          this.offline() ? 'This machine is no longer on a network.'
            : 'The server stopped answering.', true);
      };
      global.addEventListener('offline', () => {
        if (NR.Net.online || NR.Net.inRoom || this.shown) drop();
      });
      global.addEventListener('online', () => {
        /* Coming back is not a warning, it is an offer. Only made when the
           player is on the network screen and still unconnected - anywhere
           else it would be a popup nobody asked for. */
        if (this.shown && !NR.Net.online && NR.UI && !NR.UI.busy()) {
          this.warn('info', 'NETWORK IS BACK',
            'This machine is connected again. The grid can be reached from here.',
            null, true);
        }
      });
    }

    setView(v) {
      if (this.view === v) return;
      this.view = v;
      if (this.ui.nameRoot) {
        this.ui.nameRoot.setAttribute('aria-hidden', v === 'name' ? 'false' : 'true');
      }
      this.syncPoll();
    }

    /* KEEP THE ROOM LIST TRUE.
     *
     * The list used to be fetched once on arrival and then only when somebody
     * pressed REFRESH, which means the ordinary case - open the lobby, wait
     * for a friend to open a room - showed "no open rooms" forever and looked
     * like the server was down. A lobby listing is worth almost nothing if it
     * is not live.
     *
     * Polled rather than pushed because the server has no subscription for it
     * and a three-second poll of a handful of rooms is cheaper than the
     * machinery to add one. It runs ONLY while the browse view is actually on
     * screen: not in a room, not during a race, not when the panel is closed.
     * That is what keeps it from being a socket that chatters forever in the
     * background, which is the usual way a poll like this becomes a problem.
     */
    syncPoll() {
      const want = this.shown && this.view === 'browse' && NR.Net.online;
      if (want && !this._poll) {
        this._poll = global.setInterval(() => {
          if (this.shown && this.view === 'browse' && NR.Net.online) NR.Net.listRooms();
          else this.syncPoll();
        }, 3000);
      } else if (!want && this._poll) {
        global.clearInterval(this._poll);
        this._poll = 0;
      }
    }

    // ---------------------------------------------------------------- ui ---

    paintChrome() {
      const u = this.ui;
      const net = NR.Net;
      if (u.name) u.name.textContent = net.name || '—';
      if (u.link) {
        const label = { offline: 'OFFLINE', waking: 'WAKING', registering: 'LINKING', connecting: 'LINKING', online: 'ONLINE' };
        u.link.textContent = label[net.state] || 'OFFLINE';
        u.link.classList.toggle('is-locked', net.state !== 'online');
      }
      if (u.ping) {
        const s = net.stats();
        u.ping.textContent = net.online && s.rtt ? Math.round(s.rtt) + ' MS' : '--';
      }
    }

    build() {
      const u = this.ui;
      if (!u.main) return;
      /* WHAT HAD THE KEYBOARD BEFORE THIS RAN.
       *
       * `build` replaces the contents of both columns, which destroys the
       * focused element even when the rebuild changed nothing about it. Put
       * back by identity rather than by position, so a room appearing at the
       * top of the list does not move the selection out from under somebody
       * who was about to press Enter. */
      this._focusKey = this.focusKey(doc.activeElement);
      this.paintChrome();

      if (this.view === 'name') {
        if (u.status) u.status.textContent = 'The grid needs something to call you. It is shown to the other three cars and nothing else.';
        u.main.textContent = '';
        u.side.textContent = '';
        if (u.nameInput && !u.nameInput.value) u.nameInput.value = NR.Net.name || '';
        return;
      }

      u.main.textContent = '';
      u.side.textContent = '';

      if (this.view === 'connecting') this.buildConnecting();
      else if (this.view === 'room') this.buildRoom();
      else this.buildBrowse();

      this.paintLog();
      this.paintHints();
      this.bindHover(u.main, '.mp-tile, .mp-map, .story-action');
      this.bindHover(u.side, '.story-action');
      this.restoreFocus();
    }

    /* What identifies a control across a rebuild. `data-mp` for the fixed
       actions, the room code for a row in a list that reorders itself. */
    focusKey(node) {
      if (!node || node === doc.body) return '';
      const panel = this.ui.panel;
      if (!panel || !panel.contains(node)) return '';
      const tag = node.getAttribute && node.getAttribute('data-mp');
      if (tag) return 'mp:' + tag;
      const code = node.getAttribute && node.getAttribute('data-code');
      if (code) return 'code:' + code;
      return '';
    }

    /* KEEP A KEYBOARD IN THE PANEL.
     *
     * `build` replaces the contents of both columns, which destroys whatever
     * had focus - and focus that lands back on `document.body` makes the
     * arrow keys do nothing at all until the mouse is used. On a screen the
     * player may well have arrived at from a controller that reads as the
     * interface having frozen.
     *
     * So: if nothing inside the panel holds focus, put it on the first thing
     * that can take it. Deliberately not while a dialog or the name field is
     * up - those own the keyboard and stealing it back would fight them. */
    restoreFocus() {
      if (this._dialog || this.view === 'name') return;
      const panel = this.ui.panel;
      if (!panel) return;
      const at = doc.activeElement;
      if (at && at !== doc.body && panel.contains(at)) return;

      const put = (node) => {
        if (!node) return false;
        try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
        return true;
      };

      // The same control as before, if it still exists.
      const key = this._focusKey;
      if (key) {
        const [kind, value] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
        const sel = kind === 'mp'
          ? '[data-mp="' + value + '"]'
          : '[data-code="' + value + '"]';
        let node = null;
        try { node = panel.querySelector(sel); } catch (e) { node = null; }
        if (node && !node.classList.contains('locked') && put(node)) return;
      }

      /* Otherwise the first thing that can take it. Deliberately not while the
         pointer is being used: stealing focus onto the first button while
         somebody is halfway down the list with a mouse moves the highlight
         somewhere they are not looking. */
      put(panel.querySelector('button:not(.locked):not([aria-disabled="true"])'));
    }

    buildConnecting() {
      const u = this.ui;
      const panel = this.refusal && REFUSAL_PANELS[this.refusal];

      if (u.status) {
        u.status.textContent = this.status || 'reaching the grid';
      }

      const box = el('div', 'mp-connecting synx-cut' + (panel ? ' mp-refused' : ''));
      if (panel) {
        box.appendChild(el('small', null, 'LINK REFUSED'));
        box.appendChild(el('b', null, panel.title));
        box.appendChild(el('span', null, panel.body));
      } else if (this.refusal) {
        // A code this build has no panel for. The server writes readable
        // sentences precisely so that this case is still worth showing.
        box.appendChild(el('small', null, 'LINK REFUSED'));
        box.appendChild(el('b', null, 'THE GRID SAID NO'));
        box.appendChild(el('span', null, this.status || 'that server refused the connection.'));
      } else {
        box.appendChild(el('small', null, 'NETWORK LINK'));
        box.appendChild(el('b', null, (this.status || 'CONNECTING').toUpperCase()));
        box.appendChild(el('span', null,
          'The grid sleeps when nobody is on it and takes about a minute to come back. '
          + 'This screen asked it to wake the moment you opened it.'));
        const bar = el('i', 'mp-bar');
        bar.appendChild(el('span'));
        box.appendChild(bar);
      }
      u.main.appendChild(box);

      if (!panel || panel.retry) {
        this.action(u.side, 'retry', 'ASK AGAIN', 'RETRY LINK', () => this.link());
      }
      this.action(u.side, 'server', 'ANYBODY CAN RUN A SYNX SERVER', 'CHANGE SERVER…',
        () => this.editServer());

      this.group(u.side, 'LEAVE');
      this.action(u.side, 'back', 'CLOSE THE LINK TO THE GRID',
        this.from === 'modes' ? 'DISCONNECT — MODE SELECT' : 'DISCONNECT — MAIN MENU',
        () => this.back());
    }

    buildBrowse() {
      const u = this.ui;
      if (u.status) {
        u.status.textContent = 'Four cars, one road, any of the seven routes. '
          + 'Open a room and pass the code to whoever is driving with you, or take whichever race is already forming.';
      }

      const tiles = el('div', 'mp-tiles');
      tiles.appendChild(this.tile('quick', 'FASTEST WAY ON', 'QUICK RACE',
        'JOIN WHICHEVER RACE IS FORMING', () => { this.g.audio.select(); NR.Net.quickPlay(-1); }));
      /* PUBLIC, and this is the bug that made the mode look broken.

         This passed `private: true`, and the server excludes a private room
         from the listing by design - so every room anybody opened was
         invisible to everybody else, including to the person who opened it
         looking at their own lobby. "I can't see any server created" was
         exactly right, and it was this one argument. A room you open to race
         with people is public; the code still works for inviting directly. */
      tiles.appendChild(this.tile('create', 'YOUR ROOM, YOUR RULES', 'OPEN A ROOM',
        'LISTED FOR EVERYONE  //  ALSO INVITE BY CODE', () => {
          this.g.audio.select();
          NR.Net.createRoom(this.pickedMap || 0, false);
        }));
      tiles.appendChild(this.tile('private', 'ONLY WHO YOU GIVE THE CODE TO', 'PRIVATE ROOM',
        'HIDDEN FROM THE LIST', () => {
          this.g.audio.select();
          NR.Net.createRoom(this.pickedMap || 0, true);
        }));
      tiles.appendChild(this.tile('join', 'SOMEBODY SENT YOU SIX CHARACTERS', 'JOIN BY CODE',
        'ENTER A ROOM CODE', () => this.askCode()));
      u.main.appendChild(tiles);

      const list = el('div', 'mp-rooms');
      const head = el('small', 'mp-rooms-head', this.rooms.length
        ? 'OPEN ROOMS  ·  ' + this.rooms.length
        : 'NO OPEN ROOMS RIGHT NOW  ·  OPEN ONE AND IT APPEARS HERE FOR EVERYBODY');
      list.appendChild(head);
      for (const r of this.rooms) {
        const b = el('button', 'mp-room synx-cut');
        b.type = 'button';
        b.setAttribute('data-code', r.code);
        b.appendChild(el('b', null, r.code));
        b.appendChild(el('span', null, r.map_name));
        b.appendChild(el('u', null, r.players + ' / ' + r.max_players + '  ·  ' + String(r.phase).toUpperCase()));
        b.addEventListener('click', () => { this.g.audio.select(); NR.Net.joinRoom(r.code); });
        list.appendChild(b);
      }
      u.main.appendChild(list);

      /* WHICH GRID AM I ON.
       *
       * The server is configurable, and once something is configurable the
       * interface owes the player an answer to "which one is this?" that does
       * not involve opening a settings screen. The host is shown rather than
       * the whole URL because the scheme and any path are noise at a glance,
       * and the build beside it is what turns a bug report into something
       * answerable. */
      const foot = el('div', 'mp-foot');
      let host = NR.Net.server || '';
      try { host = new URL(NR.Net.server).host; } catch (e) { /* keep it whole */ }
      foot.appendChild(el('span', null, 'GRID  ' + host));
      if (NR.Net.serverBuild) foot.appendChild(el('span', null, NR.Net.serverBuild));
      u.main.appendChild(foot);

      this.group(u.side, 'THE LIST');
      this.action(u.side, 'refresh', 'IT ALSO REFRESHES ITSELF EVERY FEW SECONDS', 'REFRESH NOW',
        () => { NR.Net.listRooms(); this.g.audio.uiMove(); });

      this.group(u.side, 'YOU');
      this.action(u.side, 'name', 'CHANGE WHAT THE GRID CALLS YOU', 'DRIVER NAME…', () => {
        this.setView('name');
        this.build();
        global.setTimeout(() => { if (this.ui.nameInput) this.ui.nameInput.focus(); }, 60);
      });
      this.action(u.side, 'server', 'POINT AT ANOTHER SERVER', 'SERVER…', () => this.editServer());
      this.action(u.side, 'back', 'CLOSE THE LINK TO THE GRID',
        this.from === 'modes' ? 'DISCONNECT — MODE SELECT' : 'DISCONNECT — MAIN MENU',
        () => this.back());
    }

    buildRoom() {
      const u = this.ui;
      const room = NR.Net.room;
      if (!room) return this.buildBrowse();
      const host = NR.Net.isHost;
      const me = room.you;

      /* WHAT IS THIS ROOM WAITING FOR?
       *
       * The old line said the same two things forever - "you are the host" or
       * "waiting for the host" - which is true and useless: it never changed,
       * so it stopped being read, and the actual answer (we need one more car;
       * two people have not said ready; you have not said ready) was nowhere
       * on the screen. A player who cannot tell why nothing is happening
       * concludes something is broken. */
      const live = room.players.filter(p => p.connected);
      const mineNow = room.players.find(p => p.slot === me);
      const notReady = live.filter(p => !p.ready && p.slot !== room.host);
      if (u.status) {
        let line;
        if (live.length < 2) {
          line = 'A race needs two cars. Pass the room code to somebody, or wait here — '
            + 'this room is listed for anybody browsing.';
        } else if (mineNow && !mineNow.ready && !host) {
          line = 'Everybody else is waiting on you. Say READY when you are.';
        } else if (notReady.length) {
          line = 'Waiting for ' + notReady.map(p => p.name).join(', ') + '.';
        } else if (host) {
          line = 'Everybody is ready. Drop the lights when you want to go.';
        } else {
          line = 'Everybody is ready. Waiting for the host to drop the lights.';
        }
        u.status.textContent = line;
      }

      // ---- who is here ------------------------------------------------
      const grid = el('div', 'mp-grid');
      for (let i = 0; i < room.max_players; i++) {
        const p = room.players.find(x => x.slot === i);
        const card = el('div', 'mp-seat synx-cut' + (p ? '' : ' empty')
          + (p && p.slot === me ? ' is-you' : ''));
        card.appendChild(el('small', null, 'CAR ' + String(i + 1).padStart(2, '0')
          + (p && p.slot === me ? '  //  YOU' : '')));
        card.appendChild(el('b', null, p ? p.name : '—'));
        const tags = el('span');
        if (p) {
          if (p.host) tags.appendChild(el('i', 'mp-tag host', 'HOST'));
          if (!p.connected) tags.appendChild(el('i', 'mp-tag warn', 'RECONNECTING'));
          else if (p.ready) tags.appendChild(el('i', 'mp-tag ready', 'READY'));
          // The host does not say ready - they start the race - so labelling
          // them WAITING alongside everybody else said the race was being held
          // up by the one person who was not holding it up.
          else if (p.host) tags.appendChild(el('i', 'mp-tag host', 'STARTS THE RACE'));
          else tags.appendChild(el('i', 'mp-tag', 'NOT READY'));
          if (p.ping) tags.appendChild(el('i', 'mp-tag', p.ping + ' MS'));
        } else {
          tags.appendChild(el('i', 'mp-tag', 'OPEN SEAT'));
        }
        card.appendChild(tags);
        /* Removing somebody is not undoable and it bars them from coming
           back, so it is confirmed - and the confirmation says what it will
           actually do rather than "are you sure?". */
        if (host && p && p.slot !== me) {
          const k = el('button', 'mp-kick', 'REMOVE');
          k.type = 'button';
          k.setAttribute('data-mp', 'kick-' + p.slot);
          const who = p.name, at = p.slot;
          k.addEventListener('click', () => {
            this.g.audio.uiMove();
            this.dialog({
              kicker: 'SYNX GRID // REMOVE A DRIVER',
              title: 'REMOVE ' + who + '?',
              body: 'They lose their seat now, and cannot rejoin this room for as long '
                + 'as it is open - the code will not work for them. Closing the room '
                + 'clears that.',
              ok: 'REMOVE',
              cancel: 'KEEP THEM',
            }).then((yes) => {
              if (yes !== true) return;
              NR.Net.kick(at);
              this.notice(who + ' was removed');
            });
          });
          card.appendChild(k);
        }
        grid.appendChild(card);
      }
      u.main.appendChild(grid);

      /* ---- the route -------------------------------------------------
       *
       * ONLY THE HOST GETS A GRID.
       *
       * Everybody used to see all seven, greyed out, which is a menu that
       * exists to tell you that you may not use it. Worse, it is the largest
       * thing on the screen, so the one fact a guest actually wants - which
       * route am I about to drive - was the hardest to find in it.
       *
       * A guest now sees exactly that: the chosen route, once, at a size that
       * says it is the answer rather than an option. */
      const maps = el('div', 'mp-maps' + (host ? '' : ' is-single'));
      const swatch = NR.freeRoamSwatch;
      const levels = this.g.levels || [];
      const routes = (NR.Net.maps || []).filter(m => host || m.id === room.map);
      for (const m of routes) {
        const L = levels[m.id];
        const b = el('button', 'mp-map synx-cut' + (m.id === room.map ? ' is-picked' : '')
          + (host ? '' : ' locked'));
        b.type = 'button';
        b.setAttribute('data-mp', 'route-' + m.id);
        if (!host) b.setAttribute('aria-disabled', 'true');
        const art = el('i', 'freeroam-art');
        if (swatch && L && L.palette) {
          const p = L.palette;
          art.style.setProperty('--r1', swatch(p.lava || p.sign));
          art.style.setProperty('--r2', swatch(p.cap, 0.92));
          art.style.setProperty('--r3', swatch(p.grid));
        }
        b.appendChild(art);
        b.appendChild(el('small', null, host
          ? 'ROUTE ' + String(m.id + 1).padStart(2, '0')
          : 'THE HOST PICKED  //  ROUTE ' + String(m.id + 1).padStart(2, '0')));
        b.appendChild(el('b', null, m.name));
        b.appendChild(el('span', null, m.note));
        b.appendChild(el('u', null, m.km.toFixed(1) + ' KM'));
        if (host) {
          b.addEventListener('click', () => { this.g.audio.uiMove(); NR.Net.setMap(m.id); });
        }
        maps.appendChild(b);
      }
      u.main.appendChild(maps);

      // ---- the side ---------------------------------------------------
      /* The code exists to be given to somebody else, so it can be taken
         with one click. Reading six characters off a screen and typing them
         into a chat window is the sort of small friction that decides whether
         a second player turns up at all. */
      const code = el('button', 'mp-code synx-cut is-copyable');
      code.type = 'button';
      code.appendChild(el('small', null, room.private ? 'PRIVATE ROOM  //  SHARE THIS CODE' : 'OPEN ROOM'));
      code.appendChild(el('b', null, room.code));
      code.appendChild(el('i', null, 'CLICK TO COPY'));
      code.addEventListener('click', () => {
        this.copy(room.code).then((ok) => {
          const tag = code.querySelector('i');
          if (tag) tag.textContent = ok ? 'COPIED' : 'PRESS CTRL+C';
          code.classList.toggle('is-copied', ok);
          this.g.audio.uiMove();
          global.setTimeout(() => {
            if (!tag.isConnected) return;
            tag.textContent = 'CLICK TO COPY';
            code.classList.remove('is-copied');
          }, 2200);
        });
      });
      u.side.appendChild(code);

      /* The car is stated, not offered. A disabled button that cycles nothing
         would be a control; this is a line of text that answers the question
         "what am I driving" without inviting anybody to try to change it. */
      this.group(u.side, 'THE RACE');
      const carRow = el('div', 'mp-fact synx-cut');
      carRow.appendChild(el('small', null, CAR.note));
      carRow.appendChild(el('b', null, 'CAR: ' + CAR.label));
      u.side.appendChild(carRow);

      /* READY is the guest's one job, so it is the loud thing on their side of
         the screen - and it is loud when it is NOT done, which is the state
         that needs them to act. It used to be highlighted once it was already
         ready, which is the wrong way round. The host never sees it: they
         start the race, which is a different button. */
      const mine = room.players.find(p => p.slot === me);
      const iAmReady = !!(mine && mine.ready);
      if (!host) {
        this.action(u.side, 'ready',
          iAmReady ? 'YOU ARE IN — SELECT TO CHANGE YOUR MIND' : 'EVERYBODY IS WAITING FOR THIS',
          iAmReady ? 'READY ✓' : 'SAY YOU ARE READY',
          () => { this.g.audio.uiMove(); NR.Net.setReady(!iAmReady); },
          iAmReady ? '' : 'primary');
      }

      if (host) {
        const others = room.players.filter(p => p.connected && p.slot !== me);
        const ready = others.filter(p => p.ready).length;
        const enough = room.players.filter(p => p.connected).length >= 2;
        this.action(u.side, 'start',
          enough
            ? (ready === others.length
              ? 'EVERYBODY IS READY'
              : ready + ' OF ' + others.length + ' READY — YOU CAN START ANYWAY')
            : 'A RACE NEEDS TWO CARS — NOBODY ELSE IS HERE YET',
          'DROP THE LIGHTS', () => { this.g.audio.select(); NR.Net.startRace(); },
          enough ? 'primary' : 'locked');
      }

      this.group(u.side, 'LEAVE');
      this.action(u.side, 'leave', 'GIVE UP YOUR SEAT — THE ROOM CARRIES ON', 'LEAVE ROOM', () => {
        this.g.audio.uiMove();
        NR.Net.leaveRoom();
        this.setView('browse');
        /* Twice, deliberately. The first asks before the server has processed
           the leave and gets the old count; the second lands after it and gets
           the true one. Without the follow-up the list a player sees for the
           first few seconds after leaving still has them in it, which reads as
           the leave not having worked. */
        NR.Net.listRooms();
        this._roomsSig = '';
        global.setTimeout(() => { if (this.shown) NR.Net.listRooms(); }, 250);
        this.build();
      });
      this.action(u.side, 'back', 'CLOSE THE LINK TO THE GRID',
        this.from === 'modes' ? 'DISCONNECT — MODE SELECT' : 'DISCONNECT — MAIN MENU',
        () => this.back());
    }

    /* Put text on the clipboard, saying honestly whether it worked.
     *
     * Never rejects. The modern API needs a secure context and a permission
     * the webview may not grant, and the old one needs a live selection; when
     * neither is available the interface says "press Ctrl+C" rather than
     * claiming a copy that did not happen. */
    copy(text) {
      const v = String(text || '');
      const nav = global.navigator;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        return nav.clipboard.writeText(v).then(() => true, () => this._copyFallback(v));
      }
      return Promise.resolve(this._copyFallback(v));
    }

    _copyFallback(v) {
      try {
        const box = doc.createElement('textarea');
        box.value = v;
        box.setAttribute('readonly', '');
        box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        doc.body.appendChild(box);
        box.select();
        const ok = doc.execCommand && doc.execCommand('copy');
        doc.body.removeChild(box);
        return !!ok;
      } catch (e) {
        return false;
      }
    }

    tile(key, kicker, title, note, act) {
      const b = el('button', 'mp-tile synx-cut');
      b.type = 'button';
      b.setAttribute('data-mp', key);
      b.appendChild(el('small', null, kicker));
      b.appendChild(el('b', null, title));
      b.appendChild(el('span', null, note));
      b.addEventListener('click', act);
      return b;
    }

    /* A rule with a word on it, to break the side column into groups.
     *
     * Four identical buttons in a stack is a list of things that all look
     * equally likely to be what you want, and the only way to find out is to
     * read every one. THE RACE / LEAVE turns that into short named lists, and
     * the one you want is usually the group you can name. */
    group(host, label) {
      if (!host) return;
      host.appendChild(el('small', 'mp-group', label));
    }

    action(host, key, small, label, fn, cls) {
      if (!host) return null;
      const b = el('button', 'story-action synx-cut' + (cls ? ' ' + cls : ''));
      b.type = 'button';
      b.setAttribute('data-mp', key);
      b.appendChild(el('small', null, small));
      b.appendChild(el('b', null, label));
      b.addEventListener('click', fn);
      host.appendChild(b);
      return b;
    }

    /* The pointer, asked directly - the same arrangement js/modeselect.js uses,
       and for the same reason: a panel built underneath a cursor that is
       already sitting still never receives an enter, so the tile under it
       stays dark until the mouse is moved off it and back. */
    bindHover(root, selector) {
      if (!root || root.__synxHover) return;
      root.__synxHover = true;
      const sync = (e) => {
        const over = e && e.target && e.target.closest ? e.target.closest(selector) : null;
        const all = root.querySelectorAll(selector);
        for (let i = 0; i < all.length; i++) {
          all[i].classList.toggle('is-hover', all[i] === over && !all[i].classList.contains('locked'));
        }
      };
      root.addEventListener('pointermove', sync);
      root.addEventListener('pointerdown', sync);
      root.addEventListener('pointerleave', () => {
        const all = root.querySelectorAll(selector);
        for (let i = 0; i < all.length; i++) all[i].classList.remove('is-hover');
      });
    }

    /* WHAT THE KEYS DO HERE.
     *
     * One fixed footer used to claim ARROWS / ENTER / ESC on every screen,
     * including the two where arrows do nothing and the one where Escape means
     * something quite different. A hint that is wrong is worse than no hint:
     * it is the reason somebody presses Escape in a room expecting to leave
     * the room and finds themselves at the title screen. */
    paintHints() {
      const u = this.ui;
      if (!u.hints) return;
      const rows = [];
      if (this.view === 'name') {
        rows.push(['ENTER', 'CONFIRM'], ['ESC', 'BACK']);
      } else if (this.view === 'room') {
        rows.push(['ARROWS', 'SELECT'], ['ENTER', 'CONFIRM'], ['ESC', 'LEAVE ROOM']);
      } else if (this.view === 'browse') {
        rows.push(['ARROWS', 'SELECT'], ['ENTER', 'CONFIRM'],
          ['ESC', this.from === 'modes' ? 'MODE SELECT' : 'MAIN MENU']);
      } else {
        rows.push(['ENTER', 'CONFIRM'], ['ESC', 'BACK']);
      }
      /* ...and the button beside them says the same destination the ESC row
         does, because two labels for one action that disagree is worse than
         one label. */
      if (u.back) {
        const esc = rows[rows.length - 1];
        const b = u.back.querySelector('b');
        if (b && esc) b.textContent = esc[1];
      }
      u.hints.textContent = '';
      for (const [k, what] of rows) {
        const sp = el('span');
        sp.appendChild(el('b', null, k));
        sp.appendChild(doc.createTextNode(' ' + what));
        u.hints.appendChild(sp);
      }
    }

    // ------------------------------------------------------------ dialog --

    /* Ask for one thing, in the game's own language.
     *
     * Resolves to the entered string, to `true` for a plain confirmation, or
     * to `null` if the player backed out - so every caller reads as
     * `if (v === null) return;` and cancelling is never mistaken for an empty
     * answer.
     *
     * `filter` shapes each keystroke (a room code is upper case and six
     * characters whatever the keyboard sends); `validate` gets the final value
     * and returns an error sentence, which is shown in place rather than
     * closing the dialog on something that will not work.
     */
    dialog(opts) {
      const u = this.ui;
      const o = opts || {};
      if (!u.dialogRoot) return Promise.resolve(null);
      // A second dialog over the first would strand the first one's promise.
      this.closeDialog(null);

      if (u.dialogKicker) u.dialogKicker.textContent = o.kicker || 'SYNX GRID';
      if (u.dialogTitle) u.dialogTitle.textContent = o.title || 'CONFIRM';
      if (u.dialogBody) {
        u.dialogBody.textContent = o.body || '';
        u.dialogBody.hidden = !o.body;
      }
      if (u.dialogHint) u.dialogHint.textContent = o.hint || '';

      /* A LIST OF WAYS OUT, rather than yes-or-no.
       *
       * Built here rather than as a second panel because a race menu and a
       * confirmation are the same object as far as the player is concerned -
       * a question over the top of the game, answered with Enter or Escape -
       * and having two of them would mean two sets of focus handling, two
       * keyboard maps and two chances for them to disagree. */
      const choices = Array.isArray(o.choices) ? o.choices : null;
      if (u.dialogChoices) {
        u.dialogChoices.textContent = '';
        u.dialogChoices.hidden = !choices;
        if (choices) {
          for (const c of choices) {
            const b = el('button', 'mp-choice synx-cut' + (c.tone ? ' is-' + c.tone : ''));
            b.type = 'button';
            b.setAttribute('data-choice', c.key);
            b.appendChild(el('b', null, c.label));
            if (c.note) b.appendChild(el('span', null, c.note));
            b.addEventListener('click', () => {
              this.g.audio.select();
              this.closeDialog(c.key);
            });
            u.dialogChoices.appendChild(b);
          }
        }
      }

      const wantsInput = !choices && typeof o.value === 'string';
      if (u.dialogInput) {
        u.dialogInput.hidden = !wantsInput;
        u.dialogInput.value = wantsInput ? o.value : '';
        u.dialogInput.placeholder = o.placeholder || '';
        u.dialogInput.maxLength = o.max || 120;
      }
      if (u.dialogOk) {
        u.dialogOk.hidden = !!choices;
        if (!choices) u.dialogOk.querySelector('b').textContent = o.ok || 'CONFIRM';
      }
      /* `cancel: false` is an acknowledgement rather than a question - being
         told you were removed is not a choice, and offering a second button
         that does the same thing as the first invites the player to wonder
         which one was the safe one. */
      const canCancel = o.cancel !== false && !choices;
      if (u.dialogCancel) {
        u.dialogCancel.hidden = !canCancel;
        if (canCancel) u.dialogCancel.querySelector('b').textContent = o.cancel || 'CANCEL';
      }
      if (u.dialogRoot) u.dialogRoot.classList.toggle('is-single', !canCancel);

      u.dialogRoot.setAttribute('aria-hidden', 'false');
      // The world may still be running behind this one; see syncCursorVisibility.
      this.g.uiOverlayOpen = true;
      this.g.syncCursorVisibility();
      global.setTimeout(() => {
        const first = choices
          ? u.dialogChoices.querySelector('button')
          : (wantsInput ? u.dialogInput : u.dialogOk);
        if (first) first.focus();
        if (wantsInput && u.dialogInput.select) u.dialogInput.select();
      }, 50);

      return new Promise((resolve) => {
        this._dialog = { resolve, opts: o, wantsInput, choices: !!choices };
      });
    }

    /** Everything in the open dialog that can take the keyboard, in the order
        it is read. */
    dialogButtons() {
      const u = this.ui;
      if (!u.dialogRoot) return [];
      const out = [];
      if (u.dialogChoices && !u.dialogChoices.hidden) {
        out.push.apply(out, Array.from(u.dialogChoices.querySelectorAll('button')));
      }
      for (const b of [u.dialogOk, u.dialogCancel]) if (b && !b.hidden) out.push(b);
      return out;
    }

    /* Commit whatever the dialog is holding, or refuse to and say why.
     *
     * `validate` answers immediately from the text alone. `check` is allowed
     * to go and ask something - a server, in the one case that needs it - and
     * returns a promise. While it is out the dialog stays up with its buttons
     * disabled, because the alternative is closing on a value that has not
     * been established yet and then undoing it. */
    commitDialog() {
      const d = this._dialog;
      if (!d || d.busy) return;
      const u = this.ui;
      if (!d.wantsInput) return this.closeDialog(true);

      let v = (u.dialogInput && u.dialogInput.value) || '';
      if (d.opts.filter) v = d.opts.filter(v);

      const bad = d.opts.validate ? d.opts.validate(v) : '';
      if (bad) {
        if (u.dialogHint) u.dialogHint.textContent = bad;
        if (u.dialogInput) u.dialogInput.focus();
        return;
      }
      if (!d.opts.check) return this.closeDialog(v);

      d.busy = true;
      this.setDialogBusy(true, d.opts.checking || 'CHECKING…');
      Promise.resolve(d.opts.check(v)).then((why) => {
        // The dialog may have been cancelled while the check was out.
        if (this._dialog !== d) return;
        d.busy = false;
        this.setDialogBusy(false);
        if (why) {
          if (u.dialogHint) u.dialogHint.textContent = why;
          if (u.dialogInput) u.dialogInput.focus();
          return;
        }
        this.closeDialog(v);
      });
    }

    /** Lock the dialog while something is being asked of the network. */
    setDialogBusy(on, label) {
      const u = this.ui;
      if (u.dialogRoot) u.dialogRoot.classList.toggle('is-busy', !!on);
      for (const b of [u.dialogOk, u.dialogCancel]) {
        if (b) b.disabled = !!on;
      }
      if (u.dialogInput) u.dialogInput.readOnly = !!on;
      if (on && u.dialogHint) u.dialogHint.textContent = label || 'CHECKING…';
    }

    /** Put it away, settling the promise exactly once. */
    closeDialog(value) {
      const d = this._dialog;
      this._dialog = null;
      if (this.ui.dialogRoot) this.ui.dialogRoot.setAttribute('aria-hidden', 'true');
      this.g.uiOverlayOpen = false;
      this.g.syncCursorVisibility();
      if (d) d.resolve(value === undefined ? null : value);
    }

    bindDialog() {
      const u = this.ui;
      if (!u.dialogRoot || u.dialogRoot.__synxBound) return;
      u.dialogRoot.__synxBound = true;
      if (u.dialogOk) {
        u.dialogOk.addEventListener('click', () => { this.g.audio.select(); this.commitDialog(); });
      }
      if (u.dialogCancel) {
        u.dialogCancel.addEventListener('click', () => { this.g.audio.uiMove(); this.closeDialog(null); });
      }
      if (u.dialogInput) {
        // Shape as they type, so the field always shows what will be sent.
        u.dialogInput.addEventListener('input', () => {
          const d = this._dialog;
          if (!d || !d.opts.filter) return;
          const at = u.dialogInput.selectionStart;
          const before = u.dialogInput.value;
          const after = d.opts.filter(before);
          if (after !== before) {
            u.dialogInput.value = after;
            const back = Math.max(0, at - (before.length - after.length));
            try { u.dialogInput.setSelectionRange(back, back); } catch (e) { /* not a text field */ }
          }
        });
      }
    }

    // -------------------------------------------------------------- input --

    commitName() {
      const v = (this.ui.nameInput && this.ui.nameInput.value) || '';
      const clean = v.replace(/[^A-Za-z0-9 ._'-]/g, '').trim().slice(0, 16).toUpperCase();
      if (clean.length < 2) {
        if (this.ui.nameHint) this.ui.nameHint.textContent = 'two characters at least';
        return;
      }
      NR.Net.name = clean;
      this.g.audio.select();
      this.setView(NR.Net.online ? 'browse' : 'connecting');
      this.build();
      this.link();
    }

    askCode() {
      this.dialog({
        kicker: 'SYNX GRID // JOIN A ROOM',
        title: 'ROOM CODE',
        body: 'Six characters, from whoever opened the room.',
        value: '',
        placeholder: 'ABC123',
        max: 6,
        ok: 'JOIN',
        filter: v => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6),
        validate: v => (v.length === 6 ? '' : 'a room code is six characters'),
      }).then((code) => {
        if (code === null) return;
        this.g.audio.select();
        NR.Net.joinRoom(code);
      });
    }

    editServer() {
      const now = NR.Net.server;
      this.dialog({
        kicker: 'SYNX GRID // SERVER',
        title: 'WHICH GRID?',
        body: 'SYNX is open source and so is its server: anybody can run one. '
          + 'Point the game at yours, or at a friend\'s, by giving its address here.',
        value: now,
        placeholder: 'https://example.com',
        max: 120,
        ok: 'CONNECT',
        hint: 'leave it as it is to stay where you are',
        filter: v => v.replace(/\s+/g, ''),
        validate: (v) => {
          if (!v) return 'an address, or cancel to keep the current one';
          if (!/^https?:\/\//i.test(v)) return 'start with http:// or https://';
          try { new URL(v); } catch (e) { return 'that is not an address'; }
          return '';
        },
        /* NOTHING IS SAVED UNTIL THE ADDRESS HAS PROVED ITSELF.
           See Net.probe. A bad address written to the save is a game that
           starts up broken every time until somebody works out how to undo
           it, so the check happens here, in front of the player, while the
           old address is still the one in effect. */
        checking: 'ASKING THAT ADDRESS…',
        check: (v) => NR.Net.probe(v).then((r) => {
          if (r.ok) { this._probed = r; return ''; }
          return r.why;
        }),
      }).then((v) => {
        if (v === null) return;
        const next = v.replace(/\/+$/, '');
        if (next === now) return;
        NR.Net.server = next;
        NR.Net.disconnect('server changed');
        const info = this._probed || {};
        this.notice('grid: ' + next + (info.build ? '  ·  ' + info.build : ''));
        this.link();
      });
    }

    /* LEAVING A RACE THAT IS STILL HAPPENING.
     *
     * Multiplayer has no pause and cannot have one: three other cars keep
     * driving whatever this one does, so a menu that stops the world stops
     * only this player's view of it - the car coasts on the server, the
     * validator watches it drift, and the race is lost to a screen that
     * claimed to have paused it.
     *
     * So Escape mid-race asks the one question that is actually available,
     * over a world that is still running. `blocking: false` keeps the frame
     * loop going behind the dialog, which is the whole point.
     */
    confirmLeaveRace() {
      if (!this.racing || this._dialog) return;
      this.dialog({
        kicker: 'SYNX GRID // RACE IN PROGRESS  —  THE OTHER CARS ARE STILL DRIVING',
        title: 'RACE MENU',
        body: 'A multiplayer race cannot be paused: three other cars keep going '
          + 'whatever this one does. Everything here happens immediately.',
        choices: [
          {
            key: 'resume',
            label: 'KEEP DRIVING',
            note: 'BACK TO THE RACE',
            tone: 'go',
          },
          {
            key: 'lobby',
            label: 'RETIRE TO THE LOBBY',
            note: 'GIVE UP THIS RACE  //  KEEP YOUR SEAT FOR THE NEXT ONE',
          },
          {
            key: 'room',
            label: 'LEAVE THE ROOM',
            note: 'GIVE UP YOUR SEAT  //  BACK TO THE ROOM LIST',
          },
          {
            key: 'quit',
            label: 'DISCONNECT FROM THE GRID',
            note: 'CLOSE THE LINK  //  BACK TO ' + (this.from === 'modes' ? 'MODE SELECT' : 'THE TITLE'),
            tone: 'warn',
          },
        ],
      }).then(pick => this.leaveRace(pick));
    }

    /* THE FOUR WAYS OUT OF A RACE, in increasing order of how much you give up.
     *
     * Kept as one function because the three that leave are the same action
     * with different stopping points, and writing them separately is how they
     * drift apart - one remembering to unwind the simulation, another
     * remembering to tell the server, a third doing neither.
     */
    leaveRace(pick) {
      const g = this.g;
      if (!pick || pick === 'resume') return;
      g.audio.select();

      /* RETIRE: stop driving, stay in the room. The seat is kept, so when the
         others finish, the results arrive and the room goes back to its lobby
         with this player still in it, ready for the next race. The server
         scores this as a DNF, which is what it is. */
      if (pick === 'lobby') {
        this.abandon('you retired from the race');
        this.setView(NR.Net.inRoom ? 'room' : 'browse');
        if (this.shown) this.build();
        return;
      }

      // LEAVE THE ROOM: give up the seat, but stay on the grid.
      if (pick === 'room') {
        if (NR.Net.inRoom) NR.Net.leaveRoom();
        this.abandon('you left the room');
        this.setView('browse');
        NR.Net.listRooms();
        if (this.shown) this.build();
        return;
      }

      // DISCONNECT: all the way out. `back` runs the one teardown.
      if (pick === 'quit') this.back();
    }

    /* Escape means the smallest sensible step back, not always "quit".
     *
     * In a room it gives up the seat and returns to the lobby; in the lobby it
     * leaves multiplayer. Escape used to do the second from both, which is a
     * genuinely startling thing to happen when all you wanted was to pick a
     * different room. */
    escape() {
      if (this.view === 'room' && NR.Net.inRoom) {
        this.g.audio.uiMove();
        NR.Net.leaveRoom();
        this.setView('browse');
        NR.Net.listRooms();
        this.build();
        return;
      }
      this.back();
    }

    /* What the arrow keys may land on.
     *
     * `:not(.locked)` alone let the guest's route card into the list, which
     * meant arrowing across a room stopped on a control that does nothing and
     * reported it as selected. A thing you cannot use is not a stop. */
    buttons() {
      const panel = this.ui.panel;
      if (!panel) return [];
      return Array.from(
        panel.querySelectorAll('button:not(.locked):not([aria-disabled="true"])')
      );
    }

    move(dx, dy) {
      const b = this.buttons();
      if (!b.length) return;
      const cur = b.indexOf(doc.activeElement);
      if (cur < 0) { b[0].focus(); return; }
      const a = b[cur].getBoundingClientRect();
      const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
      let best = null, score = Infinity;
      for (const c of b) {
        if (c === b[cur]) continue;
        const r = c.getBoundingClientRect();
        const bx = r.left + r.width / 2, by = r.top + r.height / 2;
        const along = (bx - ax) * dx + (by - ay) * dy;
        if (along <= 6) continue;
        const off = Math.abs((bx - ax) * dy - (by - ay) * dx);
        const s = along + off * 2.4;
        if (s < score) { score = s; best = c; }
      }
      if (!best) best = b[(cur + (dx + dy > 0 ? 1 : b.length - 1)) % b.length];
      best.focus();
      this.g.audio.uiMove();
    }

    onKey(e) {
      /* The dialog is modal over everything, including the results board, and
         takes the keyboard before anything else looks at it. */
      if (this._dialog) {
        const k = e.key.toLowerCase();
        const stopIt = () => { e.preventDefault(); e.stopImmediatePropagation(); };
        const opts = this.dialogButtons();
        if (k === 'enter' || k === ' ') {
          stopIt();
          const at = doc.activeElement;
          if (this._dialog.choices && at && at.getAttribute && at.getAttribute('data-choice')) at.click();
          else this.commitDialog();
        } else if (k === 'escape') {
          stopIt();
          this.closeDialog(null);
        } else if (k === 'arrowdown' || k === 'arrowright' || k === 'tab' && !e.shiftKey) {
          stopIt();
          const i = opts.indexOf(doc.activeElement);
          const n = opts[(i + 1 + opts.length) % opts.length];
          if (n) { n.focus(); this.g.audio.uiMove(); }
        } else if (k === 'arrowup' || k === 'arrowleft' || k === 'tab') {
          stopIt();
          const i = opts.indexOf(doc.activeElement);
          const n = opts[(i - 1 + opts.length) % opts.length];
          if (n) { n.focus(); this.g.audio.uiMove(); }
        }
        return;
      }
      // The results board is modal over the race and takes the keyboard next.
      if (this.results) {
        const k = e.key.toLowerCase();
        if (k === 'enter' || k === ' ') { e.preventDefault(); e.stopImmediatePropagation(); this.dismissResults(true); }
        else if (k === 'escape') { e.preventDefault(); e.stopImmediatePropagation(); this.dismissResults(false); }
        return;
      }
      if (!this.shown) return;
      const k = e.key.toLowerCase();
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };

      if (this.view === 'name') {
        // The field owns the keyboard while it is up, except for the two keys
        // that mean "done" and "never mind".
        if (k === 'enter') { stop(); this.commitName(); }
        else if (k === 'escape') { stop(); if (NR.Net.named) { this.setView('browse'); this.build(); } else this.back(); }
        return;
      }
      if (k === 'arrowright') { stop(); this.move(1, 0); }
      else if (k === 'arrowleft') { stop(); this.move(-1, 0); }
      else if (k === 'arrowdown') { stop(); this.move(0, 1); }
      else if (k === 'arrowup') { stop(); this.move(0, -1); }
      else if (k === 'tab') {
        stop();
        const b = this.buttons();
        const i = Math.max(0, b.indexOf(doc.activeElement));
        const n = b[(i + (e.shiftKey ? b.length - 1 : 1)) % b.length];
        if (n) { n.focus(); this.g.audio.uiMove(); }
      } else if (k === 'enter' || k === ' ') {
        stop();
        const a = doc.activeElement;
        if (a && a.tagName === 'BUTTON') a.click();
      } else if (k === 'escape' || k === 'backspace') { stop(); this.escape(); }
    }

    // --------------------------------------------------------- the race ----

    /**
     * The lights.
     *
     * `start_at_ms` is on the SERVER's clock, which the core has been tracking
     * since the socket opened. Every car therefore drops on the same instant
     * whatever each player's latency is - which is the entire reason the clock
     * handshake exists, and the difference between a fair start and one where
     * the player with the best connection is already moving.
     */
    onCountdown(m) {
      const g = this.g;
      this.close();
      this.results = null;
      if (this.ui.resultsRoot) this.ui.resultsRoot.setAttribute('aria-hidden', 'true');
      this.pending = m;
      this.crossed = false;

      g.exitFreeRoam();
      // No AI. `soloRun` is what stops js/game.js simulating, drawing and
      // lighting the campaign's rival, and what stops it deciding the race.
      g.soloRun = true;
      g.storyHideRival = true;
      g.levelIndex = Math.max(0, Math.min((g.levels || []).length - 1, m.map | 0));
      this.ensureWorld(g.levelIndex);
      g.applyLevel();
      g.resetCar();
      // A multiplayer time is not a personal best: the route is the same but
      // the traffic is not, and a record set in a four-car pack is not
      // comparable with one set alone.
      g.recordKey = null;
      g.record = null;
      g.raceTime = 0;
      g.newRecord = false;
      g.won = false;
      g.raceOver = false;
      g.blockQuickRestart = true;

      // On the grid the server put us on, so the position it validates against
      // is the position we start from.
      const mine = (m.grid || []).find(x => x.slot === NR.Net.slot);
      if (mine) {
        if (g.story && g.story.setVehicle) g.story.setVehicle(g.car, mine.s, mine.lateral, 0);
        else g.car.reset(mine.s, mine.lateral);
      }
      g.distance = g.car.sTrack;

      this.racing = true;
      g.state = 'countdown';
      g.countdown = this.untilStart(m) + 0.999;
      g.lastBeep = -1;
      g.hideCursorForRun();
      g.fadeTo(0);
      g.onMusic();
      if (this.ui.hud) this.ui.hud.setAttribute('aria-hidden', 'false');
      this.paintHud();
    }

    /** Seconds until the lights, on the server's clock. */
    untilStart(m) {
      const s = NR.Net.stats();
      const serverNow = performance.now() + (s.offset || 0);
      return Math.max(0, ((m.start_at_ms >>> 0) - serverNow) / 1000);
    }

    /* Two of the seven routes are not merely a palette over the shipped
       landscape: Aurora Forge builds a production hall and Neon Horizon an
       elevated deck over a city. The campaign builds those from inside its own
       chapters and a tour builds them in `syncFreeRoamWorlds`; a multiplayer
       race needs the same, and asks for it the same way. */
    ensureWorld(map) {
      const g = this.g;
      if (map === 5 && NR.Level6Director) {
        if (!g.__level6Director) new NR.Level6Director(g);
        const f = g.__level6Director;
        if (f && f.world && f.world.build) f.world.build();
      }
      if (map === 6 && NR.Level7World) {
        if (!g.__level7World) g.__level7World = new NR.Level7World(g);
        g.scene.level7World = g.__level7World;
        if (NR.level7TagGround) NR.level7TagGround(g.scene);
        g.scene.level7GroundKeep = true;
        g.scene.level7Override = true;
      } else if (g.scene) {
        g.scene.level7Override = false;
      }
    }

    /** A `Vehicle` for a remote seat, made the first time it is needed. */
    carFor(slot) {
      let e = this.cars.find(c => c.slot === slot);
      if (e) return e;
      e = this.cars.find(c => c.slot < 0);
      if (!e) {
        const car = new NR.Vehicle(this.g.track);
        car.lift = this.g.car.lift;
        e = { car, slot: -1, name: '', _model: M4.make() };
        this.cars.push(e);
      }
      e.slot = slot;
      return e;
    }

    /**
     * One frame of the race, after the game has moved the local car.
     *
     * The order is the whole of it: advance the interpolator, take any
     * correction, put the remote cars where they should be, resolve contact
     * against them, then publish. Doing it after `Game.update` means the
     * collision acts on where our car actually ended up rather than where it
     * was a frame ago, which is the same rule the campaign's rival follows.
     */
    afterUpdate(dt) {
      const g = this.g;
      if (!this.racing || !NR.NetCore) return;
      const now = performance.now();

      NR.Net.pump();
      NR.NetCore.sample(now, dt);

      // The countdown is the server's, not ours. Re-derived every frame so a
      // long frame or a tab that was backgrounded cannot desynchronise it.
      if (g.state === 'countdown' && this.pending) {
        const left = this.untilStart(this.pending);
        g.countdown = left + (left > 0 ? 0.999 : 0);
        if (left <= 0 && g.state === 'countdown') {
          g.state = 'racing';
          /* Zero, rather than `g.raceTime || 0`.

             In practice these are the same: the room's own setup a hundred
             lines up already zeroes the clock before the countdown starts. The
             difference is what happens if that ever stops being true - the old
             expression would silently carry the previous race's elapsed time
             into the new one, and a race that begins at 1:47 is not a race that
             has begun. Saying zero costs nothing and cannot drift. */
          g.raceTime = 0;
        }
      }

      const why = NR.NetCore.takeCorrection(g.car);
      if (why && now - this._lastCorrection > 900) {
        this._lastCorrection = now;
        g.hud.toast(CORRECTION_TEXT[why] || 'LINK CORRECTION', '#ffb400');
      }

      // Where everybody else is. A seat with no state yet - a player who has
      // joined but whose first snapshot has not landed - is simply not drawn.
      const room = NR.Net.room;
      const live = [];
      if (room) {
        for (const p of room.players) {
          if (p.slot === NR.Net.slot) continue;
          const e = this.carFor(p.slot);
          e.name = p.name;
          if (NR.NetCore.apply(p.slot, e.car)) live.push(e);
        }
      }
      g.storyExtraRacers = live;

      // Contact. Resolved for our own car only - see `collide_local` in the
      // core for why each machine resolves the whole impulse for the car it
      // owns rather than half of it for both.
      if (g.state === 'racing') {
        for (const e of live) {
          const hit = NR.NetCore.collide(g.car, e.car);
          if (hit > 2.2) {
            const f = Math.min(1, hit / 14);
            g.audio.crash(f);
            g.shake = Math.max(g.shake || 0, 0.25 + Math.min(0.5, hit / 20));
            if (g.fx) g.fx.sparks(g.car, f);
            if (g.dentBetween) g.dentBetween(g.car, g.damage, e.car, f);
            if (g.glass && f > 0.42) g.shake += g.glass.impact(g.car, f * 0.8, 'car') || 0;
          }
        }
      }

      // ...and where we are.
      let flags = 0;
      if (g.state !== 'racing' && g.state !== 'countdown') flags |= 1 << 6;   // IDLE
      if (g.raceModeActive) flags |= 1 << 3;                                   // RACE_MODE
      NR.Net.publish(g.car, flags, 0);

      if (now - this._hudAt > 180) { this._hudAt = now; this.paintHud(); }
    }

    /* Crossing the line does not end a multiplayer race.
     *
     * js/game.js finishes a run the moment the local car passes the gantry,
     * which is right for one car and wrong for four: the result belongs to the
     * server, which is still timing three other people. So the local finish is
     * turned into a note that we are done, the car keeps rolling through the
     * run-off, and the board arrives when the room says the race is over. */
    crossLine() {
      if (this.crossed) return;
      this.crossed = true;
      const g = this.g;
      g.raceOver = true;
      g.audio.goBeep();
      g.hud.toast('ACROSS THE LINE  //  WAITING FOR THE GRID', '#5affc0');
      this.paintHud();
    }

    onResults(m) {
      const g = this.g;
      this.results = m;
      this.racing = false;
      g.storyExtraRacers = [];
      g.blockQuickRestart = false;
      if (this.ui.hud) this.ui.hud.setAttribute('aria-hidden', 'true');

      const u = this.ui;
      if (!u.resultsRoot) return;
      const mine = m.rows.find(r => r.slot === NR.Net.slot);
      if (u.resultsTitle) {
        const ordinal = ['', 'FIRST', 'SECOND', 'THIRD', 'FOURTH'];
        u.resultsTitle.textContent = !mine ? 'RACE OVER'
          : mine.dnf ? 'DID NOT FINISH'
            : mine.place === 1 ? 'WINNER' : (ordinal[mine.place] || 'PLACE ' + mine.place);
        u.resultsTitle.className = 'synx-chrome'
          + (mine && !mine.dnf && mine.place <= 3 ? ' is-p' + mine.place : '');
      }
      if (u.resultsNote) {
        const map = (NR.Net.maps || []).find(x => x.id === m.map);
        u.resultsNote.textContent = (map ? map.name + '  //  ' + map.km.toFixed(1) + ' KM' : '')
          + (mine && mine.corrections ? '   ·   ' + mine.corrections + ' LINK CORRECTIONS' : '');
      }
      /* THE PODIUM.
       *
       * The board used to be a flat list where first place was distinguished
       * from fourth by the digit in front of it. A race is a contest, and the
       * result of a contest is the one thing the interface should be willing
       * to be loud about - so the top three get a podium, ordered 2-1-3 across
       * the screen and stepped by height, the way a podium is.
       *
       * The list below keeps everybody, including the people who did not
       * finish. Both are wanted: the podium is the answer, the list is the
       * detail. */
      const finishers = m.rows.filter(r => !r.dnf);
      if (u.podium) {
        u.podium.textContent = '';
        const top = m.rows.slice(0, 3);
        u.podium.hidden = top.length < 2;
        // Second, first, third - so the winner stands in the middle.
        const order = [1, 0, 2].filter(i => i < top.length);
        for (const i of order) {
          const r = top[i];
          const step = el('div', 'mp-step is-p' + (i + 1)
            + (r.slot === NR.Net.slot ? ' is-you' : ''));
          step.appendChild(el('small', null, ['FIRST', 'SECOND', 'THIRD'][i]));
          step.appendChild(el('b', null, String(i + 1)));
          step.appendChild(el('span', null, r.name));
          step.appendChild(el('u', null, r.dnf
            ? 'DNF  ·  ' + (r.progress * 100).toFixed(0) + '%'
            : fmtTime(r.time_ms)));
          u.podium.appendChild(step);
        }
      }

      /* WHO BEAT WHO.
       *
       * A place on its own does not say what the race was actually like.
       * "Second, 0.42s behind TEST" is the sentence the player wants, and it
       * is the difference between a number and a story about a race they were
       * in. Written against the car immediately ahead, or immediately behind
       * if they won, because that is the one they were actually racing. */
      if (u.verdict) {
        let line = '';
        if (mine && !mine.dnf) {
          const idx = finishers.findIndex(r => r.slot === mine.slot);
          const ahead = idx > 0 ? finishers[idx - 1] : null;
          const behind = idx >= 0 && idx + 1 < finishers.length ? finishers[idx + 1] : null;
          if (ahead) {
            const gap = (mine.time_ms - ahead.time_ms) / 1000;
            line = gap.toFixed(2) + 's BEHIND ' + ahead.name.toUpperCase();
          } else if (behind) {
            const gap = (behind.time_ms - mine.time_ms) / 1000;
            line = gap.toFixed(2) + 's AHEAD OF ' + behind.name.toUpperCase();
          } else {
            line = 'THE ONLY CAR TO FINISH';
          }
        } else if (mine) {
          line = 'YOU GOT ' + (mine.progress * 100).toFixed(0) + '% OF THE WAY ROUND';
        }
        u.verdict.textContent = line;
        u.verdict.hidden = !line;
      }

      if (u.resultsRows) {
        u.resultsRows.textContent = '';
        for (const r of m.rows) {
          const row = el('li', 'mp-result' + (r.slot === NR.Net.slot ? ' is-you' : '')
            + (r.place <= 3 && !r.dnf ? ' is-p' + r.place : '')
            + (r.dnf ? ' is-dnf' : ''));
          row.appendChild(el('b', null, String(r.place)));
          row.appendChild(el('span', null, r.name));
          row.appendChild(el('u', null, r.dnf
            ? (r.progress * 100).toFixed(0) + '%'
            : fmtTime(r.time_ms)));
          u.resultsRows.appendChild(row);
        }
      }
      u.resultsRoot.setAttribute('aria-hidden', 'false');
      doc.body.classList.add('multiplayer-open');
      g.audio.playTrack('menu');
      global.setTimeout(() => { if (u.resultsAgain) u.resultsAgain.focus(); }, 60);
    }

    dismissResults(stay) {
      const g = this.g;
      this.results = null;
      if (this.ui.resultsRoot) this.ui.resultsRoot.setAttribute('aria-hidden', 'true');
      g.blockQuickRestart = false;
      if (stay && NR.Net.inRoom) {
        this.open(this.from);
        return;
      }
      if (NR.Net.inRoom) NR.Net.leaveRoom();
      this.setView('browse');
      this.open(this.from);
      NR.Net.listRooms();
    }

    /* Give up on the race and put the game back on its feet, WITHOUT leaving
       multiplayer: the link stays up and the player lands back in the lobby.
       That is the difference between this and `teardown`, and it is why the
       race state is unwound here by hand rather than by calling it. */
    abandon(why) {
      const g = this.g;
      if (!this.racing && !this.results) return;
      this.racing = false;
      this.results = null;
      this.crossed = false;
      this.cars = [];
      g.storyExtraRacers = [];
      g.soloRun = false;
      g.storyHideRival = false;
      g.blockQuickRestart = false;
      if (this.ui.hud) this.ui.hud.setAttribute('aria-hidden', 'true');
      if (this.ui.resultsRoot) this.ui.resultsRoot.setAttribute('aria-hidden', 'true');
      if (why) this.notice(why);
      this.setView('browse');
      this.open(this.from);
    }

    /* The standings, while driving.
     *
     * DOM rather than the canvas HUD, in the same right-hand column Chapters 6
     * and 7 use for their objective cards, so it sits where the interface
     * already leaves room and does not have to be threaded through hud.js. */
    /* WHERE THE STANDINGS CARD ACTUALLY GOES.
     *
     * Twice now this has been nudged in `vh` and twice it has landed on
     * something, because `vh` is the wrong unit for the question. The canvas
     * HUD is authored in a 1280x720 virtual space that is FITTED into the
     * window - `k = min(w/1280, h/720)` - and then centred. At 16:9 that space
     * fills the screen and a percentage happens to work; at any other aspect
     * it is letterboxed, the whole HUD slides inwards, and a card pinned to a
     * fraction of the viewport drifts across whatever is underneath it.
     *
     * The score stack lives at virtual x=570 (right aligned) with the SCORE
     * label at y=282, the digits at y=250 and the multiplier at y=216 - so it
     * occupies down to roughly y=203 once the glyphs are counted. This asks
     * the HUD to convert one virtual point below that into real pixels, which
     * is the same arithmetic the score itself went through. Wherever the score
     * is, this is under it, at every aspect ratio and every window size.
     */
    placeHud() {
      const u = this.ui;
      const hud = this.g && this.g.hud;
      if (!u.hud || !hud || !hud.vy || !hud.w) return;
      // 24 virtual units of air under the multiplier.
      const top = hud.vy(179);
      // Right edge of the card lines up with the right edge of the score stack.
      const right = hud.w - hud.vx(600);
      u.hud.style.top = Math.round(top) + 'px';
      u.hud.style.right = Math.round(Math.max(0, right)) + 'px';
    }

    paintHud() {
      const u = this.ui;
      if (!u.hudRows || !this.racing) return;
      const room = NR.Net.room;
      if (!room) return;
      this.placeHud();
      const g = this.g;
      const map = (NR.Net.maps || []).find(x => x.id === room.map);
      const span = map ? Math.max(1, map.to - map.from) : 1;
      const mine = map ? (g.distance - map.from) / span : 0;

      const rows = room.players.slice().map(p => ({
        slot: p.slot,
        name: p.name,
        place: p.place,
        ping: p.ping,
        connected: p.connected,
        finished: p.finish_ms != null,
        // Our own progress is the local car's, which is a frame old rather
        // than a snapshot old; everybody else's is what the server last said.
        progress: p.slot === NR.Net.slot ? mine : p.progress,
      }));
      rows.sort((a, b) => (b.progress - a.progress));

      u.hudRows.textContent = '';
      rows.forEach((r, i) => {
        /* First, second and third are told apart at a glance rather than by
           reading a number. Mid-race this is the only thing on screen that
           answers "am I winning", and a player at 200 km/h has about a tenth
           of a second to take it in. */
        const li = el('li', 'mp-standing' + (r.slot === NR.Net.slot ? ' is-you' : '')
          + (r.connected ? '' : ' is-gone')
          + (i < 3 ? ' is-p' + (i + 1) : ''));
        li.appendChild(el('b', null, String(i + 1)));
        li.appendChild(el('span', null, r.name));
        const gap = (r.progress - mine) * span * UNITS_TO_KM;
        li.appendChild(el('u', null, r.slot === NR.Net.slot ? 'YOU'
          : (r.finished ? 'IN' : (gap >= 0 ? '+' : '') + gap.toFixed(2) + ' KM')));
        u.hudRows.appendChild(li);
      });

      if (u.hudBanner) {
        const s = NR.Net.stats();
        u.hudBanner.textContent = (map ? map.name : '')
          + '   ·   ' + Math.round(s.rtt || 0) + ' MS'
          + '   ·   ' + Math.round(s.delay || 0) + ' MS BUFFER'
          + (this.crossed ? '   ·   WAITING FOR THE GRID' : '');
      }
    }

    /** One frame with the lobby up. The camera keeps flying down the road. */
    tick(dt) {
      const g = this.g;
      g.time += dt;
      g.scene.time = g.time;
      g.fade += (g.fadeTarget - g.fade) * Math.min(1, dt * 3);
      g.idleFlyby(dt);
      g.audio.update(g.car, dt, false);
      // The link is still live behind the panel, so the clock keeps tracking
      // and the room list keeps arriving.
      NR.Net.pump();
      if (NR.NetCore && NR.Net.online) NR.NetCore.sample(performance.now(), dt);
      this.paintChrome();
    }
  }

  NR.Multiplayer = Multiplayer;

  const GP = NR.Game.prototype;

  const oldLoad = GP.load;
  GP.load = async function () {
    await oldLoad.call(this);
    if (!this.multiplayer) this.multiplayer = new Multiplayer(this);
    const mp = this.multiplayer;
    const u = mp.ui;
    if (u.nameOk) u.nameOk.addEventListener('click', () => mp.commitName());
    if (u.resultsAgain) u.resultsAgain.addEventListener('click', () => mp.dismissResults(true));
    if (u.resultsLeave) u.resultsLeave.addEventListener('click', () => mp.dismissResults(false));
  };

  const oldUpdate = GP.update;
  GP.update = function (dt) {
    if (this.multiplayer && this.multiplayer.isExclusive()) {
      this.multiplayer.tick(dt);
      return;
    }
    oldUpdate.call(this, dt);
    if (this.multiplayer && this.multiplayer.racing) this.multiplayer.afterUpdate(dt);
  };

  /* Crossing the line is a note, not the end. See `crossLine`. */
  const oldFinish = GP.finish;
  GP.finish = function () {
    if (this.multiplayer && this.multiplayer.racing) {
      this.multiplayer.crossLine();
      return;
    }
    oldFinish.call(this);
  };

  /* GOING TO THE TITLE ALWAYS LEAVES THE GRID.
   *
   * Not only mid-race, which is what this used to check. A player sitting in
   * a lobby who reaches the title by any other route - the pause menu, a
   * chapter ending, anything that calls this - was leaving the socket open and
   * the seat taken, and the room stayed in the server's log with a driver in
   * it who had gone. The condition is now simply "is multiplayer holding
   * anything", and `teardown` is safe to call when the answer turns out to be
   * no. */
  const oldToMenu = GP.toMenu;
  GP.toMenu = function () {
    const mp = this.multiplayer;
    if (mp && (mp.shown || mp.racing || mp.results || NR.Net.online || NR.Net.inRoom)) {
      mp.teardown();
    }
    oldToMenu.call(this);
  };

  global.__SYNX_MULTIPLAYER__ = {
    name: 'MULTIPLAYER',
    maxPlayers: MAX_PLAYERS,
    car: CAR.label,
    corrections: CORRECTION_TEXT,
  };
})(window);
