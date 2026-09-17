"""Where everything is, and how to read it.

One definition of the tree, because a tool that computes ROOT its own way is a
tool that breaks when it moves.
"""
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOLS = ROOT / 'tools'
PROBES = TOOLS / 'probes'
WEB = ROOT / 'web'
JS = WEB / 'js'
DATA = WEB / 'data'
CRATES = ROOT / 'crates'
SRC_TAURI = ROOT / 'src-tauri'
ASSETS_SRC = ROOT / 'assets-src'
PAK = DATA / 'synx.pak'

WINDOWS = sys.platform == 'win32'
EXE = ROOT / 'target' / 'release' / ('synx.exe' if WINDOWS else 'synx')


def read(rel):
    """A file under the tree, as text.

    ALWAYS through this. The checkout has mixed line endings on purpose - see
    .gitattributes - and a checker that reads a CRLF file with the platform's
    newline translation gets different string offsets on different machines.
    newline='' hands back exactly what is in the file, and nothing here
    measures a line ending.
    """
    p = rel if isinstance(rel, pathlib.Path) else ROOT / rel
    with open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def read_bytes(rel):
    p = rel if isinstance(rel, pathlib.Path) else ROOT / rel
    return p.read_bytes()


def read_json(rel):
    return json.loads(read(rel))


def write(rel, text):
    """Write text back WITH THE LINE ENDINGS IT ALREADY HAD.

    Rewriting a CRLF source file as LF turns a one-line change into a
    whole-file diff, and this tree has both kinds in it.
    """
    p = rel if isinstance(rel, pathlib.Path) else ROOT / rel
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def rel(p):
    """A path as it would be typed, for a message somebody has to act on."""
    try:
        return str(pathlib.Path(p).resolve().relative_to(ROOT)).replace(os.sep, '/')
    except ValueError:
        return str(p)


def node():
    """The Node binary, for the probes that have to run the game's own code.

    THE GAME IS JAVASCRIPT. A check that proves something about the story
    machine, the ramp table or the recorder's worker protocol has to EXECUTE
    that code - the alternative is a Python copy of it, which passes happily
    while the real thing is broken. So those checks keep a probe under
    tools/probes/, Node runs it, and every rule about what the answer should be
    lives on this side. See synx.jsprobe.
    """
    return os.environ.get('SYNX_NODE', 'node')
