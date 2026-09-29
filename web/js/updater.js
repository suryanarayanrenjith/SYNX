/* SYNX - IS THERE A NEWER BUILD?
 *
 * The launcher's update check. It sends nothing of its own: the connectivity
 * monitor's first probe is the SYNX site's /api/version, which answers with the
 * newest release (see connectivity.js), so this only compares that against the
 * build that is running and says whether it is behind.
 *
 * WHY THE PAGE AND NOT THE HOST. Asking from Rust would mean compiling an HTTP
 * client and a TLS stack into the executable to do what the webview already
 * does, on a connection it already has open. The host's part is the window the
 * site opens in - see open_site in src-tauri/src/main.rs.
 *
 * NUMBERS, NOT STRINGS. Versions are major.minor.patch, compared as numbers, so
 * 1.0.10 is newer than 1.0.9. A build newer than every release - a developer's,
 * say - is never told to "update" to an older one, and a version this cannot
 * read is never told anything.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};
  if (NR.Updater) return;

  function parse(v) {
    const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(String(v == null ? '' : v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  /** Negative, zero or positive as a is older than, the same as, or newer than b. 0 if either is unreadable. */
  function compare(a, b) {
    const x = parse(a), y = parse(b);
    if (!x || !y) return 0;
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }

  NR.Updater = {
    parse,
    compare,
    /**
     * fn({ current, latest, behind, release }) once the newest version is
     * known, and again whenever it changes while the screen is open. Returns
     * an unsubscribe. Does nothing for a version it cannot read.
     */
    watch(current, fn) {
      const C = NR.Connectivity;
      if (!C || !parse(current)) return () => {};
      let told = '';
      const look = () => {
        const r = C.release;
        if (!r || !parse(r.version) || r.version === told) return;
        told = r.version;
        try {
          fn({ current, latest: r.version, behind: compare(r.version, current) > 0, release: r });
        } catch (e) { /* the screen's problem, not the check's */ }
      };
      look();
      return C.subscribe((kind) => { if (kind === 'release') look(); });
    },
  };
})(window);
