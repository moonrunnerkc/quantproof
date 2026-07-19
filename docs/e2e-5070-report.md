# quantproof: recurring-tasks-classification on NVIDIA GeForce RTX 5070

Measured results of running the recurring-tasks-classification task pack against 4 local models via ollama 0.15.2. Scores are deterministic (scorer: exact-label); no numbers below are estimates unless labeled as predictions.

## Environment

- Date: 2026-07-19
- GPU: NVIDIA GeForce RTX 5070, driver 590.48.01
- Backend: ollama 0.15.2
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
| llama3.1:latest | Q4_K_M | 0.515 (0.500..0.545) | 51.5% | 142 (127..187) | 97.7 (84.0..112.3) | 5774 | 6229 (-7.3%) | [a] |
| llama3.1:8b-instruct-q4_0 | Q4_0 | 0.576 (0.545..0.591) | 57.6% | 138 (127..161) | 108.6 (97.0..133.3) | 5472 | 5981 (-8.5%) | [b] |
| gemma3:4b | Q4_K_M | 0.439 (0.409..0.455) | 43.9% | 261 (251..324) | 142.0 (95.2..165.7) | 4231 | 4752 (-11.0%) | [c] |
| gemma3:1b | Q4_K_M | 0.182 | 18.2% | 259 (244..294) | 268.7 (174.1..323.4) | 1479 | 1906 (-22.4%) |  |

- [a] llama3.1:latest: outputs differed across repetitions; the backend did not produce repeatable output for identical requests
- [b] llama3.1:8b-instruct-q4_0: outputs differed across repetitions; the backend did not produce repeatable output for identical requests
- [c] gemma3:4b: outputs differed across repetitions; the backend did not produce repeatable output for identical requests

## Pareto frontier

Non-dominated on quality, peak memory, and median tokens/sec, among gate-passing candidates:

- **llama3.1:8b-instruct-q4_0**: quality 0.576, 5472 MiB, 108.6 tok/s
- **gemma3:4b**: quality 0.439, 4231 MiB, 142.0 tok/s
- **gemma3:1b**: quality 0.182, 1479 MiB, 268.7 tok/s

Dominated: llama3.1:latest.

## Recommendation

**llama3.1:8b-instruct-q4_0**. llama3.1:8b-instruct-q4_0 has the best measured quality (0.576) and the smallest footprint (5472 MiB peak memory) among the candidates within the quality tolerance.

- llama3.1:latest: quality 0.515 is 10.5% below the best 0.576, outside the tolerance
- gemma3:4b: quality 0.439 is 23.7% below the best 0.576, outside the tolerance
- gemma3:1b: quality 0.182 is 68.4% below the best 0.576, outside the tolerance

## Methodology

Each example ran 3 times at temperature 0 with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. Memory is polled during load and generation (GPU memory via nvidia-smi); the peak is the highest sample. Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).

## Reproduce

```
quantproof run --pack recurring-tasks-classification --config quantproof.5070.yaml
```
