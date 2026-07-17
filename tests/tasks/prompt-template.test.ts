import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPromptTemplate, renderPrompt } from '../../src/tasks/prompt-template.js';

const dir = mkdtempSync(join(tmpdir(), 'quantproof-template-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadPromptTemplate', () => {
  it('loads a template containing the placeholder', () => {
    const path = join(dir, 'prompt.md');
    writeFileSync(path, 'Extract fields from:\n\n{{input}}\n');
    const result = loadPromptTemplate(path);
    expect(result.ok && result.template).toContain('{{input}}');
  });

  it('reports a missing file with a pointer at prompt_template', () => {
    const result = loadPromptTemplate(join(dir, 'missing.md'));
    expect(!result.ok && result.error).toContain('prompt_template in task.yaml');
  });

  it('reports a template without the placeholder and says what to add', () => {
    const path = join(dir, 'no-placeholder.md');
    writeFileSync(path, 'Extract the fields.');
    const result = loadPromptTemplate(path);
    expect(!result.ok && result.error).toContain('add {{input}}');
  });
});

describe('renderPrompt', () => {
  it('substitutes the input into the placeholder', () => {
    expect(renderPrompt('Q: {{input}} A:', 'what?')).toBe('Q: what? A:');
  });

  it('substitutes every occurrence of the placeholder', () => {
    expect(renderPrompt('{{input}} and again {{input}}', 'x')).toBe('x and again x');
  });

  it('leaves templates without a placeholder unchanged', () => {
    expect(renderPrompt('static', 'x')).toBe('static');
  });
});
