"""How a check says what it found.

Every checker in this tree printed its own variation of the same three lines,
and `node tools/build.js --check` could only tell them apart by exit code. One
shell instead: a section prints a heading, collects its findings, and the
process exits non-zero if anything failed.

The shape is deliberately the one the JavaScript checkers used -

      ok   the thing that was true
      PROBLEM: the thing that was not

- because that is what the build log has looked like for the life of the
project, and a tool nobody can grep the same way is a tool that gets read less.
"""
import sys

_TTY = sys.stdout.isatty()


class _C:
    cyan = '\x1b[36m' if _TTY else ''
    green = '\x1b[32m' if _TTY else ''
    grey = '\x1b[90m' if _TTY else ''
    red = '\x1b[31m' if _TTY else ''
    yellow = '\x1b[33m' if _TTY else ''
    off = '\x1b[0m' if _TTY else ''


C = _C()


class Section:
    """One check's findings. Problems are counted, not thrown.

    A checker that stops at its first problem reports one of five, and the
    person fixing them then runs it five times. Everything that can still be
    measured after a failure is measured.
    """

    def __init__(self, title, quiet=False):
        self.title = title
        self.problems = 0
        self.checks = 0
        if not quiet:
            print('\n%s=== %s ===%s' % (C.cyan, title, C.off))

    def ok(self, msg):
        self.checks += 1
        print('  ok   ' + msg)
        return True

    def fail(self, msg):
        self.checks += 1
        self.problems += 1
        print('  %sPROBLEM: %s%s' % (C.red, msg, C.off))
        return False

    def want(self, cond, good, bad=None):
        """Assert, and say which way it went either way."""
        return self.ok(good) if cond else self.fail(bad if bad is not None else good)

    def note(self, msg):
        print('  %s%s%s' % (C.grey, msg, C.off))

    def skip(self, why):
        print('  %sskipped: %s%s' % (C.yellow, why, C.off))

    def line(self, msg=''):
        print(msg)


def heading(msg):
    print('\n%s=== %s ===%s' % (C.cyan, msg, C.off))


def summary(name, problems):
    """The last line of a tool, and the one a build log gets grepped for."""
    if problems:
        print('\n%s%s: %d problem%s%s'
              % (C.red, name, problems, '' if problems == 1 else 's', C.off))
    else:
        print('\n%s%s: OK%s' % (C.green, name, C.off))
    return 1 if problems else 0


def die(msg):
    print('%s%s%s' % (C.red, msg, C.off), file=sys.stderr)
    raise SystemExit(1)
