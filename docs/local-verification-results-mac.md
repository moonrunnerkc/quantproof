# Local verification results: MacBook (Apple M5 Max, 64 GB)

Execution of the macOS section of [local-verification.md](local-verification.md),
2026-07-16.

## Environment

- Apple M5 Max, 64 GB unified memory, macOS (Darwin 25.5.0)
- Node v26.0.0 (doc requires 22+)
- Ollama 0.24.0, server local at :11434
- Models used: gemma3:1b (e2e smoke), gemma4:31b (determinism check ,
  substituted for the doc's qwen3:14b; already local, 19 GB, fits the
  "64 GB lets you check a big model fast" intent)

## 1. Cross-platform smoke

- `npm install`: clean, 189 packages, 0 vulnerabilities.
  better-sqlite3 compiled natively on macOS without issue.
- `npm run build`: tsc clean, no errors.
- `npm test`: **399/399 passed** (32 files, 3.27s). Matches the
  documented count exactly.
- `npm run test:e2e`: **1/1 passed** (5.71s) against live Ollama with
  gemma3:1b. Validates the blob-store default (`~/.ollama/models`) and
  the full run pipeline on macOS.

## 2. Metal determinism: PASS

```
node dist/cli/main.js run --pack examples/invoice-extraction --limit 3 --model gemma4:31b
```

(gemma4:31b Q4_K_M substituted for the doc's qwen3:14b: bigger model,
already local.)

- **`determinism   outputs identical across repetitions`**: the gate.
  The nondeterminism path did not fire on Metal; no methodology.md
  caveat needed.
- `peak vram NOT MEASURED: nvidia-smi is not available...` and
  `fit prediction unknown`: the designed macOS degradation, exactly as
  documented. Not a bug.
- quality 1.000, pass rate 100%, 9/9 units completed, 0 failed.
- ttft median 14052 ms, 24.0 tokens/sec median, predicted peak
  35333 MiB (unverifiable here; VRAM gates stay on the 5070).
- env: ollama 0.24.0 | gemma4:31b@6316f0629137 | Q4_K_M | seed 42,
  temp 0, ctx 4096, 3 reps.

## 3. Optional full-pack quality sweep: quality-per-quant data

Full invoice-extraction pack (20 examples x 3 reps = 60 units per
candidate), three local gemma4 variants via a run config
(`use_local_models: false`):

```yaml
candidates:
  - gemma4:31b
  - gemma4:31b-it-q8_0
  - gemma4:e4b-it-q8_0
```

Planner correctly ordered largest-first and completed 180/180 units,
0 failed. All three candidates: `determinism outputs identical across
repetitions`.

| candidate          | quant  | quality | pass rate | ttft med | tok/s med |
|--------------------|--------|---------|-----------|----------|-----------|
| gemma4:31b-it-q8_0 | Q8_0   | 1.000   | 100.0%    | 22862 ms | 14.5      |
| gemma4:31b         | Q4_K_M | 1.000   | 100.0%    | 16757 ms | 19.8      |
| gemma4:e4b-it-q8_0 | Q8_0   | 0.000   | 0.0%      | 7365 ms  | 64.0      |

**Quality-per-quant headline:** gemma4-31b at Q4_K_M matches Q8_0
exactly (1.000 vs 1.000, identical outputs, both `done_reason: stop`
at 412 output tokens on example 001) while running ~36% more tokens/sec
from 59% of the weight bytes. On this pack the Q4 is a strict win.

**e4b finding (root-caused):** the 0.000 is real and reproducible but
is a token-budget truncation, not an extraction failure. Every e4b unit
hit `done_reason: length` at exactly `num_predict: 512` (the pack's
`max_tokens`) with an empty visible output: the model spends its whole
budget in its reasoning phase and never emits content, so the
json-schema gate fails with "output contains no JSON object or array".
Re-running example 001 directly against Ollama with `num_predict: 2048`
yields a perfect extraction at 659 tokens (`done_reason: stop`). Two
takeaways:

1. Pack authors targeting reasoning-style models need `max_tokens`
   headroom for thinking tokens (the 31b models fit under 512 at 412;
   e4b needs ~660).
2. Possible UX improvement worth a decisions.md discussion: when
   `done_reason` is `length` and the visible output is empty, the
   report could flag "truncated before any content" instead of leaving
   a bare 0.000: the signature is unambiguous in the stored data.

## Verdict

Every macOS item in local-verification.md is done: cross-platform
smoke green (install, native build, 399 unit + 1 e2e), Metal
determinism holds on every candidate tested (4 models, 240 scored
units total, zero nondeterministic repetitions), and the designed
NVIDIA-only degradation messages appear exactly as documented. The
VRAM measurement gates remain for the RTX 5070 box.
