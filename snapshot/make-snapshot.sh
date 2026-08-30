#!/usr/bin/env bash
# Capture a pre-booted VM state for browser restore.
#
# Migration saves RAM + device state, NOT disk contents: the emitted
# {rootfs-booted.ext4, vdb.qcow2, vm.state} are a MATCHED SET and must be
# served together. Machine/CPU/memory/devices here mirror web/module.js
# exactly - a stream restores only onto an identical machine.
#
# Engine pairing: the wasm engine is QEMU 8.2.0 (ktock fork); Ubuntu noble's
# qemu-system-x86 is 8.2.2 - same machine-type series (pc-i440fx-8.2), so the
# distro package captures a compatible stream. No custom QEMU build needed.
#
# Usage: make-snapshot.sh [image-dir] [out-dir]   (defaults: out/image out/snapshot)
set -euo pipefail
IMG=${1:-out/image}
OUT=${2:-out/snapshot}
[ -f "$IMG/rootfs.ext4" ] || { echo "need $IMG/rootfs.ext4 (make image first)"; exit 1; }
mkdir -p "$OUT"
cp "$IMG/rootfs.ext4" "$OUT/rootfs-booted.ext4"
cp "$IMG/vdb.qcow2"   "$OUT/vdb.qcow2"
mkdir -p "$OUT/share"

qemu-system-x86_64 \
  -nographic -M pc-i440fx-8.2 -cpu qemu64,+rdrand -smp 1 \
  -m 512M -accel tcg,tb-size=128 \
  -nic none \
  -kernel "$IMG/vmlinuz" \
  -append "console=ttyS0,115200n8 root=/dev/vda rw rootwait nokaslr nosoftlockup nowatchdog random.trust_cpu=on modules_load=virtio_rng systemd.show_status=1" \
  -drive id=root,file="$OUT/rootfs-booted.ext4",format=raw,if=none \
  -device virtio-blk-pci,drive=root \
  -drive id=lab,file="$OUT/vdb.qcow2",format=qcow2,if=none \
  -device virtio-blk-pci,drive=lab \
  -device virtio-rng-pci \
  -virtfs local,path="$OUT/share",mount_tag=share0,security_model=passthrough,id=share0 \
  -qmp unix:"$OUT/qmp.sock",server=on,wait=off \
  -serial file:"$OUT/boot-console.log" &
QPID=$!
trap 'kill $QPID 2>/dev/null || true' EXIT

# wait for the autologin shell on the serial console
for i in $(seq 1 240); do
  grep -qE "bashtion.*[$#]|login: user" "$OUT/boot-console.log" 2>/dev/null && break
  sleep 2
done
grep -qE "bashtion.*[$#]|login: user" "$OUT/boot-console.log" || {
  echo "no shell within 8 min; tail:"; tail -5 "$OUT/boot-console.log"; exit 1; }
sleep 10   # let the login session finish settling

python3 - "$OUT" <<'PYQ'
import json, socket, sys, time
out = sys.argv[1]
s = socket.socket(socket.AF_UNIX); s.connect(out + "/qmp.sock")
f = s.makefile("rw")
def cmd(c, **a):
    f.write(json.dumps({"execute": c, **({"arguments": a} if a else {})}) + "\n"); f.flush()
    while True:
        r = json.loads(f.readline())
        if "return" in r or "error" in r:
            if "error" in r: raise SystemExit("QMP error: %r" % r)
            return r
f.readline(); cmd("qmp_capabilities")
cmd("stop")
cmd("migrate", uri="exec:cat > " + out + "/vm.state")
while True:
    st = cmd("query-migrate")["return"].get("status")
    if st == "completed": break
    if st == "failed": raise SystemExit("migration failed")
    time.sleep(1)
cmd("quit")
print("vm.state captured")
PYQ
wait $QPID || true
rm -f "$OUT/qmp.sock"
ls -la "$OUT"
