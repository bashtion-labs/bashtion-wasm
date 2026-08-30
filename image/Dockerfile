# syntax = docker/dockerfile:1.5
#
# Guest image: Ubuntu 24.04 (noble) amd64 rootfs + Ubuntu's own kernel, built
# for qemu-system-x86_64 running under wasm (TCI, no KVM, no network).
#
# Design decisions (see repo README and patches/ for background):
# - Rootfs via mmdebstrap from snapshot.ubuntu.com (immutable, reproducible).
# - Kernel is Ubuntu's stock linux-image-virtual family, installed THROUGH dpkg
#   inside the chroot so `dpkg -l` / `apt list --installed` truthfully report
#   the running kernel (package-tooling exercises depend on that fidelity).
# - dm/quota/9p/netfilter availability is asserted at build time with modinfo:
#   a missing module fails the build, not the user at runtime.
# - Root fs passno is 0 in fstab: there is no initramfs fsck path, and a forced
#   fsck of the mounted root under systemd produces a failed unit every boot.
# - LVM: use_devicesfile=0, or noble's lvm2 hides fresh virtio disks from
#   pvcreate behind /etc/lvm/devices/system.devices.
# - The second disk (vdb) ships as a raw empty image: no partition table, no
#   filesystem - partitioning it is the user's exercise.

ARG SUITE=noble
# snapshot.ubuntu.com timestamp: every apt source below resolves through this,
# so the build cannot drift or rot. Bump deliberately.
ARG SNAPSHOT=20260820T000000Z
ARG MIRROR=https://snapshot.ubuntu.com/ubuntu/${SNAPSHOT}

FROM --platform=linux/amd64 ubuntu:24.04 AS builder
ARG SUITE
ARG MIRROR
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      mmdebstrap e2fsprogs zstd xz-utils libcap2-bin kmod \
      dpkg-dev apt-utils ca-certificates curl uidmap python3
# mke2fs -d with xattr support needs e2fsprogs >= 1.47 (noble ships 1.47.0)
RUN mke2fs -V 2>&1 | head -1

# ---------------------------------------------------------------- rootfs tar
COPY packages.txt /packages.txt
RUN grep -vE '^\s*(#|$)' /packages.txt | tr '\n' ',' | sed 's/,$//' > /pkglist
# --mode=root inside docker build requires no userns setup and is the
# proven-working path; the tar preserves ownership and xattrs for later
# extraction. Recommends stay off; docs are pruned but per-package copyright
# files are kept (licence hygiene).
RUN mmdebstrap --arch=amd64 --variant=important --mode=root --format=tar \
      --components=main,universe \
      --include="$(cat /pkglist)" \
      --aptopt='APT::Install-Recommends "false"' \
      --aptopt='Acquire::Retries "5"' \
      --dpkgopt='path-exclude=/usr/share/doc/*' \
      --dpkgopt='path-include=/usr/share/doc/*/copyright' \
      --dpkgopt='path-exclude=/usr/share/man/??*' \
      ${SUITE} /rootfs.tar ${MIRROR}

RUN mkdir /rootfs && tar -C /rootfs --xattrs --xattrs-include='*' \
      --numeric-owner -xf /rootfs.tar && rm /rootfs.tar
# capability xattrs must have survived the tar round-trip
RUN getcap /rootfs/usr/bin/ping | grep -q cap_net_raw || \
      { echo "FATAL: cap_net_raw lost in transit"; exit 1; }

# ----------------------------------------------------------------- kernel
# Installed through apt INSIDE the chroot, against the pinned snapshot mirror
# mmdebstrap wrote into sources.list. The snapshot timestamp is the version
# pin - no guessed kernel ABI to go stale. dpkg/apt inside the guest report
# the running kernel truthfully, which package-tooling exercises rely on.
# the chroot needs DNS only during build; the file is removed again below
RUN rm -f /rootfs/etc/resolv.conf && cp /etc/resolv.conf /rootfs/etc/resolv.conf
# persist the doc/man excludes for every later in-chroot install too
RUN mkdir -p /rootfs/etc/dpkg/dpkg.cfg.d && printf '%s\n' \
      'path-exclude=/usr/share/doc/*' \
      'path-include=/usr/share/doc/*/copyright' \
      'path-exclude=/usr/share/man/??*' \
      > /rootfs/etc/dpkg/dpkg.cfg.d/90-bashtion-trim
