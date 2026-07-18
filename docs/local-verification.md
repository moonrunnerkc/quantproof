# Local verification: what still needs a live machine

The primary platform is Apple Silicon (dev machine: M5 Max, 64 GB
unified memory). The NVIDIA/nvidia-smi measurement path stays in the
code for Linux users, but nothing is gated on NVIDIA hardware anymore.
The Anthropic API backend is parked: it stays in the code and its
tests, but local backends (Ollama, Rapid-MLX) are the focus and no API
key is required for anything below.

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

## Not needed anywhere

- Kill/resume: verified live repeatedly (SIGKILL, SIGPIPE, SIGINT);
  the journal held every unit exactly once each time.
- OOM classification: verified live with a 17 GB model on a 15 GB
  machine; recorded as a result and the sweep continued.
- Seed determinism: verified byte-identical on CPU inference and on
  Metal (four models, 240+ scored units, zero nondeterministic
  repetitions).
