import { describe, expect, it } from 'vitest';
import { parseDraft } from '../../src/ingest/draft-parser.js';

const SCORERS = ['exact-label', 'field-f1', 'json-schema', 'numeric-tolerance', 'pattern'];

function labelDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Ticket Triage',
    type: 'classification',
    scorer: 'exact-label',
    scorer_params: { labels: ['billing', 'bug'] },
    prompt: 'Classify the ticket. Respond with exactly one of: billing, bug.\n\nTicket:\n{{input}}',
    examples: Array.from({ length: 12 }, (_, i) => ({
      input: `ticket number ${String(i)}`,
      expected: i % 2 === 0 ? 'billing' : 'bug',
    })),
    ...overrides,
  };
}

function errorsFor(draft: Record<string, unknown>): readonly string[] {
  const parsed = parseDraft(JSON.stringify(draft), SCORERS);
  if (parsed.ok) {
    throw new Error('expected parsing to fail');
  }
  return parsed.errors;
}

describe('parseDraft', () => {
  it('accepts a complete draft and kebab-cases the name', () => {
    const parsed = parseDraft(JSON.stringify(labelDraft()), SCORERS);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.name).toBe('ticket-triage');
      expect(parsed.draft.examples).toHaveLength(12);
      expect(parsed.draft.scorerParams).toEqual({ labels: ['billing', 'bug'] });
    }
  });

  it('extracts the JSON object out of surrounding prose and fences', () => {
    const wrapped = `Here is the pack you asked for:\n\`\`\`json\n${JSON.stringify(labelDraft())}\n\`\`\`\nLet me know!`;
    const parsed = parseDraft(wrapped, SCORERS);
    expect(parsed.ok).toBe(true);
  });

  it('reports a response with no JSON in it', () => {
    const parsed = parseDraft('I cannot do that.', SCORERS);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors[0]).toContain('must be a single JSON object');
    }
  });

  it('rejects a prompt without the input placeholder', () => {
    const errors = errorsFor(labelDraft({ prompt: 'Classify the ticket.' }));
    expect(errors.some((e) => e.includes('{{input}}'))).toBe(true);
  });

  it('rejects an unknown scorer with the valid list', () => {
    const errors = errorsFor(labelDraft({ scorer: 'vibes' }));
    expect(errors.some((e) => e.includes('exact-label, field-f1'))).toBe(true);
  });

  it('requires the prompt to name every declared label for exact-label', () => {
    const errors = errorsFor(
      labelDraft({ prompt: 'Classify the ticket. Respond with one label.\n\nTicket:\n{{input}}' }),
    );
    expect(errors.some((e) => e.includes('missing from the prompt') && e.includes('"billing"') && e.includes('"bug"'))).toBe(true);
  });

  it('accepts labels named in the prompt regardless of case', () => {
    const parsed = parseDraft(
      JSON.stringify(labelDraft({ prompt: 'Answer Billing or Bug, nothing else.\n\n{{input}}' })),
      SCORERS,
    );
    expect(parsed.ok).toBe(true);
  });

  it('rejects expected labels outside the declared set, naming them', () => {
    const examples = Array.from({ length: 12 }, (_, i) => ({
      input: `ticket number ${String(i)}`,
      expected: i === 0 ? 'spam' : 'bug',
    }));
    const errors = errorsFor(labelDraft({ examples }));
    expect(errors.some((e) => e.includes('"spam"'))).toBe(true);
  });

  it('deduplicates identical inputs and enforces the example floor', () => {
    const errors = errorsFor(
      labelDraft({
        examples: Array.from({ length: 12 }, () => ({ input: 'same ticket', expected: 'bug' })),
      }),
    );
    expect(errors.some((e) => e.includes('only 1 distinct valid examples'))).toBe(true);
  });

  it('collects every problem in one pass', () => {
    const errors = errorsFor(labelDraft({ prompt: 'no placeholder', scorer: 'vibes', name: '' }));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('requires every key field on field-f1 expected objects', () => {
    const errors = errorsFor(
      labelDraft({
        scorer: 'field-f1',
        scorer_params: { key_fields: ['vendor', 'total'] },
        examples: Array.from({ length: 12 }, (_, i) => ({
          input: `invoice ${String(i)}`,
          expected: { vendor: 'acme' },
        })),
      }),
    );
    expect(errors.some((e) => e.includes('missing one of the key fields (vendor, total)'))).toBe(true);
  });

  it('requires numeric expected values under numeric-tolerance', () => {
    const errors = errorsFor(
      labelDraft({
        scorer: 'numeric-tolerance',
        scorer_params: { tolerance: 0.5 },
        examples: Array.from({ length: 12 }, (_, i) => ({
          input: `sum ${String(i)}`,
          expected: i === 0 ? 'twelve' : i,
        })),
      }),
    );
    expect(errors.some((e) => e.includes('must be a number'))).toBe(true);
  });

  it('requires a non-empty patterns array for the pattern scorer', () => {
    const errors = errorsFor(labelDraft({ scorer: 'pattern', scorer_params: {} }));
    expect(errors.some((e) => e.includes('scorer_params.patterns'))).toBe(true);
  });

  it('requires an inline schema object for the json-schema scorer', () => {
    const errors = errorsFor(
      labelDraft({ scorer: 'json-schema', scorer_params: { schema: './schema.json' } }),
    );
    expect(errors.some((e) => e.includes('scorer_params.schema'))).toBe(true);
  });
});
