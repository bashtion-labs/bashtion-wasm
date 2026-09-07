#!/usr/bin/env bash
#
# pack-site.sh — turn the CI artifacts into a servable htdocs directory.
#
# This is the step that used to exist only as hand-run commands in out/gate1/:
# CI produces an engine and a matched guest set, but nothing turned them into
# the emscripten file-packager bundles the page actually loads, so the build
# outputs could not be deployed without knowing the invocations by heart.
#
#   usage: scripts/pack-site.sh --engine DIR --guest DIR [--out DIR]
#
#     --engine  the `qemu-engine` artifact: out.js, the .wasm, the pthread
#               worker, vendor/ and pc-bios/
#     --guest   the `snapshot-set` artifact: vmlinuz, rootfs-booted.ext4,
#               vdb.qcow2 and vm.state
#     --out     where to assemble (default out/site)
#     --r2-tag  version suffix for the two R2 bundles, e.g. --r2-tag v2 gives
#               load-rootfsB.v2.data. Required whenever their bytes change.
#
# Files are located by NAME anywhere under the given directory, so it does not
# matter how download-artifact happened to nest them.
#
# The five packages, and why each guest path is what it is: web/module.js names
# /pack-rom/, /pack-kernel/vmlinuz, /pack-rootfs/rootfs.ext4,
# /pack-state/vm.state and /pack-lab/vdb.qcow2, so the packaged paths must
# match those exactly or QEMU cannot find its own disks. The OUTPUT names are
# what the page's <script> tags and the Worker's R2 keys use, and are not
# always the same word (load-rootfsB.data holds /pack-rootfs/rootfs.ext4).
#
# IMPORTANT: the rootfs must be the POST-BOOT one from the snapshot set, not
# out/image/rootfs.ext4. A migration stream restores RAM and device state that
# reference the disk as it was when the snapshot was taken; they are a matched
# set and mixing them silently produces a VM that will not resume.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$ROOT/out/site"
ENGINE=""
GUEST=""
# Version tag for the two R2-hosted bundles. Overwriting an R2 key in place
# does NOT reliably deliver new bytes: worker.js checks the edge cache before
# R2 and stores objects under 512 MiB as `immutable, max-age=1y`, and browsers
# hold their copies the same way. Meanwhile the loader JS bakes in the exact
# byte length of its .data, so a stale object is not an error - it is a
# silently truncated disk or memory image. Distinct names sidestep all of it:
# nothing to purge, and the switch happens atomically at `wrangler deploy`.
R2TAG=""
# Must match the toolchain the engine was built with (build.yml, emsdk 3.1.50):
# the loader JS and the runtime that consumes it are one contract.
EMSDK_IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:3.1.50}"

die() { echo "pack-site: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINE="$2"; shift 2 ;;
    --guest)  GUEST="$2";  shift 2 ;;
    --out)    OUT="$2";    shift 2 ;;
    --r2-tag) R2TAG="$2";  shift 2 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$ENGINE" ] || die "need --engine DIR (the qemu-engine artifact)"
[ -n "$GUEST" ]  || die "need --guest DIR (the snapshot-set artifact)"
[ -d "$ENGINE" ] || die "no such directory: $ENGINE"
[ -d "$GUEST" ]  || die "no such directory: $GUEST"
command -v docker >/dev/null || die "docker is required (it runs file_packager)"

# Locate one file by name, anywhere under a directory. Fails loudly rather than
# packaging something incomplete.
find_one() {
  local dir="$1" name="$2" hit
  hit="$(find "$dir" -type f -name "$name" -print -quit 2>/dev/null || true)"
  [ -n "$hit" ] || die "could not find $name under $dir"
  printf '%s' "$hit"
}

echo "==> locating inputs"
# emscripten emits the engine's JS as `qemu-system-x86_64` (no extension); the
# page loads it as ./out.js. That rename used to live only in the Makefile's
# pack target, so the CI artifact does not carry it.
OUTJS="$(find "$ENGINE" -type f \( -name out.js -o -name qemu-system-x86_64 \) \
          -not -path '*.p/*' -print -quit 2>/dev/null || true)"
