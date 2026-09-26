#!/usr/bin/env python3
"""Collect and restore the state a bashtion session is worth carrying.

Save used to be `tar czf - -C /home/user --exclude=persist .`, which meant two
things went wrong at once. Anything outside $HOME - a package installed, a user
added, an ACL set, a cron job written, an /etc file edited - was silently
dropped, and restore still reported success, so the loss surfaced much later as
a command that inexplicably failed. And ~/persist, the one directory whose name
promises the opposite, was the single path excluded from the archive.

What is captured now:

  * /home/user in full, ~/persist included.
  * Everything under /etc, /opt, /srv, /usr/local, /root and /var/spool/cron
    that DIFFERS from the image it shipped as - so the user and group
    databases, sudoers, fstab, cron jobs and anything else edited come back,
    while the ~2000 untouched files do not have to cross a serial console at a
    few hundred bytes a second.
  * Files that existed in the image and have since been deleted, so a removal
    is a change like any other.

What is deliberately not captured, because it cannot cross this channel at a
sane size: installed packages (/var/lib/dpkg plus the unpacked files), /var
generally, and the contents of /dev/vdb. `apt install` from the offline repo
has to be repeated after a restore.

The system half of an archive only means something against the image it was
saved on: it is a diff from THAT image's baseline, and its deletion list is
that image's file list. Restored into a rebuilt image it silently puts back the
old copy of every file the rebuild fixed. So each archive records the build it
came from, and unpack applies the system half only to the same build; anywhere
else it restores the home directory alone and says so.

  usage: state.py baseline        record what the image shipped as (build time)
         state.py pack            write a .tar.gz of the session to stdout
         state.py unpack          read one from stdin and apply it
"""
import atexit
import hashlib
import json
import os
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import textwrap
import time

HOME = '/home/user'
SYSTEM_ROOTS = ['/etc', '/opt', '/srv', '/usr/local', '/root', '/var/spool/cron']
STATE_DIR = '/var/lib/bashtion'
BASELINE = '/usr/local/lib/bashtion/baseline.tsv'
# The first line of BASELINE: ID_TAG, a tab, and this build's id.
ID_TAG = '#build'
SESSION = STATE_DIR + '/session.json'
# 1: format, created, roots, home, deleted.
# 2: adds build, the build id of the image that saved it, and MARKER.
FORMAT = 2
# Added to every archive, outside every tree an unpacker has ever been
# allowed to write. A format-1 unpacker never looks at format or build and
# would apply this archive's system files to whatever build it runs on - an
# old tab still open, a deploy rolled back - so instead it meets this,
# refuses the whole archive, and writes nothing. Never extracted here, and
# never a file on / either: pack stages it with the session metadata (see
# cmd_pack), so nothing on the root filesystem can keep it out of an archive.
MARKER = '/usr/lib/bashtion/archive-format-2'
MARKER_TEXT = '''This member marks a bashtion session archive of format 2 or later.

It sits outside every tree bashtion-unpack has ever been allowed to write,
on purpose: an unpacker from before format 2 refuses the whole archive when
it meets it, before extracting anything. Such an unpacker never checks which
build an archive came from, and would otherwise apply this archive's system
files to whatever build it runs on. A format-2 unpacker skips it.
'''

# Machine identity and things regenerated on every boot: restoring these onto a
# different session is wrong, not merely useless.
SKIP_EXACT = {
    '/etc/machine-id', '/etc/adjtime', '/etc/mtab', '/etc/.pwd.lock',
    '/etc/ld.so.cache', '/etc/blkid.tab', '/etc/blkid.tab.old',
    '/usr/local/lib/bashtion',
}
SKIP_PREFIX = (
    '/usr/local/lib/bashtion/',   # the helpers themselves, and this baseline
    '/etc/ssh/ssh_host_',         # host keys, generated on first boot
)

