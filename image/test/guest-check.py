#!/usr/bin/env python3
"""Boot the built guest image on native QEMU and assert what the guest is
supposed to be.

Every check here exists because something shipped broken and nothing caught
it: an empty offline apt index, an apt that spent minutes retrying a mirror it
could never reach and then reported success, no man pages, a root filesystem
95% full, a failed fallocate that still filled it and a save that could not
run once it had, a user outside adm, a half-configured network, a firewall
that reported rules it had not loaded, and a clock running at 0.4x wall time.
Build-time assertions cover the parts that are visible in the rootfs; these
cover the parts that are only true once the kernel is running.

The invocation mirrors snapshot/make-snapshot.sh, so this tests the machine
that is actually shipped. Native TCG, not the wasm engine - it cannot prove
anything about the browser, but everything asserted here is guest-side.

  usage: guest-check.py [image-dir]        (default: out/image)
  env:   QEMU_BIN, BOOT_TIMEOUT
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

IMG = sys.argv[1] if len(sys.argv) > 1 else 'out/image'
QEMU = os.environ.get('QEMU_BIN', 'qemu-system-x86_64')
BOOT_TIMEOUT = int(os.environ.get('BOOT_TIMEOUT', '900'))

ANSI = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]')

failures = []
checks = 0


class Console:
    """The guest's serial console, as a line-oriented request/response pair."""

    def __init__(self, proc):
        self.proc = proc
        self.raw = bytearray()
        self.lock = threading.Lock()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        while True:
            b = self.proc.stdout.read(1)
            if not b:
                return
            with self.lock:
                self.raw += b

    def text(self, start=0):
        with self.lock:
            chunk = bytes(self.raw[start:])
        return ANSI.sub('', chunk.decode('utf-8', 'replace'))

    def mark(self):
        with self.lock:
            return len(self.raw)

    def send(self, s):
        self.proc.stdin.write(s.encode())
        self.proc.stdin.flush()

    def expect(self, pattern, timeout, start=0):
        deadline = time.time() + timeout
        rx = re.compile(pattern)
        while time.time() < deadline:
            m = rx.search(self.text(start))
            if m:
                return m
            time.sleep(0.2)
        return None


_seq = iter(range(1, 1 << 30))


def capture(con, cmd, timeout=180):
    """Run one command; return (exit status, its output).

    The output has to be found between two markers, not by counting lines. The
    guest echoes the whole command line back before running it - readline
    redisplays what it is given whatever the tty's ECHO flag says - and the
    previous command's prompt is often still unread when this one is sent, so
    the captured region begins in the middle of both.

    The opening marker is therefore printed in a form that cannot appear in the
    line that produces it: `printf 'B%sS\\n' CHK7` puts BCHK7S on the wire but
    never in the echo. (Same trick, same reason, as web/serialfs.js.)
    """
    tag = 'CHK%d' % next(_seq)
    start = con.mark()
    con.send("printf 'B%%sS\\n' %s; %s; echo B%s=$?\n" % (tag, cmd, tag))
    m = con.expect(r'B%s=(\d+)' % tag, timeout, start)
    if not m:
        return None, con.text(start)
    body = con.text(start)[:m.start()]
    open_marker = 'B%sS' % tag
    i = body.find(open_marker)
    if i >= 0:
        body = body[i + len(open_marker):]
    return int(m.group(1)), body.strip()


def check(name, ok, detail=''):
    global checks
    checks += 1
    print('%-4s %s%s' % ('ok' if ok else 'FAIL', name,
                         ('  -- ' + detail.replace('\n', ' | ')[:400]) if detail else ''),
          flush=True)
    if not ok:
        failures.append(name)


