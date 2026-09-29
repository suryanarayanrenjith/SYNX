/* SYNX - IS THERE AN INTERNET?
 *
 * One answer, shared by every screen that needs it: the launcher shows it
 * beside the build number, the driver terminal locks MULTIPLAYER on it, and the
 * multiplayer screen believes it before spending half a minute waking a server
 * that cannot be reached.
 *
 * WHY NOT navigator.onLine. It is only trustworthy when it says NO. Yes means a
 * network interface is up - which a captive portal, a router that has lost its
 * uplink and a cable into a switch with nothing behind it all satisfy. So it is
 * used to say no at once, and never to say yes: yes is PROVEN, by a request
 * that went out across the internet and came back.
 *
 * THE PROBES, in order, and the first to come back decides it:
 *
 *   1. The SYNX site's /api/version. A few hundred bytes, answered from
 *      Vercel's edge cache - and it carries the newest version of the game, so
 *      the launcher's update check costs no request of its own (updater.js).
 *   2. A host that has nothing to do with SYNX, so that the site being down is
 *      not mistaken for the player being offline.
 *
 * Any response at all counts, a 404 or a 502 included: it still crossed the
 * internet to get here. Only a request that never came back is a no.
 *
 * WHEN IT ASKS - which is what keeps it free:
 *
 *   - once, when start() is called;
 *   - when the system says the network changed (the online and offline events,
 *     and navigator.connection where the webview has it);
 *   - when a screen that cares is opened - fresh(maxAge) asks only if the last
 *     answer is older than that;
 *   - while OFFLINE, again after 5, 10, 20 and 40 seconds and then every
 *     minute, so a cable plugged back in is noticed without anybody pressing
 *     anything;
 *   - while ONLINE, every five minutes, so a router that loses its uplink
 *     without the machine noticing is found out eventually;
 *
 * and never while the page is hidden: a check that falls due then runs the
 * moment it is shown again. One request is in flight at a time, and a second
 * ask while one is out simply joins it.
 *
 * IT NEVER LOGS AND NEVER THROWS. A failed probe is the expected answer on an
 * offline machine, not an error - and the smoke harness counts every
 * console.error and every unhandled rejection as a failure.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};
  if (NR.Connectivity) return;

  /* Where the SYNX site is. The host carries the same address for the
     window it opens the site in - see src-tauri/src/site.rs. */
  const SITE = 'https://synx-racing.vercel.app';

  const PROBES = [
    { url: SITE + '/api/version', mode: 'cors', release: true },
    { url: 'https://cloudflare.com/cdn-cgi/trace', mode: 'no-cors', release: false },
  ];
  const TIMEOUT_MS = 4500;
  const RETRY_OFFLINE = [5000, 10000, 20000, 40000, 60000];
  const RECHECK_ONLINE = 5 * 60 * 1000;

  const now = () => Date.now();

  /* One request that gives up after TIMEOUT_MS. Resolves to the Response, or
     to null - never rejects. `no-store` so an answer from the webview's own
     cache can never stand in for a trip across the internet. */
  function ask(p) {
    let ctrl = null, timer = 0;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    const opts = {
      method: 'GET', mode: p.mode, cache: 'no-store', credentials: 'omit',
      referrerPolicy: 'no-referrer', redirect: 'follow',
    };
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = global.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    }
    let req;
    try { req = global.fetch(p.url, opts); } catch (e) { req = Promise.reject(e); }
    return req.then((res) => res, () => null).then((res) => {
      if (timer) global.clearTimeout(timer);
      return res;
    });
  }

  /* The newest release, out of /api/version's answer - or null for anything
     that does not look like one. A captive portal cannot fake a TLS answer,
     but a proxy returning its own JSON can, and nothing downstream should
     have to wonder.
     No URLs are kept from it. The download page is opened by the host, which
     builds the address itself (open_site), so a link out of a network answer
     would only be something a later change could be tempted to navigate to. */
  function readRelease(body) {
    if (!body || typeof body !== 'object') return null;
    const v = String(body.version || '');
    if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(v)) return null;
    const at = String(body.published_at || '');
    return {
      version: v,
      tag: 'v' + v,
      // shown as text in a tooltip, and only if it reads as a date
      publishedAt: /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : '',
      stale: !!body.stale,
    };
  }

  class Connectivity {
    constructor() {
      /** 'unknown' until the first answer, then 'online' or 'offline'. */
      this.state = 'unknown';
      /** Why the last answer was what it was, in words - for a tooltip. */
      this.why = '';
      this.checkedAt = 0;
      this.changedAt = 0;
      /** Round trip of the last probe that answered, in milliseconds. */
      this.rtt = 0;
      /** The newest SYNX release, once the site has answered. See readRelease. */
      this.release = null;
      this.listeners = new Set();
      this.inflight = null;
      this.timer = 0;
      this.misses = 0;
      this.due = false;
      this.started = false;
    }

    get online() { return this.state === 'online'; }
    get offline() { return this.state === 'offline'; }

    /** fn(kind, this) on every change: kind is 'state' or 'release'. Returns an unsubscribe. */
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    emit(kind) {
      for (const fn of Array.from(this.listeners)) {
        try { fn(kind, this); } catch (e) { /* a listener's fault is not the monitor's */ }
      }
    }

    /** Start listening and ask once. Safe to call more than once. */
    start() {
      if (this.started) return this;
      this.started = true;
      const w = global;
      w.addEventListener('offline', () => this.settle('offline', 'the system reports no network'));
      w.addEventListener('online', () => { this.misses = 0; this.check(); });
      const c = w.navigator && w.navigator.connection;
      if (c && typeof c.addEventListener === 'function') c.addEventListener('change', () => this.check());
      if (w.document) {
        w.document.addEventListener('visibilitychange', () => {
          if (w.document.visibilityState !== 'visible') return;
          if (this.due) this.check();
          else this.fresh(60000);
        });
      }
      this.check();
      return this;
    }

    /** Ask now. Resolves to the state; joins a request already in flight. */
    check() {
      if (this.inflight) return this.inflight;
      this.clearTimer();
      this.due = false;
      if (global.navigator && global.navigator.onLine === false) {
        this.checkedAt = now();
        this.settle('offline', 'the system reports no network');
        return Promise.resolve(this.state);
      }
      const t0 = now();
      this.inflight = this.probe().then((got) => {
        this.checkedAt = now();
        if (got) {
          this.rtt = got.rtt || now() - t0;
          if (got.release && (!this.release || got.release.version !== this.release.version
              || got.release.stale !== this.release.stale)) {
            this.release = got.release;
            this.emit('release');
          }
          this.settle('online', 'the internet answered in ' + this.rtt + ' ms');
        } else {
          this.settle('offline', 'nothing on the internet answered');
        }
        return this.state;
      }).then((s) => { this.inflight = null; this.schedule(); return s; },
        () => { this.inflight = null; this.schedule(); return this.state; });
      return this.inflight;
    }

    /** Ask only if the last answer is older than maxAgeMs. Resolves to the state. */
    fresh(maxAgeMs) {
      if (this.inflight) return this.inflight;
      if (this.state !== 'unknown' && now() - this.checkedAt < (maxAgeMs || 0)) return Promise.resolve(this.state);
      return this.check();
    }

    /* The probes, one after the other: { rtt, release } from the first that
       answers, or null when none does. */
    probe() {
      let i = 0;
      const next = () => {
        if (i >= PROBES.length) return Promise.resolve(null);
        const p = PROBES[i++];
        const t0 = now();
        return ask(p).then((res) => {
          if (!res) return next();
          const rtt = now() - t0;
          if (!p.release || !res.ok) return { rtt, release: null };
          const type = (res.headers && res.headers.get('content-type')) || '';
          if (!/json/i.test(type)) return { rtt, release: null };
          return res.json().then((body) => ({ rtt, release: readRelease(body) }),
            () => ({ rtt, release: null }));
        });
      };
      return next();
    }

    settle(state, why) {
      this.why = why || '';
      if (state === 'offline') this.misses++;
      else this.misses = 0;
      if (state !== this.state) {
        this.state = state;
        this.changedAt = now();
        this.emit('state');
      }
      if (!this.inflight) this.schedule();
    }

    schedule() {
      this.clearTimer();
      if (!this.started) return;
      const wait = this.state === 'offline'
        ? RETRY_OFFLINE[Math.max(0, Math.min(this.misses - 1, RETRY_OFFLINE.length - 1))]
        : RECHECK_ONLINE;
      this.timer = global.setTimeout(() => {
        this.timer = 0;
        const doc = global.document;
        if (doc && doc.visibilityState === 'hidden') { this.due = true; return; }
        this.check();
      }, wait);
    }

    clearTimer() {
      if (this.timer) { global.clearTimeout(this.timer); this.timer = 0; }
    }
  }

  NR.Connectivity = new Connectivity();
  NR.Connectivity.SITE = SITE;
})(window);
