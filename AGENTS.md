# Working in bashtion-wasm

A full x86_64 Linux VM (real kernel, systemd, LVM, quotas, netfilter) that runs in a browser
tab: the ktock/qemu-wasm fork engine, a pre-booted snapshot restored with `-incoming`, and a
small classic-script front end. [README.md](README.md) is the overview; read it first.

## Where things are, and what to read before touching them

| Area | Paths | Read first |
|---|---|---|
| The page (what users see) | `web/fork/index.html`, `web/fork/boot.js`, `web/*.js` | `web/README.md` |
| Page tests | `web/test/*.test.mjs` (`fake-page.mjs` is the browser-shaped harness) | `web/README.md`, "Tests" |
| Save/restore, guest side | `image/seed/` (`bashtion-pack`, `bashtion-unpack`, `state.py`) | `image/seed/README.md`, README "Saving work" |
| Guest image | `image/` (Dockerfile, package lists, offline apt repo) | `image/apt-repo/README.md` |
| Snapshot capture | `snapshot/` | `snapshot/README.md` |
| Engine pin and patches | `patches/fork/REVISION`, `patches/`, `scripts/fetch-fork.sh` | `patches/*/README.md` |
| Packaging and deploy | `scripts/pack-site.sh`, `deploy/` (`worker.js`, `_headers`, `split.sh`) | `deploy/README.md` |
| User-facing guide | `USER-GUIDE.md` | - |

`web/fork/index.html` + `web/fork/boot.js` is the shipped page. `web/index.html` is the older
page with inline scripts, used only by `make pack` for the upstream TCI lane.
`third_party/qemu` is that lane's pinned submodule and stays pristine; changes to it go in
`patches/qemu/`.

## Setup for a fresh checkout

None. There are no package dependencies: the page tests run on the system Node (22 or newer)
and everything else runs in Docker. Do not initialise the `third_party/qemu` submodule unless
the job is about the experimental upstream lane.

## Validation

Run what covers the files you changed. All of these work on this Mac:

| Changed | Command | Notes |
|---|---|---|
| Anything under `web/`, `scripts/pack-site.sh`, `deploy/`, or **any Markdown file** | `node --test web/test/*.test.mjs` | About a minute. `deploy-docs.test.mjs` checks that every `.md` names the engine and snapshot bundles exactly as `deploy/worker.js` serves them. |
| `image/seed/` | `./image/test/state-roundtrip.sh` | Docker; a few minutes (it installs packages in an `ubuntu:26.04` container). |
| A shell script | `bash -n <file>` | shellcheck is not installed. |
| A Python file | `python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' <file>` | Not `py_compile`, which writes `__pycache__/` into the tree. |

These run only in CI (`.github/workflows/`), on x86_64 runners, and cannot run here: the
emscripten toolchain images are amd64-only, and the guest image build needs a privileged
amd64 Docker build plus native QEMU. CI runs on a push to `main` or a pull request, and
nothing in the factory pushes, so a change in these areas is unverified until a human pushes
it. Say so in `build.md`.

- Engine build (`build.yml`, job `qemu-engine`)
- Guest image and boot check: `make image`, then `python3 image/test/guest-check.py out/image`
- Snapshot capture (`snapshot.yml`)

## Dev server: the real page, on your port

Serving the page needs the two CI artifacts, `qemu-engine` and `snapshot-set` (about
1.3 GB). They live once, outside every worktree, in `~/.cache/bashtion-wasm/engine` and
`~/.cache/bashtion-wasm/guest`. Agents only read that cache: never download into it, refresh
it or delete it.

**If either directory is missing, the page cannot be served.** Don't write BLOCKED for that
alone. Check page behaviour through `web/test/` instead (the harness loads the real page
scripts), and say in your file that the page was not served and why.

Run these from the worktree root, with `PORT` set to the port from your prompt.

1. **Package the site** into `out/site/`. It takes a few minutes. Builder only: run it when
   `out/site/` is missing, or when the change touches `scripts/pack-site.sh`, `web/module*.js`
   or `deploy/worker.js`. Leave `out/site/` packaged at the end of every round, because the
   reviewers run in parallel and only serve it.

   ```sh
   make site ENGINE="$HOME/.cache/bashtion-wasm/engine" GUEST="$HOME/.cache/bashtion-wasm/guest" \
     R2TAG="$(sed -n "s|.*'/load-state\.\([^.']*\)\.data'.*|\1|p" deploy/worker.js)"
   ```

   If it stops with "page/Worker do not match the bundles" because the engine has a
   different name, the cached engine comes from a different build than the one
   `deploy/worker.js` names. Report that to the human. Don't edit `worker.js` to make
   it fit.

