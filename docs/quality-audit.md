# Quality Audit Notes

This file tracks quality and security follow-ups that should not be fixed by blind automated rewrites.

## 2026-06-11

- Added frontend type checking as a first-class check with `npm run typecheck`.
- Added GitHub Actions CI for gateway tests, frontend type checking/build, and AstrBot bridge syntax compilation.
- Added CodeQL scanning for JavaScript and TypeScript.
- `npm audit --registry=https://registry.npmjs.org --audit-level=moderate` reports a critical advisory through `frontend` dependency `pixi-live2d-display -> gh-pages`.
- Do not run `npm audit fix --force` for that advisory without a Live2D compatibility pass, because npm proposes a breaking `pixi-live2d-display` change.
- Recommended follow-up: evaluate a maintained Live2D integration or a patched dependency path, then verify `/live/?demo=stage` and normal room rendering before deployment.

## 2026-06-12

- Rechecked the Live2D audit path after the latest refactor batch.
- The critical advisory was isolated to `frontend` via `pixi-live2d-display -> gh-pages`.
- Added a frontend npm override so `pixi-live2d-display@0.4.0` resolves `gh-pages` to `6.3.0`.
- `npm audit --registry=https://registry.npmjs.org --audit-level=moderate` now reports 0 vulnerabilities.
- Keep browser verification for `/live/?demo=stage` in this batch because Live2D rendering remains optional and falls back to PNG when no model URL is configured.
