# Contributing

The most valuable contribution is a **task pack**: 20 to 50 real
examples of a job you need local models to do, with machine-checkable
expected values. Packs are plain YAML and JSON, no TypeScript required;
the format is specified in [docs/task-packs.md](docs/task-packs.md) and
`quantproof init` scaffolds one. Open a PR adding your pack under
`examples/` with a one-line description of the task and, if you have
one, the report from a run on your hardware.

Result reports are welcome too: run your pack, export with
`quantproof report --bundle`, and attach the bundle so the scores can
be re-checked from your raw outputs.

For code PRs, the standards in the repo are non-negotiable and CI
enforces most of them: TypeScript strict with no `any`, named exports
only, kebab-case filenames, a 300-line cap per file, JSDoc on every
export, and tests that validate behavior rather than wiring (fake the
backend adapter, never the module under test). Error messages state
what failed and what to do about it. Run `npm run typecheck`,
`npm run lint`, and `npm test` before pushing; `npm run test:e2e`
additionally exercises a live backend when one is available and skips
politely when not.

Decisions that shaped the design live in
[docs/decisions.md](docs/decisions.md); measurement limits in
[docs/methodology.md](docs/methodology.md). If your change deviates
from either, say so in the PR.
