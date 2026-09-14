#!/usr/bin/env node
/* Build SYNX into a single self-contained executable.
 *
 *     node tools/build.js                 the game
 *     node tools/build.js --test          ...and the Rust unit tests
 *     node tools/build.js --check         ...and the static checkers
 *     node tools/build.js --smoke         ...and the whole game in a browser
 *     node tools/build.js --all           test + check + smoke
 *     node tools/build.js --bundle        ...and an installer
 *     node tools/build.js --run           ...and launch it when it is done
 *
 * TWO ARTEFACTS, IN THIS ORDER, because the first goes inside the second:
 *
 *   1. crates/synx-core  ->  web/wasm/synx_core.wasm
 *      The simulation core: course generation, world meshing, the four-wheel
 *      solver, the rival's racing line and driver.
 *
 *   2. src-tauri         ->  target/release/synx[.exe]
 *      The desktop host, with the whole of web/ - scripts, shaders, textures,
 *      audio, the scene and the .wasm above - compiled into it. There is
 *      nothing to install and no server to start first.
 *
 * WHY THIS IS JAVASCRIPT
 * ----------------------
 * It replaces build.ps1 and its build.cmd shim. Those were Windows-only: the
 * game itself is a web build wrapped in Tauri and has no such restriction, so
 * the one file standing between a Linux or macOS checkout and a working binary
 * was the build script. Everything else under tools/ is already Node, and Node
 * is already needed for the checkers and the smoke test, so this adds no
 * dependency that a contributor did not already have.
 *
 * The multiplayer server is a separate repository with its own tests and its
 * own deployment. Nothing here builds it.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const EXE = WIN ? 'synx.exe' : 'synx';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const ALL = has('all');
const WANT = {
  test: ALL || has('test'),
  check: ALL || has('check') || has('smoke'),
  smoke: ALL || has('smoke'),
  bundle: has('bundle'),
  run: has('run'),
};

if (has('help') || has('h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\* ?| ?\* ?/gm, ''));
  process.exit(0);
}

// ------------------------------------------------------------------ util ---

const C = process.stdout.isTTY
  ? { cyan: '\x1b[36m', green: '\x1b[32m', grey: '\x1b[90m', red: '\x1b[31m', off: '\x1b[0m' }
  : { cyan: '', green: '', grey: '', red: '', off: '' };

function step(msg) {
  console.log(`\n${C.cyan}=== ${msg} ===${C.off}`);
}

/* Run a command, inheriting stdio, and stop the build if it fails.
 *
 * NO `shell: true`. It is tempting on Windows - cargo looks like it wants a
 * shell - and it is wrong: with a shell, spawnSync joins the argument array
 * into a single command line and the shell splits it again on whitespace, so
 * any path containing a space arrives as two arguments. This checkout lives
 * under a user directory with a space in it, and the symptom was mkcourse
 * being handed half a path and reporting that the file did not exist.
 *
 * Without a shell every element of `args` is passed through as exactly one
 * argument whatever is inside it, and cargo resolves off PATH regardless. */
function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) fail(`${what}: ${r.error.message}`);
  if (r.status !== 0) fail(`${what} failed (exit ${r.status})`);
}

