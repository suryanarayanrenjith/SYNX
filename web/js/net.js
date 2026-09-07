/* SYNX — the link to the grid.
 *
 * Everything between the game and the multiplayer server: who you are, whether
 * the server is awake, the socket, the clock, and the send tick. The netcode
 * proper - interpolation, dead reckoning, the jitter buffer - is in the Rust
 * core behind `NR.NetCore`; this file never decides where a car is.
 *
 * WHAT IT OWNS
 * ------------
 *   IDENTITY   a name, an install id kept in the save file, and a description
 *              of the machine. Registered once per session for a token.
 *   WAKING     a server that has been idle takes a moment to come back. This
 *              asks it to as early as possible, and reports honestly on how
 *              far along that is.
 *   THE SOCKET one WebSocket, text for the lobby and binary for the race, with
 *              reconnection that puts you back in the room you were in.
 *   THE CLOCK  a running estimate of the server's time, so a countdown lands
 *              on the same instant on four machines.
 *   THE TICK   publishing your own car at a rate that responds to how the
 *              connection is actually behaving.
 *
 * WHAT IT DOES NOT OWN
 * --------------------
 * Any screen. js/multiplayer.js draws the lobby and runs the race; this is the
 * layer under it, and it can be driven headlessly by a test harness.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};
  if (NR.Net) return;

  /* WHERE THE SERVER IS.
   *
   * Three places, most specific first:
   *
   *   1. `window.SYNX_SERVER`, for a harness or a one-off.
   *   2. the save file, which is what the in-game field writes to, so a player
   *      can point the game at their own server without a rebuild.
   *   3. this constant.
   *
   * It is a full origin, with the scheme: the socket URL is derived from it by
   * swapping http for ws, so an https origin gets a wss socket and a mixed
   * content error is not something anybody has to think about. */
  const DEFAULT_SERVER = 'https://synx-multiplayer.onrender.com';

  const KEY_NAME = 'synx.mp.name.v1';
  const KEY_INSTALL = 'synx.mp.install.v1';
  const KEY_SERVER = 'synx.mp.server.v1';

  /* How long to keep asking a sleeping server to wake up. A cold start is
     usually under a minute; past two there is something else wrong and saying
     so is better than spinning forever. */
  const WAKE_TIMEOUT_MS = 150000;

  /* The reconnection ladder, in milliseconds. It ends rather than repeating,
     because a client that has been trying for a minute is one the player
     should be told about rather than one that keeps trying silently. */
  const BACKOFF = [400, 900, 1800, 3500, 6000, 10000];

  /** Seats in a room. Mirrors MAX_PLAYERS in the wire protocol. */
  const MAX_PLAYERS = 4;

  /* WHAT A REFUSAL AT THE DOOR SAYS.
   *
   * The server answers a rejected registration with a short code and its own
   * sentence. The code is what this file switches on; the sentences below are
   * written for the person holding the controller rather than for the person
   * reading a log, and each one names the thing they can actually do.
   *
   * A code that is not in this table falls through to the server's own
   * message, which is why the server writes readable ones. */
  const WIRE_MESSAGE =
    'this copy of SYNX and that server were built from different versions of '
    + 'the wire format. Update the game.';

  const REFUSALS = {
    'wire-mismatch': WIRE_MESSAGE,
    'bad-origin': 'that server does not accept clients from here.',
    'protocol-mismatch': WIRE_MESSAGE,
    'rate-limited': 'too many attempts from this connection. Wait a moment.',
    'server-full': 'the grid is full. Try again shortly.',
  };

  /** Turn a refused HTTP response body into the error the interface shows. */
  function refusal(body, status) {
    const code = body && body.error;
    const text = (code && REFUSALS[code])
      || (body && body.message)
      || ('the grid refused the connection (' + status + ')');
    const err = new Error(text);
    err.code = code || 'refused';
    err.status = status;
    return err;
  }

  function save() { return NR.Save || { get() { return null; }, set() {} }; }

  function readServer() {
    if (global.SYNX_SERVER) return String(global.SYNX_SERVER).replace(/\/+$/, '');
    const stored = save().get(KEY_SERVER);
    if (stored) return String(stored).replace(/\/+$/, '');
    return DEFAULT_SERVER;
  }

  /** A random, stable identifier for this installation. */
  function installId() {
    let id = save().get(KEY_INSTALL);
    if (id && /^[0-9a-f]{32}$/.test(id)) return id;
    const bytes = new Uint8Array(16);
    (global.crypto || {}).getRandomValues
      ? global.crypto.getRandomValues(bytes)
      : bytes.forEach((_, i) => { bytes[i] = (Math.random() * 256) | 0; });
    id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    save().set(KEY_INSTALL, id);
    return id;
  }

  /* What this build calls itself, for the server's log.
   *
   * Self-reported and nothing more: it is read by a person looking at a log
   * line or a bug report, never used to decide anything. The wire fingerprint
   * beside it is the field that actually has to match. */
  function buildString() {
    const v = NR.Host && NR.Host.info && NR.Host.info.version;
    return v ? 'synx ' + v : 'synx web';
  }

  /* WHAT THIS MACHINE LOOKS LIKE.
   *
   * Sent once, at registration. It is worth being clear about what it is for,
   * because it is easy to mistake for a security measure and it is not one:
   * every field here is a value this process hands over, and anybody willing
   * to edit the game can hand over different ones. The server says so plainly
   * in its own source.
   *
   * What it actually buys is a HANDLE. The server hashes the whole set into
   * one opaque id and attaches strikes and kicks to that, so coming back after
   * being removed costs more than pressing reconnect. And the individual
   * fields make a bug report answerable: "it stutters" is unanswerable, and
   * "it stutters on a four-core machine with an integrated GPU at 2560x1440"
   * is a place to start.
   *
   * Nothing here is a stable cross-site identifier and none of it leaves this
   * one server. */
  function devicePrint() {
    const n = global.navigator || {};
    const s = global.screen || {};
    let gpu = '';
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      if (gl && ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
      else if (gl) gpu = String(gl.getParameter(gl.RENDERER) || '');
    } catch (e) { /* a context is not guaranteed */ }

    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch (e) { /* no Intl */ }

    /* The awkward half, folded into one short digest rather than sent whole.
       Each of these differs between machines for reasons that are hard to
       fake accidentally and easy to fake deliberately, which is exactly the
       weight they are given. */
    const bits = [
      String(n.hardwareConcurrency || 0),
      String(n.deviceMemory || 0),
      (n.languages || []).join(','),
      String(s.colorDepth || 0),
      String(new Date().getTimezoneOffset()),
      gpu,
      String(global.devicePixelRatio || 1),
      typeof global.__TAURI__ !== 'undefined' ? 'host' : 'web',
    ].join('|');
    let entropy = '';
    try { entropy = (NR.NetCore && NR.NetCore.digest(bits)) || ''; }
    catch (e) { entropy = ''; }

    return {
      install: installId(),
      platform: String(n.platform || (global.__TAURI__ ? 'tauri' : 'web')).slice(0, 48),
      cores: Math.min(512, n.hardwareConcurrency || 0),
      memory_gb: Math.min(4096, n.deviceMemory || 0),
      gpu: gpu.slice(0, 128),
      screen: (s.width || 0) + 'x' + (s.height || 0),
      dpr: Math.min(16, global.devicePixelRatio || 1),
      timezone: tz.slice(0, 48),
      locale: String(n.language || '').slice(0, 24),
      agent: String(n.userAgent || '').slice(0, 160),
      build: 'synx 1.0.0',
      wasm_abi: 9,
      entropy: entropy.slice(0, 64),
    };
  }

  // ------------------------------------------------------------- events ----

  /* A three-line emitter rather than a dependency. Handlers are called in the
     order they were added and one that throws does not stop the rest, because
     a lobby that stops updating because a toast threw is worse than a logged
     exception. */
  function Emitter() { this._h = Object.create(null); }
  Emitter.prototype.on = function (kind, fn) {
    (this._h[kind] || (this._h[kind] = [])).push(fn);
    return this;
  };
  Emitter.prototype.off = function (kind, fn) {
    const l = this._h[kind];
    if (!l) return this;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
    return this;
  };
  Emitter.prototype.emit = function (kind, a, b) {
    const l = this._h[kind];
    if (!l) return;
    for (let i = 0; i < l.length; i++) {
      try { l[i](a, b); }
      catch (e) { console.error('SYNX net: a "' + kind + '" handler threw', e); }
    }
  };

  // ---------------------------------------------------------------- link ----

  class Link extends Emitter {
    constructor() {
      super();
      /** 'offline' | 'waking' | 'registering' | 'connecting' | 'online' */
      this.state = 'offline';
      this.ws = null;
      this.session = null;
      this.welcome = null;
      /** The room, exactly as the server last described it. */
      this.room = null;
      /** Our seat, or -1. */
      this.slot = -1;
      this.lastError = null;
      /** The build string the server reported at the handshake. */
      this.serverBuild = '';

      this.maps = [];
      this.sendHz = 30;
      this.snapshotHz = 20;

      this._backoff = 0;
      this._closing = false;
      this._rejoin = null;
      this._sendAt = 0;
      this._timeAt = 0;
      this._timeSent = 0;
      this._stats = {};
      this._wakeAt = 0;
      this._wakePromise = null;
      /* Every pending timer this object owns, so that `disconnect` can cancel
         them rather than leave them to fire into a session that has ended.
         A reconnection attempt that lands after the player has walked back to
         the title screen reopens a socket nobody asked for and takes a seat in
         a room nobody is sitting in - which is exactly the state that shows up
         in a server log as a driver who will not leave. */
      this._timers = new Set();
    }

    get server() { return readServer(); }
    set server(v) { save().set(KEY_SERVER, String(v || '').replace(/\/+$/, '')); }

    /** The wire fingerprint of the simulation core, or 0 if it is not loaded. */
    get fingerprint() {
      return (NR.NetCore && NR.NetCore.fingerprint) >>> 0;
    }

    get name() { return save().get(KEY_NAME) || ''; }
    set name(v) { save().set(KEY_NAME, String(v || '').slice(0, 16)); }

    /** True once the player has been asked for a name at least once. */
    get named() { return !!this.name; }

    get online() { return this.state === 'online'; }
    get inRoom() { return !!(this.room && this.slot >= 0); }
    get isHost() { return !!(this.room && this.room.host === this.slot); }

    // ------------------------------------------------------------ waking --

    /**
     * Ask the server to be awake.
     *
     * Called far earlier than it is needed - the moment the multiplayer tile
     * comes into view - because a server that has been idle takes time to
     * come back and the player should be spending it reading the screen
     * rather than watching a spinner.
     *
     * Reports progress rather than merely resolving, so the interface can say
     * something true: a server that answers instantly was already up, and one
     * that takes forty seconds is one the player is waiting for.
     */
    wake(onProgress) {
      const now = performance.now();
      // A wake already in flight, or one that succeeded seconds ago, is the
      // answer. Hovering the tile four times must not be four requests.
      if (this._wakePromise && now - this._wakeAt < 20000) return this._wakePromise;
      this._wakeAt = now;

      const base = this.server;
      const started = now;
      const attempt = (n) => {
        const elapsed = performance.now() - started;
        if (onProgress) onProgress({ attempt: n, elapsed, state: 'waking' });
        if (this.state === 'offline') this.state = 'waking';
        return fetch(base + '/wake', { method: 'GET', cache: 'no-store' })
          .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then(info => {
            if (!info || !info.ready) throw new Error('not ready');
            if (this.state === 'waking') this.state = 'offline';
            if (onProgress) onProgress({ attempt: n, elapsed, state: 'ready', info });
            return info;
          })
          .catch(err => {
            if (elapsed > WAKE_TIMEOUT_MS) {
              if (this.state === 'waking') this.state = 'offline';
              this.lastError = 'the grid did not answer';
              throw err;
            }
            /* A steady two seconds rather than a backoff. This is not a
               congested server being polite to, it is a cold one being waited
               for, and the sooner the first successful request lands the
               sooner the player is racing. */
            return new Promise(r => setTimeout(r, 2000)).then(() => attempt(n + 1));
          });
      };
      this._wakePromise = attempt(1).catch(e => { this._wakePromise = null; throw e; });
      return this._wakePromise;
    }

    // ------------------------------------------------------ registration --

    /**
     * Register, and open the socket.
     *
     * The proof of work is solved in WebAssembly, in slices, between frames -
     * so the connecting screen keeps animating rather than freezing for the
     * hundred milliseconds it takes.
     */
    connect(name) {
      if (this.state === 'connecting' || this.state === 'registering') return this._connecting;
      if (this.online) return Promise.resolve(this);
      if (name) this.name = name;
      this._closing = false;

      const base = this.server;
      this.state = 'registering';
      this.emit('state', this.state);

      this._connecting = this.wake()
        .then(() => fetch(base + '/api/handshake', { cache: 'no-store' }))
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('handshake ' + r.status))))
        .then(hs => this._checkWire(hs))
        .then(hs => Promise.all([Promise.resolve(hs), this._proveWork(hs)]))
        .then(([hs, nonce]) => fetch(base + '/api/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: this.name || 'DRIVER',
            challenge: hs.challenge,
            nonce: String(nonce),
            protocol: hs.protocol,
            fingerprint: this.fingerprint,
            build: buildString(),
            device: devicePrint(),
          }),
        }))
        .then(r => r.json().then(j => (r.ok ? j : Promise.reject(refusal(j, r.status)))))
        .then(session => {
          /* The server echoes its fingerprint on the way out as well as on the
             way in. Checking it again costs nothing and closes the one gap the
             handshake check leaves: a load balancer that sent the two requests
             to instances running different builds. */
          if (session.fingerprint && this.fingerprint
              && session.fingerprint >>> 0 !== this.fingerprint) {
            return Promise.reject(new Error(WIRE_MESSAGE));
          }
          this.session = session;
          this.name = session.name;
          return this._open(base, session);
        })
        .catch(err => {
          this.state = 'offline';
          this.lastError = (err && err.message) || String(err);
          this.emit('state', this.state);
          /* The code travels with the message. A refusal at the door is not
             the same kind of event as a server that did not answer - one is
             fixed by updating the game and the other by trying again - and the
             lobby needs to be able to tell them apart to offer the right
             thing next. */
          this.emit('error', { code: (err && err.code) || 'connect', message: this.lastError });
          throw err;
        })
        .finally(() => { this._connecting = null; });
      return this._connecting;
    }

    /* DO THE TWO SIDES AGREE ABOUT WHAT A BYTE MEANS?
     *
     * The game and the server are built from separate repositories now. That
     * is the right shape - each deploys on its own schedule - but it removes
     * the guarantee that used to come free from compiling one crate into both:
     * that they agree on the wire format.
     *
     * The fingerprint is a compile-time digest of that format, computed from
     * the constants themselves rather than maintained beside them. Comparing
     * it here, before the proof of work, means a stale build is told to update
     * in the second it takes to ask - rather than after solving a challenge it
     * will not be allowed to use, and long before the real symptom, which is a
     * race that runs and is subtly wrong.
     *
     * A server too old to report one is let through: there is nothing to
     * compare against, and refusing on an absent field would make this check
     * the thing that broke the connection. */
    _checkWire(hs) {
      const mine = this.fingerprint;
      const theirs = (hs && hs.fingerprint) >>> 0;
      if (mine && theirs && mine !== theirs) {
        return Promise.reject(new Error(WIRE_MESSAGE));
      }
      if (hs && hs.protocol && NR.NetCore && NR.NetCore.protocol
          && hs.protocol !== NR.NetCore.protocol) {
        return Promise.reject(new Error(WIRE_MESSAGE));
      }
      this.serverBuild = (hs && hs.build) || '';
      return Promise.resolve(hs);
    }

    /* One slice of the proof of work per animation frame.
     *
     * Sixteen bits is about sixty-five thousand hashes and seventy
     * milliseconds in one go - long enough to drop four frames, which on the
     * one screen that is meant to feel immediate is exactly the wrong place to
     * spend them. In slices of twelve thousand it is under two milliseconds a
     * frame and completely invisible. */
    _proveWork(hs) {
      if (!hs || !hs.bits) return Promise.resolve(0);
      if (!NR.NetCore || !NR.NetCore.available) {
        return Promise.reject(new Error('the simulation core is not loaded'));
      }
      const SLICE = 12000;
      return new Promise((resolve, reject) => {
        let start = 0;
        const step = () => {
          const n = NR.NetCore.powSolve(hs.challenge, hs.bits, start, SLICE);
          if (n >= 0) return resolve(n);
          start += SLICE;
          // A challenge that has not fallen in twenty million attempts is not
          // a challenge, it is a server asking for something impossible.
          if (start > 20000000) return reject(new Error('could not solve the handshake'));
          (global.requestAnimationFrame || setTimeout)(step, 0);
        };
        step();
      });
    }

    _open(base, session) {
      return new Promise((resolve, reject) => {
        const url = base.replace(/^http/, 'ws') + (session.ws || '/ws')
          + '?token=' + encodeURIComponent(session.token);
        let ws;
        try { ws = new WebSocket(url); }
        catch (e) { return reject(e); }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        this.state = 'connecting';
        this.emit('state', this.state);

        const failed = (why) => {
          if (this.ws === ws) this.ws = null;
          reject(new Error(why));
        };
        const timer = setTimeout(() => { try { ws.close(); } catch (e) { /* gone */ } failed('the grid did not answer'); }, 15000);

        ws.onopen = () => {
          clearTimeout(timer);
          this.state = 'online';
          this._backoff = 0;
          this.lastError = null;
          if (NR.NetCore) NR.NetCore.reset(255);
          this._timeAt = 0;
          this._timeSent = 0;
          this.emit('state', this.state);
          this.emit('open');
          // The clock first: nothing else on this socket means anything until
          // the two ends agree what time it is.
          this._syncClock(true);
          resolve(this);
        };
        ws.onmessage = (e) => this._message(e);
        ws.onerror = () => { /* onclose always follows, and carries more */ };
        ws.onclose = (e) => {
          clearTimeout(timer);
          if (this.ws !== ws) return;
          this.ws = null;
          const wasOnline = this.state === 'online';
          this.state = 'offline';
          this.emit('state', this.state);
          if (wasOnline) this.emit('close', { code: e.code, reason: e.reason });
          else failed('the grid refused the connection');
          this._maybeReconnect();
        };
      });
    }

    /* IS THERE A SYNX SERVER AT THIS ADDRESS?
     *
     * Asked BEFORE an address is saved, which is the whole point. Setting the
     * server used to be unconditional: type anything, it was written to the
     * save, and the only feedback was a connection that then failed - leaving
     * the game pointed at a bad address that it would keep trying on every
     * launch until somebody worked out how to change it back. A setting that
     * can put the game into a state it cannot get out of should not be
     * settable without a check.
     *
     * WHAT IS CHECKED, and why each one is worth a separate answer:
     *
     *   1. It answers /api/handshake at all, with JSON. Rules out a typo, a
     *      dead host, and every web server on the internet that is not this
     *      one.
     *   2. The JSON has the shape a handshake has - a challenge, a difficulty,
     *      a clock, a protocol. Rules out something that serves JSON for its
     *      own unrelated reasons and would otherwise look like agreement.
     *   3. The PROTOCOL matches. A SYNX server of a different generation.
     *   4. The WIRE FINGERPRINT matches. This is the one that cannot be
     *      faked by accident: it is a compile-time digest of every opcode,
     *      field width and quantisation scale in the format, so a server that
     *      produces our number is running our wire format, and one that does
     *      not would have desynchronised this client in a way that looks like
     *      a physics bug rather than a mismatch.
     *
     * Never throws. Every failure is a `{ ok: false, why }` the interface can
     * put in front of the player, because "that did not work" is the least
     * useful thing this could say.
     */
    probe(base) {
      const url = String(base || '').replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(url)) {
        return Promise.resolve({ ok: false, why: 'an address has to start with http:// or https://' });
      }

      /* Long, and deliberately so. A free host puts an idle instance to sleep
         and a cold start is most of a minute; a five-second timeout would call
         every sleeping SYNX server invalid. */
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = global.setTimeout(() => { if (ctrl) ctrl.abort(); }, 30000);

      return fetch(url + '/api/handshake', {
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined,
      })
        .then(r => (r.ok
          ? r.json().catch(() => Promise.reject(new Error('shape')))
          : Promise.reject(new Error('status:' + r.status))))
        .then((hs) => {
          if (!hs || typeof hs !== 'object'
              || typeof hs.challenge !== 'string' || !hs.challenge
              || typeof hs.bits !== 'number'
              || typeof hs.server_time_ms !== 'number'
              || typeof hs.protocol !== 'number') {
            return { ok: false, why: 'something answered, but it is not a SYNX server' };
          }
          const ours = NR.NetCore && NR.NetCore.protocol;
          if (ours && hs.protocol && hs.protocol !== ours) {
            return {
              ok: false,
              why: 'that is a SYNX server, but it speaks protocol ' + hs.protocol
                + ' and this build speaks ' + ours,
            };
          }
          const mine = (NR.NetCore && NR.NetCore.fingerprint) >>> 0;
          const theirs = (hs.fingerprint || 0) >>> 0;
          if (mine && theirs && mine !== theirs) {
            return {
              ok: false,
              why: 'that server was built from a different version of the wire '
                + 'format; one of you needs updating',
            };
          }
          if (mine && !theirs) {
            return { ok: false, why: 'that server is too old to say what wire format it speaks' };
          }
          return { ok: true, build: hs.build || '', protocol: hs.protocol, ready: !!hs.ready };
        })
        .catch((e) => {
          const msg = String((e && e.message) || e);
          if (msg === 'shape') return { ok: false, why: 'something answered, but not with a handshake' };
          if (/^status:404/.test(msg)) return { ok: false, why: 'there is a server there, but no SYNX on it' };
          if (/^status:/.test(msg)) return { ok: false, why: 'that server answered ' + msg.slice(7) };
          if (e && e.name === 'AbortError') {
            return { ok: false, why: 'no answer in thirty seconds — if it is a free host it may be asleep' };
          }
          return { ok: false, why: 'could not reach that address at all' };
        })
        .finally(() => global.clearTimeout(timer));
    }

    // ------------------------------------------------------------ closing --

    /* Leave for good.
     *
     * Safe to call twice, safe to call when nothing is open, and it always
     * ends with this object holding no socket, no room, no seat and no
     * pending timer. That total quality is the point: every "the lobby is
     * still there after I went back to the menu" bug is some piece of this
     * having been left behind, so there is one door out and it closes
     * everything.
     *
     * The order matters. The room is told BEFORE the socket is closed, or the
     * server sees an abrupt disappearance rather than a departure - and those
     * mean opposite things to it. A departure frees the seat now; a
     * disappearance mid-race holds it for the reconnection grace, which is how
     * a room ends up with a driver in it who has gone back to the title. */
    disconnect(why) {
      this._closing = true;
      for (const t of this._timers) global.clearTimeout(t);
      this._timers.clear();

      // Say so while the socket is still open enough to carry it.
      if (this.room && this.slot >= 0) this.send({ t: 'leave' });

      this._rejoin = null;
      this.room = null;
      this.slot = -1;
      this._connecting = null;
      if (NR.NetCore) NR.NetCore.reset(255);

      const ws = this.ws;
      this.ws = null;
      // `close()` flushes what has already been queued, so the leave above
      // goes out ahead of the close frame rather than being discarded.
      if (ws) { try { ws.close(1000, why || 'left'); } catch (e) { /* already gone */ } }
      if (this.state !== 'offline') {
        this.state = 'offline';
        this.emit('state', this.state);
      }
    }

    /** A timeout this object can cancel. See `_timers`. */
    _later(fn, ms) {
      const t = global.setTimeout(() => { this._timers.delete(t); fn(); }, ms);
      this._timers.add(t);
      return t;
    }

    /* Put the player back where they were.
     *
     * A dropped connection during a race is not the same event as one in a
     * lobby, but the recovery is: reconnect, and ask for the room by its code.
     * The server holds the seat for a short grace period and hands it back
     * with the place and the progress intact, so a lift with no signal costs a
     * few seconds rather than the race. */
    _maybeReconnect() {
      if (this._closing || !this._rejoin) return;
      const wait = BACKOFF[Math.min(this._backoff, BACKOFF.length - 1)];
      if (this._backoff >= BACKOFF.length) {
        this.emit('error', { code: 'lost', message: 'lost the grid' });
        this._rejoin = null;
        return;
      }
      this._backoff++;
      this.emit('reconnecting', { attempt: this._backoff, inMs: wait });
      this._later(() => {
        if (this._closing || !this._rejoin) return;
        const code = this._rejoin;
        this.connect()
          .then(() => { this.send({ t: 'join', code }); })
          .catch(() => { /* onclose schedules the next attempt */ });
      }, wait);
    }

    // ----------------------------------------------------------- messages --

    /** Send a lobby message. */
    send(msg) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      try { this.ws.send(JSON.stringify(msg)); return true; }
      catch (e) { return false; }
    }

    _message(e) {
      if (typeof e.data === 'string') return this._text(e.data);
      // Binary is the race, and it never becomes a JavaScript object: it goes
      // straight into the core, which decodes it and moves the cars.
      if (!NR.NetCore) return;
      const bytes = new Uint8Array(e.data);
      const kind = NR.NetCore.ingest(bytes, performance.now());
      if (kind === 4) {
        // A liveness probe. The core has already queued the answer.
        const out = NR.NetCore.out();
        if (out && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(out);
      }
    }

    _text(raw) {
      let m;
      try { m = JSON.parse(raw); }
      catch (err) { return; }
      switch (m.t) {
        case 'welcome':
          this.welcome = m;
          this.maps = m.maps || [];
          this.sendHz = m.send_hz || 30;
          this.snapshotHz = m.snapshot_hz || 20;
          this.emit('welcome', m);
          break;
        case 'room': {
          const first = !this.room;
          this.room = m;
          this.slot = m.you;
          this._rejoin = m.code;
          /* The core has to know which cars are real and which seat is ours,
             or it would interpolate our own car and draw it in the past.
             `self` and `peer` rather than `reset`: a room message arrives
             every time anybody presses READY, and resetting would throw away
             the clock estimate and the playout buffer on each one - both of
             which belong to the connection rather than to the room, and both
             of which take a second of handshaking to rebuild. */
          if (NR.NetCore) {
            NR.NetCore.self(m.you);
            for (let i = 0; i < MAX_PLAYERS; i++) {
              NR.NetCore.peer(i, m.players.some(p => p.slot === i && p.slot !== m.you));
            }
          }
          this.emit('room', m, first);
          break;
        }
        case 'countdown': this.emit('countdown', m); break;
        case 'results': this.emit('results', m); break;
        case 'rooms': this.emit('rooms', m.rooms || []); break;
        case 'chat': this.emit('chat', m); break;
        case 'notice': this.emit('notice', m); break;
        case 'error':
          this.lastError = m.message;
          this.emit('error', m);
          break;
        case 'bye':
          this.lastError = m.message;
          this.emit('bye', m);
          // A farewell is the server saying not to come back, so it is not a
          // dropped connection and must not be reconnected through.
          this._rejoin = null;
          this.room = null;
          this.slot = -1;
          break;
        default: break;
      }
    }

    // -------------------------------------------------------------- clock --

    /* The clock handshake.
     *
     * Fast at first, because nothing works until it has settled, then slow,
     * because after that it is only tracking drift. The core does the
     * estimating; this only decides when to ask. */
    _syncClock(force) {
      const now = performance.now();
      const early = this._timeSent < 8;
      const every = early ? 250 : 5000;
      if (!force && now - this._timeAt < every) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !NR.NetCore) return;
      this._timeAt = now;
      this._timeSent++;
      const out = NR.NetCore.packTime(now);
      if (out) { try { this.ws.send(out); } catch (e) { /* closing */ } }
    }

    // --------------------------------------------------------- publishing --

    /**
     * Publish this client's own car, if it is time to.
     *
     * Called every frame from the game loop. Three things decide whether
     * anything is actually sent:
     *
     *   THE RATE. Thirty a second, which is twice the snapshot rate and about
     *   1.3 kB/s. Sending at the frame rate would cost four times that for
     *   information the receiving side interpolates over anyway.
     *
     *   THE BUFFER. `bufferedAmount` is how much this socket has handed to the
     *   operating system and not yet got rid of. On a healthy connection it is
     *   zero every frame. When it is not, the link is congested, and adding
     *   another packet to a queue that is not draining makes the next one
     *   later still - so the send is skipped. This is the client-side twin of
     *   the server dropping stale snapshots, and it is what stops a bad
     *   connection turning into a growing backlog of the past.
     *
     *   THE CLOCK. A state stamped before the clock has settled would be
     *   rejected as being from the wrong time, so nothing is sent until it is.
     */
    publish(car, flags, checkpoint) {
      if (!this.online || !car || !NR.NetCore) return false;
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;

      this._syncClock(false);
      const stats = NR.NetCore.stats(this._stats);
      if (!stats.synced) return false;

      const now = performance.now();
      /* The interval opens up when the round trip is long. On a link with a
         quarter-second round trip, thirty packets a second is thirty packets
         in flight at once and none of them is worth what it costs. */
      const relax = 1 + Math.min(1.5, (stats.rtt || 0) / 220);
      const interval = (1000 / this.sendHz) * relax;
      if (now - this._sendAt < interval) return false;

      // A backed-up socket is one that is already behind. 8 kB is about two
      // hundred state packets: far past a hiccup, and unmistakably a stall.
      if (ws.bufferedAmount > 8192) { this._sendAt = now; return false; }

      this._sendAt = now;
      const out = NR.NetCore.packState(car, now, flags | 0, checkpoint | 0);
      if (!out) return false;
      try { ws.send(out); } catch (e) { return false; }
      return true;
    }

    /**
     * One frame of housekeeping, whatever the game is doing.
     *
     * The clock has to keep being measured in the LOBBY as well as in a race:
     * a countdown is stated on the server's clock, and a client that only
     * synchronised while driving would meet its first countdown with an
     * estimate several minutes stale. Cheap - one small packet every few
     * seconds once it has settled.
     */
    pump() {
      if (!this.online) return;
      this._syncClock(false);
    }

    /** Everything the interface wants to show about the connection. */
    stats() {
      const s = NR.NetCore ? NR.NetCore.stats(this._stats) : this._stats;
      s.state = this.state;
      s.buffered = this.ws ? this.ws.bufferedAmount : 0;
      return s;
    }

    // ---------------------------------------------------------- shortcuts --

    /* Open a room. There is no car to choose - see maps::Ruleset on the
       server - so the field is sent as the one value it can be and is not a
       parameter anybody has to think about. */
    createRoom(map, isPrivate) {
      return this.send({ t: 'create', map: map | 0, ruleset: 'stock', private: !!isPrivate, max: 4 });
    }
    joinRoom(code) { return this.send({ t: 'join', code: String(code || '').toUpperCase() }); }
    quickPlay(map) { return this.send({ t: 'quick', map: map === undefined || map < 0 ? 255 : map | 0 }); }
    listRooms() { return this.send({ t: 'rooms' }); }
    /* Give up the seat.
     *
     * The message goes out BEFORE the local state is cleared, because `send`
     * is a no-op once `room` is null on some paths and because a leave that
     * never reached the server is exactly the bug this used to have: the lobby
     * looked empty here and stayed occupied there until a grace period
     * expired. The return value says whether it actually went. */
    leaveRoom() {
      const sent = this.send({ t: 'leave' });
      this._rejoin = null;
      this.room = null;
      this.slot = -1;
      if (NR.NetCore) NR.NetCore.reset(255);
      return sent;
    }
    setReady(on) { return this.send({ t: 'ready', on: !!on }); }
    setMap(map) { return this.send({ t: 'map', map: map | 0 }); }
    startRace() { return this.send({ t: 'start' }); }
    kick(slot) { return this.send({ t: 'kick', slot: slot | 0 }); }
    chat(text) { return this.send({ t: 'chat', text: String(text || '').slice(0, 120) }); }
  }

  NR.Net = new Link();

  /* CLOSING THE GAME IS ALSO LEAVING THE ROOM.
   *
   * Quitting, alt-F4, the title bar, a reload, the host window going away -
   * none of these are the player pressing LEAVE, and without this the server
   * finds out the slow way: the socket goes quiet, the liveness ping times out
   * after twenty-five seconds, the seat is held for another twenty-five in
   * case they are coming back, and only then is the room free. For most of a
   * minute the lobby lists a room with somebody in it who has gone.
   *
   * `disconnect` gives up the seat first and then closes, so the ordinary case
   * costs one small frame on the way out and the room is correct immediately.
   *
   * Best effort by nature. A power cut sends nothing, which is exactly what
   * the server's own liveness checks and the abandoned-room reaper are for -
   * this makes the common case instant, it does not replace them.
   *
   * `pagehide` as well as `beforeunload`: a webview that is being torn down
   * does not reliably fire the second, and firing both is harmless because
   * `disconnect` is idempotent. */
  const partOnExit = () => {
    try { if (NR.Net.online || NR.Net.inRoom) NR.Net.disconnect('closing'); }
    catch (e) { /* going away regardless */ }
  };
  global.addEventListener('beforeunload', partOnExit);
  global.addEventListener('pagehide', partOnExit);

  /* What a harness asserts against, in the shape the other modes publish
     theirs. */
  global.__SYNX_NET__ = {
    name: 'GRID LINK',
    defaultServer: DEFAULT_SERVER,
    keys: { name: KEY_NAME, install: KEY_INSTALL, server: KEY_SERVER },
    backoff: BACKOFF,
  };
})(window);
