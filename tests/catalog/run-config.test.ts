import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_CONFIG, loadRunConfig } from '../../src/catalog/run-config.js';

const dir = mkdtempSync(join(tmpdir(), 'quantproof-config-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function configFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('loadRunConfig', () => {
  it('loads candidates and use_local_models', () => {
    const path = configFile('full.yaml', 'candidates:\n  - gemma3:1b\n  - qwen3:4b\nuse_local_models: false\n');
    expect(loadRunConfig(path)).toEqual({
      candidates: ['gemma3:1b', 'qwen3:4b'],
      useLocalModels: false,
    });
  });

  it('defaults candidates to empty and use_local_models to true', () => {
    const path = configFile('minimal.yaml', 'candidates: []\n');
    expect(loadRunConfig(path)).toEqual({ candidates: [], useLocalModels: true });
  });

  it('matches the documented default when no config file is used', () => {
    expect(DEFAULT_RUN_CONFIG).toEqual({ candidates: [], useLocalModels: true });
  });

  it('rejects a missing file pointing at --config', () => {
    expect(() => loadRunConfig(join(dir, 'absent.yaml'))).toThrow(/--config/);
  });

  it('rejects invalid YAML with the file path', () => {
    const path = configFile('broken.yaml', 'candidates: [unclosed');
    expect(() => loadRunConfig(path)).toThrow(/not valid YAML/);
  });

  it('rejects a non-mapping document with a docs pointer', () => {
    const path = configFile('list.yaml', '- gemma3:1b\n');
    expect(() => loadRunConfig(path)).toThrow(/run-config\.md/);
  });

  it('rejects candidates that are not a string list', () => {
    const path = configFile('bad-candidates.yaml', 'candidates:\n  - name: gemma3\n');
    expect(() => loadRunConfig(path)).toThrow(/"candidates" must be a list of model names/);
  });

  it('rejects a non-boolean use_local_models', () => {
    const path = configFile('bad-local.yaml', 'use_local_models: "yes"\n');
    expect(() => loadRunConfig(path)).toThrow(/must be true or false/);
  });

  it('rejects unknown keys so typos do not silently do nothing', () => {
    const path = configFile('typo.yaml', 'candidats:\n  - gemma3:1b\n');
    expect(() => loadRunConfig(path)).toThrow(/unknown key "candidats"/);
  });
});
