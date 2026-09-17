#!/usr/bin/env python3
"""Everything that can be checked without a browser.

    python tools/check.py               every check
    python tools/check.py colour car    only these
    python tools/check.py --list        what there is

WHY ONE FILE
------------
There were twelve of these and they had twelve ways of saying the same three
things. Consolidating them is not tidiness for its own sake: a build log whose
sections all read differently is a build log people skim, and a checker whose
report format is its own is a checker that has to be understood before it can
be believed. Everything here prints through synx/report.py and every one of
them returns a count.

WHAT EACH ONE IS FOR, in one line, because "why does this exist" is the
question somebody will have at the moment it fails:

    shaders    a backtick inside GLSL closes the template literal it lives in
    dom        getElementById returns null and null writes fine until it does not
    settings   a setting that silently does nothing is invisible everywhere
    upscale    a reconstruction kernel's bugs are arithmetic, not pictures
    colour     a map decoded twice, a grade with a floor, eight bits undithered
    car        two parts of the car at the same depth crawl as the camera moves
    protocol   the game's and the server's copies of the wire format
    story      seven chapters, both paths, both endings, without driving any
    ramps      the ramp you see against the ramp you hit
    forge      the one structure the car drives OVER rather than past
    rec        the capture path, which must never block the frame
    radio      the soundtrack: five stations, and a panel that asks rather than knows
    ai         the rival, on every route, at every difficulty

THE FIVE THAT NEED NODE
-----------------------
settings, story, ramps, forge, rec and ai are about what the game's own
JavaScript DOES, so they run it: tools/probes/*.js measure, and every rule
about the measurements is here. See synx/jsprobe.py.
"""
import argparse
import json
import math
import pathlib
import re
import sys
from array import array

sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))

from synx import jsprobe, pak, paths                             # noqa: E402
from synx.report import Section, summary                         # noqa: E402


# ===================================================== 1. shader literals ===

def check_shaders():
    """A backtick inside a GLSL comment closes the literal the shader lives in.

    Every shader in this project is a JavaScript template literal, so a
    backtick used for emphasis in one of its comments ends the string and the
    file stops parsing - with an error pointing at whatever GLSL identifier
    happened to follow, which says nothing about the cause. It has happened
    twice.
    """
    s = Section('shader literals')
    n = 0
    for name in ('scene.js', 'game.js', 'fx.js', 'gl.js', 'hud.js'):
        p = paths.JS / name
        if not p.exists():
            continue
        src = paths.read(p)
        # Checking that the body between the two backticks contains no backtick
        # is vacuous - a non-greedy match stops at the first one it finds, so a
        # stray backtick simply produces a short "shader" and the check passes.
        # It did, and one got through. What identifies a premature close is
        # what FOLLOWS it: a shader literal is always assigned or passed, so
        # the next character is one of ; , ) or +. A backtick inside a GLSL
        # comment is followed by a letter.
        for i, m in enumerate(re.finditer(r'`#version 300 es', src), 1):
            n += 1
            close = src.find('`', m.start() + 1)
            if close < 0:
                s.fail('%s: shader #%d is never closed' % (name, i))
                break
            after = src[close + 1:].lstrip()[:1]
            if after not in ';,)+':
                line = src.count('\n', 0, close) + 1
                s.fail('%s: shader #%d closes at line %d followed by "%s" - a backtick'
                       ' inside the GLSL, most likely in a comment' % (name, i, line, after))
    if not s.problems:
        s.ok('%d shader literals, each closed where it should be' % n)
    return s.problems


# ======================================================== 2. DOM lookups ===

# Ids that are legitimately absent from the markup. Every entry needs a reason;
# an unexplained one is indistinguishable from the bug this exists to find.
CREATED_AT_RUNTIME = {
    # js/freeroam.js and js/modeselect.js build their tiles and actions as
    # elements and set data-* attributes on them; nothing looks these up by id.
}


def check_dom():
    """Every element the scripts look up, against the markup that carries it.

    getElementById returns null for an element that is not there, and null is a
    perfectly good value right up until something writes through it. The
    interface is bound once at construction and used a thousand frames later,
    so a panel deleted from index.html does not fail where it was deleted - it
    fails at the moment the one line that touches it runs, which may be inside
    a set piece halfway through a chapter.

    ONE CHECKER, EVERY PAGE. There are two documents with disjoint markup, so
    each page is read for both its ids and its own <script src> list, and a
    script is checked against the union of the ids of the pages that load it. A
    checker that cries wolf is a checker somebody switches off.
    """
    s = Section('DOM lookups')
    pages = sorted(p.name for p in paths.WEB.glob('*.html'))
    if not pages:
        s.fail('no .html in web/ - nothing to check against')
        return s.problems

    ids_of, scripts_of = {}, {}
    for page in pages:
        html = paths.read(paths.WEB / page)
        ids_of[page] = set(re.findall(r'\bid="([^"]+)"', html))
        scripts_of[page] = {m.split('?')[0].lstrip('./')
                            for m in re.findall(r'<script[^>]+src="([^"]+)"', html)}

    unreferenced = []

    def allowed_for(rel):
        out, included = set(), False
        for page in pages:
            if rel not in scripts_of[page]:
                continue
            included = True
            out |= ids_of[page]
        # A script no page loads is either dead or newly added and not wired
        # up. Failing on that is not this checker's job, but checking it
        # against nothing would pass it vacuously.
        if not included:
            unreferenced.append(rel)
            for page in pages:
                out |= ids_of[page]
        return out

    files = sorted(p.name for p in paths.JS.glob('*.js'))
    checked = 0
    for f in files:
        src = paths.read(paths.JS / f)
        seen = set(re.findall(r"getElementById\(\s*'([^']+)'\s*\)", src))
        # ...and the `const id = (n) => document.getElementById(n)` shorthand
        # every director binds through. Anchored on a word boundary so it does
        # not also match `.grid(`, `valid(` and the like.
        seen |= set(re.findall(r"\bid\(\s*'([^']+)'\s*\)", src))
        if not seen:
            continue
        allowed = allowed_for('js/' + f)
        missing = sorted(k for k in seen if k not in allowed and k not in CREATED_AT_RUNTIME)
        checked += len(seen)
        if missing:
            s.fail('%s: no element with id %s'
                   % (f, ', '.join('"%s"' % k for k in missing)))

    total = sum(len(ids_of[p]) for p in pages)
    s.note('checked %d lookups across %d files against %d ids in %s'
           % (checked, len(files), total, ', '.join(pages)))
    if unreferenced:
        s.note('(loaded by no page, so checked against all: %s)' % ', '.join(unreferenced))
    if not s.problems:
        s.ok('every element the scripts look up exists')
    return s.problems


# ===================================================== 3. wire protocol ====

def check_protocol():
    """Are the game's and the server's copies of the wire format still the same?

    crates/synx-net and synx-server/protocol are the same crate twice, and that
    is deliberate: the server has to be cloneable and buildable on its own by
    anybody who wants to run their own grid. They are held together at runtime
    by a fingerprint in the handshake - but that only covers what decides what
    a byte MEANS. A bounds check tightened on one side, a decoder fixed in one
    copy and not the other, pass the handshake and fail later.

    SKIPPED rather than failed when the server is not checked out. This
    repository is meant to build on its own.
    """
    s = Section('wire protocol copies')
    game = paths.CRATES / 'synx-net'
    server = paths.ROOT / 'synx-server' / 'protocol'
    if not (server / 'src').is_dir():
        s.skip('no server checkout beside this one')
        return 0
    if not (game / 'src').is_dir():
        s.fail('crates/synx-net is missing')
        return s.problems

    def norm(p):
        # Line endings only. A difference in whitespace inside a line is real.
        return paths.read(p).replace('\r\n', '\n')

    a_files = sorted(p.name for p in (game / 'src').glob('*.rs'))
    b_files = sorted(p.name for p in (server / 'src').glob('*.rs'))
    same = 0
    for f in sorted(set(a_files) | set(b_files)):
        if f not in a_files:
            s.fail(f + ': only in the server copy')
            continue
        if f not in b_files:
            s.fail(f + ': only in the game copy')
            continue
        a, b = norm(game / 'src' / f), norm(server / 'src' / f)
        if a == b:
            same += 1
            continue
        la, lb = a.split('\n'), b.split('\n')
        at = 0
        while at < len(la) and at < len(lb) and la[at] == lb[at]:
            at += 1
        # Say WHERE, so the fix does not start with another diff.
        s.fail('%s: differs from line %d\n      game:   %r\n      server: %r'
               % (f, at + 1, (la[at] if at < len(la) else '(end of file)').strip()[:72],
                  (lb[at] if at < len(lb) else '(end of file)').strip()[:72]))
    if norm(game / 'Cargo.toml') != norm(server / 'Cargo.toml'):
        s.fail('Cargo.toml: the two manifests differ')
    if not s.problems:
        s.ok('%d of %d source files identical' % (same, len(set(a_files) | set(b_files))))
    else:
        s.note('The fingerprint in the handshake catches a change to the format\'s shape,')
        s.note('but not a change to a bounds check or a decoder. Make the two copies')
        s.note('match before shipping either half.')
    return s.problems


# ================================================ 4. the colour pipeline ===

LUMA = (0.2126, 0.7152, 0.0722)


