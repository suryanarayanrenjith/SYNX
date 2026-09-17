
(function () {
  /* The clearance audit is switched on before a line of the game has run,
     because it is read when the world is BUILT and the world is built long
     before any probe gets a frame. Costs nothing unless --probe clear asked
     for it. See auditClear in js/scene.js. */
  if (/[?&]clear=1/.test(location.search) || window.__wantClear) {
    window.NR = window.NR || {};
    window.NR.CLEAR_AUDIT = 1;
  }
  var out = { errors: [], warnings: [], net: [], notes: [] };
  window.__smoke = out;
  /* js/net.js reads this before the save file and before its own default, so
     the probe can point the whole multiplayer stack at a local server without
     touching a line of the game. */
  if (window.__SMOKE_SERVER) window.SYNX_SERVER = window.__SMOKE_SERVER;
  var ce = console.error, cw = console.warn;
  console.error = function () { out.errors.push(Array.prototype.join.call(arguments, ' ')); ce.apply(console, arguments); };
  console.warn = function () { out.warnings.push(Array.prototype.join.call(arguments, ' ')); cw.apply(console, arguments); };
  window.addEventListener('error', function (e) {
    if (e.target && e.target.src) { out.net.push('failed to load ' + e.target.src); return; }
    out.errors.push('uncaught: ' + (e.message || e) + ' @' + (e.filename || '?') + ':' + (e.lineno || 0));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    out.errors.push('unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason));
  });
})();