# Where an archive is allowed to write. An archive is user-supplied - it may
# have come from a different machine, or been edited - so refuse anything that
# lands outside the tree this tool claims, and anything with a .. in it.
ALLOWED = tuple(p.lstrip('/') + '/' for p in [HOME] + SYSTEM_ROOTS + [STATE_DIR])
# ...and the same trees as archive member names spell them
ROOTS_REL = tuple(a.rstrip('/') for a in ALLOWED)
HOME_REL = HOME.lstrip('/')
SESSION_REL = SESSION.lstrip('/')
MARKER_REL = MARKER.lstrip('/')


def skip(path):
    return path in SKIP_EXACT or path.startswith(SKIP_PREFIX)


def in_home(member):
    return (member + '/').startswith(HOME_REL + '/')


def contained(path, roots):
    """Is `path` genuinely inside one of `roots`?

    A prefix test is not enough. `/etc/../usr/bin/sudo` starts with `/etc/`,
    and the kernel resolves the `..` when the path is used - so a string-only
    guard hands out the whole filesystem. Two conditions:

      * the path must already be canonical and absolute, so anything carrying
        `..`, `.`, `//` or a trailing slash is rejected outright rather than
        normalised into something that passes;
      * its PARENT must really resolve inside a root, so a symlinked directory
        component cannot redirect the operation somewhere else.

    pack only ever emits canonical absolute paths, so nothing legitimate is
    turned away.
    """
    if not path or not os.path.isabs(path) or os.path.normpath(path) != path:
        return False
    if not any(path == r or path.startswith(r + '/') for r in roots):
        return False
    parent = os.path.realpath(os.path.dirname(path))
    return any(parent == r or parent.startswith(r + '/') for r in roots)


def walk(root):
    """Every directory, regular file and symlink under root, root included."""
    if not os.path.lexists(root):
        return
    yield root
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in sorted(dirnames) + sorted(filenames):
            p = os.path.join(dirpath, name)
            if skip(p):
                continue
            if '\t' in p or '\n' in p:
                continue          # the baseline is tab-separated; keep it honest
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
                yield p


def stamp(path):
    """What "unchanged since the image shipped" means, per path.

    Whole seconds, deliberately. The baseline is recorded against the builder's
    filesystem and compared against the same tree after `mke2fs -d` has copied
    it into an ext4 image, and that copy keeps mtimes only to the second. Every
    file a build command wrote - the .debs curl fetched into /srv/apt, the
    lvm.conf a sed edited, the inputrc a printf appended to - carries sub-second
    nanoseconds, while everything dpkg unpacked carries whole seconds from the
    tar. Comparing nanoseconds therefore marked exactly the build-touched files
    as changed, and put 300 KiB of already-compressed .debs into every single
    save.
    """
    st = os.lstat(path)
    return '%d\t%d\t%d' % (st.st_size, st.st_mode & 0o7777, int(st.st_mtime))


def cmd_baseline():
    os.makedirs(os.path.dirname(BASELINE), exist_ok=True)
    rows = []
    for root in SYSTEM_ROOTS:
        for p in walk(root):
            if skip(p):
                continue
            try:
                rows.append((p, stamp(p)))
            except OSError:
                continue
    ident = identity(rows)
    tmp = BASELINE + '.tmp'
    with open(tmp, 'w') as f:
        # The build id heads the very file it describes, so one rename
        # replaces both: a save can never pair this baseline with another
        # baseline's id. read_baseline() knows to skip it.
        f.write('%s\t%s\n' % (ID_TAG, ident))
        for p, st in rows:
            f.write('%s\t%s\n' % (p, st))
    os.replace(tmp, BASELINE)
    print('baseline: %d paths, build %s' % (len(rows), ident))


