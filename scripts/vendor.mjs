/* Copy exactly the three.js files this app reaches, and nothing else.
 *
 * The file set is derived by walking the ES module import graph from our
 * own entry points, so adding a loader later cannot silently ship a
 * broken bundle — a hand-maintained list would. That is not theoretical:
 * the first version of this script dropped ktx-parse and KTX2Loader
 * failed to resolve at load time.
 *
 * Two decoder folders are fetched by URL at runtime rather than imported,
 * so they are named explicitly.
 */
import { copyFileSync, mkdirSync, rmSync, existsSync, readFileSync, cpSync,
         readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const NPM = 'node_modules/three';
const OUT = 'vendor/three';
const ENTRIES = ['app.js', 'lens.js', 'atmosphere.js', 'hud-pad.js'];
const RUNTIME = ['examples/jsm/libs/draco/gltf', 'examples/jsm/libs/basis'];

if (!existsSync(NPM)) {
  console.error('three is not installed — run: npm install');
  process.exit(1);
}

const IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function resolve(spec, fromFile) {
  if (spec === 'three') return 'build/three.module.js';
  if (spec.startsWith('three/addons/')) return 'examples/jsm/' + spec.slice(13);
  if (spec.startsWith('.') && fromFile) {
    return normalize(join(dirname(fromFile), spec)).split('\\').join('/');
  }
  return null;
}

const needed = new Set();
const queue = [];

for (const entry of ENTRIES) {
  if (!existsSync(entry)) continue;
  for (const m of readFileSync(entry, 'utf8').matchAll(IMPORT)) {
    const r = resolve(m[1], null);
    if (r) queue.push(r);
  }
}

while (queue.length) {
  const rel = queue.pop();
  if (needed.has(rel)) continue;
  const abs = join(NPM, rel);
  if (!existsSync(abs)) {
    console.error(`  cannot resolve ${rel} inside three — aborting`);
    process.exit(1);
  }
  needed.add(rel);
  for (const m of readFileSync(abs, 'utf8').matchAll(IMPORT)) {
    const r = resolve(m[1], rel);
    if (r && !needed.has(r)) queue.push(r);
  }
}

rmSync(OUT, { recursive: true, force: true });
for (const rel of needed) {
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(NPM, rel), dest);
}
for (const rel of RUNTIME) {
  if (existsSync(join(NPM, rel))) cpSync(join(NPM, rel), join(OUT, rel), { recursive: true });
}

const bytes = (dir) => readdirSync(dir, { withFileTypes: true }).reduce(
  (n, e) => n + (e.isDirectory() ? bytes(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);

console.log(`vendored three.js: ${needed.size} modules + decoders -> ${OUT} ` +
            `(${(bytes(OUT) / 1048576).toFixed(1)} MB)`);