def main():
    work = tempfile.mkdtemp(prefix='guest-check-')
    root = os.path.join(work, 'rootfs.ext4')
    lab = os.path.join(work, 'vdb.qcow2')
    shutil.copy(os.path.join(IMG, 'rootfs.ext4'), root)
    shutil.copy(os.path.join(IMG, 'vdb.qcow2'), lab)
    os.mkdir(os.path.join(work, 'share'))

    argv = [
        QEMU, '-display', 'none', '-serial', 'stdio', '-monitor', 'none',
        '-M', 'pc-i440fx-8.2', '-cpu', 'qemu64,+rdrand', '-smp', '1',
        '-m', '512M', '-accel', 'tcg', '-nic', 'none',
        '-kernel', os.path.join(IMG, 'vmlinuz'),
        '-append', 'console=ttyS0,115200n8 root=/dev/vda rw rootwait nokaslr '
                   'nosoftlockup nowatchdog random.trust_cpu=on '
                   'tsc=unstable clocksource=acpi_pm '
                   'modules_load=virtio_rng systemd.show_status=1',
        '-drive', 'id=root,file=%s,format=raw,if=none' % root,
        '-device', 'virtio-blk-pci,drive=root',
        '-drive', 'id=lab,file=%s,format=qcow2,if=none' % lab,
        '-device', 'virtio-blk-pci,drive=lab',
        '-device', 'virtio-rng-pci',
        '-virtfs', 'local,path=%s,mount_tag=share0,security_model=passthrough,id=share0'
                   % os.path.join(work, 'share'),
    ]
    print('==> %s' % ' '.join(argv), flush=True)
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, bufsize=0)
    con = Console(proc)
    try:
        t0 = time.time()
        if not con.expect(r'user@bashtion:[^\n]*\$', BOOT_TIMEOUT):
            print(con.text()[-4000:])
            sys.exit('FATAL: no login prompt within %ds' % BOOT_TIMEOUT)
        print('==> shell after %.0fs' % (time.time() - t0), flush=True)
        con.send('\n')
        time.sleep(2)
        run_checks(con)
    finally:
        try:
            proc.kill()
        except Exception:
            pass
        shutil.rmtree(work, ignore_errors=True)

    print('\n%d checks, %d failed' % (checks, len(failures)), flush=True)
    if failures:
        sys.exit('FAILED: ' + ', '.join(failures))