def identity(rows):
    """Name the build after everything an archive is a diff against.

    The system half of an archive only applies to the tree it was diffed
    from, so this is what a restore compares. The baseline rows alone are not
    enough: size, mode and whole-second mtime are what pack needs to spot a
    change cheaply, but a rebuild can change what a file says without changing
    any of them. So each path's contents (or link target), type, owner and
    extended attributes - ACLs included - go in too, and which other paths it
    is hard-linked to: tar packs and restores that too, so two trees that
    differ only there are not the same tree. It runs once per build, where
    reading every file costs seconds, never per save.

    Taken in sorted order, so it does not depend on the order a filesystem
    happens to list a directory in. A hard-link group is named by its first
    path in that order, never by an inode number, which a rebuild does not keep.
    """
    rows = sorted(rows)
    first = {}                    # (dev, inode) -> the first path linked to it
    group = {}                    # path -> that first path
    for p, _ in rows:
        try:
            st = os.lstat(p)
        except OSError:
            continue
        if not stat.S_ISDIR(st.st_mode) and st.st_nlink > 1:
            group[p] = first.setdefault((st.st_dev, st.st_ino), p)
    h = hashlib.sha256()
    for p, st in rows:
        h.update(('%s\t%s\t%s\t%s\n' % (p, st, fingerprint(p), group.get(p, p)))
                 .encode('utf-8', 'surrogateescape'))
    return h.hexdigest()


def fingerprint(path):
    """Type, owner, contents or link target, and xattrs of one path.

    Contents and xattrs are separate digests, and every xattr name and value
    is length-prefixed, so no arrangement of one can pass for another.
    """
    try:
        st = os.lstat(path)
    except OSError:
        return 'gone'
    data = hashlib.sha256()
    try:
        if stat.S_ISLNK(st.st_mode):
            data.update(os.fsencode(os.readlink(path)))
        elif stat.S_ISREG(st.st_mode):
            # NOFOLLOW/NONBLOCK: whatever it has become since the lstat - a
            # symlink, a fifo - is read as nothing rather than followed or
            # waited on.
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as f:
                for chunk in iter(lambda: f.read(1 << 16), b''):
                    data.update(chunk)
        contents = data.hexdigest()
    except OSError as e:
        contents = 'unreadable-%s' % e.errno
    try:
        names = sorted(os.listxattr(path, follow_symlinks=False))
    except OSError:
        names = []
    xattrs = hashlib.sha256(struct.pack('>I', len(names)))
    for name in names:
        try:
            value = os.getxattr(path, name, follow_symlinks=False)
        except OSError:
            value = b''
        for part in (os.fsencode(name), value):
            xattrs.update(struct.pack('>I', len(part)) + part)
    return '%o %d %d %s %s' % (st.st_mode, st.st_uid, st.st_gid, contents,
                               xattrs.hexdigest())


def valid_id(ident):
    return (isinstance(ident, str) and len(ident) == 64
            and all(c in '0123456789abcdef' for c in ident))


def header_id(line):
    tag, _, ident = line.rstrip('\n').partition('\t')
    return ident if tag == ID_TAG and valid_id(ident) else None


def build_id():
    """This image's build id, or None if its baseline carries none."""
    try:
        with open(BASELINE) as f:
            return header_id(f.readline())
    except OSError:
        return None


def read_baseline():
    """The baseline, and the build id at its head, read in one go.

    Taken from the same bytes, so a save records the id of exactly the
    baseline its diff was computed against.
    """
    base, ident = {}, None
    try:
        with open(BASELINE) as f:
            for i, line in enumerate(f):
                if i == 0 and line.startswith(ID_TAG + '\t'):
                    ident = header_id(line)
                    continue
                parts = line.rstrip('\n').split('\t')
                if len(parts) == 4:
                    base[parts[0]] = (parts[1], parts[2], parts[3])
    except OSError:
        pass
    return base, ident


def changed_system_paths(base):
    """Paths under the system roots that differ from the shipped image."""
    keep, seen = [], set()
    for root in SYSTEM_ROOTS:
        for p in walk(root):
            if skip(p):
                continue
            seen.add(p)
            try:
                now = tuple(stamp(p).split('\t'))
            except OSError:
                continue
            if base.get(p) != now:
                keep.append(p)
    deleted = sorted(p for p in base if p not in seen)
    return keep, deleted