function fail(msg) {
  console.error(`\n${C.red}build failed: ${msg}${C.off}`);
  process.exit(1);
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ----------------------------------------------------- 1. the WASM core ---

step('Simulation core -> WebAssembly');
run('cargo', ['build', '-p', 'synx-core', '--release', '--target', 'wasm32-unknown-unknown'],
  'core build');

const wasmOut = path.join(ROOT, 'web', 'wasm');
fs.mkdirSync(wasmOut, { recursive: true });
const wasmSrc = path.join(ROOT, 'target', 'wasm32-unknown-unknown', 'release', 'synx_core.wasm');
if (!fs.existsSync(wasmSrc)) fail(`cargo reported success but ${wasmSrc} is not there`);
fs.copyFileSync(wasmSrc, path.join(wasmOut, 'synx_core.wasm'));
console.log(`  synx_core.wasm  ${fs.statSync(wasmSrc).size.toLocaleString()} bytes`);

// -------------------------------------------------- 2. the course asset ---

/* The road the multiplayer server validates against, emitted by the game's own
   course generator so the two cannot drift apart. Cheap, and re-run every
   build rather than remembered, because a stale one is a server that refuses
   legitimate positions on whichever corner changed. */
step('Course asset');
const course = path.join(ROOT, 'target', 'course.bin');
run('cargo', ['run', '-q', '-p', 'synx-core', '--release', '--bin', 'mkcourse', '--',
  path.join(ROOT, 'web', 'data', 'scene.json'), course], 'course asset');

/* The server is a separate repository and may not be checked out at all, so
   the asset lands in this one's target/ first. When the server IS here it is
   copied across as a convenience - it is committed there on purpose, so the
   server can deploy without the game beside it. */
const serverAssets = path.join(ROOT, 'synx-server', 'synx-server', 'assets');
if (fs.existsSync(serverAssets)) {
  fs.copyFileSync(course, path.join(serverAssets, 'course.bin'));
  console.log(`${C.grey}  copied into the server checkout; commit it there when the road changes${C.off}`);
} else {
  console.log(`${C.grey}  no server checkout here; course.bin left in target/${C.off}`);
}

// ------------------------------------------------------------ 3. checks ---

if (WANT.test) {
  step('Rust unit tests');
  run('cargo', ['test', '-p', 'synx-core', '--release'], 'core unit tests');
  run('cargo', ['test', '-p', 'synx-net', '--release'], 'wire format unit tests');
}

if (WANT.check) {
  step('Rival driving: all routes, free roam and Chapter 7');
  run(process.execPath, ['tools/checkai.js', '--suite'], 'rival driving checks');
  /* The game and the server carry their own copies of the wire protocol,
     because the server has to be cloneable and buildable on its own. The
     fingerprint in the handshake catches a change to the format's SHAPE at
     runtime; this catches everything else - a bounds check tightened on one
     side, a decoder fixed in one copy and not the other.

     It is SKIPPED rather than failed when the server is not checked out.
     This repository is meant to build on its own; making a cross-repository
     check mandatory would mean it does not. */
  if (fs.existsSync(path.join(ROOT, 'synx-server', 'protocol'))) {
    step('Wire protocol copies');
    run(process.execPath, ['tools/checkprotocol.js'], 'protocol comparison');
  } else {
    step('Wire protocol copies');
    console.log(`${C.grey}  no server checkout beside this one; skipped${C.off}`);
  }

  /* The reconstruction kernel, against known inputs with known answers.
     See the note at the top of that file: it caught two real defects in the
     first version of the shader it mirrors. */
  /* The settings schema against the code that reads it. See the note at the
     top of that file: a setting that silently does nothing is invisible in
     every screenshot and in every log, and one shipped that way. */
  step('Settings schema');
  run(process.execPath, ['tools/checksettings.js'], 'settings schema check');

  step('Upscaler kernel');
  run(process.execPath, ['tools/checkupscale.js'], 'upscaler kernel check');

  step('Shader literals');
  run(process.execPath, ['tools/checkshaders.js'], 'shader literal check');

  /* Every getElementById in the scripts against every id in the document.
     This exists because a dangling lookup is the one class of JS bug that
     loads clean, runs clean, and then throws in the middle of a state
     transition. */
  step('DOM lookups');
  run(process.execPath, ['tools/checkdom.js'], 'DOM lookup check');

  /* The campaign, walked down both paths without driving any of it: every
     line, every portrait it names, every branch, both endings, and the state
     machine that plays them. A story defect loads clean and runs clean in
     exactly the way a dangling DOM lookup does - the difference is that it is
     six chapters in before anybody sees it. */
  step('story');
  run(process.execPath, ['tools/checkstory.js'], 'campaign and branch check');

  /* THE RAMPS, WHICH EXIST THREE TIMES OVER: a row in the table, a window on
     the solver, and geometry somebody builds. Nothing makes those agree, and
     when they stop agreeing a car launches off a surface that is not where it
     is drawn - which was reported as ghost ramps the cars were jumping
     through, and which no test then in the suite could have caught. */
  step('ramps');
  run(process.execPath, ['tools/checkramps.js'], 'ramp geometry and arming check');
}

if (WANT.smoke) {
  /* Every band on the title and options screens, against every other band.
     "Nothing is drawn through anything else" is arithmetic, not a matter of
     opinion, and it is not something a screenshot of one page can prove. */
  step('Interface layout');
  run(process.execPath, ['tools/smoke.js', '--seconds', '26', '--route', '0',
    '--preset', '0', '--probe', 'layout'], 'interface layout');

  /* What one chapter may leave behind for the next, and whether Chapter 7's
     boss is still beatable by the thing that is supposed to beat him. Both
     are invisible from a screenshot: the game runs and reports nothing. */
  step('Director leaks');
  run(process.execPath, ['tools/smoke.js', '--seconds', '16', '--route', '0',
    '--preset', '0', '--probe', 'director'], 'director leak check');

  step('Chapter 7 balance');
  run(process.execPath, ['tools/smoke.js', '--seconds', '16', '--route', '6',
    '--preset', '0', '--probe', 'predator'], 'predator balance');

  step('Options and key bindings');
  run(process.execPath, ['tools/smoke.js', '--seconds', '50', '--route', '0',
    '--preset', '0', '--probe', 'options'], 'options screen');

  /* The three selection screens. They are ordinary DOM panels, so nothing in
     the racing smoke runs ever opens one - which is how the mode terminal
     shipped with no way back to the title except ESC. */
  /* The launcher is a document of its own, with its own script and its own
     markup, and nothing in the game ever navigates to it - so without this
     it has no coverage at all. */
  /* The launcher IN THE REAL HOST: it opens the release binary, presses PLAY
     and checks the window becomes the game. The browser cannot test that
     half, and that half is the one that was broken. */
  step('Launcher — desktop host');
  run(process.execPath, ['tools/checklauncher.js'], 'desktop launcher check');

  step('Launcher');
  run(process.execPath, ['tools/smoke.js', '--page', 'launcher.html', '--seconds', '12'],
    'launcher screen');

  step('Selection screens');
  for (const hold of ['modes', 'freeroam', 'multiplayer', 'confirm']) {
    run(process.execPath, ['tools/smoke.js', '--seconds', '14', '--preset', '0',
      '--hold', hold], `${hold} screen`);
  }

  step('Smoke test (the whole game, in a real browser)');
  run(process.execPath, ['tools/smoke.js', '--seconds', '70', '--route', '0', '--preset', '2'],
    'route 0 smoke test');
  run(process.execPath, ['tools/smoke.js', '--seconds', '95', '--route', '6', '--preset', '2'],
    'Chapter 7 smoke test');
}

// ------------------------------------------------------ 4. the host exe ---

step('Desktop host');
run('cargo', ['build', '-p', 'synx', '--release'], 'host build');

const exe = path.join(ROOT, 'target', 'release', EXE);
if (!fs.existsSync(exe)) fail(`cargo reported success but ${exe} is not there`);
console.log(`\n${C.green}  ${EXE}  ${mb(fs.statSync(exe).size)}  ${exe}${C.off}`);

// --------------------------------------------------------- 5. installer ---

if (WANT.bundle) {
  step('Installer');
  const r = spawnSync('cargo', ['tauri', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.log(`\x1b[33m  cargo-tauri is not installed; the executable above is already self-contained.${C.off}`);
  }
}

if (WANT.run) {
  step('Launching');
  spawnSync(exe, [], { cwd: ROOT, stdio: 'inherit' });
}
