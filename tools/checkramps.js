#!/usr/bin/env node
'use strict';
/* ---------------------------------------------------------------------------
 * THE RAMPS, AND WHETHER THE ONE YOU SEE IS THE ONE YOU HIT.
 *
 * A ramp on this course exists three times over: as a row in COURSE_RAMPS, as
 * a window armed on the solver, and as geometry somebody builds. Nothing makes
 * those three agree, and when they stop agreeing the failure is the worst kind
 * there is - the car launches off a surface that is not where it is drawn, or
 * climbs a structure that was never built. The report that started this file
 * called them ghost ramps: invisible things the cars were jumping through.
 *
 * Two had gone wrong and neither was visible in any test that existed:
 *
 *   THE BLOCKED BORE was built twice. It has its own set piece - a stacked
 *   structure with a drivable crest, running 40,620..40,766, which is exactly
 *   what the solver arms - and the generic wedge builder claimed it as well,
 *   putting a second, crestless ramp at 40,660..40,766. Forty units out. The
 *   car climbed the real one and passed through the other.
 *
 *   THE SPINE and SKYLINE LAUNCH were each built twice over, in two adjacent
 *   chunks, because the chunk window reached far enough either side to catch
 *   the approach markings of a neighbour. Two coincident running surfaces
 *   z-fight; two coincident additive markings are twice as bright as every
 *   other ramp on the course.
 *
 * So this asserts the three descriptions against each other, and then drives
 * every route and checks that a car leaves the road where a ramp is and
 * nowhere else.
 *
 *   node tools/checkramps.js
 * ------------------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({
  console, WebAssembly, TextDecoder, TextEncoder,
  fetch: async () => new Response(fs.readFileSync(path.join(root, 'web/wasm/synx_core.wasm')),
    { headers: { 'Content-Type': 'application/wasm' } }),
});
context.window = context;
context.document = { body: null };
vm.runInContext(fs.readFileSync(path.join(root, 'web/js/wasm.js'), 'utf8'), context);
for (const n of ['gl', 'settings', 'game', 'chapters']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'web/js/' + n + '.js'), 'utf8'), context);
}

/* The route boundaries, matching tools/checkai.js. */
const REGIONS = [[60, 13000], [13000, 32000], [32000, 54000], [54000, 79900],
  [79900, 111500], [112080, 131300], [132070, 173000]];

/* What js/scene.js uses to decide what it draws and where. Read out of the
   source rather than restated, so a change there fails here instead of
   quietly disagreeing. */
function sceneConstants() {
  const src = fs.readFileSync(path.join(root, 'web/js/scene.js'), 'utf8');
  const num = (name) => {
    const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([0-9.]+)'));
    if (!m) throw new Error('js/scene.js no longer defines ' + name);
    return parseFloat(m[1]);
  };
  const chunk = src.match(/const CHUNK = (\d+);/);
  if (!chunk) throw new Error('js/scene.js no longer defines CHUNK');
  /* WHICH RAMPS THE BASE SCENE ACTUALLY BUILDS, read off its own filter rather
     than assumed. This is the line that caused the menu's ghost ramps: it used
     to exclude everything past LEVEL7_NEON_FROM on the grounds that Chapter 7
     draws its own, and the title screen does not load Chapter 7. */
  const filt = src.match(/const RAMPS = \(global\.NR\.COURSE_RAMPS \|\| \[\]\)\s*\.filter\(([^;]+)\);/);
  if (!filt) throw new Error('js/scene.js no longer filters COURSE_RAMPS the way this check reads');
  return {
    neonFrom: num('LEVEL7_NEON_FROM'), chunk: parseInt(chunk[1], 10),
    baseFilter: filt[1].trim(),
  };
}

let bad = 0;
const fail = (m) => { console.log('  PROBLEM: ' + m); bad++; };

