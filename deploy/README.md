# Deploying bashtion-wasm on Cloudflare (free tier, hardened)

This directory deploys the browser VM to Cloudflare's free plan with a
security-first configuration. Follow it top to bottom the first time; the
**Updating** and **Reference** sections are for later.

## Getting the files in the first place

Everything is built in CI, on x86_64 runners — nothing here needs a local
x86_64 machine or an emulator:

| Workflow | Artifact | What is in it |
|---|---|---|
| `build.yml` | `qemu-engine` | `out.js`, the `.wasm`, the pthread worker, `vendor/` (xterm + xterm-pty, the versions the engine linked against), `pc-bios/` and `FORK_REVISION` |
| `snapshot.yml` | `snapshot-set` | `vmlinuz`, `rootfs-booted.ext4`, `vdb.qcow2`, `vm.state` and `FORK_REVISION` |

`snapshot.yml` runs automatically on a push to `main` touching `image/**`,
`snapshot/**` or the fork pin, and builds native QEMU **from the ktock fork
tree** to do the capture — a distro-QEMU stream makes the fork engine hang
silently at `-incoming`, so that detail is not optional. It has to be the
**same commit** of that tree as the engine, too: both workflows fetch the one
pinned in `patches/fork/REVISION` (`scripts/fetch-fork.sh`), each artifact
records it in `FORK_REVISION`, and `pack-site.sh` refuses to pair an engine and
a snapshot that name different commits, or an artifact that names none (one
built before the pin).

Then download the two artifacts **by run id**, from the latest successful runs
on `main`, into fresh directories, and assemble:

```sh
ENGINE_RUN=$(gh run list -w build.yml -b main -e push -s success -L 1 --json databaseId -q '.[0].databaseId')
GUEST_RUN=$(gh run list -w snapshot.yml -b main -s success -L 1 --json databaseId -q '.[0].databaseId')
rm -rf /tmp/engine /tmp/guest
gh run download "$ENGINE_RUN" -n qemu-engine  -D /tmp/engine
gh run download "$GUEST_RUN"  -n snapshot-set -D /tmp/guest
make site ENGINE=/tmp/engine GUEST=/tmp/guest R2TAG=v3
```

Without a run id, `gh run download -n` takes the newest artifact of that name
from **any** run, and `build.yml` also runs on pull requests, so the engine
could come from an unmerged branch. A reused directory is refused, not merged:
`pack-site.sh` stops when a file it needs is there twice, because nothing then
says which copy belongs with which. `snapshot.yml` runs only when the image,
the snapshot scripts or the fork pin change, so its latest run can be much
older than the engine's; that is fine as long as both name the same
`FORK_REVISION`, and if they do not, `gh workflow run snapshot.yml` captures a
new one.

`R2TAG` must be the tag `deploy/worker.js` serves — the `.v3` in its
`R2_FILES` keys. The snapshot-set bundles are named by it
(`load-rootfsB.v3.data`, `load-state.v3.data`, `load-kernel.v3.data`,
`load-lab.v3.data`, `load-rom.v3.data`), and
`pack-site.sh` refuses a build whose names are not exactly what the Worker
serves, so any other tag, or none, cannot be deployed. **Updating later**
says when it moves.

`make site` runs `scripts/pack-site.sh` (emscripten's `file_packager`, in a
pinned emsdk container — it is pure Python, so it runs fine on Apple Silicon)
and then `deploy/split.sh`. It prints the static/R2 split and the exact upload
commands. It asserts, for every bundle, that the basename the browser fetches
and the guest path QEMU opens are both right, and that every path
`web/module-restore.js` names is actually packaged — a mismatch there is a VM
that cannot find its own disks.

**The rootfs must be `rootfs-booted.ext4` from the snapshot set**, never
`out/image/rootfs.ext4`. A migration stream restores RAM and device state that
reference the disk as it was at capture; they are a matched set and mixing them
produces a VM that will not resume. `pack-site.sh` takes the right one.

## What gets deployed, and why it is shaped this way

`make site` produces one directory (`out/site/`). Three files in it are large:

