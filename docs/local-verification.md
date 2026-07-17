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
