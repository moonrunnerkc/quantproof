# quantproof: config-generation on Apple M5 Max unified memory

Measured results of running the config-generation task pack against 1 local model via rapid-mlx 0.6.0. Scores are deterministic (scorer: json-schema); no numbers below are estimates unless labeled as predictions.

## Environment

- Date: 2026-07-18
- GPU: Apple M5 Max unified memory, driver macOS 26.5.1
- Backend: rapid-mlx 0.6.0
- Task pack: config-generation (scorer json-schema), fingerprint `74bf35fa2794`
- Generation: context 2048, max_tokens 256, temperature 0, seed 42, 3 runs per example

| model | quant | params | weights MiB | digest |
| --- | --- | --- | ---: | --- |
| qwen3-coder:30b-a3b | - | - | - | `qwen3-coder:30b-a3b` |

## Results

| model | quant | quality (spread) | pass | TTFT ms (spread) | tok/s (spread) | peak memory MiB | predicted MiB (delta) | flags |
| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |
| qwen3-coder:30b-a3b | ? | 1.000 | 100.0% | 66 (64..127) | 99.9 (94.6..100.5) | 29573 | - |  |

## Pareto frontier

Non-dominated on quality, peak memory, and median tokens/sec, among gate-passing candidates:

- **qwen3-coder:30b-a3b**: quality 1.000, 29573 MiB, 99.9 tok/s

## Recommendation

**qwen3-coder:30b-a3b**. qwen3-coder:30b-a3b has the best measured quality (1.000) and the smallest footprint (29573 MiB peak memory) among the candidates within the quality tolerance.


## Methodology

Each example ran 3 times at temperature 0 with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. Memory is polled during load and generation (resident backend process memory on Apple Silicon); the peak is the highest sample. Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).

## Reproduce

```
quantproof run --pack examples/config-generation --config quantproof.rapid-mlx.yaml
```
