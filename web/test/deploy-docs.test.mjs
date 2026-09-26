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

test('every snapshot-set bundle a document names carries the served tag', () => {
  const [tag] = tags;
  const docs = markdown();
  for (const doc of ['README.md', 'deploy/README.md']) assert.ok(docs.includes(doc), `${doc} not scanned`);
  const bundles = (text) => [...text.matchAll(/load-(rootfsB|state|lab)(?:\.([^.\s"'`/]+))?\.data/g)];
  assert.ok(bundles(guide).length > 0, 'deploy/README.md names no snapshot-set bundle');
  for (const doc of docs) {
    for (const [name, bundle, t] of bundles(read(doc))) {
      assert.equal(t, tag, `${doc} names ${name}; worker.js serves the ${tag} set`);
      // the lab disk is a static asset; the other two are R2 keys the Worker must know
      if (bundle !== 'lab') assert.ok(served.has(name), `worker.js does not serve ${name}`);
    }
  }
});
