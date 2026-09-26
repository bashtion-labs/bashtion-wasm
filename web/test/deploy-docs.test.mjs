import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Every Markdown document in the repository, build output and upstream code
// aside - not only the deploy guide, which is where the check began while the
// top-level README went on naming the bundles without their tag.
const SKIP = new Set(['.git', 'node_modules', 'third_party', 'out', 'dist', 'public']);
const markdown = (dir = '') => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
  const p = dir ? `${dir}/${e.name}` : e.name;
  if (e.isDirectory()) return SKIP.has(e.name) ? [] : markdown(p);
  return e.name.endsWith('.md') ? [p] : [];
});

// The R2 bundles are versioned (#68), and worker.js is where the tag lives:
// pack-site.sh refuses a build whose bundle names are not exactly the keys
// R2_FILES serves. So a deploy guide that names any other key - an older tag,
// or none - is a command that cannot finish, an upload nothing will serve, or
// a rate-limit rule that matches nothing. This is how it went stale before.
const worker = read('deploy/worker.js');
const guide = read('deploy/README.md');
const served = new Set([...worker.matchAll(/^\s*'\/([^']+)':\s*\{\s*key:/gm)].map((m) => m[1]));
const tags = new Set([...served].map((k) => k.match(/^load-[A-Za-z]+\.([^.]+)\.data$/)?.[1]).filter(Boolean));
const codeBlocks = [...guide.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map((m) => m[1]).join('\n');

test('worker.js serves one snapshot tag', () => {
  assert.equal(tags.size, 1, `R2_FILES names tags ${[...tags]}`);
});

test('the deploy guide builds with the tag worker.js serves', () => {
  const [tag] = tags;
  const cmds = codeBlocks.split('\n').filter((l) => /^\s*make site\b/.test(l));
  assert.ok(cmds.length > 0, 'deploy/README.md has no `make site` command');
  for (const cmd of cmds) {
    assert.match(cmd, new RegExp(`\\bR2TAG=${tag}\\b`), `\`${cmd.trim()}\` does not build the ${tag} bundles`);
  }
});

// The engine is named by its hash (#74): pack-site.sh builds
// qemu-system-x86_64.<16 hex>.wasm and refuses a build whose engine is not the
// one R2_FILES serves. A new engine is therefore a new name in worker.js, and
// every document naming the old one - an upload command, the rate-limit rule,
// a curl check - goes stale with it, as the tag did before this test.
const engines = [...served].filter((k) => /^qemu-system-x86_64\b/.test(k));

test('worker.js serves one engine, named by its hash', () => {
  assert.equal(engines.length, 1, `R2_FILES names engines ${engines}`);
  assert.match(engines[0], /^qemu-system-x86_64\.[0-9a-f]{16}\.wasm$/);
  const [path, key] = worker.match(/^\s*'\/(qemu-system-x86_64[^']*)':\s*\{\s*key:\s*'([^']+)'/m).slice(1);
  assert.equal(key, path, 'the engine key is not its path');
});

test('every engine a document names is the one worker.js serves', () => {
  const [engine] = engines;
  let named = 0;
  for (const doc of markdown()) {
    // a <placeholder> in place of the hash describes the scheme, not a file
    for (const [name] of read(doc).matchAll(/qemu-system-x86_64(?:\.(?!<)[^.\s"'`/]+)?\.wasm/g)) {
      assert.equal(name, engine, `${doc} names ${name}; worker.js serves ${engine}`);
      named++;
    }
  }
  assert.ok(named > 0, 'no document names the engine');
});

test('every snapshot-set bundle a document names carries the served tag', () => {
  const [tag] = tags;
  const docs = markdown();
  for (const doc of ['README.md', 'deploy/README.md']) assert.ok(docs.includes(doc), `${doc} not scanned`);
  const bundles = (text) => [...text.matchAll(/load-(rootfsB|state|lab|rom)(?:\.([^.\s"'`/]+))?\.data/g)];
  assert.ok(bundles(guide).length > 0, 'deploy/README.md names no snapshot-set bundle');
  for (const doc of docs) {
    for (const [name, bundle, t] of bundles(read(doc))) {
      assert.equal(t, tag, `${doc} names ${name}; worker.js serves the ${tag} set`);
      // the lab disk and the ROMs are static assets; the other two are R2 keys the Worker must know
      if (bundle !== 'lab' && bundle !== 'rom') assert.ok(served.has(name), `worker.js does not serve ${name}`);
    }
  }
});
