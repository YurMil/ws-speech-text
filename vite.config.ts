import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation helps ONNX Runtime Web use SharedArrayBuffer / multi-threaded WASM.
// credentialless allows Hub model fetches while still enabling SharedArrayBuffer.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// The build id lands in the artifact manifest and in the in-app diagnostics, so
// a deployed bundle can always be traced back to a source commit.
function resolveBuildId(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unversioned';
  }
}

const APP_VERSION = pkg.version;
const BUILD_ID = resolveBuildId();
const BUILD_TIME = new Date().toISOString();

/** Emits dist/build-info.json so the host sync script can label the artifact. */
function buildInfoPlugin(): Plugin {
  return {
    name: 'ws-speech-text-build-info',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: `${JSON.stringify(
          { version: APP_VERSION, buildId: BUILD_ID, buildTime: BUILD_TIME },
          null,
          2,
        )}\n`,
      });
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  base: './',
  plugins: [react(), buildInfoPlugin()],
  worker: {
    format: 'es',
  },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