RUN chroot /rootfs apt-get update && \
    chroot /rootfs apt-get install -y --no-install-recommends linux-image-virtual
RUN KVER=$(ls /rootfs/lib/modules | sort -V | tail -1) && echo "KVER=$KVER" && \
    chroot /rootfs apt-get install -y --no-install-recommends \
      linux-modules-extra-${KVER} && \
    echo "$KVER" > /kver
# kernel out for QEMU's -kernel
RUN mkdir -p /out && cp /rootfs/boot/vmlinuz-$(cat /kver) /out/vmlinuz && \
    cp /rootfs/boot/config-$(cat /kver) /out/kernel-config

# prune /lib/modules to the required set plus its dependency closure.
# linux-modules-extra alone unpacks to hundreds of MB; the guest needs a
# fraction of it. modules.dep lines are "mod.ko: dep1.ko dep2.ko ...".
COPY modules-keep.txt /modules-keep.txt
RUN KVER=$(cat /kver); MODDIR=/rootfs/lib/modules/$KVER; \
    python3 - "$MODDIR" <<'PYEOF'
import os, sys
moddir = sys.argv[1]
deps = {}
for line in open(os.path.join(moddir, 'modules.dep')):
    head, _, rest = line.partition(':')
    deps[head.strip()] = rest.split()
def norm(name):
    n = name.strip().replace('-', '_')
    for path in deps:
        base = os.path.basename(path)
        for ext in ('.ko', '.ko.zst', '.ko.xz'):
            if base.endswith(ext) and base[:-len(ext)].replace('-', '_') == n:
                return path
    return None
keep = set()
missing = []
for want in open('/modules-keep.txt'):
    want = want.split('#')[0].strip()
    if not want:
        continue
    p = norm(want)
    if p is None:
        missing.append(want)
        continue
    stack = [p]
    while stack:
        cur = stack.pop()
        if cur in keep:
            continue
        keep.add(cur)
        stack.extend(deps.get(cur, []))
builtin = open(os.path.join(moddir, 'modules.builtin')).read().replace('-', '_')
really_missing = [m for m in missing if (m + '.ko') not in builtin]
if really_missing:
    raise SystemExit('FATAL: not found as module or builtin: %r' % really_missing)
removed = kept_bytes = 0
for root, _, files in os.walk(os.path.join(moddir, 'kernel')):
    for f in files:
        full = os.path.join(root, f)
        rel = os.path.relpath(full, moddir)
        if rel in keep:
            kept_bytes += os.path.getsize(full)
        else:
            os.unlink(full); removed += 1
print('kept %d modules (%.1f MB), removed %d' % (len(keep), kept_bytes / 1e6, removed))
PYEOF
RUN KVER=$(cat /kver); chroot /rootfs depmod "$KVER" && du -sh /rootfs/lib/modules

# hard assertions: every module a required capability depends on must exist as
# a .ko for this kernel or be built in - a miss fails the build, not the user.
RUN KVER=$(cat /kver); ok=1; \
    for m in dm_mod dm_snapshot dm_mirror dm_thin_pool quota_v2 quota_tree \
             9p 9pnet_virtio ip_tables iptable_filter nf_conntrack \
             xt_conntrack xt_limit ipt_REJECT overlay virtio_blk virtio_pci; do \
      if modinfo -b /rootfs -k "$KVER" "$m" >/dev/null 2>&1; then continue; fi; \
      if grep -qE "(/|^)$(echo $m | tr _ -)\.ko" /rootfs/lib/modules/$KVER/modules.builtin 2>/dev/null || \
         grep -qE "(/|^)${m}\.ko" /rootfs/lib/modules/$KVER/modules.builtin 2>/dev/null; then continue; fi; \
      echo "FATAL: $m unavailable for $KVER"; ok=0; \
    done; [ $ok = 1 ]

