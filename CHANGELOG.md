# Changelog

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
