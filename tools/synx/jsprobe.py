"""Running the game's own JavaScript, and reading back what it did.

WHY THIS EXISTS
---------------
The game is JavaScript. Five of the checks are about things only the game can
answer - what the story machine does over thirty simulated minutes, where the
ramp table actually arms the solver, what geometry the Forge director builds,
whether the recorder's worker hands its buffers back, how the rival drives. The
only honest way to ask is to run the code.

The alternative is a Python copy of the same logic, which passes happily while
the real thing is broken. That failure mode has a name in this tree and it is
written down: a check that restates its subject is a check that fails on
healthy code and passes on sick code.

THE SPLIT
---------
A probe MEASURES and this side JUDGES. tools/probes/*.js load the shipped
scripts, drive them, and write down numbers; every rule about what those
numbers have to be lives in tools/check.py. That keeps the JavaScript free of
opinions - it is a strain gauge, not a test - and it keeps every threshold in
one language, where it can be read next to the others.

THE PROTOCOL
------------
    node tools/probes/probe.js <out-dir> <name> [args...]

The probe writes `report.json` into <out-dir> and may write binary blobs beside
it for anything too large to be JSON - the Forge's half-million vertices, for
instance. stdout is left free for diagnostics, so a probe that crashes says so
in the ordinary way.

A caller may also leave a `request.json` in <out-dir> first. That is how the
side with the opinions asks for exactly what it wants measured - the Forge
check names the points it intends to drop a ray at, rather than letting the
probe pick a grid and thereby own half the test.
"""
import json
import pathlib
import subprocess
import tempfile

from . import paths


class ProbeError(RuntimeError):
    pass


def run(name, args=(), env=None, timeout=900, keep=None, request=None):
    """Run one probe and return (report, directory).

    The directory is a temporary one that survives until the caller is done
    with it - binary blobs are read out of it - so it is handed back rather
    than cleaned up here. Pass `keep` to write into a directory of your own.
    """
    script = paths.PROBES / 'probe.js'
    if not script.exists():
        raise ProbeError('there is no probe program at ' + paths.rel(script))
    out = pathlib.Path(keep) if keep else pathlib.Path(tempfile.mkdtemp(prefix='synx-probe-'))
    out.mkdir(parents=True, exist_ok=True)
    if request is not None:
        (out / 'request.json').write_text(json.dumps(request), encoding='utf-8')

    cmd = [paths.node(), str(script), str(out), name] + [str(a) for a in args]
    full = None
    if env:
        import os
        full = dict(os.environ)
        full.update({k: str(v) for k, v in env.items()})
    r = subprocess.run(cmd, cwd=str(paths.ROOT), env=full, timeout=timeout,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    text = r.stdout.decode('utf-8', 'replace')
    report = out / 'report.json'
    if r.returncode != 0 and not report.exists():
        raise ProbeError('probe %s exited %d\n%s' % (name, r.returncode, text.strip()))
    if not report.exists():
        raise ProbeError('probe %s wrote no report\n%s' % (name, text.strip()))
    data = json.loads(report.read_text(encoding='utf-8'))
    data['_stdout'] = text
    data['_dir'] = str(out)
    return data


def available():
    """Is there a Node to run the probes with?

    Asked before a probe rather than after it fails, so "node is not installed"
    reads as that and not as a broken check.
    """
    try:
        subprocess.run([paths.node(), '--version'], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)
        return True
    except Exception:                                          # noqa: BLE001
        return False
