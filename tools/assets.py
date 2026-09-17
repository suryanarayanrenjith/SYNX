#!/usr/bin/env python3
"""Everything that makes or edits an asset.

    python tools/assets.py pack [--force]     build web/data/synx.pak
    python tools/assets.py unpack             extract it back to assets-src/
    python tools/assets.py check              verify it, writing nothing
    python tools/assets.py list               show what is in it
    python tools/assets.py shrink [--write]   re-encode every PNG, losslessly
    python tools/assets.py atlas  [--write]   erase sprites nothing draws
    python tools/assets.py gentex [--force]   generate the R-IX surface maps
    python tools/assets.py scene  [--write]   drop geometry nothing submits
    python tools/assets.py sfx    [--write]   synthesise the one-shots

WHY ONE FILE
------------
These were six separate programs that all did the same four things: find the
tree, read an asset, write it back, and say what changed. The four differences
between them are the sixty lines each contributes below.

WHAT NEEDS WHAT
---------------
`pack`, `unpack`, `check` and `list` are byte shuffling and run on a stock
interpreter - which matters, because they are the ones the build runs. The
commands that touch PIXELS want numpy (see synx/png.py for why), and `sfx`
wants numpy and soundfile. Each says so when it is asked to run without them.
"""
import argparse
import json
import math
import re
import sys

sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))

from synx import pak, paths                                     # noqa: E402


# ============================================================== the pack ===

def cmd_list(args):
    p = pak.load()
    for e in p.toc:
        print('  %9d  %s' % (e.length, e.name))
    print('%d entries, %s' % (len(p), pak.mb(len(p.buf))))
    return 0


def cmd_unpack(args):
    p = pak.load()
    n = skipped = 0
    for e in p.toc:
        dest = pak.source_of(e.name)
        if dest is None:
            why = pak.retired_reason(e.name) or 'no source directory'
            print('  skipped ' + e.name + '  (' + why + ')')
            skipped += 1
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(p.data(e))
        n += 1
    print('unpacked %d files -> %s%s' % (n, paths.rel(paths.ASSETS_SRC),
          ('  (%d retired entries left alone)' % skipped) if skipped else ''))
    return 0


def cmd_check(args):
    """VERIFY WHAT IS ON DISK, and write nothing at all.

    The JavaScript this replaces built the pack unconditionally and then added
    a pass over the file it had just written, which is a tautology on a good
    day and a disaster on a bad one: assets-src is a scratch directory that is
    routinely absent or half populated, and a check against four files happily
    replaced a forty-two megabyte archive with a three hundred kilobyte one and
    reported that all four entries matched.
    """
    if not paths.PAK.exists():
        print('There is no pack at %s to check.' % paths.rel(paths.PAK), file=sys.stderr)
        return 1
    p = pak.load()
    bad = unchecked = 0
    for e in p.toc:
        src = pak.source_of(e.name)
        if src is None:
            unchecked += 1
            continue
        if not src.exists():
            print('  MISSING SOURCE ' + e.name, file=sys.stderr)
            bad += 1
            continue
        if src.read_bytes() != p.data(e):
            print('  MISMATCH ' + e.name, file=sys.stderr)
            bad += 1
    print('checked %s  (%s, %d entries)'
          % (paths.rel(paths.PAK), pak.mb(len(p.buf)), len(p)))
    if unchecked:
        print('  %d entry/entries had no source to compare against' % unchecked)
    print(('  %d ENTRIES CORRUPT' % bad) if bad
          else '  verified: all %d entries match their source byte for byte' % len(p))
    return 1 if bad else 0


def cmd_pack(args):
    files = pak.collect()
    if not files:
        print('No assets in %s.' % paths.rel(paths.ASSETS_SRC), file=sys.stderr)
        print('The pack is the source of truth; run `python tools/assets.py unpack` first.',
              file=sys.stderr)
        return 1

    # THE ARCHIVE MAY NOT SHRINK BY ACCIDENT. assets-src is a scratch tree: it
    # is not checked in, an unpack can be interrupted, and a tool that walks it
    # can leave it holding a handful of files - at which point a plain pack
    # quietly replaces the shipped archive with those. Losing an asset that way
    # is silent. So a build that would DROP entries stops and says which.
    if paths.PAK.exists() and not args.force:
        have = {name for name, _, _ in files}
        gone = [n for n in pak.load().names() if n not in have]
        if gone:
            print('Refusing to build: %d entry/entries in the existing pack are not in %s.'
                  % (len(gone), paths.rel(paths.ASSETS_SRC)), file=sys.stderr)
            for n in gone[:12]:
                print('  missing  ' + n, file=sys.stderr)
            if len(gone) > 12:
                print('  ...and %d more' % (len(gone) - 12), file=sys.stderr)
            print('\nThat is what a half-finished unpack looks like. Run'
                  ' `python tools/assets.py unpack` first, or pass --force if the'
                  ' removal is deliberate.', file=sys.stderr)
            return 1

    buf = pak.build(files)
    paths.PAK.parent.mkdir(parents=True, exist_ok=True)
    paths.PAK.write_bytes(buf)
    body = sum(p.stat().st_size for _, p, _ in files)
    print('packed %d files -> %s' % (len(files), paths.rel(paths.PAK)))
    print('  table of contents  %d bytes' % (len(buf) - body - 12))
    print('  data               ' + pak.mb(body))
    print('  total              ' + pak.mb(len(buf)))
    return 0


