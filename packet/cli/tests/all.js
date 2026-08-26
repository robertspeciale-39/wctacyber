// all.js — run every suite. `node cli/tests/all.js`
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const suites = ['run.js', 'cli.test.js', 'labs.test.js', 'e2e.js'];
let failed = 0;

for (const s of suites) {
  const r = spawnSync(process.execPath, [join(HERE, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
