/* Are the game's and the server's copies of the wire protocol still the same?
 *
 *     node tools/checkprotocol.js
 *
 * WHY THERE ARE TWO COPIES
 * ------------------------
 * `crates/synx-net/` and `synx-server/protocol/` are the same crate, twice.
 * That is deliberate and it is not going away: `synx-server/` is a separate
 * repository that has to be cloneable and buildable on its own, by anybody who
 * wants to run their own grid. A shared path would mean the server could only
 * be built from inside a checkout of the game, which defeats the whole point of
 * publishing it.
 *
 * So the two are held together at RUNTIME instead, by `WIRE_FINGERPRINT` in the
 * handshake: a compile-time digest of the format's shape that both sides
 * compute and compare before a car is ever sent. A client whose copy has
 * drifted is refused with "update the game" rather than admitted to a race it
 * would experience as cars sliding through barriers.
 *
 * WHY THAT IS NOT QUITE ENOUGH, WHICH IS WHY THIS EXISTS
 * -----------------------------------------------------
 * The fingerprint covers everything that decides what a byte MEANS - opcodes,
 * field widths, flag bits, quantisation scales. It does not cover anything
 * else: a bounds check tightened on one side only, a decoder that rejects a
 * frame the other still sends, a bug fixed in one copy and not the other. Those
 * pass the handshake and fail later, in a way that looks like a bug in whatever
 * happened to be running at the time.
 *
 * `diff` cannot answer this on its own, because the two copies have different
 * line endings and so differ on every line. This normalises those and compares
 * what is actually there.
 *
 * Run it before shipping either half. If it reports drift, the fix is to decide
 * which copy is right and make the other match it - not to edit one and hope.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GAME = path.join(ROOT, 'crates', 'synx-net');
const SERVER = path.join(ROOT, 'synx-server', 'protocol');

/* Read a file with its line endings normalised, so a copy checked out with
   CRLF compares equal to the same bytes with LF. Nothing else is normalised:
   a difference in whitespace inside a line is a real difference. */
function read(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function listSources(dir) {
  const src = path.join(dir, 'src');
  if (!fs.existsSync(src)) return null;
  return fs.readdirSync(src).filter(f => f.endsWith('.rs')).sort();
}

const gameFiles = listSources(GAME);
const serverFiles = listSources(SERVER);

if (!gameFiles || !serverFiles) {
  console.error('one of the two protocol crates is missing:');
  console.error('  ' + GAME + (gameFiles ? '' : '   <- not found'));
  console.error('  ' + SERVER + (serverFiles ? '' : '   <- not found'));
  process.exit(1);
}

const all = Array.from(new Set([...gameFiles, ...serverFiles])).sort();
const problems = [];
let same = 0;

for (const f of all) {
  const inGame = gameFiles.includes(f);
  const inServer = serverFiles.includes(f);
  if (!inGame) { problems.push(f + ': only in the server copy'); continue; }
  if (!inServer) { problems.push(f + ': only in the game copy'); continue; }

  const a = read(path.join(GAME, 'src', f));
  const b = read(path.join(SERVER, 'src', f));
  if (a === b) { same++; continue; }

  // Say WHERE, so the fix does not start with another diff.
  const la = a.split('\n');
  const lb = b.split('\n');
  let at = 0;
  while (at < la.length && at < lb.length && la[at] === lb[at]) at++;
  problems.push(
    f + ': differs from line ' + (at + 1) +
    '\n      game:   ' + JSON.stringify((la[at] || '(end of file)').trim().slice(0, 72)) +
    '\n      server: ' + JSON.stringify((lb[at] || '(end of file)').trim().slice(0, 72))
  );
}

/* The manifests too. The crate is renamed between the two - the game calls it
   synx-net, the server calls it synx-net as well - but the dependency lists and
   the feature set have to agree or the two builds are not the same crate in any
   useful sense. */
const manifestA = read(path.join(GAME, 'Cargo.toml'));
const manifestB = read(path.join(SERVER, 'Cargo.toml'));
if (manifestA !== manifestB) problems.push('Cargo.toml: the two manifests differ');

console.log('protocol: ' + same + ' of ' + all.length + ' source files identical');
console.log('  game   ' + path.relative(ROOT, GAME));
console.log('  server ' + path.relative(ROOT, SERVER));

if (problems.length) {
  console.error('\nthe two copies of the wire protocol have drifted:\n');
  for (const p of problems) console.error('  ' + p);
  console.error('\nThe fingerprint in the handshake will catch a change to the format\'s');
  console.error('shape, but not a change to a bounds check or a decoder. Make the two');
  console.error('copies match before shipping either half.');
  process.exit(1);
}

console.log('\nboth copies of the wire protocol agree');
