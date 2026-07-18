# quantproof: invoice-extraction on Apple M5 Max unified memory

Measured results of running the invoice-extraction task pack against 1 local model via rapid-mlx 0.6.0. Scores are deterministic (scorer: field-f1); no numbers below are estimates unless labeled as predictions.

## Environment

- Date: 2026-07-18
- GPU: Apple M5 Max unified memory, driver macOS 26.5.1
- Backend: rapid-mlx 0.6.0
- Task pack: invoice-extraction (scorer field-f1), fingerprint `a5b2e967dd8b`
- Generation: context 4096, max_tokens 512, temperature 0, seed 42, 3 runs per example

| model | quant | params | weights MiB | digest |
| --- | --- | --- | ---: | --- |
| qwen3-coder:30b-a3b | - | - | - | `qwen3-coder:30b-a3b` |

## Results

| model | quant | quality (spread) | pass | TTFT ms (spread) | tok/s (spread) | peak memory MiB | predicted MiB (delta) | flags |
| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |
| qwen3-coder:30b-a3b | ? | 1.000 | 100.0% | 64 (63..191) | 100.4 (72.4..101.4) | 28754 | - | [a] |

- [a] qwen3-coder:30b-a3b: outputs differed across repetitions; the backend did not produce repeatable output for identical requests

## Pareto frontier

Non-dominated on quality, peak memory, and median tokens/sec, among gate-passing candidates:

- **qwen3-coder:30b-a3b**: quality 1.000, 28754 MiB, 100.4 tok/s

## Recommendation

**qwen3-coder:30b-a3b**. qwen3-coder:30b-a3b has the best measured quality (1.000) and the smallest footprint (28754 MiB peak memory) among the candidates within the quality tolerance.


## Methodology

Each example ran 3 times at temperature 0 with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. Memory is polled during load and generation (resident backend process memory on Apple Silicon); the peak is the highest sample. Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).

## Reproduce

```
quantproof run --pack examples/invoice-extraction --config quantproof.rapid-mlx.yaml
```
