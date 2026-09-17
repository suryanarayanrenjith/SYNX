
(function () {
  var HOLD = '${hold}';
  var FREEROAM = '${freeroam}';
  var PROBE = '${probe}';
  var AT = '${at}';
  var REEL = '${reel}';
  var PARK = '${park}';
  var STEER = '${steer}';
  var PRESS = '${press}';
  var LOOK = '${look}';
  var step = 0, at = 0, frames = 0;
  /* --reel puts the title drive at one place on the course. The reel entry is
     whichever one contains that arc length, so the cut order and the shot
     list after it are the reel's own - this only chooses where to come in. */
  var placeReel = function (g) {
    if (!REEL || g.__reelSet) return;
    g.__reelSet = 1;
    var want = parseFloat(REEL), R = window.NR.ATTRACT_REEL || [];
    for (var i = 0; i < R.length; i++) {
      if (want >= R[i].from && want < R[i].to) {
        g.attractReel = { i: i, s: want, air: null };
        g.attractCut = true;
        note('reel: started at s=' + want + ' in ' + R[i].name);
        return;
      }
    }
    note('PROBLEM: s=' + want + ' is not inside any reel stretch');
  };
  var note = function (t) { window.__smoke.notes.push(t); };
  // proof of life for the report: see the noreport branch in the runner
  if (window.__smoke) window.__smoke.driver = 1;
  function tick() {
    requestAnimationFrame(tick);
    /* The advisory is a modal the driver has no input layer to dismiss, so it
       would otherwise cover every frame and every screenshot. --hold advisory
       and --probe advisory are the two cases that want it left up.

       BEFORE THE GAME EXISTS, NOT AFTER. This used to sit under the guard
       below, and the guard is window.__nr - which main.js does not create
       until the notice has been dismissed. The harness was waiting for a game
       that was waiting for the harness, so every run reported a game that
       never started and no frames at all, on a page that was working fine. */
    /* ...and --hold ignition leaves the cold open up, which is the only way
       to photograph a screen whose whole job is to be gone by the time
       anything else has started. It holds the notice too, because the one
       call that skips the engine is the one that dismisses the notice. */
    if (PROBE !== 'advisory' && PROBE !== 'shell'
        && HOLD !== 'advisory' && HOLD !== 'ignition'
        && window.NR && window.NR.dismissAdvisory) window.NR.dismissAdvisory();

    /* ------------------------------------------- LEANING ON THE ENTER KEY
     *
     * The report: holding ENTER through the SYNX intro walked the game
     * straight into a chapter without the player seeing a screen.
     *
     * WHY IT HAPPENS, which is also why this probe is shaped the way it is.
     * By the time the intro is on screen the game has finished loading and
     * the TITLE MENU IS ALREADY LIVE UNDERNEATH IT, with START selected.
     * The intro listened for a key to skip on and did not consume it, so
     * one press did two things: it took the intro down, and the same event
     * carried on to the input layer and confirmed START. The next opened
     * the mode terminal, the one after that chose STORY.
     *
     * So this waits for exactly that state - menu live, veil up - and only
     * then starts pressing. Spamming from the first frame instead, which
     * is what the first version of this did, races the load: on this
     * software rasteriser the whole opening is gone before the pack has
     * finished decoding, the menu was never live behind it, and the leak
     * has nothing to leak into. It passed on a build with the bug in it.
     *
     * REAL EVENTS, at the real target. Dispatched on document.body so the
     * path is a keyboard's - window capture, document capture, then back
     * out to the window listeners the input layer uses. Calling the skip
     * API would pass the broken build for the same reason.
     */
    if (PROBE === 'spam') {
      var K = window.__spam || (window.__spam = {
        hits: 0, after: 0, armed: 0, leaked: 0, confirms: 0, first: null, done: false,
      });
      var gm = window.__nr;
      var veil = document.querySelector('.intro-veil');
      // not until the menu it could leak into is actually there
      if (!K.armed && !(gm && gm.state === 'menu' && veil)) return;

      /* Count what the menu does from the moment the first press lands. */
      if (gm && !K.hook) {
        K.hook = 1;
        var realConfirm = gm.confirm.bind(gm);
        gm.confirm = function () {
          if (K.armed && !K.done) K.confirms++;
          return realConfirm.apply(null, arguments);
        };
      }

      var press = function () {
        ['keydown', 'keyup'].forEach(function (ty) {
          try {
            document.body.dispatchEvent(new KeyboardEvent(ty, {
              key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
            }));
            K.hits++;
          } catch (e) { /* older webview: nothing to spam with */ }
        });
      };

      if (veil) {
        K.armed = 1;
        K.after = 0;

        /* ---------------------------------- THE ONE PRESS THAT DECIDES IT
         *
         * Everything else in this probe is the symptom. THIS is the bug:
         * with the intro on screen, does a press reach the input layer
         * underneath it?
         *
         * It has to be measured on the FIRST press and on nothing else. The
         * intro is dismissed by that press, so every press after it lands on
         * a title screen with no modal over it and is supposed to reach the
         * input layer - a probe that fires a burst and then looks cannot
         * tell the two apart, which is how three earlier versions of this
         * check passed a build with the leak in it.
         *
         * One press, read immediately, against an input layer cleared the
         * instant before. A modal that consumes its key leaves that empty. A
         * modal that merely listens leaves ENTER sitting in it, waiting for
         * the next update to confirm START - and START is the mode terminal,
         * and the row under the cursor there is STORY.
         *
         * It does not care how fast the frames are, which is the point: the
         * player who reported this was pressing thirty times a second and
         * this harness manages about one.
         */
        if (K.first === null && gm.input) {
          gm.input.pressed = Object.create(null);
          gm.input.keys = Object.create(null);
          press();
          K.first = !!(gm.input.pressed.enter || gm.input.keys.enter);
          note('spam: with the intro up, one ENTER ' +
               (K.first ? 'REACHED the input layer underneath'
                        : 'was consumed by the intro, as a modal must'));
          if (K.first) {
            note('PROBLEM: the intro reads the key without consuming it - ' +
                 'the press also lands on the title menu behind it');
          }
          return;
        }

        // ...and then lean on it, the way the report describes
        for (var sp = 0; sp < 4; sp++) press();
        if (gm.input && (gm.input.pressed.enter || gm.input.keys.enter)) K.leaked++;
        return;
      }

      if (!K.done && K.armed) {
        /* The intro is gone. STOP PRESSING - a player who keeps hammering a
           title screen is entitled to end up in the menu, and that is not
           what was reported - and let it settle before reading where the
           game ended up. */
        if (++K.after < 10) return;
        K.done = true;
        var mode = (gm && gm.story && gm.story.mode) || 'none';
        note('spam: ' + K.hits + ' ENTER events at the intro over a live menu; ' +
             'the menu confirmed ' + K.confirms + ' time(s); the game is in ' +
             'state=' + ((gm && gm.state) || '?') + ' storyMode=' + mode);
        if (mode !== 'none') {
          note('PROBLEM: spamming ENTER at the intro started story mode');
        } else if (gm.state !== 'menu') {
          note('PROBLEM: the intro handed over in state ' + gm.state +
               ' rather than at the title');
        } else if (K.confirms) {
          note('PROBLEM: ' + K.confirms + ' press(es) confirmed a menu row through the opening');
        } else {
          note('spam: the intro consumed its press and handed over at the title');
        }
        PROBE = '';
      }
      // ...and once it has reported, the run carries on as any other does
      if (!K.done) return;
    }
    /* ...and the opening camera move behind it. The harness measures the
       game in its settled state; six seconds of a scripted camera would put
       every probe six seconds later and make the camera probe measure the
       intro instead of the view it is checking. */
    if (PROBE !== 'intro' && PROBE !== 'shell' && PROBE !== 'spam'
        && window.NR && window.NR.Intro) window.NR.Intro.skip();
    var g = window.__nr;
    if (!g) return;
    frames++; g.__smokeFrames = frames;
    /* HOW STRAIGHT THE RIVAL DRIVES.
     *
     * A car that is dashing from one edge of the road to the other and back
     * looks, in a screenshot, exactly like a car taking a racing line. The
     * difference is in the total: a line wanders a few units per second, a
     * car chattering between the edges covers hundreds.
     *
     * This is here because Chapter 7's boss did precisely that - Chapter 6
     * left its lane-hint closure installed on the shared driver, so the R-IX
     * was being told to sit at +/-13 whenever its lookahead crossed a gate
     * that belonged to another chapter. Every frame of it was 'clean'. */
    if (g.rival && g.track && g.track.project && g.state === 'racing') {
      var L = g.__lat || (g.__lat = { last: null, travel: 0, lo: 1e9, hi: -1e9, n: 0, t: 0 });
      // a vehicle carries a world position; the offset from the line is a
      // projection onto it, which is what lateral means everywhere else
      var lat = g.track.project(g.rival.x, g.rival.z, g.rival.sTrack).lateral;
      if (L.last !== null) L.travel += Math.abs(lat - L.last);
      L.last = lat;
      if (lat < L.lo) L.lo = lat;
      if (lat > L.hi) L.hi = lat;
      L.n++;
      /* REAL SECONDS, not frames over sixty. This harness runs on a software
         rasteriser and draws about one frame a second, so a per-frame rate
         normalised against 60 Hz would read forty times too low - and the
         first version of this gated on a frame COUNT it could never reach. */
      L.t += g.__realDt || 0;
    }
    var nowT = performance.now();
    g.__realDt = Math.min(0.1, (nowT - (g.__lastT || nowT)) / 1000);
    g.__lastT = nowT;
    if (!g.scene || !g.scene.ready) return;
    at++;
    try { run(g); } catch (e) { window.__smoke.errors.push('driver: ' + e.message); }
  }
  function run(g) {
    if (HOLD === 'advisory') return;       // leave the notice up, for a shot
    /* HELD, AND THEN DRAWN.
       The solver writes both of these back on its own next step, and this
       hook runs on a rAF of its own rather than inside the game's loop - so
       setting them is not enough on its own, because the game's next draw may
       come after its next update. Setting them and drawing immediately makes
       the last frame on screen the posed one, which is what the screenshot
       at the end of the run captures. */
    if (step >= 1 && g.car && (STEER || PRESS)) {
      if (STEER) { g.car.steer = parseFloat(STEER); g.car.steerVisual = g.car.steer; }
      if (PRESS) g.boostPress = parseFloat(PRESS);
      try { g.draw(1 / 60); } catch (e) { /* mid-load */ }
    }
    if (PROBE === 'shell') {
      /* THE SHELL: the notice, the pointer, and the keyboard handover.
       *
       * Five things that are only true in a real browser, and every one of
       * them was reported by a player rather than caught here:
       *
       *   the notice draws a scrollbar down its side
       *   the system pointer appears on CONTINUE, next to the drawn one
       *   the drawn pointer is painted under the notice it is meant to click
       *   the menu theme plays over a photosensitivity warning
       *   two quick presses of ENTER walk through three screens
       */
      var H = g.__shell || (g.__shell = { n: 0 });
      H.n++;
      if (H.n === 1) {
        var adv = document.getElementById('advisory');
        var frame = document.querySelector('.adv-frame');
        var go = document.getElementById('advGo');
        var cur = document.getElementById('synxCursor');
        if (!adv || !frame || !go) { note('PROBLEM: the notice is not on screen to measure'); PROBE = ''; return; }

        // 1. the scrollbar, which is the width the content is inset by
        /* offsetWidth includes the border and clientWidth does not, so the
           difference is the border plus the scrollbar - and this card has a
           one-pixel border on each side. Subtract them or a card with no
           scrollbar at all reports two pixels of one. */
        var fs2 = getComputedStyle(frame);
        var edges = parseFloat(fs2.borderLeftWidth) + parseFloat(fs2.borderRightWidth);
        var bar = frame.offsetWidth - frame.clientWidth - edges;
        note('shell: the notice reserves ' + bar + 'px for a scrollbar (overflow ' +
             (frame.scrollHeight - frame.clientHeight) + 'px)');
        if (bar > 0) note('PROBLEM: the notice is drawing a scrollbar');

        // 2. the system pointer on the one control it has
        var cs = getComputedStyle(go).cursor;
        note('shell: CONTINUE asks for cursor "' + cs + '"');
        if (cs !== 'none') note('PROBLEM: the system cursor shows on CONTINUE');

        /* 3. Is the drawn pointer painted ABOVE the notice? Its own z-index
           is only half the question - an ancestor that makes a stacking
           context traps it however high it asks to be, and #synxCursor sits
           inside #stage. Walk up and report anything that would. */
        if (!cur) { note('PROBLEM: there is no drawn cursor element'); }
        else {
          var trap = null;
          for (var e = cur.parentElement; e && e !== document.body; e = e.parentElement) {
            var st = getComputedStyle(e);
            var makes = (st.zIndex !== 'auto' && st.position !== 'static')
              || st.transform !== 'none' || st.filter !== 'none'
              || st.willChange.indexOf('transform') >= 0 || st.opacity !== '1'
              || st.isolation === 'isolate' || st.mixBlendMode !== 'normal';
            if (makes) { trap = e.id || e.className || e.tagName; break; }
          }
          note('shell: the drawn cursor is z-index ' + getComputedStyle(cur).zIndex +
               ', notice is ' + getComputedStyle(adv).zIndex +
               ', trapped by ' + (trap || 'nothing'));
          if (trap) note('PROBLEM: the drawn cursor is inside a stacking context (' + trap + ')');
        }

        // 4. nothing may be playing while the notice is up
        var track = g.audio && (g.audio.trackKey || g.audio.current || g.audio.track);
        note('shell: music while the notice is up = ' + JSON.stringify(track || null) +
             ', held=' + !!g.musicHeld);
        if (!g.musicHeld) note('PROBLEM: the music hold was released before the notice came down');
        return;
      }
      if (H.n === 2) {
        /* DISMISSED WITH A REAL KEY, not by calling the API.

           The bug was that ENTER on the notice both pressed CONTINUE and
           carried on to the window listeners underneath, so the menu behind
           it confirmed START in the same frame and the player landed in a
           chapter list having never seen the title screen. Calling
           dismissAdvisory instead of pressing a key passes on the broken
           build, which makes it the wrong way to test this. */
        H.stateBefore = g.state;
        H.btn = document.getElementById('advGo');
        note('shell: before any key, CONTINUE is ' +
             (H.btn && H.btn.disabled ? 'disabled' : 'ARMED'));
        if (H.btn && !H.btn.disabled) {
          note('PROBLEM: CONTINUE was live before the warning had finished');
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        return;
      }
      if (H.n === 3) {
        // the first key completes the text and arms the button - it must NOT leave
        var still = document.getElementById('advisory');
        note('shell: after one ENTER the notice is ' + (still ? 'still up' : 'GONE') +
             ' and CONTINUE is ' + (H.btn && H.btn.disabled ? 'disabled' : 'armed'));
        if (!still) note('PROBLEM: one key dismissed the warning before it was read');
        if (H.btn && H.btn.disabled) note('PROBLEM: the reveal finished but CONTINUE never armed');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        H.leftAt = g.time;
        return;
      }
      if (H.n === 4) {
        if (g.time - H.leftAt < 0.5 && H.n < 200) { H.n--; return; }
        var gone = !document.getElementById('advisory');
        note('shell: the second ENTER left the notice ' + (gone ? 'dismissed' : 'UP') +
             ' and the game in "' + g.state + '" (was "' + H.stateBefore + '")');
        if (!gone) note('PROBLEM: the notice would not dismiss');
        if (g.state !== H.stateBefore) {
          note('PROBLEM: the key that dismissed the notice also moved the game to ' + g.state);
        }
        if (window.NR.Intro) window.NR.Intro.skip();
        return;
      }
      if (H.n === 6) {
        H.was = g.state;
        note('shell: settled on state "' + H.was + '" with music ' +
             (g.musicHeld ? 'still held' : 'released'));
        /* COUNTED, NOT INFERRED.
         *
         * The first version of this fired four ENTERs, saw the state had not
         * moved, and called the gate proved. It proved nothing: a synthetic
         * key that never reaches the input layer produces exactly the same
         * reading as a gate that swallowed it, and so does a menu whose
         * confirm path is broken. So count the confirms instead of reading
         * the state, and take a control measurement afterwards with the gate
         * open - a test that cannot fail is not a test. */
        H.confirms = 0;
        var realConfirm = g.confirm.bind(g);
        g.confirm = function () { H.confirms++; return realConfirm(); };
        /* Opened deliberately, so this is the scenario the player
           described rather than whatever the gate happened to be doing: four
           presses arriving at a screen that was ready for the first one. */
        /* WHO SHUT IT, if anyone does. The burst was reading one of four
           on one run and zero on the next, and the two look identical from
           the outside: a press is DISCARDED when the gate is shut, not held
           - so an unrelated state change landing between the dispatch and
           the frame that reads it swallows the whole burst. Recording the
           locks turns "sometimes zero" into a sentence about why. */
        H.locks = 0;
        H.who = [];
        var realLock = window.NR.Gate.lock.bind(window.NR.Gate);
        window.NR.Gate.lock = function (ms) {
          H.locks++;
          if (H.who.length < 4) {
            var st = (new Error()).stack || "";
            H.who.push((st.split(String.fromCharCode(10))[2] || "?").trim().slice(0, 70));
          }
          return realLock(ms);
        };
        if (window.NR.Gate) window.NR.Gate.clear();
        H.gateWas = !!(window.NR.Gate && window.NR.Gate.open());
        // ...and whether the loop that reads the keys is running at all
        H.clock = g.time;
        for (var i = 0; i < 4; i++) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        }
        return;
      }
      /* WAIT FOR THE GAME, NOT FOR THIS PROBE.

         This runs from the harness driver, which ticks on every animation
         frame. The game does not: on a software rasteriser it steps about
         once a second, and with GPU frame pacing on it deliberately declines
         the frames in between. So counting probe ticks measured nothing -
         two of them is thirty milliseconds, during which the game had not
         run a single frame and could not possibly have read the keys. It
         read one press on one run and none on the next, and neither number
         was about the gate.

         Half a second of the GAME clock is at least one stepped frame however
         slow the renderer is. Same lesson as counting frames rather than
         seconds elsewhere in here, one level further down: count the thing
         being measured. */
      if (H.confirms !== undefined && !H.reported
          && (g.time - H.clock >= 0.5 || H.n > 300)) {
        H.reported = 1;
        note('shell: four rapid ENTERs (gate was ' + (H.gateWas ? 'open' : 'shut') +
             ') produced ' + H.confirms + ' confirm(s), state "' + H.was + '" -> "' + g.state + '"');
        var ran = g.time - H.clock;
        note('shell: the game clock advanced ' + ran.toFixed(2) + 's across the burst, pacing ' +
             (g.fencesOff ? 'given up' : 'on'));
        if (ran < 0.001) {
          note('PROBLEM: no frame was stepped between the presses and the read');
        }
        note('shell: the gate was shut ' + H.locks + ' time(s) during the burst' +
             (H.who.length ? ' by ' + H.who.join(' | ') : ''));
        if (H.confirms === 0 && H.locks > 0) {
          note('shell: the burst landed inside another settle window - inconclusive');
        } else if (H.confirms !== 1) {
          note('PROBLEM: ' + H.confirms + ' of four presses got through - one, and only one, should');
        }
        /* THE BURST CONTROLS ITSELF, which is why there is no second
           measurement here any more. A count of one rules out both ways this
           could read as a pass without being one: zero would mean the
           synthetic keys never reached the input layer, and four would mean
           the gate does nothing. Only a working gate on a live keyboard
           produces exactly one. */
        if (H.confirms === 1 && g.state !== H.was) {
          note('shell: one press, one screen - which is the whole of the fix');
        }
        PROBE = '';
        return;
      }
      return;
    }
    if (PROBE === 'steady' && step >= 1) {
      /* DOES THE CHOSEN VIEW STAY CHOSEN?
       *
       * The bonnet camera was flickering back to the chase view several
       * times a second in a chapter. The reason was that which view is in
       * force was decided by reading the state directly, and a chapter
       * legitimately passes through "story" while the car is still being
       * steered - a line of dialogue, a telemetry card - so the view changed
       * every time one of those happened and changed back afterwards.
       *
       * It is latched now: a run is a thing with a start and an end. What
       * this samples is the answer itself, every frame, for as long as the
       * race lasts. One value across the whole of it is the fix; two is the
       * bug, whatever the states underneath were doing.
       */
      var V = g.__steady || (g.__steady = { seen: {}, n: 0, states: {} });
      if (g.camMode !== 1) { g.camMode = 1; return; }
      V.n++;
      /* THE FLIP, ASKED AS A QUESTION RATHER THAN DONE TO THE GAME.

         A plain race never enters "story", so this bug does not live in one:
         it needs a chapter, where the director moves the state to "story"
         for a line of dialogue and back while the player keeps driving.

         Driving the live state through that mid-race was the first attempt
         and it was a bad one - the story layer takes the screen, the run
         ends, and the probe never reaches its own sample count. What is
         actually being tested is a rule, and a rule can simply be asked:
         set the backing field, which has no setter and therefore no side
         effects at all, put the question, and put it back. Against the old
         rule this reads chase; against the latch it reads the bonnet. */
      if (V.n === 12) {
        var wasState = g._state;
        g._state = 'story';
        V.duringStory = g.activeCam();
        g._state = wasState;
        V.states.story = (V.states.story || 0) + 1;
      }
      V.seen[g.activeCam()] = (V.seen[g.activeCam()] || 0) + 1;
      V.states[g.state] = (V.states[g.state] || 0) + 1;
      if (V.n === 40) {
        var views = Object.keys(V.seen);
        note('steady: over ' + V.n + ' frames the view was ' + JSON.stringify(V.seen) +
             ' while the state was ' + JSON.stringify(V.states));
        if (views.length > 1) {
          note('PROBLEM: the camera changed view ' + views.length + ' ways during one run');
        } else if (views[0] !== '1') {
          note('PROBLEM: the bonnet view was asked for and never applied');
        } else {
          note('steady: with the state reading story mid-run the view is ' + V.duringStory +
               ' - the bonnet, not the chase');
          if (V.duringStory !== 1) {
            note('PROBLEM: a story beat mid-race still drops the chosen view');
          }
        }
        PROBE = '';
      }
      return;
    }
    if (PROBE === 'block' && step >= 1) {
      /* WHAT IS IN FRONT OF THE DRIVER, BY NAME.
       *
       * A first-person view that is sometimes filled with a pale panel is a
       * report, not a diagnosis: the eye is inside the bounding boxes of six
       * different parts of its own car, and any of them could be the one
       * doing it. Guessing which has already cost two rounds.
       *
       * So this asks the renderer. Every part the car submits is projected
       * against the view axis, and anything landing within fifteen degrees
       * of the middle of the frame and close enough to matter is named,
       * nearest first. Whatever is blocking the view is at the top of that
       * list by construction.
       */
      var B = g.__block || (g.__block = { n: 0 });
      if (g.camMode !== 1) { g.camMode = 1; return; }
      B.n++;
      if (B.n < 8) return;
      if (B.done) return;
      B.done = 1;
      var sc = g.scene, real = sc.drawPart, rows = [];
      var e = g.eye, tg = g.target;
      var fx = tg[0] - e[0], fy = tg[1] - e[1], fz = tg[2] - e[2];
      var fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      sc.drawPart = function (q, m) {
        var mm = m || (q && q.m);
        if (mm) {
          var dx = mm[12] - e[0], dy = mm[13] - e[1], dz = mm[14] - e[2];
          var d = Math.hypot(dx, dy, dz);
          if (d < 4.0) {
            var ahead = dx * fx + dy * fy + dz * fz;
            var off = Math.acos(Math.max(-1, Math.min(1, ahead / (d || 1)))) * 180 / Math.PI;
            rows.push({
              n: (q.mesh && q.mesh.name) || (q.mat && q.mat.name) || "?",
              mat: (q.mat && q.mat.name) || "?",
              d: d, off: off, ahead: ahead,
            });
          }
        }
        return real.call(sc, q, m);
      };
      try { g.draw(1 / 60); } finally { sc.drawPart = real; }
      rows.sort(function (a, b) { return a.d - b.d; });
      var seen = {}, out = [];
      for (var i = 0; i < rows.length && out.length < 10; i++) {
        var r = rows[i];
        if (r.ahead < 0 || r.off > 45) continue;
        var key = r.n + "/" + r.mat;
        if (seen[key]) continue;
        seen[key] = 1;
        out.push(r.n + " [" + r.mat + "] " + r.d.toFixed(2) + "u at " + r.off.toFixed(0) + "deg");
      }
      note('block: car pitch ' + (g.car.pitch || 0).toFixed(3) + ' roll ' + (g.car.roll || 0).toFixed(3) +
           ' look ' + (g.lookYaw || 0).toFixed(3) + '/' + (g.lookPitch || 0).toFixed(3) +
           ' speed ' + (g.car.speed || 0).toFixed(0));
      note('block: in front of the eye, nearest first:');
      for (var k = 0; k < out.length; k++) note('block:   ' + out[k]);
      PROBE = '';
      return;
    }
    if (PROBE === 'lag' && step >= 1) {
      /* IS THE EYE WHERE THE DRIVER IS, AT SPEED?
       *
       * The first-person eye is a point inside the car put through the car
       * transform. If that transform is a frame old, the eye sits wherever
       * the car WAS - which at a hundred and twenty miles an hour is more
       * than a car length back, outside the bodywork, looking at the
       * dashboard over its own back edge. And because the distance is a
       * frame TIME rather than a fixed offset, it moves every time a frame
       * runs long, which is what made it read as a flicker.
       *
       * Measured as the gap between the eye and the seat it belongs to, in
       * the car own frame: forward of the car centre by about half a unit is
       * right, and it must not grow with speed.
       */
      var G = g.__lag || (g.__lag = { n: 0, worst: 0, fast: 0, samples: [] });
      if (g.camMode !== 1) { g.camMode = 1; return; }
      /* DRIVEN BY THE PROBE. The harness parks the car for a probe run, and
         a lag that only exists at speed cannot be measured standing still.
         The speed is forced rather than the throttle held, so every sample is
         at the same speed and the numbers are comparable. 74 units a second
         is the 122 mph the report came from. */
      if (g.car) { g.car.v_long = 74; g.car.vLong = 74; }
      G.n++;
      var car = g.car;
      if (car && g.activeCam() === 1) {
        var dx = g.eye[0] - car.x, dz = g.eye[2] - car.z;
        // how far along the car own nose the eye sits
        var along = dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw);
        var side = dx * Math.cos(car.yaw) - dz * Math.sin(car.yaw);
        if (car.speed > 8) {
          G.fast++;
          G.samples.push({ along: along, side: side, spd: car.speed });
          G.worst = Math.max(G.worst, Math.abs(along - 0.5));
        }
      }
      if (G.fast >= 14 && !G.done) {
        G.done = 1;
        var lo = 9, hi = -9, sLo = 9, sHi = -9, fastest = 0;
        for (var i = 0; i < G.samples.length; i++) {
          var q = G.samples[i];
          lo = Math.min(lo, q.along); hi = Math.max(hi, q.along);
          sLo = Math.min(sLo, q.side); sHi = Math.max(sHi, q.side);
          fastest = Math.max(fastest, q.spd);
        }
        note('lag: over ' + G.fast + ' frames above 8u/s (peak ' + fastest.toFixed(0) +
             ') the eye sat ' + lo.toFixed(2) + '..' + hi.toFixed(2) + 'u along the car' +
             ' and ' + sLo.toFixed(2) + '..' + sHi.toFixed(2) + 'u across it');
        /* The seat is about half a unit forward of the car centre. A spread
           bigger than a tenth of a unit is the eye moving relative to the car
           it is supposed to be bolted into, which is the bug. */
        if (hi - lo > 0.10) {
          note('PROBLEM: the eye moved ' + (hi - lo).toFixed(2) + 'u along the car at speed');
        }
        if (lo < 0.2 || hi > 0.9) {
          note('PROBLEM: the eye is not in the seat - ' + lo.toFixed(2) + '..' + hi.toFixed(2));
        }
        PROBE = '';
      }
      return;
    }
    if (PROBE === 'hand' && step >= 1) {
      /* DOES THE DRIVER ACTUALLY REACH FOR THE BOOST?
       *
       * The claim is that the right hand comes off the wheel, crosses to the
       * console and presses a button, and that the left one does not move.
       * All four halves of that are checkable: which glove moved, how far,
       * whether the arm stayed attached to it, and whether the button went
       * down. A reach that detaches the elbow looks worse than no reach.
       */
      var H = g.__hand || (g.__hand = { n: 0 });
      H.n++;
      if (H.n < 4 || H.done) return;
      H.done = 1;
      var sc = g.scene, real = sc.drawPart;
      function grab(press) {
        var out = { gloves: [], arms: [], btn: null };
        sc.drawPart = function (q, m) {
          var mm = m || (q && q.m);
          var mat = (q.mat && q.mat.name) || "";
          var mesh = (q.mesh && q.mesh.name) || "";
          if (mm && Math.hypot(mm[12] - g.car.x, mm[14] - g.car.z) < 4) {
            if (/^DriverGloveP$/.test(mat)) out.gloves.push([mm[12], mm[13], mm[14]]);
            if (mesh === "DriverLimb") out.arms.push([mm[12], mm[13], mm[14], mm[8], mm[9], mm[10]]);
            if (/^CabinBtn/.test(mat)) out.btn = [mm[12], mm[13], mm[14]];
          }
          return real.call(sc, q, m);
        };
        g.boostPress = press;
        try { g.draw(1 / 60); } finally { sc.drawPart = real; }
        return out;
      }
      g.camMode = 1;
      var rest = grab(0);
      var push = grab(1);
      g.boostPress = 0;
      if (rest.gloves.length < 2 || push.gloves.length < 2) {
        note("PROBLEM: the gloves were not drawn (" + rest.gloves.length + ")");
        PROBE = "";
        return;
      }
      var moved = [];
      for (var i = 0; i < 2; i++) {
        var a = rest.gloves[i], b = push.gloves[i];
        moved.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
      }
      moved.sort(function (x, y) { return x - y; });
      note("hand: with the boost held the two gloves moved " + moved[0].toFixed(3) +
           "u and " + moved[1].toFixed(3) + "u");
      if (moved[1] < 0.15) note("PROBLEM: neither hand left the wheel");
      if (moved[0] > 0.05) note("PROBLEM: both hands left the wheel at once");

      /* THE ARM HAS TO GO WITH IT. A bone that solves to the elbow the
         forearm USED to be at leaves the upper arm pointing into space. */
      if (rest.arms.length && push.arms.length === rest.arms.length) {
        var armMoved = 0;
        for (var k = 0; k < rest.arms.length; k++) {
          var p0 = rest.arms[k], p1 = push.arms[k];
          armMoved = Math.max(armMoved, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]));
        }
        note("hand: the upper arm followed by " + armMoved.toFixed(3) + "u");
        if (armMoved < 0.02) note("PROBLEM: the hand moved and the arm did not");
      }

      if (rest.btn && push.btn) {
        var sank = Math.hypot(rest.btn[0] - push.btn[0], rest.btn[1] - push.btn[1],
          rest.btn[2] - push.btn[2]);
        note("hand: the button sank " + (sank * 1000).toFixed(0) + "mm");
        if (sank < 0.005) note("PROBLEM: the button did not move when pressed");

        /* AND THE HAND HAS TO BE ON IT.
         *
         * Everything above was already true of a reach that ended four
         * centimetres short: the right hand moved, the left did not, the arm
         * followed, and the button went down on its own because the press is
         * a number rather than a collision. A fist hanging in the air over
         * the console passes all four - which is exactly what was reported,
         * and exactly what a check that never measured the gap could not see.
         *
         * The gloves are 0.115 long and about 0.098 deep, so a palm resting
         * on a cap 0.045 thick puts their two origins within about 0.08 of
         * each other. Twice that is a hand that is near the button; four
         * times it is a hand that is not touching anything.
         */
        var far = 0, which = -1;
        for (var gi = 0; gi < 2; gi++) {
          var d = Math.hypot(push.gloves[gi][0] - push.btn[0],
            push.gloves[gi][1] - push.btn[1], push.gloves[gi][2] - push.btn[2]);
          if (which < 0 || d < far) { far = d; which = gi; }
        }
        note("hand: at full press the nearer glove is " + (far * 1000).toFixed(0) +
             "mm from the middle of the cap");
        if (far > 0.13) {
          note("PROBLEM: the hand presses the void - it stops " +
               (far * 1000).toFixed(0) + "mm from the button");
        }
      } else {
        note("PROBLEM: the console button was not drawn");
      }
      PROBE = "";
      return;
    }
    if (PROBE === 'benchrun' && step >= 1) {
      /* Stopped halfway, so the strip that covers a run can be looked at.
         A report card is easy to photograph; the thing it replaces - a panel
         over a frozen menu - was not, and the whole point of the rewrite is
         what is behind this strip while it counts. */
      var Q = g.__brun || (g.__brun = { n: 0 });
      Q.n++;
      if (Q.n < 4 || Q.done) return;
      Q.done = 1;
      var BB = window.NR.Bench;
      g.state = "menu";
      BB.start(g, function () {});
      var gd = 0;
      while (BB.running && gd++ < 20000) {
        BB.tick(g, BB.phase === "calibrate" ? 9 : 11);
        if (BB.phase === "scene" && gd > BB.CAL_TICKS * 4 + 60) break;
      }
      note("benchrun: stopped mid-scene, strip up = "
           + !!document.querySelector(".bench-strip"));
      PROBE = "";
      return;
    }
    if (PROBE === 'bench' && step >= 1) {
      /* THE BENCHMARK, END TO END.
       *
       * Not by waiting for it. A real run is four calibration rungs and
       * three scenes of a hundred and seventy frames, and this harness
       * draws about one frame a second on a software rasteriser - twelve
       * minutes, most of it measuring a renderer nobody ships on. The frame
       * TIMES are the only thing the run takes from the outside world, so
       * they are supplied and everything else happens for real: the same
       * start, the same tick, the same camera being driven scene to scene,
       * the same arithmetic, the same panel, the same write to the save.
       *
       * The calibration times are chosen so the answer is known in advance.
       * LOW and MEDIUM come in under the sixteen-and-seven budget and HIGH
       * and ULTRA do not, so the only correct recommendation is MEDIUM. A
       * benchmark that returns anything else here is wrong in a way that
       * would otherwise only show up on somebody else's machine.
       *
       * The scene times are deliberately varied - a sawtooth with one big
       * spike in it - so the 1% low and the minimum cannot come out equal
       * to the average, which is the failure a run of identical frame times
       * would hide.
       */
      var K = g.__bench || (g.__bench = { n: 0 });
      K.n++;
      if (K.n < 4 || K.done) return;
      K.done = 1;
      var B = window.NR.Bench;
      if (!B) { note("PROBLEM: NR.Bench was never loaded"); PROBE = ""; return; }
      // the benchmark is reached from the title screen; put the game there
      g.state = "menu";

      /* IS THE TITLE SCREEN ACTUALLY GONE?
       *
       * Not "is the flag set" - the flag is the mechanism, and the mechanism
       * is what changed. What matters is that START, OPTIONS and QUIT are not
       * drawn for a single frame of the run, calibration and report included,
       * and the only honest way to ask that is to count the draws. The first
       * version of this hid the menu on benchDriving, which is only true while
       * the three scenes are being driven - so the rows were on screen for the
       * whole preset ladder in front of them and under the card behind them,
       * and a check on the flag would have called that a pass.
       */
      var drawn = 0;
      if (g.hud && g.hud.drawMenu) {
        var realMenu = g.hud.drawMenu.bind(g.hud);
        g.hud.drawMenu = function () {
          if (g.benchActive) drawn++;
          return realMenu.apply(null, arguments);
        };
      }
      /* ...and the exit is stubbed, because a probe that actually quits takes
         the page with it and there is no report to read afterwards. */
      var quits = 0;
      g.quitGame = function () { quits++; };

      var why = B.start(g, function (rec) { K.rec = rec; });
      if (why) { note("PROBLEM: the benchmark would not start - " + why); PROBE = ""; return; }
      note("bench: started in phase " + B.phase + ", strip on screen = "
           + !!document.querySelector(".bench-strip"));

      // 8ms and 12ms hold sixty; 22ms and 40ms do not
      var CAL = [8, 12, 22, 40];
      var guard = 0, sawScene = 0, drove = 0;
      var wasS = g.distance;
      while (B.running && guard++ < 20000) {
        var ms;
        if (B.phase === "calibrate") {
          var rung = Math.min(CAL.length - 1, Math.floor(guard / B.CAL_TICKS));
          ms = CAL[rung];
        } else {
          sawScene++;
          /* A sawtooth around ten milliseconds with a hitch every fortieth
             frame, so the four headline numbers are all different and the
             graph has something in it. */
          ms = 9 + (sawScene % 7) * 0.6 + (sawScene % 40 === 0 ? 26 : 0);
          if (g.distance !== wasS) { drove++; wasS = g.distance; }
        }
        B.tick(g, ms);
        /* A REAL FRAME, NOW AND THEN. The loop above drives the benchmark
           directly, so the game's own draw never runs inside it - and the
           title screen is drawn from there. Without these the menu counter
           below only ever sees the frames AFTER the report, which is one of
           the three phases it is supposed to cover, and a build that showed
           START and QUIT through the whole preset ladder would pass. Five
           draws: two in the calibration, one in each scene. */
        if (guard === 5 || guard === 120 || guard === 320 || guard === 520 || guard === 700) {
          try { g.draw(1 / 60); } catch (e) { /* mid-load */ }
        }
      }
      if (!K.rec) { note("PROBLEM: the run never finished (" + guard + " ticks)"); PROBE = ""; return; }

      var r = K.rec, s = r.summary;
      var line = "";
      for (var i = 0; i < r.calibration.length; i++) {
        line += r.calibration[i].preset + "="
          + Math.round(1000 / r.calibration[i].p95) + " ";
      }
      note("bench: calibrated " + line.trim());
      note("bench: chose " + r.preset + ", held=" + r.held + ", after " + guard + " ticks");
      if (r.calibration.length !== 4) {
        note("PROBLEM: only " + r.calibration.length + " presets were calibrated");
      }
      if (r.preset !== "MEDIUM") {
        note("PROBLEM: with 8/12/22/40ms the answer is MEDIUM, not " + r.preset);
      }
      if (!r.held) note("PROBLEM: it reported that nothing held the target when two did");

      /* ...AND IT PLAYED THE MAP. The whole point of the rewrite is that the
         report comes off three scenes of the game being driven rather than
         off a parked car, so: three scenes, each with samples in it, and the
         camera actually moved down the road while they ran. */
      note("bench: " + r.scenes.length + " scenes, "
           + r.scenes.map(function (x) { return x.name + "(" + x.ms.length + ")"; }).join(" ")
           + ", camera advanced on " + drove + " frames");
      if (r.scenes.length !== B.SCENES) {
        note("PROBLEM: " + r.scenes.length + " scenes were run, not " + B.SCENES);
      }
      for (var sc = 0; sc < r.scenes.length; sc++) {
        if (!r.scenes[sc].ms.length) {
          note("PROBLEM: scene " + r.scenes[sc].name + " measured nothing");
        }
      }
      if (drove < 10) note("PROBLEM: the camera never moved - the scenes were not driven");
      if (g.benchDriving) note("PROBLEM: the camera was never handed back");

      /* The four headline numbers have to be four different numbers, and in
         the right order: a run with a 35ms hitch in it cannot have a minimum
         equal to its average. */
      note("bench: avg " + s.avg.toFixed(1) + "  1% low " + s.low1.toFixed(1)
           + "  min " + s.min.toFixed(1) + "  max " + s.max.toFixed(1) + " FPS");
      if (!(s.max > s.avg && s.avg > s.low1 && s.low1 >= s.min)) {
        note("PROBLEM: the headline numbers are not ordered max > avg > 1% low >= min");
      }

      /* WHERE THE FRAME GOES. The split has to add up to the frame and has
         to name a bound; a report that says a machine is GPU-bound when the
         GPU share is a third is worse than saying nothing. */
      note("bench: frame " + s.frameMs.toFixed(2) + "ms = sim " + s.sim.toFixed(2)
           + " + submit " + s.sub.toFixed(2) + " + gpu " + s.gpu.toFixed(2)
           + "  (" + s.bound + "-bound " + Math.round(s.gpuBoundPct) + "% gpu)");
      if (Math.abs((s.sim + s.sub + s.gpu) - s.frameMs) > 0.01) {
        note("PROBLEM: the three parts of the frame do not add up to the frame");
      }
      if ((s.bound === "gpu") !== (s.gpuBoundPct >= 50)) {
        note("PROBLEM: the verdict disagrees with the share it is drawn from");
      }

      /* AND THE REPORT IS ON THE SAME SCREEN, which is what was asked for. */
      var card = document.querySelector(".bench.is-done .bench-card");
      var stats = document.querySelectorAll(".bench-stat b");
      var rows = document.querySelectorAll(".bench-grid .bench-row");
      var segs = document.querySelectorAll(".bench-split-bar i");
      note("bench: the card shows " + stats.length + " headline numbers, "
           + rows.length + " table rows and " + segs.length + " frame segments");
      if (!card) note("PROBLEM: the report card is not on screen");
      if (stats.length !== 4) note("PROBLEM: the four headline numbers are not all there");
      if (rows.length !== r.scenes.length + 1) {
        note("PROBLEM: the per-scene table does not have a row per scene");
      }
      if (segs.length !== 3) note("PROBLEM: the frame-split bar is not three parts");
      if (document.querySelector(".bench-strip") && 
          getComputedStyle(document.querySelector(".bench-strip")).display !== "none") {
        note("PROBLEM: the running strip is still up behind the report");
      }

      /* THE MENU STOOD DOWN FOR THE WHOLE RUN. Counted across the ladder, the
         three scenes and the report - anything above zero is a frame where a
         player was shown three controls that do nothing. */
      note("bench: the title screen was drawn " + drawn + " time(s) during the run;"
           + " benchActive is now " + !!g.benchActive);
      if (drawn) {
        note("PROBLEM: START/OPTIONS/QUIT were drawn " + drawn + " time(s) behind the benchmark");
      }
      if (!g.benchActive) {
        note("PROBLEM: the title screen came back while the report is still up");
      }

      /* AND ANY KEY LEAVES. A letter, not ESC and not ENTER - the request was
         any key, and a handler that only answers the two obvious ones is the
         same wall with a narrower door. */
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key: "k", code: "KeyK", bubbles: true, cancelable: true,
      }));
      note("bench: one keypress on the report -> quit called " + quits + " time(s), "
           + "card held for the fade = " + !!document.querySelector(".bench-card"));
      if (quits !== 1) note("PROBLEM: a key on the report did not quit the game");
      /* AND THE CARD IS STILL THERE, on purpose: quitGame fades to black over
         a quarter of a second, and the panel is held through it so the title
         screen does not flash back on its way out. */
      if (!document.querySelector(".bench-card")) {
        note("PROBLEM: the report was torn down before the quit fade - the menu will flash");
      }
      if (!g.benchActive) note("PROBLEM: the title screen came back during the quit fade");

      // ...and the result has to survive into the save, or the launcher sees nothing
      var back = window.NR.Save && window.NR.Save.getJSON
        ? window.NR.Save.getJSON(window.NR.Settings.BENCH_KEY, null) : null;
      note("bench: the save now holds " + (back ? back.preset + ", pending=" + back.pending : "NOTHING"));
      if (!back || back.preset !== r.preset) {
        note("PROBLEM: the result did not reach the save the launcher reads");
      }
      PROBE = "";
      return;
    }
    if (PROBE === 'benchboot' && step >= 1) {
      /* THE PATH THE BENCHMARK BUTTON ACTUALLY TAKES.
       *
       * The sweep itself was already covered, and it passed - which is why
       * the button appeared to do nothing while every test said it worked.
       * What was never covered was the HANDOVER: the launcher writes a flag,
       * the game reads it on boot, and decides what to do about it.
       *
       * Three things are asked here, and the last two are the damage the
       * first one used to do quietly:
       *
       *   does a pending flag actually start a sweep?
       *   is the flag cleared afterwards, so the next launch is a normal one?
       *   and if it will NOT start, does it say so rather than taking the
       *   advisory and the opening cutscene away on its way past?
       */
      var Q = g.__bboot || (g.__bboot = { n: 0, said: [] });
      Q.n++;
      if (Q.n < 4 || Q.done) return;
      Q.done = 1;
      var S = window.NR.Settings, Save = window.NR.Save;
      if (!window.NR.Bench || !window.NR.Bench.autorun) {
        note("PROBLEM: NR.Bench.autorun is not there at all");
        PROBE = "";
        return;
      }

      /* AT THE TITLE, which is where a boot-time autorun actually happens:
         main.js calls it the moment load() resolves, long before anything has
         been raced. The harness has been driving since the run began, so the
         game has to be put back where the launcher would have left it, or this
         tests a refusal rather than the handover it is for. */
      g.state = "menu";
      // exactly what the launcher writes when BENCHMARK is pressed
      Save.setJSON(S.BENCH_KEY, { pending: true, when: Date.now() });
      var began = window.NR.Bench.autorun(g, function (m) { Q.said.push(m); });
      note("benchboot: autorun saw the flag = " + began +
           ", sweep running = " + window.NR.Bench.running);
      if (!began) note("PROBLEM: the pending flag was written and autorun ignored it");

      var after = Save.getJSON(S.BENCH_KEY, null);
      note("benchboot: pending is now " + (after ? after.pending : "GONE"));
      if (after && after.pending) {
        note("PROBLEM: pending survived - every later launch would benchmark again");
      }

      if (window.NR.Bench.running) {
        note("benchboot: the panel is up = " + !!document.querySelector(".bench-strip"));
        // wind it forward so the run does not sit half finished behind the rest
        var guard = 0;
        while (window.NR.Bench.running && guard++ < 5000) window.NR.Bench.tick(g, 10);
        var done = Save.getJSON(S.BENCH_KEY, null);
        note("benchboot: finished and the save holds " + (done ? done.preset : "NOTHING"));
      } else {
        note("benchboot: it refused, and said " + JSON.stringify(Q.said));
        if (!Q.said.length) note("PROBLEM: it refused silently, which is the original bug");
      }

      /* AND THE TWO THINGS IT MUST NOT HAVE TAKEN. A refusal that removes the
         safety notice and the opening move is worse than a refusal. */
      note("benchboot: the notice is " + (document.getElementById("advisory") ? "up" : "gone"));
      PROBE = "";
      return;
    }
    if (PROBE === 'intro') {
      /* THE OPENING MOVE, MEASURED.
       *
       * Four claims, and every one of them is a way the sequence can look
       * broken rather than absent:
       *
       *   It STARTS somewhere else. A hero shot that begins at the chase
       *   pose is a six second wait for nothing.
       *
       *   It ENDS at the chase pose exactly. The whole design of the blend
       *   is that the weight reaches zero before the move does, so the last
       *   frames are the live camera and there is no hand-over to see. If
       *   the eye is still being dragged at the end, there is a snap.
       *
       *   The MENU arrives with it, rather than being switched on.
       *
       *   And it FINISHES. A move that never releases the camera is a game
       *   that cannot be played.
       *
       * Sampled per FRAME, not per second: this harness draws a few frames a
       * second on a software rasteriser, so anything gated on wall-clock
       * here either never fires or fires once at the end.
       */
      var N = g.__intro || (g.__intro = { n: 0, reveals: [], far: 0, done: 0 });
      /* WHERE THE CHAIN STOPS, if it stops. The sequence is a handful of
         steps across two files - the notice dismisses, the module types its
         boot lines, the veil waits for the world, the veil lifts, the game
         starts the move - and "nothing happened" looks identical from the
         outside whichever of them did not fire. Sampled a few times rather
         than every frame, because at three frames a second every frame is a
         third of a second of a six second sequence. */
      if (N.n === 0 || N.n === 6 || N.n === 14 || N.n === 26) {
        var v = document.querySelector('.intro-veil');
        note('intro[' + N.n + ']: begin=' + !!(window.NR.Intro && window.NR.Intro.running) +
             ' veil=' + (v ? (v.className.indexOf('intro-lift') >= 0 ? 'lifting' : 'up') : 'gone') +
             ' startIntro=' + (typeof g.startIntro) +
             ' sceneReady=' + !!(g.scene && g.scene.ready) +
             ' moving=' + !!g.intro + ' reveal=' + (g.introReveal === undefined ? '-' : g.introReveal.toFixed(2)));
      }
      N.n++;
      var car = g.car;
      if (car) {
        var d = Math.hypot(g.eye[0] - car.x, g.eye[2] - car.z);
        var up = g.eye[1] - car.y;
        if (g.intro) {
          if (!N.first) { N.first = { d: d, up: up }; }
          N.last = { d: d, up: up };
          N.reveals.push(+(g.introReveal || 0).toFixed(3));
        } else if (N.first && !N.done) {
          N.done = N.n;
          N.rest = { d: d, up: up };
        }
      }
      if (N.done && N.done + 2 === N.n) {
        note('intro: opened at ' + N.first.d.toFixed(1) + 'u out and ' +
             N.first.up.toFixed(1) + 'u up, released at ' + N.last.d.toFixed(1) + '/' +
             N.last.up.toFixed(1) + ', settled at ' + N.rest.d.toFixed(1) + '/' + N.rest.up.toFixed(1));
        note('intro: ' + N.n + ' frames, reveal ran ' + N.reveals[0] + ' -> ' +
             N.reveals[N.reveals.length - 1]);
        /* WHERE THE SHOT STARTS IS NOT MEASURABLE FROM HERE, and claiming
           otherwise would be worse than not checking it.

           This harness draws well under a frame a second on a software
           rasteriser, and the move is six seconds of wall clock. The first
           frame on which the probe can see it running is routinely four or
           five seconds in - by which point the scripted pose has almost no
           weight left and the camera is legitimately at the chase pose. An
           assertion on the opening distance therefore fails on a move that
           is working perfectly, which is the worst kind of test to own.

           The shape of the path is arithmetic with no renderer in it, so it
           is checked exactly by evaluating it directly rather than sampled
           through a browser that cannot keep up. What IS worth measuring
           here is the pair of things that need the real game running: that
           the move releases the camera without a jump, and that the menu it
           was hiding actually comes back. */
        note('intro: opening pose not asserted - the harness samples slower than the move');
        /* The release must be AT the chase pose. Half a unit is the distance
           the car itself travels between two frames here, not a tolerance on
           the blend - the blend is exactly zero by then. */
        var snap = Math.hypot(N.last.d - N.rest.d, N.last.up - N.rest.up);
        note('intro: the camera moved ' + snap.toFixed(2) + 'u across the hand-over');
        if (snap > 1.5) {
          note('PROBLEM: the camera jumped ' + snap.toFixed(2) + 'u when the move ended');
        }
        if (!(N.reveals[N.reveals.length - 1] > 0.5)) {
          note('PROBLEM: the menu never revealed - last reveal was ' + N.reveals[N.reveals.length - 1]);
        }
        PROBE = '';
      }
      if (N.n > 240 && !N.done) {
        note('PROBLEM: the opening move never released the camera');
        PROBE = '';
      }
      return;
    }
    if (HOLD === 'menu') {
      placeReel(g);
      /* ...and the census probe is allowed through, because the title screen
         is a place defects get reported and 'what is drawn here' is the
         question that settles them. Everything else still stops. */
      if (PROBE !== 'near') return;
    }
    /* The confirmation card, over the title screen. It is a modal state of
       its own and nothing in a racing run ever opens one, so without this it
       has no coverage at all. */
    if (HOLD === 'confirm') {
      if (at > 6 && g.state === 'menu' && g.askQuit) { g.askQuit(); note('held: quit confirmation'); }
      return;
    }
    /* The three selection screens, each held so a screenshot is OF that screen.
       They are ordinary DOM panels with no canvas of their own, so nothing
       else in this harness would ever open one - which is how the mode
       terminal shipped with no way back to the title but ESC. */
    /* The CONTROLS screen, on a chosen tab. --hold controls:1 is the gamepad
       page, which is the one with a live diagram on it and therefore the one
       most worth looking at. */
    if (HOLD.indexOf('controls') === 0) {
      if (at > 6 && g.state === 'menu') {
        const t = parseInt(HOLD.split(':')[1] || '0', 10) || 0;
        g.state = 'controls';
        g.controlIndex = 0;
        if (g.setOptionTab) g.setOptionTab(t); else g.controlTab = t;
        note('held: controls tab ' + t);
      }
      return;
    }
    if (HOLD === 'modes') {
      if (at > 6 && g.modeSelect && !g.modeSelect.shown) {
        g.modeSelect.open();
        note('held: mode terminal, back button = ' +
          !!document.getElementById('modeBack'));
      }
      return;
    }
    if (HOLD === 'freeroam') {
      if (at > 6 && g.freeRoamUi && !g.freeRoamUi.shown) {
        /* The open route is gated on finishing the campaign, and a fresh
           profile has not. The gate itself is covered by the mode terminal's
           own refusal path; what this hold is for is the SCREEN, so it is
           lifted here and said out loud rather than left looking like a pass. */
        if (!g.freeRoamUi.open('modes')) {
          note('free roam gate lifted for the probe (campaign not complete)');
          window.NR.campaignComplete = function () { return true; };
          g.freeRoamUi.open('modes');
        }
        note('held: free roam terminal');
      }
      return;
    }
    if (HOLD === 'multiplayer') {
      if (at > 6 && g.multiplayer && !g.multiplayer.shown) {
        g.multiplayer.open('modes');
        note('held: multiplayer lobby');
      }
      return;
    }
    if (step === 0 && at > 4) {
      /* SwiftShader draws about five frames a second at 1280x720, so the
         budget is spent on the world rather than on the post chain: half
         resolution and the LOW preset, which is a supported configuration
         rather than a test-only path. */
      try {
        g.settings.quality = ${preset};
        g.settings.resolution = ${scale} >= 0 ? ${scale} : 0;
        if (${upscaler} >= 0) g.settings.upscaler = ${upscaler};
        // ...and anything else --set named, applied through the same call
        var __sets = ${sets};
        for (var __k in __sets) g.settings[__k] = __sets[__k];
        g.applySettings();
        note('pixels: scale=' + g.renderScale.toFixed(2) + ' upscaler=' + g.upscaler +
             ' render=' + g.w + 'x' + g.h + ' canvas=' + g.outW + 'x' + g.outH);
        /* WHAT THE SETTINGS ACTUALLY DID.
           Every one of these is a value the RENDERER reads, derived from a
           row on the launcher. Reporting the row would prove nothing - the
           question is whether the number on the other side of applySettings
           followed it, and that is the half that silently breaks. */
        note('applied: shadows=' + g.useShadows + ' ao=' + g.aoQuality +
             ' ssr=' + g.useSsr + ' vol=' + g.useVolumetrics + ' taa=' + g.useTaa +
             ' bloomLv=' + g.bloomLevels + ' bloomAmt=' + (g.bloomAmount || 0).toFixed(2) +
             ' grain=' + g.useGrain + ' blur=' + g.useMotionBlur);
        /* The rows that decide how NEON it looks and how much of each
           pass runs. Same reasoning as the line above: what is worth
           reporting is the number the renderer ended up with, not the
           index the row happens to hold. */
        note('workload: neon=' + (g.neonBoost || 0).toFixed(2) +
             ' disperse=' + (g.bloomDisperse || 0).toFixed(2) +
             ' anamorphic=' + (g.anamorphic || 0).toFixed(2) +
             ' flare=' + (g.flareAmount || 0).toFixed(3) +
             ' glowFast=' + !!g.glowFast +
             ' probeFaces=' + g.probeFaces +
             ' viewScale=' + (g.scene.viewScale || 0).toFixed(2) +
             ' shadowReach=' + (g.scene.shadowReach || 0).toFixed(2) +
             ' particles=' + (g.particleDensity || 0).toFixed(2) +
             ' hudGlow=' + (g.settings.hudGlow === undefined ? 2 : g.settings.hudGlow));
        /* The lights the world has of its own - see worldLamps in the scene
           shader. A count of zero here and a road that looks the same as it
           always did is the whole failure mode: the geometry is emitted, the
           lights are not, and nothing says so. */
        (function () {
          var W = g.scene.worldLights || [];
          if (!W.length) return;
          // ROAD LIGHTING OFF is a choice, not a fault - see the row in
          // js/settings.js. Nothing below applies when the feature is off.
          if (g.scene.worldLampsOn === false) {
            note('world lights: ' + W.length + ' on the course, road lighting OFF');
            return;
          }
          /* ASKED OF THE ROAD, NOT OF THE CAR.
             Whether a light reaches the shader where the car happens to be
             standing is a question about that spot - it may be in a bore, or
             on the one stretch a zone excludes - so asking it there reports a
             failure on a healthy build. The machinery is what is being
             checked, so it is asked at twenty places spread down the whole
             course, and the pass mark is that SOME of them are lit. A list
             that is built but unsorted, mis-scaled or out of range answers
             zero at every one of them, which is the fault this is for. */
          var lit = 0, most = 0, sampled = 0;
          for (var k = 0; k < 20; k++) {
            var s = W[Math.floor(W.length * k / 20)].s;
            var p = g.track.at(s, {});
            var B = g.scene.setWorldLights([p.x, (p.y || 0) + 2.5, p.z], s);
            sampled++;
            if (B.n) lit++;
            if (B.n > most) most = B.n;
          }
          note('world lights: ' + W.length + ' on the course, lighting ' + lit +
               ' of ' + sampled + ' sampled stations, up to ' + most +
               ' at once, gain ' + ((g.scene.lampGain || 0) *
                 (g.scene.lampScale === undefined ? 1 : g.scene.lampScale)).toFixed(2));
          if (!lit) {
            window.__smoke.errors.push('the course carries ' + W.length +
              ' lights and not one of ' + sampled + ' stations is lit by any of them');
          }
        })();
        /* THE PRESET MUST ACTUALLY BE THE PRESET.
 *
           This is the invariant the schema check cannot see and the
           screenshot cannot show: the option lookup searched the rows the
           settings screen DREW; that screen stopped drawing the PRESET row
           when the graphics moved to the launcher, so the lookup returned null
           and every preset silently ran HIGH. The game drew a clean frame at
           LOW with shadows, reflections and volumetrics all on.
 *
           So the renderer's own flags are compared against what the chosen
           preset asked for, on every run, at whatever preset that run uses. */
        (function () {
          var SS = window.NR && window.NR.Settings;
          if (!SS) return;
          var row = SS.rowByKey('quality');
          var name = row && row.opts[g.settings.quality];
          var q = name && SS.QUALITY[name];
          if (!q) { window.__smoke.errors.push('preset ' + g.settings.quality + ' resolves to nothing'); return; }
          var want = {
            shadows: q.shadow > 0 && g.settings.shadows === 1,
            ssr: q.ssr && g.settings.reflections === 1,
            vol: q.volumetric && g.settings.volumetrics === 1,
            taa: !!q.taa,
            bloomLv: q.bloomLevels
          };
          var got = {
            shadows: !!g.useShadows, ssr: !!g.useSsr, vol: !!g.useVolumetrics,
            taa: !!g.useTaa, bloomLv: g.bloomLevels
          };
          var wrong = [];
          for (var k in want) if (want[k] !== got[k]) wrong.push(k + ' want=' + want[k] + ' got=' + got[k]);
          if (wrong.length) {
            window.__smoke.errors.push('preset ' + name + ' was not applied: ' + wrong.join(', '));
          } else {
            note('preset ' + name + ' applied correctly');
          }
        })();
        note('image: sat=' + (g.lookSat || 0).toFixed(2) + ' punch=' + (g.lookPunch || 0).toFixed(2) +
             ' sharpen=' + (g.sharpenScale === undefined ? 'n/a' : g.sharpenScale) +
             ' pad=' + (g.pad ? (g.pad.enabled ? 'on' : 'off') : 'none') +
             ' deadzone=' + (g.pad ? g.pad.deadzone : '-') + ' curve=' + (g.pad ? g.pad.curve : '-'));
      } catch (e) { /* the preset is not essential to the run */ }
      /* THE MIXER, BY HAND.
         Audio starts on the first user gesture, and this driver writes into
         the key table rather than dispatching events - so without this the
         graph is never built and the one number the pause fix is about (the
         engine loop's gain) does not exist to be read. */
      try { g.audio.init(); g.audio.resume(); } catch (e) { /* no device */ }
      if (${nocull}) g.scene._frustumChecked = 2;   // the latch, see setFrustum
      if (${nobake}) window.NR.bakeBegin = null;
      if (FREEROAM !== '') {
        g.enterFreeRoam({ region: ${route}, rival: parseInt(FREEROAM, 10) });
        note('free roam region ${route} vs opponent ' + FREEROAM +
             ' raptor=' + !!g.raptorRival());
      } else {
        g.enterRoute(${route}, 2);
      }
      g.startCountdown();
      g.countdown = 0.05;          // software rendering has no time for lights
      if ('${camera}' !== '') {
        g.camMode = parseInt('${camera}', 10) | 0;
        note('camera view ' + g.camMode);
      }
      note('entered route ${route}: ' + (g.level && g.level.name));
      /* PARK IT SOMEWHERE. The harness draws about a frame a second, so a run
         that starts at the route's own beginning never reaches anywhere worth
         photographing. setVehicle is the same call the story uses to place a
         car for a cutscene, so the world, the director and the checkpoint
         state all agree about where it is. */
      if (PARK) {
        var ps = parseFloat(PARK);
        if (g.story && g.story.setVehicle) {
          g.story.setVehicle(g.car, ps, 0, 45);
          g.distance = ps;
          note('parked at s=' + ps);
        } else note('PROBLEM: no story manager to park with');
      }
      step = 1; at = 0;
    } else if (PROBE === 'sink' && step >= 1) {
      /* WHY THE CAR SINKS INTO THE ROAD.
       *
       * The solver puts the car at track.at(s).y + rideHeight, sampling the
       * elevation spline continuously. The road it is driving on is a triangle
       * strip whose quads are twenty-four units long, so between one pair of
       * cross sections the rendered surface is a straight CHORD while the car
       * follows the ARC.
       *
       * Over a crest the chord is below the arc and the car floats. Through a
       * dip the chord is ABOVE the arc, and the car - correctly placed on the
       * spline - is drawn underneath the road it is on. That is the reported
       * clipping, and it is a sampling mismatch rather than a physics bug, so
       * the thing to know before changing anything is how big it actually is.
       *
       * Reported as the worst chord error over the whole route.
       */
      if (!g.__sink) {
        g.__sink = true;
        var TR = g.track, STEP = 24;
        var A = 129000, B = 176000;   // the level 7 deck
        var worst = 0, worstS = 0, worstUp = 0, worstUpS = 0, n = 0, sum = 0;
        var yAt = function (ss) { return TR.at(ss, {}).y; };
        for (var ss = A; ss < B - STEP; ss += STEP) {
          var y0 = yAt(ss), y1 = yAt(ss + STEP);
          for (var k = 1; k < 4; k++) {
            var f = k / 4, mid = ss + STEP * f;
            // chord minus arc: positive means the road is drawn ABOVE the car
            var e = (y0 + (y1 - y0) * f) - yAt(mid);
            n++; sum += Math.abs(e);
            if (e > worst) { worst = e; worstS = mid; }
            if (-e > worstUp) { worstUp = -e; worstUpS = mid; }
          }
        }
        /* ...and how far off the world origin this road actually is, which is
           the size of the error a placement that ignores p.y makes. */
        var lo = 1e9, hi = -1e9, loS = 0, hiS = 0;
        for (var s3 = A; s3 < B; s3 += 24) {
          var y3 = yAt(s3);
          if (y3 < lo) { lo = y3; loS = s3; }
          if (y3 > hi) { hi = y3; hiS = s3; }
        }
        note('sink: deck elevation ' + lo.toFixed(1) + 'u (s=' + loS.toFixed(0) + ') .. ' +
             hi.toFixed(1) + 'u (s=' + hiS.toFixed(0) + ')');
        // what a director placement puts the car at, now and before
        g.story.setVehicle(g.car, hiS, 0, 40);
        note('sink: setVehicle at the high point -> car.y=' + g.car.y.toFixed(2) +
             '  roadY=' + (g.car.roadY || 0).toFixed(2) +
             '  clearance=' + (g.car.y - yAt(hiS)).toFixed(2) + 'u' +
             '  roadPitch=' + ((g.car.roadPitch || 0) * 57.3).toFixed(1) + 'deg');
        /* ...and the MENU flyby, which carries the car along the centreline
           with the solver switched off and so has to place it itself. */
        var keep = g.distance;
        var wf = 0, wfS = 0;
        for (var s4 = A; s4 < B; s4 += 240) {
          g.distance = s4 - 55 * 0.016;
          g.idleFlyby(0.016);
          var cl = g.car.y - yAt(g.car.sTrack);
          if (Math.abs(cl - (g.car.lift || 0)) > Math.abs(wf)) { wf = cl - (g.car.lift || 0); wfS = s4; }
        }
        g.distance = keep;
        note('sink: menu flyby worst clearance error ' + wf.toFixed(3) + 'u at s=' + wfS.toFixed(0) +
             '  (ride height ' + (g.car.lift || 0).toFixed(2) + 'u)');
        note('sink: chord vs arc over ' + n + ' samples, step ' + STEP + 'u');
        note('sink: worst SUNK (road above car) ' + worst.toFixed(3) + 'u at s=' + worstS.toFixed(0));
        note('sink: worst FLOAT (road below car) ' + worstUp.toFixed(3) + 'u at s=' + worstUpS.toFixed(0));
        note('sink: mean |error| ' + (sum / n).toFixed(4) + 'u   ride height ' + (g.car.lift || 0).toFixed(3) + 'u');
        // ...and the same for the detail layers, which use their own steps
        var steps = [12, 18, 36, 48];
        for (var si = 0; si < steps.length; si++) {
          var ST = steps[si], w = 0, wS = 0;
          for (var s2 = A; s2 < B - ST; s2 += ST) {
            var a2 = yAt(s2), b2 = yAt(s2 + ST), e2 = (a2 + b2) * 0.5 - yAt(s2 + ST * 0.5);
            if (e2 > w) { w = e2; wS = s2; }
          }
          note('sink: step ' + ST + 'u would sink ' + w.toFixed(3) + 'u at s=' + wS.toFixed(0));
        }
      }
      return;
    } else if (PROBE === 'director') {
      /* WHAT ONE CHAPTER MAY LEAVE BEHIND FOR THE NEXT.
       *
       * The driver's lane hint is an ABSOLUTE lateral a director lends the shared
       * driver so its car can see hardware the track does not know about -
       * Chapter 6's live walls, saws and sorting chutes. It is a closure over
       * that director and means nothing outside that chapter.
       *
       * Chapter 6 cleared it in its own teardown and nothing else ever did.
       * Any route into another chapter that skipped that teardown therefore
       * left the Forge's lane function installed, and Chapter 7's R-IX then
       * asked it where to be - getting gate gaps and the +/-13 that keeps a
       * car clear of a saw. Those are at the edge of the road, and they
       * switch on and off as the lookahead sweeps positions belonging to a
       * different chapter, so the boss drove from one edge to the other and
       * back while making perfectly ordinary forward progress.
       *
       * It is cleared in Driver.reset now, which every race start calls. This
       * asserts that, because the bug is invisible: the game runs, draws and
       * reports nothing wrong. */
      if (!g.__dir) {
        g.__dir = 1;
        var bad = 0;
        var d = g.driver;
        if (!d) { note('PROBLEM: no driver to test'); PROBE = ''; return; }
        d.laneHint = function () { return 13.2; };
        if (d.laneHint === null) { note('PROBLEM: laneHint would not set'); bad++; }
        d.reset();
        if (d.laneHint !== null) {
          note('PROBLEM: a director lane hint survived Driver.reset - it will steer the next chapter');
          bad++;
        }
        // ...and the same for the boost hold, which Chapter 7 raises and
        // which would otherwise leave the next chapter's rival flat out
        d.boostHold = 1;
        d.reset();
        if (d.boostHold !== 0) { note('PROBLEM: boostHold survived Driver.reset'); bad++; }
        note(bad ? 'director: ' + bad + ' LEAK(S)' : 'director: nothing leaks across a reset');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'story' && step >= 1) {
      /* THE STORY CARDS, IN A REAL DOCUMENT.
       *
       * tools/checkstory.js walks the whole campaign and every branch of it,
       * but it does so against a stub: it can prove the script is sound and
       * the state machine terminates, and it cannot prove that any of it
       * reaches the screen. This is the other half - the dialogue card, the
       * nameplate, the portrait and the decision card, measured where they
       * actually get laid out.
       *
       * The opening is FAST-FORWARDED rather than played: this harness draws
       * about one frame a second and the prologue is twenty-two seconds of
       * cinema before its first line. What is under test is the card, not the
       * crane that precedes it.
       */
      var ST = g.__story || (g.__story = { t: 0, done: false, step: 0 });
      if (ST.done) return;
      var story = g.story;
      if (!story) { note("PROBLEM: no story manager"); PROBE = ""; ST.done = true; return; }
      ST.t++;
      var shown = function (el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        return el.classList.contains("show") && r.width > 40 && r.height > 20;
      };

      if (ST.step === 0) {
        ST.step = 1;
        story.setRoot(true);
        story.g.state = "story";
        story.startPrologueDialogue();
        return;
      }
      if (ST.step === 1) {
        var card = document.getElementById("storyDialogue");
        var name = document.getElementById("storyNameplateName");
        var role = document.getElementById("storyNameplateRole");
        var text = document.getElementById("storyText");
        var port = document.getElementById("storyPortrait");
        if (!shown(card)) { note("PROBLEM: the dialogue card is not on screen"); }
        else note("story: card " + Math.round(card.getBoundingClientRect().width) + "x"
          + Math.round(card.getBoundingClientRect().height)
          + "  speaker=" + name.textContent + "  role=" + role.textContent);
        if (!name.textContent) note("PROBLEM: the nameplate is empty");
        if (!port || !port.getAttribute("src")) note("PROBLEM: the portrait has no source");
        /* THE REGRESSION, MEASURED ON THE REAL CARD.
           A held key must not be able to leave a line the moment it appears.
           Four advances in a row, in one frame, is precisely the input that
           walked the old opening in a second and a sixth. */
        var startIndex = story.dialogue.index;
        for (var sp = 0; sp < 8; sp++) story.dialogue.advance();
        var walked = story.dialogue.index - startIndex;
        note("story: eight advances in one frame moved " + walked + " line(s)");
        if (walked > 1) {
          note("PROBLEM: a held key still walks the conversation - " + walked + " lines in one frame");
        }
        if (!text.textContent) note("PROBLEM: the card has no text after being advanced");
        ST.step = 2;
        return;
      }
      if (ST.step === 2) {
        // ...and the decision card, which is new furniture with new styling
        var CHOICES = (window.NR && NR.STORY_CHOICES) || null;
        if (!CHOICES) { note("PROBLEM: the campaign publishes no decisions"); PROBE = ""; ST.done = true; return; }
        var keys = Object.keys(CHOICES);
        note("story: " + keys.length + " decisions - " + keys.join(", "));
        story.dialogue.active = false;
        story.setDialogueVisible(false);
        story.chapter = NR.STORY_CHAPTERS[CHOICES[keys[0]].after];
        story.showChoice(Object.assign({ id: keys[0] }, CHOICES[keys[0]]));
        ST.step = 3;
        return;
      }
      if (ST.step === 3) {
        var panel = document.getElementById("storyChoice");
        var q = document.getElementById("storyChoiceQuestion");
        var a = document.getElementById("storyChoiceEdge");
        var b = document.getElementById("storyChoiceOpen");
        if (!shown(panel)) note("PROBLEM: the decision card is not on screen");
        else note("story: decision card " + Math.round(panel.getBoundingClientRect().width) + "x"
          + Math.round(panel.getBoundingClientRect().height) + "  [" + q.textContent + "]");
        var doorText = function (el) {
          if (!el) return "";
          var t = el.querySelector("b"), sub = el.querySelector("small"), tag = el.querySelector("em");
          return (t ? t.textContent : "") + " / " + (sub ? sub.textContent : "") + " / " + ((tag ? tag.textContent : "").length) + " chars";
        };
        note("story: EDGE  " + doorText(a));
        note("story: OPEN  " + doorText(b));
        if (!a || !a.querySelector("b").textContent) note("PROBLEM: the EDGE door is blank");
        if (!b || !b.querySelector("b").textContent) note("PROBLEM: the OPEN door is blank");
        var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        if (ra.width < 80 || rb.width < 80) note("PROBLEM: a decision door collapsed to " + Math.round(ra.width) + "x" + Math.round(rb.width));
        if (ra.bottom > window.innerHeight + 2 || ra.top < -2) note("PROBLEM: the decision card overflows the window");
        ST.done = true; PROBE = "";
        return;
      }
      return;
    } else if (PROBE === 'cursor' && step >= 1) {
      /* WHO OWNS THE POINTER, AND WHETHER THE BUTTONS ARE WHERE THEY LOOK.
       *
       * Two separate things go wrong with a pointer and only one of them is
       * visible in the source.
       *
       * THE POLICY. The cursor is hidden while the car is driving, and any
       * panel that wants clicks has to say so. One boolean used to carry
       * that and exactly one screen ever set it, so the multiplayer results
       * board - which arrives while state is still racing, because
       * multiplayer cannot pause - was drawn with no cursor at all.
       *
       * THE GEOMETRY. A control can be declared, focusable and correct in
       * every respect and still be unclickable, because something
       * transparent is lying on top of it. The only honest test for that is
       * to ask the document what is at the point the button is drawn at.
       */
      var CU = g.__cursor || (g.__cursor = { step: 0, bad: 0 });
      if (CU.done) return;
      var body = document.body;
      var hidden = function () { return body.classList.contains("race-active"); };
      var hitsItself = function (el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        var at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        while (at) { if (at === el) return true; at = at.parentElement; }
        return false;
      };

      if (CU.step === 0) {
        CU.step = 1;
        if (!g.setUiOverlay) { note("PROBLEM: the game has no overlay registry"); PROBE = ""; CU.done = true; return; }
        g.state = "racing";
        g.cursorHiddenForRun = true;
        g.clearUiOverlays();
        if (!hidden()) { note("PROBLEM: the cursor is still shown while driving"); CU.bad++; }
        g.setUiOverlay("probe-a", true);
        if (hidden()) { note("PROBLEM: an overlay did not bring the cursor back"); CU.bad++; }
        /* NESTING. A dialog over a results board used to clear the one flag
           on its way out and take the board pointer with it. */
        g.setUiOverlay("probe-b", true);
        g.setUiOverlay("probe-a", false);
        if (hidden()) { note("PROBLEM: closing one of two overlays hid the cursor"); CU.bad++; }
        g.setUiOverlay("probe-b", false);
        if (!hidden()) { note("PROBLEM: the last overlay closed and the cursor stayed"); CU.bad++; }
        note("cursor: policy " + (CU.bad ? CU.bad + " FAILURE(S)" : "holds, and nests"));
        return;
      }

      if (CU.step === 1) {
        CU.step = 2;
        // the multiplayer results board, over a race that is still running
        var rr = document.getElementById("mpResultsRoot");
        var again = document.getElementById("mpResultsAgain");
        var leave = document.getElementById("mpResultsLeave");
        if (!rr) { note("PROBLEM: no multiplayer results board in the document"); CU.bad++; }
        else {
          g.state = "racing";
          rr.setAttribute("aria-hidden", "false");
          body.classList.add("multiplayer-open");
          g.setUiOverlay("mp-results", true);
          if (hidden()) { note("PROBLEM: the results board is up and the cursor is hidden"); CU.bad++; }
          /* THE POLICY IS NOT THE POINTER.
             Taking race-active off only stops the cursor being forced
             invisible. It is drawn when it has been REVEALED, and the player
             who just finished a race on the keyboard has not moved the mouse
             to reveal it - so the board came up with a live overlay, buttons
             that hit-test correctly, and nothing on screen to click them
             with. Asked of the element rather than of the body class,
             because that is the difference the player actually sees. */
          var drawn = document.getElementById("synxCursor");
          var drawnUp = !!drawn && drawn.classList.contains("show")
            && getComputedStyle(drawn).display !== "none";
          /* The real pointer counts too, and on this screen it is the one
             that is meant to be there: nothing in this harness has ever
             moved a mouse, so the drawn cursor has no position and the
             fallback is the correct answer rather than a lesser one. */
          var nativeUp = getComputedStyle(again).cursor !== "none";
          note("cursor: results board  drawn=" + drawnUp + "  native=" + nativeUp);
          if (!drawnUp && !nativeUp) {
            note("PROBLEM: the results board has buttons and no pointer of any kind");
            CU.bad++;
          }
          var okA = hitsItself(again), okB = hitsItself(leave);
          note("cursor: results board  RACE AGAIN clickable=" + okA + "  LOBBY clickable=" + okB);
          if (!okA || !okB) { note("PROBLEM: a results button is not clickable where it is drawn"); CU.bad++; }
          rr.setAttribute("aria-hidden", "true");
          body.classList.remove("multiplayer-open");
          g.setUiOverlay("mp-results", false);
        }
        return;
      }

      if (CU.step === 2) {
        CU.step = 3;
        // the story decision card, which is new furniture with new styling
        var st = g.story;
        var CH = (window.NR && NR.STORY_CHOICES) || null;
        if (st && CH) {
          var k = Object.keys(CH)[0];
          st.setRoot(true);
          st.chapter = NR.STORY_CHAPTERS[CH[k].after];
          st.showChoice(Object.assign({ id: k }, CH[k]));
          var e1 = document.getElementById("storyChoiceEdge");
          var e2 = document.getElementById("storyChoiceOpen");
          var okC = hitsItself(e1), okD = hitsItself(e2);
          note("cursor: decision card  EDGE clickable=" + okC + "  OPEN clickable=" + okD);
          if (!okC || !okD) { note("PROBLEM: a decision door is not clickable where it is drawn"); CU.bad++; }
          if (document.activeElement !== e2) note("PROBLEM: the decision card did not take focus");
          st.setLayer(st.ui.choice, false);
          st.closeStoryUi();
        }
        return;
      }

      if (CU.step === 3) {
        CU.step = 4;
        /* HOVER AND THE KEYBOARD HAVE TO AGREE.
           Every card screen commits with ENTER on the FOCUSED element, and
           every one of them lights the tile under the POINTER. If those are
           two different tiles, the thing that starts is the one the player
           was not looking at. */
        var hoverTakesFocus = function (label, card) {
          if (!card) { note("PROBLEM: " + label + " has no card to hover"); CU.bad++; return; }
          /* TWO SHAPES OF HOVER, AND THE PROBE HAS TO SPEAK BOTH.
             The story hub listens for pointerenter on the tile itself. The
             driver terminal and the route list track the pointer POSITION on
             the document and recompute from elementFromPoint - which is the
             better of the two, because it also lights the card a panel was
             built underneath. A synthetic move therefore has to carry real
             coordinates or it tells the second kind nothing. */
          var r = card.getBoundingClientRect();
          var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          card.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, clientX: cx, clientY: cy }));
          document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: cx, clientY: cy }));
          var got = document.activeElement === card;
          note("cursor: " + label + " hover takes the keyboard = " + got);
          if (!got) { note("PROBLEM: hovering " + label + " did not move focus - ENTER would commit elsewhere"); CU.bad++; }
        };
        // the driver terminal
        if (g.modeSelect && g.modeSelect.open) {
          g.modeSelect.open();
          var mc = document.querySelectorAll("#modeSelectRoot .mode-card");
          if (mc.length > 1) hoverTakesFocus("driver terminal card", mc[1]);
          if (g.modeSelect.close) g.modeSelect.close();
        }
        // the story hub
        if (g.story && g.story.openHub) {
          g.story.openHub();
          var tiles = document.querySelectorAll("#storyChapterList .story-chapter");
          if (tiles.length) hoverTakesFocus("story chapter tile", tiles[0]);
          g.story.closeStoryUi();
          g.story.mode = "none";
        }
        return;
      }

      CU.done = true; PROBE = "";
      note(CU.bad ? "cursor: " + CU.bad + " PROBLEM(S)" : "cursor: every panel owns its pointer and every button is where it looks");
      return;
    } else if (PROBE === 'attract' && step >= 1) {
      /* THE TITLE SCREEN, MEASURED.
       *
       * What plays behind every menu is a reel of stretches cut to arrive at
       * something worth seeing - see ATTRACT_REEL - and the two things that
       * can silently go wrong with it are both invisible in a screenshot:
       * the car can be out of frame, and the lens can be inside the world.
       * So this asks where the car actually projects to on screen.
       */
      var A = g.__attract || (g.__attract = { t: 0, rows: [], done: false });
      if (A.done) return;
      /* The harness draws about a frame a SECOND on a software rasteriser, so
         one sample per tick would take four minutes to walk the reel. The
         reel is stepped by hand anyway - this is about framing, not pacing -
         so a tick takes twelve samples and the whole loop lands in twenty. */
      for (var pass = 0; pass < 12 && A.t < 240; pass++) {
      A.t++;
      for (var q = 0; q < 34; q++) g.idleFlyby(1 / 60);
      var car = g.car;
      var dx = car.x - g.eye[0], dy = car.y - g.eye[1], dz = car.z - g.eye[2];
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      /* WHERE THE CAR IS, MEASURED AGAINST THE CAMERA - NOT AGAINST g.vp.
         The reel is stepped by hand here and nothing is drawn between steps,
         so the view-projection on the game object is the one the last drawn
         frame left behind, a second of reel ago. Reading it reported the car
         BEHIND THE LENS on every sample of a reel that was framed correctly
         the whole way through - a false alarm that cost an afternoon.
         The eye, the target and the field of view are all current, so the
         framing is taken from those: the angle off the view axis, against the
         half-frame the projection would be built with. */
      var fwd = [g.target[0] - g.eye[0], g.target[1] - g.eye[1], g.target[2] - g.eye[2]];
      var fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
      fwd = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl];
      var up = g.up || [0, 1, 0];
      var rt = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2],
        fwd[0] * up[1] - fwd[1] * up[0]];
      var rl = Math.hypot(rt[0], rt[1], rt[2]) || 1;
      rt = [rt[0] / rl, rt[1] / rl, rt[2] / rl];
      var uu = [rt[1] * fwd[2] - rt[2] * fwd[1], rt[2] * fwd[0] - rt[0] * fwd[2],
        rt[0] * fwd[1] - rt[1] * fwd[0]];
      var d = [car.x - g.eye[0], car.y - g.eye[1], car.z - g.eye[2]];
      var f = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
      var h = d[0] * rt[0] + d[1] * rt[1] + d[2] * rt[2];
      var v = d[0] * uu[0] + d[1] * uu[1] + d[2] * uu[2];
      var vhalf = (g.fov || 55) * Math.PI / 360;
      var hhalf = Math.atan(Math.tan(vhalf) * ((g.w || 16) / (g.h || 9)));
      var ndcx = f > 0 ? Math.atan2(h, f) / hhalf : 0;
      var ndcy = f > 0 ? Math.atan2(v, f) / vhalf : 0;
      var onScreen = f > 0 && Math.abs(ndcx) <= 1.15 && Math.abs(ndcy) <= 1.15;
      A.rows.push({ shot: g.attractShotKey, s: Math.round(g.distance),
        dist: dist, on: onScreen, ndc: f > 0 ? ndcx.toFixed(2) + "," + ndcy.toFixed(2) : "behind",
        air: +(car.y - ((g.track.at(g.distance, {}).y || 0) + (car.lift || 0))).toFixed(2),
        /* WHICH RAMP, IF ANY, IS UNDER IT. The attract car flies off the same
           table the solver arms from, so a frame in the air with nothing in
           that table beneath it is a ghost ramp - the exact thing reported on
           the title screen, and the thing a framing-only probe cannot see. */
        onRamp: (function () {
          var R = window.NR.COURSE_RAMPS || [], d = g.distance;
          for (var i = 0; i < R.length; i++) {
            var r = R[i], foot = r.s - (r.crest || 0) - r.len;
            if (d >= foot - 4 && d <= r.s + 190) return r.id;
          }
          return null;
        })(),
        why: "eye " + g.eye.map(function (n) { return n.toFixed(1); }).join(",")
          + " look " + g.target.map(function (n) { return n.toFixed(1); }).join(",")
          + " car " + [car.x, car.y, car.z].map(function (n) { return n.toFixed(1); }).join(",")
          + " age " + (g.attractShotAge || 0).toFixed(1) + "s fov " + (g.fov || 0).toFixed(0) });
      }
      /* THE WHOLE REEL, NOT A SLICE OF IT. 26 samples is 800 units of road
         and the reel is six stretches and six thousand, so the old run
         reported on whichever one the title screen happened to have reached
         and said nothing at all about the other five - including the sealed
         bore, which is the one that was reported as a mess. 240 covers the
         loop, and the output is folded per shot so it still fits on a
         screen. */
      if (A.t >= 240) {
        A.done = true; PROBE = "";
        var off = 0, air = 0, near = 0, ghost = 0, ghosts = [], by = {}, order = [];
        for (var i = 0; i < A.rows.length; i++) {
          var r = A.rows[i];
          if (!r.on) off++;
          if (r.air > 0.05) {
            air++;
            if (!r.onRamp) {
              ghost++;
              if (ghosts.length < 6) ghosts.push(r.s + ' (' + r.air.toFixed(1) + 'u up)');
            }
          }
          if (r.dist < 3.0) near++;
          var k = String(r.shot);
          if (!by[k]) { by[k] = { n: 0, off: 0, air: 0, lo: 1e9, hi: -1e9, s0: r.s, s1: r.s }; order.push(k); }
          var b = by[k];
          b.n++; if (!r.on) b.off++; if (r.air > 0.05) b.air++;
          b.lo = Math.min(b.lo, r.dist); b.hi = Math.max(b.hi, r.dist);
          b.s0 = Math.min(b.s0, r.s); b.s1 = Math.max(b.s1, r.s);
          if (!r.on && !b.worst) { b.worst = r.ndc; b.why = r.why; }
        }
        for (var j = 0; j < order.length; j++) {
          var q = by[order[j]];
          note("attract: " + order[j].padEnd(26)
            + " s " + String(q.s0).padStart(6) + ".." + String(q.s1).padEnd(6)
            + " x" + String(q.n).padStart(3)
            + "  lens " + q.lo.toFixed(1) + ".." + q.hi.toFixed(1) + "u"
            + (q.air ? "  airborne x" + q.air : "")
            + (q.off ? "  OFF SCREEN x" + q.off + " (first at " + q.worst + ")" : ""));
          if (q.off) note("attract:   " + q.why);
        }
        note("attract: " + A.rows.length + " samples over " + order.length + " shots, "
          + off + " with the car off screen, " + air + " airborne, " + near + " with the lens inside the car");
        /* ...AND EVERY RAMP THE REEL FLIES OFF IS ACTUALLY BUILT HERE.
           The title screen loads no chapter world - a chapter's world costs
           seconds to build and a menu cannot spend them - so the only ramps
           on screen are the ones the base dressing made. The flight is armed
           from the ramp TABLE, which knows nothing about who drew what, so a
           ramp the base scene skips is a car climbing and jumping on empty
           road. That is what NEON HORIZON's three did for the whole of the
           last stretch of every loop of the reel.
           Asked of the scene rather than of the source: these are the parts
           that exist, with the arc lengths they were emitted at. */
        var built = [];
        var lists = [g.scene.dressingOpaque, g.scene.dressingGlow];
        for (var li = 0; li < lists.length; li++) {
          var L = lists[li] || [];
          for (var pi = 0; pi < L.length; pi++) {
            var nm = (L[pi].mat && L[pi].mat.name) || "";
            if (/^StuntRamp|^BoreRamp/.test(nm) && L[pi].s1 !== undefined) {
              built.push([L[pi].s0, L[pi].s1]);
            }
          }
        }
        var ramps = window.NR.COURSE_RAMPS || [], missing = [];
        for (var ri = 0; ri < ramps.length; ri++) {
          var r = ramps[ri], foot = r.s - (r.crest || 0) - r.len, has = false;
          for (var bi = 0; bi < built.length; bi++) {
            if (built[bi][0] <= r.s && built[bi][1] >= foot) { has = true; break; }
          }
          if (!has) missing.push(r.id + " at " + r.s);
        }
        note("attract: " + built.length + " ramp batch(es) in the title screen's world, "
          + (ramps.length - missing.length) + " of " + ramps.length + " ramps covered");
        if (missing.length) {
          note("PROBLEM: the reel can fly off " + missing.length
            + " ramp(s) the title screen does not draw: " + missing.join(", "));
        }
        if (off > A.rows.length * 0.10) note("PROBLEM: the attract camera loses the car");
        if (near) note("PROBLEM: the attract lens ends up inside the car " + near + " times");
        if (ghost) {
          note("PROBLEM: the attract car was airborne " + ghost
            + " time(s) with no ramp under it - at s=" + ghosts.join(", s="));
        } else note("attract: every airborne frame had a ramp under it");
      }
      return;
    } else if (PROBE === 'predator') {
      /* THE BOSS'S BALANCE, AS ARITHMETIC.
       *
       * Chapter 7 is decided by three numbers: what the player can hold on
       * the Forge engine, what they can hold on boost, and what they can hold
       * in a sync window - each against the ceiling the R-IX is allowed while
       * he is being provoked. The whole design is 'boost does not shake him
       * off, the sync window does', and that is a claim about two inequalities
       * rather than about how the race feels.
       *
       * Winning a race to find out is not a test. NR.PRED.hunt is exported so
       * the curve can be asked directly, which is what this does.
       */
      if (!g.__pred) {
        g.__pred = 1;
        var P = window.NR && window.NR.PRED;
        if (!P || !P.hunt) { note('PROBLEM: NR.PRED.hunt is not exported'); PROBE = ''; return; }
        var TERM = P.stockTerminal;          // 88: a stock car here
        var ENGINE = TERM * 1.09;            // the Forge engine, ~96
        var BOOST = TERM * 1.14;             // ...and boost on top, ~100
        var MODE = TERM * 1.51;              // a sync window, ~133
        var bad = 0;
        var say = function (ok, msg) { if (!ok) { bad++; note('PROBLEM: ' + msg); } };

        /* The pressure term is gone - the counter-attack was removed on request; see
           the long note above RETAKE_CLEAR in js/chapters.js. What answers an
           overtake now is the hunt curve, and the hunt curve is a function of
           the GAP - so "provoked" is no longer a flag to pass, it is a gap to
           ask about. Alongside is the state right after being overtaken; two
           hundred units is the lead the player has to defend. */
        var hot = P.hunt(6, { confidence: 1, playerBoosting: true, playerV: BOOST });
        var cold = P.hunt(6, { confidence: 1, playerV: ENGINE });
        var mode = P.hunt(6, { confidence: 1, playerMode: true, playerV: MODE });
        var led = P.hunt(200, { confidence: 1, playerBoosting: true, playerV: BOOST });

        note('predator: ceiling alongside=' + hot.top.toFixed(1) +
             ' at a 200u lead=' + led.top.toFixed(1) + '  player engine=' + ENGINE.toFixed(1) +
             ' boost=' + BOOST.toFixed(1) + ' raceMode=' + MODE.toFixed(1));

        say(hot.top > BOOST + 8,
            'boost (' + BOOST.toFixed(1) + ') is not answered - his provoked ceiling is only ' +
            hot.top.toFixed(1) + ', so the player can simply hold boost and leave');
        /* A MARGIN, not a bare inequality. The first version of this asked
           only that the window be faster than him, and it passed on nine
           tenths of a unit per second - which is true, and is not a
           counterplay a player can feel. Three units is about a hundred metres
           over a window, which is what the chapter's notes claim it is worth. */
        say(MODE - mode.top >= 3,
            'a sync window (' + MODE.toFixed(1) + ') barely escapes his ' +
            mode.top.toFixed(1) + ' - margin ' + (MODE - mode.top).toFixed(1) +
            ' units/s is not a counterplay anyone can feel');
        /* A LEAD MUST COST THE PLAYER SOMETHING. This is what replaced the
           counter-attack's assertion, and it is the same claim in the terms
           the design now uses: getting away from him has to make him faster,
           or a player who wins one exchange never sees him again. */
        say(led.top > hot.top + 3,
            'a 200-unit lead buys him almost nothing: ' + led.top.toFixed(1) +
            ' against ' + hot.top.toFixed(1) + ' alongside');
        say(led.pace > cold.pace,
            'he does not push harder for a lead than he does alongside');

        /* MONOTONIC IN THE GAP. A ceiling that is not monotonic is a boss who
           goes slower the further ahead you get, which is the shape that makes
           a chase feel random. */
        var prev = -1, mono = true;
        for (var gp = 0; gp <= 900; gp += 60) {
          var h = P.hunt(gp, { confidence: 1, playerV: BOOST });
          if (h.top < prev - 0.001) mono = false;
          prev = h.top;
        }
        say(mono, 'the ceiling is not monotonic in the gap');

        // ...and he must ease, not vanish, once HE is in front
        var ahead = P.hunt(-400, { confidence: 1, playerV: ENGINE });
        say(ahead.pace < cold.pace, 'he does not ease off at all when he is clear ahead');
        say(ahead.pace > 0.9, 'he gives up entirely when ahead (' + ahead.pace.toFixed(2) + ')');

        note(bad ? 'predator: ' + bad + ' BALANCE PROBLEM(S)' : 'predator: the balance holds');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'layout') {
      /* NOTHING MAY BE DRAWN THROUGH ANYTHING ELSE.
       *
       * "Fix the overlapping UI" is not a thing you can eyeball on a screen
       * that is laid out from a dozen constants in two files, and it is not a
       * thing a screenshot proves either - the collision that matters is the
       * one on the page you did not open. The layout is arithmetic, so it can
       * simply be checked: every band on the options screen and the title
       * screen is listed with the extent it actually occupies, and any two
       * that share a line are reported.
       */
      if (!g.__lay) {
        g.__lay = 1;
        var bad = 0;
        var check = function (name, list) {
          list.sort(function (a, b) { return b.hi - a.hi; });
          for (var i = 0; i < list.length; i++) {
            for (var j = i + 1; j < list.length; j++) {
              var A = list[i], B = list[j];
              if (A.lo < B.hi && B.lo < A.hi) {
                // ...unless they are side by side, which is not an overlap
                if (A.x !== undefined && B.x !== undefined &&
                    (A.x[1] <= B.x[0] || B.x[1] <= A.x[0])) continue;
                bad++;
                note('PROBLEM: ' + name + ' - ' + A.n + ' (' + A.lo.toFixed(0) + '..' +
                     A.hi.toFixed(0) + ') overlaps ' + B.n + ' (' + B.lo.toFixed(0) +
                     '..' + B.hi.toFixed(0) + ')');
              }
            }
          }
        };
        var band = function (n, y, h, x0, x1) {
          return { n: n, lo: y - h / 2, hi: y + h / 2, x: x0 === undefined ? undefined : [x0, x1] };
        };

        // ---------------------------------------------------- title screen --
        var menu = [
          band('SYNX', 196, 70, -140, 140),
          band('subtitle', 122, 20, -320, 320),
          band('rule', 101, 4, -235, 235),
          band('toast 1', 300, 34, -210, 210),
          band('toast 2', 254, 34, -210, 210),
        ];
        var ML = window.NR.MENU_LAYOUT, n3 = 3;
        for (var mi = 0; mi < n3; mi++) {
          menu.push(band('menu row ' + mi, ML.yFor(mi, n3), 78, -215, 215));
        }
        menu.push(band('BEST', ML.topFor(n3) - n3 * ML.gap - 8, 46, -150, 150));
        menu.push(band('footer', -330, 16, -400, 400));
        check('title', menu);
        note('layout: title screen, ' + menu.length + ' bands');

        // ------------------------------------------------- controls screen --
        var TABY = window.NR.CTL_TAB_Y, TABW = window.NR.CTL_TAB_W;
        var TABS = window.NR.CONTROL_TABS;
        for (var t = 0; t < TABS.length; t++) {
          var rows = window.NR.tabRows(t);
          var L = window.NR.CONTROLS_LAYOUTS[t];
          /* THE GAMEPAD PAGE IS NOT A LIST, so its rows are not full width.
             They move into the right-hand third and the controller diagram
             takes the space they leave - and a checker that assumed one column
             geometry for every page would report the diagram as colliding with
             rows it is nowhere near. */
          var padTab = t === 1;
          var rowX0 = padTab ? -56 : -485;
          var rowX1 = padTab ? 564 : 485;
          var list = [
            band('kicker', 314, 16, -200, 200),
            band('CONTROLS', 282, 30, -140, 140),
            band('legend', 280, 34, 180, 560),
            band('rule', 258, 4, -450, 450),
            band('tab strip', TABY, 42, window.NR.ctlTabX(0) - TABW / 2 - 11,
                 window.NR.ctlTabX(TABS.length - 1) + TABW / 2 + 11),
            band('SAVE AND BACK', L.exitY, 52, -235, 235),
            band('hint band', L.hintY, L.hintH, -500, 500),
          ];
          if (t === 0) list.push(band('RESET', L.exitY, 34, 250, 470));
          if (padTab) {
            /* The three things drawn only on this page. Their numbers are the
               ones js/hud.js draws with, so a move there that walked into the
               tab strip or off the bottom of the panel is caught here rather
               than in a screenshot nobody took. */
            /* The status text starts at cx-120 = -420 and runs RIGHT. Its
               longest line is "NO CONTROLLER DETECTED" at 17 units, which is
               about 230 wide, so it ends near -190 - well clear of the rows,
               which start at -56. The first version of this band claimed -40
               and was reported as colliding with three of them. */
            list.push(band('pad status', 157, 46, -430, -185));
            /* Measured off drawPadDiagram rather than estimated: centre
               -196, scale 1.72, local y from -64.5 at the top of a trigger
               to +66 at the bottom of a grip, which is HUD -85 to -310. The
               first version of this claimed a top of -79 and hid a real
               overlap with the hint band underneath it. */
            list.push(band('pad diagram', -197, 226, -524, -76));
            list.push(band('pad legend', -159, 152, 46, 560));
          }
          for (var ri = 0; ri < rows.length; ri++) {
            /* 26, not the 32 of the selection panel: only one row is ever
               selected, so two selection panels can never coexist, and the
               thing that must not collide is the TEXT - 19px, so about 20
               units, plus margin. */
            list.push(band('row ' + ri + ' ' + rows[ri].label, L.rows[ri], 26, rowX0, rowX1));
            if (rows[ri].group) {
              list.push(band('header ' + rows[ri].group, L.rows[ri] + 26, 14, rowX0, rowX1 - 15));
            }
          }
          // ...and everything has to be inside the panel it is drawn in
          var PY = -6, PH = 700;
          for (var li = 0; li < list.length; li++) {
            if (list[li].hi > PY + PH / 2 || list[li].lo < PY - PH / 2) {
              bad++;
              note('PROBLEM: controls tab ' + t + ' - ' + list[li].n + ' (' +
                   list[li].lo.toFixed(0) + '..' + list[li].hi.toFixed(0) +
                   ') is outside the panel');
            }
          }
          check('controls tab ' + t, list);
          note('layout: controls tab ' + t + ' (' + TABS[t] + '), ' + list.length +
               ' bands, rows ' + L.rows[0] + '..' + L.rows[L.rows.length - 1] +
               ', exit ' + L.exitY.toFixed(0) + ', hint ' + L.hintY.toFixed(0));
        }
        // ---------------------------------------------------- pause card --
        var PPY = 10, PPH = 492;
        var pause = [
          band('PAUSED', 186, 44, -120, 120),
          band('rule', 146, 4, -215, 215),
          band('route name', 112, 20, -260, 260),
          band('percent', 84, 16, -180, -30),
          band('clock', 84, 16, 30, 180),
          band('progress rail', 60, 8, -160, 160),
          band('autosave', 26, 13, -230, 230),
          band('footer', PPY - PPH / 2 + 26, 17, -280, 280),
        ];
        for (var pi = 0; pi < 3; pi++) {
          // menuList: rows 64 apart from -12, brackets 0.97 of the gap
          pause.push(band('pause row ' + pi, -12 - pi * 64, 62, -195, 195));
        }
        for (var qi = 0; qi < pause.length; qi++) {
          if (pause[qi].hi > PPY + PPH / 2 || pause[qi].lo < PPY - PPH / 2) {
            bad++;
            note('PROBLEM: pause - ' + pause[qi].n + ' (' + pause[qi].lo.toFixed(0) +
                 '..' + pause[qi].hi.toFixed(0) + ') is outside the card');
          }
        }
        check('pause', pause);
        note('layout: pause card, ' + pause.length + ' bands');

        note('layout: ' + (bad ? bad + ' COLLISION(S)' : 'no collisions'));
        PROBE = '';
      }
      return;
    } else if (PROBE === 'options') {
      /* THE OPTIONS SCREEN, BOTH PAGES, EVERY ROW.
       *
       * The controls page is new and it is drawn from a different row shape
       * than the one the painter was written for - a binding row has no option
       * list, no meter and no chevrons - so the thing worth proving is simply
       * that every row of every page paints and hit-tests without throwing,
       * and that a rebind actually reaches the input layer.
       */
      if (!g.__opt) {
        g.__opt = { t: 0, step: 0, tab: 0 };
        g.state = 'controls';
        g.setOptionTab(0);
        g.controlIndex = 0;
        note('controls: page 0 has ' + g.settingRows.length + ' rows');
      }
      var O = g.__opt;
      O.t += g.__realDt || 0.016;
      /* WALK EVERY PAGE, not two of them. The screen went from two pages to
         three - KEYBOARD, GAMEPAD, MOUSE - and a probe that stopped at page
         one would have left the whole controller page, which is the one with
         a live diagram on it, unvisited. Reading the tab count rather than
         naming it means a fourth page is covered the day it is added. */
      var TABS = (window.NR.CONTROL_TABS || []).length || 1;
      if (O.step === 0) {
        g.controlIndex = (g.controlIndex + 1) % (g.settingRows.length + 1);
        if (g.controlIndex === 0) {
          O.tab++;
          if (O.tab >= TABS) { O.step = 2; g.setOptionTab(0); return; }
          g.setOptionTab(O.tab);
          note('controls: page ' + O.tab + ' has ' + g.settingRows.length + ' rows, ' +
               g.settingRows.filter(function (r) { return r.bind; }).length + ' of them bindings');
        }
        return;
      }
      if (O.step === 2) { O.step = 3; g.controlIndex = -1; return; }
      if (O.step === 3) {
        O.step = 4;
        g.controlIndex = 0;
        g.beginBind('throttle');
        if (!g.input.captureNext) { note('PROBLEM: beginBind armed no capture'); PROBE = ''; return; }
        g.input.captureNext('t');
        var got = g.input.keysFor('throttle');
        note('controls: throttle rebound -> [' + got.join(', ') + ']');
        if (got[0] !== 't') note('PROBLEM: the rebind did not reach Input');
        g.beginBind('boost');
        g.input.captureNext('t');
        note('controls: boost took T -> throttle [' +
             g.input.keysFor('throttle').join(', ') + ']  boost [' +
             g.input.keysFor('boost').join(', ') + ']');
        g.resetBinds();
        note('controls: after reset, throttle [' + g.input.keysFor('throttle').join(', ') + ']');
        /* THE ROUND TRIP. A rebind that does not survive the save file is a
           rebind that lasts until the player closes the game, and the
           validation loop that reads it back is the only new code on that
           path - so it is walked rather than assumed. */
        g.beginBind('boost');
        g.input.captureNext('n');
        g.saveAndExitControls();
        var raw = window.NR.Save.getJSON('synx.settings.v1', null);
        note('controls: saved binds.boost = [' +
             ((raw && raw.binds && raw.binds.boost) || ['MISSING']).join(', ') + ']');
        if (!raw || !raw.binds || !raw.binds.boost || raw.binds.boost[0] !== 'n') {
          note('PROBLEM: the rebind did not reach the save file');
        }
        g.state = 'controls';
        return;
      }
      if (O.step === 4 && O.t > 6) {
        O.step = 5;
        note('controls: every page painted without error');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'multiplayer') {
      /* THE WHOLE MULTIPLAYER STACK, IN A REAL BROWSER, AGAINST A REAL SERVER.
       *
       * Everything under this has its own tests - the wire format round-trips
       * in cargo test, the interpolator has ten of its own, the server has
       * fifty and an integration harness. What none of them can reach is the
       * seam: the driver terminal opening the screen, the screen registering,
       * the WebAssembly proof of work landing on a challenge the server
       * accepts, the socket opening from inside a web view, and the lobby
       * painting a room without throwing.
       *
       * That seam is exactly where a multiplayer feature breaks, because it is
       * the only part that cannot be tested without all of it at once.
       */
      if (!g.__mp) {
        g.__mp = { t: 0, step: 0, seen: {} };
        note('multiplayer: server ' + (window.SYNX_SERVER || '(default)'));
      }
      var P = g.__mp;
      P.t += g.__realDt || 0.016;
      var net = window.NR && window.NR.Net;
      var mp = g.multiplayer;
      if (!net || !mp) {
        // Game.load resolves after the world is built, and the probe's first
        // frames arrive before it. Waiting is the correct behaviour; giving up
        // is only correct once it is clear nothing is coming.
        if (P.t > 25) { note('PROBLEM: multiplayer did not load'); PROBE = ''; }
        return;
      }

      if (P.step === 0 && !P.ready) { P.ready = 1; P.t = 0; }
      if (P.step === 0 && P.t > 1.0) {
        P.step = 1;
        // through the front door: the title, then the driver terminal
        g.modeSelect.open();
        var cards = g.modeSelect.cards || [];
        note('multiplayer: driver terminal has ' + cards.length + ' cards: ' +
             cards.map(function (c) { return c.getAttribute('data-mode'); }).join(', '));
        if (cards.length !== 3 || cards[1].getAttribute('data-mode') !== 'multiplayer') {
          note('PROBLEM: MULTIPLAYER is not the middle card');
        }
        // and it is not gated, unlike the open route
        if (cards[1].classList.contains('locked')) {
          note('PROBLEM: the multiplayer card is locked');
        }
        cards[1].click();
        note('multiplayer: opened, view=' + mp.view);
        return;
      }
      if (P.step === 1 && P.t > 1.6) {
        P.step = 2;
        // first run asks who is driving
        if (mp.view !== 'name') note('PROBLEM: the first session did not ask for a name');
        mp.ui.nameInput.value = 'SMOKE';
        mp.commitName();
        note('multiplayer: registered as ' + net.name + ', view=' + mp.view);
        return;
      }
      if (P.step === 2) {
        if (net.online) {
          P.step = 3;
          P.t = 0;
          // The welcome is the first message after the socket opens, so the
          // route list arrives a beat after the socket does; it is checked at
          // the next step rather than in the same frame.
          note('multiplayer: link up in ' + (net.session ? 'a session' : 'no session'));
          net.createRoom(2, false);
          return;
        }
        if (P.t > 45) { note('PROBLEM: never came online (' + net.state + ': ' + (net.lastError || '') + ')'); PROBE = ''; }
        return;
      }
      if (P.step === 3 && P.t > 1.2) {
        P.step = 4;
        P.t = 0;
        var room = net.room;
        if (!room) { note('PROBLEM: the room never arrived'); PROBE = ''; return; }
        if ((net.maps || []).length !== 7) {
          note('PROBLEM: the server offered ' + (net.maps || []).length + ' routes');
        } else {
          note('multiplayer: ' + net.maps.length + ' routes offered: ' +
               net.maps.map(function (x) { return x.name; }).join(', '));
        }
        note('multiplayer: room ' + room.code + ' on ' + (net.maps[room.map] || {}).name +
             ', host=' + net.isHost + ', seats=' + room.max_players);
        if (mp.view !== 'room') note('PROBLEM: the lobby did not switch to the room view');
        // the room view painted: count what it drew
        var seats = mp.ui.main.querySelectorAll('.mp-seat').length;
        var maps = mp.ui.main.querySelectorAll('.mp-map').length;
        note('multiplayer: room view painted ' + seats + ' seats and ' + maps + ' routes');
        // The probe is the host, so it gets the full route grid; a guest is
        // shown only the one the host picked.
        if (seats !== 4 || maps !== 7) note('PROBLEM: the room view is missing tiles');
        // There is one car now, and it is stated rather than offered.
        if (mp.ui.side.querySelector('[data-mp="ruleset"]')) {
          note('PROBLEM: the car is still a control');
        }
        if (!mp.ui.side.querySelector('.mp-fact')) note('PROBLEM: the car is not stated');
        net.listRooms();
        // the host can move the route
        net.setMap(5);
        return;
      }
      if (P.step === 4 && P.t > 2.5) {
        P.step = 5;
        P.t = 0;
        var listed = (mp.rooms || []).some(function (r) { return net.room && r.code === net.room.code; });
        note('multiplayer: listing carries ' + (mp.rooms || []).length + ' room(s), mine listed=' + listed);
        if (!listed) note('PROBLEM: a public room is not in the listing');
        if (net.room && net.room.map !== 5) note('PROBLEM: the host could not change the route');
        else note('multiplayer: route changed to ' + (net.maps[net.room.map] || {}).name);
        // the clock, which everything about a countdown depends on
        var st = net.stats();
        note('multiplayer: clock ' + (st.synced ? 'synced' : 'NOT SYNCED') +
             ', rtt ' + Math.round(st.rtt) + ' ms, buffer ' + Math.round(st.delay) + ' ms');
        if (!st.synced) note('PROBLEM: the clock never settled');
        net.leaveRoom();
        return;
      }
      if (P.step === 5 && P.t > 1.0) {
        P.step = 6;
        mp.back();
        note('multiplayer: left cleanly, state=' + g.state);
        if (net.online || net.inRoom) note('PROBLEM: the link survived leaving');
        if (mp.shown) note('PROBLEM: the lobby is still shown after leaving');
        if (mp.racing || mp.results) note('PROBLEM: race state survived leaving');
        note('multiplayer: teardown clean, online=' + net.online + ' inRoom=' + net.inRoom);
        note('multiplayer: ok');
        PROBE = '';
        return;
      }
      return;
    } else if (PROBE === 'ui') {
      /* THE SCREENS THAT ONLY EXIST AFTER SOMETHING HAPPENS.
       *
       * The podium needs a finished race, the verdict needs somebody to have
       * beaten somebody, the race menu needs a race in progress and the server
       * dialog needs a wrong address typed into it. Driving all four for real
       * would take four races and most of an hour, and the thing being checked
       * is not the race - it is whether these panels build without throwing and
       * put the right elements on the screen.
       *
       * So each one is handed exactly the input it reacts to and then read back
       * out of the DOM. It is not a substitute for playing the game; it is the
       * difference between "this has never rendered once" and "this renders,
       * with the right things in it, and does not throw".
       */
      if (!g.__ui) { g.__ui = { t: 0, step: 0 }; }
      var U = g.__ui;
      U.t += g.__realDt || 0.016;
      var net = window.NR && window.NR.Net;
      var mp = g.multiplayer;
      if (!net || !mp) {
        if (U.t > 25) { note('PROBLEM: multiplayer did not load'); PROBE = ''; }
        return;
      }

      if (U.step === 0 && U.t > 1.0) {
        U.step = 1; U.t = 0;
        g.modeSelect.open();
        (g.modeSelect.cards || [])[1].click();
        if (mp.view === 'name') { mp.ui.nameInput.value = 'UIPROBE'; mp.commitName(); }
        note('ui: opened multiplayer, view=' + mp.view);
        return;
      }

      /* ---- THE PODIUM AND THE VERDICT ------------------------------------
         Four cars, two of them finishing within half a second of each other and
         one not finishing at all - which exercises the ordering, the medal
         classes, the DNF row and the "who beat who" line in one go. */
      if (U.step === 1 && U.t > 1.2) {
        U.step = 2; U.t = 0;
        net.slot = 1; // we are SECOND, so the verdict is a gap to the winner
        try {
          mp.onResults({
            map: 0,
            hold_ms: 20000,
            rows: [
              { slot: 0, name: 'ALFA',  place: 1, time_ms: 61230, progress: 1, dnf: false, corrections: 0 },
              { slot: 1, name: 'BRAVO', place: 2, time_ms: 61650, progress: 1, dnf: false, corrections: 2 },
              { slot: 2, name: 'CHARLIE', place: 3, time_ms: 64010, progress: 1, dnf: false, corrections: 0 },
              { slot: 3, name: 'DELTA', place: 4, time_ms: null, progress: 0.42, dnf: true, corrections: 0 }
            ]
          });
        } catch (e) { note('PROBLEM: onResults threw: ' + e.message); PROBE = ''; return; }

        var pod = document.getElementById('mpPodium');
        var steps = pod ? pod.querySelectorAll('.mp-step') : [];
        note('ui: podium rendered ' + steps.length + ' steps, hidden=' + (pod && pod.hidden));
        if (steps.length !== 3) note('PROBLEM: the podium did not build three steps');
        else {
          var order = [];
          for (var i = 0; i < steps.length; i++) {
            order.push(steps[i].className.replace(/[^ ]*is-p(\d)[^ ]*/, '$1').trim().slice(0, 40));
          }
          var names = [];
          for (var j = 0; j < steps.length; j++) names.push(steps[j].querySelector('span').textContent);
          note('ui: podium reads left-to-right: ' + names.join(' | '));
          if (names[0] !== 'BRAVO' || names[1] !== 'ALFA' || names[2] !== 'CHARLIE') {
            note('PROBLEM: the podium is not 2-1-3');
          }
          if (!steps[1].classList.contains('is-p1')) note('PROBLEM: the middle step is not first place');
          if (!steps[0].classList.contains('is-you')) note('PROBLEM: our own step is not marked');
        }

        var verdict = document.getElementById('mpVerdict');
        note('ui: verdict = "' + (verdict ? verdict.textContent : '(missing)') + '"');
        if (!verdict || verdict.hidden || verdict.textContent.indexOf('ALFA') < 0) {
          note('PROBLEM: the verdict does not name the car ahead');
        }
        var title = document.getElementById('mpResultsTitle');
        note('ui: results title = "' + (title ? title.textContent : '') + '" class=' + (title ? title.className : ''));
        if (!title || title.textContent !== 'SECOND') note('PROBLEM: the title does not read SECOND');

        var rows = document.querySelectorAll('#mpResultsRows .mp-result');
        var dnf = document.querySelectorAll('#mpResultsRows .mp-result.is-dnf').length;
        note('ui: full board has ' + rows.length + ' rows, ' + dnf + ' marked DNF');
        if (rows.length !== 4 || dnf !== 1) note('PROBLEM: the full board is wrong');
        return;
      }

      /* ---- THE SERVER CHECK ---------------------------------------------- */
      if (U.step === 2 && U.t > 0.6) {
        U.step = 3; U.t = 0;
        mp.dismissResults(false);
        var checks = [
          ['not-a-url', 'rejected: not an address'],
          ['http://127.0.0.1:1', 'rejected: nothing listening'],
          [window.SYNX_SERVER || 'http://127.0.0.1:18080', 'accepted: the real server']
        ];
        var done = 0;
        checks.forEach(function (c) {
          net.probe(c[0]).then(function (r) {
            note('ui: probe(' + c[0] + ') -> ok=' + r.ok + (r.why ? ' why="' + r.why + '"' : '')
                 + (r.build ? ' build=' + r.build : ''));
            done++;
            if (done === checks.length) g.__ui.probesDone = true;
          });
        });
        return;
      }

      /* ---- THE RACE MENU, and where the standings card lands -------------- */
      if (U.step === 3 && U.t > 3.0) {
        U.step = 4; U.t = 0;
        if (!g.__ui.probesDone) note('PROBLEM: a server probe never answered');

        // placeHud puts the card under the score stack in HUD virtual space.
        var hud = g.hud;
        mp.placeHud();
        var card = document.getElementById('mpHud');
        var top = parseFloat(card.style.top);
        // The multiplier sits at virtual y=216; the card must be below it.
        var comboY = hud.vy(216);
        note('ui: score multiplier at y=' + Math.round(comboY)
             + 'px, standings card top=' + Math.round(top) + 'px, window=' + hud.h + 'px');
        if (!(top > comboY)) note('PROBLEM: the standings card is not below the multiplier');
        if (top > hud.h * 0.6) note('PROBLEM: the standings card is absurdly low');

        // The race menu, with racing faked so the menu believes there is one.
        mp.racing = true;
        try { mp.confirmLeaveRace(); }
        catch (e) { note('PROBLEM: the race menu threw: ' + e.message); }
        var choices = document.querySelectorAll('#mpDialogChoices .mp-choice');
        var labels = [];
        for (var k = 0; k < choices.length; k++) labels.push(choices[k].querySelector('b').textContent);
        note('ui: race menu offers ' + choices.length + ': ' + labels.join(' / '));
        if (choices.length !== 4) note('PROBLEM: the race menu is not four choices');
        var okBtn = document.getElementById('mpDialogOk');
        if (okBtn && !okBtn.hidden) note('PROBLEM: the confirm row is showing under a choice list');
        mp.closeDialog(null);
        mp.racing = false;
        U.step = 5; U.t = 0;
        return;
      }

      /* ---- THE "CLEAN" MULTIPLIER --------------------------------------
         It used to tick up every twelve seconds whatever the car was doing,
         so a parked car collected CLEAN x2, x3, x4 for nothing. Driven
         directly here rather than by waiting: thirty simulated seconds of a
         stationary car, then thirty of a moving one, and the multiplier must
         only move in the second half. */
      if (U.step === 5) {
        U.step = 6;
        var before = g.combo;
        var toasts = 0;
        var realToast = g.hud.toast;
        g.hud.toast = function (t, c) { if (String(t).indexOf('CLEAN') === 0) toasts++; return realToast.call(g.hud, t, c); };

        var savedSpeed = g.car.speed, savedDrift = g.car.driftAmount;
        g.car.speed = 0; g.car.driftAmount = 0; g.cleanTime = 0; g.combo = 1;
        for (var n = 0; n < 1800; n++) g.updateScore(1 / 60);   // 30 s parked
        var parkedCombo = g.combo, parkedToasts = toasts;

        g.car.speed = 40; g.car.driftAmount = 0;
        for (var m2 = 0; m2 < 1800; m2++) g.updateScore(1 / 60); // 30 s moving
        var movingCombo = g.combo, movingToasts = toasts;

        g.hud.toast = realToast;
        g.car.speed = savedSpeed; g.car.driftAmount = savedDrift;
        g.combo = before; g.cleanTime = 0;

        note('ui: clean multiplier - parked 30s: combo ' + parkedCombo + ', ' + parkedToasts
             + ' toast(s); then moving 30s: combo ' + movingCombo + ', ' + movingToasts + ' toast(s)');
        if (parkedToasts !== 0 || parkedCombo !== 1) {
          note('PROBLEM: a parked car still earns CLEAN');
        }
        if (movingToasts < 2) note('PROBLEM: a moving car stopped earning CLEAN');
        note('ui: ok');
        PROBE = '';
        return;
      }
      return;
    } else if (PROBE === 'ghost' && step >= 1) {
      /* IS TRIAL 05 ACTUALLY BEATABLE?
       *
       * The commit window is only a fair window if the escape it asks for fits
       * inside it, and that depends on the car's real lateral grip at the
       * trial's speed cap - a number no amount of reading the source produces.
       * So the trial is played, by the only policy the design intends: sit
       * still while the arch is tracking, and go the moment it commits.
       *
       * If a policy that does exactly what the trial tells you to do cannot
       * break three of five, the window is too short. If it breaks five of
       * five without trying, it is too long.
       */
      if (!g.__gh) {
        // the director gates on being inside chapter 6's race, the same way
        // chapter 7's does - see the chapter7 probe
        var CH6 = (window.NR && NR.STORY_CHAPTERS) || [];
        for (var c6 = 0; c6 < CH6.length; c6++) if (CH6[c6] && CH6[c6].id === 6) g.story.chapter = CH6[c6];
        g.story.mode = 'race';
        var d6i = g.__level6Director;
        if (!d6i && window.NR && NR.Level6Director) d6i = new NR.Level6Director(g);
        if (!d6i) { note('PROBLEM: no level 6 director on this route'); PROBE = ''; return; }
        note('ghost: level6=' + !!(g.level && g.level.level6) + ' chapter=' + (g.story.chapter && g.story.chapter.id));
        /* Let the director start itself on its own update first - forcing the
           phase before that happens just gets overwritten by start(). */
        if (!d6i.started) return;
        d6i.phase = 'ghost';
        d6i.ghostBroken = 0; d6i.ghostClamped = 0; d6i.ghostHabit = 0;
        for (var ai = 0; ai < d6i.arches.length; ai++) {
          var aa = d6i.arches[ai];
          aa.armed = false; aa.done = false; aa.committed = false;
          aa.predicted = 0; aa.aim = 0; aa.hit = false;
        }
        /* --at <n> runs one arch rather than the set: five of them at the
           trial's speed cap is twenty minutes of a headless browser, and the
           question being asked is usually about one tier. */
        var only = AT === '' ? -1 : (parseInt(AT, 10) || 0);
        var startArch = only < 0 ? 0 : Math.max(0, Math.min(4, only));
        // skipped, not played - so the report below does not claim them
        for (var si = 0; si < startArch; si++) { d6i.arches[si].done = true; d6i.arches[si].skipped = true; }
        g.story.setVehicle(g.car, d6i.arches[startArch].s - 300, 0, 50);
        d6i.phaseTime = 0; d6i.failTimer = 0;
        g.__gh = { t: 0, dir: 1, seen: {}, only: only };
        note('ghost: placed 300u before arch 0' + (startArch + 1) +
             (only < 0 ? ', five arches to run' : ', that one only'));
      }
      var G = g.__gh, d6 = g.__level6Director, dtg = g.__realDt || 0.016;
      G.t += dtg;
      g.input.keys['arrowup'] = true;
      // the nearest arch still ahead of the car
      var cur = null;
      for (var bi = 0; bi < d6.arches.length; bi++) {
        var b = d6.arches[bi];
        if (!b.done && b.s > g.car.sTrack - 4) { cur = b; break; }
      }
      g.input.keys['arrowleft'] = false; g.input.keys['arrowright'] = false;
      if (cur) {
        if (!G.seen[cur.tier] && cur.committed) {
          G.seen[cur.tier] = 1;
          // alternate, because the model punishes repeating a direction
          G.dir = -G.dir;
          note('ghost: arch 0' + (cur.tier + 1) + ' committed at ' +
               (cur.s - g.car.sTrack).toFixed(0) + 'u, ' +
               ((cur.s - g.car.sTrack) / Math.max(1, g.car.speed)).toFixed(2) + 's out' +
               '  lat=' + (g.car.lateral || 0).toFixed(1) +
               '  clamp=' + cur.predicted.toFixed(1));
        }
        if (!cur.committed && LOOK === 'early') {
          /* THE OLD EXPLOIT, AS A TEST.
             The trial this replaced could be beaten by steering away as soon
             as the arch lit and then doing nothing else. If that still works
             the redesign did not happen, so it is played deliberately: go
             early, hold, and see what the clamp does about it. */
          var eoff = (g.car.lateral || 0) - cur.predicted;
          if (Math.abs(eoff) < 12) g.input.keys[G.dir > 0 ? 'arrowright' : 'arrowleft'] = true;
        }
        if (cur.committed && LOOK === 'early') {
          // ...and nothing at all once it commits. That was the whole trick.
        } else if (cur.committed) {
          /* Go, away from where it called - and STOP once clear, because
             holding full lock all the way to the arch runs the car into the
             barrier and reports a margin that says nothing about whether the
             window was long enough. */
          var off = (g.car.lateral || 0) - cur.predicted;
          var need = (window.__ghostTiers ? window.__ghostTiers[cur.tier].catch : 6) + 1.6;
          var away = Math.abs(off) < 1.0 ? G.dir : (off >= 0 ? 1 : -1);
          if (Math.abs(off) < need) g.input.keys[away > 0 ? 'arrowright' : 'arrowleft'] = true;
          else if (Math.abs(g.car.vLat || 0) > 2) g.input.keys[away > 0 ? 'arrowleft' : 'arrowright'] = true;
        }
      }
      G.tick = (G.tick || 0) + dtg;
      if (G.tick > 3 && cur) {
        G.tick = 0;
        note('ghost: .. ' + (cur.s - g.car.sTrack).toFixed(0) + 'u out  lat=' +
             (g.car.lateral || 0).toFixed(1) + '  clamp=' + cur.predicted.toFixed(1) +
             '  aim=' + cur.aim.toFixed(1) + '  v=' + (g.car.speed || 0).toFixed(0) +
             (cur.committed ? '  COMMITTED' : ''));
      }
      // ...and what the margin actually was, arch by arch
      for (var ri = 0; ri < d6.arches.length; ri++) {
        var rr = d6.arches[ri];
        if (rr.done && !rr.skipped && !G['r' + ri]) {
          G['r' + ri] = 1;
          var cw = window.__ghostTiers ? window.__ghostTiers[rr.tier] : null;
          note('ghost: arch 0' + (rr.tier + 1) + (rr.hit ? ' CLAMPED' : ' BROKEN') +
               '  miss=' + Math.abs((g.car.lateral || 0) - rr.predicted).toFixed(1) +
               'u  catch=' + (cw ? cw.catch : '?') +
               'u  window=' + (cw ? (cw.commit / 50).toFixed(2) : '?') + 's' +
               '  v=' + (g.car.speed || 0).toFixed(0));
        }
      }
      if (!G.done && G.only >= 0 && d6.arches[Math.max(0, Math.min(4, G.only))].done) {
        G.done = true; PROBE = '';
        note('ghost: single-arch run finished');
      }
      if (!G.done && (d6.phase !== 'ghost' || d6.arches.every(function (x) { return x.done; }))) {
        G.done = true;
        note('ghost: RESULT broken=' + d6.ghostBroken + '/5  clamped=' + d6.ghostClamped +
             '  (three broken is a pass)');
        PROBE = '';
      }
      if (G.t > 90 && !G.done) { G.done = true; note('ghost: timed out, broken=' + d6.ghostBroken); PROBE = ''; }
      return;
    } else if (PROBE === 'engine' && step >= 1) {
      /* DOES IT SOUND LIKE A CAR?
       *
       * That reads like a matter of taste and it is not. The report was that
       * the cold open sounded like a motorcycle, and there is a measurable
       * difference between the two which is exactly the thing that was wrong.
       *
       * A four-stroke V8 fires four times per revolution, so at 3000 rpm the
       * FIRING RATE is 200 Hz. An engine whose cylinders are evenly spaced -
       * a single, a parallel twin, a flat-plane V8 - puts essentially all of
       * its energy there and at multiples of it, and nothing in between: that
       * is a smooth, even, high-sounding note, and it is what an oscillator
       * at the firing frequency produces by construction.
       *
       * A CROSS-PLANE V8 DOES NOT. Its two banks fire unevenly - 270, 180,
       * 90, 180 degrees on one side and the mirror of that on the other - so
       * the pattern only repeats once every two revolutions, and that puts
       * real energy at HALF the firing rate. 100 Hz, at 3000 rpm. That
       * subharmonic IS the rumble; it is the whole of what makes a muscle car
       * sound like one, and a synthesiser that has none of it cannot sound
       * like anything but a motorcycle however it is filtered.
       *
       * So: render the engine offline, take a Goertzel at both frequencies,
       * and compare. It is one number, it is not an opinion, and it fails on
       * the implementation this replaced.
       */
      /* ...and the LIVE cold open, not only an offline render: a worklet
         that compiles in an OfflineAudioContext and fails to reach the real
         graph is a silent engine on every launch. */
      if (window.NR && window.NR.Ignition && window.__ignRig !== undefined) {
        note("engine: the cold open is running the " +
             (window.__ignRig ? "worklet" : "fallback"));
        if (!window.__ignRig) note("PROBLEM: the cold open fell back to oscillators");
      }
      if (!window.__eng) {
        window.__eng = 1;
        var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!OAC) { note('PROBLEM: no OfflineAudioContext to render the engine into'); PROBE = ''; return; }
        var SR = 48000, SECS = 2, RPM = 3000;
        var oc = new OAC(2, SR * SECS, SR);
        oc.audioWorklet.addModule('js/engine-worklet.js?v=rust-1').then(function () {
          var nd = new AudioWorkletNode(oc, 'synx-engine', {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
          });
          nd.parameters.get('rpm').value = RPM;
          nd.parameters.get('load').value = 1;
          nd.parameters.get('gain').value = 1;
          nd.connect(oc.destination);
          return oc.startRendering();
        }).then(function (buf) {
          var d = buf.getChannelData(0);
          // the second half only: the first is the resonators settling
          var from = (d.length / 2) | 0, n = d.length - from;
          var rms = 0;
          for (var i = from; i < d.length; i++) rms += d[i] * d[i];
          rms = Math.sqrt(rms / n);
          // one frequency at a time, which is all this needs
          var power = function (f) {
            var w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w);
            var s1 = 0, s2 = 0;
            for (var k = from; k < d.length; k++) {
              var t = d[k] + c * s1 - s2;
              s2 = s1; s1 = t;
            }
            return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / n;
          };
          var fire = (RPM / 60) * 4;            // 200 Hz: the firing rate
          var half = fire / 2;                  // 100 Hz: the cross-plane rumble
          var ratio = power(fire) > 0 ? power(half) / power(fire) : 0;
          note('engine: rendered ' + SECS + 's at ' + RPM + ' rpm, rms ' + rms.toFixed(4));
          note('engine: ' + half + ' Hz (cross-plane rumble) is ' + (ratio * 100).toFixed(0) +
               '% of ' + fire + ' Hz (firing rate)');
          if (!(rms > 0.01)) note('PROBLEM: the engine rendered silence');
          else if (ratio < 0.25) {
            note('PROBLEM: there is no energy at half the firing rate - the banks are ' +
                 'firing evenly, which is a motorcycle, not a V8');
          } else {
            note('engine: the banks fire unevenly and the rumble is there');
          }
        }).catch(function (e) {
          note('PROBLEM: the engine worklet would not load or render: ' + (e && e.message));
        });
      }
      PROBE = '';
      return;
    } else if (PROBE === 'lose' && step >= 1) {
      /* CAN EVERY CHAPTER ACTUALLY BE LOST?
       *
       * Two of them could not, and both failures looked like features from
       * the inside: chapter 5 set won = false on its way into a scripted
       * finale and completed anyway, so finishing second played the same
       * cinematic and awarded the same prototype; chapter 6 handed over the
       * driver link on the branch where the trial had been failed, and every
       * other failure rewound to a checkpoint forever.
       *
       * Neither was visible from a passing run - you have to LOSE to see
       * them, and nothing in this harness was losing. So each rule is put
       * the question directly, with the cars where they would be.
       */
      var L = g.__lose || (g.__lose = { n: 0 });
      L.n++;
      if (L.n < 4 || L.done) return;
      L.done = 1;
      var st = g.story;
      if (!st) { note("PROBLEM: there is no story manager"); PROBE = ""; return; }
      if (!st.loseRace) { note("PROBLEM: there is no shared loss path"); PROBE = ""; return; }

      /* ---------------------------------------------- CHAPTER 5, IN FRONT */
      var d5 = g.__level5Director;
      if (!d5) { note("PROBLEM: there is no chapter 5 director"); PROBE = ""; return; }
      var atTrigger = g.finishAt - d5.finishTriggerUnits() - 2;
      var setUp = function (playerLead) {
        g.raceOver = false;
        g.state = "racing";
        d5.finishPending = null;
        d5.active = null;
        g.car.sTrack = atTrigger + 10;
        if (g.rival) g.rival.sTrack = g.car.sTrack - playerLead;
      };
      setUp(40);
      var leads = d5.shouldStartFinish();
      setUp(-40);                     // forty units DOWN on the rival
      var trails = d5.shouldStartFinish();
      note("lose: chapter 5 finale runs when leading = " + leads
           + ", when trailing = " + trails);
      if (!leads) {
        note("PROBLEM: HUNT//REDLINE does not run for a player who earned it");
      }
      if (trails) {
        note("PROBLEM: the scripted finale still plays from second - the "
             + "chapter cannot be lost");
      }

      /* ------------------------------- ...AND WHAT THE FINISH DOES ABOUT IT */
      /* handleFinish is the thing that chooses between the epilogue (which
         completes the chapter and awards the R-IX) and the retry. Asked with
         the flags a losing run would actually carry. */
      var fakeChapter = { id: 5, canonicalLoss: true, track: "ASHFALL ZERO", rival: "RYKER" };
      var wasChapter = st.chapter, wasMode = st.mode, wasWon = g.won;
      var epilogues = 0, losses = 0;
      var realEpilogue = st.startCanonicalLossEpilogue;
      var realLegacy = st.finishAsLegacyLoss;
      st.startCanonicalLossEpilogue = function () { epilogues++; };
      st.finishAsLegacyLoss = function () { losses++; };
      var ask = function (earned, forced) {
        st.chapter = fakeChapter;
        st.mode = "race";
        st.canonicalEarned = earned;
        st.forcedLoss = forced || "";
        g.raceOver = false;
        epilogues = 0;
        try { st.handleFinish(function () {}); } catch (e) { /* shot machinery */ }
        return epilogues;
      };
      var earnedGoesToEpilogue = ask(true, "") > 0;
      var lostGoesToEpilogue = ask(false, "") > 0;
      st.startCanonicalLossEpilogue = realEpilogue;
      st.finishAsLegacyLoss = realLegacy;
      st.chapter = wasChapter; st.mode = wasMode; g.won = wasWon;
      st.canonicalEarned = false; st.forcedLoss = "";
      note("lose: the scripted ending plays when earned = " + earnedGoesToEpilogue
           + ", when beaten = " + lostGoesToEpilogue);
      if (!earnedGoesToEpilogue) {
        note("PROBLEM: a player who earned the ending does not get it");
      }
      if (lostGoesToEpilogue) {
        note("PROBLEM: finishing second still plays the scripted ending and "
             + "awards the prototype");
      }

      /* -------------------------------------------------------- CHAPTER 6 */
      var d6 = g.__level6Director;
      if (!d6) { note("PROBLEM: there is no chapter 6 director"); PROBE = ""; return; }
      if (!d6.javasAhead || !d6.loseChapter) {
        note("PROBLEM: chapter 6 has no way for Javas to win");
      } else {
        d6.chapterLost = false;
        var was6 = g.rival ? g.rival.sTrack : 0, wasCar = g.car.sTrack;
        // level, and he has not won
        g.car.sTrack = 120000; if (g.rival) g.rival.sTrack = 120000;
        var level = d6.javasAhead();
        // he is over the line and the player is not
        g.car.sTrack = 126000; if (g.rival) g.rival.sTrack = 126600;
        var past = d6.javasAhead();
        g.car.sTrack = wasCar; if (g.rival) g.rival.sTrack = was6;
        note("lose: chapter 6 reports Javas ahead when level = " + level
             + ", when he is past the line = " + past);
        /* ...AND THAT IT IS WIRED IN. A helper that gives the right answer
           and is never called is the same bug with an alibi, so the real tick
           is run with him over the line and the chapter is asked whether it
           noticed. */
        var realLose = st.loseRace, called = 0;
        st.loseRace = function () { called++; return true; };
        /* The probe runs on chapter 5 road, so the chapter 6 director would
           tear itself down on the first line of its own tick. Told it is on
           its own chapter for the length of one frame, which is the only way
           to ask whether the tick NOTICES - and noticing is the half that was
           missing, not the arithmetic. */
        var realIs = d6.isChapter, realMode = st.mode;
        d6.isChapter = function () { return true; };
        st.mode = "race";
        d6.chapterLost = false;
        d6.started = true;
        d6.phase = "ghost";
        g.car.sTrack = 126000; if (g.rival) g.rival.sTrack = 126600;
        try { d6.afterUpdate(1 / 60); } catch (e) { /* trial machinery */ }
        st.loseRace = realLose;
        d6.isChapter = realIs; st.mode = realMode;
        g.car.sTrack = wasCar; if (g.rival) g.rival.sTrack = was6;
        note("lose: with Javas over the line, one real tick lost the chapter = "
             + (called > 0));
        if (!called) {
          note("PROBLEM: chapter 6 ticks past Javas winning without noticing");
        }
        d6.chapterLost = false; d6.phase = "idle"; d6.started = false;
        if (level) note("PROBLEM: chapter 6 calls a level race a defeat");
        if (!past) {
          note("PROBLEM: Javas can finish the trials first and the chapter "
               + "carries on rewarding the player");
        }
      }

      /* ------------------------------------------------------ THE BACKSTOP */
      /* Nothing may clear a chapter without having won it. This is what stops
         the NEXT director being written without a losing condition. */
      var cleared = 0, diverted = 0;
      var realPersist = st.persist, realShow = st.showTitle, realCut = st.cutTo;
      st.persist = function () { cleared++; };
      st.showTitle = function () {};
      st.cutTo = function () {};
      var realLegacy2 = st.finishAsLegacyLoss;
      st.finishAsLegacyLoss = function () { diverted++; };
      st.chapter = fakeChapter;
      g.won = false;
      st.canonicalEarned = false;
      st.forcedLoss = "";
      try { st.completeChapter(); } catch (e) { /* save machinery */ }
      st.persist = realPersist; st.showTitle = realShow; st.cutTo = realCut;
      st.finishAsLegacyLoss = realLegacy2;
      st.chapter = wasChapter; g.won = wasWon; st.forcedLoss = "";
      note("lose: completing a chapter that was not won -> cleared " + cleared
           + ", diverted to a loss " + diverted);
      if (cleared) {
        note("PROBLEM: a chapter can still be cleared without being won");
      }
      if (!diverted) {
        note("PROBLEM: the completion backstop did not send a lost chapter to the loss path");
      }
      PROBE = "";
      return;
    } else if (PROBE === 'hub' && step >= 1) {
      /* SEVEN CHAPTERS, HOW MANY FACES?
       *
       * Every tile asked for its rival's its neutral portrait, and three of the
       * seven chapters share a rival - so the board was the same photograph
       * of Ryker in three places, plus a fourth in chapter 7 where the thing
       * on the card is not even him. That is the sort of defect a person
       * notices instantly and a test never does, so this counts the distinct
       * images and checks the boss is marked.
       */
      var H = g.__hub || (g.__hub = { n: 0 });
      H.n++;
      if (H.n < 4 || H.done) return;
      H.done = 1;
      var st = g.story;
      if (!st) { note("PROBLEM: there is no story manager"); PROBE = ""; return; }
      /* The board is built by the hub, so the hub is opened - every chapter
         unlocked, which is also the state the reported screenshot was in. */
      try {
        st.save = st.save || {};
        st.save.completedChapters = [1, 2, 3, 4, 5, 6, 7];
        st.openHub();
      } catch (e) { note("hub: openHub threw " + e.message); }
      var tiles = document.querySelectorAll(".story-chapter");
      if (!tiles.length) { note("PROBLEM: the hub drew no chapter tiles"); PROBE = ""; return; }
      var seen = {}, faces = 0, boss = 0, list = [];
      for (var i = 0; i < tiles.length; i++) {
        var im = tiles[i].querySelector("img");
        var src = im ? (im.getAttribute("src") || "") : "";
        var leaf = src.split("/").pop().split("?")[0];
        if (!seen[leaf]) { seen[leaf] = 1; faces++; }
        if (tiles[i].classList.contains("is-boss")) boss++;
        list.push(leaf);
      }
      note("hub: " + tiles.length + " tiles, " + faces + " distinct portraits");
      note("hub:   " + list.join("  "));
      note("hub: " + boss + " tile(s) marked as the boss");
      /* Five is the most the pack can give: seven chapters, four characters,
         and Javas ships one portrait. Fewer than five means a chapter is
         still reusing a face it did not have to. */
      if (faces < 5) {
        note("PROBLEM: only " + faces + " distinct portraits across " + tiles.length + " chapters");
      }
      if (boss !== 1) {
        note("PROBLEM: " + boss + " tile(s) marked as the boss, wanted exactly one");
      }
      PROBE = "";
      return;
    } else if (PROBE === 'forge' && step >= 1) {
      /* THE CAR THAT ARRIVES AT THE FORGE, AND THE CAR THAT LEAVES IT.
       *
       * Chapter 6 is a chapter about a rebuild, and it used to open on a car
       * in showroom condition doing the full street 132 mph - so the rebuild
       * at the end of it was worth twelve miles an hour and no visible
       * difference to the bodywork. Both halves of that are now scripted
       * state, and both halves are checked here, because either one being
       * dropped leaves the chapter telling a story the car is not in.
       *
       * Driven through the director rather than by playing the chapter: the
       * trials are several minutes of driving and this harness manages about
       * a frame a second. What is exercised is the real startTrial and the
       * real showSkill, on the real car, so the numbers are the ones a
       * player would be handed.
       */
      var F = g.__forge || (g.__forge = { n: 0 });
      F.n++;
      if (F.n < 4 || F.done) return;
      F.done = 1;
      var d6 = g.__level6Director;
      if (!d6) { note("PROBLEM: there is no chapter 6 director"); PROBE = ""; return; }
      var car = g.car;

      // as it arrives: the wreck Ryker left in the caldera
      try { d6.startTrial(); } catch (e) { note("forge: startTrial threw " + e.message); }
      var brokenMph = car.engineTopMph || 0;
      var brokenCap = car.ceilingMph || 0;
      var brokenBody = (g.damage && g.damage.total) || 0;
      note("forge: on arrival the car does " + brokenMph.toFixed(0) + " mph on the block ("
           + brokenCap.toFixed(0) + " with the reheat), body damage "
           + (brokenBody * 100).toFixed(0) + "%");
      if (!(brokenMph > 66 && brokenMph <= 74)) {
        note("PROBLEM: the wreck does " + brokenMph.toFixed(0) + " mph, wanted about 70");
      }
      if (!(brokenBody > 0.98)) {
        note("PROBLEM: the car arrives at the Forge with " + (brokenBody * 100).toFixed(0)
             + "% damage, wanted a full bar");
      }
      /* count is a render-side cache filled by pack() on the next draw;
         dents is the model, and the model is what has to be wrecked. */
      var dents = (g.damage && g.damage.dents && g.damage.dents.length) || 0;
      if (!dents) {
        note("PROBLEM: the bar is full but there is not a dent on the bodywork");
      } else {
        note("forge: " + dents + " dent(s) in the panels on arrival");
      }

      // ...and what Javas hands back
      try { d6.showSkill(); } catch (e) { note("forge: showSkill threw " + e.message); }
      var fixedMph = car.engineTopMph || 0;
      var fixedCap = car.ceilingMph || 0;
      var fixedBody = (g.damage && g.damage.total) || 0;
      note("forge: after the rebuild it does " + fixedMph.toFixed(0) + " mph on the block ("
           + fixedCap.toFixed(0) + " with the reserve), body damage "
           + (fixedBody * 100).toFixed(0) + "%");
      if (!(fixedMph > 140 && fixedMph <= 148)) {
        note("PROBLEM: the rebuild gives " + fixedMph.toFixed(0) + " mph, wanted 144");
      }
      if (!(fixedCap > 195 && fixedCap <= 205)) {
        note("PROBLEM: the reserve ceiling is " + fixedCap.toFixed(0) + " mph, wanted 200");
      }
      if (fixedBody > 0.001) {
        note("PROBLEM: Javas rebuilt the engine and handed the body back bent ("
             + (fixedBody * 100).toFixed(0) + "%)");
      }
      if (g.damage && g.damage.dents && g.damage.dents.length) {
        note("PROBLEM: " + g.damage.dents.length + " dent(s) survived the rebuild");
      }
      /* AND IT IS WORTH SOMETHING. The whole complaint was that the rebuild
         did not feel like one; a factor of two is the number that makes the
         calibration run on Straight 07 read as a different car. */
      var gain = brokenMph > 0 ? fixedMph / brokenMph : 0;
      note("forge: the rebuild is worth x" + gain.toFixed(2) + " on the block");
      if (gain < 1.9) {
        note("PROBLEM: the rebuild only gains x" + gain.toFixed(2));
      }

      // ...and none of it follows the player into the next chapter
      try { d6.reset(); } catch (e) { /* nothing to tear down */ }
      note("forge: after teardown the car does " + (car.engineTopMph || 0).toFixed(0)
           + " mph with " + (((g.damage && g.damage.total) || 0) * 100).toFixed(0) + "% damage");
      if ((g.damage && g.damage.total) > 0.001) {
        note("PROBLEM: the wreck followed the player out of chapter 6");
      }
      PROBE = "";
      return;
    } else if (PROBE === 'clear' && step >= 1) {
      /* IS ANYTHING STANDING IN THE ROAD, ANYWHERE ON THE COURSE?
       *
       * A hundred and seventy-five kilometres, eight zones and a dozen
       * systems that put things beside the road, every one of which already
       * has its own clearance test and every one of which passed - while
       * there was a building across the carriageway on two different
       * routes. Reading the generators one at a time and reasoning about
       * which was wrong is how the third one gets missed.
       *
       * So the finished GEOMETRY is asked instead. See auditClear in
       * js/scene.js: every vertex of every batch of dressing is tested
       * against the nearest road, and anything inside the painted
       * carriageway and within the height a car occupies is reported, with
       * the material that emitted it and the station it is at. A generator
       * cannot pass this by having its own opinion of what clear means.
       */
      var sc = g.scene;
      if (!sc || !sc.clearHits) {
        note("PROBLEM: the clearance audit did not run - the flag never reached the build");
        PROBE = "";
        return;
      }
      /* ------------------------- IS THE FIELD THE GENERATORS TRUST CORRECT?
       *
       * Every clearance test in the world - "no tower within two hundred",
       * "no prop within a hundred and ten" - is a call to Scene.roadAt, and
       * roadAt is an approximation. It looks the point up in a coarse grid of
       * nearest-station seeds and then refines within forty-eight stations of
       * whatever that seed was. Forty-eight stations is under three hundred
       * units of road; the course doubles back on itself repeatedly.
       *
       * If a cell is seeded to the wrong branch, roadAt will happily report a
       * point as two hundred units from the road while it is sitting on a
       * different part of the same road twenty units away - and EVERY test
       * built on it, including the audit above, agrees. That is exactly the
       * shape of a bug that puts a building in the carriageway while every
       * check passes.
       *
       * So it is held against a brute-force scan of the whole centreline at a
       * few hundred points. Slow, and it does not have to be fast: it runs
       * once, in a probe, to decide whether the cheap answer can be believed.
       */
      var C = sc.man && sc.man.centre;
      if (C && sc.roadAt) {
        var worstErr = 0, worstAt = null, checked = 0;
        var offs = 0, offWorst = Infinity, offAt = null;
        for (var t = 0; t < 600; t++) {
          // spread over the course, out to where things are actually built
          var si = Math.floor((t / 600) * (C.count - 1));
          var ang = (t * 2.399963) % 6.2831853;
          var rad = 40 + ((t * 37) % 520);
          var px = C.x[si] + Math.cos(ang) * rad;
          var pz = C.z[si] + Math.sin(ang) * rad;
          var fast = sc.roadAt(px, pz);
          if (fast.off) {
            /* "Not near any road" is a real answer only beyond the stamped
               reach. Anywhere else it is a hole, and every clearance test in
               the world reads it as open country. */
            offs++;
            var bd0 = Infinity;
            for (var q = 0; q < C.count; q++) {
              var qx = C.x[q] - px, qz = C.z[q] - pz;
              var q2 = qx * qx + qz * qz;
              if (q2 < bd0) bd0 = q2;
            }
            var od = Math.sqrt(bd0);
            if (od < offWorst) { offWorst = od; offAt = [Math.round(px), Math.round(pz)]; }
            continue;
          }
          var bd = Infinity;
          for (var i = 0; i < C.count; i++) {
            var dx = C.x[i] - px, dz = C.z[i] - pz;
            var d2 = dx * dx + dz * dz;
            if (d2 < bd) bd = d2;
          }
          var truth = Math.sqrt(bd);
          checked++;
          var err = fast.d - truth;   // positive = roadAt thinks it is further out
          if (err > worstErr) {
            worstErr = err;
            worstAt = [Math.round(px), Math.round(pz), truth, JSON.stringify(fast), fast.d];
          }
        }
        note("clear: roadAt said OFF (no road anywhere) at " + offs + " point(s); "
             + "the closest of those was really " + (offWorst === Infinity ? "-" : offWorst.toFixed(1))
             + "u from the road" + (offAt ? " at " + offAt[0] + "," + offAt[1] : ""));
        if (offWorst < 400) {
          note("PROBLEM: the road-distance field has holes ON the road - every "
               + "clearance test reads a hole as open country");
        }
        note("clear: roadAt checked against a full scan at " + checked + " points; "
             + "worst overestimate " + worstErr.toFixed(1) + "u"
             + (worstAt ? " (said " + worstAt[4] + ", really " + worstAt[2].toFixed(1)
               + "u; it landed on sample " + worstAt[3] + " of " + C.count + ")" : ""));
        if (worstErr > 12) {
          note("PROBLEM: the road-distance field overestimates by " + worstErr.toFixed(0)
               + "u - every clearance test in the world is built on it");
        }
      }

      var rows = [];
      sc.clearHits.forEach(function (r) { rows.push(r); });

      /* WHAT COUNTS AS AN OBSTACLE, and what is simply road furniture.
       *
       * Most of what the sweep reports belongs where it is. An arch straddles
       * the carriageway - legs at the edge, crown twenty-five units up over
       * the middle. A sign gantry hangs at fifty. A palm frond reaches over
       * the verge. All of them have geometry inside the corridor and none of
       * them is a thing you can hit.
       *
       * The number that separates a thing that SPANS the road from a thing
       * that STANDS in it is how low it gets over the MIDDLE of it - see
       * lowMid in js/scene.js. Six units is higher than any car in the game
       * and lower than any structure meant to be driven under.
       */
      var STAND = 6;
      var solid = rows.filter(function (r) { return r.lowMid < STAND; });
      var over = rows.filter(function (r) { return !(r.lowMid < STAND); });
      rows.sort(function (x, y) { return x.lowMid - y.lowMid; });

      note("clear: swept the whole course - " + solid.length + " thing(s) STANDING in the "
           + "carriageway, " + over.length + " passing over or beside it");
      for (var i = 0; i < solid.length; i++) {
        var r = solid[i];
        note("clear:   IN THE ROAD // " + r.name + "  " + r.lowMid.toFixed(1) +
             "u above the surface over the middle of the lane at s=" + Math.round(r.lowAt) +
             "  (" + r.lowN + " low point(s) of " + r.n + " in the corridor)");
      }
      /* The rest is listed too, because a sweep that only prints failures is
         a sweep nobody can sanity-check. Closest approach and height, so a
         gantry that has crept down can be seen before it becomes a crash. */
      over.sort(function (x, y) { return x.minD - y.minD; });
      for (var j = 0; j < Math.min(12, over.length); j++) {
        var q = over[j];
        note("clear:   over/beside // " + q.name + "  closest " + q.minD.toFixed(1) +
             "u from the centre line, " + (q.lowMid === 1e9 ? "never over the middle"
               : q.lowMid.toFixed(1) + "u up when it is") +
             "  at s=" + Math.round(q.at));
      }
      if (solid.length) {
        note("PROBLEM: " + solid.length + " thing(s) are standing in the carriageway");
      } else {
        note("clear: nothing is standing in the road on any route, "
             + "over the whole 175 km of course");
      }
      PROBE = "";
      return;
    } else if (PROBE === 'runs' && step >= 1) {
      // where the tunnels are, so a screenshot can be taken inside one
      var R = g.scene && g.scene.tunnelRuns;
      var RR = window.NR.COURSE_RAMPS || [];
      note('ramps: ' + JSON.stringify(RR.map(function (r) {
        return [Math.round(r.s), Math.round(r.len), +(r.h || 0).toFixed(1), r.crest ? 'crest' : 'ramp']; })));
      note('runs: ' + (R ? JSON.stringify(R.map(function (p) {
        return [Math.round(p[0]), Math.round(p[1])]; })) : 'none'));
      PROBE = '';
      return;
    } else if (PROBE === 'glstate' && step >= 1) {
      /* HOW MANY GL STATE CALLS NEVER LEAVE THE PAGE.
       *
       * The redundant state filter in js/game.js is only worth having if it
       * is actually catching something, and 'obviously it is' is how a
       * renderer ends up carrying an optimisation that costs more than it
       * saves. This counts both sides of it over a measured number of frames
       * and reports the share - per frame, so the number means something
       * next to a frame budget rather than being a total that grows.
       */
      var S = g.__gls || (g.__gls = { n: 0, from: null, bad: [] });
      var c = g.gl && g.gl.__state;
      if (!c) { note('PROBLEM: the state filter is not installed'); PROBE = ''; return; }

      /* DOES THE CACHE STILL AGREE WITH THE DRIVER?
       *
       * This is the only question that matters about a redundant-call filter.
       * It saves calls by believing it knows what the state is; if that belief
       * is ever wrong, the call it suppresses is one that was needed, and what
       * comes out is not an error - it is one draw with the wrong texture, or
       * the wrong blend, on one machine, once. Nothing would ever find it.
       *
       * So every frame the model is read back out of the cache and held
       * against what WebGL says the state actually is. getParameter is far too
       * expensive to leave in a renderer - it stalls the pipeline - which is
       * exactly why it belongs in a probe and not in the filter.
       */
      var gl = g.gl, want = c.believed(), miss = [];
      var cmp = function (what, mine, theirs) {
        if (mine === undefined) return;          // never set: nothing to claim
        if (mine !== theirs) miss.push(what + " cache=" + mine + " driver=" + theirs);
      };
      cmp("program", want.prog, gl.getParameter(gl.CURRENT_PROGRAM));
      cmp("vao", want.vao, gl.getParameter(gl.VERTEX_ARRAY_BINDING));
      cmp("activeTexture", want.unit, gl.getParameter(gl.ACTIVE_TEXTURE));
      cmp("depthMask", want.depthW, gl.getParameter(gl.DEPTH_WRITEMASK));
      cmp("depthFunc", want.depthF, gl.getParameter(gl.DEPTH_FUNC));
      cmp("cullFace", want.cull, gl.getParameter(gl.CULL_FACE_MODE));
      cmp("frontFace", want.front, gl.getParameter(gl.FRONT_FACE));
      cmp("blendSrc", want.blendS, gl.getParameter(gl.BLEND_SRC_RGB));
      cmp("blendDst", want.blendD, gl.getParameter(gl.BLEND_DST_RGB));
      want.caps.forEach(function (on, capName) {
        cmp("cap " + capName, on, gl.isEnabled(capName));
      });
      /* ...and the texture bound to whichever unit is live, which is the one
         binding a wrong cache would corrupt most visibly. */
      var live = gl.getParameter(gl.ACTIVE_TEXTURE);
      var key2d = (want.unit === undefined ? -1 : want.unit) + ":" + gl.TEXTURE_2D;
      if (want.unit === live && want.units.has(key2d)) {
        cmp("texture2D", want.units.get(key2d), gl.getParameter(gl.TEXTURE_BINDING_2D));
      }
      for (var mi = 0; mi < miss.length; mi++) {
        if (S.bad.indexOf(miss[mi]) < 0) S.bad.push(miss[mi]);
      }

      if (!S.from) { S.from = { sent: c.sent, saved: c.saved }; S.n = 0; return; }
      S.n++;
      if (S.n < 20) return;
      var sent = c.sent - S.from.sent, saved = c.saved - S.from.saved;
      var all = sent + saved;
      note('glstate: ' + S.n + ' frames, ' + Math.round(sent / S.n) +
           ' state calls a frame reached the driver and ' +
           Math.round(saved / S.n) + ' did not');
      note('glstate: ' + (all ? ((saved / all) * 100).toFixed(1) : '0') +
           '% of every state call this renderer makes is redundant');
      if (S.bad.length) {
        note('PROBLEM: the state cache disagrees with the driver');
        for (var bi = 0; bi < Math.min(8, S.bad.length); bi++) note('glstate:   ' + S.bad[bi]);
      } else {
        note('glstate: the cache agreed with the driver on every read, every frame');
      }
      if (saved <= 0) note('PROBLEM: the filter caught nothing - it is pure overhead');
      PROBE = '';
      return;
    } else if (PROBE === 'fps' && step >= 1) {
      /* THE FRAME COUNTER AND THE FRAME LIMIT.
         Both were rows that applied to nothing, so both are checked by their
         effect rather than by their value: does a counter exist and report a
         plausible rate, and does asking for a cap actually change the interval
         the loop runs at. */
      var Q = g.__fps || (g.__fps = { t: 0, phase: 0, uncapped: 0, capped: 0, n: 0 });
      Q.t++;
      if (Q.phase === 0) {
        // the sampler has to exist and be filling in
        if (Q.t < 12) return;
        if (!g.fps) { note('PROBLEM: the game keeps no frame statistics'); PROBE = ''; return; }
        note('fps: counter reports ' + (g.fps.now || 0).toFixed(1) + ' FPS, worst ' +
             (g.fps.worst || 0).toFixed(1));
        if (!(g.fps.now > 0)) note('PROBLEM: the counter never produced a rate');
        // the overlay has to be gated on the setting, and the setting has to
        // reach the renderer
        if (g.showFps !== (g.settings.fpsShow === 1))
          note('PROBLEM: the FPS COUNTER row does not reach the renderer');
        g.settings.fpsShow = 1;
        g.applySettings();
        if (!g.showFps) note('PROBLEM: turning the FPS COUNTER on did nothing');
        else note('fps: the overlay follows the setting');
        /* THE CAP. Measured as the interval the loop is willing to run at,
           because a software rasteriser cannot reach any of the capped rates
           and so cannot demonstrate one by frame rate alone. What is being
           checked is that the row reaches the loop at all - which is exactly
           what it did not do before. */
        var caps = window.NR.Settings.FPS_CAPS;
        var seen = [];
        for (var i = 0; i < caps.length; i++) {
          g.settings.fps_cap = i;
          g.applySettings();
          seen.push(caps[i] + '=>' + (g.frameInterval || 0).toFixed(2));
          var want = caps[i] > 0 ? 1000 / caps[i] : 0;
          if (Math.abs((g.frameInterval || 0) - want) > 0.01) {
            note('PROBLEM: FRAME LIMIT ' + caps[i] + ' produced an interval of ' +
                 (g.frameInterval || 0));
          }
        }
        note('fps: cap -> interval  ' + seen.join('  '));
        /* ...and the interval has to actually SKIP frames, not merely exist.
           Asserted by holding the game clock still: with an interval longer
           than the harness's own frame time, the loop must decline to run -
           so g.time stops advancing even though rAF keeps firing. */
        g.settings.fps_cap = 0;
        g.applySettings();
        g.frameInterval = 100000;          // one frame every 100 seconds
        Q.mark = g.time;
        Q.markT = Q.t;
        Q.phase = 1;
        return;
      }
      if (Q.phase === 1) {
        if (Q.t - Q.markT < 8) return;
        var moved = g.time - Q.mark;
        note('fps: with the loop capped, the clock advanced ' + moved.toFixed(3) +
             's over ' + (Q.t - Q.markT) + ' animation frames');
        if (moved > 0.001) note('PROBLEM: the frame limit does not skip frames');
        g.frameInterval = 0;               // hand the game back
        Q.phase = 2;
        PROBE = '';
      }
      return;
    } else if (PROBE === 'pov' && step >= 1) {
      /* THE DRIVER VIEW, MEASURED.
       *
       * The eye is the one in the head of the figure in the seat, computed on
       * the core side - see pov in crates/synx-core/src/driver.rs. Three
       * questions, and a view that fails any of them looks broken in a way
       * the other two cannot tell you about:
       *
       *   Is the eye IN the car, near the middle of it rather than out on a
       *   wing or behind the back axle?
       *   Is some of the car in the frame? A first-person view of nothing but
       *   road is a floating camera, whatever it is called.
       *   Is the near plane close enough not to eat the wheel in front of it?
       */
      /* SET THE VIEW, THEN LET THE GAME RUN A FRAME. camMode is an input to
         the camera update, not the camera: setting it and measuring g.eye in
         the same tick reads where the CHASE camera left the eye last frame,
         which is eleven units behind the car and reports a bonnet view that
         is nowhere near the bonnet. */
      var N = g.__bn || (g.__bn = { t: 0 });
      N.t++;
      if (N.t === 1) { g.camMode = 1; return; }
      if (N.t < 3) return;
      if (!N.done) {
        N.done = 1;
        var sc = g.scene;
        var real = sc.drawPart, tally = [];
        sc.drawPart = function (p, m) {
          var mm = m || (p && p.m);
          if (mm) tally.push({ n: (p.mat && p.mat.name) || '?', x: mm[12], y: mm[13], z: mm[14] });
          return real.call(sc, p, m);
        };
        try { g.draw(1 / 60); } finally { sc.drawPart = real; }
        var e = g.eye, tg = g.target, car = g.car;
        var fx = tg[0] - e[0], fy = tg[1] - e[1], fz = tg[2] - e[2];
        var fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
        // where the eye sits relative to the car it is riding
        var dx = e[0] - car.x, dy = e[1] - car.y, dz = e[2] - car.z;
        var along = dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw);
        note('pov: eye is ' + along.toFixed(2) + 'u ahead of the car centre, ' +
             dy.toFixed(2) + 'u above it, fov ' + (g.fov || 0).toFixed(0) +
             ', near ' + (g.camNear || 0).toFixed(3));
        /* The seat is a little behind the middle of the car and the eye a
           little in front of the seat, so this sits close to the centre -
           not out on the nose, which is where the camera this replaced was. */
        if (!(along > -0.8 && along < 1.6)) note('PROBLEM: the eye is not in the cabin');
        if (!(dy > 0.0 && dy < 1.3)) note('PROBLEM: the eye is not at head height');
        // ...and how much of the car is in shot, in degrees below the axis
        var vfov = (g.fov || 70) / 2;
        var lo = 999, hi = -999, seen = 0;
        for (var i = 0; i < tally.length; i++) {
          var q = tally[i];
          var qx = q.x - e[0], qy = q.y - e[1], qz = q.z - e[2];
          var f = qx * fx + qy * fy + qz * fz;
          if (f < 0.02 || f > 6) continue;         // only the car the eye is on
          var v = Math.atan2(qy - fy * f, f) * 180 / Math.PI;
          lo = Math.min(lo, v); hi = Math.max(hi, v); seen++;
        }
        note('pov: ' + seen + ' parts of the car within 6u, ' +
             (seen ? lo.toFixed(0) + ' to ' + hi.toFixed(0) + ' deg vertically' : 'none') +
             ' against a half-frame of ' + vfov.toFixed(0) + ' deg');
        if (!seen) note('PROBLEM: nothing of the car in front of the eye - the view is floating');
        // from inside, parts of the car are legitimately above the eye line
        if (lo < -vfov) note('pov: some of the car is below the frame, which is fine');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'driver' && step >= 1) {
      /* DOES THE DRIVER'S HEAD COME THROUGH THE ROOF?
       *
       * It did: the helmet was a shell of scale 0.42 centred at y 0.20 in
       * figure space, so its crown reached 0.41 against a roof that is between
       * 0.323 and 0.385 over the seat. This walks the real figure through the
       * real matrices and reports the highest point of it against the highest
       * point of the car, in world space, which is the only version of the
       * question that cannot be argued with.
       */
      if (!g.__drv) {
        g.__drv = 1;
        var sc = g.scene;
        var real = sc.drawPart, body = -1e9, head = -1e9, parts = 0;
        var cx = g.car.x, cz = g.car.z;
        /* The top of a part, in world space, from whatever its shape gives:
           an imported mesh carries its own AABB and the eight corners of it
           go through the matrix exactly; a generated driver piece does not,
           and every one of them is a unit shape centred on its origin, so
           half the length of the matrix column IS its half height. Compare
           an origin against a top and the answer is meaningless, which is
           what the first version of this probe did. */
        function topOf(mm, mesh) {
          var bb = mesh && mesh.aabb;
          if (!bb) return mm[13] + Math.hypot(mm[4], mm[5], mm[6]) * 0.5;
          var hi = -1e9;
          for (var c = 0; c < 8; c++) {
            var x = (c & 1) ? bb[3] : bb[0];
            var y = (c & 2) ? bb[4] : bb[1];
            var z = (c & 4) ? bb[5] : bb[2];
            var wy = mm[1] * x + mm[5] * y + mm[9] * z + mm[13];
            if (wy > hi) hi = wy;
          }
          return hi;
        }
        sc.drawPart = function (p, m) {
          var mm = m || (p && p.m);
          var nm = (p.mat && p.mat.name) || '';
          if (mm && Math.hypot(mm[12] - cx, mm[14] - cz) < 4) {
            var top = topOf(mm, p.mesh);
            if (/^Driver(Helmet|Visor|Peak)/.test(nm)) { head = Math.max(head, top); parts++; }
            else if (!/^Driver/.test(nm)) body = Math.max(body, top);
          }
          return real.call(sc, p, m);
        };
        try { g.draw(1 / 60); } finally { sc.drawPart = real; }
        note('driver: ' + parts + ' head parts, crown at y ' + head.toFixed(3) +
             ', the roof of the car at y ' + body.toFixed(3) +
             ' (clearance ' + (body - head).toFixed(3) + 'u)');
        /* DO THE HANDS ACTUALLY GO ROUND THE WHEEL?
         *
         * They used to turn on the spot: each glove was rotated about its own
         * origin by the steering angle, which spins a hand in place and leaves
         * it exactly where it was. From outside the car it reads as a driver
         * who is not holding anything.
         *
         * Two draws at opposite lock, and two questions about them. Did the
         * gloves MOVE - a hand on a rim at half a radian of wheel travels a
         * good fraction of the rim - and did they stay the same distance from
         * the hub, which is what tells a rotation about the hub apart from any
         * other way of moving a hand.
         */
        var poses = [];
        for (var pass = 0; pass < 2; pass++) {
          var hub = null, grip = [];
          sc.drawPart = function (q, m) {
            var mm = m || (q && q.m);
            var qn = (q.mat && q.mat.name) || '';
            var mn = (q.mesh && q.mesh.name) || '';
            if (mm && Math.hypot(mm[12] - g.car.x, mm[14] - g.car.z) < 4) {
              /* THE RIM, BY ITS MESH. The wheel, its spokes and the column
                               all wear the same material, and the column is drawn first -
                               so keying on the material name anchors the measurement to a
                               point on the steering column that does not move, and every
                               hand then looks like it is leaving the rim. Only the rim is
                               the rim. */
              if (mn === 'DriverRim' && !hub) hub = [mm[12], mm[13], mm[14]];
              /* ONE PASS ONLY. A frame draws this car more than once - the shadow
                               cascades and the reflection probe each submit it again - so a
                               collector that keeps taking gloves ends up comparing a hand
                               from one pass against a hub from another. The figure is drawn
                               hands-first, so the first two gloves and the first hub after
                               them are one pass by construction. */
                            else if (/^DriverGloveP$/.test(qn) && grip.length < 2) {
                              grip.push([mm[12], mm[13], mm[14]]);
                            }
            }
            return real.call(sc, q, m);
          };
          /* A SMALL ANGLE, BECAUSE THE RACK IS NOT SMALL ANY MORE.
             At sixteen to one, a third of a radian at the tyre is past the
             rim's own lock - so a lock-to-lock pair is more than a full
             revolution apart and both questions below alias: the chord between
             them is tiny and their relative height means nothing. Six
             hundredths is forty-five degrees of rim, which is a quarter turn
             and unambiguous for both. */
          var was = g.car.steer;
          g.car.steer = pass ? 0.06 : -0.06;
          try { g.draw(1 / 60); } finally { sc.drawPart = real; g.car.steer = was; }
          poses.push({ hub: hub, grip: grip });
        }
        var A = poses[0], Bp = poses[1];
        if (!A.hub || A.grip.length < 2 || Bp.grip.length < 2) {
          note('PROBLEM: the wheel or the gloves were not drawn');
        } else {
          var moved = 0, radiusDrift = 0;
          for (var gi = 0; gi < 2; gi++) {
            var p0 = A.grip[gi], p1 = Bp.grip[gi];
            moved = Math.max(moved, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]));
            var r0 = Math.hypot(p0[0] - A.hub[0], p0[1] - A.hub[1], p0[2] - A.hub[2]);
            var r1 = Math.hypot(p1[0] - Bp.hub[0], p1[1] - Bp.hub[1], p1[2] - Bp.hub[2]);
            radiusDrift = Math.max(radiusDrift, Math.abs(r1 - r0));
            if (gi === 0) note('driver: grip radius ' + r0.toFixed(3) + 'u from the hub');
          }
          note('driver: a quarter turn moves the gloves ' + moved.toFixed(3) +
               'u, and their radius changes by ' + radiusDrift.toFixed(4) + 'u');
          /* WHICH WAY IT TURNS. The gloves orbit the hub, so the direction the
             LEFT one goes tells you the direction the wheel goes - and that is
             the only way to settle whether the rim matches the road wheels
             without squinting at a screenshot. Positive steer is a RIGHT turn
             (yaw increases, and the car's forward vector rotates toward its
             own +X), so a correct rim takes the left hand from ten o'clock
             UP toward twelve: its height must RISE. */
          var lo = A.grip[0], hi = Bp.grip[0];
          var dy = hi[1] - lo[1];
          note('driver: turning right moves the left glove ' +
               dy.toFixed(3) + 'u vertically - ' + (dy > 0 ? 'UP, which is correct'
               : 'DOWN, so the rim turns the WRONG WAY for the steering'));
          if (dy < 0) note('PROBLEM: the steering wheel is inverted');
          if (moved < 0.14) {
            note('PROBLEM: the hands barely move with the wheel - they are turning on the spot');
          }
          if (radiusDrift > 0.01) {
            note('PROBLEM: the hands leave the rim as the wheel turns');
          }
        }
        /* THE HEAD IS MISSING FROM THE DRIVING SEAT ON PURPOSE.
           From inside, the helmet is a shell around this camera and the torso
           a wall under it, so both are dropped before anything is drawn - see
           the own list in js/scene.js. This probe wants --cam 1 for the arms, and
           reporting the deliberately absent head as a fault every time is how
           a check trains the person reading it to skip its output. */
        var inside = (g.activeCam ? g.activeCam() : g.camMode) === 1;
        if (!parts) {
          note(inside ? 'driver: no head from the driving seat, which is correct'
                      : 'PROBLEM: the driver has no head');
        } else if (head > body) note('PROBLEM: the head is through the roof by ' +
                                   (head - body).toFixed(3) + 'u');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'arms' && step >= 1) {
      /* THE DRIVER'S OWN ARMS, FROM THE DRIVER'S OWN EYE.
       *
       * A screenshot of the first-person view says whether the arms look
       * right. It does not say why they do not, and the two failures behind
       * the report that started this are both invisible in one:
       *
       *   THEY ARE OFF THE BOTTOM OF THE FRAME. The hands are at nine and
       *   three on a rim whose hub sits well below the eye line, so a view
       *   framed a few degrees too high shows the top arc of the wheel and
       *   nothing holding it. The picture looks like a wheel that turns
       *   itself, and nothing in it tells you the hands were drawn at all.
       *
       *   THEY ARE TOO THIN TO READ. An arm 6cm across at two thirds of a
       *   metre subtends five degrees, which at this frame height is forty
       *   pixels. That is the 'twig'. It is a number, so it is checked as
       *   one rather than argued about.
       *
       * Both are questions about where things land on screen, so both are
       * asked through the projection actually in use.
       */
      var Z = g.__arms || (g.__arms = { t: 0 });
      Z.t++;
      // camMode is an input to the camera, not the camera: give it a tick
      if (Z.t === 1) { g.camMode = 1; return; }
      if (Z.t < 3 || Z.done) return;
      Z.done = 1;
      var sc = g.scene, real = sc.drawPart, seen = [];
      sc.drawPart = function (p, m) {
        var mm = m || (p && p.m);
        var mn = (p.mesh && p.mesh.name) || '';
        if (mm && /^Driver(Limb|Forearm|Glove|Rim)$/.test(mn)
            && Math.hypot(mm[12] - g.car.x, mm[14] - g.car.z) < 4) {
          /* A generated driver piece is a unit shape on its own origin, so
             the length of a matrix column IS its full extent along that
             axis. Across is the widest of the two that are not the limb's
             own length. */
          seen.push({ n: mn, p: [mm[12], mm[13], mm[14]],
            across: Math.max(Math.hypot(mm[0], mm[1], mm[2]), Math.hypot(mm[4], mm[5], mm[6])),
            along: Math.hypot(mm[8], mm[9], mm[10]) });
        }
        return real.call(sc, p, m);
      };
      try { g.draw(1 / 60); } finally { sc.drawPart = real; }
      var vp = g.vp, e = g.eye, vfov = g.fov || 55;
      var on = 0, low = 0, thin = 0, hands = 0, handsOn = 0, kept = {}, rows = [];
      for (var i = 0; i < seen.length; i++) {
        var q = seen[i];
        // one pass only: the cascades and the probe each submit the figure again
        kept[q.n] = (kept[q.n] || 0) + 1;
        if (kept[q.n] > 2) continue;
        var cx = vp[0] * q.p[0] + vp[4] * q.p[1] + vp[8] * q.p[2] + vp[12];
        var cy = vp[1] * q.p[0] + vp[5] * q.p[1] + vp[9] * q.p[2] + vp[13];
        var cw = vp[3] * q.p[0] + vp[7] * q.p[1] + vp[11] * q.p[2] + vp[15];
        var dist = Math.hypot(q.p[0] - e[0], q.p[1] - e[1], q.p[2] - e[2]);
        var deg = 2 * Math.atan(q.across * 0.5 / Math.max(0.05, dist)) * 180 / Math.PI;
        var ndcx = cw > 0 ? cx / cw : 0, ndcy = cw > 0 ? cy / cw : 0;
        var inFrame = cw > 0 && Math.abs(ndcx) <= 1 && Math.abs(ndcy) <= 1;
        if (inFrame) on++; else if (cw > 0 && ndcy < -1) low++;
        /* THE GLOVES ARE THE TEST, not the whole figure. A driver cannot see
           their own shoulders and a hub behind a binnacle does not need to be
           on screen - but hands on a wheel do, and if they are not, nothing
           done to the arms can show up at all. */
        if (q.n === 'DriverGlove') { hands++; if (inFrame) handsOn++; }
        // the width of the thing, as a share of the frame height
        var px = deg / vfov;
        if (/Limb|Forearm|Glove/.test(q.n) && px < 0.055) thin++;
        rows.push(q.n.replace('Driver', '').padEnd(8)
          + ' at ' + dist.toFixed(2) + 'u'
          + '  screen ' + ndcx.toFixed(2) + ',' + ndcy.toFixed(2)
          + (inFrame ? '' : (cw <= 0 ? '  BEHIND THE EYE' : (ndcy < -1 ? '  BELOW THE FRAME' : '  OFF FRAME')))
          + '  ' + deg.toFixed(1) + ' deg across (' + (px * 100).toFixed(0) + '% of frame height)');
      }
      for (var r = 0; r < rows.length; r++) note('arms: ' + rows[r]);
      note('arms: ' + on + ' of ' + rows.length + ' driver parts in frame, '
        + low + ' below it (shoulders and the hub belong there), eye at y ' + e[1].toFixed(2) + ', fov ' + vfov.toFixed(0));
      if (!rows.length) note('PROBLEM: the driver figure was not drawn at all');
      else if (!hands) note('PROBLEM: no gloves were drawn - the driver is not holding the wheel');
      else if (handsOn < hands) {
        note('PROBLEM: ' + (hands - handsOn) + ' of ' + hands
          + ' hands are off the frame - the view shows a wheel nobody is holding');
      }
      if (thin) note('PROBLEM: ' + thin + ' limb(s) under 5.5% of frame height - that is the twig');
      PROBE = '';
      return;
    } else if (PROBE === 'near' && (step >= 1 || HOLD === 'menu')) {
      /* WHAT IS THAT THING?
       *
       * A screenshot shows a shape. It does not say which material drew it,
       * and in a scene built from forty generated sweeps that is the only
       * question worth asking - so this names everything the frame drew
       * within reach of the camera, nearest first, with how bright the
       * shader will have made it.
       *
       * Emissive is reported as what comes OUT of the glow branch: the
       * material value times 7.5, times one plus four gains. Anything much
       * over two tonemaps to white, which is how a chevron becomes a slab.
       */
      var NR2 = g.__near || (g.__near = { t: 0 });
      placeReel(g);
      NR2.t++;
      if (NR2.t < 2 || NR2.done) return;
      NR2.done = 1;
      var sc = g.scene, real = sc.drawPart, seen = {};
      var e = g.eye;
      sc.drawPart = function (p, m) {
        var bb = p.aabb;
        var nm = (p.mat && p.mat.name) || '?';
        if (bb) {
          var cx = (bb[0] + bb[3]) * 0.5, cy = (bb[1] + bb[4]) * 0.5, cz = (bb[2] + bb[5]) * 0.5;
          var d = Math.hypot(cx - e[0], cy - e[1], cz - e[2]);
          seen[nm] = seen[nm] || { d: 1e9, n: 0 };
          seen[nm].n++;
          if (d < seen[nm].d) {
            var em = (p.mat && p.mat.emis) || [0, 0, 0];
            var k = 7.5 * (1 + 4 * ((p.mat && p.mat.gain) || 0));
            var was = seen[nm].n;
            seen[nm] = { d: d, n: was, mode: p.mode, lit: (p.mode === 7 || p.mode === 6)
              ? [em[0] * k, em[1] * k, em[2] * k] : null,
              size: Math.max(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]) };
          }
        }
        return real.call(sc, p, m);
      };
      try { g.draw(1 / 60); } finally { sc.drawPart = real; }
      var rows = Object.keys(seen).map(function (k) { return { n: k, v: seen[k] }; });
      /* BY COST, NOT BY DISTANCE. What is nearest is what a screenshot is
         asking about; what is submitted most is what a frame budget is. */
      rows.sort(function (x, y) { return y.v.n - x.v.n || x.v.d - y.v.d; });
      var total = 0;
      for (var q2 = 0; q2 < rows.length; q2++) total += rows[q2].v.n;
      for (var i = 0; i < Math.min(rows.length, 22); i++) {
        var r = rows[i];
        note('near: ' + r.n.padEnd(24) + ' x' + String(r.v.n).padStart(4)
          + '  ' + r.v.d.toFixed(0).padStart(5) + 'u'
          + '  span ' + r.v.size.toFixed(0).padStart(5) + 'u'
          + '  mode ' + r.v.mode
          + (r.v.lit ? '  emits ' + r.v.lit.map(function (q) { return q.toFixed(1); }).join(',')
            + (Math.max(r.v.lit[0], r.v.lit[1], r.v.lit[2]) > 3 ? '  CLIPS' : '') : ''));
      }
      note('near: ' + rows.length + ' materials, ' + total + ' draw call(s) in one frame');
      /* WHAT THE FRAME COST THE CPU, which is not the same as how many calls
         it made. Scene.drawPart caches the material it last uploaded, so a
         frame drawn in material order re-states the texture binds and the
         eleven uniforms far less often than one drawn in road order - see the
         sort on dressingOpaque in js/scene.js. */
      note('near: engine counted ' + (g.scene.lastDrawCalls || 0) + ' draw(s), '
        + (g.scene.lastMatUploads || 0) + ' material upload(s) - '
        + Math.round(100 * (1 - (g.scene.lastMatUploads || 0)
          / Math.max(1, g.scene.lastDrawCalls || 1))) + '% served from the cache');
      PROBE = '';
      return;
    } else if (PROBE === 'cards' && step >= 1) {
      /* TWO PANELS IN ONE CORNER.
       *
       * Chapters 6 and 7 field their own objective card in the top-left
       * gutter, and the story fields a radio chip, a waypoint and a tutorial
       * strip in the same document while a trial is running. Every one of
       * them is positioned in viewport units against clamps, so whether two
       * of them touch depends on the window - which means it is not a
       * question anybody can answer by reading the stylesheet, and not one a
       * screenshot at one size settles either.
       *
       * So it is measured, at three window shapes, against the real document
       * with the real cards on it: every pair of visible panels, and whether
       * their rectangles intersect.
       */
      var CD = g.__cards || (g.__cards = { t: 0, step: 0, bad: 0 });
      if (CD.done) return;
      CD.t++;
      if (CD.t < 3) return;

      var IDS = ['storyRaceMeta', 'storyCompact', 'storyTutorial', 'storyWaypoint',
        'storyRadio', 'storyDialogue', 'forge6Objective', 'forge6Round', 'forge6Math',
        'forge6Skill', 'forge6Fatal', 'pred7Objective', 'pred7Event', 'pred7Checkpoint'];

      function visible(el) {
        if (!el) return false;
        var st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        /* 'show' counts as visible even at opacity 0. These panels fade in
           over 200ms, so a card raised and measured in the same tick is still
           reading its start value - and a probe that skipped it would report
           a clean layout for a card that is about to be on screen. The class
           is the intent; the opacity is only how it gets there. */
        var up = el.classList.contains('show') || parseFloat(st.opacity) >= 0.05;
        if (!up) return false;
        var host = el.closest ? el.closest('#forge6, #pred7, #storyRoot') : null;
        if (host) {
          var hs = window.getComputedStyle(host);
          if (hs.display === 'none') return false;
          if (!host.classList.contains('show') && parseFloat(hs.opacity) < 0.05) return false;
        }
        var r = el.getBoundingClientRect();
        return r.width > 24 && r.height > 12;
      }

      function sweepOnce(label) {
        /* The director takes its own root down on any frame where its chapter
           is not the running one, so it is put back up immediately before the
           measurement rather than a tick earlier. */
        var host = document.getElementById('forge6');
        if (host) { host.classList.add('show'); host.setAttribute('aria-hidden', 'false'); }
        var live = [];
        for (var i = 0; i < IDS.length; i++) {
          var el = document.getElementById(IDS[i]);
          if (!visible(el)) continue;
          var r = el.getBoundingClientRect();
          live.push({ n: IDS[i], x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
        }
        /* THE CANVAS HUD IS IN THE ROOM TOO. The gap readout is drawn on the
           canvas in the HUD's own 1280x720 virtual space, not in the document,
           so a DOM-only sweep says "nothing overlaps" while a trial card sits
           straight through it - which is exactly what was shipping. Its own
           coordinates, resolved through the HUD's own transform. */
        var HR = window.NR && window.NR.HUD_RIVAL, hud = g.hud;
        if (HR && hud && hud.vx) {
          live.push({ n: 'HUD gap readout',
            x0: hud.vx(HR.x), y0: hud.vy(HR.top),
            x1: hud.vx(HR.x + HR.w), y1: hud.vy(HR.bottom) });
        }
        var hits = 0;
        for (var a = 0; a < live.length; a++) {
          for (var b = a + 1; b < live.length; b++) {
            var A = live[a], B = live[b];
            var ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
            var oy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
            if (ox > 2 && oy > 2) {
              hits++; CD.bad++;
              note('PROBLEM: ' + label + ' - ' + A.n + ' overlaps ' + B.n
                + ' by ' + Math.round(ox) + 'x' + Math.round(oy) + 'px');
            }
          }
        }
        note('cards: ' + label + '  ' + live.length + ' panel(s) up'
          + (live.length ? '  [' + live.map(function (q) {
            return q.n + ' ' + Math.round(q.x0) + ',' + Math.round(q.y0)
              + ' ' + Math.round(q.x1 - q.x0) + 'x' + Math.round(q.y1 - q.y0);
          }).join('  ') + ']' : '')
          + (hits ? '  ' + hits + ' OVERLAP(S)' : ''));
      }

      /* THE SET THAT IS ACTUALLY UP AT ONCE. A trial runs with the chapter's
         objective card in the gutter and the story talking over it, so both
         are shown here - which is the state the report was about, and the one
         no single screen of the game holds still for. */
      if (CD.step === 0) {
        CD.step = 1;
        var d6 = g.__level6Director;
        if (d6 && d6.ui && d6.ui.root) {
          d6.ui.root.classList.add('show');
          d6.ui.root.setAttribute('aria-hidden', 'false');
          if (d6.bindOnce) d6.bindOnce();
          d6.ui.phase.textContent = 'AURORA FORGE // TRIAL 03';
          d6.ui.objectiveText.textContent = 'SORTING FLOOR';
          d6.ui.rule.textContent = 'FORGE // THREE CHUTES';
        } else note('PROBLEM: chapter 6 has no director to measure');
        if (g.story && g.story.showCompact) {
          g.story.setRoot(true);
          g.story.showCompact('NOVA', 'radio', 'Line four is live. Do not stop on it.', 30);
        }
        return;
      }
      if (CD.step === 1) {
        CD.step = 2;
        sweepOnce('chapter 6, ' + window.innerWidth + 'x' + window.innerHeight);
        /* ...and the trial card, which every transition raises AT THE SAME
           TIME as the radio chip - see startMachinery and startSorting in
           js/chapters.js, which call showRound and showCompact back to back.
           Shown and measured in ONE tick: the director hides its own panels on
           any frame where the chapter is not the running one, so a card raised
           here and read next frame is a card that has already been taken down.
           Reading a rect forces the layout, so this is exact. */
        var rc = document.getElementById('forge6Round');
        if (!rc) note('PROBLEM: chapter 6 has no trial card');
        else {
          document.getElementById('forge6RoundKicker').textContent = 'LINE CONTROL // SCRAP ROUTING';
          document.getElementById('forge6RoundTitle').textContent = 'SORTING FLOOR';
          document.getElementById('forge6RoundCopy').textContent =
            'THREE CHUTES. ONE IS RUNNING. THE PAINT WILL NOT TELL YOU WHICH.';
          rc.classList.add('show');
          sweepOnce('chapter 6 + trial card');
        }
        note('cards: ' + (CD.bad ? CD.bad + ' overlapping pair(s)' : 'nothing drawn through anything else'));
        PROBE = '';
        CD.done = true;
      }
      return;
    } else if (PROBE === 'city' && step >= 1) {
      /* DOES THE CITY STAY UP?
       *
       * Reported: partway through Chapter 7 the buildings disappear and only
       * the neon is left standing.
       *
       * The cause was a scan that started a fixed 2,100 units behind the draw
       * window while the meshes it was scanning were 3,600 long - so a chunk
       * that begins before the window and runs right through it was never
       * looked at. drawMeshes finds its first candidate by binary search on
       * s0, and a binary search can only be as good as the margin it is given.
       *
       * MEASURED EXACTLY, NOT BY EYE. The first version of this counted the
       * meshes the renderer submitted and looked for a hole - and it found
       * none, because the loss is not a hole. It is uniform: forty per cent
       * of the city missing at every station, which a threshold on the mean
       * cannot see because the mean moved with it.
       *
       * So the two sets are compared instead. The TRUE set is every mesh whose
       * arc span overlaps the window, which is one pass over the list and
       * needs no renderer. The FOUND set is what the scan in drawMeshes
       * actually visits, replicated here from the same numbers. They have to
       * be identical at every station; a mesh in the first and not the second
       * is a mesh the frame will never draw, whatever the frustum then says.
       */
      var CT = g.__city || (g.__city = { t: 0, bad: 0 });
      if (CT.done) return;
      CT.t++;
      if (CT.t < 3) return;
      CT.done = 1;
      var W = g.scene && g.scene.level7World;
      if (!W) { note('PROBLEM: no Chapter 7 world to measure'); PROBE = ''; return; }

      var L7 = window.__SYNX_LEVEL7__ || {};
      var from = L7.from || 132070, to = L7.to || 173000;

      /* The windows drawMeshes is called with, from the draw method itself:
         the near lists get s-950..s+4200, the horizon reaches further back and
         much further forward, and the ground further again. */
      var WINDOWS = [
        ['opaque', W.opaque, -950, 4200],
        ['glow', W.glow, -950, 4200],
        ['blend', W.blend, -950, 4200],
        ['horizon', W.horizon, -2200, 9000],
        ['groundOpaque', W.groundOpaque, -4200, 12000],
        ['groundGlow', W.groundGlow, -4200, 12000],
      ];

      var worst = null, checked = 0;
      for (var wi = 0; wi < WINDOWS.length; wi++) {
        var name = WINDOWS[wi][0], list = WINDOWS[wi][1];
        var backOff = WINDOWS[wi][2], fwdOff = WINDOWS[wi][3];
        if (!list || !list.length) continue;
        var reach = 0;
        for (var ri = 0; ri < list.length; ri++) {
          reach = Math.max(reach, (list[ri].s1 - list[ri].s0) || 0);
        }
        var missedHere = 0, worstStation = 0;
        for (var q = from; q <= to; q += 250) {
          var lo = q + backOff, hi = q + fwdOff;
          // everything that genuinely overlaps
          var truth = 0;
          for (var i = 0; i < list.length; i++) {
            if (list[i].s1 >= lo && list[i].s0 <= hi) truth++;
          }
          // ...and what the scan in drawMeshes reaches
          var found = 0;
          /* The renderer's own margin, asked of the renderer. A probe that
             recomputed it would agree with a broken one. */
          for (var j = W.lowerBound(list, lo - W.scanBack(list), function (e) { return e.s0; });
               j < list.length && list[j].s0 <= hi; j++) {
            if (list[j].s1 < lo) continue;
            found++;
          }
          checked++;
          if (found < truth) {
            missedHere += (truth - found);
            if (!worstStation) worstStation = q;
          }
        }
        note('city: ' + name.padEnd(13) + ' ' + list.length + ' mesh(es), longest '
          + reach.toFixed(0) + 'u, scan reaches back ' + W.scanBack(list).toFixed(0) + 'u'
          + (missedHere ? '   MISSES ' + missedHere + ' from s=' + worstStation : ''));
        if (missedHere) {
          CT.bad++;
          if (!worst) worst = name;
          note('PROBLEM: the ' + name + ' scan misses meshes that overlap the window'
            + ' - they are in the list and the frame never looks at them');
        }
      }
      note('city: ' + checked + ' station/list checks'
        + (CT.bad ? '   ' + CT.bad + ' LIST(S) CULLING WRONGLY' : '   every list finds everything that overlaps'));
      PROBE = '';
      return;
    } else if (PROBE === 'warnings' && step >= 1) {
      /* THE NETWORK WARNINGS, AND THE POPUP THEY ARRIVE IN.
       *
       * Three separate claims, and the first two are what the player
       * actually experiences:
       *
       *   A machine with no network is told so AT ONCE. It used to sit
       *   through two thirty-second attempts at a server it had no route to
       *   before saying anything, which reads as a game that has hung.
       *
       *   The card that says so is a real modal: it takes the keyboard, it
       *   traps it, and ESC gives it back. A warning that cannot be
       *   dismissed with a pad or a keyboard is a dead end.
       *
       *   The typewriter finishes. A message that stops halfway because its
       *   frame budget ran out is worse than one that never animated.
       */
      var W = g.__warn || (g.__warn = { t: 0 });
      W.t++;
      if (W.t === 1) {
        // the browser will not let this be assigned, but it can be shadowed
        try {
          Object.defineProperty(window.navigator, "onLine",
            { configurable: true, get: function () { return false; } });
          note("warnings: navigator.onLine forced to false");
        } catch (e) { note("warnings: could not fake onLine - " + e.message); }
        return;
      }
      if (W.t === 2) {
        if (!window.NR || !window.NR.UI) { note("PROBLEM: NR.UI was never loaded"); PROBE = ""; return; }
        // the net layer has to answer without waiting on a socket
        W.t0 = performance.now();
        window.NR.Net.probe("https://example.invalid").then(function (r) {
          var ms = performance.now() - W.t0;
          note("warnings: probe answered in " + ms.toFixed(0) + "ms, offline=" + !!r.offline
               + " why=" + JSON.stringify(r.why));
          if (!r.offline) note("PROBLEM: with no network, probe did not say so");
          if (ms > 2000) note("PROBLEM: probe took " + ms.toFixed(0) + "ms to notice there is no network");
          W.probed = 1;
        });
        // ...and the card itself
        window.NR.UI.alert({
          kind: "warn", title: "NO NETWORK",
          body: "This machine reports no connection, so there is nothing to reach.",
          note: "Reconnect and press TRY AGAIN.",
          actions: [{ label: "TRY AGAIN", value: "retry", primary: true },
                    { label: "BACK", value: "close" }],
          onClose: function (r) { W.closed = r === null ? "escape" : r; },
        });
        return;
      }
      if (W.t === 3) {
        var card = document.querySelector(".ui-modal .ui-card");
        if (!card) { note("PROBLEM: the warning card did not render"); PROBE = ""; return; }
        var r = card.getBoundingClientRect();
        note("warnings: card is " + Math.round(r.width) + "x" + Math.round(r.height) + " at " +
             Math.round(r.left) + "," + Math.round(r.top));
        if (r.width < 200 || r.height < 120) note("PROBLEM: the card rendered too small to read");
        var focused = document.activeElement;
        var hasKeys = !!(focused && card.contains(focused));
        note("warnings: the keyboard is " + (hasKeys ? "on " + focused.textContent : "NOT in the card"));
        if (!hasKeys) note("PROBLEM: the card did not take the keyboard");
        var body = card.querySelector(".ui-body");
        W.mid = body ? body.textContent.length : -1;
        return;
      }
      if (W.t >= 4 && !W.typed) {
        /* WAITED OUT IN FRAMES, NOT SECONDS. This harness draws about one
           frame a second on a software rasteriser, and the typewriter is
           driven off requestAnimationFrame - so it advances in whole
           chunks here rather than character by character, and a check on
           the frame straight after it starts catches it one letter in and
           calls a working animation broken. Give it frames until it stops
           growing. */
        var body2 = document.querySelector(".ui-modal .ui-body");
        var full = "This machine reports no connection, so there is nothing to reach.";
        var got = body2 ? body2.textContent : "";
        if (got !== full && W.t < 10) { W.last = got.length; return; }
        note("warnings: the message typed " + got.length + " of " + full.length +
             " characters over " + (W.t - 2) + " frames");
        if (got !== full) note("PROBLEM: the typewriter did not finish: " + JSON.stringify(got));
        // and ESC has to give the keyboard back
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        W.typed = W.t;
        return;
      }
      if (W.typed && W.t > W.typed) {
        var still = document.querySelector(".ui-modal:not(.ui-gone)");
        note("warnings: after ESC the card is " + (still ? "STILL UP" : "gone") +
             ", onClose said " + JSON.stringify(W.closed));
        if (still) note("PROBLEM: ESC did not dismiss the warning");
        if (W.closed !== "escape") note("PROBLEM: the caller was not told how it closed");
        if (!W.probed) note("PROBLEM: the offline probe never answered at all");
        PROBE = "";
        return;
      }
      return;
    } else if (PROBE === 'camera' && step >= 1) {
      /* THE THREE VIEWS, MEASURED. Each is a claim about where the eye is
         relative to the car, and each is checkable: a bonnet eye must be on
         the car's own nose, a drone eye a long way above it, and a chase eye
         behind it.

         The drone also has to say WHERE IN THE FRAME the car ends up, which is
         the thing that was wrong with it: the eye was so nearly overhead and
         led the road so far that the car sat at 31 degrees below the view axis
         against a 34 degree half-frame - on the bottom edge, behind the boost
         bar. Anything under about 25 leaves it clear of the HUD band. */
      /* AND THE MOVE BETWEEN THEM, WHICH IS THE OTHER HALF OF IT.

         C does not cut any more - the eye travels from one rig to the
         next over about half a second, so a probe that measured one frame
         after the key would now measure the middle of the move and report
         every view as being in the wrong place. It waits for the move to
         land instead, and on the way it watches the thing the move exists
         to be.

         WHAT SEPARATES A MOVE FROM A CUT, without a frame rate in it: a
         cut carries the whole distance in ONE frame, so its biggest step
         IS its total. A move spreads the same distance over many, so its
         biggest step is a small fraction of the total however fast or slow
         the machine drawing it is. Measured against the CAR's own travel
         subtracted, because all three rigs ride the car and the eye is
         expected to cover ground with it. */
      var C = g.__cam || (g.__cam = {
        t: 0, seen: {}, moving: 0, frames: 0, jump: 0, total: 0, last: null,
        tick: 0, frameMs: 0, armed: 0, drift: 0,
      });
      C.t++;
      var car = g.car;
      /* HOW FAST THIS MACHINE IS DRAWING, which decides what the probe is
         entitled to judge below. The move is a length of WALL CLOCK - half
         a second or so - and on the software rasteriser this harness runs
         on, a frame takes most of a second, so the whole move happens
         between two frames and there is nothing left to count. Measured
         rather than assumed, because the same probe runs on machines where
         there is. */
      var nowMs = performance.now();
      if (C.tick) C.frameMs = Math.max(C.frameMs, nowMs - C.tick);
      C.tick = nowMs;
      if (C.moving) {
        if (C.last) {
          var sx = g.eye[0] - C.last[0], sy = g.eye[1] - C.last[1], sz = g.eye[2] - C.last[2];
          var cx = car.x - C.last[3], cy = car.y - C.last[4], cz = car.z - C.last[5];
          // how far the eye moved relative to the car it is riding
          var stepped = Math.abs(Math.hypot(sx, sy, sz) - Math.hypot(cx, cy, cz));
          C.jump = Math.max(C.jump, stepped);
          C.total += stepped;
          C.frames++;
        }
        C.last = [g.eye[0], g.eye[1], g.eye[2], car.x, car.y, car.z];
        if (g.camSwitch) return;          // still travelling
      }
      if (C.t < 2) return;   // one frame for the new view to settle, not six
      var d = Math.hypot(g.eye[0] - car.x, g.eye[2] - car.z);
      var up = g.eye[1] - car.y;
      var name = ['CHASE', 'DRIVER', 'DRONE'][g.camMode];
      if (!C.seen[name]) {
        C.seen[name] = 1;
        if (C.moving) {
          /* THE CLAIM THAT HOLDS AT ANY FRAME RATE, checked where it was
             made - see the press below. The move exists, and it starts
             from the picture that was on the screen. Neither of those
             depends on the machine drawing a single frame of it. */
          if (!C.armed) {
            note('PROBLEM: C did not arm a move - the view still cuts');
          } else if (C.drift > 0.01) {
            note('PROBLEM: the move started ' + C.drift.toFixed(2) +
                 'u from where the camera actually was');
          } else {
            note('camera: the move into ' + name + ' was armed from the pose that was on screen (' + C.drift.toFixed(4) + 'u out)');
          }
          note('camera: the move into ' + name + ' drew ' + C.frames +
               ' frame(s) over ' + C.total.toFixed(1) + 'u, biggest single frame ' +
               C.jump.toFixed(2) + 'u (' +
               (100 * C.jump / (C.total || 1)).toFixed(0) + '% of it)');
          /* ...and the claim that does. A move is only visible as a move
             on a machine that draws several frames inside half a second;
             below that the correct behaviour and a cut are the same
             picture, and reporting the difference as a fault would train
             whoever reads this output to skip it. */
          if (C.frameMs > 110) {
            note('camera: a frame here takes up to ' + Math.round(C.frameMs) +
                 'ms, so a half-second move cannot span frames on this machine' +
                 ' - the shape of it is not judged');
          } else if (C.frames < 5) {
            note('PROBLEM: the move into ' + name + ' was over in ' + C.frames + ' frames');
          } else if (C.jump > C.total * 0.5) {
            note('PROBLEM: one frame carried ' +
                 (100 * C.jump / (C.total || 1)).toFixed(0) +
                 '% of the way into ' + name + ' - that is a cut, not a move');
          }
          C.moving = 0; C.frames = 0; C.jump = 0; C.total = 0; C.last = null;
          C.armed = 0; C.drift = 0;
        }
        note('camera: ' + name.padEnd(8) + ' eye is ' + d.toFixed(1) +
             'u from the car horizontally, ' + up.toFixed(1) + 'u above it, fov ' +
             (g.fov || 0).toFixed(0));
        if (name === 'DRIVER' && !(d < 2.5 && up > -0.2 && up < 2.5))
          note('PROBLEM: the driver eye is not in the car');
        if (name === 'DRONE') {
          /* HOW HIGH IS HIGH ENOUGH DEPENDS ON THE ROUTE. Two of the seven
             run under a roof and cap the climb - see droneCeiling in LEVELS -
             so a flat threshold reports the Forge and Neon Horizon as broken
             for doing exactly what they are told. At the cap, being at the
             cap is the pass. */
          var ceil = (g.level && g.level.droneCeiling) || 0;
          var high = ceil ? up > ceil - 2.5 : up > 18;
          if (!high) note('PROBLEM: the drone is only ' + up.toFixed(1) + 'u up' +
            (ceil ? ' against a ceiling of ' + ceil : ''));
          else if (ceil) note('camera: DRONE is under a roof, at its ' + ceil + 'u ceiling');
          // how far below the view axis the car sits, against the half-frame
          var ex = g.eye[0] - car.x, ey = g.eye[1] - car.y, ez = g.eye[2] - car.z;
          var tx = g.target[0] - g.eye[0], ty = g.target[1] - g.eye[1], tz = g.target[2] - g.eye[2];
          var el = Math.hypot(ex, ey, ez) || 1, tl = Math.hypot(tx, ty, tz) || 1;
          var dot = (-ex * tx - ey * ty - ez * tz) / (el * tl);
          var below = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
          var half = (g.fov || 68) / 2;
          note('camera: DRONE puts the car ' + below.toFixed(1) +
               ' deg below the view axis, against a ' + half.toFixed(0) + ' deg half-frame' +
               ' (' + (50 + 50 * below / half).toFixed(0) + '% down the screen)');
          if (below > 25) note('PROBLEM: the car is on the bottom edge, behind the HUD');
        }
        if (name === 'CHASE' && !(d > 5 && up > 1))
          note('PROBLEM: the chase camera is not behind and above');
        /* ASKED HERE, INSIDE THE FRAME OF THE PRESS, because on a slow
           machine the move is finished by the next one and there is
           nothing left to ask. `camSwitch.eye` is held in the CAR's frame,
           so it is put back through the game's own transform rather than
           compared raw - see holdCamPose in js/game.js. */
        var wasAt = [g.eye[0], g.eye[1], g.eye[2]];
        g.cycleCamera();
        var sw = g.camSwitch;
        C.armed = sw ? 1 : 0;
        if (sw && g.worldOf) {
          var held = g.worldOf([0, 0, 0], sw.eye, 1);
          C.drift = Math.hypot(held[0] - wasAt[0], held[1] - wasAt[1], held[2] - wasAt[2]);
        }
        C.moving = 1;
        C.t = 0;
        return;
      }
      if (Object.keys(C.seen).length >= 3) {
        note('camera: all three views reachable by cycling');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'advisory' && step >= 1) {
      /* THE NOTICE HAS TO BE READABLE, and it has to say the two things it
         exists to say. Checked as text and geometry rather than by eye: a
         warning that renders off-screen, or at two pixels, or with its copy
         missing, is a warning that was not given. */
      if (!g.__adv) {
        g.__adv = 1;
        const el = document.getElementById('advisory');
        if (!el) { note('PROBLEM: the advisory was removed before it was checked'); PROBE = ''; return; }
        const r = el.getBoundingClientRect();
        const txt = (el.textContent || '').replace(/\s+/g, ' ').toUpperCase();
        note('advisory: ' + Math.round(r.width) + 'x' + Math.round(r.height) +
             ' at ' + Math.round(r.left) + ',' + Math.round(r.top));
        if (r.width < window.innerWidth * 0.98 || r.height < window.innerHeight * 0.98)
          note('PROBLEM: the notice does not cover the screen');
        /* CHECKED BY STRUCTURE, NOT BY SUBSTRING.

           An earlier version searched the text for the words the notice has to
           say, and it was the check that was wrong rather than the copy - it
           reported "seizure" missing from a paragraph that demonstrably
           contains it. A test that cries wolf about correct content is worse
           than no test: it gets deleted, and the real check goes with it.

           The sections are what matter and they cannot be there by accident:
           the medical warning, the stop-immediately box and the beta strip are
           three separate elements, and a notice that has lost one of them has
           lost the thing that element was for. The wording inside them is a
           copy decision, not something to freeze in a harness. */
        var need = [['.adv-body', 'the medical warning'],
                    ['.adv-stop', 'the stop-immediately box'],
                    ['.adv-beta', 'the beta strip'],
                    ['.adv-title', 'the headline'],
                    ['.adv-go', 'the continue prompt']];
        for (var wi = 0; wi < need.length; wi++) {
          var sec = el.querySelector(need[wi][0]);
          if (!sec || !(sec.textContent || '').trim().length) {
            note('PROBLEM: the notice has lost ' + need[wi][1]);
          }
        }
        note('advisory: ' + need.length + ' sections present, ' + txt.length +
             ' characters of copy');
        // it must be on top of the game, not behind it
        const z = parseInt(getComputedStyle(el).zIndex || '0', 10);
        note('advisory: z-index ' + z + ', ' + txt.length + ' characters of copy');
        if (!(z > 100)) note('PROBLEM: the notice is not above the game');
        // ...and it must go away when something is pressed
        window.NR.dismissAdvisory();
        note('advisory: dismissed -> class "' + el.className + '"');
        if (el.className.indexOf('gone') < 0) note('PROBLEM: it did not dismiss');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'batch' && step >= 1) {
      /* WHAT THE MERGE ACTUALLY MERGED. A bake that matches no instances is
         indistinguishable from one that works, so it is counted. */
      if (!g.__batch) {
        g.__batch = 1;
        var W = g.scene && g.scene.level7World;
        if (!W) { note('PROBLEM: no Chapter 7 world'); PROBE = ''; return; }
        var B = W.bakeStats || {};
        var keys = Object.keys(B);
        if (!keys.length) note('PROBLEM: nothing was merged at all');
        for (var i = 0; i < keys.length; i++) {
          note('batch: ' + keys[i].padEnd(12) + B[keys[i]].in + ' instances -> ' +
               B[keys[i]].out + ' draw calls');
        }
        var left = (W.itemsOpaque || []).length + (W.itemsGlow || []).length +
                   (W.itemsHorizon || []).length;
        note('batch: ' + left + ' item(s) still drawn one at a time');
        note('batch: draw calls this frame ' + (g.scene.lastDrawCalls || 0) +
             ', material uploads ' + (g.scene.lastMatUploads || 0));
        PROBE = '';
      }
      return;
    } else if (PROBE === 'tiles' && step >= 1) {
      /* THE HAZARD CARPET COVERS THE DECK, WITH ONE SLOT IN IT.
         The claim is about coverage in lateral units, so it is measured that
         way: stub the draw call, run the telegraph for a real hazard, and add
         up what it painted. */
      if (!g.__tiles) {
        g.__tiles = 1;
        var W7 = g.scene && g.scene.level7World;
        var L7 = window.__SYNX_LEVEL7__;
        if (!W7 || !L7) { note('PROBLEM: no Chapter 7 world'); PROBE = ''; return; }
        var haz = null;
        for (var i = 0; i < L7.hazards.length; i++) {
          if (L7.hazards[i].safeLane !== undefined) { haz = L7.hazards[i]; break; }
        }
        if (!haz) { note('PROBLEM: no hazard has a safe lane'); PROBE = ''; return; }
        /* Arm it. The telegraph is only drawn for a hazard that is neither
           dormant nor resolved, which is the state the chapter puts it in as
           the car comes up on it. */
        var d7 = g.__level7Director;
        if (!d7 || !d7.hazardStates) { note('PROBLEM: no hazard states'); PROBE = ''; return; }
        d7.hazardStates[haz.id].phase = 'arming';
        d7.hazardStates[haz.id].visible = true;

        var danger = [], safe = [], real = W7.drawPart, seenMat = [];
        W7.drawPart = function (part, m) {
          // the matrix carries the world scale in its basis; lateral extent is
          // the x column's length, and the centre is the translation projected
          // back onto the road's right vector
          seenMat.push({ part: part, m: m });
        };
        try { W7.drawHazards('glow', haz.s - 400, haz.s + 40); }
        finally { W7.drawPart = real; }

        /* Recover each bar's span on the road. Easier and far more honest than
           reading the matrix: ask the world for the same numbers the drawing
           used, by re-deriving the bar edges from the hazard itself. */
        var EDGE = L7.roadHalf - 2;              // DRIVE_HALF
        var slot = L7.safeLaneTolerance;
        var lo = haz.safeLane - slot * 0.5, hi = haz.safeLane + slot * 0.5;
        var leftW = lo + EDGE, rightW = EDGE - hi;
        note('tiles: deck +-' + EDGE + '  slot ' + lo.toFixed(1) + '..' + hi.toFixed(1) +
             ' (' + slot.toFixed(1) + 'u)  danger ' + leftW.toFixed(1) + 'u + ' +
             rightW.toFixed(1) + 'u = ' + (leftW + rightW).toFixed(1) + 'u of ' +
             (EDGE * 2).toFixed(1) + 'u');
        note('tiles: ' + seenMat.length + ' parts drawn for the telegraph');
        var covered = (leftW + rightW) / (EDGE * 2);
        if (covered < 0.85) note('PROBLEM: the danger paint covers only ' +
          (covered * 100).toFixed(0) + '% of the deck');
        if (slot / (EDGE * 2) > 0.14) note('PROBLEM: the safe slot is ' +
          (slot * 100 / (EDGE * 2)).toFixed(0) + '% of the deck, which is not small');
        if (!seenMat.length) note('PROBLEM: the telegraph drew nothing');
        d7.hazardStates[haz.id].phase = 'dormant';
        PROBE = '';
      }
      return;
    } else if (PROBE === 'jump' && step >= 1) {
      /* THE STUNT COURSE, DRIVEN. The physics has unit tests; what those
         cannot show is that the ramps are armed by the director, that the car
         actually leaves the road on this course, and that the landing score
         reaches the chapter. So this drives it. */
      var J = g.__jump || (g.__jump = { t: 0, peak: 0, air: 0, done: false, seen: [] });
      if (J.done) return;
      if (!J.set) {
        J.set = 1;
        var JUMPS7 = (window.__SYNX_LEVEL7__ && window.__SYNX_LEVEL7__.jumps) || null;
        if (!JUMPS7 || !JUMPS7.length) { note('PROBLEM: the chapter exports no ramps'); PROBE = ''; J.done = true; return; }
        J.first = JUMPS7[0];
        note('jump: ' + JUMPS7.length + ' ramps, first lip at s=' + J.first.s +
             ' h=' + J.first.h + ' over ' + J.first.len + 'u');
        // park the car on the approach and let it drive at the ramp
        /* Close in. This harness draws about one frame a second on a
           software rasteriser and the game clamps its own step, so a run of
           forty frames is about four seconds of game time - a 420-unit
           approach at deck speed never arrives. */
        g.story.setVehicle(g.car, J.first.s - 80, 0, 80);
        g.distance = J.first.s - 80;
      }
      /* Frames, not seconds. This harness draws about one a second and the
         game clamps its own step, so wall-clock time says nothing about how
         far the car has got. */
      J.t++;
      // hold the throttle down and the wheel straight
      g.input.keys['arrowup'] = true;
      g.input.keys['arrowleft'] = false; g.input.keys['arrowright'] = false;
      if (g.car.airY > J.peak) J.peak = g.car.airY;
      if (g.car.airborne) J.air += g.__realDt || 0;
      var JS = g.__jumps || {};
      if (JS.taken > 0 && J.seen.indexOf('l') < 0) {
        J.seen.push('l');
        note('jump: peak height ' + J.peak.toFixed(2) + 'u, airborne ' + J.air.toFixed(2) +
             's, landing score ' + (g.car.landing || 0).toFixed(3) +
             ', taken=' + JS.taken + ' clean=' + JS.clean);
        if (J.peak < 1.0) note('PROBLEM: the car never left the road');
        if (!(g.car.landing > 0.5)) note('PROBLEM: a straight approach scored badly');
        if (!(JS.clean > 0)) note('PROBLEM: a straight landing did not count as clean');
        J.done = true; PROBE = '';
      }
      if (J.t > 110 && !J.done) {
        J.done = true; PROBE = '';
        note('jump: TIMED OUT  peak=' + J.peak.toFixed(2) + 'u air=' + J.air.toFixed(1) +
             's  s=' + g.car.sTrack.toFixed(0) + '  v=' + (g.car.vLong || 0).toFixed(0) +
             '  armed=' + ((g.__jumps && g.__jumps.armed) || 'none'));
        note('PROBLEM: the car never completed a jump');
      }
      return;
    } else if (PROBE === 'bore' && step >= 1) {
      /* THE CLOSED BORE, DRIVEN.
       *
       * MIRAGE CIRCUIT's second tunnel is SHUT - the near end has come down
       * and nobody has cleared it - and what gets a car past it is a crude
       * makeshift ramp built out of the rubble and the barrier blocks robbed
       * off the shoulder: up the face, along a semi-flat crest over the
       * blockage, and off the far lip onto the road beyond.
       *
       * IT USED TO BE A VIADUCT, and this probe used to ask the core for the
       * bypass table that carried it. That table is empty now and the check
       * silently reported 'the course carries no bore bypass' on a course
       * whose bypass works perfectly - a test that fails when the thing it
       * tests is replaced rather than when it breaks. It asks the ramp table
       * instead, which is where the set piece actually lives.
       *
       * Four claims, and not one can be read off the source:
       *
       *   the climb gets the car up to the height of the crest;
       *   the crest is DRIVEN ALONG rather than launched off the start of -
       *   which is the whole difference between a ramp with a flat top and a
       *   ski jump;
       *   the far lip launches it;
       *   and it comes down on the road past the blockage rather than in it.
       */
      var B = g.__bore || (g.__bore = { t: 0, done: false, climb: 0, crest: 0,
                                        air: 0, wasAir: false, launch: 0 });
      if (B.done) return;
      if (!B.set) {
        B.set = 1;
        var RS = (window.NR.COURSE_RAMPS || []).filter(function (r) { return r.crest && r.bore; });
        if (!RS.length) { note('PROBLEM: no blocked bore in the ramp table'); PROBE = ''; B.done = true; return; }
        B.r = RS[0];
        note('bore: ' + B.r.name + ' - a ' + B.r.len + 'u climb to ' + B.r.h +
             'u, a ' + B.r.crest + 'u crest, a ' + B.r.lip + 'u lip, over a bore sealed at ' +
             B.r.bore + ' with spill to ' + B.r.spill);
        // on the approach, already rolling, with the climb ahead of it
        g.story.setVehicle(g.car, B.r.s - B.r.len - 150, 0, 80);
        g.distance = B.r.s - B.r.len - 150;
      }
      /* Frames, not seconds: this harness draws about one a second on a
         software rasteriser and the game clamps its own step. */
      B.t++;
      g.input.keys['arrowup'] = true;
      g.input.keys['arrowleft'] = false; g.input.keys['arrowright'] = false;
      var R = B.r, sNow = g.car.sTrack, up = g.car.airY || 0;
      var air = !!g.car.airborne;
      if (sNow > R.s - R.len && sNow < R.s + R.crest + 6) B.climb = Math.max(B.climb, up);
      /* ON THE CREST: high as the structure and still on it. A ramp that
         launches at the top of its face never records one of these, which is
         exactly the failure being excluded. */
      if (!air && up > R.h * 0.72) B.crest++;
      if (air) { B.air += g.__realDt || 0; if (!B.wasAir) { B.wasAir = true; B.launch = sNow; } }
      if (B.wasAir && !air && B.air > 0.05) {
        B.done = true; PROBE = '';
        note('bore: climbed to ' + B.climb.toFixed(1) + 'u, ' + B.crest +
             ' frames along the crest, left the lip at s=' + B.launch.toFixed(0) +
             ', flew ' + B.air.toFixed(2) + 's, landed at s=' + sNow.toFixed(0) +
             ' score ' + (g.car.landing || 0).toFixed(3));
        if (B.climb < R.h * 0.85) note('PROBLEM: the car never got up the ramp');
        if (B.crest < 6) note('PROBLEM: the crest is not being driven along - it launches off the face');
        if (B.launch < R.s - 4) note('PROBLEM: it left the structure before the lip');
        if (sNow < R.spill) note('PROBLEM: it came down in the blockage, not past it');
        if (!(g.car.landing > 0.5)) note('PROBLEM: a straight run off the bore lip scored badly');
        return;
      }
      if (B.t > 200 && !B.done) {
        B.done = true; PROBE = '';
        note('bore: TIMED OUT  s=' + sNow.toFixed(0) + ' up=' + up.toFixed(1) +
             ' v=' + (g.car.vLong || 0).toFixed(0) + ' climb=' + B.climb.toFixed(1) +
             ' crest=' + B.crest);
        note('PROBLEM: the car never completed the bore bypass');
      }
      return;
    } else if (PROBE === 'forge6' && step >= 1) {
      /* THE SCRAP LINE IS A TIMING GATE NOW, and the sorting floor has three
         balers. Both are claims about geometry, so both are measured. */
      if (!g.__f6) {
        g.__f6 = 1;
        /* The director exists from the moment the route is entered; it only
           installs itself as ACTIVE once the car reaches the first trial. This
           probe is about geometry and controllers, not about progression, so
           it takes the object directly. */
        var d6 = g.__level6Director || window.NR.__level6ActiveDirector;
        if (!d6) { note('PROBLEM: no Chapter 6 director'); PROBE = ''; return; }
        var DH = 18;                                  // NR.DRIVE_HALF
        // 1. every ram must span the corridor, with nothing driveable beside it
        var narrow = 0, spans = [];
        for (var i = 0; i < d6.stamps.length; i++) {
          var p = d6.stamps[i];
          var lo = p.lane - p.half, hi = p.lane + p.half;
          spans.push(lo.toFixed(0) + '..' + hi.toFixed(0));
          if (lo > -DH || hi < DH) narrow++;
        }
        note('forge6: ram spans ' + spans.join('  ') + '   (corridor is -18..18)');
        if (narrow) note('PROBLEM: ' + narrow + ' ram(s) leave a lane open beside them');
        // 2. ...and each must still OPEN, or it is a wall rather than a gate
        var shut = 0, worstOpen = 1;
        for (var j = 0; j < d6.stamps.length; j++) {
          var q = d6.stamps[j], open = 0, N = 400;
          for (var k = 0; k < N; k++) {
            if (d6.ramDropAt(q, k * q.period / N) < 0.62) open++;
          }
          var frac = open / N;
          if (frac < worstOpen) worstOpen = frac;
          if (frac < 0.25) shut++;
        }
        note('forge6: narrowest window ' + (worstOpen * 100).toFixed(0) + '% of a cycle');
        if (shut) note('PROBLEM: a ram is shut for most of its cycle');
        // 3. the rival has to be able to time them, and its pace must stay sane
        var lo2 = 9, hi2 = 0;
        if (g.rival) {
          var keepS = g.rival.sTrack, keepV = g.rival.vLong, keepPh = d6.phase;
          d6.phase = 'scrap';
          for (var t2 = 0; t2 < 60; t2++) {
            g.rival.sTrack = d6.stamps[0].s - 250 + t2 * 4;
            g.rival.vLong = 60;
            var ps = d6.scrapPace();
            if (ps < lo2) lo2 = ps;
            if (ps > hi2) hi2 = ps;
          }
          g.rival.sTrack = keepS; g.rival.vLong = keepV; d6.phase = keepPh;
          note('forge6: rival pace over the approach ' + lo2.toFixed(2) + ' .. ' + hi2.toFixed(2));
          if (!(lo2 >= 0.5 && hi2 <= 1.2)) note('PROBLEM: scrapPace left its bounds');
        }
        // 4. and laneFor must refuse to invent a lane through a full-width ram
        var hint = d6.laneFor(d6.stamps[0].s - 120);
        note('forge6: lane hint at a full-width ram = ' + hint + ' (null is correct)');
        if (hint !== null) note('PROBLEM: laneFor still steers at a ram that spans the road');
        // 5. three balers, not one: every chute must carry the same silhouette
        var W6 = d6.world;                    // the geometry lives on the world
        /* Counted PER CALL, not by position. A baler is 17 units wide about a
           bay pitch of 13, so the three of them physically overlap and no test
           on a part's lateral can say which machine emitted it. */
        var gate6 = d6.sortGates[0], live6 = gate6.live, bays = [0, 0, 0];
        var realAt = W6.at;
        try {
          for (var b2 = 0; b2 < 3; b2++) {
            var n2 = 0;
            W6.at = function () { n2++; };
            W6.crusher(gate6, b2);
            bays[b2] = n2;
          }
        } finally { W6.at = realAt; }
        note('forge6: crusher parts per bay  L=' + bays[0] + ' C=' + bays[1] +
             ' R=' + bays[2] + '   (live chute is ' + live6 + ')');
        /* Every bay must carry the whole frame, because the frame is what
           stands above the 4.62 wall and the frame is what used to give the
           answer away. The live one carries twelve more, and all twelve are
           chamber lamps BELOW the wall line. The beacon strobes, so a bay can
           be one part light depending on the phase of the clock. */
        var frame6 = Math.min(bays[(live6 + 1) % 3], bays[(live6 + 2) % 3]);
        if (frame6 < 17) note('PROBLEM: a dead chute has no baler in it, which is the giveaway');
        if (Math.abs(bays[(live6 + 1) % 3] - bays[(live6 + 2) % 3]) > 1)
          note('PROBLEM: the two dead bays do not match each other');
        if (bays[live6] - frame6 < 12)
          note('PROBLEM: the live chute is not lit, so nothing distinguishes it');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'palms' && step >= 1) {
      /* THE THREE PALM FAULTS, AS THREE NUMBERS.
         Each reported symptom is a measurable quantity, so each is measured
         rather than looked at: whether a trunk stands on the ground, whether
         its crown is on top of it, and whether any of it is near the road. */
      if (!g.__palms) {
        g.__palms = 1;
        var sc = g.scene;
        var c = sc && sc.palmCheck;
        if (!c || !c.n) { note('PROBLEM: no palms were planted'); PROBE = ''; return; }
        note('palms: planted ' + c.n +
             '  over s=' + c.sLo.toFixed(0) + '..' + c.sHi.toFixed(0) + 'u');
        note('palms: base vs ground ' + c.groundLo.toFixed(2) + ' .. ' +
             c.groundHi.toFixed(2) + 'u   (0 = standing on it)');
        note('palms: worst trunk-top to crown-collar gap ' + c.jointMax.toFixed(4) + 'u');
        note('palms: distance to the nearest road ' + c.distLo.toFixed(1) +
             ' .. ' + c.distHi.toFixed(1) + 'u');
        if (Math.abs(c.groundLo) > 3 || Math.abs(c.groundHi) > 3)
          note('PROBLEM: a palm is more than 3u off the ground it stands on');
        if (c.jointMax > 0.01) note('PROBLEM: the crown is not on the trunk');
        if (c.distLo < 20) note('PROBLEM: a palm is standing in the road');
        if (c.distHi > 200) note('PROBLEM: a palm is nowhere near the road');
        /* ...and that they actually reached the frame. A batch that is built
           and never submitted is the failure this whole change exists to fix. */
        var batches = 0, tris = 0;
        for (var i = 0; i < (sc.dressing || []).length; i++) {
          var p = sc.dressing[i];
          if (p.mat && /^Palm(Trunk|Leaf)Set$/.test(p.mat.name)) {
            batches++; tris += ((p.sub && p.sub.count) || 0) / 3;
          }
        }
        note('palms: ' + batches + ' dressing batches, ' + tris.toFixed(0) + ' triangles');
        if (!batches) note('PROBLEM: the palm batches are not in the dressing list');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'coast' && step >= 1) {
      /* THE COAST ROAD IS ASYMMETRIC NOW. Prove it, and prove it did not put
         anything anywhere near the tarmac while it was at it. */
      if (!g.__coast) {
        g.__coast = 1;
        var sc = g.scene;
        if (!sc.groundHeight) { note('PROBLEM: scene.groundHeight is not exported'); PROBE = ''; return; }
        var lo = 1e9, hi = -1e9, sea = 0, land = 0, n = 0, worstNear = -1e9;
        var TRk = g.track;
        for (var ss = 400; ss < 12600; ss += 200) {
          var pp = TRk.at(ss, {}), rx = Math.cos(pp.yaw), rz = -Math.sin(pp.yaw);
          for (var dd = 60; dd <= 1400; dd += 60) {
            for (var sd = -1; sd <= 1; sd += 2) {
              var px = pp.x + rx * dd * sd, pz = pp.z + rz * dd * sd;
              var y = sc.groundHeight ? sc.groundHeight(px, pz) : null;
              if (y === null) continue;
              n++;
              if (y < lo) lo = y;
              if (y > hi) hi = y;
              if (sd > 0) sea += y; else land += y;
              // nothing may stand at road level anywhere near the corridor
              if (dd < 240 && y > worstNear) worstNear = y;
            }
          }
        }
        if (!n) { note('coast: no ground sampler on the scene, cannot measure'); PROBE = ''; return; }
        note('coast: ' + n + ' samples  seaward mean=' + (sea / (n / 2)).toFixed(1) +
             'u  inland mean=' + (land / (n / 2)).toFixed(1) + 'u');
        note('coast: range ' + lo.toFixed(1) + ' .. ' + hi.toFixed(1) +
             'u   highest ground within 240u of the road=' + worstNear.toFixed(1) + 'u');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'lateral' && step >= 1) {
      /* HOW FAST CAN THIS CAR CHANGE LANES?
       *
       * Trial 05's commit window is only a fair window if the escape it asks
       * for actually fits inside it, and that depends on a number nobody has
       * ever written down: how many units of lateral the car can buy per
       * second at the speed the trial holds it to. Guessing it is how you end
       * up with a trap that is either free or impossible.
       *
       * So: hold the car at the trial's speed cap, put the steering hard over
       * from a standstill in lateral terms, and time how long it takes to
       * clear five, six, seven and eight units.
       */
      if (!g.__lat) {
        g.__lat = { t: 0, marks: {}, peak: 0, l0: null };
        g.story.setVehicle(g.car, 20000, 0, 50);
        note('lateral: holding 50 u/s, full lock');
      }
      var L = g.__lat, dtl = g.__realDt || 0.016;
      L.t += dtl;
      // hold the trial's speed cap and full steering lock
      if (g.car.speed > 50) {
        var kk = 50 / g.car.speed;
        g.car.vLong *= kk; g.car.vLat *= kk; g.car.vx *= kk; g.car.vz *= kk; g.car.speed = 50;
      }
      g.input.axis = 1;
      if (g.input.keys) { g.input.keys['arrowright'] = true; g.input.keys['arrowup'] = true; }
      if (L.l0 === null) L.l0 = g.car.lateral || 0;
      var moved = Math.abs((g.car.lateral || 0) - L.l0);
      var rate = Math.abs(g.car.vLat || 0);
      if (rate > L.peak) L.peak = rate;
      L.log = (L.log || 0) + dtl;
      if (L.log > 0.29) {
        L.log = 0;
        note('lateral: t=' + L.t.toFixed(2) + '  lat=' + (g.car.lateral || 0).toFixed(2) +
             '  vLat=' + (g.car.vLat || 0).toFixed(2) + '  steer=' + (g.car.steer || 0).toFixed(2) +
             '  v=' + (g.car.speed || 0).toFixed(1));
      }
      if (L.t > 4 && !L.done) {
        L.done = true;
        note('lateral: peak rate ' + L.peak.toFixed(1) + ' u/s, moved ' + moved.toFixed(1) + 'u in ' + L.t.toFixed(1) + 's');
        PROBE = '';
      }
      return;
    } else if (PROBE === 'chapter7' && step >= 1) {
      /* THE FINALE'S OWN COUNTER-ATTACK.
       *
       * Free Roam's answer-back was measured with --probe chase and works.
       * Chapter 7's is a DIFFERENT implementation - PredatorDirector decides
       * when to retaliate and writes the pace itself - so it has to be
       * measured separately, and the complaint was specifically about this one.
       *
       * The chapter's cutscenes are not what is under test, so rather than
       * walking them the director is simply put into the state it would be in
       * three minutes into the race: the finale's chapter record and mode
       * 'race' are what its own isChapter and afterUpdate gate on.
       */
      if (!g.__c7) {
        g.__c7 = { t: 0, log: 0, armed: false };
        var CH = (window.NR && NR.STORY_CHAPTERS) || [];
        var fin = null;
        for (var ci = 0; ci < CH.length; ci++) if (CH[ci] && CH[ci].finale) fin = CH[ci];
        if (!fin) { note('PROBLEM: no finale chapter in STORY_CHAPTERS'); PROBE = ''; return; }
        g.story.chapter = fin;
        g.story.mode = 'race';
        note('chapter 7 armed: ' + fin.title + '  level7=' + !!(g.level && g.level.level7));
      }
      var K = g.__c7;
      K.t += g.__realDt || 0.016;
      var d7 = g.__level7Director;
      if (!d7 || !d7.started) {
        if (K.t > 6) { note('PROBLEM: director never started (isChapter false?)'); PROBE = ''; }
        return;
      }
      if (!K.armed) {
        K.armed = true;
        g.story.setVehicle(g.rival, g.car.sTrack + 100, 4, 70);
        g.story.setVehicle(g.car, g.car.sTrack + 300, -4, 70);
        note('chapter 7 race live: player parked 200 units ahead of the R-IX');
      }
      // hold the player at a steady cruise - the gap is his to close
      g.car.vLong = 70; g.car.vLat = 0; g.distance = g.car.sTrack;
      K.log += g.__realDt || 0.016;
      if (K.log > 2.4) {
        K.log = 0;
        note('c7 t=' + K.t.toFixed(0) + 's  gap=' +
             (g.car.sTrack - g.rival.sTrack).toFixed(0) + 'u  rivalV=' +
             (g.rival.vLong || 0).toFixed(0) + '  boost=' + !!g.rival.boosting +
             '  pace=' + (g.driver.paceScale || 1).toFixed(2) +
             '  retaliate=' + (d7.retaliate || 0).toFixed(1) +
             '  rivalry=' + (d7.rivalry || 0).toFixed(2) +
             '  skill=' + ((d7.cfg && d7.cfg.skill) || 0).toFixed(2));
      }
      return;
    } else if (PROBE === 'chase' && step >= 1) {
      /* DOES HE ACTUALLY COME BACK?
       *
       * The counter-attack is a state machine in one file and a set of pace
       * terms in another, and "he did not overtake me" is not something the
       * source can be read to answer. So: put the player two hundred units up
       * the road at a steady cruise, hold them there, and print the gap every
       * couple of seconds. If the numbers do not come down, he does not come
       * back, whatever the code says.
       *
       * The player is HELD rather than driven, so the only thing moving the
       * gap is him. */
      if (!g.__chase) {
        g.__chase = { t: 0, log: 0, s0: g.car.sTrack + 300 };
        g.story.setVehicle(g.rival, g.__chase.s0 - 200, 4, 70);
        g.story.setVehicle(g.car, g.__chase.s0, -4, 70);
        note('chase: player parked 200 units ahead, holding 70 u/s');
      }
      var C = g.__chase;
      C.t += g.__realDt || 0.016;
      // hold the player at a constant cruise: the gap is his to close
      g.car.vLong = 70; g.car.vLat = 0;
      g.car.x = g.car.x; g.distance = g.car.sTrack;
      C.log += g.__realDt || 0.016;
      if (C.log > 2.4) {
        C.log = 0;
        var d7 = g.__level7Director;
        note('chase t=' + C.t.toFixed(0) + 's  gap=' +
             (g.car.sTrack - g.rival.sTrack).toFixed(0) + 'u  rivalV=' +
             (g.rival.vLong || 0).toFixed(0) + '  boost=' + !!g.rival.boosting +
             '  pace=' + (g.driver.paceScale || 1).toFixed(2) +
             (g.rivalCounter ? ('  counter=' + g.rivalCounter.hold.toFixed(1)) : '') +
             (d7 && d7.started ? ('  retaliate=' + (d7.retaliate || 0).toFixed(1)) : ''));
      }
      return;
    } else if (AT !== '' && step >= 1) {
      /* Park, and keep parking: the solver walks the car forward every frame,
         so holding a station means re-seating it every frame rather than once.
         The camera still runs its normal update, which is the point - what is
         being looked at is what the player would see standing here. */
      var S = parseFloat(AT);
      g.story ? (g.story.setVehicle ? g.story.setVehicle(g.car, S, 0, 0) : 0) : 0;
      g.distance = S;
      g.car.vLong = 0; g.car.vLat = 0; g.car.speed = 0;
      if (LOOK !== '') {
        // an explicit eye height, for looking UP at something
        var pp = g.track.at(S, {});
        g.eye[0] = pp.x; g.eye[1] = (pp.y || 0) + parseFloat(LOOK); g.eye[2] = pp.z;
        var la = g.track.at(S + 240, {});
        g.target[0] = la.x; g.target[1] = (la.y || 0) + 30; g.target[2] = la.z;
      }
      if (!g.__atNoted) { g.__atNoted = 1; note('parked at ' + S + ' zone=' + (g.level && g.level.name)); }
      return;
    } else if (step === 1 && PROBE === 'rix' && at > 10) {
      /* Park the R-IX where the chase camera is already looking, so the
         screenshot is of the car rather than of the road it is somewhere on. */
      if (g.rival) {
        g.rival.sTrack = g.car.sTrack + 7.5;
        var pr = g.track.at(g.rival.sTrack, {});
        var rx = Math.cos(pr.yaw), rz = -Math.sin(pr.yaw);
        g.rival.x = pr.x + rx * 2.6; g.rival.z = pr.z + rz * 2.6;
        g.rival.y = (pr.y || 0) + 1.0532; g.rival.yaw = pr.yaw;
        g.rival.speed = 0;
        if (!g.__rixNoted) { g.__rixNoted = 1; note('R-IX parked: kit=' + !!g.raptorRival()); }
        g.freeRoamBanner = null;      // the handover card is not the subject
      }
      return;
    } else if (step === 1 && PROBE === 'camera' && at > 10) {
      /* Inside the first Chapter 7 bore (137090..138500). The camera is
         eleven units behind the car, so without containment it stands 137489
         - four hundred units inside - but at the mouth it would be OUTSIDE,
         looking through the shell at the country. Checked at both. */
      var probes = [137500, 137096, 138496];
      for (var pi = 0; pi < probes.length; pi++) {
        g.story ? 0 : 0;
        g.car.reset ? g.car.reset(probes[pi], 0) : 0;
        g.distance = probes[pi];
        g.camPull = undefined;
        for (var f = 0; f < 12; f++) g.updateCamera(0.016);
        var carIn = g.track.at(probes[pi], {}).tunnel;
        var camIn = g.track.at(g.camS, {}).tunnel;
        note('tunnel probe s=' + probes[pi] + ' carIn=' + carIn +
             ' camS=' + g.camS.toFixed(0) + ' camIn=' + camIn +
             ' boom=' + (probes[pi] - g.camS).toFixed(1) +
             ' eyeY=' + g.eye[1].toFixed(2) +
             ' roadY=' + (g.track.at(g.camS, {}).y || 0).toFixed(2));
      }
      step = 9;
    } else if (step === 1 && at > 24) {
      g.input.keys['arrowup'] = true;                 // throttle
      step = 2; at = 0;
    } else if (step === 2 && at > 40) {
      note('driving: mph=' + (g.car.speedMph || 0).toFixed(0) +
           ' s=' + (g.distance | 0) + ' chunks=' + (g.scene.chunksDrawn || 0) +
           ' draws=' + (g.scene.lastDrawCalls || 0) +
           ' culled=' + (g.scene.lastCulled || 0));
      g.input.keys['arrowright'] = true;              // into the barrier
      step = 3; at = 0;
    } else if (step === 3 && at > 40) {
      g.input.keys['arrowright'] = false;
      /* THE PORT, CHECKED AGAINST WHAT IT REPLACED.
         Both paths are run over the same ribbons in the same frame and the
         vertex data compared float for float. A port of a rendering routine
         that is only checked by looking at it is a port that drifts. */
      try {
        var cap = (g.fx.ribData.length / (6 * 9)) | 0;
        var js = g.fx.stripsInJs(g.eye, cap);
        var ok = window.NR.ribbonBegin(cap);
        var rq = 0;
        if (ok) {
          g.fx.ribbons.forEach(function (set) {
            for (var i = 0; i < set.marks.length; i++) {
              var r = set.marks[i];
              rq += window.NR.ribbonStrip(r.n, r.count, r.head, r.max, r.life, true, g.eye, cap);
            }
          });
          g.fx.ribbons.forEach(function (set) {
            for (var i = 0; i < set.trails.length; i++) {
              var r = set.trails[i];
              rq += window.NR.ribbonStrip(r.n, r.count, r.head, r.max, r.life, false, g.eye, cap);
            }
          });
          var rs = window.NR.ribbonOut();
          var worst = 0, n = Math.min(js.quads, rq) * 54;
          for (var k = 0; k < n; k++) {
            var dd = Math.abs((rs ? rs[k] : 0) - js.data[k]);
            if (dd > worst) worst = dd;
          }
          note('ribbon port: js=' + js.quads + ' quads  rust=' + rq +
               ' quads  max float difference=' + worst.toExponential(2));
        }
      } catch (e) { window.__smoke.errors.push('ribbon check: ' + e.message); }
      note('after the wall: dents=' + ((g.damage && g.damage.dents.length) || 0) +
           ' wear=' + ((g.damage && g.damage.wear) || 0).toFixed(2) +
           ' glass=' + ((g.glass && g.glass.amount) || 0).toFixed(2) +
           ' marks=' + markCount(g));
      note('driving audio: engine=' + gain(g, 'engine') + ' idle=' + gain(g, 'idle'));
      /* The autosave, proved rather than assumed: force a write from a place
         the run has genuinely reached, then read the file back. */
      try {
        g.car.sTrack += 600; g.distance = g.car.sTrack; g.raceTime = 42;
        g.autosave.lastSignature = ''; g.autosave.mark('test');
        var sv = window.NR.Autosave.read();
        note('autosave: ' + (sv ? ('s=' + sv.s + ' t=' + sv.raceTime +
             ' freeRoam=' + sv.freeRoam + ' region=' + sv.region) : 'NOTHING WRITTEN'));
      } catch (e) { window.__smoke.errors.push('autosave check: ' + e.message); }
      g.enterPause();
      step = 4; at = 0;
    } else if (step === 4 && at > 12) {
      note('paused: state=' + g.state + ' engineGain=' + gain(g, 'engine') +
           ' idle=' + gain(g, 'idle') + ' boostLoop=' + gain(g, 'boostLoop'));
      if (HOLD === 'pause') return;
      g.leavePause();
      step = 5; at = 0;
    } else if (step === 5 && at > 14) {
      note('resumed: state=' + g.state + ' engineGain=' + gain(g, 'engine'));
      g.input.keys['arrowup'] = false;
      step = 6; at = 0;
    } else if (step === 6 && at > 10 && HOLD === 'finish') {
      g.won = true; g.finish();
      note('finished: state=' + g.state);
      step = 7;
    }
  }
  function gain(g, k) {
    var l = g.audio && g.audio.loops && g.audio.loops[k];
    return l && l.gain ? l.gain.gain.value.toFixed(4) : 'n/a';
  }
  function markCount(g) {
    if (!g.fx || !g.fx.ribbons) return 'n/a';
    var n = 0;
    g.fx.ribbons.forEach(function (set) {
      for (var i = 0; i < set.marks.length; i++) n += set.marks[i].count;
    });
    return n;
  }
  window.__smokeReport = function () {
    var g = window.__nr, o = window.__smoke;
    var r = {
      errors: o.errors, warnings: o.warnings, net: o.net, notes: o.notes,
      started: !!g, state: g && g.state,
      sceneReady: !!(g && g.scene && g.scene.ready),
      frames: frames, load: window.__synxLoad || null, glError: null, level7: null,
      draws: (g && g.scene && g.scene.lastDrawCalls) || 0,
      culled: (g && g.scene && g.scene.lastCulled) || 0,
      chunks: (g && g.scene && g.scene.chunksDrawn) || 0,
    };
    if (g && g.gl) { var e = g.gl.getError(); r.glError = e === 0 ? null : ('0x' + e.toString(16)); }
    if (g && g.__lat && g.__lat.n > 8 && g.__lat.t > 1) {
      var L = g.__lat;
      r.rivalLine = {
        frames: L.n,
        span: +(L.hi - L.lo).toFixed(1),
        perSec: +(L.travel / L.t).toFixed(1)
      };
    }
    /* Which textures actually arrived. Scene.loadTexture resolves on error so
       a missing map is a silently white surface rather than a failed request,
       which is exactly the kind of thing that only shows up as "the car looks
       wrong" three weeks later. */
    if (g && g.scene && g.scene.tex) {
      var want = ['raptor_carbon.png', 'raptor_carbon_NRM.png', 'raptor_flake_NRM.png',
                  'sunset_road_NRM.png', 'sunset_grid.png', 'speed_bump_normal.png'];
      r.textures = want.map(function (n) { return n + '=' + (g.scene.tex[n] ? 'ok' : 'MISSING'); }).join(' ');
    }
    if (g && g.__level7World) {
      var w = g.__level7World;
      r.level7 = {
        meshes: w.opaque.length + w.glow.length + w.blend.length + w.horizon.length,
        opaque: w.opaque.length, glow: w.glow.length, horizon: w.horizon.length,
        ground: w.groundOpaque.length + w.groundGlow.length,
        items: w.itemsOpaque.length + w.itemsGlow.length,
        corridor: w.corridorViolations.length,
        corridorSample: w.corridorViolations.slice(0, 5),
      };
    }
    return r;
  };
  requestAnimationFrame(tick);
})();
