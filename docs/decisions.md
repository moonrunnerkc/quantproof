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

## Phase 1 (vertical slice)

- All Ollama endpoint semantics verified live against 0.23.1 before coding: empty-prompt generate loads a model (done_reason "load") honoring num_ctx, the same request with keep_alive 0 unloads (done_reason "unload"), streaming generate is JSONL token lines ending in a done line with eval counts, errors are an {"error": msg} envelope with 4xx status. Captured responses live in tests/fixtures/ollama.
- This dev sandbox has no GPU access: no NVIDIA driver, no /dev/nvidia*, no nvidia-smi anywhere on the filesystem, and Ollama reports size_vram 0 (CPU inference). The vram probe therefore takes its designed unavailable path in every live run here; probe sampling, peak tracking, and gpu-identity parsing are tested against a fake nvidia-smi executable, which is the process boundary. The gate item "peak VRAM within a plausible range of nvidia-smi" cannot be verified on this machine and needs one manual run on the 5070 host.
- Determinism verified live (gate 3): gemma3:1b at temperature 0 seed 42 on ollama 0.23.1 produced byte-identical outputs across 3 in-run repetitions and across two consecutive CLI runs. The deterministic case applies; the nondeterministic path still exists and renders loudly if a backend ever stops honoring the seed.
- Kill-mid-run verified live: SIGKILL after 5 completed units left a journal with exactly those 5 units completed, each with its generation and score row present (one transaction per unit), 55 pending, run row readable.
- vram probe waits on the child's exit event, not close: close waits for the stdout pipe, which a grandchild process can hold open forever.
- Probe exposes gpu identity at start (not only at stop) because the run record is journaled before generations begin.
- Retry policy: only transport errors (unreachable backend) retry, twice; a mid-stream crash or malformed stream fails the unit immediately and is journaled as the failure reason. OOM classification is phase 2.
- Warmup uses the first example's rendered prompt, untimed and never journaled.
- Executor runs example-major (all repetitions of an example consecutively); determinism is judged per example across its repetitions by byte equality.
- Run ids are crypto.randomUUID; randomness is fine outside scoring, which stays pure.
- Added --limit N to quantproof run for smoke tests and quick checks; e2e uses a 3-example slice.
- eslint-plugin-import-x and typescript-eslint project service require config files listed in tsconfig include and the default-export exemption; vitest.e2e.config.ts added to both.
- First live result worth keeping: gemma3:1b scores 0.000 on invoice-extraction not because extraction fails (field-f1 would give 1.0 after normalization) but because it quotes totals as strings and the json-schema gate rejects "/total must be number". The gate composition surfaces exactly this distinction in details.

## Deferred

- Word-number parsing ("forty-two") for numeric-tolerance.
- README, docs/task-packs.md, docs/methodology.md: phase 3/4 deliverables per the build plan.
- Empty component directories (catalog, backends, telemetry, orchestrator, results, report) exist locally but hold no stubs; files appear when their phase does.
