#!/usr/bin/env node
/* Drop from data/scene.{json,bin} everything the game never draws.
 *
 *     node tools/trimscene.js            report what would go
 *     node tools/trimscene.js --write    ...and rewrite the scene
 *
 * WHY
 * ---
 * scene.bin is eleven megabytes and it is the single largest thing inside the
 * shipped executable. Two thirds of it is geometry that no frame has ever
 * shown, for two separate reasons, and both of them are decisions the renderer
 * already made and then paid for anyway:
 *
 *   terrain_sunset_MeshPart0/1   The imported hills. buildDrawLists drops
 *                                them by name because buildLandscape covers
 *                                the whole 173 km from one height field, and
 *                                two landscapes meeting in the middle of route
 *                                2 is what made the world look assembled.
 *                                51,262 vertices and 304,077 indices that are
 *                                loaded, uploaded to the GPU and never bound.
 *
 *   PalmPrefab-mesh0/1/2         The baked palm forest. 159,528 vertices
 *                                spread over 5.8 km by 10.2 km, planted flat
 *                                at y = -2.29 against the terrain above -
 *                                which is not drawn, so they stand in a
 *                                generated landscape that reaches 340 units
 *                                and are buried in it. What reaches the frame
 *                                is crowns with no trunks poking out of
 *                                hillsides, which is one of the three reported
 *                                palm faults.
 *
 * ...and with them the instances that place them, plus the 112 `trunk`
 * instances: the shipped roadside palms. Those are the other two faults. Their
 * crown matrix puts the frond cluster 9.6 units sideways and 16.6 units BELOW
 * the top of its own trunk, so the trunk spears past a crown floating beside
 * it; and every one of them is pinned at y = -2.12 with no reference to the
 * ground, at anything from 70 to 5,440 units from the road. They are replaced
 * by Scene.buildPalms, which plants the SAME two meshes - the artist's
 * geometry and the artist's line-art unwrap, unchanged - correctly assembled
 * and conformed to the landscape. So `trunk` and `palms` are kept in the
 * buffer even though nothing instances them any more; see KEEP below.
 *
 * WHAT IT DOES NOT TOUCH
 * ----------------------
 * The two tunnel shells and the four tunnel facades are also never submitted,
 * and they stay: fixupGeometry squeezes the shells into the narrowed corridor
 * and `roadSqueezed` is asserted against them. They are 7,446 vertices; the
 * assertion is worth more.
 *
 * The output is byte-identical in meaning: every surviving mesh keeps its
 * vertices, its indices and its winding, and every instance keeps the mesh it
 * pointed at. Only the numbering changes.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'web', 'data', 'scene.json');
const BIN_PATH = path.join(ROOT, 'web', 'data', 'scene.bin');
const WRITE = process.argv.includes('--write');

/* Meshes dropped outright, by name. Everything else survives if something
   still points at it. */
const DROP_MESH = /^(terrain_sunset_MeshPart[01]|PalmPrefab-mesh[0-2])$/;
/* Instances dropped, by name. `-mesh` is what the exporter made of
   "PalmPrefab-mesh0" when it split the name; `trunk` covers both halves of
   every shipped roadside palm, the frond cluster included - the exporter gave
   the crown instances the trunk's name too. */
const DROP_INST = /^(terrain_sunset|-mesh$|trunk$)/;
/* ...and the meshes that must survive being un-instanced, because the palm
   emitter reads their geometry directly out of the buffer. */
const KEEP = new Set(['trunk', 'palms']);

const man = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const bin = fs.readFileSync(BIN_PATH);
const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const STRIDE = man.vertexStride;                 // in floats
const verts = new Float32Array(ab, 0, man.vertexBytes / 4);
const idx = new Uint32Array(ab, man.vertexBytes, man.indexBytes / 4);

const LISTS = ['world', 'road', 'car'];
const srcMeshCount = man.meshes.length;

// ---------------------------------------------------------------- select ---

const keptInst = {};
let droppedInst = 0;
for (const key of LISTS) {
  keptInst[key] = (man[key] || []).filter((i) => {
    const drop = DROP_INST.test(i.name || '');
    if (drop) droppedInst++;
    return !drop;
  });
}

/* A mesh survives if it is named in KEEP or if a surviving instance points at
   it - and never if it is named in DROP_MESH, which is the whole point. */
const used = new Set();
for (const key of LISTS) for (const i of keptInst[key]) used.add(i.mesh);

const keep = [];
man.meshes.forEach((m, i) => {
  if (DROP_MESH.test(m.name)) return;
  if (KEEP.has(m.name) || used.has(i)) keep.push(i);
});

/* Nothing is dropped silently. Two of the ten are neither in DROP_MESH nor
   orphaned by this tool - the dashboard and its three buttons were exported
   with the car and have never been instanced by anything, in any build - and a
   list is the only way that stays visible the next time somebody runs it. */