def check_colour():
    """Three questions a screenshot does not answer and that go wrong silently.

    1. IS EVERY TEXTURE DECODED EXACTLY ONCE? A colour map holds sRGB-encoded
       reflectance, and it has to be decoded BEFORE it is filtered - bilinear
       taps and mip levels are averages, and averaging gamma-encoded bytes and
       decoding afterwards is always too dark, because the curve is convex, and
       it compounds once per mip. So the decode lives in the texture unit. Two
       ways that breaks: a DATA map decoded as colour, which swings every
       normal toward -Z; and a colour map decoded TWICE, which turns the world
       black.

    2. DOES THE GRADE STILL LEAVE ROOM FOR BLACK? The split tone used to ADD an
       offset, which is a floor and not a tint: measured on a night frame the
       blue channel never went below 29 of 255 and not one pixel was within ten
       per cent of neutral.

    3. IS ANYTHING DITHERED BEFORE IT IS QUANTISED? Everything after the
       tonemapper is eight bits, and a night sky is a shallow gradient across a
       whole screen.
    """
    s = Section('colour management and grade')
    scene = paths.read(paths.JS / 'scene.js')
    game = paths.read(paths.JS / 'game.js')

    # --- the decode, once -------------------------------------------------
    # THE LOADER'S OWN RULE, lifted out of the source rather than restated. A
    # check that carries its own copy of the answer is a check that passes on
    # broken code.
    list_m = re.search(r'const DATA_TEXTURES = new Set\(\[([\s\S]*?)\]\);', scene)
    name_m = re.search(r'const DATA_NAME = /(.*)/([a-z]*);', scene)
    if not list_m:
        s.fail('DATA_TEXTURES is not declared in js/scene.js any more')
    if not name_m:
        s.fail('DATA_NAME - the normal-map naming convention - is gone from js/scene.js')
    if 'isDataTexture(name)' not in scene:
        s.fail('loadTexture no longer asks isDataTexture() - the sRGB decision is being'
               ' made some other way and this check cannot speak for it')
    explicit = set(re.findall(r"'([^']+)'", list_m.group(1))) if list_m else set()
    # JavaScript's /i is Python's re.I; nothing else in that literal differs.
    data_name = re.compile(name_m.group(1), re.I if 'i' in name_m.group(2) else 0) \
        if name_m else re.compile(r'(?!)')
    man_nrm = set()

    def is_data(n):
        return n in explicit or data_name.search(n) is not None or n in man_nrm

    # WHAT THE GAME ACTUALLY BINDS WHERE, from every place a binding is made -
    # a list assembled from one file passes while the other two are wrong.
    bound_data, bound_colour = set(), set()
    man = paths.read_json(paths.DATA / 'scene.json')
    for m in man.get('materials') or []:
        if m.get('tex'):
            bound_colour.add(m['tex'])
        if m.get('nrm'):
            bound_data.add(m['nrm'])
            man_nrm.add(m['nrm'])

    for p in sorted(paths.JS.glob('*.js')):
        src = paths.read(p)
        bound_data |= set(re.findall(r"\bnrm\s*[:=]\s*'([A-Za-z0-9_\-]+\.png)'", src))
        bound_colour |= set(re.findall(r"\btex\s*[:=]\s*'([A-Za-z0-9_\-]+\.png)'", src))
        bound_colour |= set(re.findall(r"\bemisTex\s*[:=]\s*'([A-Za-z0-9_\-]+\.png)'", src))
    # ...and the two the post chain reaches for directly, by the uniform they
    # land on rather than by a material field.
    for m in re.finditer(r"tex\['([A-Za-z0-9_\-]+\.png)'\][\s\S]{0,160}?U\.i\(gl, u\.(\w+)", game):
        (bound_data if re.search(r'Cookie|Shards|Crack', m.group(2))
         else bound_colour).add(m.group(1))

    # Nothing may be both. A texture used as an albedo on one material and a
    # normal map on another cannot be given a correct format at load time.
    for n in sorted(bound_data & bound_colour):
        s.fail(n + ' is bound BOTH as colour and as data - one format cannot serve both,'
               ' and whichever is chosen one of the two surfaces is decoded wrong')

    loaded = set(man.get('textures') or [])
    loaded |= set(re.findall(r"'([A-Za-z0-9_\-]+\.png)'", scene))
    unclassified = sorted(loaded - bound_data - bound_colour)
    if unclassified:
        s.note('not bound anywhere this can see: ' + ' '.join(unclassified))

    for n in sorted(bound_data):
        if not is_data(n):
            s.fail(n + ' is bound to a DATA sampler but is not in DATA_TEXTURES - the'
                   ' loader will give it an sRGB format and the decode will bend every'
                   ' value in it')
    for n in sorted(bound_colour):
        if is_data(n):
            s.fail(n + ' is bound to a COLOUR sampler but IS in DATA_TEXTURES - it will'
                   ' never be decoded and the surface will read too bright and too flat')
    s.ok('%d named outright, pattern /%s/, %d from the material table; %d bound as data,'
         ' %d bound as colour'
         % (len(explicit), name_m.group(1) if name_m else '', len(man_nrm),
            len(bound_data), len(bound_colour)))

    # The other half: with hardware decoding on, the shader must not decode a
    # SAMPLED value a second time. Uniform colours still must - they never pass
    # through a texture unit.
    for _ in re.finditer(r'toLinear\(\s*texture(?:Lod)?\s*\(', scene):
        s.fail('a sampled value is still being decoded by toLinear() in the shader -'
               ' with an sRGB format that squares the curve. Use texLinear().')
    for pat, why in (
            (r'vec3 texLinear', 'texLinear() is gone from the scene shader'),
            (r'#ifdef HW_SRGB', 'the HW_SRGB switch is gone from the scene shader'),
            (r'SRGB8_ALPHA8', 'nothing asks for an sRGB texture format any more'),
            (r'probeSrgb', 'the sRGB capability probe is gone - a driver that refuses'
                           ' generateMipmap on sRGB would silently ship black textures')):
        if not re.search(pat, scene):
            s.fail(why)
    s.ok('sampled colours decode in the sampler, uniform colours in the shader')

    # --- room for black ---------------------------------------------------
    post = (re.search(r'const POST_FRAG = `([\s\S]*?)`;', game) or [None, ''])
    post = post.group(1) if hasattr(post, 'group') else ''
    if not post:
        s.fail('POST_FRAG could not be read')
    # Matched on the SHAPE, not on a variable called `shadows`. Any term of the
    # form `<x> * (1.0 - col)` added into the picture is a lift toward <x> that
    # reaches full strength at col = 0 - a floor, whatever it is called. The
    # first version named the variable, and a mutation that inlined the
    # constant walked straight past it.
    if re.search(r'\*\s*\(\s*1\.0\s*-\s*col\s*\)', post):
        s.fail('the grade is ADDING a term that peaks at black - that is a floor, not a'
               ' tint, and nothing in the game can be darker than it')
    if re.search(r'\bcol\s*\+=\s*vec3\s*\(', post):
        s.fail('the grade adds a constant vec3 into the picture - it will show up as a'
               ' colour the frame can never go below')
    if ('shTint /= dot(shTint, LW)' not in post) or ('hiTint /= dot(hiTint, LW)' not in post):
        s.fail('a split-tone tint is not normalised to its own luminance - it will act as'
               ' an exposure change wherever it applies, which on a dark route is the'
               ' whole frame')
    for m in re.finditer(r'vec3 (shTint|hiTint) = vec3\(([^)]*)\);', post):
        try:
            v = [float(x) for x in m.group(2).split(',')]
        except ValueError:
            v = []
        if len(v) != 3:
            s.fail(m.group(1) + ' is unreadable')
            continue
        lum = sum(a * b for a, b in zip(v, LUMA))
        sat = (max(v) - min(v)) / max(v) if max(v) else 0.0
        s.ok('%s = (%s)  luminance %.3f, chroma spread %.0f%%'
             % (m.group(1), ', '.join(str(x) for x in v), lum, 100 * sat))
        if sat > 0.35:
            s.fail('%s spreads %.0f%% between its channels - past about a third it stops'
                   ' being a tint and starts being a colour filter' % (m.group(1), 100 * sat))
    if 'min(uGradeSat, max(1.0, room))' not in post:
        s.fail('the saturation push is no longer headroom-limited - it will drive the'
               ' weakest channel of a strongly tinted pixel below zero, and the clamp'
               ' turns that into a black hole with the wrong hue')

    # --- the dither -------------------------------------------------------
    final_m = re.search(r'const FINAL_FRAG = `([\s\S]*?)`;', game)
    final = final_m.group(1) if final_m else ''
    for name, src in (('POST_FRAG', post), ('FINAL_FRAG', final)):
        if not re.search(r'\(\s*(?:d1|e1)\s*-\s*(?:d2|e2)\s*\)\s*\*\s*\(1\.0 / 255\.0\)', src):
            s.fail(name + ' writes eight bits with no dither on it')
            continue
        at = src.find('1.0 / 255.0')
        if 'uGrain' in src[max(0, at - 220):at]:
            s.fail(name + "'s dither is gated on the grain setting - turning grain off"
                   ' would turn banding on')
        else:
            s.ok(name + ': triangular-PDF dither, one LSB, unconditional')
    return s.problems


# ================================================= 5. the car's own depth ===

# How close two faces have to be before the depth buffer cannot tell them
# apart. A car is about six units long, so a thousandth is inside the noise of
# any depth buffer the game will meet.
GAP = 0.001
# Centroids further apart than this are not the same surface. It is also the
# cell size of the hash below, so 27 neighbouring cells cover every candidate.
NEAR = 0.3


