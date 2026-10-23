// Build a Worker from flat files in the repository root.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const types = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'sw.js': 'text/javascript; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json',
  'icon.svg': 'image/svg+xml'
};
const assets = {};
for (const [name, type] of Object.entries(types)) {
  assets['/' + name] = { type, body: readFileSync(new URL(`./${name}`, import.meta.url), 'utf8') };
}
const src = readFileSync(new URL('./worker-source.js', import.meta.url), 'utf8');
if (!src.includes('/*__ASSETS__*/ {}')) throw new Error('worker-source.js placeholder missing');
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/worker.js', import.meta.url), src.replace('/*__ASSETS__*/ {}', () => JSON.stringify(assets)));
console.log('built dist/worker.js from root-level files');
