#!/usr/bin/env node
/* Re-encode every PNG in the pack's source tree, losslessly.
 *
 *     node tools/shrinkpng.js            report what would be saved
 *     node tools/shrinkpng.js --write    ...and rewrite them
 *
 * The codec it does this with is tools/lib/png.js. The long note there is the
 * one that used to be here.
 *
 * WHY THIS IS NOT `oxipng`
 * ------------------------
 * Because a build that needs a tool nobody has installed is a build that does
 * not run. Everything under tools/ is Node, Node ships zlib, and a PNG is
 * zlib with a one-byte filter tag on the front of every row - which is the
 * entire format as far as file size is concerned. So the two things an
 * optimiser actually does are both reachable from here:
 *
 *   1. CHOOSE A BETTER FILTER PER ROW. Encoders overwhelmingly pick one filter
 *      for the whole image, or use the classic "minimum sum of absolute
 *      differences" heuristic on each row. Trying all five and keeping the one
 *      that genuinely deflates smallest is slower and strictly better.
 *      Doing it per row is what PNG was designed for and what most encoders
 *      skip.
 *
 *   2. DEFLATE HARDER. Level 9 with a 32K window, on one IDAT stream rather
 *      than the several most tools emit.
 *
 * PIXELS ARE NOT TOUCHED. Every output is decoded again and compared against
 * the input byte for byte before it is written; a mismatch is a hard failure,
 * not a warning. That is what makes this safe to run over the art without a
 * separate review of what it did to it - and it is why this is the only kind
 * of size saving worth taking on a game whose whole look is the texture work.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No palette reduction, no bit-depth reduction, no dropping an alpha channel
 * that happens to be opaque, no quantisation. All of those change pixels or
 * change what a shader can sample, and the sheets here are alpha-cut line art
 * and normal maps where both would be visible.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets-src');
const WRITE = process.argv.includes('--write');

/* The codec lives in tools/lib/png.js: three tools need it now - this one,
   trimatlas and gentex - and a second copy is a second place for a bug in one
   of them. What is left in this file is the sweep. */
const { decode, encode } = require('./lib/png.js');

if (!fs.existsSync(SRC)) {
  console.error('assets-src/ is not there. Run `node tools/pack.js --unpack` first.');
  process.exit(2);
}

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.png$/i.test(name)) files.push(p);
  }
})(SRC);
files.sort();

let before = 0, after = 0, changed = 0, skipped = 0;
for (const p of files) {
  const src = fs.readFileSync(p);
  before += src.length;
  let out;
  try {
    const im = decode(src);
    out = encode(im);
    /* THE PROOF. Decode what is about to be written and compare it, pixel for
       pixel, against what was read. An optimiser that is merely believed to be
       lossless is an optimiser that has not been checked. */
    const back = decode(out);
    if (back.w !== im.w || back.h !== im.h || back.ctype !== im.ctype
        || !back.pixels.equals(im.pixels)) {
      throw new Error('round trip changed the pixels');
    }
  } catch (e) {
    console.log('  skip  ' + path.relative(SRC, p) + '  (' + e.message + ')');
    after += src.length;
    skipped++;
    continue;
  }
  if (out.length < src.length) {
    const save = src.length - out.length;
    console.log('  ' + String(-save).padStart(9) + '  ' + path.relative(SRC, p)
      + '  (' + (save * 100 / src.length).toFixed(1) + '%)');
    after += out.length;
    changed++;
    if (WRITE) fs.writeFileSync(p, out);
  } else {
    after += src.length;
  }
}

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log('\n' + files.length + ' PNGs, ' + changed + ' smaller, ' + skipped + ' skipped');
console.log(mb(before) + ' -> ' + mb(after)
  + '   (' + ((before - after) / 1048576).toFixed(2) + ' MB saved, '
  + ((before - after) * 100 / before).toFixed(1) + '%)');
if (!WRITE) console.log('\n--write to apply, then re-run tools/pack.js');
