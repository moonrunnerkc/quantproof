# quantproof: Complete Build Plan

Working name: **quantproof** (verify GitHub/npm/PyPI availability before first push; "quantfit" is taken on PyPI, "llmfit" and "modelfit" are taken by static fit-calculators).

One-sentence value: point it at a folder of your real task examples and it tells you which quantized model actually handles them on your hardware, with measured quality, latency, and VRAM.

---

## 1. What This Is

Every existing "which local model should I run" tool answers with math or leaderboards. llmfit and whichllm compute whether weights plus KV cache fit in VRAM. LocalScore measures tokens/sec on synthetic prompts. lm-eval-harness runs academic benchmarks that don't resemble anyone's actual workload. None of them run your tasks. The question people actually have ("will Q4_K_M mangle my invoice extraction or is it fine?") is answerable only by running the extraction on Q4_K_M and checking, and nobody has packaged that loop.

quantproof is a CLI that does exactly that loop:

1. You write a small task pack: 20 to 50 real examples of the work you need done, each with a machine-checkable expected result.
2. It enumerates candidate models and quants (starting from what's already pulled in Ollama), predicts which ones fit your GPU, and runs your examples against each candidate, one model at a time.
3. While running, it measures actual peak VRAM, time-to-first-token, and throughput, not estimates.
4. It scores outputs deterministically (schema conformance, field accuracy, label match), never vibes.
5. It emits a report: a quality/VRAM/latency table, a Pareto frontier, and one recommendation ("smallest quant within 2% of best measured quality").

What it is not: not an inference engine (it orchestrates Ollama and later llama-server), not a leaderboard, not a benchmark suite, not an eval framework for cloud LLM apps (promptfoo's territory), not a VRAM calculator (llmfit's territory).

## 2. End Goals

Primary: become the default answer to "which quant should I actually run for X" on r/LocalLLaMA and adjacent communities. The output artifact (the report table) should be so shareable that users post their own results unprompted, the way people post LocalScore numbers today.

Measurable targets, in order:

- Week 1: launch case study published, repo public, 100+ stars (matches the current success metric).
- Month 1: at least 5 result reports posted by people who are not Brad, at least 3 community task packs contributed.
- Month 3: "quantproof pack" is a recognized format; a shared results site or pinned megathread aggregates community runs.

Strategic goal behind those numbers: the durable asset is not the runner, which is copyable, it's the task-pack format plus the corpus of reproducible results. If task packs become how the local-LLM community expresses "my workload," the tool that defined the format keeps the center of gravity even after competitors add similar features. This is the moat whichllm's static database can't cross without becoming a different product.

Reproducibility is a first-class end goal, not a feature. Every run produces a self-contained result bundle (task pack hash, model digest, quant, sampler params, seed, backend version, driver, GPU, raw outputs, scores). Anyone with the same GPU class can re-run and compare. This is the same instinct as Counterfactual Court's verdict bundles applied to model selection, and it's what separates "some guy's table on Reddit" from citable data.

## 3. Positioning Boundaries

Rules that protect the launch, taken from the viability gate:

- Never publish a comparison table against whichllm, llmfit, promptfoo, or lm-eval-harness at v0.1. The README earns attention through its own case study.
- Never frame determinism-only scoring as superior to LLM-as-judge. It's a scoping decision for trustworthy v0.1 results; say exactly that when asked.
- The launch deliverable is one case study, not a feature list. README stays under 50 lines.
- If asked "why not promptfoo," the honest answer: promptfoo can be configured to approximate 60% of this; quantproof exists because model-pull orchestration, VRAM measurement, OOM handling, and the recommendation layer are the hard 40% nobody wants to hand-roll in YAML.

## 4. Hard Design Principles

These decide every ambiguous call during implementation:

1. **Measured beats predicted.** Fit prediction exists only to decide what's worth attempting. Every number in a report comes from an actual run. Where prediction and measurement disagree, the report shows both, because publishing prediction error builds trust that static calculators can't.
2. **OOM is data, not failure.** A model that crashes the runner at your context length is a result ("Q6_K: does not run at 8k context on 12GB") and appears in the report as such. The orchestrator must survive backend crashes and resume the sweep.
3. **Deterministic scoring only in v0.1.** Every scorer is a pure function from output to score. No LLM-as-judge until there's traction, because judge bias would be the first credibility attack on launch day, and because a local judge model competes for the VRAM under test.
4. **Sequential isolation.** One model loaded at a time, forced unload between candidates, cooldown gap, warmup run before timed runs. Concurrent evaluation on one GPU corrupts both the VRAM and latency measurements. Slower and correct beats fast and noisy.
5. **Variance is reported, never hidden.** Each example runs N times (default 3) at temperature 0 with a fixed seed where the backend honors it. Score spread and latency spread appear in the report. A single-number summary hides exactly the instability users need to know about.

## 5. Architecture

Eight components, each independently testable, communicating through plain data records. No framework, no plugin system in v0.1, no daemon. A run is a batch process with a resumable journal.

### 5.1 Task loader

Parses a task pack directory into validated task definitions and examples. A task pack declares the task type, the scorer and its parameters, generation parameters (context length, max tokens, temperature, seed), and a set of examples (input plus expected). Validation is strict and errors say what's wrong and how to fix it, because task packs are the community-facing surface and sloppy error messages here kill contributions.

Rationale for a directory format over a single config file: examples are data, they belong in versionable individual files people can diff and PR. This is also what makes packs shareable units.

Illustrative task pack manifest (data format, not code):

```yaml
# tasks/invoice-extraction/task.yaml
name: invoice-extraction
type: extraction
scorer: field-f1
scorer_params:
  schema: ./schema.json      # JSON Schema the output must satisfy
  key_fields: [vendor, total, due_date]
generation:
  context: 4096
  max_tokens: 512
  temperature: 0
  seed: 42
  runs_per_example: 3
prompt_template: ./prompt.md   # {{input}} placeholder
examples_dir: ./examples       # one JSON file per example: { input, expected }
```

### 5.2 Model catalog and resolver

Builds the candidate list. Source one: models already present in the local Ollama store (zero-friction path, most of the audience has half a dozen pulled already). Source two: an explicit candidate list in the run config (model plus quant tags), pulled on demand through Ollama. Reads GGUF metadata (architecture, layer count, head config, quant type, file size) for the fit predictor. Deliberately not building a Hugging Face browser or downloader in v0.1; Ollama's registry already solves distribution and reimplementing it is wrapper syndrome in reverse.

### 5.3 Fit predictor

Estimates whether a candidate fits before spending minutes loading it: weights size from the GGUF file, KV cache estimated from layer count, KV head count, head dimension, declared context length, and cache element size, plus a fixed overhead allowance for compute buffers. Compares against free VRAM at run start. Deliberately conservative; a false "fits" costs a crash cycle, a false "doesn't fit" only requires a `--force` flag to override. After each run, records predicted versus measured peak, and the report includes the delta. Over time this produces the dataset that makes the predictor honest, which is itself publishable content.

### 5.4 Backend adapters

A minimal adapter interface: ensure model available, load, generate (streaming, so TTFT is measurable), unload, report backend version. v0.1 ships one adapter: Ollama over its local HTTP API, using keep_alive zero on the final request per model to force unload. v0.2 adds llama-server for users who want explicit offload-layer control; the adapter boundary exists from day one so this is additive.

Rejected alternative: driving llama.cpp directly via bindings. It maximizes control but triples the build time, drags native compilation into the install story, and the audience already runs Ollama. Bindings can come later if precision demands it.

Known limitation to document, not solve, in v0.1: Ollama controls its own GPU offload decisions, so a "fits partially" model may silently run split across CPU and GPU. The telemetry catches this (throughput collapses, VRAM plateaus below prediction) and the report flags suspected partial offload rather than pretending the number is a clean GPU result.

### 5.5 Telemetry probes

Two probes, both passive observers of a run. The VRAM probe polls NVML (or nvidia-smi as fallback) at a couple hundred milliseconds during load and generation, recording the peak and the timeline. The timing probe wraps the streaming generation call: time-to-first-token, tokens per second post-first-token, wall time. Warmup generation per model is mandatory and untimed, which absorbs load-time compilation and cache effects. v0.1 is NVIDIA-only and says so plainly in the README; Apple Silicon (unified memory makes "fits" a different question) and AMD come post-traction. Cutting hardware breadth is what keeps launch within weeks.

### 5.6 Scorers

Pure functions, one file each, registered by name:

- `json-schema`: output parses as JSON and satisfies the declared schema (binary plus a violations list).
- `field-f1`: per-field comparison against expected, normalized (whitespace, case, number formats), reported as precision/recall/F1 over key fields. The workhorse for extraction.
- `exact-label`: classification with a declared label set and alias normalization.
- `contains` / `regex`: presence checks for constrained generation tasks.
- `numeric-tolerance`: numbers within declared tolerance, for calculation-ish tasks.

Composability: a task declares one primary scorer plus optional gate scorers (example: must pass json-schema, then field-f1 determines quality). Summarization, open QA, and style tasks are explicitly out of scope for v0.1 because they can't be scored deterministically; the docs say "wait for judge mode" rather than shipping a bad proxy metric like ROUGE.

### 5.7 Orchestrator

Owns the run lifecycle: expand (task pack x candidates x examples x repetitions) into a work plan, execute sequentially per model, journal every completed unit to the results store immediately, and resume from the journal after a crash, including the backend dying from OOM. Handles retry policy narrowly: transport errors retry twice, OOM never retries at the same configuration (it's a result). Enforces the isolation rules from principle 4. This is deliberately boring code, and it's where Swarm Orchestrator experience pays directly.

### 5.8 Results store and reporting

Store: SQLite, one file per project under `.quantproof/`. Chosen over JSONL because the report queries are relational (aggregate across repetitions, join runs to models to tasks) and because resume logic wants transactional writes. Every raw model output is retained, because re-scoring past runs with an improved scorer without re-running inference is a feature (scorers version independently of runs).

Reporting: three renderers off the same result records. Terminal table for the daily loop. Markdown report for sharing (this is the case-study artifact, so its layout gets real design attention: results table, Pareto summary, recommendation with reasoning, environment block, reproduction command). Result bundle (zip of report, raw outputs, run metadata) for reproducibility claims. Recommendation logic: filter candidates that pass all gate scorers, compute the quality/VRAM/latency Pareto frontier, recommend the smallest-VRAM candidate within a configurable tolerance (default 2%) of best measured quality, and say why in one sentence.

## 6. Run Lifecycle (Happy Path and Failure Paths)

Happy path: `quantproof run` loads the task pack, resolves candidates, fit-predicts, prints the plan (what will run, what's skipped as too big, rough time estimate), then per candidate: pull if needed, load, warmup, run all examples x repetitions with probes attached, force unload, cooldown, journal. At the end, score, aggregate, render, print the recommendation.

Failure paths: backend crash mid-model marks remaining units for that model as OOM-suspect and moves on; the resume command re-attempts only unfinished non-OOM work. Ollama unreachable fails fast at plan time with the exact command to fix it. An example whose expected file fails validation aborts before any inference, listing every invalid example at once instead of one per run. VRAM probe unavailable (no NVML) degrades to a run without memory measurements, loudly marked as such in the report, never silently.

## 7. Tech Stack and Rationale

**Language: TypeScript on Node 22.** The deciding factor is shipping speed under a closing window; this is Brad's highest-velocity stack, the existing engineering standards (named exports, kebab-case, 300-line cap, JSDoc, real-behavior tests) apply without translation, and the tool is process orchestration plus HTTP plus arithmetic, nothing that needs Python's ML ecosystem. Tradeoff acknowledged: the r/LocalLLaMA contributor base skews Python, so some drive-by contributions are lost. Mitigation: the community contribution surface is task packs (YAML and JSON, language-neutral), not core code.

**Distribution: npm, npx-first.** `npx quantproof run` with zero global install is the demo command. Single-binary builds (bun compile or pkg) are a fast follow for the no-Node crowd, not a launch blocker.

**Dependencies, deliberately few:** a CLI arg parser, a JSON Schema validator (ajv), a YAML parser, better-sqlite3, a GGUF metadata reader (small enough to implement in-repo against the documented format if no solid library exists, which also removes a supply-chain dependency). No LLM SDKs at all in v0.1; the Ollama API is plain HTTP.

**Testing:** scorers get exhaustive table-driven tests (they're the trust surface). Orchestrator tested against a fake adapter that simulates OOM, slow streams, and crashes, per the "never mock the thing you're testing" rule: the adapter interface is the boundary, so a fake on the far side of it is legitimate. One end-to-end smoke test against real Ollama with a tiny model (qwen-class 0.5B) runs in CI on a self-hosted runner or is documented as a local-only gate.

## 8. File Structure

```
quantproof/
├── README.md                      # under 50 lines; the case study leads
├── LICENSE                        # MIT
├── package.json
├── tsconfig.json
├── docs/
│   ├── task-packs.md              # pack format spec, the community surface
│   ├── methodology.md             # how measurement works, honestly, incl. limits
│   └── decisions.md               # running ADR log
├── examples/
│   ├── invoice-extraction/        # starter pack: field-f1 + schema gate
│   ├── ticket-classification/     # starter pack: exact-label
│   └── config-generation/         # starter pack: json-schema + regex gates
├── src/
│   ├── cli/
│   │   ├── main.ts                # entry, command routing only
│   │   ├── command-run.ts
│   │   ├── command-resume.ts
│   │   ├── command-report.ts
│   │   ├── command-models.ts      # list candidates + fit predictions
│   │   └── command-init.ts        # scaffold a task pack interactively
│   ├── tasks/
│   │   ├── task-schema.ts         # pack manifest validation
│   │   ├── task-loader.ts
│   │   └── example-loader.ts
│   ├── catalog/
│   │   ├── model-resolver.ts      # ollama store + explicit candidates
│   │   ├── gguf-metadata.ts
│   │   └── fit-predictor.ts
│   ├── backends/
│   │   ├── backend-adapter.ts     # interface + shared types
│   │   └── ollama-adapter.ts
│   ├── telemetry/
│   │   ├── vram-probe.ts          # NVML/nvidia-smi polling
│   │   └── timing-probe.ts        # TTFT, tokens/sec, wall time
│   ├── scoring/
│   │   ├── scorer-registry.ts
│   │   ├── json-schema-scorer.ts
│   │   ├── field-f1-scorer.ts
│   │   ├── exact-label-scorer.ts
│   │   ├── pattern-scorer.ts      # contains + regex
│   │   ├── numeric-tolerance-scorer.ts
│   │   └── normalize.ts           # shared text/number normalization
│   ├── orchestrator/
│   │   ├── run-planner.ts         # expansion + fit filtering + estimates
│   │   ├── run-executor.ts        # sequential execution, isolation rules
│   │   └── recovery.ts            # journal-based resume, OOM classification
│   ├── results/
│   │   ├── run-store.ts           # sqlite persistence
│   │   ├── record-types.ts
│   │   └── bundle.ts              # reproducibility bundle export
│   └── report/
│       ├── aggregate.ts           # stats, variance, pareto frontier
│       ├── recommend.ts
│       ├── terminal-report.ts
│       └── markdown-report.ts
└── tests/
    ├── scoring/                   # table-driven, exhaustive
    ├── tasks/
    ├── catalog/
    ├── orchestrator/              # fake-adapter crash/OOM simulations
    └── e2e/                       # real-ollama smoke, tiny model
```

Every file honors the 300-line cap; the components were cut at boundaries where that's natural. Nothing exports a default.

## 9. Build Sequence

Total target: repo public with case study inside 3 weeks. The window analysis says white space in this ecosystem closes in one to two quarters, and whichllm plus promptfoo are each one decision away from this feature.

**Phase 0, days 1 to 2: scoring core.** Task schema, loaders, all five scorers, normalization, full test tables. Gate: identical inputs produce identical scores across 1,000 repeated invocations, and every starter-pack example scores correctly against hand-computed expected values. Nothing else starts until scoring is unimpeachable, because scoring is what the project's credibility rests on.

**Phase 1, days 3 to 6: single-model vertical slice.** Ollama adapter, both probes, executor without planning (one hardcoded model), SQLite store. Gate: one command runs the invoice pack against one local model on the 5070 and produces a terminal table with quality, TTFT, tokens/sec, and measured peak VRAM that matches nvidia-smi eyeballing.

**Phase 2, days 7 to 11: the sweep.** GGUF metadata, fit predictor, planner, resume/recovery, forced unload and cooldown, OOM classification. Gate: a 10+ candidate sweep survives an induced OOM mid-run, resumes correctly, and the predicted-vs-measured VRAM deltas land within 15% on models that fully offload.

**Phase 3, days 12 to 15: the report.** Aggregation, variance, Pareto, recommendation, markdown renderer, bundle export, `init` scaffolding, docs (methodology.md gets written honestly here, including the partial-offload caveat). Gate: the markdown report is something you'd post without editing it.

**Phase 4, days 16 to 21: case study and launch.** Run the real study: 3 task packs, 10 to 14 quant/model combinations across two or three families (current Gemma, Qwen, DeepSeek distills) on the RTX 5070. The target headline is whatever the data actually shows; the expected shape, based on existing quant-quality research (llama.cpp's own KL-divergence measurements, the "Q4 is usually fine" folk wisdom this tool exists to test), is something like "the leaderboard-recommended quant was beatable at half the VRAM on 2 of 3 tasks, and Q3 collapsed on structured output while staying fine on classification." If the data is boring, the honest boring result still launches; fabricating a spicy headline is banned by standing content rules. README is the case study plus install plus one command. Launch surface: r/LocalLLaMA post presenting the results (the tool rides along), Show HN a few days later, dev.to methodology write-up after that.

Phases 0 and 1 can overlap by a day (adapter work doesn't touch scoring). Phase 4's model pulling can start during Phase 3.

## 10. Post-Traction Roadmap (v0.2+, only if launch validates)

Ordered by expected leverage: llama-server adapter with explicit offload control (turns partial-offload from caveat into measured dimension). Judge mode as an optional scorer type using a large local model, clearly labeled, never the default, with judge-vs-deterministic agreement stats shown. Community task-pack index (a repo of packs before it's ever a website). Apple Silicon support via unified-memory-aware fit logic. Context-length sweep mode (same model, quality-vs-context curve, which the KV cache math makes interesting on 12GB cards). A results-aggregation site only if organic sharing volume demands it.

## 11. Risk Register

- **whichllm adds real inference.** Highest-probability competitive risk (4.8k stars, owns the search phrase). Mitigation: speed to launch, and the task-pack format as the part that's hard to bolt on. Static-tool users are also quantproof users; positioning stays complementary in all public communication.
- **promptfoo publishes a "local model comparison" recipe.** They already have the guide; a polished recipe covers the middle of the market. Mitigation: the measured-VRAM/OOM/recommendation layer is outside their architecture's interest; stay focused there.
- **Ollama API or store format changes.** Moderate likelihood, low damage: the adapter boundary contains it, and keep_alive semantics are the only subtle dependency.
- **Measurement credibility attack** ("your latency numbers are noise," "VRAM polling misses transients"). Mitigation is methodology.md: document polling resolution, warmup policy, variance reporting, and known blind spots before anyone else points them out. First-mover honesty is cheap armor.
- **GGUF metadata inconsistency across model families** breaks the fit predictor on exotic architectures. Mitigation: predictor failure degrades to "unknown, attempt with --force," never blocks a run.
- **The case study data is dull.** Real risk, embrace it: "we measured and the folk wisdom holds" is still a citable result and the tool's value is re-running the question on your workload, not the headline.

## 12. Definition of Done for v0.1.0

One command from clean machine to recommendation: install Ollama, `npx quantproof init`, add examples, `npx quantproof run`. Three starter packs. Scorer suite fully tested. Sweep survives OOM. Report is share-ready. Methodology documented with limits stated. README under 50 lines led by the case study. No comparison tables against anyone. NVIDIA-only, stated plainly. Everything else is v0.2.
