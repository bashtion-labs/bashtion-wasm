# Deploying bashtion-wasm on Cloudflare (free tier, hardened)

This directory deploys the browser VM to Cloudflare's free plan with a
security-first configuration. Follow it top to bottom the first time; the
**Updating** and **Reference** sections are for later.

## What gets deployed, and why it is shaped this way

The build produces one directory of files (`out/gate1/htdocsF/`). Three of them
are large:

| File | Size | Where it goes |
|------|------|---------------|
| `load-rootfsB.data` (the Ubuntu disk) | ~874 MiB | **R2** |
| `load-state.data` (the saved running state) | ~297 MiB | **R2** |
| `qemu-system-x86_64.wasm` (the engine) | ~39 MiB | **R2** |
| the page, JS, `load-kernel.data` (17 MiB), ROM, lab disk, `vendor/` | each < 25 MiB | **Static Assets** |

Cloudflare's static hosting (Pages / Workers Static Assets) rejects any single
file over **25 MiB**, so the big three cannot be static files. They live in a
**private R2 bucket** and are streamed by a small Worker (`worker.js`).
Everything is served from **one origin**, which keeps the setup simple and
sidesteps all cross-origin (CORS/CORP) complexity.

```
browser ──▶ https://lab.bashtion.dev
             ├─ /  /*.js  /vendor/*  /load-kernel.data …  ─▶ Static Assets (public/)
             └─ /qemu-system-x86_64.wasm                   ─▶ worker.js ─▶ private R2
                /load-rootfsB.data  /load-state.data           (bucket binding)
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

`worker.js` stores each full GET of `qemu-system-x86_64.wasm` and `load-state.data`
in Cloudflare's edge cache (they are immutable), so a second visitor in the same
region gets them straight from cache — no Worker invocation, no R2 read. The
~874 MiB `load-rootfsB.data` is intentionally **not** cached: it is above the
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
curl -s -o /dev/null -D - https://lab.bashtion.dev/qemu-system-x86_64.wasm \
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
- The built site at `out/gate1/htdocsF/` (from the build/snapshot pipeline, or a
  CI artifact download).
- For the ~874 MiB rootfs upload: [`rclone`](https://rclone.org/downloads/)
  (`brew install rclone`), because it uploads in multipart chunks. `aws-cli`
  works too.

---

## Step 1 — Assemble the static half

```sh
./deploy/split.sh          # defaults to out/gate1/htdocsF
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
npx wrangler r2 object put bashtion-assets/qemu-system-x86_64.wasm \
    --file out/gate1/htdocsF/qemu-system-x86_64.wasm --remote

npx wrangler r2 object put bashtion-assets/load-state.data \
    --file out/gate1/htdocsF/load-state.data --remote
```

## Step 4 — Upload the rootfs (multipart) with a least-privilege token

`wrangler r2 object put` uses a single request (~300 MiB ceiling); the rootfs is
~874 MiB, so upload it with rclone using a **scoped, temporary** R2 API token.

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
fail. (Cloudflare's own example omits it and uses the interactive `rclone
config` wizard — provider `Cloudflare`, region `auto`, that endpoint — which
yields the same `[r2]` remote.)

**4c. Upload (multipart):**

```sh
rclone copy out/gate1/htdocsF/load-rootfsB.data r2:bashtion-assets/ \
  --s3-upload-cutoff=100M --s3-chunk-size=100M --progress
```

This stores it as `r2:bashtion-assets/load-rootfsB.data`.

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
  https://lab.bashtion.dev/qemu-system-x86_64.wasm | \
  grep -iE 'HTTP|content-range|content-type'
```

Then open the URL in a browser: you should see the boot banner, then a
`user@bashtion:~$` prompt. If the tab shows a `SharedArrayBuffer is not defined`
error, the COOP/COEP headers are not reaching the page — check `public/_headers`
made it into the deploy.

---

## Updating later

- **Changed the page/JS only:** re-run `./deploy/split.sh`, then
  `cd deploy && npx wrangler deploy`. No R2 changes needed.
- **Rebuilt the guest image or snapshot:** re-upload whichever of the three big
  files changed (Steps 3–4), then redeploy. R2 objects are content-addressed by
  you here, so overwriting the same key is fine; visitors get the new bytes
  (the immutable cache is keyed on the URL — if you need instant invalidation,
  version the key, e.g. `load-rootfsB.v2.data`, and update `worker.js`).

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
- **Rate limiting.** The free plan includes basic rate-limiting rules; you can
  cap requests per IP to the big-file paths if abuse is ever a concern.

## Files here

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Worker + Static Assets + R2 binding config |
| `worker.js` | Serves the 3 big files from private R2 (allowlist, Range, hardened) |
| `_headers` | Security + isolation headers for the static files (COOP/COEP, CSP, …) |
| `split.sh` | Assembles `public/` from a build and prints the upload plan |
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
  Keys must be exactly `qemu-system-x86_64.wasm`, `load-rootfsB.data`,
  `load-state.data`.
