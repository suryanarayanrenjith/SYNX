"""web/data/synx.pak - every asset the game ships, in one file.

FORMAT
    magic    "SYNXPAK1"            8 bytes
    tocLen   uint32 little-endian  4 bytes
    toc      UTF-8 JSON            tocLen bytes
    data     the files, end to end

The table of contents is JSON because it is read exactly once, it is a few
kilobytes, and being able to look at the head of the file and see what is in
there is worth more than the bytes a packed table would save.

NOT COMPRESSED, deliberately. Almost every entry is already a PNG, a JPEG or
an Ogg, and running deflate over those costs load-time CPU to make the file
marginally larger. What the pack is for is the NUMBER of files: inside the
desktop host each one is a separate request against Tauri's protocol, and a
request has a fixed cost that has nothing to do with how big the thing is.

THE PACK IS THE SOURCE OF TRUTH. `assets-src/` is not shipped and does not
need to exist; unpacking writes it back byte for byte. That is why unpack is
part of the tool rather than something you would write when you needed it.
"""
import json
import pathlib
import struct

from . import paths

MAGIC = b'SYNXPAK1'

# What goes in, and the path each entry is addressed by inside the archive -
# which is the path the game already used, so no call site had to change.
DIRS = [
    ('textures', 'assets/textures'),
    ('audio', 'assets/audio'),
    ('audio/radio', 'assets/audio/radio'),
    ('sprites', 'sprites'),
    ('models', 'assets/models'),
]

# Paths an OLDER pack may contain that this build no longer produces. They are
# recognised so unpack and check can say what they are looking at instead of
# failing on them: a pack written before the fonts and the scene came out is
# still a valid pack, and a tool that crashes on one is a tool that cannot be
# used to inspect the thing it is complaining about.
RETIRED = {
    'assets/fonts/': 'the launcher needs these loose; see web/fonts and css/launcher.css',
    'data/': 'scene.bin and scene.json ship loose; see the note in this module',
}

# THE FONTS ARE NOT IN HERE, and they were. web/fonts/ has to exist as loose
# files whatever this archive contains, because launcher.html is a document of
# its own that opens BEFORE the pack is loaded and declares the faces in
# launcher.css by relative path. Packing them as well shipped both copies
# inside the executable for no gain.
#
# THE SCENE IS NOT IN HERE EITHER. web/data/scene.{bin,json} cannot leave the
# tree - mkcourse reads the manifest at build time, the scene trimmer rewrites
# both, and the loader falls back to fetching them for a checkout with no pack
# - so packing them put a SECOND copy of the same bytes inside the executable.
# It used to be eleven megabytes and the zero-copy load was worth having twice;
# trimming took it to two, and two megabytes of duplication costs more than one
# extra request saves.

MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ogg': 'audio/ogg',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
    '.bin': 'application/octet-stream',
}


class Entry:
    __slots__ = ('name', 'off', 'length', 'mime')

    def __init__(self, name, off, length, mime):
        self.name = name
        self.off = off
        self.length = length
        self.mime = mime


class Pack:
    """An archive already on disk."""

    def __init__(self, buf):
        if buf[:8] != MAGIC:
            raise ValueError('bad magic - not a SYNX pack')
        toc_len = struct.unpack_from('<I', buf, 8)[0]
        self.toc = [Entry(e['n'], e['o'], e['l'], e.get('t'))
                    for e in json.loads(buf[12:12 + toc_len].decode('utf-8'))]
        self.base = 12 + toc_len
        self.buf = buf

    def __len__(self):
        return len(self.toc)

    def data(self, e):
        return self.buf[self.base + e.off:self.base + e.off + e.length]

    def names(self):
        return [e.name for e in self.toc]


def load(path=None):
    return Pack((path or paths.PAK).read_bytes())


def dir_for(name):
    """The longest matching prefix, so assets/audio/radio beats assets/audio."""
    hits = [d for d in DIRS if name.startswith(d[1] + '/')]
    hits.sort(key=lambda d: -len(d[1]))
    return hits[0] if hits else None


def retired_reason(name):
    for k, why in RETIRED.items():
        if name.startswith(k):
            return why
    return None


def source_of(name, src=None):
    """Where an entry came from in assets-src, or None if nothing owns it."""
    d = dir_for(name)
    if not d:
        return None
    return (src or paths.ASSETS_SRC) / d[0] / pathlib.PurePosixPath(name).name


def collect(src=None):
    """Every file assets-src offers, in the order the pack stores them."""
    src = src or paths.ASSETS_SRC
    out = []
    for sub, as_ in DIRS:
        d = src / sub
        if not d.is_dir():
            continue
        for p in sorted(d.iterdir(), key=lambda p: p.name):
            if not p.is_file():
                continue
            ext = p.suffix.lower()
            if ext not in MIME:
                continue
            out.append((as_ + '/' + p.name, p, ext))
    return out


def build(files):
    """The archive bytes for a list of (name, path, ext)."""
    toc = []
    chunks = []
    off = 0
    for name, p, ext in files:
        b = p.read_bytes()
        toc.append({'n': name, 'o': off, 'l': len(b), 't': MIME[ext]})
        chunks.append(b)
        off += len(b)
    toc_json = json.dumps(toc, separators=(',', ':')).encode('utf-8')
    head = MAGIC + struct.pack('<I', len(toc_json))
    return b''.join([head, toc_json] + chunks)


def mb(n):
    return '%.2f MB' % (n / 1048576.0)
