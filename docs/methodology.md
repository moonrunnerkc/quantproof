# Methodology

How quantproof measures, and where it is blind. The limits come first
because they decide how much to trust any number in a report.

## Limits and blind spots

Read these before citing a quantproof report.

- **VRAM polling can miss transients.** The probe runs `nvidia-smi
  --query-gpu=memory.used -lms 200`, so the recorded peak is the
  highest 200 ms sample. Allocation spikes shorter than the polling
  interval (transient compute buffers, fragmentation churn) can exceed
  the reported peak. Treat "peak VRAM" as a floor on the true peak,
  accurate to the polling interval, not an allocator trace.
- **NVIDIA only.** Measurements come from nvidia-smi. On machines
  without it (no GPU, AMD, Apple Silicon), runs still execute but every
  VRAM figure is reported as "not measured", never estimated. Apple
  Silicon's unified memory makes "fits in VRAM" a different question;
  quantproof does not pretend to answer it yet.
- **Ollama decides GPU offload, not quantproof.** A model that does not
  fully fit may silently run split across CPU and GPU. The report flags
  *suspected* partial offload with a stated reason when either signal
  fires: measured peak under 60% of the prediction on a completed
  candidate, or median tokens/sec under 25% of the best similar-size
  candidate (0.5x to 2x the weights). The heuristic needs a prediction
  or size peers to fire, so a lone unpredictable model can run split
  without being flagged. A flag is a suspicion with its reasoning, not
  a measurement.
- **TTFT includes everything before the first token.** Time to first
  token is measured from sending the HTTP request to the first streamed
  chunk, so it includes connection overhead, queueing, and prompt
  evaluation. That is the latency a user actually feels, but it is not
  a pure decode metric, and it scales with prompt length.
- **Tokens/sec is stream-chunk rate after the first token.** Computed
  as (chunks - 1) / time between first and last chunk. Ollama streams
  roughly one token per chunk, so this tracks decode rate closely, but
  it is not derived from the backend's own eval counters (those are
  recorded in the result store for cross-checking).
- **Determinism is verified, not assumed.** Every example runs N times
  (default 3) at temperature 0 with a fixed seed. Outputs are compared
  byte for byte per example; the report says either "outputs identical
  across repetitions" or flags nondeterminism loudly. Seed handling is
  backend- and hardware-specific: byte-identical repeats were verified
  live on Ollama 0.23.1 on CPU and on Apple Metal, but a backend or
  driver update can change this, which is exactly why the check runs
  every time instead of being trusted once.
- **OOM classification is pattern-based and deliberately a suspicion.**
  Ollama reports load failures generically, so "model failed to load
  ... resource limitations" on a memory-starved machine is classified
  oom-suspect. A crash with the same signature but a different root
  cause would be misclassified. OOM candidates are results ("does not
  run at this context on this hardware"), never retried at the same
  configuration, and never silently dropped from the report.
- **Deterministic scoring only.** Every scorer is a pure function from
  output to score: schema conformance, field comparison, label match,
  pattern presence, numeric tolerance. This is a scoping decision for
  trustworthy v0.1 results, not a claim that deterministic scoring is
  superior to judged evaluation. Tasks that need judgment
  (summarization quality, open QA, style) are out of scope rather than
  approximated with a proxy metric.
- **Fit prediction is intentionally conservative.** Predicted peak =
  weights on disk + KV cache (blocks x kv_heads x (key_len + value_len)
  x context x 2 bytes, f16) + a fixed 1024 MiB compute allowance;
  "fits" additionally demands the result stay within 95% of free VRAM
  at plan time. A false "does not fit" costs a `--force` flag; a false
  "fits" costs a crash cycle. Every report shows predicted versus
  measured so the prediction error is public.

## How a run works

1. **Plan.** The task pack is validated (every problem reported at
   once), candidates are resolved from the local Ollama store or an
   explicit config, architecture metadata is read from the API or the
   GGUF header, and each candidate gets a fit verdict. The plan prints
   before anything runs.
2. **Isolate.** Candidates run strictly one at a time. Before each
   candidate: VRAM baseline sample. After each: forced unload
   (keep_alive 0), a poll until memory returns to within 256 MiB of
   baseline (or a loud warning after 15 s), then a 3 s cooldown.
   Concurrent evaluation on one GPU corrupts both VRAM and latency
   numbers; slower and correct wins.
3. **Warm up.** One untimed generation per model absorbs load-time
   compilation and cache effects before anything is measured.
4. **Measure.** Every example x repetition streams through the timing
   probe while the VRAM probe samples in the background. The complete
   raw output, timings, request options, and score are journaled to
   SQLite in one transaction per unit; a crash mid-run loses nothing
   that finished, and `quantproof resume` continues from the journal.
5. **Score.** The primary scorer runs on every output; gate scorers
   (for example json-schema before field-f1) zero the unit score on
   failure while the primary's raw score stays visible in details.
6. **Report.** Means come with their spread across repetitions,
   medians with their min..max. Gate-passing candidates compete on the
   quality/VRAM/throughput Pareto frontier, and the recommendation is
   the smallest peak VRAM within 2% (configurable) of the best measured
   quality. Raw outputs are retained, so reports re-score past runs
   with current scorers and say so when values changed.

## Reproducing someone else's numbers

`quantproof report --bundle` exports a zip with the report, every raw
output, all scores, the run metadata (model digests, sampler params,
backend version, GPU, pack fingerprint), and the scoring inputs. The
scores in a bundle can be recomputed from its own raw outputs without
the original machine; hardware-dependent numbers (VRAM, latency) need
the same GPU class to compare fairly.
