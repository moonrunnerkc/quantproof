import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/cli/command-run.js';
import { journalFailureHint, RunStore } from '../../src/results/run-store.js';

const dir = mkdtempSync(join(tmpdir(), 'quantproof-errors-'));
const pack = resolve(import.meta.dirname, '../../examples/ticket-classification');
afterAll(() => {
  chmodSync(join(dir, 'sealed'), 0o755);
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `fn` against a throwaway HTTP server that answers like Ollama. */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server failed to bind a port');
  }
  try {
    await fn(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    server.close();
  }
}

const emptyStore = (req: IncomingMessage, res: ServerResponse): void => {
  if (req.url === '/api/version') {
    res.end(JSON.stringify({ version: '0.0-test' }));
    return;
  }
  if (req.url === '/api/tags') {
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not handled by the test server' }));
};

describe('user-reachable failure paths', () => {
  it('a missing task pack names the manifest and points at init', async () => {
    await expect(runCommand({ pack: join(dir, 'no-such-pack') })).rejects.toThrow(
      /cannot read .*task\.yaml.*quantproof init/s,
    );
  });

  it('an unreachable backend names the url and the command to start it', async () => {
    await expect(
      runCommand({ pack, baseUrl: 'http://127.0.0.1:9' }),
    ).rejects.toThrow(/cannot reach Ollama at http:\/\/127\.0\.0\.1:9; start it with: ollama serve/);
  });

  it('an empty model store says exactly how to get a candidate', async () => {
    await withServer(emptyStore, async (baseUrl) => {
      await expect(runCommand({ pack, baseUrl })).rejects.toThrow(
        /no candidates to run; pull a model \(ollama pull gemma3:1b\), pass --model, or list candidates/,
      );
    });
  });

  it('a failed pull names the model and the manual retry command', async () => {
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      if (req.url === '/api/pull') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }));
        return;
      }
      emptyStore(req, res);
    };
    await withServer(handler, async (baseUrl) => {
      await expect(runCommand({ pack, model: 'nope:latest', baseUrl })).rejects.toThrow(
        /pulling "nope:latest" failed:.*file does not exist.*retry with: ollama pull nope:latest/s,
      );
    });
  });

  it('a pull cut off mid-stream still ends with the retry command', async () => {
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      if (req.url === '/api/pull') {
        res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        setTimeout(() => {
          res.destroy();
        }, 20);
        return;
      }
      emptyStore(req, res);
    };
    await withServer(handler, async (baseUrl) => {
      await expect(runCommand({ pack, model: 'gemma3:1b', baseUrl })).rejects.toThrow(
        /pulling "gemma3:1b" failed:.*retry with: ollama pull gemma3:1b/s,
      );
    });
  });

  it('a corrupt results database says to move it aside', () => {
    const corrupt = join(dir, 'corrupt.db');
    writeFileSync(corrupt, 'this is not sqlite');
    expect(() => RunStore.open(corrupt)).toThrow(
      new RegExp(`not a quantproof results database.*mv ${corrupt} ${corrupt}\\.bad`, 's'),
    );
  });

  it('an unwritable database directory says to pick another with --db', () => {
    mkdirSync(join(dir, 'sealed'), { recursive: true });
    chmodSync(join(dir, 'sealed'), 0o555);
    expect(() => RunStore.open(join(dir, 'sealed', 'deeper', 'results.db'))).toThrow(
      /cannot create the results directory.*--db <path>/s,
    );
  });

  it('a disk-full journal write maps to free-space-then-resume guidance', () => {
    const full = Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    const hint = journalFailureHint(full, '.quantproof/results.db');
    expect(hint?.message).toContain('every completed unit is already saved');
    expect(hint?.message).toContain('quantproof resume');
  });

  it('a database that stopped being writable maps to fix-then-resume guidance', () => {
    const readonly = Object.assign(new Error('attempt to write a readonly database'), {
      code: 'SQLITE_READONLY',
    });
    expect(journalFailureHint(readonly, 'x.db')?.message).toContain('quantproof resume');
  });

  it('passes unrecognized errors through untouched for the caller to rethrow', () => {
    expect(journalFailureHint(new Error('scorer exploded'), 'x.db')).toBeNull();
  });
});
