# quantproof: config-generation on Apple M5 Max unified memory

Measured results of running the config-generation task pack against 2 local models via ollama 0.24.0. Scores are deterministic (scorer: json-schema); no numbers below are estimates unless labeled as predictions.

## Environment

- Date: 2026-07-18
- GPU: Apple M5 Max unified memory, driver macOS 26.5.1
- Backend: ollama 0.24.0
- Task pack: config-generation (scorer json-schema), fingerprint `74bf35fa2794`
- Generation: context 2048, max_tokens 256, temperature 0, seed 42, 3 runs per example

| model | quant | params | weights MiB | digest |
| --- | --- | --- | ---: | --- |
| gemma4:e4b-it-q8_0 | Q8_0 | 8.0B | 11097 | `9dcc35808b42` |
| gemma3:1b | Q4_K_M | 999.89M | 778 | `8648f39daa8f` |

## Results

| model | quant | quality (spread) | pass | TTFT ms (spread) | tok/s (spread) | peak memory MiB | predicted MiB (delta) | flags |
| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |
| gemma4:e4b-it-q8_0 | Q8_0 | 1.000 | 100.0% | 155 (149..235) | 67.2 (63.0..75.1) | 12434 | 12457 (-0.2%) |  |
| gemma3:1b | Q4_K_M | 0.750 | 75.0% | 144 (140..166) | 243.9 (232.4..249.5) | 1520 | 1854 (-18.0%) | [a] |

- [a] gemma3:1b: failed gate scorers (pattern on 15 of 60 completed units); gate failures zero the unit score and exclude the candidate from the frontier and the recommendation

## Pareto frontier

Non-dominated on quality, peak memory, and median tokens/sec, among gate-passing candidates:

- **gemma4:e4b-it-q8_0**: quality 1.000, 12434 MiB, 67.2 tok/s

## Recommendation

**gemma4:e4b-it-q8_0**. gemma4:e4b-it-q8_0 has the best measured quality (1.000) and the smallest footprint (12434 MiB peak memory) among the candidates within the quality tolerance.

- gemma3:1b: failed gate scorers: pattern (15 units)

## Methodology

Each example ran 3 times at temperature 0 with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. Memory is polled during load and generation (resident backend process memory on Apple Silicon); the peak is the highest sample. Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).

## Reproduce

```
quantproof run --pack examples/config-generation --config quantproof.yaml
```
