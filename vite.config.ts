import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation helps ONNX Runtime Web use SharedArrayBuffer / multi-threaded WASM.
// credentialless allows Hub model fetches while still enabling SharedArrayBuffer.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  base: './',
  plugins: [react()],
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
});
