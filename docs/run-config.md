# Run config

The run config names the candidate models for a sweep. It is optional:
with no config file, `quantproof run --pack <dir>` sweeps every model
already in the local Ollama store.

```yaml
# quantproof.yaml
candidates:          # evaluated first, pulled on demand if missing
  - gemma3:1b
  - qwen3:4b
use_local_models: true   # also sweep everything already pulled (default true)
```

That is the whole format. Unknown keys are an error so a typo cannot
silently change what runs.

Notes:

- Explicit candidates run in declared order relative to each other, but
  the planner reorders the final set largest-first so out-of-memory
  surprises surface early.
- Ollama cloud models (`*:cloud`) are excluded automatically: nothing
  about them can be measured locally.
- Candidates predicted not to fit in free VRAM are skipped from the
  plan; pass `--force` to attempt them anyway. An attempt that runs out
  of memory is recorded as a result, not an error.
- `quantproof resume` reuses the run's original config exactly. If this
  file (or the task pack) changes on disk after planning, resume aborts
  rather than mixing two configurations in one result set.
