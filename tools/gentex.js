/* Generate the R-IX's own surface maps, and write them where pack.js will
 * find them.
 *
 *     node tools/gentex.js            write assets-src/textures/raptor_*.png
 *     node tools/gentex.js --force    ...even if they already exist
 *
 * WHY THESE EXIST
 * ---------------
 * The prototype's shell is the game's car in a third livery, so it already has
 * every map the player's car has - the grille, the rims, the tyres, the vents
 * all come through `buildRaptorCar` untouched. What it did NOT have was
 * anything for the parts that make it the R-IX rather than a repaint: the aero
 * kit, the momentum rings and the optics were all built by hand in
 * js/chapters.js with `tex: null, nrm: null`, which is a flat colour with a
 * specular lobe on it. Beside a car whose every panel carries a normal map,
 * flat colour is exactly what "the model looks worse than the default car"
 * means, and no amount of tuning the smoothness fixes it, because the thing
 * that is missing is surface.
 *
 * So the kit gets three maps of its own, generated rather than authored
 * because all three are regular patterns that are better described than drawn:
 *
 *   raptor_carbon.png       2x2 twill weave, the albedo. Dark, with the
 *                           characteristic diagonal step.
 *   raptor_carbon_NRM.png   the same weave as relief, so the tow crossings
 *                           catch a highlight and the resin between them does
 *                           not. This is what makes carbon read as woven cloth
 *                           under lacquer instead of as grey plastic.
 *   raptor_flake_NRM.png    metallic flake, for the paint. A pearl coat is a
 *                           suspension of tiny mirrors at random angles, and
 *                           the reason a real one glitters as the light moves
 *                           across it is that the flake normals are not the
 *                           panel normal. Very fine, very shallow - the effect
 *                           is meant to be found rather than seen.
 *
 * They are tiled, they are small, and they go into data/synx.pak with
 * everything else - the pack is the source of truth, so the workflow is
 * unpack, run this, pack.
 *
 * PNG BY HAND
 * -----------
 * A dependency-free encoder, because the alternative is a build-time package
 * for three textures. It writes the simplest legal file there is: one IHDR,
 * one IDAT holding zlib-deflated scanlines each prefixed with filter type 0,
 * and an IEND. No interlacing, no palette, no ancillary chunks.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets-src', 'textures');
const FORCE = process.argv.includes('--force');

// ------------------------------------------------------------------ png ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** `rgb` is a Uint8Array of w*h*3. */
function writePng(file, w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 2;        // colour type 2: truecolour, no alpha
  ihdr[10] = 0;       // deflate
  ihdr[11] = 0;       // adaptive filtering
  ihdr[12] = 0;       // no interlace

  // one filter byte (0 = None) per scanline, then the row
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    raw[o] = 0;
    rgb.copy ? rgb.copy(raw, o + 1, y * w * 3, (y + 1) * w * 3)
             : Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, o + 1);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  console.log('  ' + String(png.length).padStart(8) + '  ' +
    path.relative(path.join(__dirname, '..'), file));
}

// --------------------------------------------------------------- weaving ---
/* A 2x2 twill. The tow that is on top steps one place along on every row,
   which is what produces the diagonal a plain weave does not have and is the
   first thing anyone recognises carbon fibre by.

   `u,v` are in tows. Returns { top, height, along } - which of the two
   directions is uppermost here, how proud of the resin the tow is at this
   point, and the direction the filaments run, so the normal can be tilted
   ACROSS the tow rather than along it. */
function twill(u, v) {
  const cu = Math.floor(u), cv = Math.floor(v);
  const fu = u - cu, fv = v - cv;
  // 2x2 twill: warp is over the weft when ((cu + cv) mod 4) < 2
  const warpOver = (((cu + cv) % 4) + 4) % 4 < 2;
  // across the tow, the filament bundle is a shallow round bar
  const t = warpOver ? fv : fu;
  const bar = Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
  // ...and along it, a fine ripple: a tow is hundreds of filaments, not a rod
  const along = warpOver ? fu : fv;
  const fil = 0.5 + 0.5 * Math.cos(along * Math.PI * 2 * 9);
  return { warpOver, height: bar * (0.82 + 0.18 * fil), t };
}

