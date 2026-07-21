# CAD AutoScript Site Integration

## 1. Integration model

`YurMil/ws-speech-text` is the source repository. It publishes a versioned static release artifact. `YurMil/cadautoscript.com` downloads, verifies, and embeds that artifact through its existing same-origin utility iframe architecture.

The CAD AutoScript site must not install or bundle Transformers.js, ONNX Runtime, or model weights.

## 2. Paths

| Concern | Location |
|---|---|
| Source application | `YurMil/ws-speech-text` repository root |
| Source build output | `dist/` |
| Release archive | GitHub release asset |
| Host sync script | `scripts/sync-whisper-transcriber.mjs` |
| Host published app | `static/utility-apps/whisper-transcriber/` |
| Host entry | `static/utility-apps/whisper-transcriber/app.html` |
| Host route | `src/pages/utilities/whisper-transcriber.tsx` |
| Shell config | `src/data/utilityShellPages.tsx` |
| Catalog | `src/data/utilities.ts` |
| User docs | `docs/utilities/whisper-transcriber.mdx` |
| Security headers | `vercel.json` |

## 3. Vite output

```ts
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: {format: 'es'},
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});
```

Release packaging renames `index.html` to `app.html` or emits the correct name, rejects absolute development paths, and generates manifest/checksum files.

## 4. Host sync process

The host sync script must:

1. accept a pinned release tag and expected archive checksum;
2. download the release archive;
3. verify SHA-256 before extraction;
4. reject path traversal, symlinks, and unexpected file types;
5. validate `app.html` references only packaged relative assets;
6. reject localhost, source maps, and development endpoints;
7. verify the artifact manifest and per-file checksums;
8. stage into a temporary directory;
9. atomically replace the published target;
10. print build ID, release tag, and total bytes.

## 5. Docusaurus route

```tsx
import {createUtilityPage} from '@site/src/components/Utilities/createUtilityPage';

export default createUtilityPage('whisper-transcriber');
```

Add the route only after the artifact exists and preview security policies work.

## 6. Per-utility iframe permissions

Extend shell config:

```ts
export type UtilityPageConfig = {
  // existing fields
  iframeAllow?: string;
};
```

Transcriber entry:

```ts
iframeAllow: "microphone 'self'"
```

Shell rendering:

```tsx
const {iframeAllow = "camera 'self'"} = config;

<iframe
  ref={iframeRef}
  src={iframeSrc}
  title={title}
  allow={iframeAllow}
  loading="lazy"
/>
```

Do not grant microphone access to all utilities.

## 7. Permissions Policy blocker

The current global policy contains `microphone=()`, which blocks both the host page and embedded document. The transcriber host route and embedded app path require an effective policy equivalent to:

```text
Permissions-Policy: camera=(self), microphone=(self), geolocation=()
```

Relevant paths:

```text
/utilities/whisper-transcriber/*
/utility-apps/whisper-transcriber/*
```

Other routes should retain microphone denial where practical. Verify final Vercel response headers and precedence in preview.

## 8. Content Security Policy

The existing host policy already needs Worker and WASM support. Model delivery determines `connect-src`:

- first-party model path: no broad third-party origin required;
- remote Hub: add only exact tested origins and redirects for pinned assets.

Never use unrestricted `connect-src *` or `connect-src https:`. Prefer path-specific policy where platform behavior is predictable.

## 9. Cache headers

Hashed utility assets:

```text
Cache-Control: public, max-age=31536000, immutable
```

`app.html` and mutable manifests should revalidate. Versioned model files may be immutable under their own specific rule.

## 10. Host bridge

Allowed same-origin messages:

```ts
{type: 'cas:host-context', version: 1, locale: 'en', theme: 'dark'}
{type: 'cas:utility-ready', version: 1, buildId: '...'}
{type: 'cas:utility-error', version: 1, code: '...'}
```

Both sides verify `event.origin` and `event.source`. No audio, filenames, transcript text, segments, or user edits are sent.

Version 1 does not announce support for the host `?calc=` share protocol.

## 11. Catalog and localization

After release acceptance:

- add the slug to `UtilityPageSlug`;
- add shell metadata;
- add catalog descriptor and related tools;
- add thumbnail/OG image;
- add English user documentation;
- add required strings to all six host locale dictionaries;
- add localized MDX according to CAD AutoScript policy.

Public copy must say that first use downloads a model and that browser caches can be cleared or evicted.

## 12. CI split

### Source repository

Install, typecheck, unit test, build, verify artifact, privacy/network tests, dependency audit, and release packaging.

### Host repository

Download pinned artifact, verify checksums, confirm entry/assets, run typecheck/lint/build, and execute iframe/security-header preview tests.

The host build never downloads model weights.

## 13. Preview acceptance

- all packaged assets and Worker/WASM files return 200 with correct MIME types;
- cold and warm model preparation work;
- microphone prompt appears only after click;
- file workflow works when microphone is denied;
- WebGPU fallback works;
- cancellation releases tracks and Worker;
- transcript content is absent from requests, URLs, logs, analytics, and host messages;
- fullscreen and responsive iframe layouts work;
- rollback restores the previous artifact and policy.
