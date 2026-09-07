/* The settings schema, against the code that reads it.
 *
 *     node tools/checksettings.js
 *
 * WHY
 * ---
 * Settings are indices into lists of strings, stored in a file, edited by two
 * screens and applied by a third piece of code. Every join in that chain fails
 * silently: a wrong index is a legal value, a missing row makes a lookup
 * return `undefined`, and a lookup that returns `undefined` usually lands on a
 * sensible-looking fallback. Nothing throws, nothing looks wrong, and the
 * setting simply does not do anything.
 *
 * THIS IS NOT HYPOTHETICAL. When the graphics settings moved from the in-game
 * screen to the launcher, `optionOf` was still searching the rows that screen
 * DRAWS rather than the schema. It returned null for 'quality', the caller
 * fell back to `QUALITY.HIGH`, and every preset ran HIGH's passes - LOW
 * rendered shadows, reflections, volumetrics and a six-level bloom pyramid,
 * which is the exact opposite of what LOW is for. The game ran, drew, and
 * reported nothing. It took a probe printing the renderer's own flags to see.
 *
 * So the joins are checked here instead:
 *
 *   1. every row is well formed, and its default is a real index
 *   2. no two rows share a key
 *   3. every quality preset is reachable from the PRESET row, every option on
 *      that row is a preset that exists, and no two presets are identical
 *   4. every key the game READS by name is a row that exists, and every row is
 *      read by something
 *   5. the parallel tables - FPS_CAPS, RENDER_SCALES, HOST_KEYS - line up with
 *      the rows they belong to
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

/* The schema loads straight in. js/settings.js closes over
   `typeof window !== 'undefined' ? window : globalThis` precisely so a tool can
   require it as well as a page loading it - and evaluating source by hand is a
   habit worth not having even when the source is our own. */
require(path.join(WEB, 'js', 'settings.js'));
const S = globalThis.NR && globalThis.NR.Settings;
if (!S) {
  console.error('  settings.js did not define NR.Settings');
  process.exit(1);
}

let bad = 0;
const fail = (m) => { console.error('  ' + m); bad++; };
const ok = (m) => console.log('  ok   ' + m);

/* Rows whose options are built at run time from the machine - the monitor list
   and the window-size ladder - so a static default index cannot be checked
   against them. Listed rather than skipped by a rule, because an exception
   nobody wrote down is a hole. */
const RUNTIME_OPTS = new Set(['monitor', 'size']);

// ---------------------------------------------------------------- 1 and 2 --
{
  const seen = new Map();
  for (const r of S.ROWS) {
    if (!r.key) { fail('a row has no key'); continue; }
    if (seen.has(r.key)) fail('two rows share the key "' + r.key + '"');
    seen.set(r.key, r);
    if (!r.label) fail(r.key + ': no label');
    if (!r.hint) fail(r.key + ': no hint - a row whose cost is unexplained cannot be traded');
    if (r.where !== 'game' && r.where !== 'launcher') {
      fail(r.key + ': `where` is "' + r.where + '", which is neither screen');
    }
    if (typeof r.tab !== 'number') fail(r.key + ': no tab');
    if (RUNTIME_OPTS.has(r.key)) continue;
    if (!Array.isArray(r.opts) || !r.opts.length) { fail(r.key + ': no options'); continue; }
    if (typeof r.def !== 'number' || r.def < 0 || r.def >= r.opts.length) {
      fail(r.key + ': default ' + r.def + ' is outside its ' + r.opts.length + ' options');
    }
  }
  if (!bad) ok(S.ROWS.length + ' rows, all well formed and uniquely keyed');
}

