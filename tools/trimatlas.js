#!/usr/bin/env node
'use strict';
/* ---------------------------------------------------------------------------
 * THE SPRITES NOTHING DRAWS ANY MORE.
 *
 *     node tools/trimatlas.js            report what is dead and what it costs
 *     node tools/trimatlas.js --write    erase it and drop it from game_data
 *
 * WHY THIS IS NOT `rm`
 * --------------------
 * A sprite is not a file. `speed`, `boost_bar`, `boost_bar_border` and `turbo`
 * are RECTANGLES inside two shipped atlas sheets that also carry the countdown
 * numerals, the chequered flag and the chase meter - so the sheets have to
 * stay, and the only thing that can be got back is the AREA.
 *
 * Getting it back is worth doing. A dead rectangle is not free: it is
 * photographic data sitting in the middle of a PNG's deflate stream, and
 * GUI_HUD_Console is a 4096x2048 sheet of which a sixth is things this build
 * replaced with drawn instruments. Erased to transparent black it compresses
 * to almost nothing, and the sheet the game ships gets smaller by the whole of
 * it. Nothing else about the file changes: same dimensions, same colour type,
 * every surviving rectangle byte for byte where it was.
 *
 * WHAT IS DEAD IS DERIVED, NOT LISTED
 * -----------------------------------
 * The live set is read out of js/hud.js - every literal name handed to
 * `placeSprite`, `placeSpriteTinted`, `sprite` and `spriteAt`, plus the widget
 * names those resolve through in data/game_data.js. A hard-coded list of dead
 * sprites would be a list that is wrong the first time somebody draws one
 * again, and the failure would be a hole in a sheet rather than an error.
 *
 * The one thing a reader cannot see is a name built by concatenation, so those
 * are declared below WITH A REASON. An exception nobody wrote down is a hole.
 * ------------------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');
const { decode, encode } = require('./lib/png.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets-src');
const WRITE = process.argv.includes('--write');

/* Names the source builds rather than writes. Each one needs a reason. */
const BUILT_AT_RUNTIME = {
  countdown_1: "js/hud.js draws 'countdown_' + n for the three lights",
  countdown_2: "js/hud.js draws 'countdown_' + n for the three lights",
  countdown_3: "js/hud.js draws 'countdown_' + n for the three lights",
};

/* ------------------------------------------------------------ the tables -- */
const gdPath = path.join(ROOT, 'web/data/game_data.js');
global.window = {};
require(gdPath);
const gd = global.window.NR_GAME;
const hud = fs.readFileSync(path.join(ROOT, 'web/js/hud.js'), 'utf8');

