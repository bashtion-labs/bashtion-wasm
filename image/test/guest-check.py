#!/usr/bin/env python3
"""Boot the built guest image on native QEMU and assert what the guest is
supposed to be.

Every check here exists because something shipped broken and nothing caught
it: an empty offline apt index, no man pages, a root filesystem 95% full, a
user outside adm, a half-configured network, a firewall that reported rules it
had not loaded, and a clock running at 0.4x wall time. Build-time assertions
cover the parts that are visible in the rootfs; these cover the parts that are
only true once the kernel is running.

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
    """Run one command; return (exit status, its output)."""
    tag = 'BCHK%d' % next(_seq)
    start = con.mark()
    con.send('%s; echo %s=$?\n' % (cmd, tag))
    m = con.expect(r'%s=(\d+)' % tag, timeout, start)
    if not m:
        return None, con.text(start)
    body = con.text(start)[:m.start()]
    # drop the echoed command line itself
    body = body.split('\n', 1)[1] if '\n' in body else ''
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

    # ---- #54 manual pages ------------------------------------------------
    rc, out = capture(con, 'man -w ls')
    check('#54 man resolves a page for ls', rc == 0 and '/man/' in out, out)
    rc, out = capture(con, 'man ls 2>/dev/null | head -2 | tail -1')
    check('#54 man renders it', rc == 0 and 'ls' in out.lower(), out)
    rc, out = capture(con, 'man -k passwd 2>&1 | head -2', 120)
    check('#54 apropos index is built', rc == 0 and 'passwd' in out, out)

    # ---- #55 room on the root filesystem ---------------------------------
    rc, out = capture(con, 'df --output=avail -m / | tail -1')
    avail = int(out.strip()) if out.strip().isdigit() else -1
    check('#55 root has >=150 MiB free (%s MiB)' % avail, avail >= 150, out)
    rc, out = capture(con, 'lsblk -dno NAME,SIZE /dev/vdb')
    check('#55 the spare disk /dev/vdb is present', rc == 0 and 'vdb' in out, out)

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
    capture(con, 'echo canary-home > ~/marker.txt; echo canary-share > ~/share/marker.txt')
    capture(con, 'sudo mkdir -p /opt/example/dir && sudo groupadd exgroup && '
                 'sudo useradd -m exuser && sudo setfacl -m u:exuser:rwx /opt/example/dir', 300)
    capture(con, 'sudo sh -c "echo edited-by-user >> /etc/bashtion-probe"')
    rc, out = capture(con, 'sudo /usr/local/sbin/bashtion-pack > /tmp/probe.tgz 2>/tmp/probe.err; '
                           'echo packed $(wc -c < /tmp/probe.tgz)', 600)
    check('#50 bashtion-pack produces an archive', rc == 0 and ' 0' not in out, out)
    rc, err = capture(con, 'cat /tmp/probe.err')
    print('     pack said: %s' % err.replace('\n', ' | ')[:300], flush=True)

    capture(con, 'rm -f ~/marker.txt ~/share/marker.txt; '
                 'sudo rm -rf /opt/example /etc/bashtion-probe; '
                 'sudo userdel -r exuser >/dev/null 2>&1; sudo groupdel exgroup', 300)
    rc, out = capture(con, 'sudo /usr/local/sbin/bashtion-unpack < /tmp/probe.tgz 2>&1', 600)
    check('#50 bashtion-unpack applies it', rc == 0, out)

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

    # ---- #60 the guest can be told the terminal's shape -------------------
    rc, out = capture(con, 'stty rows 43 cols 160; stty size')
    check('#60 the console accepts a window size', out.strip().endswith('43 160'), out)
    capture(con, 'stty rows 24 cols 80')


if __name__ == '__main__':
    main()