// --------------------------------------------------------------------- 3 --
{
  const before = bad;
  const row = S.rowByKey('quality');
  if (!row) fail('there is no PRESET row');
  else {
    for (const name of row.opts) {
      if (!S.QUALITY[name]) fail('PRESET offers "' + name + '", which is not a quality preset');
    }
    for (const name of Object.keys(S.QUALITY)) {
      if (row.opts.indexOf(name) < 0) fail('quality preset "' + name + '" is unreachable from PRESET');
    }
    /* The presets must actually DIFFER. Four names for one configuration is
       what the bug above produced, and it would pass every other check here. */
    const sigs = new Map();
    for (const name of row.opts) {
      const sig = JSON.stringify(S.QUALITY[name]);
      if (sigs.has(sig)) fail('presets ' + sigs.get(sig) + ' and ' + name + ' are identical');
      sigs.set(sig, name);
    }
    if (bad === before) ok(row.opts.length + ' presets, each reachable and each distinct');
  }
}

// --------------------------------------------------------------------- 4 --
{
  const before = bad;
  /* Both files that read a settings blob. gamepad.js takes the whole object in
     `configure(st)`, so the pad's four rows are read there rather than in
     game.js - and a check that looked only at game.js would report them as
     controls that do nothing, which is the very thing it is looking for. */
  const READERS = ['game.js', 'gamepad.js'];
  const read = new Set();
  for (const f of READERS) {
    const text = fs.readFileSync(path.join(WEB, 'js', f), 'utf8');
    // the `optionOf(st, 'x')` lookup, which returns an option STRING...
    for (const m of text.matchAll(/optionOf\(\s*st\w*\s*,\s*'([^']+)'\s*\)/g)) read.add(m[1]);
    // ...and the `st.x` index read
    for (const m of text.matchAll(/\bst\.([A-Za-z_$][\w$]*)/g)) read.add(m[1]);
  }

  /* Keys on the settings object that are not schema rows. `binds` is the
     keyboard map, which is a structure rather than an index and is validated
     where it is loaded. */
  const NOT_ROWS = new Set(['binds']);

  const missing = [];
  for (const k of read) {
    if (NOT_ROWS.has(k)) continue;
    if (!S.rowByKey(k)) missing.push(k);
  }
  if (missing.length) fail('the game reads settings no row declares: ' + missing.join(', '));
  else ok(read.size + ' settings read by ' + READERS.join(' + ') + ', all declared');

  /* ...and the reverse. A row nothing reads is a control that does nothing,
     which is the same bug wearing the other hat. The window rows are exempt:
     the host reads those out of the save file in Rust, before any JavaScript
     exists. */
  const byHost = new Set(S.HOST_KEYS);
  const unread = S.ROWS.filter((r) => !read.has(r.key) && !byHost.has(r.key)).map((r) => r.key);
  if (unread.length) fail('rows nothing reads, so nothing they do can be seen: ' + unread.join(', '));
  else if (bad === before) ok('every row is read by something');
}

// --------------------------------------------------------------------- 5 --
{
  const before = bad;
  const fps = S.rowByKey('fps_cap');
  if (fps && fps.opts.length !== S.FPS_CAPS.length) {
    fail('FRAME LIMIT offers ' + fps.opts.length + ' values but FPS_CAPS has ' + S.FPS_CAPS.length);
  }
  const res = S.rowByKey('resolution');
  if (res && res.opts.length !== S.RENDER_SCALES.length) {
    fail('RENDER SCALE offers ' + res.opts.length + ' but RENDER_SCALES has ' + S.RENDER_SCALES.length);
  }
  for (const k of S.HOST_KEYS) {
    const r = S.rowByKey(k);
    if (!r) { fail('HOST_KEYS names "' + k + '", which is not a row'); continue; }
    /* A host key must be a launcher row: the host reads it before any
       JavaScript exists, so one owned by the in-game screen could never reach
       it. */
    if (r.where !== 'launcher') fail('"' + k + '" is a host key but lives on the game screen');
  }
  if (bad === before) ok('the parallel tables line up with their rows');
}

if (bad) {
  console.error('\n' + bad + ' PROBLEM(S) in the settings schema');
  process.exit(1);
}
console.log('\nthe settings schema and its readers agree');
