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
- `npm run test:e2e` — pending (below).

## 2. Metal determinism

Pending (below).
