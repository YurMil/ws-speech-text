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
const ALLOWLIST_PATH = path.join(ROOT, 'scripts', 'allowed-external-origins.json');

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

/**
 * Nothing in the bundle may reach a third party.
 *
 * A stylesheet that @imports a web font passes every other check here — it is
 * valid CSS, referenced from a packaged file — yet it is blocked by the host CSP
 * and announces the visitor's IP to whoever serves it. So:
 *
 *   CSS: any absolute http(s) URL fails. There is no legitimate reason for one,
 *        and the check has no false positives.
 *   JS:  a bundled library's error strings and doc links contain URLs it never
 *        requests, so a plain match would be noise. Instead the set of origins
 *        is ratcheted against a reviewed allowlist: known-inert ones pass, a new
 *        one fails until somebody writes down why it is there.
 */
function checkExternalReferences(files) {
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')).origins ?? {};
  const seen = new Map();

  for (const relative of files) {
    const extension = path.extname(relative).toLowerCase();
    if (extension !== '.css' && extension !== '.js' && extension !== '.mjs') continue;

    const contents = fs.readFileSync(path.join(DIST_DIR, relative), 'utf8');
    const urls = contents.match(/https?:\/\/[a-zA-Z0-9.-]+/g) ?? [];

    // Report each origin once per file, however many times it occurs.
    const reported = new Set();

    for (const url of urls) {
      const origin = url.replace(/^http:/, 'https:');
      if (extension === '.css') {
        if (reported.has(origin)) continue;
        reported.add(origin);
        problems.push(`stylesheet reaches a third party: ${relative} -> ${origin}`);
        continue;
      }
      if (!(origin in allowlist) && !reported.has(origin)) {
        reported.add(origin);
        problems.push(
          `unreviewed external origin in ${relative}: ${origin}\n` +
            `      If the bundle never requests it, record why in scripts/allowed-external-origins.json.`,
        );
      }
      seen.set(origin, (seen.get(origin) ?? 0) + 1);
    }
  }

  for (const [origin, count] of [...seen].sort()) {
    console.log(`[verify-artifact] external origin present: ${origin} (${count}x, allowlisted)`);
  }
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

  checkExternalReferences(files);

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
