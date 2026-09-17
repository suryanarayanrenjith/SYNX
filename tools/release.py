#!/usr/bin/env python3
"""Collect one platform's finished build into `dist/`, named for a download page.

    python tools/release.py                              this machine
    python tools/release.py --target x86_64-apple-darwin  ...or one named target

WHAT THIS IS FOR
----------------
`tools/build.py --bundles ...` leaves its output scattered under
`target/[<triple>/]release/bundle/`, in a directory per format, with names the
bundler chose - `SYNX_1.0.0_amd64.deb`, `SYNX_1.0.0_x64-setup.exe`,
`SYNX_1.0.0_aarch64.dmg`. Those are fine names for a build directory and poor
ones for a release page, where five platforms' files sit in one list and
`x64`, `amd64` and `x86_64` are three spellings of the same machine.

So everything lands in `dist/` under one scheme:

    SYNX-<version>-<platform>-<arch>[-<kind>].<ext>

and anything the platform is supposed to have produced and did not is a failed
run rather than a release that is quietly missing its installer.

THE PORTABLE ARCHIVE IS BUILT HERE
----------------------------------
The bundler makes installers. It does not make the "just give me the program"
download, and on Linux that is the only form that works everywhere - a .deb is
no use on Fedora and an .rpm is no use on Debian. So the Windows .zip and the
Linux .tar.gz are assembled here, around the same self-contained executable the
installers carry.

HOW MUCH COMPRESSION IS ACTUALLY WORTH
--------------------------------------
Not much, and it is worth knowing why before anyone goes looking for a better
algorithm. Around forty-four of the executable's forty-seven megabytes are
web/data/synx.pak, which is PNG, JPEG and Ogg end to end - already-compressed
data that deflate leaves within two per cent of where it found it. The archives
are written at maximum compression anyway, because it costs a few seconds once
and nothing afterwards, but the honest expectation is single figures.

The size that CAN be moved is the code, and that is moved in Cargo.toml -
opt-level 3, fat LTO, one codegen unit and `strip` - not here.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import sys
import tarfile
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from synx import paths                                          # noqa: E402
from synx.report import C                                       # noqa: E402

DIST = paths.ROOT / 'dist'

# The target triples this project releases for, and what each one is called on
# a download page. A person choosing a file knows whether their Mac is Intel or
# Apple silicon; they do not necessarily know that theirs is `aarch64-apple-
# darwin`, and they should not have to.
TARGETS = {
    'x86_64-pc-windows-msvc':   ('windows', 'x86_64'),
    'aarch64-pc-windows-msvc':  ('windows', 'arm64'),
    'x86_64-unknown-linux-gnu': ('linux', 'x86_64'),
    'aarch64-unknown-linux-gnu': ('linux', 'arm64'),
    'x86_64-apple-darwin':      ('macos', 'intel'),
    'aarch64-apple-darwin':     ('macos', 'apple-silicon'),
}


def fail(msg):
    print('\n%srelease failed: %s%s' % (C.red, msg, C.off), file=sys.stderr)
    raise SystemExit(1)


def version():
    """The one version number, from the file the bundler reads it from too."""
    return json.loads(paths.read(paths.SRC_TAURI / 'tauri.conf.json'))['version']


def this_target():
    """The triple for the machine running this, when none was named.

    Only ever a fallback for a local run: the release workflow always says
    which target it built, because on a Mac the answer depends on which of two
    it asked for rather than on which one it is running on.
    """
    import platform as plat
    machine = plat.machine().lower()
    arm = machine in ('arm64', 'aarch64')
    if sys.platform == 'win32':
        return 'aarch64-pc-windows-msvc' if arm else 'x86_64-pc-windows-msvc'
    if sys.platform == 'darwin':
        return 'aarch64-apple-darwin' if arm else 'x86_64-apple-darwin'
    return 'aarch64-unknown-linux-gnu' if arm else 'x86_64-unknown-linux-gnu'


def bundle_dir(target, native):
    """Where the bundler left its output.

    `--target` moves cargo's whole output tree down one level. A build without
    one writes to target/release/, and the workflow always passes a target, so
    both cases are real and neither can be assumed.
    """
    base = paths.ROOT / 'target'
    return (base / 'release' / 'bundle') if native else (base / target / 'release' / 'bundle')


def one(where, pattern, what):
    """Exactly one file matching `pattern`, or a message naming the problem.

    Two matches is as much of a fault as none: it means a previous build's
    artefact is still sitting there, and picking either one at random is how a
    release page ends up carrying last week's installer.
    """
    hits = sorted(p for p in where.glob(pattern) if p.is_file())
    if not hits:
        fail('no %s: nothing matching %s in %s' % (what, pattern, paths.rel(where)))
    if len(hits) > 1:
        fail('%d candidates for %s in %s - clear target/ and rebuild:\n  %s'
             % (len(hits), what, paths.rel(where), '\n  '.join(p.name for p in hits)))
    return hits[0]


def take(src, name):
    """Copy one finished artefact into dist/ under the release's own name."""
    dst = DIST / name
    shutil.copy2(src, dst)
    return dst


def zip_portable(exe, name):
    """The Windows download for people who do not want an installer.

    Stored at maximum deflate. See the note at the top about what that is
    actually worth on a file that is mostly a media pack.
    """
    dst = DIST / name
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(exe, 'SYNX/SYNX.exe')
        z.write(paths.ROOT / 'README.md', 'SYNX/README.md')
    return dst


