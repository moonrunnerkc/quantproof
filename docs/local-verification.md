# Local verification: what still needs a live machine

Two verified platforms: the Apple Silicon M5 Max (64 GB unified
memory) and the Linux RTX 5070 desktop (12 GB, nvidia-smi path), which
is the current dev machine. The Anthropic API backend is parked: it
stays in the code and its tests, but local backends (Ollama,
Rapid-MLX) are the focus and no API key is required for anything
below.

## Setup

```bash
git clone git@github.com:moonrunnerkc/quantproof.git && cd quantproof
# Node 22+ (nvm use 22). better-sqlite3 compiles natively on install.
npm install && npm run build
npm test            # unit suite, no Ollama needed
npm run test:e2e    # needs Ollama running and pulls gemma3:1b (815 MB)
```

## Verified on the Mac (2026-07-16 and 2026-07-17)

Full detail in
[local-verification-results-mac.md](local-verification-results-mac.md).
Summary: install/build/unit/e2e green on macOS, Metal determinism
holds on every candidate tested, full uninterrupted multi-candidate
sweeps complete, SIGINT-mid-sweep resume journals every unit exactly
once, and full-run bundles re-score from bundle contents alone with
zero mismatches. Memory columns read "not measured" on the Mac today;
that is the designed degradation until unified-memory measurement
lands.

## Closed gates (2026-07-17, live on the M5 Max)

1. **Unified-memory measurement: closed.** The probe samples backend
   process RSS on Apple Silicon; a live sweep reported gemma3:1b at a
   1511 MiB peak against a 1854 MiB prediction, and the approach was
   validated against Ollama's own accounting (runner RSS 14.4 GiB vs
   /api/ps 14.1 GiB for an 11 GB model). Fit verdicts are real on the
   Mac now (75% unified-memory budget).
2. **Rapid-MLX backend adapter: closed.** Verified against the live
   0.6.0 instance: streaming, usage counts, cache clearing, and memory
   from the server's Metal accounting (26.8 GiB peak for the served
   30B, where process RSS misleadingly reads 1.3 GiB). Reports label
   the backend in every row and environment line.

## Closed gate (2026-07-17, same day)

**Backend comparison study: closed.** Three packs times three models
across both backends on the M5 Max, 540 scored generations, zero
failed units. Summary in the README case study; the six full reports
are in [docs/case-study/](case-study/), reproducible from the two
config files at the repo root.

## Closed gates (2026-07-19, live on the RTX 5070)

Full detail in
[local-verification-results-5070.md](local-verification-results-5070.md).

1. **NVIDIA VRAM measurement: closed.** First live run of the
   nvidia-smi path: measured peaks on every candidate, predicted
   versus measured deltas of -7.3% to -11.0% on the 4B and 8B models
   (inside the phase 2 gate's 15% band) and -22.4% on gemma3:1b, the
   same deliberate conservative bias the Mac measured on that model.
2. **Three-step flow on a real document: closed.** ingest, review,
   run, report, bundle, all verified end to end, including the repair
   rounds, the salvage path, and the provenance label on every report
   surface. 264/264 units completed; the bundle re-scored identically
   from its own contents.
3. **CUDA determinism finding:** seeded temperature-0 repetitions are
   not byte-identical on this stack (ollama 0.15.2, driver 590.48.01)
   for llama3.1 and gemma3:4b; gemma3:1b held. The nondet flag caught
   and labeled it in every surface, which is the designed behavior.

## Not needed anywhere

- Kill/resume: verified live repeatedly (SIGKILL, SIGPIPE, SIGINT);
  the journal held every unit exactly once each time.
- OOM classification: verified live with a 17 GB model on a 15 GB
  machine; recorded as a result and the sweep continued.
- Seed determinism: verified byte-identical on CPU inference and on
  Metal (four models, 240+ scored units, zero nondeterministic
  repetitions).
