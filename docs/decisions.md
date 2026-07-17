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

## Phase 2 (sweep, fit, resume)

- Run config format kept to two keys (candidates, use_local_models), documented in docs/run-config.md; unknown keys are hard errors so typos cannot silently change a sweep.
- BackendAdapter interface extended with listModels(), and ModelDescriptor with a remote flag: the resolver needs the local store, and Ollama cloud entries must be excluded from sweeps because nothing about them is measurable locally.
- Architecture metadata comes from /api/show model_info first; the in-repo GGUF header reader (documented format, versions 2 and 3, arrays skipped structurally) is the fallback and was verified against real multi-gigabyte blobs. The blob locator searches $OLLAMA_MODELS, ~/.ollama/models, then /usr/share/ollama/.ollama/models (the systemd service default, which is where this machine's store actually lives).
- KV cache estimate: blocks x kv_heads x (key_length + value_length) x context x 2 bytes (f16). Fixed compute allowance 1024 MiB. Conservative bias: fits requires predicted peak within 95% of sampled free VRAM.
- With no GPU telemetry, fit verdicts are "unknown" and unknown candidates run (measurement decides); only a confident does-not-fit is filtered without --force. An explicitly named --model always runs: naming it is the override.
- OOM classifier patterns include Ollama 0.23.1's generic load failure ("model failed to load ... resource limitations"), verified live by loading a 17 GB model on this 15 GB machine; it is deliberately a *suspect* classification. A mid-stream backend crash also classifies as OOM-suspect per build plan section 6.
- Unit statuses gained "skipped": an OOM candidate's remaining units are journaled as skipped with the reason, so resume can honor "never re-attempt OOM at the same configuration" from the journal alone.
- Resume drift detection fingerprints the whole pack directory (every file, sorted walk) and the config file bytes; any change aborts resume with an explanation instead of mixing configurations.
- Isolation between candidates: forced unload (in the candidate runner's finally), VRAM polled back to within 256 MiB of the pre-load baseline or a 15s timeout with a loud warning, then a 3s cooldown. On this GPU-less machine the baseline poll is a no-op by design.
- Partial-offload heuristic: measured peak under 60% of predicted while completing, or median tok/s under 25% of the best similar-size candidate (0.5x to 2x weights). It writes a reasoned flag, never a hard claim, and needs peers or a prediction to fire.
- Time estimate: fixed 20 tok/s guess plus flat per-unit and per-candidate overheads, recomputed from the first completed candidate's measured median rate for the remaining candidates.
- executeSingleModelRun was replaced by prepareSweepJournal + executeSweep (a single --model run is now a one-candidate sweep); pre-release interface change, all callers updated in the same commits.
- Live sweep gate: 4 real candidates (gemma3-27b-q4 16.4 GiB, qwen3:14b, qwen3:4b, gemma3:1b) over ticket-classification. The 27b was induced to OOM (17 GiB weights on a 15 GiB RAM, GPU-less machine), classified oom-suspect at load, its 6 units journaled as skipped, and the sweep completed the other three candidates (18/18 units, all seed-deterministic, 25.2 / 10.4 / 4.1 tok/s). The offload heuristic correctly stayed quiet: no two candidates share a size band on this ladder.
- Live kill/resume gate: SIGKILL mid-candidate left 2 of 24 units completed; resume picked up exactly the 16 pending units across 3 non-OOM candidates and re-ran nothing finished. A second unplanned kill (SIGPIPE from a truncated shell pipeline) mid-resume was also absorbed: final journal holds all 24 units exactly once, zero units with more than one generation.
- Gate 4 (predicted vs measured VRAM within 15%) is unverifiable on this machine: predicted peaks are recorded for every candidate (18447 / 10190 / 3694 / 1854 MiB), but measured peak is null everywhere because there is no GPU and no nvidia-smi here; Ollama runs CPU-only (size_vram 0). The predicted-vs-measured delta rendering and the 15% check need one sweep on the 5070 host; nothing was waved off, there is simply no measurement to compare on this box.
- Progress lines write through console.log; a downstream head/SIGPIPE kills the process mid-run, which the journal absorbs by design (it became an accidental extra crash test). Not treating EPIPE specially in v0.1.

## Phase 3 (report, recommendation, CLI completion, docs)

- Terminal comparison table shows the quality mean with its repetition spread inline; TTFT and tok/s show medians only there (width budget), with full min..max spreads in the markdown report. Spread accompanies every mean; medians carry spread where space allows.
- Pareto eligibility: status completed, every completed unit passed every gate, quality present. OOM and failed candidates are excluded with their reason and surface as runners-up/nearest misses instead.
- Pareto dominance treats a missing measurement (unmeasured VRAM) as incomparable on that axis: it can neither dominate nor be dominated through it. Exact ties all stay on the frontier.
- Recommendation tolerance is relative (quality >= best x (1 - tolerance)), default 0.02, boundary inclusive; validated to [0, 1) with a fix hint.
- When any within-tolerance candidate lacks a measured peak, all of them are ranked by weights on disk instead, and the recommendation sentence says so; mixing measured and proxy footprints in one ordering would be dishonest.
- Footprint tie-breaks: quality, then tok/s, then model name, so the pick is deterministic.
- ZIP writer and reader implemented in-repo against the documented format (deflate via node:zlib), same supply-chain rationale as the GGUF reader; archives are timestamped with the run start so identical runs export byte-identical bundles.
- Bundle "config" is the plan snapshot plus generation params inside run.json, not a copy of the config file: the file can drift after the run, and the fingerprints in the snapshot detect exactly that.
- Bundle carries scoring.json (scorer, params, gates, expected values) so verifyBundle can re-score raw outputs with no access to the original machine; omitted when the pack drifted, and verification then refuses loudly.
- No stored scorer versions: the report command re-scores every retained output whenever the pack fingerprint still matches, swaps in fresh values, and notes how many changed. Pack drift or an unloadable pack falls back to stored scores with a note. Comparing values beats trusting a version string.
- report --out with both --markdown and --bundle applies to the markdown file; the bundle keeps its derived name (one flag, two outputs, the markdown is the more commonly redirected).
- run/resume keep the per-candidate detail blocks and append the comparison table plus recommendation at the end; report renders the compact view only.
- models command previews fit at context 4096 by default (--context overrides) and says a sweep uses the pack's declared context.
- init placeholders carry a replace_me key that example-loader rejects unconditionally with a replace-and-delete-the-key message; a scaffolded pack cannot run until real examples exist.
- init prompts state their defaults; --yes or a non-TTY stdin accepts defaults silently, flags bypass prompts entirely. Scaffolds exist for all five scorers, with schema.json written only where a schema is referenced.
- Terminal prose lines (recommendation, flags, reasons) wrap at 100 columns in the renderer; only table rows rely on column layout.
- Phase 3 live gates, partial by request (local runs paused mid-session): sweep interrupted after the 27b OOM result and 19 qwen3:14b units; report rendered the partial journal honestly, bundle exported from it re-scored 19/19 outputs to identical values (verifyBundle 0 mismatches), python zipfile read the archive clean. Full-sweep skeptic-read gate and all VRAM gates remain; checklist in docs/local-verification.md under "Phase 3 report layer".
- A bundle exported from a cwd where the run's relative packDir does not resolve omits scoring.json by design (the drift check cannot pass); observed live, worth knowing before exporting from outside the repo root.
- Git history rewritten (author and committer on every commit) to moonrunnerkc <bradkinnard@proton.me>: the desktop had been committing as root@VivoBookBrads.(none), which GitHub attributes to nobody.

## Release hardening

- Dependency review at release: npm audit reports zero vulnerabilities across the tree. npm ls flags six wasm shims (emnapi, napi-rs, tslib) extraneous; npm prune retains them because the eslint import resolver's optional wasm fallback wants them. Dev-only, not in the published package (files whitelist is dist), dispositioned as harmless. Runtime deps stay at four, each chosen once: commander (arg parsing with subcommands and typed options, no hand-rolled argv), yaml (the maintained YAML 1.2 parser, eemeli's), ajv (pack-declared JSON Schemas only), better-sqlite3 (synchronous transactions fit the per-unit journal exactly). Dev-side, vitest was picked in phase 0 for native ESM and typed test contexts; no entry existed for it or commander/yaml until now, which this line closes.
- field-f1 now throws on a non-object expected value instead of scoring 0 forever; plan-check provokes every scorer authoring throw (params and expected types) before any inference by dry-scoring an empty output per example, and run/resume/validate all refuse with the full problem list.
- Journal write failures (disk full, db turned read-only) translate to free-space-or-fix guidance ending in the resume command; store open wraps corrupt-file and unwritable-path errors the same way.
- Concurrency guard: a lock row inside the results db (pid, command, start time) makes a second quantproof process refuse politely; a holder whose pid is dead is stale and taken over silently. Pid-recycling misclassification is possible and accepted: the failure mode is one spurious refusal message, not corruption.
- SIGINT during a sweep prints that completed units are journaled plus the exact resume command, releases the lock, and exits 130; the in-flight generation is discarded by design (the journal is transactional per unit).
- Sweeps estimated over an hour warn at plan time with --limit and resume pointers; the estimate itself was already printed, the warning makes the sequential-by-design cost explicit.
- VRAM timelines decimate at 4096 samples (halving resolution each time the cap is hit) while the peak tracks the raw stream, so no spike is ever lost to downsampling; documented in methodology.
- Test honesty pass found no vi.mock and no was-called-only assertions anywhere; the two spy usages silence console output or assert prompting behavior. One defect fixed: a zip test named for an independent-implementation check it did not perform now actually shells out to python3 zipfile.

## Anthropic API backend

- Design intent: this backend exists for GPU-free validation and CI (the e2e suite runs on it), and later becomes the frontier-baseline comparison feature (local quants versus a Claude model on the same pack). It is the one feature addition of the release-hardening pass.
- Built on @anthropic-ai/sdk rather than raw HTTP, deviating from the build plan's "no LLM SDKs" line: the SDK's default retry policy is byte-for-byte the required design (429 backoff honoring retry-after, transient 5xx twice, invalid requests never), and typed errors plus streaming helpers beat hand-rolled SSE for a supply-chain cost of one first-party dependency.
- Backend selection lives in the run config (backend: ollama | anthropic); a stored run carries it in backendVersion, which is how resume reconnects to the same backend and how renderers label API runs. The anthropic backend demands an explicit candidates list; use_local_models is rejected there because sweeping the whole API catalog by default would be an expensive surprise.
- API model descriptors carry sizeBytes 0 and the model id as digest: no local weights exist, and the id is the version pin the API exposes. sizeBytes 0 doubles as the no-local-footprint marker the recommendation checks.
- Recommendation on API runs ranks gate-passing candidates on quality, then throughput, and says so in the reason; fit renders not-applicable (a fourth verdict, distinct from unknown), VRAM cells render n/a, and API runs skip GPU identity, VRAM probing, and inter-candidate cooldowns entirely (polling the local GPU during an API run would measure the wrong machine).
- Seed and context sizing have no Messages API equivalent and are recorded as not-applicable in each generation's request options; a model that rejects temperature gets exactly one retry without it, recorded the same way. Determinism is still checked byte-for-byte across repetitions and flagged with backend-neutral wording.
- Key hygiene: ANTHROPIC_API_KEY only, read at client construction, never placed in records; tests assert the journal database and exported bundles contain no key material, and the missing-key error carries the exact export command.
- Token spend per generation comes from the API's usage counts and every sweep prints the total at the end (also true for ollama runs, whose eval counts were already journaled).
- e2e suites gate themselves: the ollama slice skips with a notice when no local Ollama answers, the API suite skips when ANTHROPIC_API_KEY is absent, so forks and keyless machines stay green.

## Deferred

- Word-number parsing ("forty-two") for numeric-tolerance.
- README, docs/task-packs.md, docs/methodology.md: phase 3/4 deliverables per the build plan.
- Empty component directories (catalog, backends, telemetry, orchestrator, results, report) exist locally but hold no stubs; files appear when their phase does.
