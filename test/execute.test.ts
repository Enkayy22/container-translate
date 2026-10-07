import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCompose } from '../src/cli.js';
import { executeDown, executeUp } from '../src/compose/execute.js';
import { parseCompose } from '../src/compose/parse.js';
import { writeState } from '../src/compose/state.js';
import { TranslateError } from '../src/errors.js';
import type { CommandResult, Runtime } from '../src/runtime.js';

class FakeRuntime implements Runtime {
  calls: string[][] = [];
  failExists = new Set<string>();
  onRun: (argv: string[]) => CommandResult | undefined = () => undefined;

  async run(argv: string[]): Promise<CommandResult> {
    this.calls.push(argv);
    const custom = this.onRun(argv);
    if (custom) return custom;
    const rendered = argv.join(' ');
    if (argv[1] === 'system' && argv[2] === 'status') return { code: 0, stdout: 'running', stderr: '' };
    if (this.failExists.has(rendered)) return { code: 1, stdout: '', stderr: 'already exists' };
    return { code: 0, stdout: '', stderr: '' };
  }
}

function useStateDir(): void {
  process.env.CT_STATE_DIR = mkdtempSync(join(tmpdir(), 'ct-state-'));
}

function writeCompose(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-compose-'));
  const file = join(dir, 'compose.yml');
  writeFileSync(file, body);
  return file;
}

