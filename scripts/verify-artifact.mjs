// Checks that dist/ is publishable before it is ever released.
//
// The CAD AutoScript host runs an equivalent audit when it publishes the
// artifact (scripts/sync-whisper-transcriber.mjs there). Running it here too
// means a bad bundle fails in this repository's CI instead of blocking the
// host's release pipeline.
//
// Usage: node scripts/verify-artifact.mjs [distDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist'));

const ALLOWED_EXTENSIONS = new Set(['.js', '.css', '.wasm', '.json', '.html', '.mjs']);
const FORBIDDEN_PATTERNS = [/localhost/i, /127\.0\.0\.1/, /\/@vite\//, /sourceMappingURL/i];

const problems = [];

function collectFiles(rootDir) {
  const files = [];

  const walk = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolute = path.join(currentDir, entry.name);
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');

      if (entry.isSymbolicLink()) {
        problems.push(`symlink in dist: ${relative}`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        problems.push(`non-regular file in dist: ${relative}`);
        continue;
      }
      if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        problems.push(`unexpected file type in dist: ${relative}`);
        continue;
      }
      files.push(relative);
    }
  };

  walk(rootDir);
  return files.sort();
}

function main() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    problems.push(`missing entry: ${path.join(DIST_DIR, 'index.html')}`);
    return;
  }

  const files = collectFiles(DIST_DIR);
  const assets = files.filter((file) => file !== 'index.html');
  const html = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(html)) {
      problems.push(`entry HTML contains a development reference (${pattern})`);
    }
  }

  const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  if (referenced.length === 0) {
    problems.push('entry HTML references no assets — the build is probably empty');
  }
  for (const reference of referenced) {
    if (!reference.startsWith('./')) {
      problems.push(`entry HTML must reference assets relatively, found: ${reference}`);
      continue;
    }
    if (!assets.includes(reference.replace(/^\.\//, ''))) {
      problems.push(`entry HTML references an unpackaged asset: ${reference}`);
    }
  }

  // The host manifest is built from these fields; without them it refuses the
  // artifact, so catch it here instead.
  const infoPath = path.join(DIST_DIR, 'build-info.json');
  if (!fs.existsSync(infoPath)) {
    problems.push('missing build-info.json');
  } else {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    for (const field of ['version', 'buildId', 'buildTime']) {
      if (!info[field]) problems.push(`build-info.json is missing ${field}`);
    }
    if (info.buildId === 'unversioned') {
      problems.push('build-info.json has no git build id — build inside a checkout');
    }
  }

  console.log(`[verify-artifact] ${files.length} files checked in ${DIST_DIR}`);
}

main();

if (problems.length > 0) {
  console.error('[verify-artifact] artifact is not publishable:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log('[verify-artifact] OK');
