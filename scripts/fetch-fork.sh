#!/usr/bin/env bash
#
# fetch-fork.sh — check out the ktock/qemu-wasm commit this repository builds.
#
#   usage: scripts/fetch-fork.sh DIR
#
# The wasm engine (build.yml) and the native QEMU that captures the snapshot
# (snapshot.yml) must come from the SAME fork tree: a migration stream from a
# different tree hangs the engine's -incoming silently rather than failing.
# Both used to clone the fork's default branch at whatever it pointed to when
# the job ran, and the two jobs run on different pushes, days apart. So the
# commit is pinned in one place, patches/fork/REVISION, and both workflows
# fetch exactly it through this script. Each records what it built from in
# its artifact (FORK_REVISION), and scripts/pack-site.sh refuses to pair an
# engine and a snapshot that do not name the same commit.
#
# Moving the pin rebuilds both: build.yml runs on every push, and snapshot.yml
# watches patches/fork/. The new vm.state is a new snapshot set, so it takes a
# new R2 tag like any other (deploy/README.md, "Updating later").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL=https://github.com/ktock/qemu-wasm.git
DIR="${1:?usage: scripts/fetch-fork.sh DIR}"

REV="$(tr -d '[:space:]' < "$ROOT/patches/fork/REVISION")"
[[ "$REV" =~ ^[0-9a-f]{40}$ ]] \
  || { echo "fetch-fork: patches/fork/REVISION is not a full commit id: '$REV'" >&2; exit 1; }

git init -q "$DIR"
git -C "$DIR" remote add origin "$URL"
git -C "$DIR" fetch -q --depth 1 origin "$REV"
git -C "$DIR" checkout -q --detach FETCH_HEAD
[ "$(git -C "$DIR" rev-parse HEAD)" = "$REV" ] \
  || { echo "fetch-fork: $DIR is not at $REV" >&2; exit 1; }
echo "fetch-fork: $URL @ $REV"
