/* The spatial reconstruction kernel, checked numerically.
 *
 *     node tools/checkupscale.js
 *
 * WHY
 * ---
 * The upscaler is the one piece of the renderer whose bugs are invisible in a
 * screenshot and obvious in the arithmetic. A kernel that is not normalised
 * changes the brightness of the whole frame; one whose clamp is wrong rings on
 * every neon edge; one whose anisotropy is transposed averages ACROSS the edge
 * it was meant to follow and is a worse blur than the bilinear stretch it
 * replaced. All three look, at a glance, like "the low setting is a bit soft".
 *
 * This is the same arithmetic as `easu()` in the UPSCALE_FRAG shader in
 * web/js/game.js, ported to JavaScript so it can be run against known inputs
 * with known right answers. It is a port rather than a shared implementation
 * because GLSL cannot be executed here - which means the two CAN drift, and
 * the mitigation is that both are short, both are commented with the same
 * reasoning, and this file names the shader it mirrors.
 *
 * IT HAS ALREADY EARNED ITS PLACE. It caught two real defects in the first
 * version of that shader: a positive-only window that returned a one-texel
 * line at 0.37 where bilinear left it at 0.75, and a transposed anisotropy
 * that sharpened across features instead of along them.
 */
'use strict';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* THE KERNEL, AND WHY IT HAS TO GO NEGATIVE.
 *
 * The first version of this was a positive-only lobe - (1-b)^4 over the
 * squared distance - chosen because it is cheap and looked like a reasonable
 * window. It is not: a reconstruction filter whose weights are all positive is
 * a weighted average, and a weighted average of a one-texel line is a blur.
 * These tests caught it - a bright line came back at 0.37 where plain bilinear
 * left it at 0.75, so the "upscaler" was measurably worse than the stretch it
 * replaced.
 *
 * What separates a resample from a blur is the negative lobe: taps either side
 * of a feature must be subtracted, which is what keeps an edge an edge. This
 * is Catmull-Rom, evaluated on the anisotropic distance - a cubic, so it costs
 * a handful of multiplies, it interpolates its samples exactly, and its
 * negative lobe is what preserves the line.
 */
function kernel(x) {
  x = Math.abs(x);
  if (x < 1) return ((1.5 * x - 2.5) * x) * x + 1;
  if (x < 2) return (((-0.5 * x + 2.5) * x) - 4) * x + 2;
  return 0;
}

/* src: { w, h, get(x,y) -> luma 0..1 }, sampled with clamp-to-edge. */
function easu(src, outW, outH, ox, oy) {
  const u = (ox + 0.5) / outW;
  const v = (oy + 0.5) / outH;
  const pp = [u * src.w - 0.5, v * src.h - 0.5];
  const fp = [Math.floor(pp[0]), Math.floor(pp[1])];
  const fr = [pp[0] - fp[0], pp[1] - fp[1]];
  const at = (dx, dy) => src.get(fp[0] + dx, fp[1] + dy);

  const B = at(0, -1), C = at(1, -1);
  const E = at(-1, 0), F = at(0, 0), G = at(1, 0), H = at(2, 0);
  const I = at(-1, 1), J = at(0, 1), K = at(1, 1), L = at(2, 1);
  const N = at(0, 2), O = at(1, 2);

  let dir = [0, 0];
  let len = 0;
  const quad = (w, c, d, uu, vv) => {
    dir[0] += (d - c) * w;
    dir[1] += (vv - uu) * w;
    len += (Math.abs(d) + Math.abs(c) + Math.abs(uu) + Math.abs(vv)) * w;
  };
  quad((1 - fr[0]) * (1 - fr[1]), F - G, F - E, F - B, F - J);
  quad(fr[0] * (1 - fr[1]), G - H, G - F, G - C, G - K);
  quad((1 - fr[0]) * fr[1], J - K, J - I, J - F, J - N);
  quad(fr[0] * fr[1], K - L, K - J, K - G, K - O);

  const dirMax = Math.max(Math.abs(dir[0]), Math.abs(dir[1]));
  let d2 = dirMax > 1e-6 ? [dir[0] / dirMax, dir[1] / dirMax] : [1, 0];
  const n = Math.hypot(d2[0], d2[1]) || 1;
  d2 = [d2[0] / n, d2[1] / n];

  let lenN = clamp(len * 0.5, 0, 1);
  lenN = lenN * lenN;
  const stretch = 1 + (2 - 1) * lenN;

  /* `dir` is the LUMA GRADIENT, so ax points ACROSS the feature and ay runs
     ALONG it. The kernel must therefore treat a tap displaced across the edge
     as FAR - it belongs to the other side - and one displaced along it as
     NEAR, because that is the same edge. So the across component is
     multiplied by the stretch and the along component divided by it.

     Getting this pair the wrong way round is not a subtle error and it does
     not look like one either: it averages across the edge it was supposed to
     follow, which is a worse blur than the bilinear it replaced. The
     one-texel-line test is what catches it. */
  const ax = d2;
  const ay = [-d2[1], d2[0]];
  const sc = [stretch, 1 / stretch];

  const offs = [[0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [2, 0],
    [-1, 1], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2]];
  const cols = [B, C, E, F, G, H, I, J, K, L, N, O];

  let acc = 0, wsum = 0;
  for (let q = 0; q < 12; q++) {
    const dx = offs[q][0] - fr[0];
    const dy = offs[q][1] - fr[1];
    const rx = (dx * ax[0] + dy * ax[1]) * sc[0];
    const ry = (dx * ay[0] + dy * ay[1]) * sc[1];
    const w = kernel(Math.sqrt(rx * rx + ry * ry));
    acc += cols[q] * w;
    wsum += w;
  }
  const lo4 = Math.min(F, G, J, K);
  const hi4 = Math.max(F, G, J, K);
  return clamp(wsum > 1e-6 ? acc / wsum : F, lo4, hi4);
}

