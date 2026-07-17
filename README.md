# quantproof

Point it at a folder of your real task examples and it tells you which
quantized model actually handles them on your hardware: measured
quality, latency, and peak VRAM, never estimates, plus one
recommendation (the smallest quant within 2% of the best measured
quality).

Fit calculators predict whether weights fit. Leaderboards rank models
on benchmarks that are not your workload. The question that actually
matters ("will Q4_K_M mangle my invoice extraction?") is only
answerable by running your extraction on Q4_K_M and checking. That
loop, packaged: sweep the candidates one at a time, score every output
deterministically, measure VRAM and latency while doing it, report the
spread, recommend.

## Case study

<!-- LAUNCH DATA GOES HERE: the RTX 5070 study (3 task packs, 10+
     quant/model combinations) lands in this section, table and
     recommendation verbatim from `quantproof report --markdown`. -->

Results table and full methodology forthcoming; the format is the
report this tool prints, unedited.

## Run it on your task

Needs Node 22+, an NVIDIA GPU with nvidia-smi, and
[Ollama](https://ollama.com) running locally. (Runs work without the
GPU; VRAM columns then read "not measured", loudly.)

```
npx quantproof init my-task     # scaffold: prompts, examples, scorer
# replace the two placeholder examples with 20+ real ones
npx quantproof run --pack my-task
```

The sweep covers every model already pulled in Ollama (or an explicit
list via `--config`), survives OOM as a result rather than a crash,
and `quantproof report --markdown` renders the shareable version;
`--bundle` exports raw outputs and scores so anyone can re-check the
scoring.

- [Task pack format](docs/task-packs.md), the part meant to be shared
- [Methodology and limits](docs/methodology.md), read before citing
- [Run config](docs/run-config.md)
