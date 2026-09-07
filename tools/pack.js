/* Build web/data/synx.pak — every asset the game ships, in one file.
 *
 *     node tools/pack.js            build from assets-src/
 *     node tools/pack.js --check    ...and verify every entry reads back
 *     node tools/pack.js --list     show what is in the existing pack
 *     node tools/pack.js --unpack   extract the pack back to assets-src/
 *
 * WHY
 * ---
 * The game shipped as ninety-eight loose asset files. Inside the desktop host
 * each one is a separate request against Tauri's protocol, and a request has a
 * fixed cost that has nothing to do with how big the thing is - so a hundred
 * small ones cost more than a single large one carrying the same bytes. One
 * file is also simply tidier: the asset tree is one artefact to copy, hash or
 * diff instead of a hundred.
 *
 * THE PACK IS THE SOURCE OF TRUTH
 * -------------------------------
 * `assets-src/` is not shipped and does not need to exist. `--unpack` writes
 * it back out of the pack, byte for byte, so the workflow for changing an
 * asset is: unpack, edit, pack. That is why `--unpack` is here rather than
 * being a thing you would write a script for when you needed it.
 *
 * FORMAT
 * ------
 *     magic    "SYNXPAK1"            8 bytes
 *     tocLen   uint32 little-endian  4 bytes
 *     toc      UTF-8 JSON            tocLen bytes
 *     data     the files, end to end
 *
 * The table of contents is JSON because it is read exactly once, it is a few
 * kilobytes, and being able to `head -c 8000 synx.pak` and see what is in
 * there is worth more than the bytes a packed table would save.
 *
 * NOT COMPRESSED, deliberately. Almost every entry is already a PNG, a JPEG or
 * an Ogg, and running deflate over those costs load-time CPU to make the file
 * marginally larger. What the pack is for is the number of files, not their
 * size. (scene.bin is the one exception and it is left alone too, because it
 * is read straight into a typed array and inflating it would mean a second
 * copy of eleven megabytes at load.)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const SRC = path.join(ROOT, 'assets-src');
const OUT = path.join(WEB, 'data', 'synx.pak');

/* What goes in, and the path each entry is addressed by inside the archive -
   which is the path the game already used, so no call site had to change. */
const DIRS = [
  { src: 'textures', as: 'assets/textures' },
  { src: 'audio', as: 'assets/audio' },
  { src: 'audio/radio', as: 'assets/audio/radio' },
  { src: 'sprites', as: 'sprites' },
  { src: 'fonts', as: 'assets/fonts' },
  /* The scene itself. It is eleven megabytes of vertex data and a manifest,
     and it was the last thing still being fetched separately. `Pak.buffer`
     hands it over as a view on bytes that are already in memory, so putting it
     here removes a request AND a copy rather than adding one. */
  { src: 'data', as: 'data' },
];

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
};

function collect() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(SRC, d.src);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) {
      const p = path.join(abs, name);
      if (!fs.statSync(p).isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (!MIME[ext]) continue;
      out.push({ rel: d.as + '/' + name, abs: p, ext });
    }
  }
  return out;
}

/** The longest matching prefix, so `assets/audio/radio` beats `assets/audio`. */
function dirFor(rel) {
  return DIRS.filter(d => rel.indexOf(d.as + '/') === 0)
             .sort((a, b) => b.as.length - a.as.length)[0];
}

function readPack() {
  const buf = fs.readFileSync(OUT);
  if (buf.slice(0, 8).toString('ascii') !== 'SYNXPAK1') throw new Error('bad magic');
  const tl = buf.readUInt32LE(8);
  const toc = JSON.parse(buf.slice(12, 12 + tl).toString('utf8'));
  return { buf, toc, base: 12 + tl };
}

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

// --------------------------------------------------------------- listing ---
if (process.argv.includes('--list')) {
  const { toc, buf } = readPack();
  for (const e of toc) {
    console.log('  ' + String(e.l).padStart(9) + '  ' + e.n);
  }
  console.log(toc.length + ' entries, ' + mb(buf.length));
  process.exit(0);
}

// -------------------------------------------------------------- unpacking ---
if (process.argv.includes('--unpack')) {
  const { buf, toc, base } = readPack();
  let n = 0;
  for (const e of toc) {
    const d = dirFor(e.n);
    if (!d) { console.error('  no source directory for ' + e.n); continue; }
    const dest = path.join(SRC, d.src, path.basename(e.n));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf.slice(base + e.o, base + e.o + e.l));
    n++;
  }
  console.log('unpacked ' + n + ' files -> ' + path.relative(ROOT, SRC));
  process.exit(0);
}

// --------------------------------------------------------------- building ---
const files = collect();
if (!files.length) {
  console.error('No assets in ' + path.relative(ROOT, SRC) + '.');
  console.error('The pack is the source of truth; run `node tools/pack.js --unpack` first.');
  process.exit(1);
}

const toc = [];
const chunks = [];
let offset = 0;
for (const f of files) {
  const buf = fs.readFileSync(f.abs);
  toc.push({ n: f.rel, o: offset, l: buf.length, t: MIME[f.ext] });
  chunks.push(buf);
  offset += buf.length;
}

const tocJson = Buffer.from(JSON.stringify(toc), 'utf8');
const header = Buffer.alloc(12);
header.write('SYNXPAK1', 0, 'ascii');
header.writeUInt32LE(tocJson.length, 8);

const pak = Buffer.concat([header, tocJson, ...chunks]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, pak);

console.log('packed ' + files.length + ' files -> ' + path.relative(ROOT, OUT));
console.log('  table of contents  ' + tocJson.length + ' bytes');
console.log('  data               ' + mb(offset));
console.log('  total              ' + mb(pak.length));

if (process.argv.includes('--check')) {
  /* Read it back the way the game will and prove every entry survives. The
     pack is the only copy the shipped build has; a packer that silently
     truncated one texture would not be found until somebody drove past it. */
  const { buf, toc: back, base } = readPack();
  let bad = 0;
  for (const e of back) {
    const got = buf.slice(base + e.o, base + e.o + e.l);
    const d = dirFor(e.n);
    const src = fs.readFileSync(path.join(SRC, d.src, path.basename(e.n)));
    if (!got.equals(src)) { console.error('  MISMATCH ' + e.n); bad++; }
  }
  console.log(bad ? '  ' + bad + ' ENTRIES CORRUPT'
                  : '  verified: all ' + back.length + ' entries match their source byte for byte');
  if (bad) process.exit(1);
}