function carbonAlbedo(size, tows) {
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const w = twill(x / size * tows, y / size * tows);
      /* Carbon under clearcoat is not black: it is a very dark grey whose tow
         crossings are lighter than the resin between them.

         THESE ARE sRGB BYTES, and the shader decodes them - so 0.18 here is
         about 0.027 of linear reflectance and 0.42 is about 0.14, which
         brackets what real 2x2 twill under lacquer actually measures. Writing
         the linear value straight into the byte (which is the easy mistake)
         puts the whole map under half a per cent and the part comes out black
         whatever is done to the material afterwards. */
      let v = 0.185 + w.height * 0.215;
      // the resin gutters between tows go darker still
      v *= 0.72 + 0.28 * Math.min(1, w.height * 1.6);
      const r = Math.round(Math.min(255, v * 255 * 1.02));
      const g = Math.round(Math.min(255, v * 255 * 1.00));
      const b = Math.round(Math.min(255, v * 255 * 1.06));
      const o = (y * size + x) * 3;
      px[o] = r; px[o + 1] = g; px[o + 2] = b;
    }
  }
  return px;
}

/** Central-difference the height field into a tangent-space normal map. */
function heightToNormal(size, height, strength) {
  const px = Buffer.alloc(size * size * 3);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // n = normalize(-dx, -dy, 1), packed to 0..255
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 3;
      px[o] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      px[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      px[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
    }
  }
  return px;
}

function carbonNormal(size, tows) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = twill(x / size * tows, y / size * tows).height;
    }
  }
  /* Gentle. The weave is a fraction of a millimetre proud and it is under
     lacquer; a strength that made the tows look like rope produced normals
     forty degrees off the panel, which on a clearcoated part is a shimmering
     mess rather than cloth. */
  return heightToNormal(size, h, 2.6);
}

/* Metallic flake.
 *
 * Every flake is one shallow, randomly tilted facet a few pixels across. The
 * map is built as a height field of overlapping cones rather than as noise,
 * because noise gives a normal that changes at every texel and reads as
 * roughness; a pearl coat glitters because the surface is made of FLAT pieces
 * at different angles, so a highlight lands on some of them and not on the
 * ones beside them. Deliberately very shallow - `strength` is a twentieth of
 * the weave's. */
function flakeNormal(size, count, seed) {
  let x = seed >>> 0;
  const rnd = () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
  const h = new Float32Array(size * size);
  for (let i = 0; i < count; i++) {
    const cx = rnd() * size, cy = rnd() * size;
    const r = 1.6 + rnd() * 2.6;
    const tilt = (rnd() - 0.5) * 2, tiltB = (rnd() - 0.5) * 2;
    const r2 = r * r;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const px = ((Math.round(cx) + dx) % size + size) % size;
        const py = ((Math.round(cy) + dy) % size + size) % size;
        // a flat facet: a plane through the flake's centre, faded at its rim
        const fall = 1 - d2 / r2;
        h[py * size + px] += (dx * tilt + dy * tiltB) * 0.06 * fall;
      }
    }
  }
  return heightToNormal(size, h, 0.6);
}

/* ------------------------------------------------------------ shattered ---
 *
 * WHAT MAKES BROKEN GLASS LOOK BROKEN, AND WHAT A DRAWN CRACK CANNOT DO.
 *
 * js/glass.js builds the impact star itself - the radials, the laterals, the
 * shards - because those have to be placed where the hit was. What it cannot
 * draw at any sensible cost is the SCALE BELOW that: a real fracture is not a
 * clean line, it is a line surrounded by a few millimetres of pulverised glass
 * with a hundred hairlines running out of it, and the eye reads a crack as
 * real or as a decal almost entirely on whether that is there.
 *
 * So the star supplies the structure and this supplies the substance. It is
 * one tiling sheet sampled at high frequency and modulated by the star's own
 * halo, which means the detail only exists where there is damage:
 *
 *   R  MICRO-FRACTURE. A Worley/cellular edge field: the distance between the
 *      two nearest of a scattered point set, which is zero exactly on the
 *      boundary between two cells. That is what a crack web IS - the seams
 *      between fragments - and it is why cellular noise looks like shattered
 *      material and value noise never does.
 *   G  PULVERISED GLASS. The same field thresholded hard and blurred: the
 *      white dust that gathers along a fracture and in the crush zone.
 *   B  SPARKLE. Isolated bright points, for the fragments that happen to be
 *      turned toward the light. Sparse on purpose - glass glitters at a few
 *      points, it does not shimmer everywhere.
 */
