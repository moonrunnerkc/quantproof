# quantproof: invoice-extraction on Apple M5 Max unified memory

Measured results of running the invoice-extraction task pack against 2 local models via ollama 0.24.0. Scores are deterministic (scorer: field-f1); no numbers below are estimates unless labeled as predictions.

## Environment

- Date: 2026-07-18
- GPU: Apple M5 Max unified memory, driver macOS 26.5.1
- Backend: ollama 0.24.0
- Task pack: invoice-extraction (scorer field-f1), fingerprint `a5b2e967dd8b`
- Generation: context 4096, max_tokens 512, temperature 0, seed 42, 3 runs per example

| model | quant | params | weights MiB | digest |
| --- | --- | --- | ---: | --- |
| gemma4:e4b-it-q8_0 | Q8_0 | 8.0B | 11097 | `9dcc35808b42` |
| gemma3:1b | Q4_K_M | 999.89M | 778 | `8648f39daa8f` |

## Results

| model | quant | quality (spread) | pass | TTFT ms (spread) | tok/s (spread) | peak memory MiB | predicted MiB (delta) | flags |
| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |
| gemma4:e4b-it-q8_0 | Q8_0 | 0.000 | 0.0% | 6909 (6902..6980) | 68.1 (68.1..68.2) | 12506 | 12793 (-2.2%) | [a] [b] |
| gemma3:1b | Q4_K_M | 0.150 | 15.0% | 147 (136..173) | 246.2 (239.1..248.6) | 1526 | 1906 (-19.9%) | [c] |

- [a] gemma4:e4b-it-q8_0: failed gate scorers (json-schema on 60 of 60 completed units); gate failures zero the unit score and exclude the candidate from the frontier and the recommendation
- [b] gemma4:e4b-it-q8_0: 57 of 60 completed units hit the max_tokens budget before emitting any visible output; those scores measure truncation, not task quality; raise generation.max_tokens in task.yaml
- [c] gemma3:1b: failed gate scorers (json-schema on 51 of 60 completed units); gate failures zero the unit score and exclude the candidate from the frontier and the recommendation

## Pareto frontier

Empty: no candidate passed all gate scorers.

## Recommendation

None. no candidate passed all gate scorers, so nothing is recommendable on this task. Nearest misses:

- gemma3:1b: failed gate scorers: json-schema (51 units)
- gemma4:e4b-it-q8_0: failed gate scorers: json-schema (60 units)

## Methodology

Each example ran 3 times at temperature 0 with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. Memory is polled during load and generation (resident backend process memory on Apple Silicon); the peak is the highest sample. Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).

## Reproduce

```
quantproof run --pack examples/invoice-extraction --config quantproof.yaml
```
