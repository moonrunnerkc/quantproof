# quantproof

CLI that runs a user's real task examples against local quantized models
via Ollama, measures quality, latency, and peak VRAM, and recommends the
smallest quant that holds quality. Full spec: docs/build-plan.md. That
file wins every disagreement. Log deviations in docs/decisions.md with a
one-line reason.

## Environment
- Current dev and measurement machine: Linux desktop with an NVIDIA
  RTX 5070 (12 GB, nvidia-smi path). The Apple Silicon M5 Max (64 GB
  unified memory) remains a verified platform; results from it live in
  docs/local-verification-results-mac.md and the case study.
- Rapid-MLX (OpenAI-compatible, MLX) applies on the Mac only; when
  working there it may be serving at http://localhost:8000/v1, verify
  against the live instance.
- Node 22, TypeScript strict
- Ollama running at http://localhost:11434 with a small model pulled.
  Verify API behavior against the live instance; do not trust memory of
  the Ollama API. When live behavior differs from an assumption, follow
  live behavior and record it in docs/decisions.md.

## Engineering standards (non-negotiable)
- TypeScript strict mode. The word "any" does not appear as a type. Use
  unknown plus narrowing where needed.
- Named exports only. No default exports anywhere.
- Kebab-case filenames.
- 300-line hard cap per file. Approaching the cap means decompose, not
  compress.
- Full JSDoc on every exported function and type: purpose, params,
  returns, and failure behavior.
- DRY at three repetitions, not before. SOLID applied pragmatically.
- Error messages state what failed AND what to do about it, including
  the exact command to run when one exists.
- Every function has at least one test. Test names describe behavior.
  Tests validate real behavior, never wiring. Never mock the module
  under test. The backend adapter interface is the legitimate fake
  boundary: a fake adapter simulating OOM, crashes, and slow streams is
  correct; mocking a scorer to test a scorer is not.
- Code must read human-written: intentional names, no boilerplate
  comments narrating obvious lines, no scaffold comments left behind,
  comments only where the why is not obvious from the code.
- No em dashes in any output: code, comments, docs, commit messages,
  error strings. Use commas, colons, or parentheses.

## Working rules
- Do not ask the user questions. Make the call, log it in
  docs/decisions.md (one line per decision: what, why), and keep moving.
- Do not stop at partial completion. A prompt's acceptance gate is the
  only definition of done.
- Before declaring done: npm run typecheck, npm run lint, npm test all
  pass clean, then re-read the gate checklist and verify each item
  honestly.
- Never commit unless asked. The user commits at gates.
- Scope discipline: build exactly what the current prompt covers.
  Anything tempting but out of scope goes in docs/decisions.md under a
  "deferred" heading instead of into the code.