| File | Size | Where it goes |
|------|------|---------------|
| `load-rootfsB.v3.data` (the Ubuntu disk) | ~1.0 GB | **R2** |
| `load-state.v3.data` (the saved running state) | ~300 MiB | **R2** |
| `qemu-system-x86_64.d8537ec6ccf0354a.wasm` (the engine, named by its hash) | ~39 MiB | **R2** |
| the page, JS, `load-kernel.v3.data` (17 MiB), ROM, lab disk, `vendor/` | each < 25 MiB | **Static Assets** |

Sizes drift with the guest image — the rootfs grew from ~1038 MiB when man pages
and a real free-space target were added. `pack-site.sh` prints the current
split, and `split.sh` fails rather than deploy anything over the 25 MiB cap, so
neither number needs to be trusted from this table.

Cloudflare's static hosting (Pages / Workers Static Assets) rejects any single
file over **25 MiB**, so the big three cannot be static files. They live in a
**private R2 bucket** and are streamed by a small Worker (`worker.js`).
Everything is served from **one origin**, which keeps the setup simple and
sidesteps all cross-origin (CORS/CORP) complexity.

```
browser ──▶ https://lab.bashtion.dev
             ├─ /  /*.js  /vendor/*  /load-kernel.v3.data …      ─▶ Static Assets (public/)
             └─ /qemu-system-x86_64.d8537ec6ccf0354a.wasm        ─▶ worker.js ─▶ private R2
                /load-rootfsB.v3.data  /load-state.v3.data           (bucket binding)
```

### Does it fit the free tier?

Yes, comfortably.

- **R2 storage:** ~1.2 GB of ~10 GB free.
- **R2 egress:** free (R2 has **no egress fees** — this is the whole reason to
  use it for ~1.2 GB per cold visit).
- **R2 reads:** ~3 per cold load, of 10,000,000 free/month.
- **Worker requests:** only the 3 big files hit the Worker; static-asset
  requests are free and unlimited. 100,000 Worker requests/day ≈ ~33,000 cold
  loads/day of headroom — and `worker.js` edge-caches the wasm + state, so repeat
  visitors in a region are served from cache without a Worker call or an R2 read
  at all, pushing that headroom much higher.
- **Bandwidth through the Worker** does not burn CPU time — streaming an R2
  object to the response is pass-through, so the free CPU limit is a non-issue.

## Caching

`worker.js` stores each full GET of `qemu-system-x86_64.d8537ec6ccf0354a.wasm` and `load-state.v3.data`
in Cloudflare's edge cache (they are immutable), so a second visitor in the same
region gets them straight from cache — no Worker invocation, no R2 read. The
~1038 MiB `load-rootfsB.v3.data` is intentionally **not** cached: it is above the
free-plan max cacheable object size, and skipping it avoids streaming a huge body
through the Worker's 128 MiB memory (it still serves fine from R2, and egress is
free). Ranged requests bypass the cache and read R2 directly; browsers also cache
all three locally via the `immutable` header, so a returning user re-fetches
nothing. The Worker stamps an **`x-bashtion-cache`** header so you can see it working:
`MISS` on the first full GET, `HIT` on the next, `UNCACHED` for the oversized
rootfs, and `BYPASS` for HEAD/range requests (which skip the cache). Note that
`curl -I` sends **HEAD**, so it always shows `BYPASS` and never a hit; and
`cf-cache-status` does **not** appear here — that is a CDN-cache header, not one
the Workers Cache API emits. Verify with a full GET, run twice (expect `MISS`
then `HIT`):

```sh
curl -s -o /dev/null -D - https://lab.bashtion.dev/qemu-system-x86_64.d8537ec6ccf0354a.wasm \
  | grep -i x-bashtion-cache
```

## Security posture (best-practice hardening)

This deploy is locked down on purpose. What is in place and why:

- **Private bucket, no public access.** The R2 bucket is never made public and
  no `r2.dev` URL is enabled. Assets are reachable **only** through the Worker's
  bucket binding.
- **Worker is an allowlist, not a proxy.** `worker.js` maps exactly three fixed
  paths to three fixed keys. The request path is never used as a key, so there
  is no path traversal into the bucket. It answers **GET/HEAD only** and returns
  **generic errors** (no key or bucket name leaks).