/** Every literal the HUD hands to one of the four sprite calls. */
const asked = new Set();
for (const re of [/placeSprite\(\s*'([^']+)'/g, /placeSpriteTinted\(\s*'([^']+)'/g,
  /\bsprite\(\s*'([^']+)'/g, /spriteAt\(\s*'([^']+)'/g]) {
  let m;
  while ((m = re.exec(hud))) asked.add(m[1]);
}
/* `placeSprite` takes a WIDGET name, which resolves to wgt.sprite through the
   shipped layout - so the widget names have to be mapped across. */
const widgetSprite = {};
for (const w of gd.hud || []) if (w.sprite) widgetSprite[w.name] = w.sprite;

const live = new Set(Object.keys(BUILT_AT_RUNTIME));
for (const a of asked) {
  live.add(a);
  if (widgetSprite[a]) live.add(widgetSprite[a]);
}

/* ------------------------------------------------------------- the sweep -- */
let bytesBefore = 0, bytesAfter = 0, deadCount = 0, deadPx = 0;
const dropped = {};      // atlas key -> [sprite names]

for (const key of Object.keys(gd.atlas || {})) {
  const atlas = gd.atlas[key];
  const file = atlas.texture ? atlas.texture + '.png' : null;
  if (!file) continue;
  const p = path.join(SRC, 'textures', file);
  if (!fs.existsSync(p)) {
    console.log('  skip  ' + file + '  (not in assets-src; run tools/pack.js --unpack)');
    continue;
  }

  const dead = Object.keys(atlas.sprites).filter((n) => !live.has(n));
  const src = fs.readFileSync(p);
  bytesBefore += src.length;
  console.log('\n== ' + key + '  ' + file + '  ' + (src.length / 1024).toFixed(0) + ' KB');
  if (!dead.length) {
    console.log('   every sprite on this sheet is still drawn');
    bytesAfter += src.length;
    continue;
  }

  const im = decode(src);
  let px = 0;
  for (const n of dead) {
    const [x, y, w, h] = atlas.sprites[n];
    console.log('   DEAD  ' + n.padEnd(20) + ' ' + w + 'x' + h
      + ' at ' + x + ',' + y + '   ' + ((w * h) / 1000).toFixed(0) + ' kpx');
    /* Erased to zero rather than to a colour: an all-zero run is the single
       cheapest thing deflate can encode, and transparent black cannot bleed
       into a neighbouring sprite through bilinear filtering the way an opaque
       fill would. */
    for (let row = Math.max(0, y); row < Math.min(im.h, y + h); row++) {
      const at = row * im.stride + Math.max(0, x) * im.ch;
      const end = row * im.stride + Math.min(im.w, x + w) * im.ch;
      if (end > at) im.pixels.fill(0, at, end);
    }
    px += w * h;
  }
  deadCount += dead.length;
  deadPx += px;
  dropped[key] = dead;

  const out = encode(im);
  /* The same proof tools/shrinkpng.js takes: decode what is about to be
     written and check the surviving pixels are the ones that were read. */
  const back = decode(out);
  if (back.w !== im.w || back.h !== im.h || back.ctype !== im.ctype
      || !back.pixels.equals(im.pixels)) {
    throw new Error(file + ': the round trip changed the pixels');
  }
  const save = src.length - out.length;
  console.log('   ' + (src.length / 1024).toFixed(0) + ' KB -> ' + (out.length / 1024).toFixed(0)
    + ' KB   (' + (save >= 0 ? '-' : '+') + Math.abs(save / 1024).toFixed(0) + ' KB, '
    + (save * 100 / src.length).toFixed(1) + '%)');
  bytesAfter += out.length;
  if (WRITE) fs.writeFileSync(p, out);
}

/* ------------------------------------------ and out of the lookup table --- */
/* A rectangle that has been erased must stop being ADDRESSABLE, or a later
   edit can point something at a hole and see nothing at all - which is the
   hardest kind of missing art to trace, because everything about the draw
   succeeds. */
if (deadCount) {
  let gdSrc = fs.readFileSync(gdPath, 'utf8');
  const data = JSON.parse(gdSrc.slice(gdSrc.indexOf('{'), gdSrc.lastIndexOf('}') + 1));
  let removed = 0;
  for (const key of Object.keys(dropped)) {
    for (const n of dropped[key]) {
      if (data.atlas[key] && data.atlas[key].sprites[n]) {
        delete data.atlas[key].sprites[n];
        removed++;
      }
    }
  }
  const head = gdSrc.slice(0, gdSrc.indexOf('{'));
  const tail = gdSrc.slice(gdSrc.lastIndexOf('}') + 1);
  const next = head + JSON.stringify(data) + tail;
  console.log('\n' + removed + ' sprite(s) dropped from data/game_data.js');
  if (WRITE) fs.writeFileSync(gdPath, next);
}

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('\n' + deadCount + ' dead sprite(s), ' + (deadPx / 1000).toFixed(0) + ' kpx of sheet');
console.log(kb(bytesBefore) + ' -> ' + kb(bytesAfter)
  + '   (' + kb(bytesBefore - bytesAfter) + ' saved)');
if (!WRITE) console.log('\n--write to apply, then re-run tools/pack.js');