const kept = new Set(keep);
const gone = man.meshes
  .map((m, i) => ({ m, i }))
  .filter(({ i }) => !kept.has(i))
  .map(({ m, i }) => '  - ' + m.name.padEnd(26) + ' v' + String(m.vCount).padStart(6)
    + ' i' + String(m.iCount).padStart(7)
    + (DROP_MESH.test(m.name) ? '   named above' : '   nothing instances it'));

const remap = new Map();
keep.forEach((old, now) => remap.set(old, now));

for (const key of LISTS) {
  for (const i of keptInst[key]) {
    if (!remap.has(i.mesh)) {
      console.error('instance "' + i.name + '" points at dropped mesh '
        + man.meshes[i.mesh].name);
      process.exit(2);
    }
  }
}

// ------------------------------------------------------------- rebuild -----

/* Vertices and indices are copied mesh by mesh in the new order, so the two
   arrays come out contiguous with no holes and every index is rewritten by the
   shift its own mesh moved. Indices are stored globally - they address the one
   big buffer, not the mesh - so the shift is `newVOff - oldVOff`. */
let vTotal = 0, iTotal = 0;
for (const old of keep) { vTotal += man.meshes[old].vCount; iTotal += man.meshes[old].iCount; }

const outV = new Float32Array(vTotal * STRIDE);
const outI = new Uint32Array(iTotal);
const meshes = [];
let vAt = 0, iAt = 0;
for (const old of keep) {
  const m = man.meshes[old];
  outV.set(verts.subarray(m.vOff * STRIDE, (m.vOff + m.vCount) * STRIDE), vAt * STRIDE);
  const shift = vAt - m.vOff;
  for (let k = 0; k < m.iCount; k++) outI[iAt + k] = idx[m.iOff + k] + shift;
  meshes.push(Object.assign({}, m, { vOff: vAt, iOff: iAt }));
  vAt += m.vCount;
  iAt += m.iCount;
}

for (const key of LISTS) {
  for (const i of keptInst[key]) i.mesh = remap.get(i.mesh);
  man[key] = keptInst[key];
}
man.meshes = meshes;
man.vertexCount = vTotal;
man.indexCount = iTotal;
man.vertexBytes = vTotal * STRIDE * 4;
man.indexBytes = iTotal * 4;

/* Materials are left alone. They are a few kilobytes of JSON, they are
   addressed by index from the instances, and renumbering them to drop the two
   the palm forest used would be a second remapping for no measurable gain. */

// ---------------------------------------------------------------- report ---

const before = bin.length, after = man.vertexBytes + man.indexBytes;
const pct = (n) => (n * 100 / before).toFixed(1) + '%';
console.log('meshes    ' + meshes.length + ' kept, '
  + (srcMeshCount - meshes.length) + ' dropped');
console.log('instances ' + droppedInst + ' dropped');
for (const line of gone) console.log(line);
console.log('vertices  ' + man.vertexCount.toLocaleString()
  + '  (was ' + (verts.length / STRIDE).toLocaleString() + ')');
console.log('indices   ' + man.indexCount.toLocaleString()
  + '  (was ' + idx.length.toLocaleString() + ')');
console.log('scene.bin ' + (after / 1048576).toFixed(2) + ' MB'
  + '  (was ' + (before / 1048576).toFixed(2) + ' MB, '
  + pct(before - after) + ' saved)');

if (!WRITE) { console.log('\n--write to apply'); process.exit(0); }

// ----------------------------------------------------------------- write ---

/* Sanity, before anything is overwritten: every index must address a vertex
   that exists, and must stay inside the mesh that owns it. An off-by-one in
   the shift above would otherwise ship as a scene full of stray triangles
   stretching to the origin, which is a hard thing to trace back to here. */
for (const m of man.meshes) {
  for (let k = 0; k < m.iCount; k++) {
    const v = outI[m.iOff + k];
    if (v < m.vOff || v >= m.vOff + m.vCount) {
      console.error('mesh ' + m.name + ' index ' + k + ' -> ' + v + ' is outside ['
        + m.vOff + ',' + (m.vOff + m.vCount) + ')');
      process.exit(2);
    }
  }
}

const out = Buffer.alloc(man.vertexBytes + man.indexBytes);
Buffer.from(outV.buffer, 0, man.vertexBytes).copy(out, 0);
Buffer.from(outI.buffer, 0, man.indexBytes).copy(out, man.vertexBytes);
fs.writeFileSync(BIN_PATH, out);
fs.writeFileSync(JSON_PATH, JSON.stringify(man));
console.log('\nwritten. re-run tools/pack.js to fold it into the pack.');
