import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const scriptsOf = (html) =>
  [...html.matchAll(/<script[^>]*src="\.\/([^"]+)"/g)].map((m) => m[1]);

// Both pages are plain classic scripts with no module graph, so nothing
// enforces load order but the page itself. bootscreen and boot.js call into
// SERIALTAP and TERMFIT, which are `const` at top level — referencing one
// before its script has run is a TDZ ReferenceError, not undefined.
const NEEDS_FIRST = { 'bootscreen.js': ['serialtap.js', 'termfit.js'] };

for (const page of ['fork/index.html', 'index.html']) {
  test(`${page} loads its dependencies before the scripts that use them`, () => {
    const scripts = scriptsOf(read(page));
    for (const [later, earlier] of Object.entries(NEEDS_FIRST)) {
      const at = scripts.indexOf(later);
      if (at < 0) continue;
      for (const dep of earlier) {
        const depAt = scripts.indexOf(dep);
        assert.ok(depAt >= 0, `${page} never loads ${dep}`);
        assert.ok(depAt < at, `${page} loads ${dep} after ${later}`);
      }
    }
  });

  test(`${page} loads the whole page-script set`, () => {
    const scripts = scriptsOf(read(page));
    for (const f of ['serialtap.js', 'termfit.js', 'serialfs.js', 'bootscreen.js']) {
      assert.ok(scripts.includes(f), `${page} does not load ${f}`);
    }
  });
}

test('the deployed page stays CSP-clean: no inline script, no inline handler', () => {
  const html = read('fork/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'inline <script> would need unsafe-inline');
  assert.ok(!/\son[a-z]+\s*=/.test(html), 'inline event handler would need unsafe-inline');
});

test('the dev page inline module is syntactically valid', () => {
  const m = read('index.html').match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'dev page has no inline module');
  const body = m[1].replace(/^\s*import .*$/m, '');
  // top-level await is legal in a module; wrap so the Function constructor
  // (which parses as a script) accepts it.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(body));
});

test('every script the deploy assembles is one the pages actually name', () => {
  const split = readFileSync(join(WEB, '..', 'deploy', 'split.sh'), 'utf8');
  const shipped = split.match(/^PAGE=\(([^)]*)\)/m)[1].split(/\s+/).filter(Boolean);
  const named = new Set([...scriptsOf(read('fork/index.html')), 'index.html', 'module.js']);
  for (const f of shipped) {
    assert.ok(named.has(f), `split.sh ships ${f}, which the page never loads`);
  }
});
