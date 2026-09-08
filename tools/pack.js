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
   which is the path the game already used, so no call site had to change.

   WHAT IS DELIBERATELY ABSENT is documented below the list, because "why is
   this not packed" is the question somebody will have, and an empty space
   answers it badly. */
const DIRS = [
  { src: 'textures', as: 'assets/textures' },
  { src: 'audio', as: 'assets/audio' },
  { src: 'audio/radio', as: 'assets/audio/radio' },
  { src: 'sprites', as: 'sprites' },
  { src: 'models', as: 'assets/models' },
];

/* Paths an OLDER pack may contain that this build no longer produces. They are
   recognised so `--unpack` and `--check` can say what they are looking at
   instead of failing on them: a pack written before the fonts and the scene
   came out is still a valid pack, and a tool that crashes on one is a tool
   that cannot be used to inspect the thing it is complaining about. */
const RETIRED = {
  'assets/fonts/': 'the launcher needs these loose; see web/fonts and css/launcher.css',
  'data/': 'scene.bin and scene.json ship loose; see the note below',
};

/* THE FONTS ARE NOT IN HERE, and they were.

     `web/fonts/` has to exist as loose files whatever this archive contains,
     because launcher.html is a document of its own that opens BEFORE the pack
     is loaded and declares the faces in launcher.css by relative path. Packing
     them as well shipped both copies inside the executable for no gain: the
     game now installs the same two loose files, which the host serves from the
     same place the launcher already got them from. */
  /* THE SCENE IS NOT IN HERE EITHER, for the same reason and a bigger number.

     What follows is the note from when it was, and the reasoning was sound at
     the time - it just stopped applying. `web/data/scene.{bin,json}` cannot
     leave the tree: `mkcourse` reads the manifest at build time, `trimscene`
     rewrites both, and the loader falls back to fetching them for a checkout
     with no pack. So packing them put a SECOND copy of the same bytes inside
     the executable.

     It used to be eleven megabytes and the zero-copy load was worth having
     twice. tools/trimscene.js took it to two, and two megabytes of duplication
     costs more than one extra request saves. The loader's fetch path is not a
     fallback nobody runs - it is what every browser session already used.

     The old note follows, because the trade-off it describes is real and would
     come back if the scene ever grew again:

     The scene itself. It is eleven megabytes of vertex data and a manifest,
     and it was the last thing still being fetched separately. `Pak.buffer`
     hands it over as a view on bytes that are already in memory, so putting it
     here removes a request AND a copy rather than adding one. */

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

/** Why an entry has no source directory, if it is one this build retired. */
function retiredReason(rel) {
  for (const k of Object.keys(RETIRED)) if (rel.indexOf(k) === 0) return RETIRED[k];
  return null;
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
  let skipped = 0;
  for (const e of toc) {
    const d = dirFor(e.n);
    if (!d) {
      const why = retiredReason(e.n);
      console.log('  skipped ' + e.n + (why ? '  (' + why + ')' : '  (no source directory)'));
      skipped++;
      continue;
    }
    const dest = path.join(SRC, d.src, path.basename(e.n));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf.slice(base + e.o, base + e.o + e.l));
    n++;
  }
  console.log('unpacked ' + n + ' files -> ' + path.relative(ROOT, SRC)
    + (skipped ? '  (' + skipped + ' retired entr' + (skipped === 1 ? 'y' : 'ies') + ' left alone)' : ''));
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
  let unchecked = 0;
  for (const e of back) {
    const d = dirFor(e.n);
    /* An entry with no source directory cannot be compared against one. That
       used to throw here - `d.src` on undefined - which turned "this pack has
       an entry I retired" into a stack trace. */
    if (!d) { unchecked++; continue; }
    const srcPath = path.join(SRC, d.src, path.basename(e.n));
    if (!fs.existsSync(srcPath)) { console.error('  MISSING SOURCE ' + e.n); bad++; continue; }
    const got = buf.slice(base + e.o, base + e.o + e.l);
    if (!got.equals(fs.readFileSync(srcPath))) { console.error('  MISMATCH ' + e.n); bad++; }
  }
  if (unchecked) console.log('  ' + unchecked + ' entry/entries had no source to compare against');
  console.log(bad ? '  ' + bad + ' ENTRIES CORRUPT'
                  : '  verified: all ' + back.length + ' entries match their source byte for byte');
  if (bad) process.exit(1);
}
