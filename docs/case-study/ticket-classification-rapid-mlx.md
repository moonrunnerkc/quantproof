# quantproof: ticket-classification on Apple M5 Max unified memory

Measured results of running the ticket-classification task pack against 1 local model via rapid-mlx 0.6.0. Scores are deterministic (scorer: exact-label); no numbers below are estimates unless labeled as predictions.

## Environment

- Date: 2026-07-18
- GPU: Apple M5 Max unified memory, driver macOS 26.5.1
- Backend: rapid-mlx 0.6.0
- Task pack: ticket-classification (scorer exact-label), fingerprint `aafe948cdd07`
- Generation: context 2048, max_tokens 16, temperature 0, seed 42, 3 runs per example

| model | quant | params | weights MiB | digest |
| --- | --- | --- | ---: | --- |
| qwen3-coder:30b-a3b | - | - | - | `qwen3-coder:30b-a3b` |

## Results

| model | quant | quality (spread) | pass | TTFT ms (spread) | tok/s (spread) | peak memory MiB | predicted MiB (delta) | flags |
| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |
| qwen3-coder:30b-a3b | ? | 0.900 | 90.0% | 63 (61..67) | 101.8 (97.0..104.3) | 27576 | - |  |

## Pareto frontier

Non-dominated on quality, peak memory, and median tokens/sec, among gate-passing candidates:

- **qwen3-coder:30b-a3b**: quality 0.900, 27576 MiB, 101.8 tok/s

## Recommendation

**qwen3-coder:30b-a3b**. qwen3-coder:30b-a3b has the best measured quality (0.900) and the smallest footprint (27576 MiB peak memory) among the candidates within the quality tolerance.


## Methodology

Each example ran 3 times at temperature 0 with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. Memory is polled during load and generation (resident backend process memory on Apple Silicon); the peak is the highest sample. Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).

## Reproduce

```
quantproof run --pack examples/ticket-classification --config quantproof.rapid-mlx.yaml
```