[ -n "$OUTJS" ] || die "could not find out.js or qemu-system-x86_64 under $ENGINE"
WASM="$(find_one "$ENGINE" qemu-system-x86_64.wasm)"
WORKER="$(find_one "$ENGINE" qemu-system-x86_64.worker.js)"
KERNEL="$(find_one "$GUEST" vmlinuz)"
ROOTFS="$(find_one "$GUEST" rootfs-booted.ext4)"
LAB="$(find_one "$GUEST" vdb.qcow2)"
STATE="$(find_one "$GUEST" vm.state)"
VENDOR_DIR="$(dirname "$(find_one "$ENGINE" xterm.js)")"
ROM_DIR="$(dirname "$(find_one "$ENGINE" bios-256k.bin)")"
for f in "$OUTJS" "$WASM" "$WORKER" "$KERNEL" "$ROOTFS" "$LAB" "$STATE"; do
  printf '    %10s  %s\n' "$(du -h "$f" | cut -f1)" "${f#$ROOT/}"
done

rm -rf "$OUT"; mkdir -p "$OUT/vendor" "$OUT/rom"
for r in bios-256k.bin vgabios-stdvga.bin kvmvapic.bin linuxboot_dma.bin; do
  [ -f "$ROM_DIR/$r" ] || die "missing ROM $r in $ROM_DIR"
  cp "$ROM_DIR/$r" "$OUT/rom/"
done
for v in xterm.js xterm.css xterm-pty.js; do
  [ -f "$VENDOR_DIR/$v" ] || die "missing vendor file $v in $VENDOR_DIR"
  cp "$VENDOR_DIR/$v" "$OUT/vendor/"
done
cp "$OUTJS" "$OUT/out.js"
cp "$WASM" "$OUT/qemu-system-x86_64.wasm"
cp "$WORKER" "$OUT/qemu-system-x86_64.worker.js"

# --- the file-packager bundles -------------------------------------------
# Run from a directory that contains everything, so one bind mount covers all
# the inputs wherever the caller keeps them.
# Under out/, not $TMPDIR: on macOS that is /var/folders/..., which Docker
# Desktop does not share by default, and the bind mount silently comes up
# empty rather than failing.
STAGE="$ROOT/out/.pack-site.$$"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE"
link() { ln "$1" "$2" 2>/dev/null || cp "$1" "$2"; }   # hardlink when possible; 1.2 GB otherwise
mkdir -p "$STAGE/in"
link "$KERNEL" "$STAGE/in/vmlinuz"
link "$ROOTFS" "$STAGE/in/rootfs.ext4"
link "$LAB"    "$STAGE/in/vdb.qcow2"
link "$STATE"  "$STAGE/in/vm.state"
cp -R "$OUT/rom" "$STAGE/in/rom"
mkdir -p "$STAGE/out"

# output name : source under in/ : guest path the page's module.js expects
# The tag renames only the DATA file — the object the browser fetches and the
# Worker serves. The loader JS keeps a stable name, because the page's <script>
# tags name it and those should not churn. file_packager takes the two paths
# separately, so they can differ; the loader records the data file's basename
# as REMOTE_PACKAGE_BASE and fetches exactly that.
SUF=""
[ -n "$R2TAG" ] && SUF=".$R2TAG"
# data file : loader js : source under in/ : guest path module.js expects
PACKAGES="
load-rom.data:load-rom.js:rom:/pack-rom
load-kernel.data:load-kernel.js:vmlinuz:/pack-kernel/vmlinuz
load-rootfsB${SUF}.data:load-rootfsB.js:rootfs.ext4:/pack-rootfs/rootfs.ext4
load-state${SUF}.data:load-state.js:vm.state:/pack-state/vm.state
load-lab.data:load-lab.js:vdb.qcow2:/pack-lab/vdb.qcow2
"

echo "==> packaging (emsdk: $EMSDK_IMAGE)"
SCRIPT="$STAGE/run.sh"
{
  echo 'set -e'
  echo 'FP=$EMSDK/upstream/emscripten/tools/file_packager.py'
  echo '[ -f "$FP" ] || { echo "file_packager.py not found in this emsdk image" >&2; exit 1; }'
  echo "$PACKAGES" | while IFS=: read -r data js src dest; do
    [ -n "$data" ] || continue
    printf 'python3 $FP /w/out/%s --preload /w/in/%s@%s --js-output=/w/out/%s\n' \
      "$data" "$src" "$dest" "$js"
  done
} > "$SCRIPT"
docker run --rm -v "$STAGE:/w" -w /w "$EMSDK_IMAGE" sh /w/run.sh
mv "$STAGE"/out/load-*.data "$STAGE"/out/load-*.js "$OUT/"

