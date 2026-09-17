#!/usr/bin/env python3
"""Build SYNX into a single self-contained executable.

    python tools/build.py                 the game
    python tools/build.py --test          ...and the Rust unit tests
    python tools/build.py --check         ...and the static checkers
    python tools/build.py --smoke         ...and the whole game in a browser
    python tools/build.py --all           test + check + smoke
    python tools/build.py --bundle        ...and an installer
    python tools/build.py --run           ...and launch it when it is done

THREE ARTEFACTS, IN THIS ORDER, because the first two go inside the third:

  1. crates/synx-core  ->  web/wasm/synx_core.wasm
     The simulation core: course generation, world meshing, the four-wheel
     solver, the rival's racing line and driver.

  1b. crates/synx-rec  ->  web/wasm/synx_rec.wasm
     The recorder: a JPEG encoder, an AVI muxer and the replay ring. Its own
     module because it runs on its own thread, in a Web Worker - so the JPEG
     encode and the mux happen off the thread that is drawing the game, and the
     ring's ninety-odd megabytes live in their own linear memory rather than
     growing the core's and detaching every view the page holds over it.

  2. src-tauri         ->  target/release/synx[.exe]
     The desktop host, with the whole of web/ - scripts, shaders, textures,
     audio, the scene and the .wasm above - compiled into it. There is nothing
     to install and no server to start first.

WHY THIS IS PYTHON
------------------
It replaced a JavaScript build script, which replaced a PowerShell one. The
reason for the first move was portability; the reason for this one is that the
rest of tools/ is Python now and a build script that needs a second runtime to
run the checkers is a build that needs two runtimes installed.

Node is still needed for SIX of the checks - the ones that run the game's own
JavaScript, which is the only honest way to check JavaScript - and they say so
and skip when it is absent. Nothing else here needs it.

The multiplayer server is a separate repository with its own tests and its own
deployment. Nothing here builds it.
"""
import argparse
import pathlib
import shutil
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from synx import paths                                          # noqa: E402
from synx.report import C                                       # noqa: E402

PY = sys.executable


def step(msg):
    print('\n%s=== %s ===%s' % (C.cyan, msg, C.off))


def fail(msg):
    print('\n%sbuild failed: %s%s' % (C.red, msg, C.off), file=sys.stderr)
    raise SystemExit(1)


def run(cmd, what):
    """Run a command, inheriting stdio, and stop the build if it fails.

    NO shell. It is tempting on Windows - cargo looks like it wants one - and
    it is wrong: with a shell the argument list is joined into a command line
    and split again on whitespace, so any path containing a space arrives as
    two arguments. This checkout lives under a user directory with a space in
    it, and the symptom was the course generator being handed half a path and
    reporting that the file did not exist.
    """
    r = subprocess.run([str(c) for c in cmd], cwd=str(paths.ROOT))
    if r.returncode != 0:
        fail('%s failed (exit %d)' % (what, r.returncode))


def mb(n):
    return '%.1f MB' % (n / 1048576.0)


