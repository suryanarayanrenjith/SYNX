#!/usr/bin/env python3
"""The one version number, read and written in the places that carry it.

    python tools/version.py                      what the tree says today
    python tools/version.py --set 1.0.7          write that everywhere
    gh release list ... | python tools/version.py --next
                                                 the version the next release
                                                 should be, given the ones that
                                                 already exist

WHERE THE NUMBER LIVES

Three files, and they have to agree. `src-tauri/tauri.conf.json` is what the
bundler stamps on the installer and what the launcher shows; `src-tauri/
Cargo.toml` is what cargo compiles in; `Cargo.lock` records the same thing and
cargo rewrites it on the next build anyway, but leaving it stale makes the
build's first act a modification of a checked-in file, which is noise in a
diff and a failure under `--locked`.

WHO DECIDES IT, AND WHY IT IS NOT THIS TREE

The release workflow does, at release time, from the releases that already
exist. The alternative - bumping the file in a commit - needs the workflow to
push back to the branch that triggered it, which is either a loop or a
`[skip ci]` dance, and it races any human pushing at the same time.

So the number in the tree is a FLOOR rather than a statement. A release takes
the highest version already published, adds one to the patch, and uses that
unless the tree asks for something higher - which is how a real version bump
still works: raise it here, and the next release is the number you wrote
rather than the one after the last one.

A local build therefore reports the floor, not the newest release. That is the
price, and it is cheap: the number that matters is the one on the file people
downloaded, and that one is always correct.
"""
import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from synx import paths                                          # noqa: E402

CONF = paths.SRC_TAURI / 'tauri.conf.json'
CARGO = paths.SRC_TAURI / 'Cargo.toml'
LOCK = paths.ROOT / 'Cargo.lock'

# major.minor.patch, and nothing else. The bundlers are stricter than semver
# here: an RPM release field and a Windows FILEVERSION are both four numbers
# with no room for a pre-release suffix, so `1.0.7-beta` is not a version this
# project can ship even though it is a valid semver string. The release is
# called a beta in its title, which is where a person reads it anyway.
VERSION = re.compile(r'^(\d+)\.(\d+)\.(\d+)$')


def fail(msg):
    print('version: %s' % msg, file=sys.stderr)
    raise SystemExit(1)


def parse(text):
    m = VERSION.match((text or '').strip().lstrip('vV'))
    return tuple(int(g) for g in m.groups()) if m else None


def show(v):
    return '%d.%d.%d' % v


def current():
    """What the tree says, from the file the bundler reads."""
    v = parse(json.loads(paths.read(CONF)).get('version', ''))
    if not v:
        fail('%s has no usable version' % paths.rel(CONF))
    return v


def highest(tags):
    """The largest version among some tags, ignoring anything unparseable.

    Tags arrive from `gh release list`, which is a list of whatever anyone has
    ever published - including, one day, something that is not a version at
    all. Those are skipped rather than guessed at.
    """
    seen = [parse(t) for t in tags]
    seen = [v for v in seen if v]
    return max(seen) if seen else None


def write(v):
    """Put `v` in all three places, changing nothing else about the files."""
    text = show(v)

    # The JSON is rewritten as text rather than re-serialised: dumping the
    # parsed object would reformat every line of a file somebody hand-edits.
    conf = paths.read(CONF)
    new, n = re.subn(r'("version"\s*:\s*")[^"]*(")', r'\g<1>' + text + r'\g<2>',
                     conf, count=1)
    if n != 1:
        fail('no version field in %s' % paths.rel(CONF))
    paths.write(CONF, new)

    # ...and the manifest's own, which is the FIRST version key in the file:
    # the dependencies below it have versions too, and a greedy replace would
    # pin tauri to the game's version number.
    cargo = paths.read(CARGO)
    new, n = re.subn(r'(?m)^(version\s*=\s*")[^"]*(")', r'\g<1>' + text + r'\g<2>',
                     cargo, count=1)
    if n != 1:
        fail('no version key in %s' % paths.rel(CARGO))
    paths.write(CARGO, new)

    # The lock's entry for this package only. Matched through the package
    # header so the crate next to it in the file cannot be hit instead, and
    # across either line ending, because paths.read hands back whatever the
    # working copy has rather than normalising it.
    if LOCK.exists():
        lock = paths.read(LOCK)
        new, n = re.subn(r'(?m)^(name = "synx"\r?\nversion = ")[^"]*(")',
                         r'\g<1>' + text + r'\g<2>', lock, count=1)
        if n == 1:
            paths.write(LOCK, new)

    return text


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog='version.py', description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--set', metavar='X.Y.Z',
                   help='write this version into the files that carry it')
    g.add_argument('--next', action='store_true',
                   help='read published tags on stdin, one per line, and print'
                        ' the version the next release should use')
    a = ap.parse_args(argv)

    if a.set:
        v = parse(a.set)
        if not v:
            fail('%r is not major.minor.patch' % a.set)
        print(write(v))
        return 0

    if a.next:
        published = highest(sys.stdin.read().splitlines())
        floor = current()
        if published is None:
            # Nothing released yet, so the tree's number is the first one.
            print(show(floor))
            return 0
        bumped = (published[0], published[1], published[2] + 1)
        print(show(max(bumped, floor)))
        return 0

    print(show(current()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