# ============================================================ the sheets ===

def _png():
    from synx import png
    return png


def _every_png():
    out = [p for p in paths.ASSETS_SRC.rglob('*.png')]
    out.sort(key=lambda p: str(p).lower())
    return out


def cmd_shrink(args):
    """Re-encode every PNG in the pack's source tree, losslessly.

    WHY THIS IS NOT `oxipng`. Because a build that needs a tool nobody has
    installed is a build that does not run. A PNG is zlib with a one-byte
    filter tag on the front of every row, which is the entire format as far as
    file size is concerned, so the two things an optimiser actually does are
    both reachable from here: choose a better filter per row, and deflate
    harder. See synx/png.py.

    PIXELS ARE NOT TOUCHED. Every output is decoded again and compared against
    the input before it is written; a mismatch is a hard failure, not a
    warning. That is what makes this safe to run over the art without a
    separate review of what it did to it.
    """
    png = _png()
    import numpy as np
    if not paths.ASSETS_SRC.is_dir():
        print('assets-src/ is not there. Run `python tools/assets.py unpack` first.',
              file=sys.stderr)
        return 2
    files = _every_png()
    before = after = changed = skipped = 0
    for p in files:
        src = p.read_bytes()
        before += len(src)
        try:
            im = png.decode(src)
            out = png.encode(im)
            back = png.decode(out)
            if (back.w != im.w or back.h != im.h or back.ctype != im.ctype
                    or not np.array_equal(back.pixels, im.pixels)):
                raise ValueError('round trip changed the pixels')
        except Exception as e:                                  # noqa: BLE001
            print('  skip  %s  (%s)' % (paths.rel(p), e))
            after += len(src)
            skipped += 1
            continue
        if len(out) < len(src):
            save = len(src) - len(out)
            print('  %9d  %s  (%.1f%%)' % (-save, paths.rel(p), save * 100.0 / len(src)))
            after += len(out)
            changed += 1
            if args.write:
                p.write_bytes(out)
        else:
            after += len(src)

    print('\n%d PNGs, %d smaller, %d skipped' % (len(files), changed, skipped))
    print('%s -> %s   (%.2f MB saved, %.1f%%)'
          % (pak.mb(before), pak.mb(after), (before - after) / 1048576.0,
             (before - after) * 100.0 / max(1, before)))
    if not args.write:
        print('\n--write to apply, then re-run `python tools/assets.py pack`')
    return 0


# Sprite names the HUD builds rather than writes. Each one needs a reason: an
# exception nobody wrote down is a hole.
BUILT_AT_RUNTIME = {
    'countdown_1': "js/hud.js draws 'countdown_' + n for the three lights",
    'countdown_2': "js/hud.js draws 'countdown_' + n for the three lights",
    'countdown_3': "js/hud.js draws 'countdown_' + n for the three lights",
}


def game_data():
    """data/game_data.js as a dict, plus the text either side of it.

    The file is one assignment of a JSON object literal, so the object is cut
    out by its braces rather than executed. That is deliberate: this tool
    WRITES the file back, and round-tripping through a JavaScript engine would
    mean trusting the engine's idea of how to print it.
    """
    src = paths.read(paths.DATA / 'game_data.js')
    a, b = src.index('{'), src.rindex('}') + 1
    return json.loads(src[a:b]), src[:a], src[b:]


