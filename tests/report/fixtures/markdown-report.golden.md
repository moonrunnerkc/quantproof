# quantproof: invoice-extraction on NVIDIA GeForce RTX 5070

Measured results of running the invoice-extraction task pack against 5 local models via ollama 0.23.1. Scores are deterministic (scorer: field-f1); no numbers below are estimates unless labeled as predictions.

## Environment

- Date: 2026-07-16
- GPU: NVIDIA GeForce RTX 5070, driver 580.65.06
- Backend: ollama 0.23.1
- Task pack: invoice-extraction (scorer field-f1), fingerprint `pack-fp`
- Generation: context 4096, max_tokens 512, temperature 0, seed 42, 3 runs per example

| model | quant | params | weights MiB | digest |
| --- | --- | --- | ---: | --- |
| qwen3:14b | Q4_K_M | 14.8B | 8846 | `qwen314b0123` |
| gemma3:4b | Q4_K_M | 4.3B | 3184 | `gemma34b0123` |
| gemma3:1b | Q4_K_M | 999.89M | 778 | `gemma31b0123` |
| gemma3-27b-q4:latest | Q4_K_M | 27.4B | 16785 | `gemma327bq4l` |
| qwen3:8b-split | Q4_K_M | 8.2B | 4959 | `qwen38bsplit` |

## Results

| model | quant | quality (spread) | pass | TTFT ms (spread) | tok/s (spread) | peak VRAM MiB | predicted MiB (delta) | flags |
| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |
| qwen3:14b | Q4_K_M | 0.917 (0.900..0.930) | 100.0% | 640 (512..811) | 10.4 (9.8..11.2) | 10190 | 10000 (+1.9%) |  |
| gemma3:4b | Q4_K_M | 0.905 (0.900..0.910) | 100.0% | 231 (198..268) | 25.2 (24.1..26.0) | 4212 | 4000 (+5.3%) |  |
| gemma3:1b | Q4_K_M | 0.310 (0.290..0.330) | 31.0% | 250 (220..280) | 41.7 (39.7..43.7) | 1854 | 1900 (-2.4%) | [a] |
| gemma3-27b-q4:latest | Q4_K_M | - | - | - | - | not measured | 18447 | [b] |
| qwen3:8b-split | Q4_K_M | 0.899 (0.890..0.910) | 100.0% | 250 (220..280) | 3.1 (1.1..5.1) | 5100 | 9000 (-43.3%) | [c] |

- [a] gemma3:1b: failed gate scorers (json-schema on 4 of 6 completed units); gate failures zero the unit score and exclude the candidate from the frontier and the recommendation
- [b] gemma3-27b-q4:latest: oom-suspect during load/warmup at context 4096: model failed to load
- [c] qwen3:8b-split: suspected CPU/GPU split, measured peak 5100 MiB is under 60% of the predicted 9000 MiB while completing; throughput also trails similar-size candidates

## Pareto frontier

Non-dominated on quality, peak VRAM, and median tokens/sec, among gate-passing candidates:

- **qwen3:14b**: quality 0.917, 10190 MiB, 10.4 tok/s
- **gemma3:4b**: quality 0.905, 4212 MiB, 25.2 tok/s

Dominated: qwen3:8b-split.

## Recommendation

**gemma3:4b**. gemma3:4b holds quality 0.905, within 2% of the best (0.917 from qwen3:14b), at 4212 MiB peak VRAM versus 10190 MiB.

- qwen3:14b: same quality band but 5978 MiB more peak VRAM than gemma3:4b
- qwen3:8b-split: same quality band but 888 MiB more peak VRAM than gemma3:4b
- gemma3:1b: failed gate scorers: json-schema (4 units)
- gemma3-27b-q4:latest: did not run: oom-suspect during load/warmup at context 4096: model failed to load

## Methodology

Each example ran 3 times at temperature 0 with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. VRAM is polled via nvidia-smi during load and generation; the peak is the highest sample. Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).

## Reproduce

```
quantproof run --pack ./examples/invoice-extraction
```
