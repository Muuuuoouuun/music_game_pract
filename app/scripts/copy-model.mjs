/**
 * Copies the basic-pitch TF.js model (model.json + weight shards) from the npm package
 * into public/basic-pitch/ so Vite serves it as a static asset next to index.html.
 * Runs before dev/build/test (npm pre-scripts); the copy is git-ignored.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@spotify', 'basic-pitch', 'model');
const dst = join(root, 'public', 'basic-pitch');

if (!existsSync(src)) {
  console.error('[copy-model] @spotify/basic-pitch is not installed (expected ' + src + '). Run npm install.');
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
let copied = 0;
for (const name of readdirSync(src)) {
  const from = join(src, name);
  const to = join(dst, name);
  if (!statSync(from).isFile()) continue;
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied++;
}
console.log(`[copy-model] basic-pitch model → public/basic-pitch (${copied} file(s) copied)`);
