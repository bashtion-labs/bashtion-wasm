// Load one of the page's classic scripts into a test-controlled scope.
//
// The page ships plain <script> files that define a single top-level const
// (SERIALTAP, SERIALFS, ...). Nothing is bundled and nothing is imported at
// runtime, deliberately: the page runs under a CSP with no inline scripts and
// no module graph. To exercise those files here, evaluate the real source with
// the globals the browser would have provided, then hand back the symbol.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadScript(file, symbol, globals) {
  const src = readFileSync(join(WEB, file), 'utf8');
  const names = Object.keys(globals);
  const fn = new Function(...names, `${src}\n;return ${symbol};`);
  return fn(...names.map((n) => globals[n]));
}