def cmd_atlas(args):
    """The sprites nothing draws any more.

    A sprite is not a file: `speed`, `boost_bar` and the rest are RECTANGLES
    inside two shipped atlas sheets that also carry the countdown numerals, the
    chequered flag and the chase meter - so the sheets have to stay, and the
    only thing that can be got back is the AREA. Erased to transparent black it
    deflates to almost nothing.

    WHAT IS DEAD IS DERIVED, NOT LISTED. The live set is read out of js/hud.js:
    every literal name handed to the four sprite calls, plus the widget names
    those resolve through. A hard-coded list would be wrong the first time
    somebody drew one again, and the failure would be a hole in a sheet rather
    than an error.
    """
    png = _png()
    import numpy as np
    gd, _, _ = game_data()
    hud = paths.read(paths.JS / 'hud.js')

    asked = set()
    for pat in (r"placeSprite\(\s*'([^']+)'", r"placeSpriteTinted\(\s*'([^']+)'",
                r"\bsprite\(\s*'([^']+)'", r"spriteAt\(\s*'([^']+)'"):
        asked.update(re.findall(pat, hud))
    widget_sprite = {w['name']: w['sprite'] for w in gd.get('hud', []) if w.get('sprite')}
    live = set(BUILT_AT_RUNTIME)
    for a in asked:
        live.add(a)
        if a in widget_sprite:
            live.add(widget_sprite[a])

    before = after = dead_count = dead_px = 0
    dropped = {}
    for key, atlas in (gd.get('atlas') or {}).items():
        if not atlas.get('texture'):
            continue
        p = paths.ASSETS_SRC / 'textures' / (atlas['texture'] + '.png')
        if not p.exists():
            print('  skip  %s  (not in assets-src; run `python tools/assets.py unpack`)'
                  % p.name)
            continue
        dead = [n for n in atlas['sprites'] if n not in live]
        src = p.read_bytes()
        before += len(src)
        print('\n== %s  %s  %d KB' % (key, p.name, len(src) // 1024))
        if not dead:
            print('   every sprite on this sheet is still drawn')
            after += len(src)
            continue

        im = png.decode(src)
        px = 0
        for n in dead:
            x, y, w, h = atlas['sprites'][n]
            print('   DEAD  %-20s %dx%d at %d,%d   %d kpx' % (n, w, h, x, y, w * h // 1000))
            # Erased to zero rather than to a colour: an all-zero run is the
            # cheapest thing deflate can encode, and transparent black cannot
            # bleed into a neighbouring sprite through bilinear filtering the
            # way an opaque fill would.
            y0, y1 = max(0, y), min(im.h, y + h)
            x0, x1 = max(0, x), min(im.w, x + w)
            if y1 > y0 and x1 > x0:
                im.pixels[y0:y1, x0:x1, :] = 0
            px += w * h
        dead_count += len(dead)
        dead_px += px
        dropped[key] = dead

        out = png.encode(im)
        back = png.decode(out)
        if (back.w != im.w or back.h != im.h or back.ctype != im.ctype
                or not np.array_equal(back.pixels, im.pixels)):
            raise SystemExit(p.name + ': the round trip changed the pixels')
        save = len(src) - len(out)
        print('   %d KB -> %d KB   (%s%d KB, %.1f%%)'
              % (len(src) // 1024, len(out) // 1024, '-' if save >= 0 else '+',
                 abs(save) // 1024, save * 100.0 / len(src)))
        after += len(out)
        if args.write:
            p.write_bytes(out)

    # A rectangle that has been erased must stop being ADDRESSABLE, or a later
    # edit can point something at a hole and see nothing at all - which is the
    # hardest kind of missing art to trace, because everything about the draw
    # succeeds.
    if dead_count:
        data, head, tail = game_data()
        removed = 0
        for key, names in dropped.items():
            for n in names:
                if data['atlas'].get(key, {}).get('sprites', {}).pop(n, None) is not None:
                    removed += 1
        print('\n%d sprite(s) dropped from data/game_data.js' % removed)
        if args.write:
            paths.write(paths.DATA / 'game_data.js',
                        head + json.dumps(data, separators=(',', ':'),
                                          ensure_ascii=False) + tail)

    print('\n%d dead sprite(s), %d kpx of sheet' % (dead_count, dead_px // 1000))
    print('%d KB -> %d KB   (%d KB saved)'
          % (before // 1024, after // 1024, (before - after) // 1024))
    if not args.write:
        print('\n--write to apply, then re-run `python tools/assets.py pack`')
    return 0


# ======================================================== generated maps ===

def _xorshift(seed):
    """The same 32-bit xorshift the JavaScript generator used, so regenerating
    a map produces the sheet that is already in the pack rather than a
    different one that happens to look similar."""
    x = seed & 0xffffffff

    def rnd():
        nonlocal x
        x ^= (x << 13) & 0xffffffff
        x ^= x >> 17
        x ^= (x << 5) & 0xffffffff
        x &= 0xffffffff
        return x / 4294967296.0
    return rnd


def _jsround(x, np):
    """Math.round, not numpy's round.

    They disagree on exactly one input and the twill produces a lot of it.
    numpy rounds a half to the nearest EVEN value; JavaScript rounds a half
    toward positive infinity. The carbon normal map is a symmetric height
    field, so about one byte in seventy landed on a dead .5 and came out one
    step darker than the sheet already in the pack. floor(x + 0.5) is what
    Math.round is defined to be.
    """
    return np.floor(x + 0.5)


def _twill(u, v):
    """A 2x2 twill. The tow that is on top steps one place along on every row,
    which is what produces the diagonal a plain weave does not have and is the
    first thing anyone recognises carbon fibre by."""
    cu, cv = math.floor(u), math.floor(v)
    fu, fv = u - cu, v - cv
    warp_over = ((cu + cv) % 4 + 4) % 4 < 2
    t = fv if warp_over else fu
    bar = math.sin(math.pi * min(1.0, max(0.0, t)))
    along = fu if warp_over else fv
    fil = 0.5 + 0.5 * math.cos(along * math.pi * 2 * 9)
    return bar * (0.82 + 0.18 * fil)


def _hypot3(dx, dy, np):
    """Math.hypot(dx, dy, 1), which is NOT sqrt(dx*dx + dy*dy + 1).

    hypot in JavaScript divides through by the largest term and sums the
    squares with Kahan compensation, so its last bit is not the last bit of a
    naive sum. This is here because the regenerated sheet has to be the sheet
    already in the pack - if it is not, every --force is a diff in the art that
    nobody can see and nobody can explain.

    It is NOT what was wrong when this port first came back one step off: that
    was the height field, which is a Float32Array on the JavaScript side. See
    _height_to_normal. Both are needed; only one was the bug.
    """
    m = np.maximum(np.maximum(np.abs(dx), np.abs(dy)), 1.0)
    total = np.zeros_like(dx)
    comp = np.zeros_like(dx)
    for v in (dx, dy, np.ones_like(dx)):
        n = v / m
        summand = n * n - comp
        prelim = total + summand
        comp = (prelim - total) - summand
        total = prelim
    return np.sqrt(total) * m


def _height_to_normal(size, height, strength, np):
    """Central-difference a height field into a tangent-space normal map.

    THE FIELD IS SINGLE PRECISION and the arithmetic over it is double. Both
    halves of that matter and neither is an accident: the JavaScript stores its
    height in a Float32Array, so every sample is quantised before it is
    differenced, and then reads it back into ordinary doubles for the gradient.
    Computing the whole thing in double instead moved about one byte in seventy
    of the carbon weave by one step - invisible, but enough to make every
    regeneration a diff.
    """
    h = height.reshape(size, size).astype(np.float32).astype(np.float64)
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * strength
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * strength
    ln = _hypot3(dx, dy, np)
    out = np.empty((size, size, 3), dtype=np.uint8)
    out[:, :, 0] = _jsround((-dx / ln * 0.5 + 0.5) * 255, np)
    out[:, :, 1] = _jsround((-dy / ln * 0.5 + 0.5) * 255, np)
    out[:, :, 2] = _jsround((1.0 / ln * 0.5 + 0.5) * 255, np)
    return out


def _carbon_albedo(size, tows, np):
    h = np.array([[_twill(x / size * tows, y / size * tows) for x in range(size)]
                  for y in range(size)])
    # Carbon under clearcoat is not black: it is a very dark grey whose tow
    # crossings are lighter than the resin between them. THESE ARE sRGB BYTES
    # and the shader decodes them, so 0.18 here is about 0.027 of linear
    # reflectance - writing the linear value straight into the byte (the easy
    # mistake) puts the whole map under half a per cent and the part comes out
    # black whatever is done to the material afterwards.
    v = 0.185 + h * 0.215
    v = v * (0.72 + 0.28 * np.minimum(1.0, h * 1.6))
    out = np.empty((size, size, 3), dtype=np.uint8)
    for i, gain in enumerate((1.02, 1.00, 1.06)):
        out[:, :, i] = _jsround(np.minimum(255.0, v * 255 * gain), np)
    return out


def _carbon_normal(size, tows, np):
    h = np.array([[_twill(x / size * tows, y / size * tows) for x in range(size)]
                  for y in range(size)], dtype=np.float64)
    # Gentle. The weave is a fraction of a millimetre proud and it is under
    # lacquer; a strength that made the tows look like rope produced normals
    # forty degrees off the panel, which on a clearcoated part is a shimmering
    # mess rather than cloth.
    return _height_to_normal(size, h, 2.6, np)


def _flake_normal(size, count, seed, np):
    """Metallic flake: shallow, randomly tilted facets a few pixels across.

    Built as overlapping cones rather than as noise, because noise gives a
    normal that changes at every texel and reads as roughness. A pearl coat
    glitters because the surface is made of FLAT pieces at different angles, so
    a highlight lands on some of them and not on the ones beside them.
    """
    rnd = _xorshift(seed)
    h = np.zeros((size, size))
    for _ in range(count):
        cx, cy = rnd() * size, rnd() * size
        r = 1.6 + rnd() * 2.6
        tilt, tilt_b = (rnd() - 0.5) * 2, (rnd() - 0.5) * 2
        r2 = r * r
        span = int(math.ceil(r))
        for dy in range(-span, span + 1):
            for dx in range(-span, span + 1):
                d2 = dx * dx + dy * dy
                if d2 > r2:
                    continue
                px = (int(round(cx)) + dx) % size
                py = (int(round(cy)) + dy) % size
                h[py, px] += (dx * tilt + dy * tilt_b) * 0.06 * (1 - d2 / r2)
    return _height_to_normal(size, h, 0.6, np)


def _glass_shards(size, cells, seed, np):
    """What makes broken glass look broken, below the scale a crack can be drawn.

    js/glass.js builds the impact star itself, because that has to be placed
    where the hit was. What it cannot draw at any sensible cost is the scale
    BELOW: a real fracture is a line surrounded by a few millimetres of
    pulverised glass with a hundred hairlines running out of it, and the eye
    reads a crack as real or as a decal almost entirely on whether that is
    there.

      R  MICRO-FRACTURE. A cellular edge field - the gap between the two
         nearest of a scattered point set, which is zero exactly on the
         boundary between two cells. That is what a crack web IS, and it is why
         cellular noise looks like shattered material and value noise does not.
      G  PULVERISED GLASS. The same field blurred: the dust along a fracture.
      B  SPARKLE. Isolated bright points, for the fragments that happen to be
         turned toward the light. Sparse on purpose.
    """
    rnd = _xorshift(seed)
    g = cells
    # A jittered grid rather than uniform random points: uniform points clump,
    # and a clump in a cellular field is a fragment the size of six others,
    # which reads as a mistake.
    pts = np.empty((g * g, 2))
    for i in range(g * g):
        pts[i, 0] = (i % g) + 0.12 + rnd() * 0.76
        pts[i, 1] = (i // g) + 0.12 + rnd() * 0.76

    u = (np.arange(size) / size * g)[None, :]
    v = (np.arange(size) / size * g)[:, None]
    cx = np.floor(u).astype(int)
    cy = np.floor(v).astype(int)
    d1 = np.full((size, size), 1e9)
    d2 = np.full((size, size), 1e9)
    for oy in range(-1, 2):
        for ox in range(-1, 2):
            gx = (cx + ox) % g
            gy = (cy + oy) % g
            # the point's position in THIS tile's frame
            fx = pts[gy * g + gx, 0] + (cx + ox - gx)
            fy = pts[gy * g + gx, 1] + (cy + oy - gy)
            dd = (fx - u) ** 2 + (fy - v) ** 2
            closer = dd < d1
            d2 = np.where(closer, d1, np.minimum(d2, dd))
            d1 = np.where(closer, dd, d1)
    edge = np.sqrt(d2) - np.sqrt(d1)

    web = np.maximum(0.0, 1 - edge * 5.2) ** 3
    blur = np.zeros_like(web)
    for oy in range(-2, 3):
        for ox in range(-2, 3):
            blur += np.roll(np.roll(web, -oy, axis=0), -ox, axis=1)
    blur /= 25.0
    ix = np.arange(size)
    sp = ((web > 0.86) & (((ix[None, :] * 7 + ix[:, None] * 13) % 29) == 0))
    out = np.empty((size, size, 3), dtype=np.uint8)
    out[:, :, 0] = _jsround(np.minimum(255.0, web * 255), np)
    out[:, :, 1] = _jsround(np.minimum(255.0, blur ** 0.7 * 235), np)
    out[:, :, 2] = sp * 255
    return out


def cmd_gentex(args):
    """The R-IX's own surface maps, and the shattered-glass sheet.

    The prototype's shell is the game's car in a third livery, so it already
    has every map the player's car has. What it did NOT have was anything for
    the parts that make it the R-IX rather than a repaint: the aero kit, the
    momentum rings and the optics were all built with no texture at all, which
    is a flat colour with a specular lobe on it. Beside a car whose every panel
    carries a normal map, that is exactly what "the model looks worse than the
    default car" means.

    Generated rather than authored because all four are regular patterns that
    are better described than drawn.
    """
    png = _png()
    import numpy as np
    out_dir = paths.ASSETS_SRC / 'textures'
    jobs = [
        ('raptor_carbon.png', 256, lambda: _carbon_albedo(256, 8, np)),
        ('raptor_carbon_NRM.png', 256, lambda: _carbon_normal(256, 8, np)),
        ('raptor_flake_NRM.png', 256, lambda: _flake_normal(256, 2600, 0x9E3779B9, np)),
        ('glass_shards.png', 512, lambda: _glass_shards(512, 22, 0x1B873593, np)),
    ]
    print('generated surface maps ->')
    for name, size, make in jobs:
        f = out_dir / name
        if f.exists() and not args.force:
            print('  (exists) %s  - pass --force to regenerate' % name)
            continue
        data = png.encode(png.from_raw(size, size, 3, make()))
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        print('  %8d  %s' % (len(data), paths.rel(f)))
    print('\nnow: python tools/assets.py check')
    return 0


# =============================================================== the scene ===

# Meshes dropped outright, by name. Everything else survives if something
# still points at it.
DROP_MESH = re.compile(r'^(terrain_sunset_MeshPart[01]|PalmPrefab-mesh[0-2])$')
# Instances dropped, by name. `-mesh` is what the exporter made of
# "PalmPrefab-mesh0" when it split the name; `trunk` covers both halves of
# every shipped roadside palm, the frond cluster included.
DROP_INST = re.compile(r'^(terrain_sunset|-mesh$|trunk$)')
# ...and the meshes that must survive being un-instanced, because the palm
# emitter reads their geometry directly out of the buffer.
KEEP_MESH = {'trunk', 'palms'}
LISTS = ('world', 'road', 'car')


def cmd_scene(args):
    """Drop from data/scene.{json,bin} everything the game never draws.

    Two thirds of it was geometry no frame has ever shown, for two reasons the
    renderer had already decided and then paid for anyway: the imported hills,
    which buildDrawLists drops by name because the landscape is generated from
    one height field; and the baked palm forest, planted flat at y = -2.29
    against a terrain that is not drawn, so it stands buried in a generated
    landscape that reaches 340 units.

    The output is identical in meaning: every surviving mesh keeps its
    vertices, its indices and its winding, and every instance keeps the mesh it
    pointed at. Only the numbering changes.
    """
    from array import array
    man = paths.read_json(paths.DATA / 'scene.json')
    blob = paths.read_bytes(paths.DATA / 'scene.bin')
    stride = man['vertexStride']
    verts = array('f')
    verts.frombytes(blob[:man['vertexBytes']])
    idx = array('I')
    idx.frombytes(blob[man['vertexBytes']:man['vertexBytes'] + man['indexBytes']])
    src_mesh_count = len(man['meshes'])

    kept_inst = {}
    dropped_inst = 0
    for key in LISTS:
        keep_list = []
        for i in man.get(key) or []:
            if DROP_INST.search(i.get('name') or ''):
                dropped_inst += 1
            else:
                keep_list.append(i)
        kept_inst[key] = keep_list

    used = {i['mesh'] for key in LISTS for i in kept_inst[key]}
    keep = [n for n, m in enumerate(man['meshes'])
            if not DROP_MESH.match(m['name']) and (m['name'] in KEEP_MESH or n in used)]

    # Nothing is dropped silently. Some of these are neither named above nor
    # orphaned by this tool - the dashboard and its buttons were exported with
    # the car and have never been instanced by anything, in any build - and a
    # list is the only way that stays visible next time somebody runs it.
    kept = set(keep)
    gone = ['  - %-26s v%6d i%7d   %s'
            % (m['name'], m['vCount'], m['iCount'],
               'named above' if DROP_MESH.match(m['name']) else 'nothing instances it')
            for n, m in enumerate(man['meshes']) if n not in kept]

    remap = {old: now for now, old in enumerate(keep)}
    for key in LISTS:
        for i in kept_inst[key]:
            if i['mesh'] not in remap:
                print('instance "%s" points at dropped mesh %s'
                      % (i.get('name'), man['meshes'][i['mesh']]['name']), file=sys.stderr)
                return 2

    # Vertices and indices are copied mesh by mesh in the new order, so the two
    # arrays come out contiguous with no holes and every index is rewritten by
    # the shift its own mesh moved. Indices are stored GLOBALLY - they address
    # the one big buffer, not the mesh - so the shift is newVOff - oldVOff.
    out_v = array('f')
    out_i = array('I')
    meshes = []
    v_at = i_at = 0
    for old in keep:
        m = man['meshes'][old]
        out_v.extend(verts[m['vOff'] * stride:(m['vOff'] + m['vCount']) * stride])
        shift = v_at - m['vOff']
        seg = idx[m['iOff']:m['iOff'] + m['iCount']]
        out_i.extend(seg if shift == 0 else array('I', (v + shift for v in seg)))
        nm = dict(m)
        nm['vOff'], nm['iOff'] = v_at, i_at
        meshes.append(nm)
        v_at += m['vCount']
        i_at += m['iCount']

    for key in LISTS:
        for i in kept_inst[key]:
            i['mesh'] = remap[i['mesh']]
        man[key] = kept_inst[key]
    man['meshes'] = meshes
    man['vertexCount'] = v_at
    man['indexCount'] = i_at
    man['vertexBytes'] = v_at * stride * 4
    man['indexBytes'] = i_at * 4

    before = len(blob)
    after = man['vertexBytes'] + man['indexBytes']
    print('meshes    %d kept, %d dropped' % (len(meshes), src_mesh_count - len(meshes)))
    print('instances %d dropped' % dropped_inst)
    for line in gone:
        print(line)
    print('vertices  {:,}  (was {:,})'.format(man['vertexCount'], len(verts) // stride))
    print('indices   {:,}  (was {:,})'.format(man['indexCount'], len(idx)))
    print('scene.bin %.2f MB  (was %.2f MB, %.1f%% saved)'
          % (after / 1048576.0, before / 1048576.0, (before - after) * 100.0 / before))
    if not args.write:
        print('\n--write to apply')
        return 0

    # Sanity, before anything is overwritten: every index must address a vertex
    # that exists and stay inside the mesh that owns it. An off-by-one in the
    # shift above would otherwise ship as a scene full of stray triangles
    # stretching to the origin, which is a hard thing to trace back to here.
    for m in man['meshes']:
        lo, hi = m['vOff'], m['vOff'] + m['vCount']
        for k in range(m['iCount']):
            v = out_i[m['iOff'] + k]
            if v < lo or v >= hi:
                print('mesh %s index %d -> %d is outside [%d,%d)'
                      % (m['name'], k, v, lo, hi), file=sys.stderr)
                return 2

    (paths.DATA / 'scene.bin').write_bytes(out_v.tobytes() + out_i.tobytes())
    paths.write(paths.DATA / 'scene.json',
                json.dumps(man, separators=(',', ':'), ensure_ascii=False))
    print('\nwritten. re-run `python tools/assets.py pack` to fold it into the pack.')
    return 0


# ================================================================== sound ===

SR = 44100
# seed, spring Hz, scrub, weight - the same car, landed three ways
LANDING_TAKES = ((7, 55.0, 0.30, 1.00), (19, 49.0, 0.42, 1.12), (23, 61.0, 0.22, 0.88))


def _one_pole_lp(x, cutoff, np):
    """A single-pole low pass, which is all the shaping this needs.

    Deliberately the plain recurrence and not a clever equivalent. The three
    one-shots already in the pack were produced by exactly this loop, and a
    filter that is only ALMOST the same one regenerates an asset that is only
    almost the same asset. Twenty-seven thousand samples cost about twenty
    milliseconds; there is nothing here to optimise.
    """
    a = math.exp(-2.0 * math.pi * cutoff / SR)
    out = np.empty_like(x)
    z = 0.0
    for i in range(len(x)):
        z = (1.0 - a) * x[i] + a * z
        out[i] = z
    return out


def _one_pole_hp(x, cutoff, np):
    return x - _one_pole_lp(x, cutoff, np)


def _env(n, attack, decay, np):
    """A percussive envelope: a few samples up, exponential down."""
    t = np.arange(n) / SR
    return np.clip(t / max(attack, 1e-5), 0.0, 1.0) * np.exp(-t / decay)


def _landing(seed, spring_hz, scrub, weight, np):
    """A car coming back down off a jump.

    Synthesised rather than sampled, for the same reason every other sound in
    this game is: nothing here may depend on a file somebody has to license.

    WHAT A LANDING ACTUALLY SOUNDS LIKE, in the order the ear gets it -

      the tyres    a broadband slap as the contact patch is slammed flat.
                   Short, bright at the front, gone in about 80 ms.
      the springs  the body arriving on the suspension a moment later. This is
                   the part that carries the WEIGHT of the car: a decaying
                   thump around 55 Hz, which is where 1400 kg on those spring
                   rates actually sits.
      the scrub    the tyres finding grip again while the car is still moving
                   forward - a band of noise dying as the slip does.
      the shell    a little structural rattle after it, quiet, so the sound has
                   an end rather than a cut.
    """
    rng = np.random.default_rng(seed)
    dur = 0.62
    n = int(SR * dur)
    t = np.arange(n) / SR
    out = np.zeros(n)

    slap = rng.standard_normal(n) * _env(n, 0.0004, 0.030, np)
    slap = _one_pole_hp(slap, 900.0, np)
    slap += _one_pole_lp(rng.standard_normal(n) * _env(n, 0.0006, 0.055, np), 2600.0, np) * 0.8
    out += slap * 0.55

    # two partials: the body on its springs, and the axle hop above it
    body = np.sin(2 * np.pi * spring_hz * t) * _env(n, 0.006, 0.150, np)
    hop = np.sin(2 * np.pi * (spring_hz * 2.7) * t) * _env(n, 0.004, 0.060, np)
    # the pitch falls as the spring extends again, which is what makes it a
    # mass landing rather than a drum. It needs an envelope of its own: without
    # one this is a constant-amplitude sine running the whole buffer, a hum
    # UNDER the landing rather than part of it, and it showed up as the energy
    # rising again a fifth of a second in.
    fall = np.sin(2 * np.pi * np.cumsum(spring_hz * (1.0 - 0.35 * t / dur)) / SR)
    fall *= _env(n, 0.008, 0.130, np)
    out += (body * 0.75 + hop * 0.22 + fall * 0.35) * weight

    d = int(SR * 0.045)
    sc = np.zeros(n)
    m = n - d
    sc[d:] = _one_pole_lp(_one_pole_hp(rng.standard_normal(m), 1400.0, np),
                          4200.0, np) * _env(m, 0.010, 0.115, np)
    out += sc * scrub

    r = int(SR * 0.10)
    mr = n - r
    rat = np.zeros(n)
    rat[r:] = _one_pole_lp(rng.standard_normal(mr), 3000.0, np) * _env(mr, 0.02, 0.19, np) * 0.10
    out += rat

    tail = int(SR * 0.05)
    out[-tail:] *= np.linspace(1.0, 0.0, tail)
    peak = float(np.max(np.abs(out)))
    if peak > 0:
        out = out / peak * 0.89
    return out.astype(np.float32)


def cmd_sfx(args):
    import numpy as np
    try:
        import soundfile as sf
    except ImportError:
        raise SystemExit('This needs soundfile (libsndfile):\n'
                         '  python -m venv .venv && .venv/Scripts/pip install numpy soundfile')
    out_dir = paths.ASSETS_SRC / 'audio'
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, (seed, hz, scrub, weight) in enumerate(LANDING_TAKES):
        y = _landing(seed, hz, scrub, weight, np)
        p = out_dir / ('carland%d.ogg' % i)
        if not args.write:
            print('  would write %-14s %.2fs' % (p.name, len(y) / SR))
            continue
        # VORBIS at the same sort of quality the rest of the pack's one-shots
        # are - these come out around 9 KB each, which is what carhit*.ogg cost
        sf.write(str(p), y, SR, format='OGG', subtype='VORBIS')
        print('  %-14s %.2fs, %s bytes' % (p.name, len(y) / SR, '{:,}'.format(p.stat().st_size)))
    if not args.write:
        print('\n--write to apply, then re-run `python tools/assets.py pack`')
    return 0


# =================================================================== main ===

COMMANDS = {
    'pack': cmd_pack, 'unpack': cmd_unpack, 'check': cmd_check, 'list': cmd_list,
    'shrink': cmd_shrink, 'atlas': cmd_atlas, 'gentex': cmd_gentex,
    'scene': cmd_scene, 'sfx': cmd_sfx,
}


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog='assets.py', description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=sorted(COMMANDS))
    ap.add_argument('--write', action='store_true',
                    help='apply the change instead of reporting it')
    ap.add_argument('--force', action='store_true',
                    help='pack: allow entries to be dropped; gentex: overwrite')
    args = ap.parse_args(argv)
    return COMMANDS[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
