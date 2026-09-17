"""Everything tools/ shares.

The four entry points beside this package - build.py, check.py, assets.py and
smoke.py - are the whole of the tooling. This is what they all needed twice.

    paths       where the tree is, and the handful of files everyone reads
    report      the pass/fail shell every check prints through
    png         a PNG codec, because the asset tools may not depend on one
    pak         the archive format, read and written in one place
    cdp         a static server, a WebSocket and the DevTools protocol
    jsprobe     running the game's own JavaScript and reading back an answer
"""