# ------------------------------------------------------- guest customization
COPY seed/ /seed/
RUN set -e; \
    echo bashtion > /rootfs/etc/hostname; \
    printf '127.0.0.1\tlocalhost\n127.0.1.1\tbashtion\n' > /rootfs/etc/hosts; \
    chroot /rootfs systemd-machine-id-setup; \
    chroot /rootfs useradd -m -s /bin/bash -G sudo -u 1000 user; \
    echo 'user:changeme' | chroot /rootfs chpasswd; \
    echo 'root:root' | chroot /rootfs chpasswd
# fstab: root passno 0 (no initramfs fsck path); 9p share is optional at boot
RUN printf '%s\n' \
      '/dev/vda / ext4 defaults,errors=remount-ro 0 0' \
      'share0 /home/user/persist 9p trans=virtio,version=9p2000.L,msize=512000,cache=loose,rw,nofail 0 0' \
      > /rootfs/etc/fstab && \
    mkdir -p /rootfs/home/user/persist && \
    chroot /rootfs chown user:user /home/user/persist
# lvm: without this, fresh virtio disks are invisible to pvcreate on noble
RUN mkdir -p /rootfs/etc/lvm && \
    printf 'devices {\n\tuse_devicesfile = 0\n}\n' > /rootfs/etc/lvm/lvm.conf.d-bashtion.conf 2>/dev/null; \
    sed -i 's/# *use_devicesfile *=.*/use_devicesfile = 0/' /rootfs/etc/lvm/lvm.conf 2>/dev/null || \
    printf 'devices {\n\tuse_devicesfile = 0\n}\n' >> /rootfs/etc/lvm/lvm.conf
# systemd: mask what hangs or fails on a no-network, no-RTC-battery, slow box.
# Deliberately NOT setting a global DefaultTimeoutStartSec: on weak hardware a
# legitimate slow unit must not cascade into failures.
# Every masked unit is ~5-10s of TCI time at boot. Everything here is either
# network-dependent (none exists), hardware-dependent (none exists), or
# maintenance that a disposable browser VM never needs. lvm2-monitor is
# masked deliberately: it is the dmeventd monitoring daemon, not the lvm2
# command-line tools the storage exercises use.
RUN for u in systemd-networkd.service systemd-networkd-wait-online.service \
             systemd-timesyncd.service apt-daily.timer apt-daily-upgrade.timer \
             motd-news.timer man-db.timer e2scrub_all.timer fstrim.timer \
             systemd-random-seed.service \
             keyboard-setup.service console-setup.service \
             lvm2-monitor.service blk-availability.service \
             modprobe@drm.service modprobe@configfs.service \
             modprobe@fuse.service modprobe@efi_pstore.service \
             systemd-binfmt.service systemd-pstore.service \
             systemd-backlight@.service systemd-rfkill.service \
             plymouth-quit-wait.service plymouth-start.service \
             e2scrub_reap.service systemd-journal-flush.service \
             setvtrgb.service; do \
      chroot /rootfs systemctl mask $u >/dev/null 2>&1 || true; \
    done
# serial console autologin-free getty; console on ttyS0
RUN chroot /rootfs systemctl enable serial-getty@ttyS0.service
# Under TCI each generator costs ~8s and systemd's sandboxed-generator batch
# has a hard 90s internal deadline (SIGALRM -> "Protocol error" -> "Freezing
# execution", measured). Mask every generator this machine cannot use via
# /etc/ overrides - dpkg-owned files stay untouched. Kept: fstab (mounts),
# getty (serial console), debug.
RUN mkdir -p /rootfs/etc/systemd/system-generators && \
    for g in $(ls /rootfs/usr/lib/systemd/system-generators/); do \
      case "$g" in \
        systemd-fstab-generator|systemd-getty-generator|systemd-debug-generator) ;; \
        *) ln -sf /dev/null /rootfs/etc/systemd/system-generators/$g ;; \
      esac; \
    done && ls -la /rootfs/etc/systemd/system-generators/ | head -20

