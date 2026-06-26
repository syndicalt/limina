// Copy the canonical installers (repo root) into site/public so they are served
// at https://www.liminaengine.com/install.sh and /install.ps1. Runs in `prebuild`
// so every deploy ships the current scripts; the committed copies keep `astro dev`
// and immediate serving working too.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const publicDir = resolve(here, '..', 'public');

mkdirSync(publicDir, { recursive: true });
for (const file of ['install.sh', 'install.ps1']) {
  copyFileSync(resolve(repoRoot, file), resolve(publicDir, file));
  console.log(`synced ${file} → site/public/${file}`);
}
