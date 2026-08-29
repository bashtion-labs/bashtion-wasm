#!/usr/bin/env bash
# Pre-boot the guest on NATIVE qemu and capture VM state, so the browser
# restores an already-booted system instead of sitting through systemd under
# TCI. Runs qemu in Docker (linux/amd64) and drives the migration over QMP.
#
# Usage: snapshot/make-snapshot.sh [out/image] [out/snapshot]
set -euo pipefail
IMG_DIR=${1:-out/image}
OUT_DIR=${2:-out/snapshot}
[ -f "$IMG_DIR/rootfs.ext4" ] || { echo "run 'make image' first"; exit 1; }
mkdir -p "$OUT_DIR"

# Machine/CPU/memory here MUST match web/module.js exactly - a migration
# stream only restores onto an identical machine.
docker run --rm --platform linux/amd64 \
  -v "$PWD/$IMG_DIR:/img:ro" -v "$PWD/$OUT_DIR:/out" \
  ubuntu:24.04 bash -exc '
    apt-get update -qq && apt-get install -y -qq qemu-system-x86 python3 >/dev/null
    qemu-system-x86_64 \
      -M pc -cpu qemu64 -m 1024M -smp 1 -accel tcg \
      -nographic -nic none \
      -kernel /img/vmlinuz \
      -drive if=virtio,format=raw,file=/img/rootfs.ext4,snapshot=on \
      -append "console=ttyS0,115200n8 root=/dev/vda rw rootwait nokaslr" \
      -qmp unix:/tmp/qmp.sock,server=on,wait=off \
      -serial file:/out/boot-console.log &
    QPID=$!
    # wait for a login prompt on the serial log, then snapshot via QMP
    for i in $(seq 1 300); do
      grep -q "login:" /out/boot-console.log 2>/dev/null && break
      sleep 2
    done
    grep -q "login:" /out/boot-console.log || { echo "no login prompt after 10min"; kill $QPID; exit 1; }
    python3 - <<PYQ
import json, socket, time
s = socket.socket(socket.AF_UNIX); s.connect("/tmp/qmp.sock")
f = s.makefile("rw")
def cmd(c, **a):
    f.write(json.dumps({"execute": c, **({"arguments": a} if a else {})}) + "\n"); f.flush()
    while True:
        r = json.loads(f.readline())
        if "return" in r or "error" in r: return r
f.readline(); cmd("qmp_capabilities")
cmd("stop")
cmd("migrate", uri="exec:cat > /out/vm.state")
while True:
    st = cmd("query-migrate")["return"].get("status")
    if st == "completed": break
    if st == "failed": raise SystemExit("migration failed")
    time.sleep(1)
cmd("quit")
PYQ
    wait $QPID || true
    ls -la /out/
  '
echo "snapshot: $OUT_DIR/vm.state"
