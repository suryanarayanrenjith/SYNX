#!/usr/bin/env node
'use strict';
/* ---------------------------------------------------------------------------
 * AURORA FORGE'S BROKEN ROOF: IS THE DECK WHERE THE CAR WILL BE?
 *
 *     node tools/checkforge.js
 *
 * The geometry is the half of the broken roof that no unit test reaches: the
 * solver's profile is checked by cargo and the table by tools/checkramps.js,
 * and whether the DECK IS WHERE THE CAR WILL BE is a question about triangles.
 *
 * So the real FactoryWorld is built against the real course through a GL stub
 * that keeps what it is handed, and then a ray is dropped down the centreline
 * at a set of stations and asked what it hits. Counting vertices near a point
 * does not answer that: a deck quad has its corners at the kerbs and nothing
 * at all in the middle, which is exactly where the car drives.
 *
 * WHAT IT CAUGHT ON THE FIRST RUN, which is why it exists rather than a
 * screenshot: the trestle's diagonal braces leaned seven and a half units
 * sideways and crossed the carriageway, one of them standing a unit and a half
 * proud of the running surface on the climb; and the chevrons were laid four
 * times as thick as road paint, so the surface the car stood on was a fifth of
 * a unit above the surface the solver had it on. Neither is visible in a still
 * and both are a car clipping through its own road.
 * ------------------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({
  console, WebAssembly, TextDecoder, TextEncoder, performance,
  fetch: async () => new Response(fs.readFileSync(path.join(root, 'web/wasm/synx_core.wasm')),
    { headers: { 'Content-Type': 'application/wasm' } }),
});
context.window = context;
context.document = { body: null, createElement: () => ({ getContext: () => null, style: {} }) };
vm.runInContext(fs.readFileSync(path.join(root, 'web/js/wasm.js'), 'utf8'), context);
for (const n of ['gl', 'settings', 'game', 'chapters']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'web/js/' + n + '.js'), 'utf8'), context);
}

function stubGL(keep) {
  return {
    ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, FLOAT: 4,
    createVertexArray: () => ({}), bindVertexArray: () => {},
    createBuffer: () => ({}), bindBuffer: () => {},
    bufferData: (t, data) => { (t === 1 ? keep.verts : keep.idx).push(data); },
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
  };
}

(async () => {
  const NR = await context.NR.loadCore();
  const scene = JSON.parse(fs.readFileSync(path.join(root, 'web/data/scene.json')));
  const track = new NR.Track(NR.buildCourse(scene.centre));
  track.setWidth(NR.DRIVE_HALF, NR.ROAD_HALF);

  const keep = { verts: [], idx: [] };
  const game = { gl: stubGL(keep), scene: {}, track, time: 0, distance: 129000 };
  const World = context.__SYNX_FACTORY_WORLD__;
  if (!World) throw new Error('js/chapters.js does not publish __SYNX_FACTORY_WORLD__');
  const world = new World(game);
  world.build();

  const ROOF = context.NR.FORGE_ROOF;
  /* The BIGGEST buffer, not the first: makeCube and makeRing each hand over a
     mesh of their own in the constructor, long before the merged hall arrives. */
  const big = (a) => a.reduce((b, v) => (!b || v.length > b.length ? v : b), null);
  const V = big(keep.verts), I = big(keep.idx);
  if (!V || V.length < 1000) throw new Error('the hall built no vertices');
  console.log('hall built: ' + (V.length / 8).toLocaleString() + ' vertices, '
    + (I.length / 3).toLocaleString() + ' triangles');

  /* ------------------------------------------------------ the ray cast --
   * Triangles bucketed into a 16-unit grid in x/z, so one drop test looks at
   * a few dozen rather than at half a million. */
  const CELL = 16;
  const grid = new Map();
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 8, b = I[t + 1] * 8, c = I[t + 2] * 8;
    const x0 = Math.min(V[a], V[b], V[c]), x1 = Math.max(V[a], V[b], V[c]);
    const z0 = Math.min(V[a + 2], V[b + 2], V[c + 2]), z1 = Math.max(V[a + 2], V[b + 2], V[c + 2]);
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
      for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
        const k = gx + 'x' + gz;
        let list = grid.get(k);
        if (!list) grid.set(k, list = []);
        list.push(t);
      }
    }
  }

  /** The highest surface under (x, z) at or below `ceil`, or null. */
  function surfaceAt(x, z, ceil) {
    const list = grid.get(Math.floor(x / CELL) + 'x' + Math.floor(z / CELL));
    if (!list) return null;
    let best = null;
    for (const t of list) {
      const a = I[t] * 8, b = I[t + 1] * 8, c = I[t + 2] * 8;
      const ax = V[a], az = V[a + 2], bx = V[b], bz = V[b + 2], cx = V[c], cz = V[c + 2];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;               // edge-on; it has no top
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * V[a + 1] + v * V[b + 1] + w * V[c + 1];
      if (y > ceil) continue;
      if (best === null || y > best) best = y;
    }
    return best;
  }

  const at = (s) => {
    const p = track.at(s, {});
    return { x: p.x, z: p.z, rx: Math.cos(p.yaw), rz: -Math.sin(p.yaw) };
  };
  const pt = (s, lat) => { const F = at(s); return [F.x + F.rx * lat, F.z + F.rz * lat]; };

  let bad = 0;
  const fail = (m) => { console.log('  PROBLEM: ' + m); bad++; };

  // ------------------------------------------------------------------- 1 --
  console.log('\n=== THE RUNNING SURFACE IS WHERE THE CAR WILL BE ===');
  let worstErr = 0, worstAt = 0, checked = 0, holes = 0;
  for (let s = ROOF.foot + 8; s < ROOF.floor - 6; s += 37) {
    const want = world.roofY(s);
    for (const lat of [-14, 0, 14]) {
      const [x, z] = pt(s, lat);
      const got = surfaceAt(x, z, want + 0.9);
      checked++;
      if (got === null) {
        holes++;
        if (holes <= 4) fail('nothing under the car at s=' + s.toFixed(0) + ' lat=' + lat);
        continue;
      }
      const err = Math.abs(got - want);
      if (err > worstErr) { worstErr = err; worstAt = s; }
      if (err > 0.22) {
        fail('the deck at s=' + s.toFixed(0) + ' lat=' + lat + ' is ' + got.toFixed(2)
          + ' but the solver puts the car at ' + want.toFixed(2));
      }
    }
  }
  console.log('  ' + checked + ' drop tests along the climb, the deck and the slope; '
    + holes + ' found nothing');
  console.log('  worst disagreement with the solver: ' + worstErr.toFixed(3)
    + 'u at s=' + worstAt.toFixed(0));

  // ------------------------------------------------------------------- 2 --
  console.log('\n=== THE HALL UNDER IT IS EMPTY ===');
  for (const s of [ROOF.clearFrom + 150, ROOF.deck + 200, ROOF.deck + 600, ROOF.edge - 60]) {
    let hits = 0, highest = 0;
    for (const lat of [-16, -8, 0, 8, 16]) {
      const [x, z] = pt(s, lat);
      const y = surfaceAt(x, z, world.roofY(s) - 2.4);
      if (y !== null && y > 8.6) { hits++; highest = Math.max(highest, y); }
    }
    console.log('  s=' + s.toFixed(0) + '  surfaces between 8.6 and the deck: ' + hits
      + (hits ? '  highest ' + highest.toFixed(1) : ''));
    if (hits) fail(hits + ' surface(s) still hang over the carriageway at ' + s.toFixed(0));
  }

  // ------------------------------------------------------------------- 3 --
  console.log('\n=== AND THE ROOF IS BACK ON EITHER SIDE ===');
  for (const s of [ROOF.clearFrom - 500, ROOF.clearFrom - 60, ROOF.clearTo + 60, ROOF.clearTo + 500]) {
    let found = 0;
    for (const lat of [-12, 0, 12]) {
      const [x, z] = pt(s, lat);
      const y = surfaceAt(x, z, 40);
      if (y !== null && y > 15.5) found++;
    }
    console.log('  s=' + s.toFixed(0) + '  roof over the road at ' + found + ' of 3 points');
    if (found < 3) fail('the roof is open at ' + s.toFixed(0) + ', which is outside the breach');
  }

  // ------------------------------------------------------------------- 4 --
  console.log('\n=== NOTHING IN THE CAR ENVELOPE ON THE ROOF ===');
  {
    let worst = 0, where = 0, lateral = 0;
    for (let s = ROOF.foot + 4; s < ROOF.floor - 4; s += 11) {
      const deck = world.roofY(s);
      for (let lat = -18; lat <= 18; lat += 3) {
        const [x, z] = pt(s, lat);
        /* The car is about 1.5 units tall. Anything standing between the deck
           and four units over it is something it would hit; a gantry above
           that is something it passes under. */
        const y = surfaceAt(x, z, deck + 4.0);
        if (y !== null && y > deck + 0.35) {
          const h = y - deck;
          if (h > worst) { worst = h; where = s; lateral = lat; }
        }
      }
    }
    console.log('  tallest obstruction inside the barrier: +' + worst.toFixed(2)
      + 'u' + (worst ? ' at s=' + where.toFixed(0) + ' lat=' + lateral : ''));
    if (worst > 0.9) {
      fail('something stands ' + worst.toFixed(2) + 'u proud of the running surface at s='
        + where.toFixed(0) + ' lat=' + lateral);
    }
  }

  // ------------------------------------------------------------------- 5 --
  console.log('\n=== THE PORTALS ===');
  for (const [name, s] of [['entry', 112040], ['exit', 131460]]) {
    let head = null, blocked = 0;
    for (const lat of [-12, 0, 12]) {
      const [x, z] = pt(s, lat);
      const y = surfaceAt(x, z, 40);
      if (y !== null && (head === null || y > head)) head = y;
      const low = surfaceAt(x, z, 3.0);
      if (low !== null && low > 0.6) blocked++;
    }
    console.log('  ' + name + ' at ' + s + ': lintel at y='
      + (head === null ? 'NONE' : head.toFixed(1))
      + ', road blocked at ' + blocked + ' of 3 points');
    if (head === null || head < 15) fail('the ' + name + ' portal has no beam over the road');
    if (blocked) fail('the ' + name + ' portal has something standing in the road');
  }

  // ------------------------------------------------------------------- 6 --
  /* THE SORTING FLOOR'S THREE BORES ARE CLEAR TUBES.
   *
   * Different question, same failure. The balers are drawn in IMMEDIATE MODE -
   * one at() per box, every frame - so none of them is in the merged buffer
   * the drop tests above ray-cast, and none of them has a collider either
   * (see obstacles() in js/chapters.js, which lists only the walls). Geometry
   * with no collider that stands in the road is geometry the car goes
   * through, and two of these three bays are the RIGHT answer: the trial
   * requires them to be driveable end to end at speed.
   *
   * WHAT IT CAUGHT: the chamber floor was a slab standing 1.1 above the road
   * and seventeen wide, so every bore had a kerb across its mouth that the
   * car passed through; the jaw plate was centred on 1.1 with 2.2 of height
   * on it - y=0..2.2, on the road, through the car, in all three mouths at
   * once - under a comment claiming it sat at 1.1..4.5; and each machine
   * carried its own legs at +-8.4 and its own ram cylinders at +-8.0 from its
   * own centre, which put four of them in the bay NEXT DOOR at windscreen
   * height. Every one of those is invisible in a still and all of them are a
   * car driving through a factory.
   */
  console.log('\n=== THE SORTING FLOOR: THREE DRIVEABLE BORES ===');
  {
    const CAR_TOP = 1.6, DIVIDER = 6.8, WALL_W = 3.2, S = 120000;
    const WALL = [[-DIVIDER - WALL_W / 2, -DIVIDER + WALL_W / 2],
                  [DIVIDER - WALL_W / 2, DIVIDER + WALL_W / 2]];
    const BAYS = [['left', -18.0, -8.4], ['centre', -5.2, 5.2], ['right', 8.4, 18.0]];
    const inWall = (l, r) => WALL.some((w) => l >= w[0] - 1e-3 && r <= w[1] + 1e-3);
    const seen = new Set();
    let worst = null, boxes = 0;
    /* Sampled across a whole baler cycle: everything in here moves, and a
       part is only clear if it is clear at every point in its stroke. */
    for (let step = 0; step <= 40; step++) {
      const g6 = { gl: stubGL({ verts: [], idx: [] }), scene: {}, track,
        time: step / 40 / 0.55, distance: S - 300, car: { sTrack: S - 300 } };
      const w = new context.__SYNX_FACTORY_WORLD__(g6);
      const out = [];
      w.at = (s, lat, y, sx, sy, sz, p) =>
        out.push({ s, lat, y, sx, sy, sz, part: (p && p.mat && p.mat.name) || '?' });
      w.frame = (s) => ({ x: s, y: 0, z: 0, rx: 1, rz: 0, fx: 0, fz: 1 });
      w.sortGate({ s: S, live: 1, resolved: false, crush: false, crushT: 0, cleared: 0 });
      boxes = out.length;
      for (const b of out) {
        const lo = b.y - b.sy / 2, hi = b.y + b.sy / 2;
        if (hi <= 0.20 || lo >= CAR_TOP) continue;
        const l = b.lat - b.sx / 2, r = b.lat + b.sx / 2;
        if (inWall(l, r)) continue;
        for (const [name, blo, bhi] of BAYS) {
          if (r <= blo + 1e-3 || l >= bhi - 1e-3) continue;
          const into = Math.min(r, bhi) - Math.max(l, blo);
          const key = name + b.part + b.lat.toFixed(1) + lo.toFixed(2);
          if (!seen.has(key)) {
            seen.add(key);
            fail(b.part + ' stands ' + into.toFixed(2) + ' units into the ' + name
              + ' bore at s+' + (b.s - S).toFixed(0)
              + ', y=' + lo.toFixed(2) + '..' + hi.toFixed(2));
          }
          if (!worst || into > worst) worst = into;
        }
      }
    }
    console.log('  ' + boxes + ' boxes per gate, sampled over a full baler cycle');
    console.log('  ' + (worst === null
      ? 'nothing below the roof of a car in any of the three bays'
      : 'worst intrusion: ' + worst.toFixed(2) + ' units'));
  }

  console.log(bad ? '\n' + bad + ' problem(s) in the breach'
    : '\nthe deck is where the solver puts the car, the hall under it is clear,\n'
      + 'the roof is intact either side, the corridor is open, both mouths\n'
      + 'have a portal over them and all three sorting bores are driveable');
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
