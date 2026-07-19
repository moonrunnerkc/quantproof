# Task packs

A task pack is a directory describing one job you need a local model to
do: the prompt, 20 to 50 real examples with machine-checkable expected
results, and the scorer that decides whether an output is right. Packs
are the unit people share; everything in one is plain YAML, JSON, and
text so a pack can be diffed, reviewed, and PRed.

Three ways to get one: `quantproof ingest <file>` drafts a complete
pack from a freeform document (notes, a task list, a runbook) using a
local model; `quantproof init` scaffolds one to fill in by hand; or
copy a shared pack. Check any of them with `quantproof validate <dir>`.
Validation reports every problem in one pass, each with the file and
the fix.

## Ingest and provenance

`quantproof ingest ~/Downloads/my-tasks.md` picks the largest local
model that fits in memory (override with `--model`), has it propose the
whole pack (name, scorer, prompt, 20+ examples with expected values),
re-validates the proposal with the same strict loader hand-written
packs go through, and gives the model up to two repair rounds on the
collected errors. A draft that still fails is written as-is with the
errors printed, so you fix two fields instead of starting over.

Drafting quality tracks the drafting model. An 8B-class model can
propose sound examples yet ignore instructions the validator enforces
(a live run watched one refuse, across all three attempts, to name the
label set in the prompt); the errors are printed and the fix is usually
one hand edit. A larger drafter gets it right in one pass more often,
and either way the review step below is not optional: expect a wrong
expected value or two per draft.

The pack it writes carries a `provenance` block:

```yaml
provenance:
  source: my-tasks.md
  source_sha256: <hash of the document at drafting time>
  drafted_by: gemma3:4b (ollama 0.23.1)
  drafted_at: 2026-07-17
  reviewed: false
```

Until you set `reviewed: true`, every report rendered from the pack
says so, loudly: expected values a model invented measure agreement
with that model, not correctness, and the label only clears when a
human has checked the examples. Scoring itself stays deterministic
either way; the drafting model never judges an output.

## Layout

```
my-task/
├── task.yaml        # the manifest (spec below)
├── prompt.md        # sent verbatim to the model, {{input}} substituted
├── schema.json      # only if a scorer or gate references one
└── examples/        # one JSON file per example
    ├── 001.json
    └── 002.json
```

## task.yaml

```yaml
name: invoice-extraction     # kebab-case identifier
type: extraction             # free-form label (extraction, classification, ...)

scorer: field-f1             # primary scorer, decides the quality score
scorer_params:
  key_fields: [vendor, total, due_date]

gates:                       # optional; every gate must pass or the
  - scorer: json-schema      # example scores 0 (primary score stays
    scorer_params:           # visible in the stored details)
      schema: ./schema.json

generation:                  # applied to every candidate model
  context: 4096              # context window requested from the backend
  max_tokens: 512            # generation cap per example; too low
                             # truncates output and tanks scores
  temperature: 0             # keep 0: deterministic scoring assumes it
  seed: 42                   # applied where the backend honors it
  runs_per_example: 3        # repetitions; score spread is reported

prompt_template: ./prompt.md # must contain {{input}}
examples_dir: ./examples
```

All paths are relative to the pack directory. Unknown scorers, missing
fields, and malformed values are hard errors with the valid options
listed.

## prompt.md

Plain text, no template engine. Every occurrence of `{{input}}` is
replaced with the example's input. The file must contain the
placeholder at least once.

## Examples

One JSON file per example. The filename (minus `.json`) is the example
id; files load in sorted filename order.

```json
{
  "input": "Invoice #4821 from ACME Corp, total $1,234.50, due 2026-08-01",
  "expected": { "vendor": "ACME Corp", "total": 1234.50, "due_date": "2026-08-01" }
}
```

- `input`: non-empty string, substituted into the prompt.
- `expected`: any JSON value; its required shape depends on the scorer.
- A file containing a `replace_me` key is rejected as an init
  placeholder, whatever else it contains.

## Scorers

Every scorer is a pure function: same output and expected value always
produce the same score. Malformed model output scores 0 with an
explanation; it never throws. Invalid `scorer_params` throw at load
time, before any inference.

| scorer | expected value | params |
| --- | --- | --- |
| `field-f1` | object with the key fields | `key_fields` (required) |
| `exact-label` | one label (or alias) from the set | `labels` (required), `aliases` (optional map) |
| `json-schema` | unused; the schema decides | `schema` (required: inline object or `./file.json` path) |
| `pattern` | unused; the patterns decide | `patterns` (required), `mode`: `contains` (default) or `regex`, `match`: `all` (default) or `any` |
| `numeric-tolerance` | a number | `tolerance` (required, absolute) |

Normalization notes that bite in practice:

- `field-f1` normalizes case, whitespace, and number formats before
  comparing, so `"$1,234.50"` matches `1234.5`. Score is F1 over the
  key fields; passing requires every key field to match. A field that
  is present but wrong hurts both precision and recall; an absent field
  hurts recall only.
- `exact-label` requires the whole normalized output to be a label or
  alias. A correct label wrapped in prose scores 0: emitting a bare
  label is part of the task.
- Percent tokens parse at face value (`"42%"` is 42, not 0.42). Number
  parsing handles US-style thousands separators only; numbers written
  as words never parse.
- `pattern` in `contains` mode is case-sensitive, because its usual
  targets (config keys, code fragments) are.
- JSON extraction (for `json-schema` and `field-f1`) takes the first
  balanced `{...}` or `[...]` in the output; if that candidate fails to
  parse, the output scores 0 rather than scanning further.

Tasks that cannot be scored deterministically (summarization quality,
open QA, style) are out of scope in v0.1 by design; there is no proxy
metric that would not mislead.

## Worked example

`examples/invoice-extraction` in this repo is the reference pack:
`field-f1` over three key fields, gated by `json-schema` so non-JSON
output scores 0 before field comparison ever runs.

```
examples/invoice-extraction/
├── task.yaml       # shown above, verbatim
├── prompt.md       # "Extract ... respond with JSON matching ..." + {{input}}
├── schema.json     # type: object, requires vendor, total, due_date
└── examples/       # 001.json .. 013.json, real invoice lines
```

A live result from this pack, worth copying: gemma3:1b extracts the
fields correctly but quotes totals as strings (`"total": "1234.50"`),
so the json-schema gate fails it with `/total must be number` and its
quality is 0 despite near-perfect field text. That distinction (can
extract, cannot emit the declared type) is exactly what gates exist to
surface, and it is visible in the stored score details.

Run it:

```
quantproof validate examples/invoice-extraction
quantproof run --pack examples/invoice-extraction
```
