# quantproof: ticket-classification on Apple M5 Max unified memory

Measured results of running the ticket-classification task pack against 2 local models via ollama 0.24.0. Scores are deterministic (scorer: exact-label); no numbers below are estimates unless labeled as predictions.

## Environment

- Date: 2026-07-18
- GPU: Apple M5 Max unified memory, driver macOS 26.5.1
- Backend: ollama 0.24.0
- Task pack: ticket-classification (scorer exact-label), fingerprint `aafe948cdd07`
- Generation: context 2048, max_tokens 16, temperature 0, seed 42, 3 runs per example

| model | quant | params | weights MiB | digest |
| --- | --- | --- | ---: | --- |
| gemma4:e4b-it-q8_0 | Q8_0 | 8.0B | 11097 | `9dcc35808b42` |
| gemma3:1b | Q4_K_M | 999.89M | 778 | `8648f39daa8f` |

## Results

| model | quant | quality (spread) | pass | TTFT ms (spread) | tok/s (spread) | peak memory MiB | predicted MiB (delta) | flags |
| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |
| gemma4:e4b-it-q8_0 | Q8_0 | 0.950 | 95.0% | 167 (154..206) | 75.3 (69.1..77.5) | 12335 | 12457 (-1.0%) |  |
| gemma3:1b | Q4_K_M | 0.800 | 80.0% | 149 (133..169) | 217.6 (103.9..277.4) | 1514 | 1854 (-18.3%) |  |

## Pareto frontier

Non-dominated on quality, peak memory, and median tokens/sec, among gate-passing candidates:

- **gemma4:e4b-it-q8_0**: quality 0.950, 12335 MiB, 75.3 tok/s
- **gemma3:1b**: quality 0.800, 1514 MiB, 217.6 tok/s

## Recommendation

**gemma4:e4b-it-q8_0**. gemma4:e4b-it-q8_0 has the best measured quality (0.950) and the smallest footprint (12335 MiB peak memory) among the candidates within the quality tolerance.

- gemma3:1b: quality 0.800 is 15.8% below the best 0.950, outside the tolerance

## Methodology

Each example ran 3 times at temperature 0 with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. Memory is polled during load and generation (resident backend process memory on Apple Silicon); the peak is the highest sample. Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).

## Reproduce

```
quantproof run --pack examples/ticket-classification --config quantproof.yaml
```
