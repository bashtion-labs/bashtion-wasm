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
  loads/day of headroom.
- **Bandwidth through the Worker** does not burn CPU time — streaming an R2
  object to the response is pass-through, so the free CPU limit is a non-issue.

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

## Step 4 — Upload the rootfs (multipart, scoped credential)

`wrangler r2 object put` uses a single request (~300 MiB ceiling); the rootfs is
~874 MiB, so use a multipart tool with a **least-privilege, temporary** token.

1. In the dashboard: **R2 → API → Manage API Tokens → Create API Token**.
   - Permission: **Object Read & Write**.
   - Scope: **Apply to specific buckets only → `bashtion-assets`**.
   - TTL: as short as is practical (you only need it for one upload).
   - Note the **Access Key ID**, **Secret Access Key**, and your account's S3
     endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
2. Configure rclone (do **not** commit this config; keep the secret out of the
   repo and your shell history):

   ```sh
   rclone config create r2 s3 \
     provider=Cloudflare \
     access_key_id=<ACCESS_KEY_ID> \
     secret_access_key=<SECRET_ACCESS_KEY> \
     endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
     acl=private
   ```
3. Upload:

   ```sh
   rclone copyto out/gate1/htdocsF/load-rootfsB.data \
     r2:bashtion-assets/load-rootfsB.data --s3-chunk-size 64M --progress
   ```
4. **Rotate or delete the token now** (dashboard → the token → Roll/Delete), and
   `rclone config delete r2`. The running site does not use it — only the Worker
   binding, which needs no key.

Confirm all three objects are present:

```sh
npx wrangler r2 object get bashtion-assets/load-rootfsB.data --remote 2>&1 | head -c 0 && echo ok
npx wrangler r2 bucket list
```

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