# --- assertions: never ship a bundle that points at the wrong path --------
echo "==> verifying"
echo "$PACKAGES" | while IFS=: read -r data jsname src dest; do
  [ -n "$data" ] || continue
  js="$OUT/$jsname"
  [ -s "$OUT/$data" ] || die "$data is empty"
  [ -s "$js" ] || die "$jsname is empty"
  # the basename is what the browser fetches at runtime
  grep -q "REMOTE_PACKAGE_BASE = '$data'" "$js" \
    || die "$js does not fetch $data"
  # and the guest path is what QEMU opens
  case "$dest" in
    /pack-rom) want='/pack-rom/bios-256k.bin' ;;
    *) want="$dest" ;;
  esac
  grep -q "\"filename\": \"$want\"" "$js" \
    || die "$js does not map $want — QEMU would not find it"
  printf '    ok  %-20s -> %s\n' "$data" "$dest"
done

# every asset web/module.js names must be in some bundle
python3 - "$OUT" "$ROOT/web/module-restore.js" <<'PYEOF'
import json, re, sys, pathlib
out, module = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).read_text()
packaged = set()
for js in out.glob('load-*.js'):
    packaged |= set(re.findall(r'"filename": "([^"]+)"', js.read_text()))
wanted = set(re.findall(r'/pack-[a-z]+/[A-Za-z0-9._-]+', module))
wanted |= {'/pack-rom/bios-256k.bin'} if '/pack-rom/' in module else set()
missing = sorted(w for w in wanted if w not in packaged)
if missing:
    raise SystemExit('pack-site: module.js needs %s, which no bundle provides' % missing)
print('    ok  every path web/module-restore.js names is packaged')
PYEOF

# The ROMs live inside load-rom.data now; the loose copies were only staging.
rm -rf "$OUT/rom"

# Whatever the bundles ended up called, the page and the Worker must name
# exactly those. A page pointing at a key the Worker does not serve is a 404
# at boot; a Worker serving a key the page never asks for is dead weight.
python3 - "$OUT" "$ROOT/web/fork/index.html" "$ROOT/deploy/worker.js" <<'PYEOF'
import pathlib, re, sys
out, page, worker = (pathlib.Path(p) for p in sys.argv[1:4])
produced = sorted(p.name for p in out.glob('load-*.data'))
page_src = page.read_text()
worker_src = worker.read_text()
bad = []
for js in sorted(p.name for p in out.glob('load-*.js')):
    if ('./%s' % js) not in page_src:
        bad.append('the page does not load %s' % js)
    # the loader must fetch a data file this build actually produced
    m = re.search(r"REMOTE_PACKAGE_BASE = '([^']+)'", (out / js).read_text())
    if not m or m.group(1) not in produced:
        bad.append('%s fetches %r, which this build did not produce'
                   % (js, m.group(1) if m else None))
big = [d for d in produced if (out / d).stat().st_size > 25 * 1024 * 1024]
for d in big:
    if ("'/%s'" % d) not in worker_src:
        bad.append('%s is over the 25 MiB static cap but deploy/worker.js does not serve it '
                   '- add \'/%s\': { key: \'%s\', ... } to R2_FILES' % (d, d, d))
for m in re.findall(r"'/(load-[^']+\.data)'", worker_src):
    if m not in produced:
        bad.append('deploy/worker.js serves /%s, which this build did not produce' % m)
if bad:
    raise SystemExit('pack-site: page/Worker do not match the bundles:\n  - ' + '\n  - '.join(bad))
print('    ok  the page and worker.js name exactly the bundles produced')
PYEOF

echo
echo "==> $OUT"
CAP=$((25 * 1024 * 1024))
for f in "$OUT"/*; do
  [ -f "$f" ] || continue
  sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  if [ "$sz" -gt "$CAP" ]; then where="R2"; else where="static"; fi
  printf '    %-30s %8s  %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)" "$where"
done
echo
echo "Next: deploy/split.sh $OUT"