2. **Put the page in place**, as `deploy/split.sh` does (its `cp` list is authoritative).
   Builder only. Rerun this after every page change:

   ```sh
   cp web/fork/index.html web/fork/boot.js web/serialfs.js web/serialtap.js \
      web/termfit.js web/bootscreen.js out/site/
   cp web/module-restore.js out/site/module.js
   ```

3. **Serve** with the COOP/COEP headers cross-origin isolation needs, the way `make serve`
   does but on your port:

   ```sh
   docker run --rm -d --name "bashtion-serve-$PORT" -p "127.0.0.1:$PORT:80" \
     -v "$PWD/out/site:/usr/local/apache2/htdocs/:ro" \
     -v "$PWD/web/xterm-pty.conf:/usr/local/apache2/conf/extra/xterm-pty.conf:ro" \
     --entrypoint=/bin/sh httpd -c \
     'echo "Include conf/extra/xterm-pty.conf" >> /usr/local/apache2/conf/httpd.conf && httpd-foreground'
   ```

   Open `http://localhost:$PORT/`. The boot banner shows first. The restore reaches a
   `user@bashtion:~$` prompt in about 15 s, so wait at least 30 s before you judge it.
   `window.__serial`, `window.__xterm` and `SERIALTAP.screen()` / `SERIALTAP.atPrompt()`
   let you read the console (see `web/README.md`). `SERIALTAP` is a top-level `const`, not a
   `window` property. Stop the server with `docker rm -f "bashtion-serve-$PORT"`.

Docker here is colima, which mounts only the home directory. `make site` and the server both
bind-mount the worktree, so they work only from a worktree under `$HOME`; the factory's
worktrees are.

Locally there is no CSP, but deployed there is (`deploy/_headers`). The page must still run
with no inline scripts and no inline event handlers.

**Refreshing the cache (human only).** CI artifacts expire after 14 days. Download the latest
successful runs on `main` that still have them:

```sh
ENGINE_RUN=$(gh run list -w build.yml -b main -s success -L 1 --json databaseId -q '.[0].databaseId')
GUEST_RUN=$(gh run list -w snapshot.yml -b main -s success -L 1 --json databaseId -q '.[0].databaseId')
rm -rf ~/.cache/bashtion-wasm/engine ~/.cache/bashtion-wasm/guest
gh run download "$ENGINE_RUN" -n qemu-engine  -D ~/.cache/bashtion-wasm/engine
gh run download "$GUEST_RUN"  -n snapshot-set -D ~/.cache/bashtion-wasm/guest
```

If they have expired, re-run both workflows on `main` (`gh workflow run build.yml --ref main`,
then the same for `snapshot.yml`) and download those runs.

## Look and feel

There is no theme file or design-token config. The styling is a small, consistent set of
inline values, so match it:

- the `<style>` block and the control bar in `web/fork/index.html`;
- the boot banner in `web/bootscreen.js`;
- the save/load overlay in `web/serialfs.js`.

The values are a `#111` background, `#e6e6e6` text, greys `#9a9a9a`, `#8a8a8a` and `#666`
for secondary text, `#4a9eff` for progress, `#3ec77a` for success, `#3aa0d0` for the banner,
and `system-ui` at 12-15px.

Copy is plain and short, in the voice of `USER-GUIDE.md`, which is written for people who
have never used Linux. Users never see raw transfer data, base64, or boot output.

## Conventions

- **Comments say why**, often with the measurement or the issue that forced the choice
  (`(#73)`, "measured"). Keep the density of the code around yours.
- **Docs ship with the change.** Update the README sections, `web/README.md`,
  `deploy/README.md` and `USER-GUIDE.md` your change makes stale. The docs test
  enforces the bundle and engine names; the rest is on you.
- **Commit messages**: one line, imperative, sentence case, in the style of
  `git log --oneline`.
- **Never commit build output**: `out/`, `deploy/public/`, `*.wasm`, `*.data`, `__pycache__/`.
- **The engine and the snapshot are a matched pair.** They are pinned to one fork commit in
  `patches/fork/REVISION`, and `vm.state` matches its disks. When their bytes change, the
  bundle names change too (see `deploy/README.md`, "Updating later"). Never reuse a name
  for different bytes.
- **Never push, open PRs, dispatch workflows, run `wrangler`, or touch R2 or Cloudflare.**
  Deploying is a human step.