function glassShards(size, cells, seed) {
  let x = seed >>> 0;
  const rnd = () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
  /* A jittered grid rather than uniform random points: uniform points clump,
     and a clump in a cellular field is a fragment the size of six others,
     which reads as a mistake. */
  const g = cells;
  const px = new Float64Array(g * g), py = new Float64Array(g * g);
  for (let i = 0; i < g * g; i++) {
    px[i] = (i % g) + 0.12 + rnd() * 0.76;
    py[i] = Math.floor(i / g) + 0.12 + rnd() * 0.76;
  }
  const edge = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let xx = 0; xx < size; xx++) {
      const u = xx / size * g, v = y / size * g;
      const cx = Math.floor(u), cy = Math.floor(v);
      let d1 = 1e9, d2 = 1e9;
      // the nine neighbouring cells, wrapped, so the sheet tiles
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = ((cx + ox) % g + g) % g, gy = ((cy + oy) % g + g) % g;
          const i = gy * g + gx;
          // the point's position in THIS tile's frame
          const fx = px[i] + (cx + ox - gx), fy = py[i] + (cy + oy - gy);
          const dd = (fx - u) * (fx - u) + (fy - v) * (fy - v);
          if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) d2 = dd;
        }
      }
      // the gap between first and second nearest: zero on a seam
      edge[y * size + xx] = Math.sqrt(d2) - Math.sqrt(d1);
    }
  }
  const out = Buffer.alloc(size * size * 3);
  const at = (a, b) => edge[((b + size) % size) * size + ((a + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let xx = 0; xx < size; xx++) {
      const e = edge[y * size + xx];
      // a narrow ridge on the seam, falling off fast
      const web = Math.pow(Math.max(0, 1 - e * 5.2), 3);
      /* Dust is the seam blurred - a three-tap box is enough at this
         frequency and keeps the sheet cheap to generate. */
      let blur = 0;
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        blur += Math.pow(Math.max(0, 1 - at(xx + ox, y + oy) * 5.2), 3);
      }
      blur /= 25;
      // sparkle: the brightest fifth of a per cent of the seam, and nothing else
      const sp = web > 0.86 && ((xx * 7 + y * 13) % 29 === 0) ? 1 : 0;
      const o = (y * size + xx) * 3;
      out[o] = Math.round(Math.min(255, web * 255));
      out[o + 1] = Math.round(Math.min(255, Math.pow(blur, .7) * 235));
      out[o + 2] = Math.round(sp * 255);
    }
  }
  return out;
}

// ------------------------------------------------------------------ main ---
const jobs = [
  ['raptor_carbon.png', 256, () => carbonAlbedo(256, 8)],
  ['raptor_carbon_NRM.png', 256, () => carbonNormal(256, 8)],
  ['raptor_flake_NRM.png', 256, () => flakeNormal(256, 2600, 0x9E3779B9)],
  ['glass_shards.png', 512, () => glassShards(512, 22, 0x1B873593)],
];

console.log('generated surface maps ->');
for (const [name, size, make] of jobs) {
  const file = path.join(OUT, name);
  if (fs.existsSync(file) && !FORCE) {
    console.log('  (exists) ' + name + '  - pass --force to regenerate');
    continue;
  }
  writePng(file, size, size, make());
}
console.log('\nnow: node tools/pack.js --check');
