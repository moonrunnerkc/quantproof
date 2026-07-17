/**
 * The compact terminal view of a sweep: one row per candidate, flags
 * inline with a legend underneath, the Pareto summary, and the
 * recommendation on the last lines. Built to fit a normal terminal
 * without wrapping; per-candidate drill-down lives in terminal-report.
 */

import type { CandidateAggregate } from './aggregate.js';
import type { UnitResult } from '../results/record-types.js';
import {
  fmtMib, fmtMs, fmtRate, fmtScore, fmtSignedPercent, fmtWithSpread, renderColumns, wrapLine,
} from './format.js';
import type { ReportData } from './report-data.js';

/** Short inline tokens with the detail each one expands to. */
interface Flag {
  readonly token: string;
  readonly detail: string;
}

function flagsFor(aggregate: CandidateAggregate): Flag[] {
  const flags: Flag[] = [];
  if (aggregate.status === 'oom') {
    flags.push({ token: 'oom', detail: aggregate.statusReason ?? 'out of memory' });
  }
  if (aggregate.status === 'failed') {
    flags.push({ token: 'failed', detail: aggregate.statusReason ?? 'no reason recorded' });
  }
  if (aggregate.status === 'running') {
    flags.push({
      token: 'incomplete',
      detail: 'interrupted before finishing; quantproof resume will complete its pending units',
    });
  }
  if (aggregate.gatesPassed === false) {
    const gates = Object.entries(aggregate.gateFailureCounts)
      .map(([gate, count]) => `${gate} (${String(count)} unit${count === 1 ? '' : 's'})`)
      .join(', ');
    flags.push({ token: 'gates!', detail: `failed gate scorers: ${gates}` });
  }
  if (aggregate.offloadSuspectReason !== null) {
    flags.push({ token: 'offload?', detail: aggregate.offloadSuspectReason });
  }
  if (aggregate.summary.outputsDeterministic === false) {
    flags.push({
      token: 'nondet',
      detail: 'outputs differ across repetitions; the backend did not produce repeatable output for identical requests',
    });
  }
  return flags;
}

function row(aggregate: CandidateAggregate, flags: readonly Flag[]): string[] {
  const s = aggregate.summary;
  const vram =
    aggregate.candidate.fitVerdict === 'not-applicable'
      ? 'n/a'
      : aggregate.measuredPeakMib === null
        ? 'n/m'
        : aggregate.vramDeltaPercent === null
          ? fmtMib(aggregate.measuredPeakMib)
          : `${fmtMib(aggregate.measuredPeakMib)} (${fmtSignedPercent(aggregate.vramDeltaPercent)}%)`;
  return [
    aggregate.candidate.modelName,
    aggregate.candidate.quantization ?? '?',
    fmtWithSpread(s.meanScore, s.scoreSpread, fmtScore),
    s.passRate === null ? '-' : (s.passRate * 100).toFixed(1),
    s.ttftMedianMs === null ? '-' : fmtMs(s.ttftMedianMs),
    s.tokensPerSecondMedian === null ? '-' : fmtRate(s.tokensPerSecondMedian),
    vram,
    flags.map((f) => f.token).join(','),
  ];
}

function recommendationLines(data: ReportData): string[] {
  const rec = data.recommendation;
  if (rec.kind === 'none') {
    return [
      ...wrapLine(`no recommendation: ${rec.reason}`),
      ...rec.nearestMisses.flatMap((miss) =>
        wrapLine(`  nearest miss ${miss.aggregate.candidate.modelName}: ${miss.reason}`),
      ),
    ];
  }
  return [
    ...wrapLine(`recommend ${rec.pick.candidate.modelName}: ${rec.reason}`),
    ...rec.runnersUp.flatMap((runner) =>
      wrapLine(`  runner-up ${runner.aggregate.candidate.modelName}: ${runner.reason}`),
    ),
  ];
}

/**
 * One line totaling the run's token spend from the backend's own
 * counts, printed at the end of a sweep.
 *
 * @param units - The run's unit results.
 * @returns The line, or an empty string when no generation reported
 *   token counts.
 */
export function renderTokenSpend(units: readonly UnitResult[]): string {
  const counted = units.filter((u) => u.generation !== null);
  if (counted.length === 0) {
    return '';
  }
  const prompt = counted.reduce((n, u) => n + (u.generation?.promptTokenCount ?? 0), 0);
  const output = counted.reduce((n, u) => n + (u.generation?.outputTokenCount ?? 0), 0);
  return `token spend: ${String(prompt)} prompt + ${String(output)} output tokens across ${String(counted.length)} generations\n`;
}

/**
 * Renders the sweep comparison: header, table, flag legend, Pareto
 * summary, and the recommendation at the bottom.
 *
 * @param data - Assembled report data for one run.
 * @returns Multi-line text ready for stdout.
 */
export function renderComparison(data: ReportData): string {
  const { run } = data;
  const gpu =
    run.gpuName === null
      ? `VRAM not measured: ${run.vramUnavailableReason ?? 'no GPU telemetry'}`
      : `${run.gpuName} (driver ${run.driverVersion ?? 'unknown'})`;
  const lines: string[] = [
    '',
    `${run.packName}: ${String(data.aggregates.length)} candidate${data.aggregates.length === 1 ? '' : 's'} | ${run.backendVersion} | ${gpu}`,
  ];
  for (const note of data.notes) {
    lines.push(`note: ${note}`);
  }
  lines.push('');

  const flagged = data.aggregates.map((aggregate) => ({ aggregate, flags: flagsFor(aggregate) }));
  lines.push(
    ...renderColumns(
      ['model', 'quant', 'quality (rep spread)', 'pass%', 'ttft ms', 'tok/s', 'peak MiB', 'flags'],
      flagged.map(({ aggregate, flags }) => row(aggregate, flags)),
      [3, 4, 5, 6],
    ),
  );
  if (data.aggregates.some((a) => a.vramDeltaPercent !== null)) {
    lines.push('  (+x%) = measured peak versus the fit prediction');
  }
  for (const { aggregate, flags } of flagged) {
    for (const flag of flags) {
      lines.push(...wrapLine(`  ${flag.token} ${aggregate.candidate.modelName}: ${flag.detail}`));
    }
  }
  lines.push('');

  const frontier = data.pareto.frontier;
  lines.push(
    ...wrapLine(
      frontier.length === 0
        ? 'pareto frontier: empty (no gate-passing candidates)'
        : `pareto frontier (quality/VRAM/tok/s): ${frontier.map((p) => p.aggregate.candidate.modelName).join(', ')}` +
            (data.pareto.dominated.length > 0
              ? ` | dominated: ${data.pareto.dominated.map((p) => p.aggregate.candidate.modelName).join(', ')}`
              : ''),
    ),
  );
  lines.push(...recommendationLines(data));
  lines.push('');
  return lines.join('\n');
}
