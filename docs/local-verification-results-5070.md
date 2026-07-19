# Local verification results: RTX 5070 desktop (Linux, 12 GB)

End-to-end verification of the full three-step flow (ingest, run,
report) on NVIDIA hardware, 2026-07-19. This run closes the VRAM
measurement gates that [local-verification-results-mac.md](local-verification-results-mac.md)
left open ("the VRAM measurement gates remain for the RTX 5070 box").

## Environment

- NVIDIA GeForce RTX 5070, 12227 MiB, driver 590.48.01, Linux 6.8.0
- Node v22.16.0 via nvm (system node is 20)
- Ollama 0.15.2, server local at :11434
- Models: llama3.1:latest (Q4_K_M), llama3.1:8b-instruct-q4_0 (Q4_0),
  gemma3:4b (pulled on demand by the sweep config), gemma3:1b (pulled
  by the e2e suite)

## 1. Cross-platform smoke

- `npm ci`: clean, 0 vulnerabilities; better-sqlite3 compiled natively.
- `npm run typecheck`, `npm run lint`: clean.
- `npm test`: **637/637 passed** (57 files). Three tests that simulate
  CPU-only boxes initially failed on this machine because they left the
  real `/dev/nvidia0` device check active; each now injects
  `nvidiaDevicePaths: []` like its sibling tests, and the fix is what
  makes the suite hardware-independent rather than the suite being
  waved through.
- `npm run test:e2e`: Ollama slice **passed** against the live server
  (pulls gemma3:1b); the Anthropic and Rapid-MLX suites self-skipped
  with their designed notices (no key, no server).

## 2. VRAM measurement gates: CLOSED

First live verification of the nvidia-smi path end to end. Every
candidate in every sweep recorded a measured peak with a timeline, and
predicted-versus-measured deltas rendered in every report surface:

| candidate                 | predicted MiB | measured MiB | delta  |
|---------------------------|---------------|--------------|--------|
| llama3.1:latest           | 6229          | 5774         | -7.3%  |
| llama3.1:8b-instruct-q4_0 | 5981          | 5472         | -8.5%  |
| gemma3:4b                 | 4752          | 4231         | -11.0% |
| gemma3:1b                 | 1906          | 1479         | -22.4% |

Three of four land within the 15% band from the phase 2 gate. The
gemma3:1b overshoot matches the Mac finding (18 to 20% under on the
same model): the fixed 1024 MiB compute allowance dominates the
prediction for sub-1B models, a deliberate conservative bias, now
measured on two platforms. Isolation also verified: VRAM polled back
to baseline between candidates, no inflated-measurement warnings.

## 3. Three-step flow, end to end

`quantproof ingest ~/Downloads/recurring-tasks.md` drafted a five-label
classification pack (exact-label over the document's own cadence
categories) with llama3.1:latest as the auto-picked drafter (largest
local model whose fit verdict is "fits" at the drafting context).

- First ingest exposed a real gap: the drafted prompt never named the
  label set, every model invented its own categories, and the whole
  sweep scored 0.000. Root cause fixed in parseDraft (an exact-label
  draft whose prompt is missing any declared label now fails validation
  and enters the repair rounds) rather than treated as a bad day.
- Re-ingest after the fix: the new check fired on all three attempts,
  llama3.1 never complied as a drafter, and the salvage path wrote the
  pack anyway with the exact error printed. That is the designed
  degradation from build plan 5.9, observed live.
- Human review step: fixed the salvaged prompt by hand and corrected 1
  of 22 drafter-authored expected values against the source document
  (the first draft had 2 of 18 wrong). This is the drafter-agreement
  risk the provenance label exists for, demonstrated on a real document.
- Sweep: 4 candidates x 22 examples x 3 reps = **264/264 units
  completed, 0 failed**, gemma3:4b pulled on demand by the config.
  Report and recommendation in [e2e-5070-report.md](e2e-5070-report.md);
  every surface carried the drafted-pack provenance label.
- Bundle: exported and re-scored from bundle contents alone, **264/264
  identical, 0 mismatches**; python zipfile reads the archive clean.

## 4. CUDA determinism: the nondet flag earns its keep

Seeded temperature-0 repetitions are NOT byte-identical on this
CUDA stack (ollama 0.15.2, driver 590.48.01): llama3.1 (both quants)
and gemma3:4b each produced differing outputs across repetitions of
identical requests, flagged nondet in every report surface; gemma3:1b
was byte-identical throughout. Observed concretely: one example
answered "As needed" on rep 1 and "Weekly" on reps 2 and 3. On the Mac
the same check passed on every candidate (Metal, 240+ units). This is
the exact backend property methodology.md warns about, and the reason
the check runs every time instead of being trusted once. Note the
backend here is older (0.15.2); whether current Ollama behaves better
on CUDA is unmeasured until this box is upgraded.

## Verdict

Install, build, unit, and e2e suites green on Linux/NVIDIA; the
nvidia-smi measurement path is verified live end to end; the ingest,
run, report flow works on a real freeform document including the
repair, salvage, and provenance paths; bundles reproduce exactly. One
product fix (exact-label prompt coverage in parseDraft) and one test
fix (device-path injection) came out of the run, both committed with
tests.