# ------------------------------------------------------------- offline apt
# Packages installable DURING use (not preinstalled), with dependency closure.
COPY apt-repo/extra-packages.txt /extra-packages.txt
RUN set -e; mkdir -p /rootfs/srv/apt; \
    if grep -vE '^\s*(#|$)' /extra-packages.txt >/dev/null 2>&1; then \
      pkgs=$(grep -vE '^\s*(#|$)' /extra-packages.txt | tr '\n' ' '); \
      chroot /rootfs sh -c "cd /srv/apt && apt-get update -qq && \
        apt-get install --print-uris -qq --no-install-recommends $pkgs 2>/dev/null | \
        cut -d\\' -f2 | grep '^http' | xargs -r -n1 curl -fsSLO"; \
    fi; \
    chroot /rootfs sh -c "cd /srv/apt && dpkg-scanpackages . /dev/null | gzip > Packages.gz"; \
    printf 'deb [trusted=yes] file:/srv/apt ./\n' > /rootfs/etc/apt/sources.list.d/local.list; \
    rm -f /rootfs/etc/apt/sources.list.d/ubuntu.sources; \
    rm -rf /rootfs/var/lib/apt/lists/* /rootfs/var/cache/apt/*.bin; \
    chroot /rootfs apt-get update

# --------------------------------------------------------------- trim pass
RUN rm -f /rootfs/etc/resolv.conf && touch /rootfs/etc/resolv.conf
RUN set -e; \
    rm -rf /rootfs/usr/share/vim/vim*/doc /rootfs/usr/share/vim/vim*/tutor \
           /rootfs/usr/share/vim/vim*/spell /rootfs/usr/share/vim/vim*/lang \
           /rootfs/usr/share/zoneinfo/right /rootfs/usr/share/zoneinfo/posix \
           /rootfs/var/cache/apt/archives /rootfs/var/cache/man \
           /rootfs/usr/share/icons /rootfs/usr/share/fonts; \
    # keep only English message catalogs
    find /rootfs/usr/share/locale -mindepth 1 -maxdepth 1 \
         ! -name 'en*' ! -name 'C.*' ! -name locale.alias -exec rm -rf {} +; \
    # python bytecode caches regenerate on use
    find /rootfs/usr/lib/python3* -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null; \
    du -sh /rootfs

# size evidence in the build log: top consumers before the image is cut
RUN du -x --max-depth=2 --block-size=1M /rootfs 2>/dev/null | sort -rn | head -25

# ------------------------------------------------------------- disk images
# root: measured content + headroom for user-created files
RUN size_kb=$(du -s --block-size=1024 /rootfs | cut -f1); \
    size_mb=$(( size_kb / 1024 * 108 / 100 + 64 )); \
    echo "rootfs ${size_mb}M"; \
    mke2fs -q -t ext4 -J size=16 -L bashtion-root -d /rootfs -b 4096 \
      /out/rootfs.ext4 ${size_mb}M
# verify the capability xattr survived mke2fs -d
RUN debugfs -R 'ea_list /usr/bin/ping' /out/rootfs.ext4 2>/dev/null | \
      grep -q security.capability || { echo "FATAL: cap xattr lost in ext4"; exit 1; }
# practice disk: qcow2, empty, unpartitioned - partitioning it is the
# exercise. qcow2 so the browser holds ~200 KB, growing only as written,
# instead of 256 MB of raw zeros resident in the wasm heap.
RUN apt-get install -y --no-install-recommends qemu-utils >/dev/null && \
    qemu-img create -f qcow2 /out/vdb.qcow2 1G && ls -la /out/vdb.qcow2
# manifest
ARG SNAPSHOT
RUN python3 - <<PYEOF
import json, hashlib, os
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''): h.update(c)
    return h.hexdigest()
json.dump({
    'suite': '${SUITE}', 'snapshot': '${SNAPSHOT}',
    'kernel': open('/kver').read().strip(),
    'artifacts': {p: {'bytes': os.path.getsize('/out/' + p), 'sha256': sha('/out/' + p)}
                  for p in os.listdir('/out')},
}, open('/out/manifest.json', 'w'), indent=1)
PYEOF

FROM scratch
COPY --from=builder /out/ /