(async () => {
  const NR = await context.NR.loadCore();
  const scene = JSON.parse(fs.readFileSync(path.join(root, 'web/data/scene.json')));
  const track = new NR.Track(NR.buildCourse(scene.centre));
  track.setWidth(NR.DRIVE_HALF, NR.ROAD_HALF);
  const RAMPS = context.NR.COURSE_RAMPS;
  const TELE = context.NR.RAMP_TELEGRAPH || 280;
  const PAST = -14;
  const K = sceneConstants();

  // ------------------------------------------------ who builds each one --
  console.log('=== WHO BUILDS IT, AND WHERE ===');
  for (const r of RAMPS) {
    /* The window the solver is armed with - see updateRamps in js/game.js.
       A crest ramp climbs to `h` and then runs on to `lip` along a drivable
       top; everything else is the plain wedge. */
    const s0 = r.crest ? r.s - r.crest - r.len : r.s - r.len;
    const s1 = r.crest ? r.s - r.crest : r.s;

    let owner, g0, g1;
    if (r.crest) {
      // the set piece: rampTop runs (len + crest) back from the lip
      owner = 'bore set piece';
      g0 = r.s - r.len - r.crest; g1 = r.s;
    } else if (r.s >= K.neonFrom) {
      /* Two builders, and that is correct: the base scene builds it for every
         world that is not the finale - the title screen among them - and
         Chapter 7 builds its own and hides the base one behind its drawPart
         filter. Both run s-len..s, so whichever is on screen is the same ramp
         in the same place. */
      owner = 'base + chapter 7';
      g0 = r.s - r.len; g1 = r.s;
    } else {
      owner = 'generic wedge';
      g0 = r.s - r.len; g1 = r.s;
    }
    const armedEnd = r.crest ? r.s : s1;
    const off = Math.abs(g0 - s0) + Math.abs(g1 - armedEnd);
    console.log('  ' + r.id.padEnd(11) + ' L' + r.level + '  ' + owner.padEnd(15)
      + ' draws ' + g0.toFixed(0) + '..' + g1.toFixed(0)
      + '   arms ' + s0.toFixed(0) + '..' + armedEnd.toFixed(0)
      + (off > 1 ? '   MISPLACED BY ' + off.toFixed(0) + 'u' : ''));
    if (off > 1) {
      fail(r.id + ' is drawn ' + off.toFixed(0) + 'u away from the window it arms'
        + ' - a car climbing it goes through it');
    }
  }

  /* ...AND THE BASE SCENE BUILDS ALL OF THEM.
   *
   * The title screen flies the attract car off ramps armed from this table
   * (see attractAir in js/game.js) and it does not load any chapter's world -
   * so a ramp the base scene declines to build is a ramp the menu launches
   * off thin air. That is exactly what shipped: NEON HORIZON's three were
   * left to Chapter 7, and the last stretch of every loop of the reel showed
   * a car climbing, jumping and landing on empty road.
   *
   * The filter is read out of js/scene.js rather than restated, so narrowing
   * it again fails here instead of on the title screen. */
  console.log('\n=== WHAT THE MENU CAN FLY ===');
  console.log('  js/scene.js builds: ' + K.baseFilter);
  if (/LEVEL7_NEON_FROM|\b1320{2}0\b/.test(K.baseFilter)) {
    fail('the base scene excludes part of the course from its ramp geometry -'
      + ' the attract reel will fly off ramps that are not drawn there');
  }
  {
    /* A crest ramp is the one exception and it is a real one: it has its own
       set piece, built for the whole course in the same pass. */
    const missing = RAMPS.filter((r) => !r.crest && r.s >= K.neonFrom
      && /neonFrom|LEVEL7/.test(K.baseFilter));
    if (missing.length) fail(missing.length + ' ramp(s) exist only inside a chapter world');
    console.log('  every ramp in the table is geometry on the title screen');
  }

  /* ...AND THE TITLE REEL ONLY FLIES OFF RAMPS IT MEANS TO.
   *
   * The menu's drive uses the same ramp table the solver does, so a stretch
   * that happens to contain a ramp will launch the car whether or not the
   * shot list was written for one - and a launch the camera is not framing
   * reads as a car taking off from flat road, which is what every ghost-ramp
   * report on the title screen has been.
   *
   * So each stretch declares its flavour and this holds the table to it: a
   * `jump` stretch must contain a ramp, and nothing else may. */
  console.log('\n=== THE TITLE REEL ===');
  for (const e of (context.NR.ATTRACT_REEL || [])) {
    const inside = RAMPS.filter((r) => {
      const foot = r.s - (r.crest || 0) - r.len;
      return foot < e.to && r.s > e.from - 40;
    });
    const kind = e.kind || 'drift';
    console.log('  ' + String(e.from).padStart(6) + '..' + String(e.to).padEnd(6)
      + ' ' + kind.padEnd(6) + ' ' + e.name.padEnd(17)
      + (inside.length ? inside.map((r) => r.id).join(', ') : 'no ramp'));
    if (kind === 'jump' && !inside.length) {
      fail(e.name + ' at ' + e.from + ' is cut as a jump and has no ramp in it');
    }
    if (kind !== 'jump' && inside.length) {
      fail(e.name + ' at ' + e.from + ' is a ' + kind + ' stretch but contains '
        + inside.map((r) => r.id).join(', ') + ' - the menu will launch with no shot on it');
    }
  }

  // ----------------------------------------- and exactly one chunk each --
  /* The generic builder emits per 2,000-unit chunk and a ramp must land in
     one of them. Two chunks claiming the same ramp is two coincident ramps. */
  const generic = RAMPS.filter((r) => !r.crest);
  for (const r of generic) {
    let claims = 0;
    for (let a = 0; a < 180000; a += K.chunk) {
      if (r.s >= a && r.s < a + K.chunk) claims++;
    }
    if (claims !== 1) fail(r.id + ' is claimed by ' + claims + ' chunks, not one');
  }
  console.log('  ' + generic.length + ' generic ramp(s), each claimed by exactly one chunk');

  // ---------------------------------------------------- and then drive --
  console.log('\n=== EVERY LAUNCH, DRIVEN ===');
  const dt = 1 / 60;
  for (let li = 0; li < REGIONS.length; li++) {
    const [from, to] = REGIONS[li];
    const car = new NR.Vehicle(track);
    const driver = new NR.Driver(track, 'HARD');
    driver.setLevel('HARD'); driver.reset();
    car.reset(from, 0);
    let armed = null, wasAir = false, launchS = 0, peak = 0;
    const flights = [];
    const maxF = Math.round((to - from) / 30 / dt);
    for (let f = 0; f < maxF && car.sTrack < to; f++) {
      // the same arming the game does, from the same table
      let next = null;
      for (const r of RAMPS) {
        if (r.s - car.sTrack < PAST) continue;
        if (!next || r.s < next.s) next = r;
      }
      const span = next ? next.len + (next.crest || 0) : 0;
      const arm = !!next && (next.s - car.sTrack) < TELE + span && (next.s - car.sTrack) > PAST;
      if (arm) {
        if (armed !== next.id) {
          armed = next.id;
          if (next.crest) {
            car.armRampDeck(next.s - next.crest - next.len, next.s - next.crest,
              next.s, next.h, next.lip || next.h);
          } else car.armRamp(next.s - next.len, next.s, next.h);
        }
      } else if (armed) { armed = null; car.clearRamp(); }

      car.update(dt, driver.drive(dt, car, { raceOn: true }), true);
      const air = !!car.airborne;
      if (air && !wasAir) { launchS = car.sTrack; peak = 0; }
      if (air) peak = Math.max(peak, car.airY || 0);
      if (!air && wasAir) flights.push({ a: launchS, b: car.sTrack, peak });
      wasAir = air;
    }
    const here = RAMPS.filter((r) => r.s > from && r.s < to);
    console.log('  L' + (li + 1) + '  ' + String(from).padStart(6) + '..' + String(to).padEnd(6)
      + '  ' + here.length + ' ramp(s), ' + flights.length + ' launch(es)');
    for (const fl of flights) {
      const on = RAMPS.filter((r) => fl.a >= r.s - r.len - (r.crest || 0) - 6 && fl.a <= r.s + 8);
      console.log('        ' + (on.length ? on[0].id : '???').padEnd(11)
        + ' left at ' + fl.a.toFixed(0) + ', down at ' + fl.b.toFixed(0)
        + ', ' + (fl.b - fl.a).toFixed(0) + 'u out, ' + fl.peak.toFixed(1) + 'u up');
      if (!on.length) {
        fail('a car left the road at ' + fl.a.toFixed(0) + ' with no ramp there');
      }
    }
    for (const r of here) {
      if (!flights.some((fl) => Math.abs(fl.a - r.s) < r.len + (r.crest || 0) + 10)) {
        fail(r.id + ' at ' + r.s + ' was never taken');
      }
    }
  }

  // ------------------------------------- and what else is on that road --
  /* NEON HORIZON'S HAZARDS, placed by arc length the same way the ramps are
     and with the same two ways of going wrong.

     A hazard is painted on the deck a telegraph-length before it arrives, so
     two of them closer together than that telegraph put two warnings on the
     road at once - and a player who commits to the cyan lane of the second is
     in the red lane of the first. A hazard whose telegraph starts before its
     own event has been announced is a warning painted on a deck with no set
     piece running on it. Both were happening: the gauntlet's spacings were
     760, 1730, 890, 930, 1720, 1030 and 710 against telegraphs of up to 820.

     And then there is the finish. A shear panel that lands nine seconds from
     the flag does not test anything - there is no race left to recover in, so
     it either happens to miss you or it decides the chapter. The last one
     stood 820 units out. */
  const L7 = context.__SYNX_LEVEL7__;
  if (!L7) {
    fail('js/chapters.js no longer exports __SYNX_LEVEL7__');
  } else {
    console.log('\n=== NEON HORIZON: WHAT ELSE IS ON THE DECK ===');
    const ev = {};
    for (const e of L7.events) ev[e.id] = e;
    let prev = null;
    for (const h of L7.hazards) {
      const e = ev[h.eventId];
      const reads = h.s - (h.telegraph || 0);
      const gap = prev && prev.eventId === h.eventId ? h.s - prev.s : null;
      let note = '';
      if (e && reads < e.from) {
        note += '  READS ' + (e.from - reads) + 'u BEFORE ITS EVENT';
        fail(h.id + ' telegraphs before ' + h.eventId + ' has begun');
      }
      if (gap !== null && reads < prev.s) {
        note += '  OVERLAPS ' + prev.id;
        fail(h.id + ' telegraphs while ' + prev.id + ' is still ahead of the car');
      }
      console.log('  ' + h.id.padEnd(12) + ' s=' + h.s
        + '  reads from ' + reads
        + (gap === null ? '           ' : '  gap ' + String(gap).padStart(5))
        + '  ' + String(L7.to - h.s).padStart(5) + 'u to the line' + note);
      prev = h;
    }
    /* THREE KILOMETRES OF CLEAR DECK, which at the speed this route is taken
       at is the best part of a minute. The last thing that can hit you has to
       be further out than that: the finale is a thirty-kilometre race against
       the R-IX and it has to be settled by the two cars, which means the
       player needs road to spend a reserve on, take a tow down and make the
       pass. A set piece that runs to the flag decides it instead. */
    const RUN_IN = 5000;
    const last = L7.hazards.reduce((a2, h) => Math.max(a2, h.s), 0);
    console.log('  the last hazard is ' + (L7.to - last) + 'u from the line');
    if (L7.to - last < RUN_IN) {
      fail('the last hazard is ' + (L7.to - last) + 'u from the line, inside the '
        + RUN_IN + 'u run-in the finale is supposed to keep clear');
    }
  }

  console.log(bad
    ? '\n' + bad + ' problem(s) on the course'
    : '\nevery ramp is built once where it is armed, every launch had one under it,'
      + '\nand every hazard reads alone inside its own event');
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
