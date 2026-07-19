# Changelog

## 0.1.1 (2026-07-19)

The three-step flow: ingest, run, report.

- `quantproof ingest <file>`: a local model drafts a complete runnable
  pack (name, scorer, prompt, 20+ examples with expected values) from a
  freeform document, re-validated by the same strict loader as
  hand-written packs, with bounded repair rounds and a salvage path
  that writes a failing draft anyway with its errors printed. Drafted
  packs carry a provenance block (source hash, drafting model, date,
  reviewed flag), and every report surface labels results from an
  unreviewed draft. Scoring never involves the drafting model.
- exact-label drafts must name every declared label in the prompt; a
  draft that does not is rejected into the repair rounds instead of
  producing a sweep where models invent their own categories and
  everything scores zero (found by a live end-to-end run).
- Memory measured everywhere: probe selection checks the hardware at
  run start and always lands on an honest source. NVIDIA GPUs via
  nvidia-smi, Apple Silicon via summed backend process RSS (validated
  against Ollama's own accounting), Rapid-MLX via the server's Metal
  accounting at /v1/status, and any other box with a readable
  /proc/meminfo via backend RSS with the fit budget from MemAvailable.
  An NVIDIA device without nvidia-smi refuses to measure rather than
  passing RSS off as VRAM. Fit verdicts on GPU-less boxes come from
  real available memory.
- Rapid-MLX backend (`backend: rapid-mlx`): sweeps against a local
  OpenAI-compatible MLX server, prompt cache cleared before every
  generation so latency measures fresh inference.
- Truncation flagged: a completed unit that spends its whole
  max_tokens budget without emitting visible output is marked in every
  renderer with the fix named (raise generation.max_tokens), instead
  of rendering as a bare 0.000.
- Case study (README and docs/case-study/): three packs, two backends,
  540 scored generations on an M5 Max; NVIDIA path verified live on an
  RTX 5070 (predicted-versus-measured deltas published).

## 0.1.0 (2026-07-16)

First release.

- Task packs: a directory format for real task examples with
  machine-checkable expected values, validated in one pass with
  per-file fixes; `quantproof init` scaffolds one interactively.
- Five deterministic scorers (json-schema, field-f1, exact-label,
  pattern, numeric-tolerance) with gate composition; authoring errors
  (bad params, mismatched expected types) die at plan time, before any
  inference.
- Sequential sweep orchestrator over local Ollama models: fit
  prediction from GGUF metadata, one model loaded at a time with forced
  unload and cooldown, per-unit transactional journaling in SQLite,
  OOM classified as a result and never retried, resume from the
  journal with pack/config drift detection, a process lock against
  concurrent sweeps, and a SIGINT notice pointing at resume.
- Measurements: peak VRAM via nvidia-smi polling (bounded timeline,
  raw-stream peak), time to first token, tokens/sec, wall time, score
  spread across repetitions, byte-level output determinism checks, and
  a suspected partial-offload flag with its reasoning.
- Reports: terminal comparison table, a shareable markdown report
  (environment block, results with spreads, Pareto frontier over
  quality/VRAM/throughput, recommendation with runners-up, methodology
  link, exact reproduction command), and a zip bundle from which every
  score can be recomputed from the raw outputs alone.
- Anthropic API backend (`backend: anthropic`): the same packs against
  Claude models over the streaming Messages API, quality and latency
  measured with no GPU, VRAM/fit labeled not-applicable, token spend
  totaled per sweep, and reports labeled so API tables cannot be
  mistaken for local measurements.
- Three starter packs: invoice-extraction, ticket-classification,
  config-generation.
