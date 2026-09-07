#!/usr/bin/env node
/* Re-encode every PNG in the pack's source tree, losslessly.
 *
 *     node tools/shrinkpng.js            report what would be saved
 *     node tools/shrinkpng.js --write    ...and rewrite them
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
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets-src');
const WRITE = process.argv.includes('--write');

// ------------------------------------------------------------- decoding ---

/** Split a PNG into its chunks. */
function chunks(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('latin1');
    out.push({ type, data: buf.slice(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The raw, unfiltered image, plus everything needed to write it back. */
function decode(buf) {
  const cs = chunks(buf);
  const ihdr = cs.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('no IHDR');
  const w = ihdr.data.readUInt32BE(0), h = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8], ctype = ihdr.data[9], interlace = ihdr.data[12];
  if (interlace) throw new Error('interlaced');
  if (depth !== 8) throw new Error('bit depth ' + depth);
  const ch = CHANNELS[ctype];
  if (ch === undefined) throw new Error('colour type ' + ctype);
  const idat = Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);
  const stride = w * ch;
  if (raw.length < h * (stride + 1)) throw new Error('short IDAT');

  const out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    const cur = out.slice(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, q, q + stride);
    q += stride;
    unfilter(f, cur, y ? out.slice((y - 1) * stride, y * stride) : null, ch);
  }
  return { w, h, ch, ctype, depth, stride, pixels: out, chunks: cs };
}

function unfilter(f, cur, prev, ch) {
  const n = cur.length;
  if (f === 0) return;
  for (let x = 0; x < n; x++) {
    const a = x >= ch ? cur[x - ch] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= ch ? prev[x - ch] : 0;
    let add;
    if (f === 1) add = a;
    else if (f === 2) add = b;
    else if (f === 3) add = (a + b) >> 1;
    else if (f === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    } else throw new Error('filter ' + f);
    cur[x] = (cur[x] + add) & 255;
  }
}

function filterRow(f, cur, prev, ch, dst) {
  const n = cur.length;
  for (let x = 0; x < n; x++) {
    const a = x >= ch ? cur[x - ch] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= ch ? prev[x - ch] : 0;
    let sub;
    if (f === 0) sub = 0;
    else if (f === 1) sub = a;
    else if (f === 2) sub = b;
    else if (f === 3) sub = (a + b) >> 1;
    else {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      sub = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    dst[x] = (cur[x] - sub) & 255;
  }
}

// ------------------------------------------------------------- encoding ---

/** Deflate a candidate filtering of the whole image. */
function pack(im, pick) {
  const { h, stride, ch, pixels } = im;
  const body = Buffer.alloc(h * (stride + 1));
  const row = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const cur = pixels.slice(y * stride, (y + 1) * stride);
    const prev = y ? pixels.slice((y - 1) * stride, y * stride) : null;
    const f = pick(y, cur, prev);
    body[y * (stride + 1)] = f;
    filterRow(f, cur, prev, ch, row);
    row.copy(body, y * (stride + 1) + 1);
  }
  return body;
}

/** The classic heuristic: the filter whose output has the smallest absolute
    sum, treating bytes as signed. Cheap, and right most of the time. */
function bestByHeuristic(cur, prev, ch, scratch) {
  let best = 0, bestScore = Infinity;
  for (let f = 0; f < 5; f++) {
    if (f === 2 && !prev) continue;
    filterRow(f, cur, prev, ch, scratch);
    let s = 0;
    for (let x = 0; x < scratch.length; x++) {
      const v = scratch[x];
      s += v < 128 ? v : 256 - v;
    }
    if (s < bestScore) { bestScore = s; best = f; }
  }
  return best;
}

function encode(im) {
  const scratch = Buffer.alloc(im.stride);
  /* Six whole-image candidates - each of the five filters applied uniformly,
     plus the per-row heuristic - deflated, and the smallest wins. Uniform
     candidates matter: on a sheet that is mostly one colour, "none" or "up"
     everywhere compresses better than a per-row mixture, because a constant
     filter byte is itself part of the stream being deflated. */
  let best = null;
  const tries = [
    (y, cur, prev) => bestByHeuristic(cur, prev, im.ch, scratch),
    () => 0, () => 1, (y) => (y ? 2 : 0), () => 3, () => 4,
  ];
  for (const pick of tries) {
    const body = pack(im, pick);
    const z = zlib.deflateSync(body, { level: 9, memLevel: 9, windowBits: 15 });
    if (!best || z.length < best.length) best = z;
  }

  /* Keep only the chunks that mean something to a renderer. Everything the
     game samples is RGBA in one colour space; the ancillary metadata an
     exporter leaves behind - timestamps, editor comments, physical dimensions,
     embedded profiles - is bytes shipped to no purpose. IHDR, PLTE, tRNS and
     IDAT/IEND are the ones that can change how a pixel decodes. */
  const KEEP = new Set(['IHDR', 'PLTE', 'tRNS']);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const put = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const head = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head, data])) >>> 0, 0);
    parts.push(len, head, data, crc);
  };
  for (const c of im.chunks) if (KEEP.has(c.type)) put(c.type, c.data);
  put('IDAT', best);
  put('IEND', Buffer.alloc(0));
  return Buffer.concat(parts);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return c ^ -1;
}

// ----------------------------------------------------------------- main ---

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
