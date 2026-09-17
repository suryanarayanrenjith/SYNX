
  window.__smokeExercise = async function () {
    var S = window.NR && window.NR.Settings;
    var out = { tabs: [], rows: [], errors: [] };
    if (!S) { out.errors.push("settings schema missing"); return out; }

    function snapshot() {
      try {
        return (localStorage.getItem(S.LAUNCHER_KEY) || "") + "|" +
               (localStorage.getItem(S.KEY) || "");
      } catch (e) { return ""; }
    }
    function rowsNow() { return document.querySelectorAll("#rows .row"); }

    var tabs = document.querySelectorAll("#tabs .tab");
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].click();
      var n = rowsNow().length;
      out.tabs.push({ tab: tabs[t].textContent, rows: n });
      if (!n) out.errors.push("tab " + tabs[t].textContent + " built no rows");
      for (var i = 0; i < n; i++) {
        var live = rowsNow()[i];
        if (!live) continue;
        var label = (live.querySelector(".lbl") || {}).textContent || "?";
        var shown = (live.querySelector(".txt") || {}).textContent || "";
        var inc = live.querySelectorAll(".val button")[1];
        var atEnd = !inc || inc.disabled;
        var before = snapshot();
        if (inc && !inc.disabled) inc.click();
        /* Let the write land. The launcher chains its saves onto a promise
           so two clicks cannot interleave. The queue is the tail of that
           chain, and awaiting it is exactly what 'the save this click started
           has finished' means. */
        var app = window.__SYNX_LAUNCHER__;
        if (app && app._queue) { try { await app._queue; } catch (e) { /* reported below */ } }
        var after = snapshot();
        var live2 = rowsNow()[i];
        var shown2 = live2 ? ((live2.querySelector(".txt") || {}).textContent || "") : "";
        out.rows.push({
          tab: tabs[t].textContent, label: label, from: shown, to: shown2,
          atEnd: atEnd, saved: before !== after, redrew: shown !== shown2
        });
      }
    }
    return out;
  };
