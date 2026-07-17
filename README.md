<p align="center">
  <img src="docs/assets/cover.svg" alt="QuantProof: measured quality, latency, and peak VRAM for quantized models on your own task" width="100%">
</p>

<p align="center">
  <a href="#why-measure">Why measure</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#case-study">Case study</a> ·
  <a href="#run-it-on-your-task">Run it on your task</a> ·
  <a href="#api-runs">API runs</a> ·
  <a href="#documentation">Documentation</a>
</p>

# QuantProof

Point QuantProof at a folder of real examples from your task, and it tells
you which quantized model performs best on your hardware.

It measures, not estimates:

- **Quality**
- **Latency**
- **Peak VRAM usage**

Then it recommends the smallest quantized model whose quality is within 2%
of the best-performing model.

## Why measure

Fit calculators only tell you whether a model's weights will fit in memory.
Benchmark leaderboards rank models on general tests, not your specific
workload.

If your real question is:

> "Will Q4_K_M hurt my invoice extraction accuracy?"

there's only one reliable way to answer it: run your invoice extraction on
Q4_K_M and measure the results.

## How it works

QuantProof automates that process. It:

1. Tests candidate models one at a time
2. Scores every output deterministically
3. Measures latency and peak VRAM
4. Reports the full range of results
5. Recommends the best size/quality tradeoff

## Case study

<!-- LAUNCH DATA GOES HERE: the RTX 5070 study (3 packs, 10+ quants),
     table and recommendation verbatim from report --markdown. -->

Results forthcoming. The report below is exactly what QuantProof prints,
unedited.

## Run it on your task

Requirements:

- Node.js 22+
- For local model sweeps: [Ollama](https://ollama.com) running
- An NVIDIA GPU with nvidia-smi available if you want VRAM measurements

Runs still work without an NVIDIA GPU. In that case, the VRAM columns are
clearly marked "not measured."

```sh
git clone https://github.com/moonrunnerkc/quantproof && cd quantproof
npm install && npm run build && npm link   # not on npm yet

quantproof init my-task     # scaffold: prompts, examples, scorer

# Replace the two placeholder examples with 20+ real ones

quantproof run --pack my-task
```

The sweep:

- Tests every model already downloaded in Ollama (or a specific list
  provided with `--config`)
- Treats out-of-memory failures as recorded results instead of crashing

Generate a shareable report with:

```sh
quantproof report --markdown
```

To make results fully reproducible, export the raw outputs and scores:

```sh
quantproof report --bundle
```

Anyone can use the bundle to verify the scoring.

## API runs

The same task packs also run against Claude models through the Anthropic
API (`backend: anthropic` in the [run configuration](docs/run-config.md)
with `ANTHROPIC_API_KEY` set). These runs do not require Ollama or a GPU.
QuantProof still measures quality and latency, and clearly labels them as
API runs.

## Documentation

- [Task pack format](docs/task-packs.md): the part intended to be shared
- [Methodology and limitations](docs/methodology.md): read before citing results
- [Run configuration](docs/run-config.md)
