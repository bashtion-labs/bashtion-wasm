#!/usr/bin/env bash
#
# split.sh — assemble deploy/public/ (the small, statically-served half of the
# site) from a built htdocs directory, and print the plan for uploading the
# three large files to the private R2 bucket.
#
#   usage: deploy/split.sh [path-to-built-htdocs]   (default: out/gate1/htdocsF)
#
# The build artifact's index.html carries an inline script + an inline onclick,
# which a strict CSP forbids. We deliberately DROP it and drop in the tracked,
# CSP-clean web/fork/index.html + web/fork/boot.js instead. Everything else
# (out.js, the load-*.js loaders, the small .data bundles, the pthread worker,
# vendor/, the serial-fs and boot-screen scripts) is copied verbatim.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="${1:-$ROOT/out/gate1/htdocsF}"
PUB="$HERE/public"

# The three files that exceed the 25 MiB static-asset cap and go to R2 instead.
BIG=(qemu-system-x86_64.wasm load-rootfsB.data load-state.data)
# out.wasm is an unused duplicate of qemu-system-x86_64.wasm — never ship it.
DROP=("${BIG[@]}" out.wasm index.html)

die() { echo "split.sh: $*" >&2; exit 1; }

[ -d "$SRC" ] || die "built htdocs not found: $SRC (run the build/snapshot first)"
[ -f "$SRC/out.js" ] || die "$SRC has no out.js — is this a fork-engine build?"
[ -f "$ROOT/web/fork/index.html" ] || die "missing web/fork/index.html"
[ -f "$ROOT/web/fork/boot.js" ] || die "missing web/fork/boot.js"
for f in "${BIG[@]}"; do
  [ -f "$SRC/$f" ] || die "expected large file missing from build: $f"
done

echo "==> assembling $PUB from $SRC"
rm -rf "$PUB"
mkdir -p "$PUB"

# Copy the build output minus the dropped files.
EXCLUDES=()
for f in "${DROP[@]}"; do EXCLUDES+=(--exclude "$f"); done
rsync -a "${EXCLUDES[@]}" "$SRC"/ "$PUB"/

# Drop in the tracked, hardened page + bootstrap and the header policy.
cp "$ROOT/web/fork/index.html" "$PUB/index.html"
cp "$ROOT/web/fork/boot.js"    "$PUB/boot.js"
cp "$HERE/_headers"            "$PUB/_headers"

# --- assertions: fail loudly rather than deploy something broken ------------
for f in index.html boot.js out.js qemu-system-x86_64.worker.js \
         load-rom.js load-kernel.js load-rootfsB.js load-state.js load-lab.js \
         load-kernel.data load-rom.data load-lab.data _headers; do
  [ -e "$PUB/$f" ] || die "assembled public/ is missing $f"
done
for f in "${BIG[@]}"; do
  [ -e "$PUB/$f" ] && die "large file leaked into public/: $f"
done
grep -q "onclick=" "$PUB/index.html" && die "index.html still has an inline handler (CSP would block it)"
# Static Assets reject any file > 25 MiB. Catch it here, not at deploy.
CAP=$((25 * 1024 * 1024))
while IFS= read -r f; do
  sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  [ "$sz" -le "$CAP" ] || die "static file over 25 MiB cap: ${f#$PUB/} ($sz bytes) — must go to R2"
done < <(find "$PUB" -type f)

echo "==> public/ ready ($(du -sh "$PUB" | cut -f1), $(find "$PUB" -type f | wc -l | tr -d ' ') files)"
echo

# --- R2 upload plan ---------------------------------------------------------
# wrangler's single PUT tops out at 300 MiB; the rootfs is ~874 MiB and needs a
# multipart tool (rclone or aws-cli against the S3 endpoint). Decide per file.
CAP_PUT=$((300 * 1024 * 1024))
echo "Upload the three large files to the private bucket 'bashtion-assets':"
echo "(run after 'npx wrangler login'; keys must match the paths above)"
echo
for f in "${BIG[@]}"; do
  sz=$(stat -f%z "$SRC/$f" 2>/dev/null || stat -c%s "$SRC/$f")
  mib=$(( sz / 1024 / 1024 ))
  if [ "$sz" -le "$CAP_PUT" ]; then
    printf '  # %-26s %4d MiB  (single PUT)\n' "$f" "$mib"
    printf '  npx wrangler r2 object put bashtion-assets/%s \\\n      --file %s --remote\n\n' "$f" "$SRC/$f"
  else
    printf '  # %-26s %4d MiB  (exceeds wrangler 300 MiB PUT — use rclone; see deploy/README.md Step 4)\n' "$f" "$mib"
    printf '  #   needs an rclone R2 remote configured with no_check_bucket=true for a bucket-scoped token\n'
    printf '  rclone copy %s r2:bashtion-assets/ --s3-upload-cutoff=100M --s3-chunk-size=100M --progress\n\n' "$SRC/$f"
  fi
done
echo "Then deploy the Worker + static assets:"
echo "  cd deploy && npx wrangler deploy"