def cmd_pack():
    base, build = read_baseline()
    if not base:
        print('bashtion-pack: no baseline; capturing the system roots in full',
              file=sys.stderr)
    system, deleted = changed_system_paths(base)
    home = [p for p in walk(HOME) if not skip(p)]

    # The metadata and MARKER are staged in /tmp and renamed into place inside
    # the archive, never written to the root filesystem. A save has to work on
    # a full disk - that is exactly when someone most needs their work out -
    # and /tmp is a tmpfs, with room when / has none. Writing SESSION in place
    # only ever survived 100% because the image happened to ship a copy whose
    # one block could be reused. MARKER was packed from / too, and written
    # back first whenever it had gone - tar skips what it cannot read, and
    # packs nothing for a socket - so on a full root the write failed and the
    # archive went out unmarked. Staged, every archive this saves carries
    # both, or no archive is saved at all. mkdtemp, not a fixed name: this
    # runs as root in a world-writable directory.
    try:
        stage = tempfile.mkdtemp(prefix='bashtion-pack-', dir='/tmp')
        atexit.register(shutil.rmtree, stage, True)
        staged = os.path.join(stage, 'session.json')
        with open(staged, 'w') as f:
            json.dump({'format': FORMAT, 'created': int(time.time()),
                       'roots': SYSTEM_ROOTS, 'home': HOME, 'deleted': deleted,
                       'build': build}, f)
        marker = os.path.join(stage, os.path.basename(MARKER))
        with open(marker, 'w') as f:
            os.fchmod(f.fileno(), 0o644)
            f.write(MARKER_TEXT)
    except OSError as e:
        sys.exit('bashtion-pack: cannot stage the session metadata in /tmp: %s'
                 % (e.strerror or e))
    # tar knows each file only by where it really is, so rename it on the way
    # in: an anchored match on that one path, every metacharacter escaped. The
    # new names are SESSION_REL, the one member unpack reads the metadata
    # from, and MARKER_REL, the one it skips.
    rename = ['s,^%s$,%s,' % (
        ''.join('\\' + c if c in '\\.[]*^$' else c for c in path.lstrip('/')), name)
        for path, name in ((staged, SESSION_REL), (marker, MARKER_REL))]

    members = home + system + [staged, marker]
    bytes_total = 0
    for p in members:
        try:
            if os.path.isfile(p) and not os.path.islink(p):
                bytes_total += os.path.getsize(p)
        except OSError:
            pass
    print('bashtion-pack: %d paths from home, %d changed system paths, '
          '%d deleted, %.1f MiB before compression'
          % (len(home), len(system), len(deleted), bytes_total / 1048576.0),
          file=sys.stderr)
    if bytes_total > 65536:
        sized = []
        for p in members:
            try:
                if os.path.isfile(p) and not os.path.islink(p):
                    sized.append((os.path.getsize(p), p))
            except OSError:
                pass
        sized.sort(reverse=True)
        print('bashtion-pack: largest: %s'
              % ', '.join('%s (%d KiB)' % (p, n // 1024) for n, p in sized[:8]),
              file=sys.stderr)

    listing = '\0'.join(p.lstrip('/') for p in members) + '\0'
    tar = subprocess.Popen(
        ['tar', 'czf', '-', '--numeric-owner', '--acls',
         '--xattrs', '--xattrs-include=*', '--no-recursion',
         '--ignore-failed-read']
        + [arg for expr in rename for arg in ('--transform', expr)]
        + ['-C', '/', '--null', '-T', '-'],
        stdin=subprocess.PIPE)
    tar.communicate(listing.encode())
    # 1 is "some files differed while being read" - normal for a live home
    # directory. --ignore-failed-read covers the other half of the same race:
    # the walk can take minutes on a 10-30x interpreter, and a file that is
    # gone by the time tar stats it is otherwise a fatal exit 2, which the page
    # reports as a failed save even though the archive is complete.
    sys.exit(0 if tar.returncode in (0, 1) else tar.returncode or 2)


def read_meta(data, names):
    """The archive's session.json, read out of the archive itself.

    This happens before anything is extracted, because whether the archive
    may touch the system roots at all depends on what it says. It is never
    read back from disk: after an extraction that could be a previous save's
    file, and a home-only restore does not extract it at all.

    None when the archive carries none. One that cannot be understood - or a
    format newer than this code - stops the restore here, while nothing has
    been written yet: guessing at it is how a restore goes wrong silently.
    """
    if not names:
        return None
    if len(names) > 1:
        sys.exit('bashtion-unpack: this archive carries more than one '
                 'session.json; nothing was restored')
    # Exactly that member and nothing under it: named as a directory, tar
    # would otherwise hand back whatever file sits inside and call it this.
    # A directory, link or symlink yields no bytes, and so is unreadable.
    got = subprocess.run(['tar', 'xzf', '-', '-O', '--no-recursion', '--', names[0]],
                         input=data, capture_output=True)
    meta = None
    if got.returncode == 0 and not names[0].endswith('/'):
        try:
            meta = json.loads(got.stdout.decode('utf-8'))
        except ValueError:
            pass
    if not isinstance(meta, dict):
        sys.exit("bashtion-unpack: this archive's session.json is unreadable; "
                 'nothing was restored')
    fmt = meta.get('format')
    if type(fmt) is not int or fmt < 1:
        sys.exit('bashtion-unpack: unknown archive format %.40r; nothing was '
                 'restored' % (fmt,))
    if fmt > FORMAT:
        sys.exit('bashtion-unpack: this archive was saved by a newer bashtion '
                 '(format %d; this one reads up to %d); nothing was restored'
                 % (fmt, FORMAT))
    return meta


def home_only(members, meta, theirs, ours):
    """Say, loudly, that only the home directory came back - and why."""
    system = sum(1 for m in members if not in_home(m) and m != SESSION_REL)
    deleted = meta.get('deleted') if meta else None
    gone = len(deleted) if isinstance(deleted, list) else 0
    if theirs is None:
        why = 'this archive does not record which build of bashtion saved it'
    elif ours is None:
        why = 'this machine has no build id to compare the archive with'
    else:
        why = 'this archive was saved on a different build of bashtion'
    lines = ['WARNING: %s.' % why,
             '  archive saved on build: %s' % (theirs or 'none recorded'),
             '  this machine is build:  %s' % (ours or 'unknown')]
    lines += textwrap.wrap(
        "Only %s was restored. The archive's changes under %s, and its "
        'deletions, were recorded against the image that saved it: applied '
        'here they could silently undo what this build changed, so they were '
        'NOT applied.' % (HOME, ' '.join(SYSTEM_ROOTS)), 60)
    # Last, and on one line: the page reports the restore from this line alone.
    lines.append('restored home only; %d system paths and %d deletions not '
                 'applied (archive build %s, this build %s)'
                 % (system, gone, (theirs or 'none')[:12], (ours or 'unknown')[:12]))
    for line in lines:
        print('bashtion-unpack: ' + line, file=sys.stderr)


def cmd_unpack():
    data = sys.stdin.buffer.read()
    if not data:
        sys.exit('bashtion-unpack: empty archive')

    listed = subprocess.run(['tar', 'tzf', '-'], input=data, capture_output=True)
    if listed.returncode != 0:
        sys.exit('bashtion-unpack: not a readable archive')
    members = set()
    marked = False                # carries the format-2 marker
    sessions = []                 # session.json, as the listing spells it
    roots = set()                 # every tree it writes under, per spelling
    home = set()                  # ...and the home tree alone
    for name in listed.stdout.decode('utf-8', 'replace').splitlines():
        # A leading ./ is only a way of spelling a name, and is dropped. Any
        # other way of making one non-canonical - a .., a ., a //, a leading
        # / - is refused: `.../home/user/x` is not under /home/user, and
        # `var/lib/bashtion/./session.json` must not be a second session.json
        # that the checks below never see.
        n = name
        while n.startswith('./'):
            n = n[2:]
        if n in ('', '.'):
            continue
        key = n.rstrip('/')
        if (n.startswith('/') or '..' in key.split('/')
                or os.path.normpath(key) != key):
            sys.exit('bashtion-unpack: refusing path %r' % name)
        if key == MARKER_REL:
            marked = True
            continue
        if not (key + '/').startswith(ALLOWED):
            sys.exit('bashtion-unpack: refusing path outside the session: %r' % name)
        members.add(key)
        if key == SESSION_REL:
            sessions.append(name)
        # tar selects members by exact name, `./home/user` and `home/user`
        # being different ones, and the listing escapes unusual characters -
        # so select each tree by its root, spelled as this archive does.
        # Whatever is not under one of them - MARKER - is never extracted.
        root = next(r for r in ROOTS_REL if (key + '/').startswith(r + '/'))
        roots.add(name[:len(name) - len(n)] + root)
        if root == HOME_REL:
            home.add(name[:len(name) - len(n)] + root)

    # The system half of an archive is a diff from the image that saved it,
    # and its deletion list is that image's file list. Applied to the same
    # build it restores the session exactly. Applied to any other it puts back
    # the saved copy of every file the newer build changed - reverting its
    # fixes, silently - and replays removals derived from a different tree.
    # So it applies only when both sides name the same build; otherwise the
    # home directory, which means the same thing on any build, is all that
    # comes back. That includes every format-1 archive, saved before builds were
    # named. (Older ones never get here: their members are relative to the home
    # directory, and the name check above refuses them.)
    # Only a format-2 pack writes the marker, and it always writes session.json
    # beside it. A marked archive without one is damaged, or from a format that
    # keeps its metadata elsewhere - not a legacy archive to restore home-only.
    if marked and not sessions:
        sys.exit('bashtion-unpack: this archive is marked format 2 or later but '
                 'carries no session.json; nothing was restored')
    meta = read_meta(data, sessions)
    theirs = meta.get('build') if meta else None
    theirs = theirs if valid_id(theirs) else None
    ours = build_id()
    full = theirs is not None and theirs == ours

    # ALLOWED has already refused anything outside HOME, the system roots and
    # STATE_DIR, so HOME is the only home tree an archive can carry.
    select = sorted(roots if full else home)
    if select:
        out = subprocess.run(
            ['tar', 'xzf', '-', '-C', '/', '--numeric-owner', '--same-owner',
             '--same-permissions', '--acls', '--xattrs', '--xattrs-include=*',
             '--'] + select, input=data, capture_output=True)
        if out.returncode not in (0, 1):
            err = out.stderr.decode('utf-8', 'replace').strip().splitlines()
            sys.exit('bashtion-unpack: %s' % (err or ['tar failed'])[-1])
    if not full:
        return home_only(members, meta, theirs, ours)

    # A file the user deleted stays deleted: without this a restore is a
    # union of every session that ever ran, and removals never take.
    #
    # This list is ARCHIVE-SUPPLIED - session.json is a member like any other -
    # so it gets the same containment treatment as the member names, and it is
    # the one read out of this archive above. Reading whatever session.json
    # happens to be on disk would replay the previous save's deletions over
    # files the current archive just restored.
    deleted = meta.get('deleted', [])
    if not isinstance(deleted, list):
        deleted = []
    removed = refused = 0
    # Deepest first: sorted() puts /opt/pkg before /opt/pkg/a, so replaying in
    # that order hits rmdir on a directory whose children are still there,
    # fails with ENOTEMPTY and leaves the skeleton behind.
    for p in sorted((x for x in deleted if isinstance(x, str)), reverse=True):
        if skip(p) or not contained(p, SYSTEM_ROOTS):
            refused += 1
            continue
        try:
            if os.path.islink(p) or os.path.isfile(p):
                os.unlink(p); removed += 1
            elif os.path.isdir(p):
                os.rmdir(p); removed += 1
        except OSError:
            pass
    note = '; %d refused as out of bounds' % refused if refused else ''
    print('bashtion-unpack: restored; %d deletions applied%s' % (removed, note),
          file=sys.stderr)


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else ''
    if what == 'baseline':
        return cmd_baseline()
    if what == 'pack':
        return cmd_pack()
    if what == 'unpack':
        return cmd_unpack()
    sys.exit('usage: state.py baseline|pack|unpack')


if __name__ == '__main__':
    main()