def main(argv=None):
    ap = argparse.ArgumentParser(prog='build.py', description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--test', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--smoke', action='store_true')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--bundle', action='store_true')
    ap.add_argument('--run', action='store_true')
    a = ap.parse_args(argv)
    want_test = a.all or a.test
    want_check = a.all or a.check or a.smoke
    want_smoke = a.all or a.smoke

    # ------------------------------------------------- 1. the WASM core ---
    step('Simulation core -> WebAssembly')
    run(['cargo', 'build', '-p', 'synx-core', '--release',
         '--target', 'wasm32-unknown-unknown'], 'core build')
    out = paths.WEB / 'wasm'
    out.mkdir(parents=True, exist_ok=True)
    src = paths.ROOT / 'target' / 'wasm32-unknown-unknown' / 'release' / 'synx_core.wasm'
    if not src.exists():
        fail('cargo reported success but %s is not there' % paths.rel(src))
    shutil.copyfile(src, out / 'synx_core.wasm')
    print('  synx_core.wasm  {:,} bytes'.format(src.stat().st_size))

    step('Recorder -> WebAssembly')
    run(['cargo', 'build', '-p', 'synx-rec', '--release',
         '--target', 'wasm32-unknown-unknown'], 'recorder build')
    rec = paths.ROOT / 'target' / 'wasm32-unknown-unknown' / 'release' / 'synx_rec.wasm'
    if not rec.exists():
        fail('cargo reported success but %s is not there' % paths.rel(rec))
    shutil.copyfile(rec, out / 'synx_rec.wasm')
    print('  synx_rec.wasm   {:,} bytes'.format(rec.stat().st_size))

    # --------------------------------------------- 2. the course asset ----
    # The road the multiplayer server validates against, emitted by the game's
    # own course generator so the two cannot drift apart. Cheap, and re-run
    # every build rather than remembered, because a stale one is a server that
    # refuses legitimate positions on whichever corner changed.
    step('Course asset')
    course = paths.ROOT / 'target' / 'course.bin'
    run(['cargo', 'run', '-q', '-p', 'synx-core', '--release', '--bin', 'mkcourse', '--',
         paths.DATA / 'scene.json', course], 'course asset')
    # The server is a separate repository and may not be checked out at all, so
    # the asset lands in this one's target/ first.
    server_assets = paths.ROOT / 'synx-server' / 'synx-server' / 'assets'
    if server_assets.is_dir():
        shutil.copyfile(course, server_assets / 'course.bin')
        print('%s  copied into the server checkout; commit it there when the road'
              ' changes%s' % (C.grey, C.off))
    else:
        print('%s  no server checkout here; course.bin left in target/%s' % (C.grey, C.off))

    # ------------------------------------------------------- 3. checks ----
    if want_test:
        step('Rust unit tests')
        run(['cargo', 'test', '-p', 'synx-core', '--release'], 'core unit tests')
        run(['cargo', 'test', '-p', 'synx-net', '--release'], 'wire format unit tests')

    if want_check:
        # One command now, and one report. It used to be thirteen invocations
        # of thirteen programs with thirteen output formats, and the build
        # could only tell them apart by exit code.
        step('Static checks')
        run([PY, paths.TOOLS / 'check.py'], 'checks')

    if want_smoke:
        # Every band on the title and options screens, against every other
        # band. "Nothing is drawn through anything else" is arithmetic, not a
        # matter of opinion, and it is not something a screenshot of one page
        # can prove.
        smoke = paths.TOOLS / 'smoke.py'
        for name, args in [
            ('Interface layout',
             ['--seconds', 26, '--route', 0, '--preset', 0, '--probe', 'layout']),
            # What one chapter may leave behind for the next, and whether
            # Chapter 7's boss is still beatable by the thing that is supposed
            # to beat him. Both are invisible from a screenshot.
            ('Director leaks',
             ['--seconds', 16, '--route', 0, '--preset', 0, '--probe', 'director']),
            ('Chapter 7 balance',
             ['--seconds', 16, '--route', 6, '--preset', 0, '--probe', 'predator']),
            ('Options and key bindings',
             ['--seconds', 50, '--route', 0, '--preset', 0, '--probe', 'options']),
        ]:
            step(name)
            run([PY, smoke] + args, name)

        # The launcher IN THE REAL HOST: it opens the release binary, presses
        # PLAY and checks the window becomes the game. The browser cannot test
        # that half, and that half is the one that was broken.
        step('Launcher - desktop host')
        run([PY, smoke, 'launcher'], 'desktop launcher check')

        step('Launcher')
        run([PY, smoke, '--page', 'launcher.html', '--seconds', 12], 'launcher screen')

        # The three selection screens. They are ordinary DOM panels, so nothing
        # in the racing smoke runs ever opens one - which is how the mode
        # terminal shipped with no way back to the title except ESC.
        step('Selection screens')
        for hold in ('modes', 'freeroam', 'multiplayer', 'confirm'):
            run([PY, smoke, '--seconds', 14, '--preset', 0, '--hold', hold],
                '%s screen' % hold)

        step('Smoke test (the whole game, in a real browser)')
        run([PY, smoke, '--seconds', 70, '--route', 0, '--preset', 2], 'route 0 smoke test')
        run([PY, smoke, '--seconds', 95, '--route', 6, '--preset', 2], 'Chapter 7 smoke test')

    # -------------------------------------------------- 4. the host exe ---
    step('Desktop host')
    run(['cargo', 'build', '-p', 'synx', '--release'], 'host build')
    if not paths.EXE.exists():
        fail('cargo reported success but %s is not there' % paths.rel(paths.EXE))
    print('\n%s  %s  %s  %s%s'
          % (C.green, paths.EXE.name, mb(paths.EXE.stat().st_size), paths.EXE, C.off))

    # ----------------------------------------------------- 5. installer ---
    if a.bundle:
        step('Installer')
        r = subprocess.run(['cargo', 'tauri', 'build'], cwd=str(paths.ROOT))
        if r.returncode != 0:
            print('%s  cargo-tauri is not installed; the executable above is already'
                  ' self-contained.%s' % (C.yellow, C.off))

    if a.run:
        step('Launching')
        subprocess.run([str(paths.EXE)], cwd=str(paths.ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
