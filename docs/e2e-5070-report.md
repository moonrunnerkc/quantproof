# quantproof: recurring-tasks-classification on NVIDIA GeForce RTX 5070

Measured results of running the recurring-tasks-classification task pack against 4 local models via ollama 0.32.1. Scores are deterministic (scorer: exact-label); no numbers below are estimates unless labeled as predictions.

## Environment

- Date: 2026-07-19
- GPU: NVIDIA GeForce RTX 5070, driver 590.48.01
- Backend: ollama 0.32.1
- Task pack: recurring-tasks-classification (scorer exact-label), fingerprint `7b7a2b622291`
- **Drafted pack**: pack drafted by llama3.1:latest (ollama 0.15.2) from recurring-tasks.md on 2026-07-19; expected values are model-authored and unreviewed, so quality measures agreement with the drafter (set provenance.reviewed in task.yaml after checking)
- Generation: context 4096, max_tokens 512, temperature 0, seed 42, 3 runs per example

| model | quant | params | weights MiB | digest |
| --- | --- | --- | ---: | --- |
| llama3.1:latest | Q4_K_M | 8.0B | 4693 | `46e0c10c039e` |
| llama3.1:8b-instruct-q4_0 | Q4_0 | 8.0B | 4445 | `42182419e950` |
| gemma3:4b | Q4_K_M | 4.3B | 3184 | `a2af6cc3eb7f` |
| gemma3:1b | Q4_K_M | 999.89M | 778 | `8648f39daa8f` |

## Results

| model | quant | quality (spread) | pass | TTFT ms (spread) | tok/s (spread) | peak memory MiB | predicted MiB (delta) | flags |
| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |
| llama3.1:latest | Q4_K_M | 0.591 | 59.1% | 233 (222..311) | 108.9 (89.9..115.0) | 5588 | 6229 (-10.3%) |  |
| llama3.1:8b-instruct-q4_0 | Q4_0 | 0.545 | 54.5% | 234 (225..283) | 112.9 (101.0..122.9) | 5459 | 5981 (-8.7%) |  |
| gemma3:4b | Q4_K_M | 0.455 | 45.5% | 508 (484..591) | 119.7 (84.0..132.0) | 4189 | 4752 (-11.9%) | [a] |
| gemma3:1b | Q4_K_M | 0.212 (0.182..0.227) | 21.2% | 480 (467..556) | 203.9 (106.4..232.6) | 1411 | 1906 (-26.0%) | [b] |

- [a] gemma3:4b: outputs differed across repetitions; the backend did not produce repeatable output for identical requests
- [b] gemma3:1b: outputs differed across repetitions; the backend did not produce repeatable output for identical requests

## Pareto frontier

Non-dominated on quality, peak memory, and median tokens/sec, among gate-passing candidates:

- **llama3.1:latest**: quality 0.591, 5588 MiB, 108.9 tok/s
- **llama3.1:8b-instruct-q4_0**: quality 0.545, 5459 MiB, 112.9 tok/s
- **gemma3:4b**: quality 0.455, 4189 MiB, 119.7 tok/s
- **gemma3:1b**: quality 0.212, 1411 MiB, 203.9 tok/s

## Recommendation

**llama3.1:latest**. llama3.1:latest has the best measured quality (0.591) and the smallest footprint (5588 MiB peak memory) among the candidates within the quality tolerance.

- llama3.1:8b-instruct-q4_0: quality 0.545 is 7.7% below the best 0.591, outside the tolerance
- gemma3:4b: quality 0.455 is 23.1% below the best 0.591, outside the tolerance
- gemma3:1b: quality 0.212 is 64.1% below the best 0.591, outside the tolerance

## Methodology

Each example ran 3 times at temperature 0 with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. Memory is polled during load and generation (GPU memory via nvidia-smi); the peak is the highest sample. Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).

## Reproduce

```
quantproof run --pack recurring-tasks-classification --config quantproof.5070.yaml
```