def _car_tris(man, verts, idx, part):
    """World-space triangles of one instance, as (normal, centroid).

    The indices in scene.bin are ABSOLUTE into the shared vertex buffer, not
    relative to the mesh's vOff.
    """
    mesh = man['meshes'][part['mesh']] if part['mesh'] < len(man['meshes']) else None
    if not mesh:
        return []
    m = part['m']
    stride = man['vertexStride']
    out = []

    def xf(i):
        b = i * stride
        x, y, z = verts[b], verts[b + 1], verts[b + 2]
        return (m[0] * x + m[4] * y + m[8] * z + m[12],
                m[1] * x + m[5] * y + m[9] * z + m[13],
                m[2] * x + m[6] * y + m[10] * z + m[14])

    for i in range(0, mesh['iCount'], 3):
        a = xf(idx[mesh['iOff'] + i])
        b = xf(idx[mesh['iOff'] + i + 1])
        c = xf(idx[mesh['iOff'] + i + 2])
        u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        ln = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
        if ln < 1e-12:
            continue
        out.append(((n[0] / ln, n[1] / ln, n[2] / ln),
                    ((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3,
                     (a[2] + b[2] + c[2]) / 3)))
    return out


def _hash(tris):
    """Centroids bucketed at NEAR, so a pair search looks at a handful.

    The JavaScript this replaces compared every triangle of one part against
    every triangle of the other - four million pairs for the shell against the
    lining alone, which is affordable in a JIT and is not here. Nothing about
    the answer changes: the first thing the inner loop did was reject anything
    further apart than NEAR, so bucketing at exactly that size and looking in
    the twenty-seven neighbouring cells reaches every candidate it could have.
    """
    grid = {}
    for t in tris:
        g = t[1]
        k = (int(math.floor(g[0] / NEAR)), int(math.floor(g[1] / NEAR)),
             int(math.floor(g[2] / NEAR)))
        grid.setdefault(k, []).append(t)
    return grid


def _coincidence(a_tris, b_grid):
    """What fraction of A's faces sit on a face of B."""
    hit = 0
    for an, ag in a_tris:
        gx = int(math.floor(ag[0] / NEAR))
        gy = int(math.floor(ag[1] / NEAR))
        gz = int(math.floor(ag[2] / NEAR))
        found = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for bn, bg in b_grid.get((gx + dx, gy + dy, gz + dz), ()):
                        if abs(an[0] * bn[0] + an[1] * bn[1] + an[2] * bn[2]) < 0.985:
                            continue
                        ox, oy, oz = ag[0] - bg[0], ag[1] - bg[1], ag[2] - bg[2]
                        if ox * ox + oy * oy + oz * oz > NEAR * NEAR:
                            continue
                        if abs(ox * bn[0] + oy * bn[1] + oz * bn[2]) < GAP:
                            found = True
                            break
                    if found:
                        break
                if found:
                    break
            if found:
                break
        hit += found
    return hit / len(a_tris) if a_tris else 0.0


def check_car():
    """Does any part of the car share a plane with another at the same depth?

    The shipped car is not a set of separate objects. Large parts of it are
    STICKERS: a lining, a window surround, a filler cap, a badge, each modelled
    directly on the surface it decorates with no gap at all. Two surfaces at
    the same depth have no correct answer - the rasteriser keeps whichever wins
    a floating-point comparison, and the winner changes when the camera moves
    by a thousandth of a unit. From the driving seat that is a flickering line
    around the window forty centimetres from the player's eye, alternating
    between the paint outside and the trim inside. It was reported exactly that
    way.

    js/scene.js fixes it with a depth-buffer offset per part, and the fix is
    invisible in a screenshot and silent when it breaks.
    """
    s = Section('car depth order')
    man = paths.read_json(paths.DATA / 'scene.json')
    blob = paths.read_bytes(paths.DATA / 'scene.bin')
    scene = paths.read(paths.JS / 'scene.js')

    # THE GAME'S OWN ORDERING, parsed out of js/scene.js. A check carrying its
    # own copy of the answer passes on broken code.
    table = re.search(r'const SHELL_ORDER = \{([\s\S]*?)\};', scene)
    if not table:
        s.fail('SHELL_ORDER is gone from js/scene.js')
        return s.problems
    order = {m.group(1): int(m.group(2))
             for m in re.finditer(r'^\s*([A-Za-z_]\w*)\s*:\s*(-?\d+)', table.group(1), re.M)}
    if 'gl.polygonOffset(' not in scene or 'POLYGON_OFFSET_FILL' not in scene:
        s.fail('nothing applies a polygon offset any more - the table is decorative')
    if 'this.shellDepth(p.name)' not in scene:
        s.fail('the car draw loop no longer calls shellDepth() per part')

    stride = man['vertexStride']
    verts = array('f')
    verts.frombytes(blob[:man['vertexCount'] * stride * 4])
    idx = array('I')
    idx.frombytes(blob[man['vertexBytes']:man['vertexBytes'] + man['indexCount'] * 4])

    by_name = {}
    for p in man['car']:
        if p['name'] not in by_name:
            by_name[p['name']] = _car_tris(man, verts, idx, p)

    # Only the parts that take part in the depth test. Glass and the additive
    # lamp halos are drawn with the depth write off, so they cannot fight
    # anything - see the blend pass in Scene.drawCar.
    glassy = set()
    for p in man['car']:
        mi = (p.get('mats') or [-1])[0]
        mat = man['materials'][mi] if mi is not None and mi >= 0 else None
        if mat and mat.get('mode') in ('glass', 'add'):
            glassy.add(p['name'])

    solid = sorted(n for n, t in by_name.items() if len(t) >= 4 and n not in glassy)
    s.note('(depth-tested parts only; %d glass/additive parts excluded)' % len(glassy))
    grids = {n: _hash(by_name[n]) for n in solid}
    pairs = 0
    for i, a in enumerate(solid):
        for b in solid[i + 1:]:
            f = max(_coincidence(by_name[a], grids[b]), _coincidence(by_name[b], grids[a]))
            if f < 0.05:
                continue
            pairs += 1
            oa, ob = order.get(a, 0), order.get(b, 0)
            if oa == ob:
                s.fail('%s and %s share a plane over %.0f%% of one of them and have the'
                       ' SAME depth offset (%d) - they will z-fight, and from the driving'
                       ' seat that is a crawling seam around the window' % (a, b, 100 * f, oa))
            else:
                s.ok('%-14s / %-14s %3.0f%% coincident   offsets %3d / %3d'
                     % (a, b, 100 * f, oa, ob))
    if not pairs:
        s.ok('no two depth-tested parts share a plane')
    return s.problems


# ============================================== 6. the upscaler's kernel ===

def _kernel(x):
    """Catmull-Rom, and why it has to go negative.

    The first version of this was a positive-only lobe, chosen because it is
    cheap and looked like a reasonable window. It is not: a reconstruction
    filter whose weights are all positive is a weighted average, and a weighted
    average of a one-texel line is a blur. These tests caught it - a bright
    line came back at 0.37 where plain bilinear left it at 0.75. What separates
    a resample from a blur is the negative lobe: taps either side of a feature
    must be SUBTRACTED, which is what keeps an edge an edge.
    """
    x = abs(x)
    if x < 1:
        return ((1.5 * x - 2.5) * x) * x + 1
    if x < 2:
        return (((-0.5 * x + 2.5) * x) - 4) * x + 2
    return 0.0


def _clamp(v, a, b):
    return a if v < a else (b if v > b else v)


def _easu(src, out_w, out_h, ox, oy):
    """The same arithmetic as easu() in UPSCALE_FRAG, in a language that can
    be run against known inputs with known right answers.

    A port rather than a shared implementation, because GLSL cannot be executed
    here - which means the two CAN drift, and the mitigation is that both are
    short, both carry the same reasoning, and this names the shader it mirrors.
    """
    w, h, get = src
    u = (ox + 0.5) / out_w
    v = (oy + 0.5) / out_h
    ppx, ppy = u * w - 0.5, v * h - 0.5
    fpx, fpy = math.floor(ppx), math.floor(ppy)
    frx, fry = ppx - fpx, ppy - fpy

    def at(dx, dy):
        return get(fpx + dx, fpy + dy)

    B, C = at(0, -1), at(1, -1)
    E, F, G, H = at(-1, 0), at(0, 0), at(1, 0), at(2, 0)
    I, J, K, L = at(-1, 1), at(0, 1), at(1, 1), at(2, 1)
    N, O = at(0, 2), at(1, 2)

    dir_ = [0.0, 0.0]
    ln = 0.0

    def quad(wq, c, d, uu, vv):
        nonlocal ln
        dir_[0] += (d - c) * wq
        dir_[1] += (vv - uu) * wq
        ln += (abs(d) + abs(c) + abs(uu) + abs(vv)) * wq

    quad((1 - frx) * (1 - fry), F - G, F - E, F - B, F - J)
    quad(frx * (1 - fry), G - H, G - F, G - C, G - K)
    quad((1 - frx) * fry, J - K, J - I, J - F, J - N)
    quad(frx * fry, K - L, K - J, K - G, K - O)

    dir_max = max(abs(dir_[0]), abs(dir_[1]))
    d2 = [dir_[0] / dir_max, dir_[1] / dir_max] if dir_max > 1e-6 else [1.0, 0.0]
    n = math.hypot(d2[0], d2[1]) or 1.0
    d2 = [d2[0] / n, d2[1] / n]

    len_n = _clamp(ln * 0.5, 0, 1) ** 2
    stretch = 1 + (2 - 1) * len_n

    # `dir` is the LUMA GRADIENT, so ax points ACROSS the feature and ay runs
    # ALONG it. The kernel must treat a tap displaced across the edge as FAR -
    # it belongs to the other side - and one displaced along it as NEAR. Getting
    # this pair the wrong way round averages across the edge it was meant to
    # follow, which is a worse blur than the bilinear it replaced.
    ax = d2
    ay = [-d2[1], d2[0]]
    sc = [stretch, 1.0 / stretch]

    offs = ((0, -1), (1, -1), (-1, 0), (0, 0), (1, 0), (2, 0),
            (-1, 1), (0, 1), (1, 1), (2, 1), (0, 2), (1, 2))
    cols = (B, C, E, F, G, H, I, J, K, L, N, O)

    acc = wsum = 0.0
    for q in range(12):
        dx = offs[q][0] - frx
        dy = offs[q][1] - fry
        rx = (dx * ax[0] + dy * ax[1]) * sc[0]
        ry = (dx * ay[0] + dy * ay[1]) * sc[1]
        wq = _kernel(math.sqrt(rx * rx + ry * ry))
        acc += cols[q] * wq
        wsum += wq
    return _clamp(acc / wsum if wsum > 1e-6 else F, min(F, G, J, K), max(F, G, J, K))


def _bilinear(src, out_w, out_h, ox, oy):
    w, h, get = src
    u = (ox + 0.5) / out_w * w - 0.5
    v = (oy + 0.5) / out_h * h - 0.5
    x0, y0 = math.floor(u), math.floor(v)
    fx, fy = u - x0, v - y0
    return (get(x0, y0) * (1 - fx) * (1 - fy) + get(x0 + 1, y0) * fx * (1 - fy)
            + get(x0, y0 + 1) * (1 - fx) * fy + get(x0 + 1, y0 + 1) * fx * fy)


def _src(w, h, f):
    return (w, h, lambda x, y: f(_clamp(x, 0, w - 1), _clamp(y, 0, h - 1)))


def check_upscale():
    """The spatial reconstruction kernel, checked numerically.

    The upscaler is the one piece of the renderer whose bugs are invisible in a
    screenshot and obvious in the arithmetic. A kernel that is not normalised
    changes the brightness of the whole frame; one whose clamp is wrong rings
    on every neon edge; one whose anisotropy is transposed averages ACROSS the
    edge it was meant to follow. All three look, at a glance, like "the low
    setting is a bit soft". It has already caught two real defects.
    """
    s = Section('upscaler kernel')

    # 1. A FLAT FIELD MUST COME BACK EXACTLY. If the weights are not
    #    normalised, the whole frame changes brightness.
    src = _src(64, 64, lambda x, y: 0.5)
    worst = max(abs(_easu(src, 128, 128, x, y) - 0.5)
                for y in range(0, 128, 4) for x in range(0, 128, 4))
    s.want(worst < 1e-9, 'a flat field is reproduced exactly (max error %.1e)' % worst)

    # 2. A LINEAR RAMP MUST NOT GAIN STRUCTURE. This is the case that separates
    #    a reconstruction from a sharpener: the sky must stay smooth.
    src = _src(64, 64, lambda x, y: x / 63)
    breaks, prev = 0, -1.0
    for x in range(128):
        v = _easu(src, 128, 128, x, 64)
        if v < prev - 1e-6:
            breaks += 1
        prev = v
    s.want(breaks == 0, 'a linear ramp stays monotonic (%d reversals)' % breaks)

    # 3. THE CLAMP MUST HOLD, or the anisotropic kernel is overshooting and
    #    neon will ring.
    src = _src(32, 32, lambda x, y: 1.0 if ((int(x) >> 2) + (int(y) >> 2)) % 2 else 0.0)
    out = sum(1 for y in range(0, 96, 2) for x in range(0, 96, 2)
              if not (-1e-9 <= _easu(src, 96, 96, x, y) <= 1 + 1e-9))
    s.want(out == 0, 'a hard checkerboard never leaves the source range (%d escapes)' % out)

    # 4. THE POINT OF THE WHOLE THING: on a diagonal edge - the case bilinear
    #    is worst at - it must be closer to the true high-resolution image.
    N = 96

    def edge(x, y, w):
        return _clamp((x - y) / (w * 0.02) + 0.5, 0, 1)

    src = _src(N // 2, N // 2, lambda x, y: edge(x / (N / 2), y / (N / 2), 1))
    ee = eb = 0.0
    for y in range(N):
        for x in range(N):
            t = edge(x / N, y / N, 1)
            ee += abs(_easu(src, N, N, x, y) - t)
            eb += abs(_bilinear(src, N, N, x, y) - t)
    ee /= N * N
    eb /= N * N
    s.want(ee < eb, 'a diagonal edge is closer to ground truth than bilinear'
           ' (%.4f vs %.4f, %.1f%% less error)' % (ee, eb, (1 - ee / eb) * 100))

    # 5. A ONE-PIXEL BRIGHT LINE - every neon rail in the game - must survive
    #    with more contrast than bilinear leaves it.
    N = 128
    src = _src(N // 2, N // 2, lambda x, y: 1.0 if x == 32 else 0.0)
    pe = max(_easu(src, N, N, x, 40) for x in range(N))
    pb = max(_bilinear(src, N, N, x, 40) for x in range(N))
    s.want(pe >= pb - 1e-9,
           "a one-texel line keeps at least bilinear's peak (%.3f vs %.3f)" % (pe, pb))
    return s.problems


# ============================================== 7. the settings schema =====

# Rows whose options are built at run time from the machine - the monitor list
# and the window-size ladder - so a static default index cannot be checked
# against them. Listed rather than skipped by a rule, because an exception
# nobody wrote down is a hole.
RUNTIME_OPTS = {'monitor', 'size'}
# Keys on the settings object that are not schema rows. `binds` is the keyboard
# map, which is a structure rather than an index and is validated where it is
# loaded.
NOT_ROWS = {'binds'}


def check_settings():
    """The settings schema, against the code that reads it.

    Settings are indices into lists of strings, stored in a file, edited by two
    screens and applied by a third piece of code. Every join in that chain
    fails silently: a wrong index is a legal value, a missing row makes a
    lookup return undefined, and undefined usually lands on a sensible-looking
    fallback. Nothing throws and the setting simply does not do anything.

    THIS IS NOT HYPOTHETICAL. When the graphics settings moved to the launcher,
    the lookup was still searching the rows that screen DRAWS rather than the
    schema. It returned null for 'quality', the caller fell back to HIGH, and
    every preset ran HIGH's passes - so LOW rendered shadows, reflections,
    volumetrics and a six-level bloom pyramid, which is the exact opposite of
    what LOW is for.
    """
    s = Section('settings schema')
    d = jsprobe.run('settings')
    rows = d['rows']
    by_key = {r['key']: r for r in rows if r['key']}

    # 1 and 2: well formed, uniquely keyed
    seen = set()
    for r in rows:
        if not r['key']:
            s.fail('a row has no key')
            continue
        if r['key'] in seen:
            s.fail('two rows share the key "%s"' % r['key'])
        seen.add(r['key'])
        if not r['label']:
            s.fail(r['key'] + ': no label')
        if not r['hint']:
            s.fail(r['key'] + ': no hint - a row whose cost is unexplained cannot be traded')
        if r['where'] not in ('game', 'launcher'):
            s.fail('%s: `where` is "%s", which is neither screen' % (r['key'], r['where']))
        if not isinstance(r['tab'], int):
            s.fail(r['key'] + ': no tab')
        if r['key'] in RUNTIME_OPTS:
            continue
        if not r['opts']:
            s.fail(r['key'] + ': no options')
            continue
        if r['def'] is None or not (0 <= r['def'] < len(r['opts'])):
            s.fail('%s: default %s is outside its %d options'
                   % (r['key'], r['def'], len(r['opts'])))
    if not s.problems:
        s.ok('%d rows, all well formed and uniquely keyed' % len(rows))

    # 3: the presets
    before = s.problems
    row = by_key.get('quality')
    if not row:
        s.fail('there is no PRESET row')
    else:
        for name in row['opts']:
            if name not in d['quality']:
                s.fail('PRESET offers "%s", which is not a quality preset' % name)
        for name in d['quality']:
            if name not in row['opts']:
                s.fail('quality preset "%s" is unreachable from PRESET' % name)
        # The presets must actually DIFFER. Four names for one configuration is
        # what the bug above produced, and it would pass every other check.
        sigs = {}
        for name in row['opts']:
            sig = json.dumps(d['quality'].get(name), sort_keys=True)
            if sig in sigs:
                s.fail('presets %s and %s are identical' % (sigs[sig], name))
            sigs[sig] = name
        if s.problems == before:
            s.ok('%d presets, each reachable and each distinct' % len(row['opts']))

    # 4: every key the game reads is a row, and every row is read
    before = s.problems
    # gamepad.js takes the whole object in configure(st), so the pad's rows are
    # read there rather than in game.js - and a check that looked only at
    # game.js would report them as controls that do nothing, which is the very
    # thing it is looking for.
    readers = ('game.js', 'gamepad.js')
    read = set()
    for f in readers:
        text = paths.read(paths.JS / f)
        read |= set(re.findall(r"optionOf\(\s*st\w*\s*,\s*'([^']+)'\s*\)", text))
        read |= set(re.findall(r'\bst\.([A-Za-z_$][\w$]*)', text))
    missing = sorted(k for k in read if k not in NOT_ROWS and k not in by_key)
    if missing:
        s.fail('the game reads settings no row declares: ' + ', '.join(missing))
    else:
        s.ok('%d settings read by %s, all declared' % (len(read), ' + '.join(readers)))
    # ...and the reverse. A row nothing reads is a control that does nothing,
    # which is the same bug wearing the other hat. The window rows are exempt:
    # the host reads those out of the save file in Rust, before any JavaScript.
    host = set(d['hostKeys'])
    unread = [r['key'] for r in rows if r['key'] not in read and r['key'] not in host]
    if unread:
        s.fail('rows nothing reads, so nothing they do can be seen: ' + ', '.join(unread))
    elif s.problems == before:
        s.ok('every row is read by something')

    # 5: the parallel tables
    before = s.problems
    fps = by_key.get('fps_cap')
    if fps and len(fps['opts']) != len(d['fpsCaps']):
        s.fail('FRAME LIMIT offers %d values but FPS_CAPS has %d'
               % (len(fps['opts']), len(d['fpsCaps'])))
    res = by_key.get('resolution')
    if res and len(res['opts']) != len(d['renderScales']):
        s.fail('RENDER SCALE offers %d but RENDER_SCALES has %d'
               % (len(res['opts']), len(d['renderScales'])))
    for k in d['hostKeys']:
        r = by_key.get(k)
        if not r:
            s.fail('HOST_KEYS names "%s", which is not a row' % k)
            continue
        # A host key must be a launcher row: the host reads it before any
        # JavaScript exists, so one owned by the in-game screen could never
        # reach it.
        if r['where'] != 'launcher':
            s.fail('"%s" is a host key but lives on the game screen' % k)
    if s.problems == before:
        s.ok('the parallel tables line up with their rows')
    return s.problems


# ================================================== 8. the course's ramps ===

def _scene_constants():
    """What js/scene.js uses to decide what it draws and where.

    Read out of the source rather than restated, so a change there fails here
    instead of quietly disagreeing.
    """
    src = paths.read(paths.JS / 'scene.js')

    def num(name):
        m = re.search(r'const\s+' + name + r'\s*=\s*([0-9.]+)', src)
        if not m:
            raise ValueError('js/scene.js no longer defines ' + name)
        return float(m.group(1))

    chunk = re.search(r'const CHUNK = (\d+);', src)
    if not chunk:
        raise ValueError('js/scene.js no longer defines CHUNK')
    # WHICH RAMPS THE BASE SCENE ACTUALLY BUILDS, read off its own filter
    # rather than assumed. This is the line that caused the menu's ghost ramps:
    # it used to exclude everything past LEVEL7_NEON_FROM on the grounds that
    # Chapter 7 draws its own, and the title screen does not load Chapter 7.
    filt = re.search(r'const RAMPS = \(global\.NR\.COURSE_RAMPS \|\| \[\]\)\s*\.filter\(([^;]+)\);',
                     src)
    if not filt:
        raise ValueError('js/scene.js no longer filters COURSE_RAMPS the way this check reads')
    return {'neonFrom': num('LEVEL7_NEON_FROM'), 'chunk': int(chunk.group(1)),
            'baseFilter': filt.group(1).strip()}


# Three kilometres of clear deck, which at the speed this route is taken at is
# the best part of a minute. The finale is a thirty-kilometre race against the
# R-IX and it has to be settled by the two cars, which means the player needs
# road to spend a reserve on, take a tow down and make the pass. A set piece
# that runs to the flag decides it instead.
RUN_IN = 5000


def check_ramps():
    """The ramps, and whether the one you see is the one you hit.

    A ramp on this course exists three times over: as a row in COURSE_RAMPS, as
    a window armed on the solver, and as geometry somebody builds. Nothing
    makes those three agree, and when they stop agreeing the car launches off a
    surface that is not where it is drawn. The report that started this called
    them ghost ramps: invisible things the cars were jumping through.
    """
    s = Section('ramps')
    K = _scene_constants()
    d = jsprobe.run('ramps')

    # --- who builds each one, and where -----------------------------------
    s.note('who builds it, and where')
    for r in d['ramps']:
        if r['drop']:
            # The Forge roof: js/chapters.js sweeps the running surface from
            # the foot of the climb to the bottom of the slope, against exactly
            # the marks NR.FORGE_ROOF publishes.
            owner, g0, g1 = 'forge breach', r['foot'], r['end']
        elif r['crest']:
            owner, g0, g1 = 'bore set piece', r['foot'], r['s']
        elif r['s'] >= K['neonFrom']:
            # Two builders, and that is correct: the base scene builds it for
            # every world that is not the finale - the title screen among them
            # - and Chapter 7 builds its own and hides the base one behind its
            # draw filter. Both run s-len..s, so whichever is on screen is the
            # same ramp in the same place.
            owner, g0, g1 = 'base + chapter 7', r['s'] - r['len'], r['s']
        else:
            owner, g0, g1 = 'generic wedge', r['s'] - r['len'], r['s']
        off = abs(g0 - r['armFrom']) + abs(g1 - r['armTo'])
        line = ('%-11s L%d  %-15s draws %.0f..%.0f   arms %.0f..%.0f'
                % (r['id'], r['level'], owner, g0, g1, r['armFrom'], r['armTo']))
        if off > 1:
            s.fail(line + '   MISPLACED BY %.0fu - a car climbing it goes through it' % off)
        else:
            s.note('  ' + line)

    # --- what the menu can fly --------------------------------------------
    # The title screen flies the attract car off ramps armed from this table
    # and it does not load any chapter's world - so a ramp the base scene
    # declines to build is a ramp the menu launches off thin air. That is
    # exactly what shipped: NEON HORIZON's three were left to Chapter 7, and
    # the last stretch of every loop of the reel showed a car climbing, jumping
    # and landing on empty road.
    s.note('js/scene.js builds: ' + K['baseFilter'])
    if re.search(r'LEVEL7_NEON_FROM|\b1320{2}0\b', K['baseFilter']):
        s.fail('the base scene excludes part of the course from its ramp geometry -'
               ' the attract reel will fly off ramps that are not drawn there')
    else:
        s.ok('every ramp in the table is geometry on the title screen')

    # --- the title reel ---------------------------------------------------
    # The menu's drive uses the same ramp table the solver does, so a stretch
    # that happens to contain a ramp will launch the car whether or not the
    # shot list was written for one - and a launch the camera is not framing
    # reads as a car taking off from flat road, which is what every ghost-ramp
    # report on the title screen has been.
    for e in d['reel']:
        inside = e['inside']
        s.note('  %6d..%-6d %-6s %-17s %s'
               % (e['from'], e['to'], e['kind'], e['name'],
                  ', '.join(inside) if inside else 'no ramp'))
        if e['kind'] == 'jump' and not inside:
            s.fail('%s at %d is cut as a jump and has no ramp in it' % (e['name'], e['from']))
        if e['kind'] != 'jump' and inside:
            s.fail('%s at %d is a %s stretch but contains %s - the menu will launch'
                   ' with no shot on it' % (e['name'], e['from'], e['kind'], ', '.join(inside)))

    # --- and exactly one chunk each ---------------------------------------
    # The generic builder emits per chunk and a ramp must land in one of them.
    # Two chunks claiming the same ramp is two coincident ramps.
    generic = [r for r in d['ramps'] if not r['crest']]
    for r in generic:
        claims = sum(1 for a in range(0, 180000, K['chunk']) if a <= r['s'] < a + K['chunk'])
        if claims != 1:
            s.fail('%s is claimed by %d chunks, not one' % (r['id'], claims))
    s.ok('%d generic ramp(s), each claimed by exactly one chunk' % len(generic))

    # --- every launch, driven ---------------------------------------------
    for reg in d['regions']:
        here = [r for r in d['ramps'] if reg['from'] < r['s'] < reg['to']]
        s.note('  L%d  %6d..%-6d  %d ramp(s), %d launch(es)'
               % (reg['level'], reg['from'], reg['to'], len(here), len(reg['flights'])))
        for fl in reg['flights']:
            on = [r for r in d['ramps'] if r['foot'] - 6 <= fl['a'] <= r['s'] + 8]
            s.note('        %-11s left at %.0f, down at %.0f, %.0fu out, %.1fu up'
                   % (on[0]['id'] if on else '???', fl['a'], fl['b'],
                      fl['b'] - fl['a'], fl['peak']))
            if not on:
                s.fail('a car left the road at %.0f with no ramp there' % fl['a'])
        for r in here:
            if r['drop']:
                # A ROAD RAMP MUST NOT FLY, AND MUST CLIMB. Its whole reason
                # for existing is that the car ends the section on the floor
                # under its own wheels; a launch off the far end is the
                # eighteen-unit drop this replaced.
                up = reg['driven'].get(r['id'], 0)
                s.note('        %-11s driven to %.1fu without leaving the ground'
                       % (r['id'], up))
                if up < r['h'] - 0.3:
                    s.fail('%s only climbed %.1fu of its %su deck' % (r['id'], up, r['h']))
                if any(r['foot'] - 10 < fl['a'] < r['end'] + 10 for fl in reg['flights']):
                    s.fail('%s launched the car - a ramp with a descent must not' % r['id'])
                continue
            if not any(abs(fl['a'] - r['s']) < r['len'] + r['crest'] + 10
                       for fl in reg['flights']):
                s.fail('%s at %s was never taken' % (r['id'], r['s']))

    # --- and what else is on that road ------------------------------------
    # A hazard is painted on the deck a telegraph-length before it arrives, so
    # two of them closer together than that telegraph put two warnings on the
    # road at once - and a player who commits to the cyan lane of the second is
    # in the red lane of the first. A hazard whose telegraph starts before its
    # own event has been announced is a warning painted on a deck with no set
    # piece running on it. Both were happening.
    L7 = d['level7']
    if not L7:
        s.fail('js/chapters.js no longer exports __SYNX_LEVEL7__')
    else:
        ev = {e['id']: e for e in L7['events']}
        prev = None
        for h in L7['hazards']:
            e = ev.get(h['eventId'])
            reads = h['s'] - h['telegraph']
            note = ''
            if e and reads < e['from']:
                note += '  READS %du BEFORE ITS EVENT' % (e['from'] - reads)
                s.fail('%s telegraphs before %s has begun' % (h['id'], h['eventId']))
            if prev and prev['eventId'] == h['eventId'] and reads < prev['s']:
                note += '  OVERLAPS ' + prev['id']
                s.fail('%s telegraphs while %s is still ahead of the car'
                       % (h['id'], prev['id']))
            s.note('  %-12s s=%d  reads from %d  %5du to the line%s'
                   % (h['id'], h['s'], reads, L7['to'] - h['s'], note))
            prev = h
        last = max((h['s'] for h in L7['hazards']), default=0)
        s.note('  the last hazard is %du from the line' % (L7['to'] - last))
        if L7['to'] - last < RUN_IN:
            s.fail('the last hazard is %du from the line, inside the %du run-in the'
                   ' finale is supposed to keep clear' % (L7['to'] - last, RUN_IN))

    # --- the body tilts with the ramp -------------------------------------
    # The solver measures the ramp's slope every frame a car is on the
    # structure and publishes it as rampPitch. For a long time NOTHING read it:
    # the car rose with the surface and was drawn dead level while it did, so
    # its bonnet went into the slope - six degrees on a coastal kicker,
    # eighteen on the blocked bore, which is the whole front of the car inside
    # the ramp. The Rust test proves the solver still sets it; this is the
    # other half, which no Rust test can see.
    game = paths.read(paths.JS / 'game.js')
    if not re.search(r'static bodyPitch\(car\)\s*\{[^}]*rampPitch[^}]*\}', game):
        s.fail('Game.bodyPitch no longer folds rampPitch in - every car on the course'
               ' will be drawn level on a slope')
    else:
        s.ok('Game.bodyPitch includes rampPitch')
    # ...and that nothing composes an orientation the long way round any more.
    # Minus bodyPitch itself, which is the one place that is SUPPOSED to spell
    # the sum out - without that cut this matches its own helper.
    body = re.sub(r'static bodyPitch\(car\)[\s\S]*?\n    \}', '', game)
    raw = re.findall(r'\(\s*\w+\.pitch\s*\|\|\s*0\s*\)\s*\+\s*\(\s*\w+\.roadPitch', body)
    if raw:
        s.fail('%d place(s) still compose pitch + roadPitch by hand instead of calling'
               ' Game.bodyPitch - those cars climb ramps flat' % len(raw))
    else:
        s.ok('no call site composes a body orientation without it')
    return s.problems


# ============================================== 9. the Aurora Forge roof ===

CELL = 16


def _surface_at(grid, x, z, ceil):
    """The highest surface under (x, z) at or below `ceil`, or None."""
    best = None
    for t in grid.get((math.floor(x / CELL), math.floor(z / CELL)), ()):
        ax, ay, az, bx, by, bz, cx, cy, cz = t
        den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
        if abs(den) < 1e-9:
            continue                                # edge-on; it has no top
        u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den
        v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den
        w = 1 - u - v
        if u < -1e-6 or v < -1e-6 or w < -1e-6:
            continue
        y = u * ay + v * by + w * cy
        if y > ceil:
            continue
        if best is None or y > best:
            best = y
    return best


def check_forge():
    """The one structure on the course the car drives OVER rather than past.

    The ramp check proves the window and the table agree; this builds the hall
    and drops rays through it to prove the DECK does, that the carriageway
    under it is clear, that the roof is intact either side of the breach, that
    nothing stands in the car's envelope on the way over, that both portals
    have a beam and no obstruction, and that the sorting floor's three bores
    are driveable tubes.
    """
    s = Section('Aurora Forge')

    # The probe needs the sample points before it can measure anything, and
    # deciding where to look is this side's job - so the marks are asked for
    # first, the grids are built here, and the whole set goes over at once.
    head = jsprobe.run('forge', request={'points': [], 'cell': CELL, 'sortSteps': 0})
    R = head['roof']

    plan = []

    def want(kind, s_, lat):
        plan.append((kind, s_, lat))

    for sv in range(int(R['foot']) + 8, int(R['floor']) - 6, 37):
        for lat in (-14, 0, 14):
            want('deck', sv, lat)
    for sv in (R['clearFrom'] + 150, R['deck'] + 200, R['deck'] + 600, R['edge'] - 60):
        for lat in (-16, -8, 0, 8, 16):
            want('hall', sv, lat)
    for sv in (R['clearFrom'] - 500, R['clearFrom'] - 60, R['clearTo'] + 60, R['clearTo'] + 500):
        for lat in (-12, 0, 12):
            want('roof', sv, lat)
    for sv in range(int(R['foot']) + 4, int(R['floor']) - 4, 11):
        for lat in range(-18, 19, 3):
            want('envelope', sv, lat)
    for sv in (112040, 131460):
        for lat in (-12, 0, 12):
            want('portal', sv, lat)

    d = jsprobe.run('forge', request={'points': [[p[1], p[2]] for p in plan],
                                      'cell': CELL, 'sortS': 120000, 'sortSteps': 40})
    s.note('hall built: {:,} vertices, {:,} triangles'
           .format(d['built']['vertices'], d['built']['triangles']))

    tris = array('f')
    tris.frombytes((pathlib.Path(d['_dir']) / d['tris']['file']).read_bytes())
    grid = {}
    for i in range(0, len(tris), 9):
        t = tuple(tris[i:i + 9])
        x0, x1 = min(t[0], t[3], t[6]), max(t[0], t[3], t[6])
        z0, z1 = min(t[2], t[5], t[8]), max(t[2], t[5], t[8])
        for gx in range(math.floor(x0 / CELL), math.floor(x1 / CELL) + 1):
            for gz in range(math.floor(z0 / CELL), math.floor(z1 / CELL) + 1):
                grid.setdefault((gx, gz), []).append(t)
    s.note('%d triangle(s) within reach of the %d sample points'
           % (len(tris) // 9, len(plan)))

    pts = {}
    for (kind, sv, lat), q in zip(plan, d['probes']):
        pts.setdefault(kind, []).append((sv, lat, q[0], q[1], q[2]))

    # 1. the running surface is where the car will be
    worst_err, worst_at, holes = 0.0, 0, 0
    for sv, lat, x, z, want_y in pts.get('deck', ()):
        got = _surface_at(grid, x, z, want_y + 0.9)
        if got is None:
            holes += 1
            if holes <= 4:
                s.fail('nothing under the car at s=%.0f lat=%d' % (sv, lat))
            continue
        err = abs(got - want_y)
        if err > worst_err:
            worst_err, worst_at = err, sv
        if err > 0.22:
            s.fail('the deck at s=%.0f lat=%d is %.2f but the solver puts the car at %.2f'
                   % (sv, lat, got, want_y))
    s.note('%d drop tests along the climb, the deck and the slope; %d found nothing'
           % (len(pts.get('deck', ())), holes))
    if not holes and worst_err <= 0.22:
        s.ok('worst disagreement with the solver: %.3fu at s=%.0f' % (worst_err, worst_at))

    # 2. the hall under it is empty
    by_s = {}
    for sv, lat, x, z, want_y in pts.get('hall', ()):
        y = _surface_at(grid, x, z, want_y - 2.4)
        if y is not None and y > 8.6:
            by_s.setdefault(sv, []).append(y)
    for sv, hits in sorted(by_s.items()):
        s.fail('%d surface(s) still hang over the carriageway at %.0f (highest %.1f)'
               % (len(hits), sv, max(hits)))
    if not by_s:
        s.ok('nothing hangs over the carriageway at any of the four stations')

    # 3. and the roof is back on either side
    found = {}
    for sv, lat, x, z, _ in pts.get('roof', ()):
        y = _surface_at(grid, x, z, 40)
        found[sv] = found.get(sv, 0) + (1 if y is not None and y > 15.5 else 0)
    for sv, n in sorted(found.items()):
        if n < 3:
            s.fail('the roof is open at %.0f (%d of 3 points), which is outside the breach'
                   % (sv, n))
    if found and all(n >= 3 for n in found.values()):
        s.ok('the roof is intact at all four stations either side of the breach')

    # 4. nothing in the car envelope on the roof
    worst, where, lateral = 0.0, 0, 0
    for sv, lat, x, z, deck in pts.get('envelope', ()):
        # The car is about 1.5 units tall. Anything standing between the deck
        # and four units over it is something it would hit; a gantry above that
        # is something it passes under.
        y = _surface_at(grid, x, z, deck + 4.0)
        if y is not None and y > deck + 0.35 and y - deck > worst:
            worst, where, lateral = y - deck, sv, lat
    s.note('tallest obstruction inside the barrier: +%.2fu%s'
           % (worst, (' at s=%.0f lat=%d' % (where, lateral)) if worst else ''))
    if worst > 0.9:
        s.fail('something stands %.2fu proud of the running surface at s=%.0f lat=%d'
               % (worst, where, lateral))
    else:
        s.ok('nothing stands in the car envelope on the roof')

    # 5. the portals
    for sv in sorted({p[0] for p in pts.get('portal', ())}):
        name = 'entry' if sv < 120000 else 'exit'
        head_y, blocked = None, 0
        for psv, lat, x, z, _ in pts['portal']:
            if psv != sv:
                continue
            y = _surface_at(grid, x, z, 40)
            if y is not None and (head_y is None or y > head_y):
                head_y = y
            low = _surface_at(grid, x, z, 3.0)
            if low is not None and low > 0.6:
                blocked += 1
        s.note('%s at %d: lintel at y=%s, road blocked at %d of 3 points'
               % (name, sv, 'NONE' if head_y is None else '%.1f' % head_y, blocked))
        if head_y is None or head_y < 15:
            s.fail('the %s portal has no beam over the road' % name)
        if blocked:
            s.fail('the %s portal has something standing in the road' % name)

    # 6. the sorting floor: three driveable bores
    # Geometry with no collider that stands in the road is geometry the car
    # goes through, and two of these three bays are the RIGHT answer: the trial
    # requires them to be driveable end to end at speed. What it caught: the
    # chamber floor was a slab standing 1.1 above the road so every bore had a
    # kerb across its mouth; the jaw plate sat on the road through the car in
    # all three mouths at once; and each machine carried its legs and rams into
    # the bay NEXT DOOR at windscreen height.
    CAR_TOP, DIVIDER, WALL_W = 1.6, 6.8, 3.2
    walls = ((-DIVIDER - WALL_W / 2, -DIVIDER + WALL_W / 2),
             (DIVIDER - WALL_W / 2, DIVIDER + WALL_W / 2))
    bays = (('left', -18.0, -8.4), ('centre', -5.2, 5.2), ('right', 8.4, 18.0))
    seen, worst_in, boxes = set(), None, 0
    for step in d['gate']:
        boxes = len(step)
        for sv, lat, y, sx, sy, sz, part in step:
            lo, hi = y - sy / 2, y + sy / 2
            if hi <= 0.20 or lo >= CAR_TOP:
                continue
            l, r = lat - sx / 2, lat + sx / 2
            if any(l >= w[0] - 1e-3 and r <= w[1] + 1e-3 for w in walls):
                continue
            for name, blo, bhi in bays:
                if r <= blo + 1e-3 or l >= bhi - 1e-3:
                    continue
                into = min(r, bhi) - max(l, blo)
                key = (name, part, round(lat, 1), round(lo, 2))
                if key not in seen:
                    seen.add(key)
                    s.fail('%s stands %.2f units into the %s bore at s+%.0f, y=%.2f..%.2f'
                           % (part, into, name, sv - d['sortS'], lo, hi))
                if worst_in is None or into > worst_in:
                    worst_in = into
    s.note('%d boxes per gate, sampled over a full baler cycle' % boxes)
    if worst_in is None:
        s.ok('nothing below the roof of a car in any of the three bays')
    return s.problems


# ================================================== 10. the recorder ======

def check_rec():
    """The recorder's plumbing, which is the part that was actually broken.

    `cargo test -p synx-rec` proves the encoder and the container. This proves
    the worker answers, gives every pixel buffer back and writes playable
    files, and that the capture loop paces itself, never blocks the frame and
    collects what it starts.
    """
    s = Section('recorder')
    d = jsprobe.run('rec')
    if not d.get('built'):
        s.fail('web/wasm/synx_rec.wasm is not built - run the build first')
        return s.problems

    w = d['worker']
    if not w.get('began'):
        s.fail('the worker never answered begin')
        return s.problems
    if not w['began']['ok']:
        s.fail('the worker refused a 128x72 ring')
        return s.problems
    s.ok('begin: frame buffer %d bytes, pacing every %d ms'
         % (w['began']['frameLen'], w['began']['step']))
    if w['began']['step'] != 50:
        s.fail('20 fps should pace at 50 ms, not %d' % w['began']['step'])

    if w['handedBack'] != w['handedOut']:
        s.fail('the worker kept %d of %d pixel buffers - the pool bleeds one per frame'
               ' and the page allocates for ever'
               % (w['handedOut'] - w['handedBack'], w['handedOut']))
    else:
        s.ok('every one of %d pixel buffers came back to be refilled' % w['handedOut'])

    st = w['stats']
    if not st:
        s.fail('the worker did not report its stats')
    else:
        s.ok('held %d frames, %d KB, %d mark(s), %d ms'
             % (st['frames'], st['bytes'] // 1024, st['marks'], st['spanMs']))
        if st['frames'] < 50:
            s.fail('only %d frames were kept out of 200 offered' % st['frames'])
        if st['marks'] != 1:
            s.fail('expected exactly one mark, got %d' % st['marks'])

    for c in w['clips']:
        if not c['came']:
            s.fail(c['name'] + ': no clip came back')
            continue
        if not c['frames'] or not c['length']:
            s.fail(c['name'] + ': the clip was empty')
            continue
        if not c['riff']:
            s.fail(c['name'] + ': what came back is not a RIFF/AVI file')
            continue
        s.ok('%-15s %4d frames, %7d bytes%s'
             % (c['name'], c['frames'], c['length'],
                ('  named "%s"' % c['label']) if c['label'] else ''))
        if c['kind'] == 3 and c['label'] != 'OVERTAKE':
            s.fail('the automatic mode should have named its window after the mark'
                   ' inside it, not "%s"' % c['label'])
    if w['afterEnd']:
        s.fail('the ring is still live after end')
    else:
        s.ok('end gave the ring back')

    c = d['capture']
    if c.get('noConfigure'):
        s.fail('NR.Record has no configure')
        return s.problems
    if not c['started']:
        s.fail('the recorder did not start')
        return s.problems
    if not c['ready']:
        s.fail('the recorder never became ready')
        return s.problems
    if c['sync']:
        for line in c['sync']:
            s.fail(line)
    else:
        s.ok('nothing in the capture path blocks: no CPU readPixels, no timed wait,'
             ' no finish')
    s.ok('%d readbacks started over %d ms of a 144 Hz game' % (c['reads'], round(c['ms'])))
    # 200 frames at 144 Hz is about 1389 ms, which is about 42 frames at 30.
    if c['reads'] > 55:
        s.fail('%d readbacks for ~42 wanted frames - the pacing gate is not working'
               % c['reads'])
    if c['reads'] < 30:
        s.fail('only %d readbacks in %d ms' % (c['reads'], round(c['ms'])))
    if c['fences'] != c['reads']:
        s.fail('%d readbacks but %d fences - one is unguarded' % (c['reads'], c['fences']))
    if c['flushes'] != c['fences']:
        s.fail('a fence was left in an unsubmitted command buffer')
    if c['blits'] != c['reads']:
        s.fail('a readback happened without a downscale blit')
    s.ok('%d of them collected once the GPU signalled, %d posted on'
         % (c['collected'], c['posted']))
    if c['collected'] < c['reads'] - 4:
        s.fail('%d readbacks were started and never collected' % (c['reads'] - c['collected']))
    return s.problems


# ================================================== 11. the campaign ======

# The camera's own vocabulary, from conversationShot. A tag outside this set
# falls through to `wide`, which is not an error the eye can catch.
SHOTS = {'player', 'closeup', 'rival', 'over', 'two', 'low',
         'wheel', 'rear', 'road', 'sky', 'wide'}
# What one line of a dialogue card can hold before it sets type it cannot show.
# Measured against the widest line that reads correctly in the shipped card at
# the narrowest supported window.
MAX_LINE = 116
# A finished line that a held key can leave faster than this is a line nobody
# reads. Four of them in a row is the opening card going past before it
# arrives, which is exactly what was reported.
MIN_DWELL = 0.38


def _check_line(s, cast, where, line):
    if line.get('bad'):
        return s.fail(where + ': not a line')
    who = cast.get(line['speaker'])
    if who is None:
        return s.fail('%s: unknown speaker "%s"' % (where, line['speaker']))
    if not isinstance(line['text'], str) or not line['text'].strip():
        return s.fail(where + ': empty text')
    for part in line['text'].split('\n'):
        if len(part) > MAX_LINE:
            s.fail('%s: %d characters on one line (max %d)' % (where, len(part), MAX_LINE))
    exp = line['expression'] or 'neutral'
    if exp not in who:
        s.fail('%s: %s has no "%s" portrait (has: %s)'
               % (where, line['speaker'], exp, ', '.join(who)))
    if line['shot'] and line['shot'] not in SHOTS:
        s.fail('%s: unknown shot "%s"' % (where, line['shot']))
    if line['wait'] is not None and not (0 <= line['wait'] <= 1.6):
        s.fail('%s: wait %s is outside 0..1.6' % (where, line['wait']))
    if line['hold'] is not None and not (0 <= line['hold'] <= 2.5):
        s.fail('%s: hold %s is outside 0..2.5' % (where, line['hold']))


def _codeonly(src):
    """The source with comments and string CONTENTS removed, newlines kept.

    The first version of the door check below grepped the class body and passed
    on the broken build, because the comment explaining the fix contains the
    very words it was grepping for. Stripping first is also what makes the
    class spans right rather than right by luck: a brace inside a comment or a
    string cannot move the end of a class.
    """
    out = []
    i, n, mode = 0, len(src), 0     # 0 code, 1 //, 2 /* */, 3 ' 4 " 5 backtick
    tick = chr(96)
    while i < n:
        c = src[i]
        d = src[i + 1] if i + 1 < n else ''
        if mode == 0:
            if c == '/' and d == '/':
                mode, i = 1, i + 2
                continue
            if c == '/' and d == '*':
                mode, i = 2, i + 2
                continue
            if c in ("'", '"', tick):
                mode = 3 if c == "'" else (4 if c == '"' else 5)
                out.append(c)
                i += 1
                continue
            out.append(c)
            i += 1
            continue
        if mode == 1:
            if c == '\n':
                mode = 0
                out.append('\n')
            i += 1
            continue
        if mode == 2:
            if c == '*' and d == '/':
                mode, i = 0, i + 2
            else:
                if c == '\n':
                    out.append('\n')
                i += 1
            continue
        if c == '\\':                                # an escape inside a string
            i += 2
            continue
        if (mode == 3 and c == "'") or (mode == 4 and c == '"') or (mode == 5 and c == tick):
            mode = 0
            out.append(c)
            i += 1
            continue
        if c == '\n':
            out.append('\n')
        i += 1
    return ''.join(out)


def _dispatch_modes():
    """The modes js/story.js knows how to update, READ OUT OF THE DISPATCHER.

    This used to be a hand-written list and it went stale the first time a mode
    was added: `endingCredits` was wired into the switch and into both endings,
    and the check failed four paths for a mode the game handles perfectly well.
    A test that fails when the code is EXTENDED rather than when it breaks is a
    test people learn to ignore.

    Adding a mode and a handler together now passes silently, which is correct;
    adding a mode WITHOUT a handler still fails, which is what this was written
    to catch.
    """
    src = paths.read(paths.JS / 'story.js')
    at = src.find('switch (this.mode)')
    if at < 0:
        raise ValueError('js/story.js no longer dispatches on this.mode')
    end = src.find('default: break;', at)
    if end < 0:
        raise ValueError('the mode switch in js/story.js has no default arm')
    out = {'none'} | set(re.findall(r"case '([A-Za-z0-9_]+)':", src[at:end]))
    if len(out) < 8:
        raise ValueError('only %d modes found - the switch was not parsed' % len(out))
    return out


def check_story():
    """The whole campaign, walked down both paths without driving any of it.

    A scene in js/story.js is an array of lines or a pure function of the run's
    state, and the only state it may read is the context object storyCtx
    builds. So every scene can be resolved here for every value that context
    can take, and what comes out is exactly what a player would see.
    """
    s = Section('story')
    d = jsprobe.run('story')
    sc = d['script']
    cast = sc['cast']

    # --- the script -------------------------------------------------------
    total = 0
    for ch in sc['chapters']:
        if ch.get('missing'):
            s.fail('chapter %d is missing' % ch['id'])
            continue
        counts = []
        for v in ch['variants']:
            n = 0
            for key in ('coldOpen', 'intro', 'win'):
                lines = v['parts'][key]
                if lines is None:
                    s.fail('ch%d %s is not an array' % (ch['id'], key))
                    continue
                for i, line in enumerate(lines):
                    _check_line(s, cast, 'ch%d %s[%s] #%d' % (ch['id'], key, v['path'], i), line)
                n += len(lines)
            counts.append(n)
            if not (0 <= v['diff'] <= 3):
                s.fail('ch%d difficulty %s is outside 0..3' % (ch['id'], v['diff']))
            if not isinstance(v['brief'], str):
                s.fail('ch%d brief is not text' % ch['id'])
            if not v['rating']:
                s.fail('ch%d has no rating on path %s' % (ch['id'], v['path']))
        total += counts[0] if counts else 0
        if counts and all(n == 0 for n in counts):
            s.fail('ch%d has no dialogue at all' % ch['id'])
        # A FORK HAS TO ACTUALLY FORK. A chapter that declares itself
        # path-aware and then says the same thing either way is reported rather
        # than shipped.
        diff_forks = ch['diffEdge'] != ch['diffOpen']
        if ch['declared'] and not ch['textForks'] and not diff_forks:
            s.fail('ch%d is written as path-aware but reads identically either way' % ch['id'])
        s.note('  ch%d %-15s lines %3d..%-3d%s'
               % (ch['id'], ch['title'], min(counts), max(counts),
                  ('   branches:' + (' dialogue' if ch['textForks'] else '')
                   + (' difficulty %s->%s' % (ch['diffOpen'], ch['diffEdge'])
                      if diff_forks else '')) if ch['textForks'] or diff_forks else ''))
    s.ok('%d lines on the default path' % total)

    # --- the decisions ----------------------------------------------------
    keys = sorted(sc['choices'])
    if len(keys) != 3:
        s.fail('expected three decisions, found %d' % len(keys))
    for k in keys:
        dch = sc['choices'][k]
        if not dch['chapterExists']:
            s.fail('%s hangs off chapter %s, which does not exist' % (k, dch['after']))
            continue
        for side in ('edge', 'open'):
            sd = dch[side]
            if not (sd['label'] and sd['sub'] and sd['tag']):
                s.fail('%s.%s is incomplete' % (k, side))
                continue
            if not sd['echo']:
                s.fail('%s.%s has no spoken answer' % (k, side))
            for i, line in enumerate(sd['echo']):
                _check_line(s, cast, '%s.%s.echo #%d' % (k, side, i), line)
        s.note('  %s  after ch%s  %s  /  %s'
               % (k, dch['after'], dch['edge']['label'], dch['open']['label']))
    # THE ARITHMETIC THAT GUARANTEES AN ENDING, enumerated rather than argued:
    # three decisions of plus or minus one can never sum to zero.
    reach = {'edge': 0, 'open': 0}
    zero = 0
    for a in (1, -1):
        for b in (1, -1):
            for c in (1, -1):
                t = a + b + c
                if t == 0:
                    zero += 1
                reach['edge' if t > 0 else 'open'] += 1
    if zero:
        s.fail('%d of the eight decision paths sum to zero' % zero)
    else:
        s.ok('all eight decision paths reach an ending (%d edge, %d open)'
             % (reach['edge'], reach['open']))

    # --- the endings ------------------------------------------------------
    for key in ('edge', 'open'):
        E = sc['endings'].get(key)
        if not E:
            s.fail('no "%s" ending' % key)
            continue
        for part in ('lines', 'coda'):
            if not E[part]:
                s.fail('%s ending has no %s' % (key, part))
                continue
            for i, line in enumerate(E[part]):
                _check_line(s, cast, '%s.%s #%d' % (key, part, i), line)
        if len(E['cards']) < 3:
            s.fail('%s ending has fewer than three closing cards' % key)
        for c in E['cards']:
            if c != 3:
                s.fail('%s ending has a malformed card' % key)
        if not (E['title'] and E['subtitle'] and E['kicker']):
            s.fail('%s ending is missing its card text' % key)
        # Both endings have to END: the player and Ryker both have to be given
        # somewhere to land. Ryker may land in either skin - in one ending the
        # last thing he says is said through the machine wearing him, which is
        # that ending rather than an omission.
        speakers = {l['speaker'] for l in E['lines'] + E['coda'] if not l.get('bad')}
        if 'PLAYER' not in speakers:
            s.fail('%s ending never gives PLAYER a line' % key)
        if 'RYKER' not in speakers and 'RAPTOR' not in speakers:
            s.fail('%s ending never gives Ryker a line, in either skin' % key)
        s.note('  %-20s cost %3d   coda %3d   cards %d'
               % (E['title'], len(E['lines']), len(E['coda']), len(E['cards'])))

    # --- the flow ---------------------------------------------------------
    dispatch = _dispatch_modes()
    flow = d['flow']
    plans = (('every decision EDGE', 'edge', 'edge', 3),
             ('every decision OPEN', 'open', 'open', -3),
             ('split, leaning EDGE', 'splitEdge', 'edge', 1),
             ('split, leaning OPEN', 'splitOpen', 'open', -1))
    for label, key, ending, resolve in plans:
        r = flow['runs'].get(key) or {}
        if r.get('threw'):
            s.fail('%s: threw - %s' % (label, r['threw']))
            continue
        if r['timedOut']:
            s.fail('%s: the campaign never reached the hub' % label)
            continue
        if r['completed'] != sc['lastChapter']:
            s.fail('%s: completed %d of %d chapters'
                   % (label, r['completed'], sc['lastChapter']))
        if len(r['asked']) != 3:
            s.fail('%s: %d decisions asked, expected 3' % (label, len(r['asked'])))
        if r['resolve'] != resolve:
            s.fail('%s: resolve came to %s, expected %d' % (label, r['resolve'], resolve))
        if r['ending'] != ending:
            s.fail('%s: reached "%s", expected "%s"' % (label, r['ending'], ending))
        for m in r['seen']:
            if m not in dispatch:
                s.fail('%s: mode "%s" has no entry in the dispatch table' % (label, m))
        if r['fastest'] is not None and r['fastest'] < MIN_DWELL:
            s.fail('%s: a finished line was left after only %.3fs of a held key -'
                   ' a conversation can be walked through again' % (label, r['fastest']))
        E = sc['endings'].get(r['ending']) or {}
        s.note('  %-21s%4d lines   %.1f min   min dwell %.2fs   -> %s'
               % (label, r['lines'], r['frames'] * d['dt'] / 60, r['fastest'] or 0,
                  E.get('title')))

    # THE CLAIM ON THE CLOSING CARD, TESTED. Finish the campaign one way, then
    # play it again on the same save deciding the other way. If a decision were
    # only ever asked once - which is how it was first written - this run would
    # end where the first one did and the card would be lying.
    rp = flow['replay']
    if rp.get('threw'):
        s.fail('replay: threw - ' + rp['threw'])
    elif rp['first']['ending'] != 'edge':
        s.fail('replay: the first run did not reach the EDGE ending')
    elif rp['again']['ending'] != 'open':
        s.fail('replay: deciding the other way still ended on "%s" - the second ending'
               ' is unreachable without wiping the save' % rp['again']['ending'])
    elif len(rp['again']['asked']) != 3:
        s.fail('replay: only %d decisions were re-asked' % len(rp['again']['asked']))
    else:
        s.note('  %-21s%4d lines   resolve %s -> %s   -> %s'
               % ('replay, decided anew', rp['again']['lines'], rp['first']['resolve'],
                  rp['again']['resolve'], sc['endings'][rp['again']['ending']]['title']))

    p = flow['prologue']
    if p.get('threw'):
        s.fail('the prologue threw - ' + p['threw'])
    else:
        if not p['lines']:
            s.fail('the prologue played no dialogue at all')
        if p['timedOut']:
            s.fail('the prologue never handed over to Chapter 1')
        if p['fastest'] is not None and p['fastest'] < MIN_DWELL:
            s.fail('a prologue line was left after only %.3fs of a held key - the opening'
                   ' card can still be walked past' % p['fastest'])
        for m in ('prologue', 'prologueDialogue', 'tutorial'):
            if m not in p['seen']:
                s.fail('the prologue never entered "%s"' % m)
        s.note('  %-21s%4d lines   %.0f s   min dwell %.2fs'
               % ('prologue -> chapter 1', p['lines'], p['frames'] * d['dt'],
                  p['fastest'] or 0))

    # --- chapters that finish on their own terms --------------------------
    # Five of the seven chapters end at a finish line: the car crosses it, two
    # lines in Game.update decide who won, and js/story.js runs the ending. The
    # flow walk above resolves every chapter that way, which is exactly why it
    # cannot see the other kind: a chapter whose DIRECTOR decides the result
    # and then calls completeChapter.
    #
    # completeChapter has a door on it. A chapter completes when the player won
    # it, or when it is the one chapter whose written ending is a defeat and
    # that defeat was earned. A director that calls it having declared neither
    # has written an ending the door then throws away.
    #
    # That is not hypothetical - it is what BROKEN CIRCUIT did. Chapter 6 ends
    # on the calibration run about a kilometre short of a line, so `won` was
    # still false from resetCar when Javas finished congratulating the player.
    # Every successful run of the Forge was recorded as a loss, NEON HORIZON
    # was never unlocked, and the only symptom was one console warning nobody
    # has a console open to read.
    code = _codeonly(paths.read(paths.JS / 'chapters.js'))
    lines = code.split('\n')
    classes = []
    for i, line in enumerate(lines):
        m = re.match(r'^\s*class\s+([A-Za-z0-9_$]+)', line)
        if not m:
            continue
        depth, end = 0, i
        for j in range(i, len(lines)):
            depth += lines[j].count('{') - lines[j].count('}')
            if depth == 0 and j > i:
                end = j
                break
        classes.append((m.group(1), i, end, '\n'.join(lines[i:end + 1])))

    callers = 0
    doors_bad = 0
    for i, line in enumerate(lines):
        if not re.search(r'\.completeChapter\s*\(', line):
            continue
        callers += 1
        owner = sorted((c for c in classes if c[1] <= i <= c[2]), key=lambda c: c[2] - c[1])
        if not owner:
            s.fail('completeChapter is called at js/chapters.js:%d outside any director' % (i + 1))
            doors_bad += 1
            continue
        name, _, _, body = owner[0]
        win = re.search(r'\bwon\s*=\s*true', body) is not None
        loss = re.search(r'\bcanonicalEarned\s*=\s*true', body) is not None
        says = [t for t in (('a win' if win else None), ('an earned loss' if loss else None)) if t]
        s.note('  %-18s completes at line %5d   declares %s'
               % (name, i + 1, ' and '.join(says) if says else 'NOTHING'))
        if not says:
            doors_bad += 1
            s.fail('%s calls completeChapter without ever setting won = true or'
                   ' canonicalEarned = true - the door in js/story.js records the chapter'
                   ' as a loss, so the chapter cannot be completed and the next track'
                   ' never unlocks' % name)
    if not callers:
        s.fail('no director calls completeChapter any more; this check is reading the'
               ' wrong thing')
    elif not doors_bad:
        s.ok('%d director-driven completion(s), each declaring a result' % callers)
    return s.problems


# ============================================== 12. the rival, driving =====

# What a route has to be driven at before the run counts as a drive rather than
# a crawl, and how long each mode gets. A run that does not COMPLETE only
# counts against the rival when it was given the full budget.
MIN_PACE = 45
AI_SECONDS = 1200
AI_MODES = ('driver', 'free', 'boss', 'tactics')


def check_ai():
    """The rival, on every route, at every difficulty.

    Four separate processes, because the point of the driver mode is that it
    starts from nothing: a run that inherits another mode's solver state is a
    run that proves something about the order the modes happen to be in.
    """
    s = Section('rival driving')
    for mode in AI_MODES:
        env = {'AI_MODE': mode, 'AI_SECONDS': AI_SECONDS, 'AI_HZ': 60, 'AI_GAP': 0}
        if mode == 'boss':
            env['AI_LEVEL'] = 7
            env['AI_DIFFICULTY'] = 'IMPOSSIBLE'
        d = jsprobe.run('ai', env=env, timeout=3600)
        if mode == 'tactics':
            t = d['tactics']
            s.want(t['overtake']['lead'] > 20,
                   'overtook a real slower car by %.0fu' % t['overtake']['lead'],
                   'did not complete an overtake (lead %.0fu)' % t['overtake']['lead'])
            s.want(t['overtake']['contacts'] == 0,
                   'made no contact while overtaking',
                   'made contact %d time(s) while overtaking' % t['overtake']['contacts'])
            s.want(t['overtake']['walls'] == 0, 'hit no wall while overtaking',
                   'hit a wall %d time(s) while overtaking' % t['overtake']['walls'])
            s.want(t['reset']['same'] and t['reset']['laneHintCleared'],
                   'a reset driver drives the same frame as a fresh one',
                   'a reset driver remembered a previous passing lane')
            s.want(abs(t['corridor']['lateral'] - t['corridor']['want']) < 1.5
                   and not t['corridor']['offroad'],
                   'obstacle guidance reached its corridor (%.2f of %.2f)'
                   % (t['corridor']['lateral'], t['corridor']['want']),
                   'passing offset corrupted the obstacle lane (%.2f of %.2f%s)'
                   % (t['corridor']['lateral'], t['corridor']['want'],
                      ', off the road' if t['corridor']['offroad'] else ''))
            for rec in t['recovery']:
                s.want(rec['sTrack'] > 900 and rec['vLong'] > 20,
                       'recovered from a wall-facing stop on the %s (%.0fu, %.0f u/s)'
                       % ('left' if rec['side'] < 0 else 'right', rec['sTrack'], rec['vLong']),
                       'failed to recover from a wall-facing stop on the %s'
                       % ('left' if rec['side'] < 0 else 'right'))
            # The boss does not lift when the player boosts or the lead changes
            # hands: a pace curve with a step in it is a rival that gives up.
            lifts = [h for h in t['hunt'] if h['boosting'] < h['plain']]
            s.want(not lifts, 'the boss never lifts when the player boosts',
                   'the boss lifts when the player boosts at gap %s'
                   % ', '.join(str(h['gap']) for h in lifts))
            s.want(t['huntSeam']['before'] == t['huntSeam']['after'],
                   'the boss pace curve is continuous across the lead change',
                   'the boss pace steps at the lead change: %.3f -> %.3f'
                   % (t['huntSeam']['before'], t['huntSeam']['after']))
            continue

        for r in d['rows']:
            where = 'L%d %-10s %-6s' % (r['level'], r['difficulty'], r['mode'])
            trouble = []
            if r['nonFinite']:
                trouble.append('the simulation went non-finite')
            if r['firstWall']:
                trouble.append('touched a wall at s=%s, %.0f u/s, lane %.1f'
                               % (r['firstWall']['s'], r['firstWall']['speed'],
                                  r['firstWall']['lane']))
            if r['offroadFrames']:
                trouble.append('%d frame(s) off the road' % r['offroadFrames'])
            if r['pace'] < MIN_PACE:
                trouble.append('averaged %.1f u/s, under %d' % (r['pace'], MIN_PACE))
            if d['seconds'] >= AI_SECONDS and not r['completed']:
                trouble.append('did not finish in %ds (%dm of %dm)'
                               % (d['seconds'], r['distance'], r['level']))
            if trouble:
                s.fail(where + ': ' + '; '.join(trouble))
            else:
                s.note('  %s  %5.1f u/s, %6dm in %5.1fs, slip %.2f, slowest %.0f'
                       % (where, r['pace'], r['distance'], r['seconds'],
                          r['maxSlip'], r['minSpeed']))
        if not s.problems:
            s.ok('%s: %d run(s), none touched a wall or left the road'
                 % (mode, len(d['rows'])))
    return s.problems


# =================================================================== main ===


# ================================================== 13. the radio ==========

# What a title can be before the panel has to scroll it, and what it can be
# before scrolling stops being a courtesy. Measured against the panel's own
# inner width at the size Hud.radio sets titles in.
TITLE_MAX = 26


def check_radio():
    """The soundtrack: five stations, four fixed scores, and the panel.

    Four things about this go wrong silently and none of them is visible in a
    screenshot, because the symptom of each is a song that does not play and a
    panel that says nothing about why:

      A FILE THAT IS NOT IN THE PACK. The mixer streams from the archive, a
      missing entry is a 404, the element fires `error`, the track is marked
      broken and the selector quietly skips it for the rest of the session. The
      station simply never comes on.

      TWO STATIONS ON ONE FREQUENCY, or one outside the dial the HUD draws. The
      needle lands on the wrong tick or off the end of the scale.

      AN ENVIRONMENT WITH ONE USABLE SONG. `_pickRadio` is asked for a track
      that is neither the one on the fader nor the one before it, and with one
      candidate that is unsatisfiable - so the rule that stops a route
      repeating the same song falls back to allowing exactly that.

      A PANEL THAT KNOWS THE ANSWERS. The moment Hud.radio contains a title or
      a frequency of its own it is a second copy of this table, and the two
      drift on the first edit.
    """
    s = Section('radio')
    d = jsprobe.run('radio')
    tracks = d['tracks']
    radio = [t for t in tracks if t['freq']]
    fixed = [t for t in tracks if not t['freq']]

    # --- every piece of music is named -----------------------------------
    titles = {}
    for t in tracks:
        if not t['title']:
            s.fail('%s has no title - the panel would print its key' % t['key'])
            continue
        if not t['station']:
            s.fail('%s has no station' % t['key'])
        if t['title'] in titles:
            s.fail('%s and %s are both called "%s"'
                   % (titles[t['title']], t['key'], t['title']))
        titles[t['title']] = t['key']
        if len(t['title']) > TITLE_MAX:
            s.fail('"%s" is %d characters; past %d the panel scrolls for longer than'
                   ' the song is worth' % (t['title'], len(t['title']), TITLE_MAX))
    if not s.problems:
        s.ok('%d pieces of music, each named and each named once (%d on the dial,'
             ' %d fixed scores)' % (len(tracks), len(radio), len(fixed)))

    # --- and every one of them is in the archive -------------------------
    have = set(pak.load().names())
    for t in tracks:
        name = 'assets/audio/' + t['file']
        if name not in have:
            s.fail('%s streams %s, which is not in the pack - the element will 404,'
                   ' the mixer will mark it broken and it will never be heard'
                   % (t['key'], name))
    if not s.problems:
        s.ok('every track is an entry in %s' % paths.rel(paths.PAK))

    # --- the dial ---------------------------------------------------------
    hud = paths.read(paths.JS / 'hud.js')
    m = re.search(r'const RAD_LO = ([\d.]+), RAD_HI = ([\d.]+);', hud)
    if not m:
        s.fail('js/hud.js no longer declares the tuner scale, so nothing can check'
               ' the frequencies against it')
    else:
        lo, hi = float(m.group(1)), float(m.group(2))
        before = s.problems
        seen = {}
        for t in sorted(radio, key=lambda t: t['freq']):
            f = t['freq']
            if f in seen:
                s.fail('%s and %s are both on %.1f' % (seen[f], t['key'], f))
            seen[f] = t['key']
            if not (lo < f < hi):
                s.fail('%s is on %.1f, which is outside the %.1f..%.1f dial the panel'
                       ' draws - its needle would sit off the end of the scale'
                       % (t['key'], f, lo, hi))
        if s.problems == before:
            s.ok('%d stations from %.1f to %.1f on a %.1f..%.1f dial'
                 % (len(radio), min(t['freq'] for t in radio),
                    max(t['freq'] for t in radio), lo, hi))

    # --- no environment is left with one song ----------------------------
    envs = sorted({e for t in radio for e in (t['environments'] or [])})
    for env in envs:
        here = [t for t in radio if env in (t['environments'] or [])]
        prime = [t for t in here if t['primary'] == env]
        if len(here) < 2:
            s.fail('"%s" has %d usable station(s) - the selector is asked for one that'
                   ' is neither playing nor the one before it, which it cannot satisfy'
                   % (env, len(here)))
        if not prime:
            s.fail('"%s" has no primary station, so crossing into it picks from the'
                   ' whole dial rather than from the country under the car' % env)
        s.note('  %-7s %d station(s): %s'
               % (env, len(here), ', '.join(t['title'] for t in here)))
    if envs and not s.problems:
        s.ok('every environment has a primary and an alternate')

    # --- the panel asks rather than knows --------------------------------
    body = re.search(r'\n    radio\(g\) \{([\s\S]*?)\n    \}\n', hud)
    if not body:
        s.fail('Hud.radio is gone, so the panel is not being drawn any more')
    else:
        text = body.group(1)
        if 'a.nowPlaying()' not in text:
            s.fail('Hud.radio no longer asks the mixer what is playing')
        for t in tracks:
            if t['title'] and ("'" + t['title'] + "'") in text:
                s.fail('Hud.radio has "%s" written into it - that is a second copy of'
                       ' the soundtrack table and the two will drift' % t['title'])
        for t in radio:
            if re.search(r'\b%s\b' % re.escape('%.1f' % t['freq']), text):
                s.fail('Hud.radio has the frequency %.1f written into it' % t['freq'])
        if not s.problems:
            s.ok('the panel reads the mixer and holds no copy of the table')

    # --- and the tap on the music is a dead end --------------------------
    # An AnalyserNode with nothing connected to its output still analyses
    # everything that reaches it. Connecting it ONWARD puts a second copy of
    # the music into the mix, which is inaudible as anything but +6 dB - so it
    # would be found by someone turning the music down and hearing it stay
    # loud, which is a long way from here.
    audio = paths.read(paths.JS / 'audio.js')
    if 'createAnalyser' not in audio:
        s.fail('the tap on the music bus is gone - the panel meter has nothing to show')
    elif re.search(r'this\.scope\.connect\(', audio):
        s.fail('the analyser is connected onward, so the music is mixed in twice')
    else:
        s.ok('the level meter taps the music bus without re-entering it')
    return s.problems

CHECKS = [
    ('shaders', check_shaders, False),
    ('dom', check_dom, False),
    ('protocol', check_protocol, False),
    ('colour', check_colour, False),
    ('car', check_car, False),
    ('upscale', check_upscale, False),
    ('settings', check_settings, True),
    ('story', check_story, True),
    ('ramps', check_ramps, True),
    ('forge', check_forge, True),
    ('rec', check_rec, True),
    ('radio', check_radio, True),
    ('ai', check_ai, True),
]


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog='check.py', description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='*', help='which checks to run (default: all)')
    ap.add_argument('--list', action='store_true', help='name them and stop')
    args = ap.parse_args(argv)

    if args.list:
        for name, fn, needs_node in CHECKS:
            first = (fn.__doc__ or '').strip().split('\n')[0]
            print('  %-10s %s%s' % (name, first, '   [node]' if needs_node else ''))
        return 0

    wanted = args.names or [c[0] for c in CHECKS]
    unknown = [n for n in wanted if n not in {c[0] for c in CHECKS}]
    if unknown:
        print('no such check: ' + ', '.join(unknown), file=sys.stderr)
        print('try --list', file=sys.stderr)
        return 2

    have_node = None
    problems = 0
    for name, fn, needs_node in CHECKS:
        if name not in wanted:
            continue
        if needs_node:
            if have_node is None:
                have_node = jsprobe.available()
            if not have_node:
                Section(name).skip('node is not on PATH, and this check runs the'
                                   ' game\'s own JavaScript')
                continue
        try:
            problems += fn()
        except jsprobe.ProbeError as e:
            Section(name).fail(str(e))
            problems += 1
        except Exception as e:                                  # noqa: BLE001
            import traceback
            Section(name).fail('%s: %s' % (type(e).__name__, e))
            traceback.print_exc()
            problems += 1
    return summary('check', problems)


if __name__ == '__main__':
    sys.exit(main())
