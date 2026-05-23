# Contributing

Thanks for considering a contribution to Edgent.

## Development Setup

```sh
git clone https://github.com/mv37-org/edgent.git
cd edgent
npm install
npm run typecheck
npm run lint
npm run test
npm run build
```

## Pull Requests

- Keep the SDK headless and browser-first.
- Do not add provider-specific clients to core.
- Keep CodeMirror integration in `@mv37/edgent/codemirror`.
- Keep Pyodide integration as a host-provided runtime wrapper.
- Add or update tests for behavior changes.
- Run `npm run typecheck && npm run lint && npm run test && npm run build` before opening a PR.

## Design Boundaries

Edgent should remain a small agent orchestration layer. Host apps should own credentials, provider selection, storage, UI, permissions, and side effects.
