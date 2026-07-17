# Local verification results: MacBook (Apple M5 Max, 64 GB)

Execution of the macOS section of [local-verification.md](local-verification.md),
2026-07-16.

## Environment

- Apple M5 Max, 64 GB unified memory, macOS (Darwin 25.5.0)
- Node v26.0.0 (doc requires 22+)
- Ollama 0.24.0, server local at :11434
- Models used: gemma3:1b (e2e smoke), gemma4:31b (determinism check —
  substituted for the doc's qwen3:14b; already local, 19 GB, fits the
  "64 GB lets you check a big model fast" intent)

## 1. Cross-platform smoke

- `npm install` — clean, 189 packages, 0 vulnerabilities.
  better-sqlite3 compiled natively on macOS without issue.
- `npm run build` — tsc clean, no errors.
- `npm test` — **399/399 passed** (32 files, 3.27s). Matches the
  documented count exactly.
- `npm run test:e2e` — **1/1 passed** (5.71s) against live Ollama with
  gemma3:1b. Validates the blob-store default (`~/.ollama/models`) and
  the full run pipeline on macOS.

## 2. Metal determinism — PASS

```
node dist/cli/main.js run --pack examples/invoice-extraction --limit 3 --model gemma4:31b
```

(gemma4:31b Q4_K_M substituted for the doc's qwen3:14b — bigger model,
already local.)

- **`determinism   outputs identical across repetitions`** — the gate.
  The nondeterminism path did not fire on Metal; no methodology.md
  caveat needed.
- `peak vram NOT MEASURED: nvidia-smi is not available...` and
  `fit prediction unknown` — the designed macOS degradation, exactly as
  documented. Not a bug.
- quality 1.000, pass rate 100%, 9/9 units completed, 0 failed.
- ttft median 14052 ms, 24.0 tokens/sec median, predicted peak
  35333 MiB (unverifiable here; VRAM gates stay on the 5070).
- env: ollama 0.24.0 | gemma4:31b@6316f0629137 | Q4_K_M | seed 42,
  temp 0, ctx 4096, 3 reps.
