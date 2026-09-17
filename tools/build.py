#!/usr/bin/env python3
"""Build SYNX into a single self-contained executable.

    python tools/build.py                 the game
    python tools/build.py --test          ...and the Rust unit tests
    python tools/build.py --check         ...and the static checkers
    python tools/build.py --smoke         ...and the whole game in a browser
    python tools/build.py --all           test + check + smoke
    python tools/build.py --bundle        ...and an installer
    python tools/build.py --run           ...and launch it when it is done

    python tools/build.py --target aarch64-apple-darwin --bundles app,dmg
                                          one release artefact, for one target
    python tools/build.py --test --check --no-host
                                          everything that can fail, and nothing
                                          that takes ten minutes

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


def tauri_cli():
    """How to invoke the Tauri CLI, whichever way it happens to be installed.

    Two ways exist and both are normal. `cargo install tauri-cli` puts a
    `cargo-tauri` on the path and is what a Rust machine usually has; the npm
    package `@tauri-apps/cli` puts a `tauri` there and ships a PREBUILT
    binary, which is why the release workflow uses it - compiling the CLI
    from source costs more than compiling the game does.

    Returns None when neither is there, and the caller decides whether that
    is a note or the end of the build.

    THE PATH IS RESOLVED, NOT ASSUMED. npm installs the standalone CLI on
    Windows as `tauri.cmd`, and a bare 'tauri' handed to CreateProcess does
    not find it - the extension search that a shell would do is the shell's,
    and there is deliberately no shell here (see `run`). which() applies
    PATHEXT and hands back something that can actually be started.
    """
    if shutil.which('cargo-tauri'):
        return ['cargo', 'tauri']
    standalone = shutil.which('tauri')
    if standalone:
        return [standalone]
    return None


def host_exe(target):
    """Where cargo leaves the host binary, with and without a --target.

    Passing --target moves the whole output tree down one level, which is the
    one thing about cross-compiling that silently breaks a script with the
    path written down. paths.EXE is the no-target answer and stays correct.

    The FILENAME is the cargo package's, not the product name: Tauri 2 stopped
    renaming the binary to match `productName`, so it is `synx` everywhere and
    `SYNX` is only what the finished bundle is called. On a case-sensitive
    filesystem that difference is the bundler failing to find its own
    executable, so it is worth being exact about.
    """
    if not target:
        return paths.EXE
    name = 'synx.exe' if 'windows' in target else 'synx'
    return paths.ROOT / 'target' / target / 'release' / name


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
    ap.add_argument('--target', metavar='TRIPLE',
                    help='build the host for this Rust target instead of this machine')
    ap.add_argument('--no-host', action='store_true', dest='no_host',
                    help='stop after the checks; do not build the desktop host.'
                         ' The release workflow gates on this before it starts'
                         ' four builds it would only throw away')
    ap.add_argument('--bundles', metavar='LIST',
                    help='what to ask the bundler for, e.g. deb,rpm or nsis or app,dmg.'
                         ' Implies --bundle, and a missing CLI is then a failed build'
                         ' rather than a note')
    a = ap.parse_args(argv)
    if a.bundles:
        a.bundle = True
    # A cross build cannot be launched here, and saying so beats trying it.
    if a.run and a.target:
        fail('--run cannot launch a %s build on this machine' % a.target)
    # ...and there is nothing to launch or wrap up if it was never built.
    if a.no_host and (a.run or a.bundle):
        fail('--no-host cannot be combined with --run or a bundle')
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

    # Everything above this line is the game; everything below it is the
    # DELIVERY of the game. --no-host stops between the two.
    if a.no_host:
        print('\n%s  checks only: the desktop host was not built%s' % (C.grey, C.off))
        return 0

    # -------------------------------------------------- 4. the host exe ---
    step('Desktop host' + (' (%s)' % a.target if a.target else ''))
    cmd = ['cargo', 'build', '-p', 'synx', '--release']
    if a.target:
        cmd += ['--target', a.target]
    run(cmd, 'host build')
    exe = host_exe(a.target)
    if not exe.exists():
        fail('cargo reported success but %s is not there' % paths.rel(exe))
    print('\n%s  %s  %s  %s%s'
          % (C.green, exe.name, mb(exe.stat().st_size), exe, C.off))

    # ----------------------------------------------------- 5. installer ---
    #
    # THE EXECUTABLE ABOVE IS ALREADY THE GAME. Everything in web/ is compiled
    # into it, so a bundle is a matter of how that file is DELIVERED - an
    # installer that puts it on a Start menu, a .deb a package manager can
    # remove again, a .dmg that opens with the application in it. None of them
    # changes what runs.
    #
    # `--bundles` names them and the config's own list is then ignored, which
    # is what the release workflow wants: "all" on Linux means an AppImage as
    # well, and that one downloads a runtime while it builds.
    if a.bundle:
        step('Bundle' + (' [%s]' % a.bundles if a.bundles else ''))
        cli = tauri_cli()
        if not cli:
            msg = ('no Tauri CLI on the path: install one with'
                   ' `cargo install tauri-cli --version "^2"`'
                   ' or `npm i -g @tauri-apps/cli@^2`')
            # Asked for by name, so not getting it is a failed build. Without
            # --bundles it is a developer convenience and a note is right.
            if a.bundles:
                fail(msg)
            print('%s  %s; the executable above is already self-contained.%s'
                  % (C.yellow, msg, C.off))
        else:
            cmd = cli + ['build']
            if a.target:
                cmd += ['--target', a.target]
            if a.bundles:
                cmd += ['--bundles', a.bundles]
            run(cmd, 'bundle')

    if a.run:
        step('Launching')
        subprocess.run([str(paths.EXE)], cwd=str(paths.ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
