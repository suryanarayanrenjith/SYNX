/* Guard against a backtick inside a GLSL source string.
 *
 * Every shader in this project lives in a JavaScript template literal, so a
 * backtick used for emphasis in one of its comments closes the literal and the
 * file stops parsing - with an error that points at whatever GLSL identifier
 * happened to follow, which says nothing about the real cause. It has happened
 * twice. It does not need to happen again.
 *
 *     node tools/checkshaders.js
 */
const fs = require('fs');
const path = require('path');

const files = ['scene.js', 'game.js', 'fx.js', 'gl.js', 'hud.js']
  .map(f => path.join(__dirname, '..', 'web', 'js', f))
  .filter(fs.existsSync);

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  /* A shader literal opens with a backtick immediately followed by
     "#version 300 es" and runs to the NEXT backtick. Checking that the body
     between them contains no backtick is vacuous - the non-greedy match stops
     at the first one it finds, so a stray backtick simply produces a short
     "shader" and the check passes. It did, and one got through.

     What actually identifies a premature close is what FOLLOWS it. A shader
     literal is always assigned or passed, so the character after the closing
     backtick is one of ; , ) or +. A backtick inside a GLSL comment is
     followed by a letter. */
  const re = /`#version 300 es/g;
  let m, n = 0;
  while ((m = re.exec(src))) {
    n++;
    const close = src.indexOf('`', m.index + 1);
    if (close < 0) {
      console.error(path.basename(f) + ': shader #' + n + ' is never closed');
      bad++;
      break;
    }
    const after = src.slice(close + 1).replace(/^\s+/, '')[0];
    if (';,)+'.indexOf(after) < 0) {
      const line = src.slice(0, close).split(String.fromCharCode(10)).length;
      console.error(path.basename(f) + ': shader #' + n + ' closes at line ' + line +
        ' followed by "' + after + '" - a backtick inside the GLSL, most likely in a comment');
      bad++;
    }
    re.lastIndex = close + 1;
  }
  // ...and every literal must be balanced: an odd count means one is unclosed
  const ticks = (src.match(/`/g) || []).length;
  if (ticks % 2 !== 0) {
    console.error(path.basename(f) + ': odd number of backticks (' + ticks + ') - a literal is unclosed');
    bad++;
  }
  console.log('  ' + path.basename(f).padEnd(12) + n + ' shader(s), ' + ticks + ' backticks');
}
if (bad) { console.error('\n' + bad + ' PROBLEM(S)'); process.exit(1); }
console.log('\nall shader literals are well formed');
