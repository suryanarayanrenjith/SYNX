'use strict';
/* What every probe needs before it can ask the game anything.
 *
 * A probe MEASURES; tools/check.py decides whether the measurement is
 * acceptable. Nothing in here or in any probe beside it should contain a
 * threshold, a pass, or a failure - see tools/synx/jsprobe.py for why the
 * split is that way round.
 *
 * The shipped scripts are loaded into a `vm` context rather than required,
 * because they are browser scripts: they close over `window` and hang
 * themselves off a global `NR`. Giving them that global and nothing else is
 * what makes it possible to run the real simulation core, the real course
 * generator and the real directors with no browser and no renderer.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

function readWeb(rel) {
  return fs.readFileSync(path.join(ROOT, 'web', rel), 'utf8');
}

/** A context with the handful of globals the scripts touch at load time. */
function context(extra) {
  const ctx = vm.createContext(Object.assign({
    console, WebAssembly, TextDecoder, TextEncoder, URL, performance,
    setTimeout, setImmediate, clearTimeout,
    fetch: async (url) => {
      const file = path.join(ROOT, 'web/wasm', path.basename(String(url || 'synx_core.wasm')));
      if (!fs.existsSync(file)) return { ok: false, status: 404 };
      const buf = fs.readFileSync(file);
      return new Response(buf, { headers: { 'Content-Type': 'application/wasm' } });
    },
  }, extra || {}));
  ctx.window = ctx;
  ctx.global = ctx;
  ctx.document = {
    body: null,
    createElement: () => ({ getContext: () => null, style: {}, click() {} }),
  };
  return ctx;
}

/** Load web/js/<name>.js into a context, in order. */
function load(ctx, names) {
  for (const n of names) {
    vm.runInContext(readWeb('js/' + n + '.js'), ctx, { filename: 'web/js/' + n + '.js' });
  }
  return ctx;
}

/** The usual arrangement: the wasm bridge, then the world scripts. */
function world(extra) {
  const ctx = context(extra);
  load(ctx, ['wasm', 'gl', 'settings', 'game', 'chapters']);
  return ctx;
}

const scene = () => JSON.parse(readWeb('data/scene.json'));

/* --------------------------------------------------------------- output --- */

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node tools/probes/probe.js <out-dir> <name> [args]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

/** What tools/check.py asked for, if it asked for anything.
 *
 * The side with the opinions names the points it wants measured, so that a
 * probe never quietly owns half of a test by choosing the grid. */
function request() {
  const f = path.join(OUT, 'request.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

/** The report tools/check.py reads. One per run, written last. */
function report(obj) {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(obj));
}

/** A blob too large to be JSON - a vertex buffer, say - beside the report. */
function blob(name, typedArray) {
  const b = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  fs.writeFileSync(path.join(OUT, name), b);
  /* The element type travels with it. An index buffer is a Uint16Array or a
     Uint32Array depending on how many vertices the mesh came to, and a reader
     that guesses gets a hall made of noise. */
  return { file: name, count: typedArray.length,
    type: typedArray.constructor.name, bytes: typedArray.byteLength };
}

/** Wrap an async probe so a throw becomes a readable exit rather than a hang. */
function main(fn) {
  Promise.resolve()
    .then(fn)
    .catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = { ROOT, OUT, readWeb, context, load, world, scene, request,
  report, blob, main, vm, fs, path };