- **Cross-origin isolation** via `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (also required for the engine to
  run at all).
- **Strict Content-Security-Policy** with **no `'unsafe-inline'` for scripts**:
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'
  blob:; connect-src 'self'; …; frame-ancestors 'none'; object-src 'none';
  base-uri 'none'`. `'wasm-unsafe-eval'` permits WebAssembly compilation only —
  **not** JavaScript `eval()` — which the runtime JIT needs. To make this CSP
  honest, the page carries **no inline scripts and no inline event handlers**
  (see `web/fork/`); `split.sh` refuses to ship a page that reintroduces one.
- **Extra headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `X-Frame-Options: DENY`, a locked-down `Permissions-Policy`
  (camera/mic/geo/USB/etc. all denied), and HSTS.
- **No third-party runtime code.** xterm and the engine are self-hosted; nothing
  is pulled from a CDN at run time, so there is no third-party supply-chain
  surface.
- **Least-privilege upload.** The one credential you create (an R2 API token for
  the multipart rootfs upload) is scoped to a single bucket and is **rotated or
  deleted after upload** — see Step 4.

This whole header set was tested end-to-end: the VM boots to a shell under it
with zero CSP violations. If you change the page, re-test (`deploy/split.sh`
then load it under the same headers) before shipping.

## Prerequisites

- A free Cloudflare account, with the **bashtion.dev** zone already added to it
  (the deploy serves on `lab.bashtion.dev`).
- Node.js (for `npx wrangler`). No global install needed.
- The built site at `out/site/` (from the build/snapshot pipeline, or a
  CI artifact download).