def run_checks(con):
    # ---- #64 locale and UTF-8 --------------------------------------------
    rc, out = capture(con, 'printf "LANG=[%s]\\n" "$LANG"')
    check('#64 LANG is a UTF-8 locale', 'LANG=[C.UTF-8]' in out, out)
    probe = 'héllo ┌─┐ αβγ'
    rc, out = capture(con, "printf 'UTF8<%s>\\n' '" + probe + "'")
    check('#64 non-ASCII survives the console byte-exact',
          ('UTF8<%s>' % probe) in out, out)

    # ---- #53 the offline apt repository ----------------------------------
    rc, out = capture(con, 'zcat /srv/apt/Packages.gz | grep -c "^Package: "')
    check('#53 Packages.gz is a real index', rc == 0 and out.strip().isdigit()
          and int(out.strip()) > 0, out)
    rc, out = capture(con, 'apt-cache policy tree')
    check('#53 apt offers tree from the local repo', 'file:/srv/apt' in out, out)
    rc, out = capture(con, 'sudo apt-get install -y -o Debug::NoLocking=1 tree 2>&1 | tail -3', 300)
    check('#53 apt install tree succeeds offline', rc == 0, out)
    rc, out = capture(con, 'tree --version')
    check('#53 the installed package runs', rc == 0, out)

    # ---- #56 apt fails at once offline, and says so -----------------------
    # mmdebstrap left the snapshot mirror in sources.list and the build's
    # Acquire::Retries "5" in apt.conf.d, so every Ubuntu package looked
    # installable: apt retried each one for minutes, and `apt update` ended
    # "All packages are up to date." with exit 0. Every status checked below
    # is apt's own: apt writes to a file, not into a pipe as in #53.
    # indextargets lists every configured source, fetched or not; apt-cache
    # policy would show only those whose lists were downloaded.
    rc, out = capture(con, "apt-get indextargets --no-release-info --format '$(URI)'")
    uris = out.split()
    check('#56 apt has no source but the offline repository',
          len(uris) > 0 and all(u.startswith('file:/srv/apt/') for u in uris), out)
    # the first file anyone opens to find the mirror, so it says why there is none
    rc, out = capture(con, "grep -q bashtion /etc/apt/sources.list && "
                           "grep -cvE '^\\s*(#|$)' /etc/apt/sources.list")
    check('#56 /etc/apt/sources.list explains itself', out.strip() == '0', out)
    # Retries 0 alone still lets `apt update` exit 0 on a failed fetch: it
    # takes Error-Mode any to make that an error
    rc, out = capture(con, 'apt-config shell R Acquire::Retries E APT::Update::Error-Mode')
    words = out.split()
    check('#56 apt neither retries nor ignores a failed fetch',
          "R='0'" in words and "E='any'" in words, out)
    # Error-Mode any must not fail the local-only update: the flat repo's
    # Ign: InRelease / Release lines are not failures. 60 s, not 30, because
    # it still reads the dpkg database under TCG on one vCPU.
    t = time.time()
    rc, out = capture(con, 'sudo apt-get update >/tmp/bashtion-56.log 2>&1; echo "apt=$?"; '
                           'tail -3 /tmp/bashtion-56.log; rm -f /tmp/bashtion-56.log', 180)
    dt = time.time() - t
    check('#56 apt-get update succeeds offline (%.1fs)' % dt,
          'apt=0' in out.split() and dt < 60, out)
    # nginx is in Ubuntu main, so the old image tried to fetch it; it is not
    # in /srv/apt, so now apt has no candidate for it at all
    t = time.time()
    rc, out = capture(con, 'sudo apt-get install -y nginx >/tmp/bashtion-56.log 2>&1; '
                           'echo "apt=$?"; tail -3 /tmp/bashtion-56.log; '
                           'rm -f /tmp/bashtion-56.log', 90)
    dt = time.time() - t
    check('#56 apt install of a package not in /srv/apt fails at once (%.1fs)' % dt,
          'apt=100' in out.split() and 'Unable to locate package' in out and dt < 30, out)
    # A mirror added from a tutorial must fail, quickly, and not exit 0 as if
    # it had been fetched. Added and removed in one command, so a failure
    # leaves nothing under /etc for the #50 clean-pack check.
    t = time.time()
    rc, out = capture(con, "echo 'deb http://archive.ubuntu.com/ubuntu resolute main' | "
                           "sudo tee /etc/apt/sources.list.d/bashtion-56.list >/dev/null; "
                           "sudo apt-get update >/tmp/bashtion-56.log 2>&1; echo \"apt=$?\"; "
                           "sudo rm -f /etc/apt/sources.list.d/bashtion-56.list; "
                           "tail -3 /tmp/bashtion-56.log; rm -f /tmp/bashtion-56.log", 90)
    dt = time.time() - t
    check('#56 with a mirror added, apt-get update fails fast and says so (%.1fs)' % dt,
          'apt=100' in out.split() and 'Failed to fetch' in out and dt < 30, out)
    # the one screen everyone sees names the way to list what can be installed
    rc, out = capture(con, "grep -c 'ls /srv/apt' /etc/motd")
    check('#56 the motd says how to list what apt can install', out.strip() == '1', out)

    # ---- #54 manual pages ------------------------------------------------
    rc, out = capture(con, 'man -w ls')
    check('#54 man resolves a page for ls', rc == 0 and '/man/' in out, out)
    rc, out = capture(con, 'man ls 2>/dev/null | wc -l')
    check('#54 man renders a full page',
          out.strip().isdigit() and int(out.strip()) > 20, out)
    rc, out = capture(con, 'man -k passwd 2>&1 | head -2', 120)
    check('#54 apropos index is built', rc == 0 and 'passwd' in out, out)

    # ---- #55 room on the root filesystem ---------------------------------
    rc, out = capture(con, 'df --output=avail -m / | tail -1')
    avail = int(out.strip()) if out.strip().isdigit() else -1
    check('#55 root has >=150 MiB free (%s MiB)' % avail, avail >= 150, out)
    rc, out = capture(con, 'lsblk -dno NAME,SIZE /dev/vdb')
    check('#55 the spare disk /dev/vdb is present', rc == 0 and 'vdb' in out, out)

    # ---- #70 a file-size cap that makes an oversized fallocate atomic -----
    # ext4 keeps whatever fallocate managed to allocate before ENOSPC, so a
    # `fallocate -l 10G` on / used to strand ~240 MB and leave the disk full.
    # RLIMIT_FSIZE is checked before anything is allocated. The cap is the size
    # of /dev/vdb, applied by pam_limits at the autologin - so it is also in
    # every restored session - and root needs its own line: su resets the
    # limit, and '*' never matches root.
    rc, out = capture(con, 'lsblk -bdno SIZE /dev/vdb')
    check('#70 /dev/vdb is 4 GiB', out.strip() == str(4 << 30), out)
    rc, out = capture(con, 'echo "soft=$(ulimit -Sf) hard=$(ulimit -Hf)"')
    check('#70 the shell has a soft 4 GiB file-size cap, hard unlimited',
          'soft=4194304 hard=unlimited' in out, out)
    rc, out = capture(con, "sudo bash -c 'ulimit -Sf'; sudo su -c 'ulimit -Sf'")
    check('#70 root starts capped too, through sudo and through su',
          out.split()[-2:] == ['4194304', '4194304'], out)
    rc, out = capture(con, "(ulimit -f unlimited; ulimit -Sf); "
                           "sudo bash -c 'ulimit -f unlimited; ulimit -Sf'")
    check('#70 ulimit -f unlimited lifts it, on either side of sudo',
          out.split()[-2:] == ['unlimited', 'unlimited'], out)
    rc, out = capture(con, "grep -cF -e 'spare 4 GiB disk' -e 'may not exceed 4 GiB' "
                           "-e 'ulimit -f unlimited' /etc/motd")
    check('#70 the motd gives the disk size, the cap and how to lift it',
          out.strip() == '3', out)
    # 4 GiB is the disk's size, not what the tab can hold: what is written to
    # it lives in the page's memory
    rc, out = capture(con, "grep -c 'do not fill it' /etc/motd")
    check('#70 the motd says not to fill /dev/vdb', out.strip() == '1', out)
    for who, sudo, path in (('the user', '', '/var/tmp/bashtion-70.img'),
                            ('root via sudo', 'sudo ', '/bashtion-70.img')):
        # Measured and cleaned up in one command, so a failure strands nothing.
        # The refusal arrives as SIGXFSZ, whose default action dumps core into
        # the cwd - on / - unless the soft core limit is 0, as Ubuntu's systemd
        # sets it. A core there would also land in the #50 clean-pack check.
        rc, out = capture(con,
                          'b=$(df --output=used -B1 / | tail -1); '
                          '%sfallocate -l 10G %s; r=$?; '
                          'a=$(df --output=used -B1 / | tail -1); '
                          'echo "rc=$r delta=$((a - b)) '
                          'file=$(stat -c %%s:%%b %s 2>/dev/null || echo absent) '
                          'cores=$(ls -d core core.[0-9]* 2>/dev/null | wc -l)"; '
                          '%srm -f %s core core.[0-9]*' % (sudo, path, path, sudo, path), 300)
        m = re.search(r'rc=(\d+) delta=(-?\d+) file=(\S+) cores=(\d+)', out)
        frc, delta, left, cores = ((int(m.group(1)), int(m.group(2)), m.group(3),
                                    int(m.group(4))) if m else (0, 0, '?', -1))
        check('#70 fallocate -l 10G on / is refused for %s (rc %d)' % (who, frc),
              m is not None and frc != 0, out)
        check('#70 ...and strands nothing: no blocks held, df unchanged (%s, %+d bytes)'
              % (left, delta), m is not None and left in ('absent', '0:0')
              and abs(delta) < (64 << 10), out)
        check('#70 ...and dumps no core onto / (%d)' % cores, cores == 0, out)

    # ---- #57 coherently offline ------------------------------------------
    rc, out = capture(con, 'systemctl is-enabled systemd-resolved.service')
    check('#57 systemd-resolved is masked', 'masked' in out, out)
    rc, out = capture(con, 'test -s /etc/resolv.conf && head -1 /etc/resolv.conf')
    check('#57 resolv.conf explains itself', rc == 0 and 'bashtion' in out, out)
    rc, out = capture(con, 'ls /etc/netplan/')
    check('#57 /etc/netplan says why it is empty', 'README-no-network' in out, out)
    t = time.time()
    rc, out = capture(con, 'getent hosts snapshot.ubuntu.com >/dev/null 2>&1', 90)
    check('#57 name resolution fails fast (%.1fs)' % (time.time() - t),
          rc != 0 and time.time() - t < 30, out)
    rc, out = capture(con, 'test -s /etc/motd && grep -c . /etc/motd')
    check('#57 /etc/motd states the limits', rc == 0, out)

    # ---- #59 journal access ----------------------------------------------
    rc, out = capture(con, 'id -Gn')
    check('#59 user is in adm', re.search(r'\badm\b', out) is not None, out)
    rc, out = capture(con, 'journalctl -n 5 --no-pager | wc -l', 180)
    check('#59 journalctl works unprivileged and piped',
          rc == 0 and out.strip().isdigit() and int(out.strip()) > 0, out)

    # ---- #52 the clock ---------------------------------------------------
    rc, out = capture(con, 'cat /sys/devices/system/clocksource/clocksource0/current_clocksource')
    check('#52 clocksource is acpi_pm', out.strip() == 'acpi_pm', out)
    host0 = time.time()
    rc, g0 = capture(con, 'date +%s')
    rc, _ = capture(con, 'sleep 30', 300)
    rc, g1 = capture(con, 'date +%s')
    host1 = time.time()
    try:
        ratio = (int(g1.strip()) - int(g0.strip())) / (host1 - host0)
    except ValueError:
        ratio = -1
    check('#52 guest time tracks wall time (ratio %.2f)' % ratio,
          0.85 <= ratio <= 1.15, 'g0=%s g1=%s' % (g0, g1))

    # ---- #58 ufw actually applies what it reports -------------------------
    rc, out = capture(con, 'sudo ufw allow 22/tcp 2>&1 | tail -1', 180)
    check('#58 ufw allow is accepted', rc == 0, out)
    rc, out = capture(con, 'sudo ufw --force enable 2>&1', 300)
    check('#58 ufw enable succeeds', rc == 0, out)
    check('#58 no missing-netfilter-module warnings',
          'not supported, missing kernel module' not in out, out)
    rc, out = capture(con, 'sudo iptables -S ufw-user-input 2>&1', 180)
    check('#58 the allowed port is in the kernel, not just in ufw status',
          rc == 0 and '--dport 22' in out, out)
    rc, out = capture(con, 'sudo iptables -S ufw-before-input 2>&1 | grep -c ACCEPT', 180)
    check('#58 loopback/established accepts are loaded',
          rc == 0 and out.strip().isdigit() and int(out.strip()) > 0, out)
    capture(con, 'nohup python3 -m http.server 8111 --directory /tmp '
                 '>/tmp/http.log 2>&1 & sleep 3', 120)
    t = time.time()
    rc, out = capture(con, 'curl -s -m 20 -o /dev/null -w "%{http_code}" '
                           'http://localhost:8111/', 120)
    check('#58 loopback still works with the firewall up (%.1fs)' % (time.time() - t),
          '200' in out, out)
    capture(con, 'sudo ufw --force disable 2>&1 | tail -1', 180)

    # ---- #50/#51 the session survives a save/restore round trip -----------
    # First, a session that has changed nothing must pack to almost nothing.
    # This is the check that catches a baseline which does not match the image
    # it shipped as: when it drifts, every save silently carries the difference
    # across a serial console at a few hundred bytes a second.
    rc, out = capture(con, 'sudo /usr/local/sbin/bashtion-pack 2>/tmp/clean.err | wc -c', 600)
    clean = int(out.strip()) if out.strip().isdigit() else -1
    rc, err = capture(con, 'cat /tmp/clean.err')
    print('     clean pack: %s' % err.replace('\n', ' | ')[:600], flush=True)
    check('#50 an untouched session packs small (%s bytes)' % clean,
          0 < clean < 65536, out)

    capture(con, 'echo canary-home > ~/marker.txt; echo canary-share > ~/share/marker.txt')
    capture(con, 'sudo mkdir -p /opt/example/dir && sudo groupadd exgroup && '
                 'sudo useradd -m exuser && sudo setfacl -m u:exuser:rwx /opt/example/dir', 300)
    capture(con, 'sudo sh -c "echo edited-by-user >> /etc/bashtion-probe"')
    rc, out = capture(con, 'sudo /usr/local/sbin/bashtion-pack > /tmp/probe.tgz 2>/tmp/probe.err; '
                           'echo packed $(wc -c < /tmp/probe.tgz)', 600)
    check('#50 bashtion-pack produces an archive', rc == 0 and ' 0' not in out, out)
    rc, err = capture(con, 'cat /tmp/probe.err')
    print('     pack said: %s' % err.replace('\n', ' | ')[:900], flush=True)

    # ---- #72 an archive names the build it was saved on -------------------
    # A restore applies the system half only to that same build, so the image
    # has to carry an id - at the head of the baseline every save is a diff
    # from - and pack has to record exactly it.
    rc, out = capture(con, 'head -1 /usr/local/lib/bashtion/baseline.tsv')
    m = re.fullmatch(r'#build\s+([0-9a-f]{64})', out.strip())
    stamp = m.group(1) if m else ''
    check('#72 the image carries a build id', m is not None, out)
    rc, out = capture(con, "tar xzOf /tmp/probe.tgz var/lib/bashtion/session.json | python3 -c "
                           "'import json,sys; m=json.load(sys.stdin); "
                           "print(\"FORMAT=%s BUILD=%s\" % (m.get(\"format\"), m.get(\"build\")))'")
    m = re.search(r'FORMAT=(\S+) BUILD=(\S+)', out)
    check('#72 pack records the build id, in format 2',
          m is not None and m.group(1) == '2' and len(stamp) == 64
          and m.group(2) == stamp, out)
    # ...and carries the member that makes a pre-#72 unpacker - an old tab,
    # a rolled-back deploy - refuse it instead of applying it blind.
    rc, out = capture(con, 'tar tzf /tmp/probe.tgz | grep -cx usr/lib/bashtion/archive-format-2')
    check('#72 the archive carries the format-2 marker', out.strip() == '1', out)

    capture(con, 'rm -f ~/marker.txt ~/share/marker.txt; '
                 'sudo rm -rf /opt/example /etc/bashtion-probe; '
                 'sudo userdel -r exuser >/dev/null 2>&1; sudo groupdel exgroup', 300)
    rc, out = capture(con, 'sudo /usr/local/sbin/bashtion-unpack < /tmp/probe.tgz 2>&1', 600)
    check('#50 bashtion-unpack applies it', rc == 0, out)
    check('#72 an archive from this same build restores in full',
          'bashtion-unpack: restored; ' in out and 'home only' not in out, out)

    rc, out = capture(con, 'cat ~/marker.txt')
    check('#50 a home file comes back', 'canary-home' in out, out)
    rc, out = capture(con, 'cat ~/share/marker.txt')
    check('#51 ~/share comes back too (it used to be the one excluded path)',
          'canary-share' in out, out)
    rc, out = capture(con, 'id exuser')
    check('#50 a user created in the session comes back', rc == 0, out)
    rc, out = capture(con, 'getfacl -p /opt/example/dir 2>/dev/null | grep user:exuser')
    check('#50 an ACL comes back', 'exuser:rwx' in out, out)
    rc, out = capture(con, 'cat /etc/bashtion-probe')
    check('#50 an edited /etc file comes back', 'edited-by-user' in out, out)
    capture(con, 'sudo rm -rf /opt/example /etc/bashtion-probe /tmp/probe.tgz /tmp/probe.err; '
                 'rm -f ~/marker.txt ~/share/marker.txt; '
                 'sudo userdel -r exuser >/dev/null 2>&1; sudo groupdel exgroup', 300)

    # ...and one from any other build brings back home, and nothing else.
    other = '0' * 64
    capture(con, 'rm -rf /tmp/x72 && mkdir -p /tmp/x72/home/user /tmp/x72/etc '
                 '/tmp/x72/var/lib/bashtion && '
                 'echo from-elsewhere > /tmp/x72/home/user/x72.txt && '
                 'echo from-elsewhere > /tmp/x72/etc/bashtion-x72 && '
                 "echo '{\"format\": 2, \"build\": \"%s\"}' "
                 '> /tmp/x72/var/lib/bashtion/session.json && '
                 'tar czf /tmp/x72.tgz -C /tmp/x72 home/user/x72.txt etc/bashtion-x72 '
                 'var/lib/bashtion/session.json' % other)
    rc, out = capture(con, 'sudo /usr/local/sbin/bashtion-unpack < /tmp/x72.tgz 2>&1', 600)
    check('#72 an archive from another build restores home only',
          rc == 0 and 'bashtion-unpack: restored home only; ' in out, out)
    check('#72 ...and the warning names both builds',
          other in out and len(stamp) == 64 and stamp in out, out)
    rc, out = capture(con, 'cat ~/x72.txt; '
                           'test -e /etc/bashtion-x72 && echo SYSTEM-APPLIED || echo SYSTEM-SKIPPED')
    check('#72 its home file comes back', 'from-elsewhere' in out, out)
    check('#72 its system file does not', 'SYSTEM-SKIPPED' in out, out)
    capture(con, 'sudo rm -rf /tmp/x72 /tmp/x72.tgz /etc/bashtion-x72; rm -f ~/x72.txt', 120)

    # ---- #60 the guest can be told the terminal's shape -------------------
    rc, out = capture(con, 'stty rows 43 cols 160; stty size')
    check('#60 the console accepts a window size', out.strip().endswith('43 160'), out)
    capture(con, 'stty rows 24 cols 80')

    # ---- #63 the utilities that were missing ------------------------------
    tools = ('file', 'wget', 'nslookup', 'nft', 'cryptsetup', 'lpr', 'lpq', 'lprm')
    rc, out = capture(con, 'command -v ' + ' '.join(tools))
    # command -v succeeds when any one of the names is found, so count them
    check('#63 %s are all on the PATH' % ' '.join(tools),
          rc == 0 and sorted(os.path.basename(p) for p in out.split()) == sorted(tools), out)
    rc, out = capture(con, 'man -w ' + ' '.join(tools))
    check('#63 man resolves a page for each of them',
          rc == 0 and out.count('/man/') == len(tools), out)
    rc, out = capture(con, 'file -bL /usr/bin/ls')
    check('#63 file identifies a binary', 'ELF 64-bit' in out, out)
    # the #58 http.server is still listening on loopback
    rc, out = capture(con, 'wget -nv -O /dev/null http://localhost:8111/', 120)
    check('#63 wget fetches over loopback', rc == 0, out)
    t = time.time()
    rc, out = capture(con, 'wget -O /dev/null http://snapshot.ubuntu.com/', 90)
    check('#63 wget of an outside URL fails fast (%.1fs)' % (time.time() - t),
          rc != 0 and time.time() - t < 30, out)
    t = time.time()
    rc, out = capture(con, 'nslookup snapshot.ubuntu.com', 90)
    check('#63 nslookup fails fast (%.1fs)' % (time.time() - t),
          rc != 0 and time.time() - t < 30, out)

    # ---- #63 nft, alongside ufw -------------------------------------------
    # /etc/nftables.conf starts with `flush ruleset`, ufw's rules included
    rc, out = capture(con, 'systemctl is-enabled nftables.service')
    check('#63 nftables.service is disabled', out.strip() == 'disabled', out)
    # After #58, so ufw has already been through iptables-nft. One transaction:
    # the table loads whole or not at all, and is deleted straight after.
    rc, out = capture(con, "sudo nft 'add table inet bashtion63; "
                           "add chain inet bashtion63 input "
                           "{ type filter hook input priority 0; policy accept; }; "
                           "add rule inet bashtion63 input ct state established,related accept; "
                           "add rule inet bashtion63 input tcp dport 8163 reject' && "
                           "sudo nft list table inet bashtion63", 180)
    check('#63 nft loads an inet table with a ct state rule and a reject',
          rc == 0 and 'ct state established,related accept' in out
          and 'tcp dport 8163 reject' in out, out)
    rc, out = capture(con, 'sudo nft delete table inet bashtion63 && sudo nft list tables', 180)
    check('#63 ...and deletes it, leaving no table behind',
          rc == 0 and 'bashtion63' not in out, out)

    # ---- #63 LUKS over dm-crypt -------------------------------------------
    # Only the PBKDF is forced cheap. This checks the kernel side - dm-crypt
    # for the data, AF_ALG for the keyslots, XTS - and argon2id's default cost
    # on native TCG says nothing about the browser. Formatted, opened, closed
    # and removed in one command, so a failure strands nothing.
    rc, out = capture(con,
                      "sudo bash -c 'f=/tmp/bashtion-63.luks; truncate -s 32M $f; "
                      "echo bashtion-63 | cryptsetup luksFormat --batch-mode "
                      "--pbkdf pbkdf2 --pbkdf-force-iterations 1000 $f; echo format=$?; "
                      "echo bashtion-63 | cryptsetup open $f bashtion63; echo open=$?; "
                      "test -b /dev/mapper/bashtion63 && echo mapped=1; "
                      "cryptsetup status bashtion63; cryptsetup close bashtion63; echo close=$?; "
                      "rm -f $f; udevadm settle; "
                      "echo maps=$(ls /dev/mapper | grep -c bashtion63) "
                      "loops=$(losetup -a | grep -c bashtion-63)' 2>&1", 600)
    words = out.split()
    check('#63 cryptsetup formats a LUKS volume on a file and opens it',
          'format=0' in words and 'open=0' in words and 'mapped=1' in words, out)
    check('#63 ...with the default cipher, aes-xts-plain64',
          re.search(r'cipher:\s+aes-xts-plain64\b', out) is not None, out)
    check('#63 ...and closing it leaves no mapping or loop device behind',
          'close=0' in words and 'maps=0' in words and 'loops=0' in words, out)

    # ---- #63 the BSD printing commands ------------------------------------
    # No queue is configured, so there is nothing to list - but lpq has to
    # hear that from the scheduler, not fail to reach it.
    rc, out = capture(con, 'lpq', 180)
    check('#63 lpq reaches the cups scheduler',
          'no default destination' in out and 'Unable to connect' not in out, out)

    # ---- #70 a save works when / is 100% full -----------------------------
    # LAST on purpose: this fills the root filesystem, and anything that ran
    # after a failed cleanup would be measuring a full disk. pack used to write
    # session.json to /var/lib/bashtion first, so on a full disk the save died
    # with a traceback - survivable only when an earlier copy's block could be
    # reused, which is why any such copy is removed first. The fill is the very
    # partial fallocate the cap exists to stop, run with the cap lifted on the
    # root side so the root reserve goes too. /tmp, where pack now stages its
    # metadata and the page writes the archive, is a tmpfs and unaffected.
    rc, out = capture(con, 'findmnt -no FSTYPE /tmp')
    check('#70 /tmp is a tmpfs, so it has room when / has none',
          out.strip() == 'tmpfs', out)
    capture(con, 'sudo rm -f /var/lib/bashtion/session.json')
    rc, out = capture(con, "echo \"was=$(df --output=avail -m / | tail -1 | tr -d ' ')\"; "
                           "sudo bash -c 'ulimit -f unlimited; "
                           "fallocate -l 10G /var/tmp/bashtion-70-fill' 2>&1; "
                           "echo \"avail=$(df --output=avail -B1 / | tail -1 | tr -d ' ')\"", 600)
    m = re.search(r'was=(\d+)', out)
    was = int(m.group(1)) if m else -1
    check('#70 / is full for the test (%d MiB were free)' % was, 'avail=0' in out.split(), out)
    rc, out = capture(con, 'sudo /usr/local/sbin/bashtion-pack > /tmp/full.tgz 2>/tmp/full.err; '
                           'echo "pack=$?"; tail -1 /tmp/full.err; '
                           'echo "meta=$(tar tzf /tmp/full.tgz | grep -cx var/lib/bashtion/session.json)"; '
                           'echo "marker=$(tar tzf /tmp/full.tgz | grep -cx usr/lib/bashtion/archive-format-2)"; '
                           'test -e /var/lib/bashtion/session.json && echo WROTE-IN-PLACE; '
                           'test -e /usr/lib/bashtion/archive-format-2 && echo WROTE-IN-PLACE', 900)
    check('#70 bashtion-pack succeeds with / at 100%', 'pack=0' in out.split(), out)
    check('#70 ...its archive carries the session metadata', 'meta=1' in out.split(), out)
    # staged with the metadata, so a full / cannot keep it out (#72)
    check('#70 ...and the format-2 marker', 'marker=1' in out.split(), out)
    check('#70 ...and it wrote nothing to /', 'WROTE-IN-PLACE' not in out, out)
    rc, out = capture(con, 'sudo rm -f /var/tmp/bashtion-70-fill; '
                           'echo "avail=$(df --output=avail -m / | tail -1 | tr -d \' \')"', 300)
    m = re.search(r'avail=(\d+)', out)
    avail = int(m.group(1)) if m else -1
    check('#70 the fill is cleaned up (%d MiB free again, %d before)' % (avail, was),
          was > 0 and avail >= was - 1, out)
    rc, out = capture(con, 'sudo /usr/local/sbin/bashtion-unpack < /tmp/full.tgz 2>&1; '
                           'echo "unpack=$?"; rm -f /tmp/full.tgz /tmp/full.err', 600)
    # Exit 0 alone no longer says it: a restore of home only exits 0 too (#72).
    # Saved on this very build, with its id staged in /tmp, it comes back whole.
    check('#70 the archive saved on a full disk restores, in full',
          'unpack=0' in out.split() and 'bashtion-unpack: restored; ' in out, out)


if __name__ == '__main__':
    main()
