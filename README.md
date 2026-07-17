# quantproof

Point it at a folder of your real task examples and it tells you which
quantized model actually handles them on your hardware: measured
quality, latency, and peak VRAM, never estimates, plus one
recommendation, the smallest quant within 2% of the best quality.

Fit calculators predict whether weights fit. Leaderboards rank models
on benchmarks that are not your workload. The question that matters
("will Q4_K_M mangle my invoice extraction?") is only answerable by
running your extraction on Q4_K_M and checking. That loop, packaged:
sweep candidates one at a time, score every output deterministically,
measure VRAM and latency, report the spread, recommend.

## Case study

<!-- LAUNCH DATA GOES HERE: the RTX 5070 study (3 packs, 10+ quants),
     table and recommendation verbatim from report --markdown. -->

Results forthcoming; the format is the report this tool prints, unedited.

## Run it on your task

Needs Node 22+. Local sweeps need [Ollama](https://ollama.com) running,
plus an NVIDIA GPU with nvidia-smi for the VRAM numbers (runs work
without the GPU; VRAM columns then read "not measured", loudly).

```
git clone https://github.com/moonrunnerkc/quantproof && cd quantproof
npm install && npm run build && npm link   # not on npm yet
quantproof init my-task     # scaffold: prompts, examples, scorer
# replace the two placeholder examples with 20+ real ones
quantproof run --pack my-task
```

The sweep covers every model already pulled in Ollama (or an explicit
list via `--config`), survives OOM as a result rather than a crash,
and `quantproof report --markdown` renders the shareable version;
`--bundle` exports raw outputs and scores so anyone can re-check the
scoring.

The same packs also run against Claude models over the Anthropic API
(`backend: anthropic` in a [run config](docs/run-config.md), with
`ANTHROPIC_API_KEY` set): no GPU or Ollama involved, quality and
latency still measured, reports labeled as API runs.

- [Task pack format](docs/task-packs.md), the part meant to be shared
- [Methodology and limits](docs/methodology.md), read before citing
- [Run config](docs/run-config.md)
