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

## Open gates (Mac, in build order)

1. **Unified-memory measurement.** A Mac-native memory probe behind
   the existing probe interface, so "peak memory" is measured on Apple
   Silicon instead of marked unmeasured, and the fit predictor compares
   against free unified memory. Gate: a sweep's reported peak is in the
   same ballpark as external observation (Activity Monitor or
   `footprint`/`vm_stat` sampling) while a model generates.
2. **Rapid-MLX backend adapter.** OpenAI-compatible local server on
   MLX (http://localhost:8000/v1). Gate: the same pack sweeps both
   backends and the report labels each candidate's backend honestly;
   verify streaming TTFT, token counts, and determinism behavior
   against the live instance, not documentation memory.
3. **Backend comparison study.** Same models, same pack, Ollama versus
   Rapid-MLX on the M5 Max: the Mac case study for the README.

## Not needed anywhere

- Kill/resume: verified live repeatedly (SIGKILL, SIGPIPE, SIGINT);
  the journal held every unit exactly once each time.
- OOM classification: verified live with a 17 GB model on a 15 GB
  machine; recorded as a result and the sweep continued.
- Seed determinism: verified byte-identical on CPU inference and on
  Metal (four models, 240+ scored units, zero nondeterministic
  repetitions).
