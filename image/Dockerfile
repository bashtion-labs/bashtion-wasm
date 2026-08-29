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
# Installed through dpkg --root so the package database knows about it.
ARG KABI=6.8.0-79
ARG KVER=${KABI}-generic
RUN chroot_apt() { :; }; \
    for p in linux-image-unsigned-${KVER} linux-modules-${KVER} linux-modules-extra-${KVER}; do \
      url=$(cd /rootfs && chroot . /bin/sh -c "apt-get update -qq 2>/dev/null; apt-get download --print-uris -qq $p" | cut -d\' -f2); \
      echo "fetch $p <- $url"; curl -fsSL -o /tmp/$p.deb "$url" || exit 1; \
    done; \
    dpkg --root=/rootfs -i /tmp/linux-image-unsigned-${KVER}.deb \
        /tmp/linux-modules-${KVER}.deb /tmp/linux-modules-extra-${KVER}.deb && \
    rm /tmp/*.deb
# kernel out for QEMU's -kernel; keep /boot copy so update-alternatives paths hold
RUN mkdir -p /out && cp /rootfs/boot/vmlinuz-${KVER} /out/vmlinuz

# hard assertions: every module a capability depends on must resolve
RUN for m in dm-mod dm-snapshot dm-mirror dm-thin-pool quota_v2 quota_tree \
             9p 9pnet_virtio ip_tables iptable_filter nf_conntrack \
             xt_conntrack xt_limit ipt_REJECT overlay virtio_blk virtio_pci; do \
      modinfo -b /rootfs -k ${KVER} $m >/dev/null 2>&1 || \
      grep -qE "(=y)" /rootfs/boot/config-${KVER} 2>/dev/null && \
      grep -q "CONFIG_.*$(echo $m | tr 'a-z-' 'A-Z_').*=y" /rootfs/boot/config-${KVER} || \
      modinfo -b /rootfs -k ${KVER} $m >/dev/null || { echo "FATAL: $m unavailable"; exit 1; }; \
    done

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
RUN for u in systemd-networkd.service systemd-networkd-wait-online.service \
             systemd-timesyncd.service apt-daily.timer apt-daily-upgrade.timer \
             motd-news.timer man-db.timer e2scrub_all.timer fstrim.timer \
             systemd-random-seed.service; do \
      chroot /rootfs systemctl mask $u >/dev/null 2>&1 || true; \
    done
# serial console autologin-free getty; console on ttyS0
RUN chroot /rootfs systemctl enable serial-getty@ttyS0.service

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
    chroot /rootfs apt-get update -qq || true

# --------------------------------------------------------------- trim pass
RUN rm -rf /rootfs/usr/share/vim/vim*/doc /rootfs/usr/share/vim/vim*/tutor \
           /rootfs/usr/share/zoneinfo/right /rootfs/usr/share/zoneinfo/posix \
           /rootfs/var/cache/apt/archives/*.deb /rootfs/var/lib/apt/lists/*_Packages* || true; \
    du -sh /rootfs

# ------------------------------------------------------------- disk images
# root: measured content + headroom for user-created files
RUN size_kb=$(du -s --block-size=1024 /rootfs | cut -f1); \
    size_mb=$(( size_kb / 1024 * 120 / 100 + 128 )); \
    echo "rootfs ${size_mb}M"; \
    mke2fs -q -t ext4 -J size=16 -L bashtion-root -d /rootfs -b 4096 \
      /out/rootfs.ext4 ${size_mb}M
# verify the capability xattr survived mke2fs -d
RUN debugfs -R 'ea_list /usr/bin/ping' /out/rootfs.ext4 2>/dev/null | \
      grep -q security.capability || { echo "FATAL: cap xattr lost in ext4"; exit 1; }
# practice disk: raw, empty, unpartitioned - partitioning it is the exercise
RUN dd if=/dev/zero of=/out/vdb.img bs=1M count=0 seek=256
# manifest
ARG SNAPSHOT
ARG KABI
RUN python3 - <<PYEOF
import json, hashlib, os
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''): h.update(c)
    return h.hexdigest()
json.dump({
    'suite': '${SUITE}', 'snapshot': '${SNAPSHOT}', 'kernel': '${KABI}-generic',
    'artifacts': {p: {'bytes': os.path.getsize('/out/' + p), 'sha256': sha('/out/' + p)}
                  for p in os.listdir('/out')},
}, open('/out/manifest.json', 'w'), indent=1)
PYEOF

FROM scratch
COPY --from=builder /out/ /
