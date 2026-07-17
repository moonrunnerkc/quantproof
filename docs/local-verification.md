# Local verification: what still needs a real machine

Everything below is what could not be verified in the dev sandbox
(which has no GPU: no driver, no nvidia-smi, Ollama running CPU-only).
Unit and e2e suites are green; these are the measurement gates.

## Setup on either machine

```bash
git clone git@github.com:moonrunnerkc/quantproof.git && cd quantproof
# Node 22+ (nvm use 22). better-sqlite3 compiles natively on install.
npm install && npm run build
npm test            # 399 tests, no Ollama needed
npm run test:e2e    # needs Ollama running and pulls gemma3:1b (815 MB)
```

## RTX 5070 box: the gates that matter (NVIDIA-only by design)

These close the open items from the phase 1 and phase 2 acceptance
gates. Have `nvidia-smi` on PATH and Ollama running.

1. Pull a size ladder that brackets the 12 GB card:

```bash
ollama pull gemma3:1b && ollama pull qwen3:4b && ollama pull qwen3:14b
```

2. Run a sweep and watch the plan:

```bash
node dist/cli/main.js run --pack examples/ticket-classification --limit 2
```

Check, in order:

- **Fit filter fires for real.** The plan should show real `fits` /
  `does-not-fit` verdicts (not `unknown`) because free VRAM is now
  sampled. Anything predicted over ~95% of free VRAM gets skipped with
  a reason and a `--force` hint.
- **Peak VRAM sanity (phase 1 gate).** While a model is generating, run
  `nvidia-smi` in another terminal and eyeball memory.used against the
  `peak vram` line in the final table. Same ballpark = pass.
- **Predicted vs measured within 15% (phase 2 gate).** Each completed
  candidate's table prints `X MiB peak measured (predicted Y MiB,
  delta Z%)`. For models that fully offload, |Z| <= 15 passes. If any
  fully-offloaded model misses, do not shrug it off: paste the table
  into a decisions.md entry and we will chase the discrepancy (likely
  suspects: compute buffer allowance, KV cache element size if Ollama
  is using q8 cache, or other processes holding VRAM at plan time).
- **Partial-offload flag.** Force a too-big model and confirm the
  heuristic fires with its reasoning rather than reporting a clean
  GPU number:

```bash
node dist/cli/main.js run --pack examples/ticket-classification --limit 2 --model qwen3:14b
# 14b predicts ~10.2 GiB at ctx 2048; if it splits, throughput collapses
# and the table should show SUSPECTED CPU/GPU SPLIT with the numbers.
```

- **Isolation baseline.** Between candidates the sweep polls VRAM back
  toward the pre-load baseline. If you ever see the "did not return to
  baseline" warning, note what else was using the GPU.

3. Send back: the full terminal output of the sweep (plan + tables) and
   one `nvidia-smi` snapshot taken mid-generation. That is enough to
   write the remaining decisions.md entries and mark gate 4 closed.

## Phase 3 report layer: what remains after the 2026-07-16 session

Everything code-side of phase 3 is done, tested (495 unit tests), and
pushed: aggregation with spreads, Pareto frontier, recommendation,
terminal comparison table, markdown report, bundle export with
re-score verification, and the report / models / init commands, plus
docs (methodology.md, task-packs.md, README skeleton).

Verified live in the sandbox on 2026-07-16 (CPU-only Ollama 0.23.1):

- Stranger path end to end minus inference: `init --yes` scaffolded a
  pack, placeholders failed validation with the replace-me messages,
  edited examples validated clean.
- `models` listed the 5-model local ladder with predictions, excluded
  the 4 cloud entries, and said plainly why every verdict is unknown
  without nvidia-smi.
- A live sweep was started and deliberately interrupted mid-candidate
  (gemma3-27b OOM-classified as a result, qwen3:14b 19 units
  journaled). `report` rendered the partial journal honestly, and
  `report --bundle` exported a zip whose 19 raw outputs re-scored to
  identical values from the bundle contents alone (verifyBundle: 0
  mismatches). Python's zipfile independently read the archive with no
  corrupt entries, so the in-repo zip writer interoperates.

Still open, needs a machine with time on it (either box for the first
two, the 5070 for anything involving VRAM columns):

1. **Full uninterrupted sweep + skeptic read (phase 3 acceptance gate
   2).** `node dist/cli/main.js run --pack examples/ticket-classification`
   over the full local ladder, then `node dist/cli/main.js report
   --markdown` and read the file top to bottom as a skeptical stranger
   before calling it postable. The interrupted journal from 2026-07-16
   is still in `.quantproof/results.db` on the dev sandbox; `resume`
   will finish exactly the pending 4 candidates if run there.
2. **Bundle gate at full scale (gate 3).** From the completed run:
   `report --bundle`, then re-score check, e.g.
   `node --input-type=module -e "import {readFileSync} from 'node:fs'; const {verifyBundle} = await import('./dist/results/bundle.js'); console.log(verifyBundle(readFileSync('<bundle.zip>')))"`.
   Expect 0 mismatches.
3. **Everything in the RTX 5070 section above**, unchanged, now with
   the bonus that the markdown report renders the predicted-vs-measured
   delta column that only exists once VRAM is measurable.

Known content note for the eventual case study: qwen3 models score 0
on ticket-classification because they spend the 16-token budget on
`<think>` output instead of a bare label. That is an honest result
(the pack demands a bare label), worth a sentence in the writeup, and
a good example of what gate scorers surface.

## MacBook M5 64GB: useful, but not the gates

quantproof v0.1 is NVIDIA-only (stated in the build plan; Apple Silicon
is post-traction roadmap because unified memory changes what "fits"
means). On the Mac every table will read
`peak vram NOT MEASURED: nvidia-smi is not available...` and fit
verdicts will be `unknown`. That is the designed degradation, not a
bug. What the Mac run actually tells us:

1. **Cross-platform smoke.** `npm install && npm test && npm run
   test:e2e` on macOS validates the native better-sqlite3 build, the
   blob-store fallback path (`~/.ollama/models` is the right default on
   macOS), and the whole pipeline on a second OS.
2. **Metal determinism (worth having).** The nondeterminism path has
   never fired in live testing. 64 GB lets you check a big model fast:

```bash
ollama pull qwen3:14b
node dist/cli/main.js run --pack examples/invoice-extraction --limit 3 --model qwen3:14b
```

   The `determinism` line should read "outputs identical across
   repetitions". If it ever reads NONDETERMINISTIC on Metal, that is a
   finding worth a decisions.md entry and a methodology.md caveat,
   since plenty of the target audience runs Macs and will re-run packs
   there.
3. **Optional: real quality data.** A full-pack sweep
   (`--config` with a few models, no `--limit`) runs fast on the M5 and
   gives usable quality-per-quant numbers, but latency and memory
   numbers from the Mac do not feed the case study; that stays on the
   5070.

## Not needed anywhere

- Kill/resume: verified live twice (SIGKILL mid-candidate and an
  unplanned SIGPIPE mid-resume); journal held every unit exactly once.
- OOM classification: verified live with a 17 GB model on a 15 GB
  machine; recorded as a result and the sweep continued.
- Seed determinism on CUDA-less CPU inference: verified byte-identical
  within and across runs.