def tar_portable(exe, name):
    """The Linux download that works on a distribution neither package fits.

    A .deb is no use on Fedora and an .rpm is no use on Debian, and between
    them they miss Arch, openSUSE, NixOS and every immutable desktop. This is
    the executable, an icon, and a .desktop file pointing at wherever the
    person unpacked it - which is why the Exec line is a bare name rather than
    a path: the install note tells them to put it on their PATH, and a path
    baked in here would be wrong for everyone who did not.
    """
    desktop = '\n'.join([
        '[Desktop Entry]',
        'Type=Application',
        'Name=SYNX',
        'GenericName=Synthwave eXtreme Racing',
        'Comment=A neon arcade racer with a Rust simulation core',
        'Exec=synx',
        'Icon=synx',
        'Terminal=false',
        'Categories=Game;ArcadeGame;',
        '',
    ])
    install = '\n'.join([
        'SYNX - portable Linux build',
        '',
        'Everything the game needs is inside the `synx` executable: the',
        'renderer, the asset pack and the simulation core are compiled into it.',
        'There is nothing to install and no server to start first.',
        '',
        'To run it from here:',
        '',
        '    ./synx',
        '',
        'To install it for the current user, so it appears in the applications',
        'menu with its icon:',
        '',
        '    install -Dm755 synx            ~/.local/bin/synx',
        '    install -Dm644 synx.png        ~/.local/share/icons/hicolor/256x256/apps/synx.png',
        '    install -Dm644 synx.desktop    ~/.local/share/applications/synx.desktop',
        '',
        'It needs a WebKitGTK 4.1 runtime, which every current desktop',
        'distribution ships; on Debian and Ubuntu the package is',
        'libwebkit2gtk-4.1-0. The .deb and .rpm downloads declare that',
        'dependency for you - this archive cannot, which is the one thing you',
        'give up by using it.',
        '',
    ])
    dst = DIST / name
    # compresslevel 9, and the members owned by root rather than by whichever
    # account the build agent happened to run as
    with tarfile.open(dst, 'w:gz', compresslevel=9) as t:
        def clean(info):
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            return info

        t.add(exe, 'SYNX/synx', filter=lambda i: clean(_mode(i, 0o755)))
        t.add(paths.SRC_TAURI / 'icons' / 'icon.png', 'SYNX/synx.png',
              filter=lambda i: clean(_mode(i, 0o644)))
        t.add(paths.ROOT / 'README.md', 'SYNX/README.md',
              filter=lambda i: clean(_mode(i, 0o644)))
        _add_text(t, 'SYNX/synx.desktop', desktop, clean)
        _add_text(t, 'SYNX/INSTALL.txt', install, clean)
    return dst


def _mode(info, mode):
    info.mode = mode
    return info


def _add_text(tar, name, text, clean):
    import io
    data = text.encode('utf-8')
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    tar.addfile(clean(info), io.BytesIO(data))


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog='release.py', description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--target', metavar='TRIPLE',
                    help='the triple that was built; this machine\'s if omitted')
    ap.add_argument('--native', action='store_true',
                    help='the build did not pass --target, so read target/release/')
    a = ap.parse_args(argv)

    target = a.target or this_target()
    if target not in TARGETS:
        fail('%s is not a target this project releases for; known:\n  %s'
             % (target, '\n  '.join(sorted(TARGETS))))
    plat, arch = TARGETS[target]
    ver = version()
    stem = 'SYNX-%s-%s-%s' % (ver, plat, arch)

    bundles = bundle_dir(target, a.native)
    if not bundles.is_dir():
        fail('no bundle output at %s - run tools/build.py --bundles first'
             % paths.rel(bundles))
    exe = (bundles.parent / ('synx.exe' if plat == 'windows' else 'synx'))
    if not exe.exists():
        fail('the host binary is not at %s' % paths.rel(exe))

    # Written fresh every run. A stale file in here is a file that gets
    # uploaded, and nothing downstream is in a position to notice.
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    made = []
    if plat == 'windows':
        made.append(take(one(bundles / 'nsis', '*-setup.exe', 'the Windows installer'),
                         stem + '-setup.exe'))
        made.append(zip_portable(exe, stem + '-portable.zip'))
    elif plat == 'linux':
        made.append(take(one(bundles / 'deb', '*.deb', 'the Debian package'),
                         stem + '.deb'))
        made.append(take(one(bundles / 'rpm', '*.rpm', 'the RPM package'),
                         stem + '.rpm'))
        made.append(tar_portable(exe, stem + '.tar.gz'))
    else:
        made.append(take(one(bundles / 'dmg', '*.dmg', 'the macOS disk image'),
                         stem + '.dmg'))

    sums = DIST / ('SHA256SUMS-%s-%s.txt' % (plat, arch))
    lines = []
    print('\n%s%s %s for %s / %s%s' % (C.cyan, 'SYNX', ver, plat, arch, C.off))
    for p in made:
        digest = sha256(p)
        lines.append('%s  %s' % (digest, p.name))
        print('  %-44s %8.1f MB  %s' % (p.name, p.stat().st_size / 1048576.0, digest[:16]))
    sums.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('  %-44s %s' % (sums.name, 'sha-256 of each of the above'))
    print('\n%s  %d file(s) in %s%s' % (C.green, len(made), paths.rel(DIST), C.off))
    return 0


if __name__ == '__main__':
    sys.exit(main())
