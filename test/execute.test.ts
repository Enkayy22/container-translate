import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { executeDown, executeUp } from '../src/compose/execute.js';
import { parseCompose } from '../src/compose/parse.js';
import type { CommandResult, Runtime } from '../src/runtime.js';

class FakeRuntime implements Runtime {
  calls: string[][] = [];
  failExists = new Set<string>();

  async run(argv: string[]): Promise<CommandResult> {
    this.calls.push(argv);
    const rendered = argv.join(' ');
    if (argv[1] === 'system' && argv[2] === 'status') return { code: 0, stdout: 'running', stderr: '' };
    if (this.failExists.has(rendered)) return { code: 1, stdout: '', stderr: 'already exists' };
    return { code: 0, stdout: '', stderr: '' };
  }
}

describe('compose execution', () => {
  it('creates the network and volume, then runs postgres, and down removes only that stack', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ct-state-'));
    process.env.CT_STATE_DIR = stateDir;
    const runtime = new FakeRuntime();
    runtime.failExists.add('container network create --label dev.container-translate.project=postgresql postgresql_default');
    const project = parseCompose([join(process.cwd(), 'test/fixtures/docker-compose.postgresql.yaml')]);
    await executeUp(project, 'container', runtime);

    const rendered = runtime.calls.map((call) => call.join(' '));
    assert.ok(rendered.some((line) => line.startsWith('container system status')));
    assert.ok(rendered.some((line) => line.includes('network create') && line.endsWith('postgresql_default')));
    assert.ok(rendered.some((line) => line.includes('volume create') && line.endsWith('postgresql_postgres-data')));
    assert.ok(rendered.some((line) => line.includes('run') && line.includes('--name db')));

    const state = JSON.parse(readFileSync(join(stateDir, 'postgresql.json'), 'utf8'));
    assert.equal(state.services[0].containerName, 'db');

    runtime.calls.length = 0;
    await executeDown(project, 'container', runtime, true);
    const down = runtime.calls.map((call) => call.join(' '));
    assert.ok(down.some((line) => line.includes('stop') && line.includes('db')));
    assert.ok(down.some((line) => line.includes('delete --force db')));
    assert.ok(down.some((line) => line.includes('volume delete postgresql_postgres-data')));
    assert.equal(down.some((line) => line.includes('kafka')), false);
  });
});
