# Contributing

## Documentation changes

Keep requirements explicit and testable. Clearly distinguish current behavior, proposed behavior, and deferred scope. Update cross-references and the architecture decision log when changing a boundary, privacy guarantee, runtime policy, or release invariant.

## Implementation workflow

Use a feature branch and pull request. Before opening a PR, run the available equivalents of:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:artifact
```

Do not commit generated `dist/`, downloaded model weights, recordings, transcripts, environment files, browser caches, or private benchmark data.

## Code boundaries

- inference and model preparation run in a module Web Worker;
- audio algorithms live outside React components;
- domain/protocol code remains framework-independent where practical;
- model IDs, revisions, dtypes, limits, and capabilities come from a validated manifest;
- the CAD AutoScript host receives only the verified static artifact;
- no transcript-derived state enters host messages or share URLs.

## Security and privacy

Never add telemetry or logs containing audio, filenames, transcript text, timestamped segment text, user edits, or device identifiers. New network origins, browser storage, permissions, model revisions, Worker messages, and content-derived metrics require explicit documentation and tests.

Use stable error codes and sanitized diagnostics instead of forwarding raw third-party exception text.

## Tests required by change type

| Change | Minimum tests |
|---|---|
| Audio normalization | deterministic fixtures, limits, cancellation |
| Worker protocol | request correlation, stale messages, crash/cancel recovery |
| Runtime/model profile | WASM, WebGPU fallback, manifest validation |
| Export | TXT/SRT/VTT formatting and unsafe-text cases |
| Microphone | permission denial, stop/cleanup, browser E2E |
| Network/model delivery | CSP/CORS, cold/warm cache, interrupted download |
| Telemetry/diagnostics | privacy marker and allowlist tests |
| Release tooling | checksum, unsafe archive, missing asset, rollback tests |

## Release changes

A release must use immutable package and model revisions, generate checksums and an SBOM, retain third-party notices, and pass the browser, privacy, accessibility, performance, security-header, artifact, and rollback gates in `docs/08-testing-observability-release.md`.

## Commit and PR scope

Prefer focused PRs. Do not combine major audio algorithm changes, model replacement, security-header expansion, and public launch in one change. PR descriptions should state:

- what changed and why;
- architecture/privacy impact;
- model/runtime impact;
- tests and browsers used;
- artifact size change;
- migration and rollback procedure.
