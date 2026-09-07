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

  usage: state.py baseline        record what the image shipped as (build time)
         state.py pack            write a .tar.gz of the session to stdout
         state.py unpack          read one from stdin and apply it
"""
import json
import os
import stat
import subprocess
import sys
import time

HOME = '/home/user'
SYSTEM_ROOTS = ['/etc', '/opt', '/srv', '/usr/local', '/root', '/var/spool/cron']
STATE_DIR = '/var/lib/bashtion'
BASELINE = '/usr/local/lib/bashtion/baseline.tsv'
SESSION = STATE_DIR + '/session.json'
FORMAT = 1

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


def skip(path):
    return path in SKIP_EXACT or path.startswith(SKIP_PREFIX)


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
    n = 0
    tmp = BASELINE + '.tmp'
    with open(tmp, 'w') as f:
        for root in SYSTEM_ROOTS:
            for p in walk(root):
                if skip(p):
                    continue
                try:
                    f.write('%s\t%s\n' % (p, stamp(p)))
                except OSError:
                    continue
                n += 1
    os.replace(tmp, BASELINE)
    print('baseline: %d paths' % n)


def read_baseline():
    base = {}
    try:
        with open(BASELINE) as f:
            for line in f:
                parts = line.rstrip('\n').split('\t')
                if len(parts) == 4:
                    base[parts[0]] = (parts[1], parts[2], parts[3])
    except OSError:
        pass
    return base


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
    base = read_baseline()
    if not base:
        print('bashtion-pack: no baseline; capturing the system roots in full',
              file=sys.stderr)
    system, deleted = changed_system_paths(base)
    home = [p for p in walk(HOME) if not skip(p)]

    os.makedirs(STATE_DIR, exist_ok=True)
    with open(SESSION, 'w') as f:
        json.dump({'format': FORMAT, 'created': int(time.time()),
                   'roots': SYSTEM_ROOTS, 'home': HOME, 'deleted': deleted}, f)

    members = home + system + [SESSION]
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
         '-C', '/', '--null', '-T', '-'],
        stdin=subprocess.PIPE)
    tar.communicate(listing.encode())
    # 1 is "some files differed while being read", which for a live home
    # directory is normal and not a reason to refuse to save.
    sys.exit(0 if tar.returncode in (0, 1) else tar.returncode or 2)


def cmd_unpack():
    data = sys.stdin.buffer.read()
    if not data:
        sys.exit('bashtion-unpack: empty archive')

    listed = subprocess.run(['tar', 'tzf', '-'], input=data, capture_output=True)
    if listed.returncode != 0:
        sys.exit('bashtion-unpack: not a readable archive')
    for name in listed.stdout.decode('utf-8', 'replace').splitlines():
        n = name.lstrip('./')
        if not n:
            continue
        if n.startswith('/') or '..' in n.split('/'):
            sys.exit('bashtion-unpack: refusing path %r' % name)
        if not (n + '/').startswith(ALLOWED):
            sys.exit('bashtion-unpack: refusing path outside the session: %r' % name)

    out = subprocess.run(
        ['tar', 'xzf', '-', '-C', '/', '--numeric-owner', '--same-owner',
         '--same-permissions', '--acls', '--xattrs', '--xattrs-include=*'],
        input=data, capture_output=True)
    if out.returncode not in (0, 1):
        err = out.stderr.decode('utf-8', 'replace').strip().splitlines()
        sys.exit('bashtion-unpack: %s' % (err or ['tar failed'])[-1])

    # A file the user deleted stays deleted: without this a restore is a
    # union of every session that ever ran, and removals never take.
    try:
        with open(SESSION) as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return
    removed = 0
    for p in meta.get('deleted', []):
        if skip(p) or not any(p.startswith(r + '/') for r in SYSTEM_ROOTS):
            continue
        try:
            if os.path.islink(p) or os.path.isfile(p):
                os.unlink(p); removed += 1
            elif os.path.isdir(p):
                os.rmdir(p); removed += 1
        except OSError:
            pass
    print('bashtion-unpack: restored; %d deletions applied' % removed, file=sys.stderr)


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
