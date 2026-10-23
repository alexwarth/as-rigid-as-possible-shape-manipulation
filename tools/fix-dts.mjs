// After `tsc -p tsconfig.lib.json`: the emitted JavaScript gets its relative
// `.ts` import extensions rewritten to `.js` (rewriteRelativeImportExtensions),
// but declaration files keep `.ts`, which consumers' compilers reject. Rewrite
// them here so `lib/` is usable from any TypeScript or JavaScript project.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'lib';
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.d.ts')) continue;
  const p = join(dir, f);
  writeFileSync(p, readFileSync(p, 'utf8').replace(/(from\s+'\.\/[^']+)\.ts'/g, "$1.js'"));
}