function bilinear(src, outW, outH, ox, oy) {
  const u = (ox + 0.5) / outW * src.w - 0.5;
  const v = (oy + 0.5) / outH * src.h - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  const a = src.get(x0, y0), b = src.get(x0 + 1, y0);
  const c = src.get(x0, y0 + 1), d = src.get(x0 + 1, y0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

function makeSrc(w, h, f) {
  return { w, h, get: (x, y) => f(clamp(x, 0, w - 1), clamp(y, 0, h - 1)) };
}

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL ' + msg); fail++; } else console.log('  ok   ' + msg); };

// ---------------------------------------------------------------- tests ---
console.log('spatial reconstruction (UPSCALE_FRAG easu):');

// 1. A FLAT FIELD MUST COME BACK EXACTLY. If the weights are not normalised,
//    the whole frame changes brightness - the most visible possible bug.
{
  const src = makeSrc(64, 64, () => 0.5);
  let worst = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    worst = Math.max(worst, Math.abs(easu(src, 128, 128, x, y) - 0.5));
  }
  ok(worst < 1e-9, 'a flat field is reproduced exactly (max error ' + worst.toExponential(1) + ')');
}

// 2. A LINEAR RAMP MUST NOT GAIN STRUCTURE. This is the case that separates a
//    reconstruction from a sharpener: a smooth gradient - the sky - must stay
//    smooth, so the result has to stay monotonic along the ramp.
{
  const src = makeSrc(64, 64, (x) => x / 63);
  let breaks = 0, prev = -1;
  for (let x = 0; x < 128; x++) {
    const v = easu(src, 128, 128, x, 64);
    if (v < prev - 1e-6) breaks++;
    prev = v;
  }
  ok(breaks === 0, 'a linear ramp stays monotonic (' + breaks + ' reversals)');
}

// 3. THE CLAMP MUST HOLD. Every output must lie inside the 2x2 it sits in, or
//    the anisotropic kernel is overshooting and neon will ring.
{
  const src = makeSrc(32, 32, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 1 : 0);
  let out = 0;
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
    const v = easu(src, 96, 96, x, y);
    if (v < -1e-9 || v > 1 + 1e-9) out++;
  }
  ok(out === 0, 'a hard checkerboard never leaves the source range (' + out + ' escapes)');
}

// 4. THE POINT OF THE WHOLE THING: on a diagonal edge - the case bilinear is
//    worst at - the reconstruction must be closer to the true high-resolution
//    image than the bilinear stretch of the same source.
{
  const N = 96;
  const edge = (x, y, w) => clamp((x - y) / (w * 0.02) + 0.5, 0, 1);  // soft diagonal
  const truth = (x, y) => edge(x / N, y / N, 1);
  const src = makeSrc(N / 2, N / 2, (x, y) => edge(x / (N / 2), y / (N / 2), 1));
  let eE = 0, eB = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const t = truth(x, y);
    eE += Math.abs(easu(src, N, N, x, y) - t);
    eB += Math.abs(bilinear(src, N, N, x, y) - t);
  }
  eE /= N * N; eB /= N * N;
  const better = (1 - eE / eB) * 100;
  ok(eE < eB, 'a diagonal edge is closer to ground truth than bilinear ' +
    '(' + eE.toFixed(4) + ' vs ' + eB.toFixed(4) + ', ' + better.toFixed(1) + '% less error)');
}

// 5. A ONE-PIXEL BRIGHT LINE - every neon rail in the game - must survive with
//    more contrast than bilinear leaves it.
{
  const N = 128;
  const src = makeSrc(N / 2, N / 2, (x) => (x === 32 ? 1 : 0));
  let pe = 0, pb = 0;
  for (let x = 0; x < N; x++) {
    pe = Math.max(pe, easu(src, N, N, x, 40));
    pb = Math.max(pb, bilinear(src, N, N, x, 40));
  }
  ok(pe >= pb - 1e-9, 'a one-texel line keeps at least bilinear\'s peak ' +
    '(' + pe.toFixed(3) + ' vs ' + pb.toFixed(3) + ')');
}

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nthe reconstruction kernel behaves');
process.exit(fail ? 1 : 0);
