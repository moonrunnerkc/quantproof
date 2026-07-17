# Decisions

Running ADR log. One line per decision: what, why. Newest at the bottom
of each section.

## Phase 0 (scaffold + scoring core)

- Dev toolchain runs on Node 22.15 via nvm (system node is 18); package.json engines is >=22 per the build plan.
- Skipped zod: manifest validation is hand-rolled so every error is collected in one pass with a field-specific fix hint; ajv stays reserved for pack-declared JSON Schemas.
- Deferred better-sqlite3 to phase 1: native dependency with no consumer in the scoring core, adding it now only slows installs.
- eslint-plugin-import-x instead of eslint-plugin-import: the latter has no eslint 10 peer support; import-x provides the same no-default-export rule.
- Added an optional `gates` list to the task.yaml manifest: build plan 5.1 does not show it but 5.6 requires gate composition, so gates are declared as `[{ scorer, scorer_params }]`.
- Files beyond the section 8 skeleton in src/scoring: extract-json.ts, scorer-params.ts, gate-composition.ts, builtin-scorers.ts; shared logic and the 300-line cap made separate modules the honest decomposition.
- JSON extraction takes the first balanced `{...}`/`[...]` in the output; if that candidate never closes or fails to parse, the output scores zero rather than scanning for a later value.
- normalizeScalar compares purely numeric strings as numbers, so "$1,234.50" matches 1234.5; strings with trailing prose stay strings.
- Percent tokens parse at face value ("42%" is 42, not 0.42); packs that want fractions encode the expected value accordingly.
- Number parsing handles US-style thousands separators only; European decimal commas are out of scope and score as mismatches.
- Numbers written as words never parse in numeric-tolerance; documented limit with an expected-fail test, not a bug.
- field-f1 counting: present-and-wrong counts against both precision and recall, absent counts against recall only; score is F1 and pass requires every key field to match.
- exact-label requires the (normalized) whole output to be a label or alias; a label wrapped in prose scores zero, since emitting a bare label is part of the task.
- exact-label treats an off-label `expected` value as a pack authoring error and throws instead of silently scoring zero forever; an expected value written as an alias resolves canonically.
- Gate composition always runs the primary scorer so its raw score survives in details; only the top-level score is zeroed, and the record names the first failing gate.
- pattern scorer: score is the matched fraction, pass follows all/any; contains mode is case-sensitive because its targets (config keys, code fragments) are.
- CLI ships a single `validate` command in phase 0: the bin entry needs a real entry point and pack validation is the only complete vertical; run/resume/report/models/init land with their phases.
- test:e2e is a placeholder echo until the phase 1 Ollama adapter exists; no live Ollama behavior was assumed anywhere in the scoring core.
- Starter-pack determinism gate compares JSON.stringify of score records across 1000 invocations; string equality in JS is a byte-level (code unit) comparison.
- Determinism gate scoping: each scorer runs against every example it can type-check against (numeric-tolerance gets invoice totals, pattern gets ticket labels, field-f1 gets config objects); scorers throw by design on wrong-typed expected values, so the literal "every scorer x every example" cross product is impossible.

## Deferred

- Word-number parsing ("forty-two") for numeric-tolerance.
- README, docs/task-packs.md, docs/methodology.md: phase 3/4 deliverables per the build plan.
- Empty component directories (catalog, backends, telemetry, orchestrator, results, report) exist locally but hold no stubs; files appear when their phase does.
