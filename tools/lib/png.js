'use strict';
/* ---------------------------------------------------------------------------
 * PNG, WITHOUT A DEPENDENCY.
 *
 * A reader, and a writer that searches the filter per row. It lived inside
 * tools/shrinkpng.js, which is where it was written and which is still its
 * biggest customer - but three tools need it now and a second copy of a codec
 * is a second place for a bug in one of them:
 *
 *   shrinkpng   re-encodes every sheet in assets-src, losslessly
 *   trimatlas   erases sprites nothing draws, then writes the sheet back
 *   gentex      generates the carbon, flake and glass sheets from scratch
 *
 * gentex is the one that gains something by moving. It wrote its own PNGs with
 * filter 0 on every row, because that is the version of the format you can
 * write in twenty lines; going through the same encoder as the other two puts
 * its output through the per-row filter search as well, and a generated normal
 * map is exactly the kind of sheet that search is good at.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No palette reduction, no bit-depth
 * reduction, no dropping an alpha channel that happens to be opaque, no
 * quantisation. All of those change pixels or change what a shader can sample.
 * ------------------------------------------------------------------------- */
const zlib = require('zlib');

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

/* Build an image from raw samples, for a caller that has no source PNG to
   start from. `ch` is 3 for RGB and 4 for RGBA; everything else the encoder
   needs is derived. */
function fromRaw(w, h, ch, pixels) {
  const ctype = ch === 4 ? 6 : ch === 3 ? 2 : ch === 1 ? 0 : -1;
  if (ctype < 0) throw new Error('unsupported channel count ' + ch);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = ctype;
  ihdr[10] = 0;         // deflate
  ihdr[11] = 0;         // adaptive filtering
  ihdr[12] = 0;         // no interlace
  const body = Buffer.isBuffer(pixels) ? pixels : Buffer.from(pixels.buffer || pixels);
  if (body.length < w * h * ch) throw new Error('short pixel buffer');
  return { w, h, ch, ctype, depth: 8, stride: w * ch, pixels: body,
    chunks: [{ type: 'IHDR', data: ihdr }] };
}

module.exports = { chunks, decode, encode, fromRaw, crc32 };
