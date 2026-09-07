/* Every element the scripts look up, against the markup that has to carry it.
 *
 *     node tools/checkdom.js
 *
 * WHY
 * ---
 * `document.getElementById` returns null for an element that is not there, and
 * null is a perfectly good value right up until something writes through it.
 * The interface is bound once at construction and used a thousand frames
 * later, so a panel deleted from index.html does not fail where it was
 * deleted - it fails at the moment the one line that touches it runs, which
 * may be inside a set piece halfway through a chapter.
 *
 * That is not hypothetical. Removing Chapter 6's DOM raceMode meter in favour
 * of a canvas widget left five writes to `this.ui.modeState.textContent`
 * behind, and the one inside `activateRaceMode` threw *after* the director had
 * put the game into a cinematic state and *before* anything could take it out
 * again - so pressing R after beating Javas froze the game with the simulation
 * still running underneath. Nothing in the tree could have caught it: it
 * parses, it compiles, and the smoke test never presses R.
 *
 * So this reads every `getElementById('x')` out of web/js and checks it
 * against the page that actually loads that script. It is a spelling check
 * with teeth, it runs in a few milliseconds, and it is wired into
 * `node tools/build.js --check`.
 *
 * ONE CHECKER, EVERY PAGE
 * -----------------------
 * There are two documents now - the game and the launcher - with disjoint
 * markup. Checking every script against index.html alone reported ten
 * perfectly good lookups in js/launcher.js as dangling, and a checker that
 * cries wolf is a checker somebody switches off. So each page is read for both
 * its ids and its own <script src> list, and a script is checked against the
 * union of the ids of the pages that include it. A third page needs no change
 * here.
 *
 * WHAT IT CANNOT SEE
 * ------------------
 * Ids built at runtime, and elements created by script rather than markup.
 * Both are listed as exceptions below rather than being silently skipped,
 * because an exception nobody wrote down is a hole.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

/* Ids that are legitimately absent from the markup. Every entry needs a
   reason; an unexplained one is indistinguishable from the bug this exists to
   find. */
const CREATED_AT_RUNTIME = {
  // js/freeroam.js and js/modeselect.js build their tiles and actions as
  // elements and set data-* attributes on them; nothing looks these up by id.
};

const ID_ATTR = /\bid="([^"]+)"/g;
const SCRIPT_SRC = /<script[^>]+src="([^"]+)"/g;
const BY_ID = /getElementById\(\s*'([^']+)'\s*\)/g;
/* The `const id = (n) => document.getElementById(n)` shorthand every director
   binds through. Deliberately anchored on a word boundary so it does not also
   match `.grid(`, `valid(` and the like. */
const ID_SHORTHAND = /\bid\(\s*'([^']+)'\s*\)/g;

const pages = fs.readdirSync(WEB).filter((f) => f.endsWith('.html'));
if (!pages.length) {
  console.error('  no .html in web/ - nothing to check against');
  process.exit(1);
}

const idsOf = new Map();        // page -> Set of ids it defines
const scriptsOf = new Map();    // page -> Set of scripts it loads
for (const page of pages) {
  const html = fs.readFileSync(path.join(WEB, page), 'utf8');
  const ids = new Set();
  for (const m of html.matchAll(ID_ATTR)) ids.add(m[1]);
  idsOf.set(page, ids);
  const scripts = new Set();
  for (const m of html.matchAll(SCRIPT_SRC)) {
    // strip the cache-busting query the game's tags carry, and any ./ prefix
    scripts.add(m[1].split('?')[0].replace(/^\.?\//, ''));
  }
  scriptsOf.set(page, scripts);
}

const unreferenced = [];

/** The ids a given script is allowed to look up, and which pages allow them. */
function allowedFor(rel) {
  const out = new Set();
  let included = false;
  for (const page of pages) {
    if (!scriptsOf.get(page).has(rel)) continue;
    included = true;
    for (const id of idsOf.get(page)) out.add(id);
  }
  /* A script no page loads is either dead or newly added and not wired up.
     Failing on that is not this checker's job, but checking it against nothing
     would pass it vacuously - so it is checked against every page and named in
     the summary. */
  if (!included) {
    unreferenced.push(rel);
    for (const page of pages) for (const id of idsOf.get(page)) out.add(id);
  }
  return out;
}

let bad = 0;
let checked = 0;
const files = fs.readdirSync(path.join(WEB, 'js')).filter((f) => f.endsWith('.js'));
for (const f of files) {
  const src = fs.readFileSync(path.join(WEB, 'js', f), 'utf8');
  const seen = new Set();
  for (const m of src.matchAll(BY_ID)) seen.add(m[1]);
  for (const m of src.matchAll(ID_SHORTHAND)) seen.add(m[1]);
  if (!seen.size) continue;
  const allowed = allowedFor('js/' + f);
  const missing = [];
  for (const key of seen) {
    checked++;
    if (allowed.has(key) || key in CREATED_AT_RUNTIME) continue;
    missing.push(key);
  }
  if (missing.length) {
    console.error('  ' + f + ': no element with id ' +
      missing.map((k) => '"' + k + '"').join(', '));
    bad += missing.length;
  }
}

let totalIds = 0;
for (const page of pages) totalIds += idsOf.get(page).size;
console.log('  checked ' + checked + ' lookups across ' + files.length +
  ' files against ' + totalIds + ' ids in ' + pages.join(', '));
if (unreferenced.length) {
  console.log('  (loaded by no page, so checked against all: ' + unreferenced.join(', ') + ')');
}
if (bad) {
  console.error('\n' + bad + ' DANGLING LOOKUP(S) - a write through one of these is a crash');
  process.exit(1);
}
console.log('\nevery element the scripts look up exists');