async function captureLog(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
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

  it('polls a service_healthy dependency and fails after the configured retries', async () => {
    useStateDir();
    const file = writeCompose([
      'services:',
      '  db:',
      '    image: postgres:15',
      '    healthcheck:',
      '      test: ["CMD", "pg_isready"]',
      '      interval: 1ms',
      '      retries: 2',
      '  app:',
      '    image: alpine',
      '    depends_on:',
      '      db:',
      '        condition: service_healthy',
    ].join('\n'));
    const runtime = new FakeRuntime();
    await runCompose(['-p', 'health', '-f', file, 'up', '-d'], runtime);
    const rendered = runtime.calls.map((call) => call.join(' '));
    const db = rendered.findIndex((line) => line.includes('run') && line.includes('--name db'));
    const probe = rendered.findIndex((line) => line === 'container exec db pg_isready');
    const app = rendered.findIndex((line) => line.includes('run') && line.includes('--name app'));
    assert.ok(db >= 0 && probe > db && app > probe);

    runtime.calls.length = 0;
    runtime.onRun = (argv) => (argv[1] === 'exec' ? { code: 1, stdout: '', stderr: 'no' } : undefined);
    await assert.rejects(
      () => runCompose(['-p', 'health-fail', '-f', file, 'up', '-d'], runtime),
      (err: unknown) => err instanceof TranslateError && /Healthcheck failed/.test(err.message),
    );
    assert.equal(runtime.calls.filter((call) => call[1] === 'exec').length, 2);
    assert.equal(runtime.calls.some((call) => call.includes('--name') && call.includes('app')), false);
  });

  it('recreates containers, builds before run, and deletes orphans recorded before up', async () => {
    useStateDir();
    const file = writeCompose([
      'services:',
      '  web:',
      '    build:',
      '      context: .',
      '      args:',
      '        FOO: bar',
    ].join('\n'));
    writeState({
      project: 'demo',
      network: 'demo_default',
      volumes: [],
      services: [
        { name: 'web', containerName: 'web' },
        { name: 'old', containerName: 'old-job' },
      ],
    });
    const runtime = new FakeRuntime();
    await runCompose(['-p', 'demo', '-f', file, 'up', '-d', '--force-recreate', '--remove-orphans'], runtime);
    const rendered = runtime.calls.map((call) => call.join(' '));
    const build = rendered.findIndex((line) => line.startsWith('container build'));
    const stopWeb = rendered.findIndex((line) => line === 'container stop web');
    const runWeb = rendered.findIndex((line) => line.includes('run') && line.includes('--name web'));
    const stopOld = rendered.findIndex((line) => line === 'container stop old-job');
    assert.ok(build >= 0 && stopWeb >= 0 && runWeb > build && runWeb > stopWeb);
    assert.ok(rendered[build].includes('--build-arg FOO=bar'));
    assert.ok(stopOld > runWeb);
    assert.ok(rendered.some((line) => line === 'container delete --force old-job'));
  });

  it('starts the container service when it is stopped and refuses a missing CLI', async () => {
    useStateDir();
    const file = writeCompose([
      'services:',
      '  web:',
      '    image: nginx:1',
    ].join('\n'));
    const runtime = new FakeRuntime();
    runtime.onRun = (argv) => {
      if (argv[1] === 'system' && argv[2] === 'status') return { code: 1, stdout: '', stderr: 'stopped' };
      return undefined;
    };
    await runCompose(['-p', 'boot', '-f', file, 'up', '-d'], runtime);
    assert.ok(runtime.calls.some((call) => call.join(' ') === 'container system start'));
    assert.ok(runtime.calls.some((call) => call.includes('--name') && call.includes('web')));

    runtime.calls.length = 0;
    runtime.onRun = (argv) => {
      if (argv[1] === 'system' && argv[2] === 'status') return { code: 127, stdout: '', stderr: 'not found' };
      return undefined;
    };
    await assert.rejects(
      () => runCompose(['-p', 'missing', '-f', file, 'up', '-d'], runtime),
      /Apple Container CLI was not found/,
    );
  });

  it('limits up to the named service, then stops, starts, pulls, logs, execs, and lists', async () => {
    useStateDir();
    const file = writeCompose([
      'services:',
      '  web:',
      '    image: nginx:1',
      '  worker:',
      '    image: alpine',
      '    depends_on: [web]',
      '  built:',
      '    build: .',
    ].join('\n'));
    const runtime = new FakeRuntime();
    await runCompose(['-p', 'deps', '-f', file, 'up', '-d', '--no-deps', 'worker'], runtime);
    const up = runtime.calls.map((call) => call.join(' '));
    assert.ok(up.some((line) => line.includes('--name worker')));
    assert.equal(up.some((line) => line.includes('--name web') || line.includes('--name built')), false);

    runtime.calls.length = 0;
    await runCompose(['-p', 'stack', '-f', file, 'stop'], runtime);
    assert.deepEqual(runtime.calls.map((call) => call.join(' ')), [
      'container stop built',
      'container stop worker',
      'container stop web',
    ]);

    runtime.calls.length = 0;
    await runCompose(['-p', 'stack', '-f', file, 'start'], runtime);
    assert.deepEqual(runtime.calls.map((call) => call.join(' ')), [
      'container system status',
      'container start web',
      'container start worker',
      'container start built',
    ]);

    runtime.calls.length = 0;
    await runCompose(['-p', 'stack', '-f', file, 'restart'], runtime);
    assert.deepEqual(runtime.calls.map((call) => call.join(' ')), [
      'container stop built',
      'container stop worker',
      'container stop web',
      'container system status',
      'container start web',
      'container start worker',
      'container start built',
    ]);

    runtime.calls.length = 0;
    await runCompose(['-p', 'stack', '-f', file, 'pull'], runtime);
    assert.deepEqual(runtime.calls.map((call) => call.join(' ')), [
      'container image pull nginx:1',
      'container image pull alpine',
    ]);

    runtime.calls.length = 0;
    await runCompose(['-p', 'stack', '-f', file, 'logs', '--tail', '20', '-f'], runtime);
    assert.deepEqual(runtime.calls.map((call) => call.join(' ')), [
      'container logs -n 20 web',
      'container logs -n 20 worker',
      'container logs --follow -n 20 built',
    ]);

    runtime.calls.length = 0;
    await runCompose(['-p', 'stack', '-f', file, 'exec', 'web', 'sh', '-c', 'true'], runtime);
    assert.deepEqual(runtime.calls.map((call) => call.join(' ')), [
      'container exec web sh -c true',
    ]);

    runtime.calls.length = 0;
    await runCompose(['-p', 'stack', '-f', file, 'ps'], runtime);
    assert.deepEqual(runtime.calls.map((call) => call.join(' ')), [
      'container list --all',
    ]);
  });

  it('prints dry-run and config without calling container, and honors COMPOSE_PROFILES', async () => {
    useStateDir();
    const file = writeCompose([
      'services:',
      '  web:',
      '    image: nginx:1',
      '  debug:',
      '    image: alpine',
      '    profiles: [debug]',
    ].join('\n'));
    const runtime = new FakeRuntime();
    const dryRun = await captureLog(() => runCompose(['-p', 'demo', '-f', file, 'up', '--dry-run'], runtime));
    assert.equal(runtime.calls.length, 0);
    assert.ok(dryRun.some((line) => line.includes('container run') && line.includes('--name web')));
    assert.equal(dryRun.some((line) => line.includes('--name debug')), false);

    const config = await captureLog(() => runCompose(['-p', 'demo', '-f', file, 'config'], runtime));
    assert.match(config.join('\n'), /"name": "demo"/);
    assert.equal(runtime.calls.length, 0);

    process.env.COMPOSE_PROFILES = 'debug';
    try {
      await runCompose(['-p', 'demo', '-f', file, 'up', '-d'], runtime);
    } finally {
      delete process.env.COMPOSE_PROFILES;
    }
    const up = runtime.calls.map((call) => call.join(' '));
    assert.ok(up.some((line) => line.includes('--name web')));
    assert.ok(up.some((line) => line.includes('--name debug')));
  });

  it('stops with the compose signal and grace period, and keeps volumes unless -v is set', async () => {
    useStateDir();
    const file = writeCompose([
      'services:',
      '  web:',
      '    image: alpine',
      '    stop_signal: SIGTERM',
      '    stop_grace_period: 10s',
      '    volumes:',
      '      - web-data:/data',
      'volumes:',
      '  web-data:',
    ].join('\n'));
    const project = parseCompose([file], { projectName: 'signals' });
    const runtime = new FakeRuntime();
    await executeDown(project, 'container', runtime, false);
    const kept = runtime.calls.map((call) => call.join(' '));
    assert.ok(kept.includes('container stop --signal SIGTERM --time 10 web'));
    assert.ok(kept.includes('container delete --force web'));
    assert.equal(kept.some((line) => line.includes('volume delete')), false);

    runtime.calls.length = 0;
    await executeUp(project, 'container', runtime);
    runtime.calls.length = 0;
    await executeDown(project, 'container', runtime, true);
    assert.ok(runtime.calls.some((call) => call.join(' ') === 'container volume delete signals_web-data'));
  });
});