- For the ~1038 MiB rootfs upload: [`rclone`](https://rclone.org/downloads/)
  (`brew install rclone`), because it uploads in multipart chunks. `aws-cli`
  works too.

---

## Step 1 — Assemble the static half

```sh
./deploy/split.sh          # defaults to out/site
```

This creates `deploy/public/` (the small files + the hardened page + the header
policy), verifies nothing over 25 MiB slipped in, and prints the exact upload
commands for the three big files. `deploy/public/` is git-ignored — it is
generated output.

## Step 2 — Log in and create the private bucket

```sh
npx wrangler login
npx wrangler r2 bucket create bashtion-assets
```

Do **not** enable public access or a managed domain on this bucket. Leave it
private.

## Step 3 — Upload the two smaller large files (single PUT)

The engine and the saved-state file are under wrangler's single-upload cap:

```sh
npx wrangler r2 object put bashtion-assets/qemu-system-x86_64.d8537ec6ccf0354a.wasm \
    --file out/site/qemu-system-x86_64.d8537ec6ccf0354a.wasm --remote

npx wrangler r2 object put bashtion-assets/load-state.v3.data \
    --file out/site/load-state.v3.data --remote
```

## Step 4 — Upload the rootfs (multipart) with a least-privilege token

`wrangler r2 object put` uses a single request (~300 MiB ceiling); the rootfs is
~1038 MiB, so upload it with rclone using a **scoped, temporary** R2 API token.

**4a. Create a bucket-scoped R2 API token (S3 credentials).** In the dashboard,
go to **Storage & databases → R2 Object Storage** (the R2 Overview page). In the
**Account Details** panel on the right, click **Manage** next to **API Tokens**
(the **`{ } API`** button at the top-right opens the same page). This is the
R2-specific S3-token page — *not* My Profile / Manage Account → API Tokens, which
issues generic Cloudflare tokens, not the S3 key pair rclone needs. Then:

1. **Create API token** → **Create Account API token** (belongs to the account,
   survives user removal — needs the Super Administrator role) or **Create User
   API token** for a personal credential.
2. Name it, e.g. `bashtion-assets-upload`.
3. **Permissions:** **Object Read & Write** — only the two *Object* tiers can be
   bucket-scoped; the *Admin* tiers always cover every bucket in the account.
4. **Bucket scope:** **Apply to specific buckets only → `bashtion-assets`** (leave
   all others unselected).
5. *(Optional)* set a short **TTL** and/or a client-IP allowlist.
6. **Create**, then copy the **Access Key ID** and **Secret Access Key** now —
   the Secret is shown **once only**. (Ignore the separate bearer "Token value";
   rclone does not use it.)

Your **Account ID** is in the R2 Account Details panel (and inside the endpoint
URL printed on the confirmation page). Endpoint:
`https://<ACCOUNT_ID>.r2.cloudflarestorage.com` — use the `.eu` / `.fedramp` /
`.us` variant only if the bucket was created with that jurisdiction.

**4b. Configure rclone** (do **not** commit this config; keep the secret out of
the repo and your shell history):

```sh
rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id=<ACCESS_KEY_ID> \
  secret_access_key=<SECRET_ACCESS_KEY> \
  region=auto \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  acl=private \
  no_check_bucket=true
```

`no_check_bucket=true` is **required** for a bucket-scoped token: it cannot list
or create buckets, so rclone's default pre-flight bucket check would otherwise
fail. (Cloudflare's own rclone page prescribes the same thing — "If you are using a
token with Object-level permissions, you will need to add `no_check_bucket =
true`". Its wizard walkthrough does *not* produce an equivalent remote: it
emits no `region`, and rclone no longer offers `acl` for provider=Cloudflare,
nor `no_check_bucket` outside the advanced prompts.)

**4c. Upload (multipart):**

```sh
rclone copy out/site/load-rootfsB.v3.data r2:bashtion-assets/ \
  --s3-upload-cutoff=100M --s3-chunk-size=100M --progress
```

This stores it as `r2:bashtion-assets/load-rootfsB.v3.data`. (The `.v3` in
these names is the tag `worker.js` serves; use whatever `split.sh` printed.)

**4d. Confirm all three objects landed, then retire the token:**

```sh
rclone lsl r2:bashtion-assets/     # should list wasm + state + rootfs
```

Then delete the token in **R2 → Account Details → Manage API tokens → ⋯ →
Delete** (or **Roll** to rotate the secret), and `rclone config delete r2`. The
running site never uses it — only the Worker's binding, which needs no key.

## Step 5 — Deploy the Worker + static assets

```sh
cd deploy
npx wrangler deploy
```

Because `wrangler.jsonc` declares `lab.bashtion.dev` as a **custom domain**,
`wrangler deploy` creates the DNS record and provisions its TLS certificate
automatically. On the **first** deploy the certificate can take a minute or two
to go live — a brief TLS error right after deploying is normal; retry shortly.
`workers_dev` is disabled, so the site is reachable **only** at
`https://lab.bashtion.dev` (no `*.workers.dev` URL).

## Step 6 — Verify

```sh
# Cross-origin isolation + CSP present on the page:
curl -sI https://lab.bashtion.dev/ | \
  grep -iE 'cross-origin-(opener|embedder)|content-security-policy'

# The big files come from R2 through the Worker, with Range support:
curl -sI -H 'Range: bytes=0-15' \
  https://lab.bashtion.dev/qemu-system-x86_64.d8537ec6ccf0354a.wasm | \
  grep -iE 'HTTP|content-range|content-type'
```

Then open the URL in a browser: you should see the boot banner, then a
`user@bashtion:~$` prompt. If the tab shows a `SharedArrayBuffer is not defined`
error, the COOP/COEP headers are not reaching the page — check `public/_headers`
made it into the deploy.

---

## Updating later

- **Changed the page/JS only:** re-run `./deploy/split.sh out/site`, then
  `cd deploy && npx wrangler deploy`. No R2 changes needed — the page scripts
  are taken from the tracked `web/` tree, so a rebuild is not required either.
- **Rebuilt the guest image or snapshot: bump the version tag.** Do *not*
  overwrite an existing R2 key. Two caches make an in-place overwrite unsafe:
  `worker.js` consults the edge cache **before** R2 and stores anything under
  `CACHE_MAX_BYTES` as `immutable, max-age=1y`, and browsers hold their copies
  the same way — a purge cannot reach those. And because each loader bakes in
  the **exact byte length** of its `.data`, a stale object is not an error: the
  loader slices the wrong range and hands QEMU a truncated disk or memory
  image, which fails later and mysteriously.

  So: the change that alters the set also moves the two keys in `worker.js`'s
  `R2_FILES` to a tag that has never been uploaded (#70 took them from v2 to
  v3; the next is v4). At release, `make site ENGINE=... GUEST=... R2TAG=<that
  tag>`, upload the new objects, `wrangler deploy` (the switch is atomic —
  nothing points at the new keys until the page does), then delete the old
  objects once traffic has moved. `pack-site.sh` refuses to finish if the page
  and `worker.js` do not name exactly the bundles it built - which also means a
  tag left stale in `worker.js` makes overwriting the live objects the only
  build that passes, so bump it with the change, not at release time. The
  same change updates the tag everywhere this guide names it (the assembly
  command, the upload commands, the rate-limit rule, troubleshooting), and
  `web/test/deploy-docs.test.mjs` fails until it does. If the rate-limit rule
  is set up in the dashboard, edit its paths at release too: it matches exact
  paths, so it silently stops applying once the Worker serves new ones.
  The tag renames the ROMs too (`load-rom.v3.data`): `vm.state` carries the
  ROM regions and will not restore against ones of another size, and they
  change only when the fork pin moves, which is a new `vm.state` anyway.
  And the kernel (`load-kernel.v3.data`). It changes only when the image's
  `ARG SNAPSHOT` date moves and Ubuntu's kernel moved with it. A stale kernel
  does not show when the page starts, because the running kernel is inside
  `vm.state`, but a reboot inside the VM cold-boots the file, and the loader
  takes whatever the browser has cached without checking its length.
  The tag renames the small lab disk too (`load-lab.v3.data`): it is a static
  asset, not an R2 object, but it belongs to the same matched set, and a fixed
  name is how the 1 GiB disk would outlive the move to 4 GiB in browsers that
  cached it as immutable. Nothing to upload for it - `load-lab.js` names it.

- **Rebuilt the engine: it gets a new name, and `worker.js` has to learn it.**
  The engine is cached exactly like the bundles above - edge cache first, then
  `immutable` for a year in browsers - while `out.js`, the emscripten loader
  that must come from the same build, is a static asset that revalidates. So
  an engine overwritten under a fixed name reaches nobody who has the old one,
  and they run the new loader against the old engine. Instead `pack-site.sh`
  names the engine by its content, `qemu-system-x86_64.<first 16 hex of its
  sha256>.wasm`, rewrites `out.js` to fetch exactly that, and refuses a build
  whose engine is not the one `R2_FILES` serves. The build is reproducible from
  a fixed fork commit (`patches/fork/REVISION`), flags and emsdk, so an
  unchanged engine keeps its name and needs no upload at all.

  When the engine does change, `make site` stops and prints the new name. Put
  it in `worker.js`'s `R2_FILES` (path and key) and in this guide - `node
  --test web/test/deploy-docs.test.mjs` lists each place it names the old one -
  commit, and build again. Upload the new object, `wrangler deploy` (the new
  `out.js` and the Worker switch together), then delete the old object once
  traffic has moved. Moving the fork pin also changes `vm.state`, so it is a
  new snapshot set and a new R2 tag as well.

  **Deploy an engine change when nobody is using the lab.** A tab that is
  already open keeps the loader and engine it started with, except in one
  place: emscripten starts four threads up front and more only when the VM
  needs more at once than it has before, and each new thread loads `out.js`
  again by its fixed name. After the deploy that is the new `out.js`, run
  against the old engine the tab hands it, and the VM can fail mid-session,
  losing whatever the student has not downloaded. (A page loaded in the
  seconds before the switch can also find its old engine no longer served; a
  reload fixes that.) If an engine change has to go out during a session,
  have students download their work and reload first.

  `vendor/` is renamed by neither. It holds xterm and xterm-pty, and xterm-pty
  is pinned exactly inside the fork tree (the fork's Dockerfile installs
  0.10.1, and `build.yml` says why it stays there), so it changes only if a
  pin move changes that version. Browsers that loaded the site before #74 hold
  `vendor/` as `immutable` for a year, so a pin move that does has to give
  `vendor/` a new path in `web/fork/index.html` too.

## Optional add-ons

- **Zone hygiene.** `lab.bashtion.dev` is configured as the canonical host (see
  `wrangler.jsonc`). For belt-and-suspenders on the zone, set SSL/TLS to Full
  (Strict) and turn on **Always Use HTTPS** and a minimum TLS version of 1.2 in
  the bashtion.dev dashboard.
- **Restrict who can load it** (if you ever want it gated to a known group
  rather than open): put **Cloudflare Access** (Zero Trust, free for small
  teams) in front of the Worker. Note this adds a login step, which usually
  defeats the "reachable from any locked-down browser" purpose — leave it off
  for the open safety-net use case.
- **Rate limiting (per IP) on the big-file paths.** In the **zone** (bashtion.dev)
  dashboard: **Security → Security rules** (older accounts: **Security → WAF →
  Rate limiting rules**) → **Create rule → Rate limiting rules**. Match the three
  paths — click **Edit expression** and paste:

  ```
  http.request.uri.path in {"/qemu-system-x86_64.d8537ec6ccf0354a.wasm" "/load-rootfsB.v3.data" "/load-state.v3.data"}
  ```

  Set **the same characteristics = IP** (the only per-IP option on free), then
  **When rate exceeds = 50 requests / 10 seconds**, **action = Block**. Free-plan
  limits: **one** rule per zone, counting period and block duration both **fixed
  at 10 s**, IP-only characteristic, Block returns HTTP 429.

  You will **not** see a **Cache status** / "Also apply rate limiting to cached
  assets" control — it is a **Business+** feature, hidden on Free/Pro, where it
  defaults to counting cached assets too. That is fine: rate limiting runs before
  the cache and the Worker, and these files are Worker-served (dynamic), so every
  request is counted regardless. Skip it.

  Threshold reasoning: a cold browser load fetches each big file once (~3
  requests), so 50 / 10 s allows ~16 simultaneous cold loads from one IP and
  auto-recovers after 10 s. Raise it (100+/10 s) if many users may sit behind one
  shared/NAT IP; lower it (20–30) for tighter protection when IPs are unique.

- **Usage / billing alert — the honest state on free.** There is **no** alert
  (free or paid) that warns you as you approach the Workers 100k-requests/day free
  cap; it simply starts returning errors — **not** a bill — when exceeded.
  Dollar-spend **Budget alerts** exist only once the account is **Pay-as-you-go**
  (a payment method on file, e.g. because R2 is enabled beyond its free tier):
  **Manage Account → Billing → Billable Usage → Create budget alert**, set a low
  **Budget threshold (USD)** (e.g. $1) and an email recipient. They are
  informational — they email you; they do **not** cap or pause usage. (Since
  2026-06-15 a default budget alert is on for Pay-as-you-go accounts, so check
  whether one already exists.) On a strictly-free account there is no metered
  spend to threshold on.

## Files here

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Worker + Static Assets + R2 binding config |
| `worker.js` | Serves the 3 big files from private R2 (allowlist, Range, hardened) |
| `_headers` | Security + isolation headers for the static files (COOP/COEP, CSP, …) |
| `split.sh` | Assembles `public/` from a built htdocs and prints the upload plan |
| `../scripts/pack-site.sh` | Turns the two CI artifacts into that htdocs (file_packager bundles) |
| `public/` | Generated static site (git-ignored) |

## Troubleshooting

- **`SharedArrayBuffer is not defined` / engine never starts** → COOP/COEP not
  on the page. Confirm `public/_headers` exists and Step 6's `curl` shows both.
- **Blank page, CSP errors in console** → you edited the page and reintroduced
  an inline script/handler. Move it into `boot.js`; `split.sh` will refuse an
  inline `onclick`.
- **Deploy rejected: file too large** → a big file leaked into `public/`.
  `split.sh` guards against this; make sure you deployed from `deploy/` after
  running it.
- **Big file 404s at runtime** → the R2 key does not match the request path.
  Keys must be exactly the ones `worker.js`'s `R2_FILES` serves:
  `qemu-system-x86_64.d8537ec6ccf0354a.wasm`, `load-rootfsB.v3.data`, `load-state.v3.data`.
- **`pack-site: page/Worker do not match the bundles`** → the build's tag is
  not the one `worker.js` serves (or there was none). Re-run `make site` with
  `R2TAG` set to the tag in `R2_FILES`; do not add unversioned or old-tag keys
  to `R2_FILES`, whatever the message suggests. If it is the engine it names,
  the engine changed: see **Updating later**.
- **`pack-site: the engine and the snapshot come from different fork trees`**
  (or an artifact **records no `FORK_REVISION`**) → the two downloads were
  built from different `patches/fork/REVISION` commits, or one from before the
  pin. Download the pair from runs after the last change to the pin; if
  `snapshot.yml` has not run since, run it (`gh workflow run snapshot.yml`).
