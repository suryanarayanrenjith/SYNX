
  window.__smokeReport = async function () {
    var o = window.__smoke;
    var r = {
      errors: o.errors, warnings: o.warnings, net: o.net, notes: o.notes,
      started: true, state: "dom", sceneReady: true, frames: 0,
    };
    if (document.getElementById("rows")) {
      r.dom = {
        rows: document.querySelectorAll("#rows .row").length,
        tabs: document.querySelectorAll("#tabs .tab").length,
      };
    }
    if (window.__smokeExercise) {
      try { r.exercise = await window.__smokeExercise(); }
      catch (e) { r.exercise = { errors: ["exerciser threw: " + e.message], tabs: [], rows: [] }; }
    }
    return r;
  };
