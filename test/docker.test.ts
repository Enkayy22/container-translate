import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseComposeArgs } from '../src/cli.js';
import { translateDocker, type DockerTranslation } from '../src/docker/translate.js';
import { SOCKET_EXPLANATION, SUDO_EXPLANATION } from '../src/doctor.js';

function argvOf(args: string[]): string[] {
  const translated = translateDocker(args, 'container');
  assert.equal(translated.kind, 'exec');
  return (translated as Extract<DockerTranslation, { kind: 'exec' }>).argv;
}

describe('docker shim', () => {
  it('maps the commands the old wrapper got wrong', () => {
    assert.deepEqual(translateDocker(['ps', '-a'], 'container'), {
      kind: 'exec',
      argv: ['container', 'ls', '--all'],
      warnings: [],
    });
    assert.deepEqual(argvOf(['images', '-q']), [
      'container', 'image', 'ls', '--quiet',
    ]);
    assert.deepEqual(argvOf(['pull', 'postgres:15-alpine']), [
      'container', 'image', 'pull', 'postgres:15-alpine',
    ]);
    assert.deepEqual(argvOf(['rmi', '-f', 'postgres:15']), [
      'container', 'image', 'delete', '--force', 'postgres:15',
    ]);
    assert.deepEqual(argvOf(['volume', 'ls']), [
      'container', 'volume', 'list',
    ]);
    assert.deepEqual(argvOf(['network', 'rm', 'demo']), [
      'container', 'network', 'delete', 'demo',
    ]);
  });

  it('strips engine-only run flags and keeps publish, name, and detach', () => {
    const translated = translateDocker([
      'run', '-d', '--name', 'db', '--restart', 'always', '-p', '5432:5432', '-e', 'POSTGRES_PASSWORD=app-secret', 'postgres:15',
    ], 'container');
    assert.equal(translated.kind, 'exec');
    if (translated.kind !== 'exec') return;
    assert.deepEqual(translated.argv, [
      'container', 'run', '--detach', '--name', 'db', '--publish', '5432:5432',
      '--env', 'POSTGRES_PASSWORD=app-secret', 'postgres:15',
    ]);
    assert.equal(translated.warnings.length, 1);
  });

  it('sends compose to the translator instead of container compose', () => {
    const translated = translateDocker(['compose', '-f', 'docker-compose.kafka.yml', 'up', '-d'], 'container');
    assert.deepEqual(translated, {
      kind: 'compose',
      args: ['-f', 'docker-compose.kafka.yml', 'up', '-d'],
      warnings: [],
    });
  });

  it('maps logs --tail and exec -it', () => {
    assert.deepEqual(argvOf(['logs', '-f', '--tail', '50', 'db']), [
      'container', 'logs', '--follow', '-n', '50', 'db',
    ]);
    assert.deepEqual(argvOf(['exec', '-it', 'db', 'sh']), [
      'container', 'exec', '--interactive', '--tty', 'db', 'sh',
    ]);
  });

  it('refuses commands that require the Docker Engine API', () => {
    const translated = translateDocker(['swarm', 'init'], 'container');
    assert.equal(translated.kind, 'error');
  });
});

describe('compose argv', () => {
  it('parses the makefile form and keeps log follow separate from -f', () => {
    assert.deepEqual(parseComposeArgs(['-f', 'docker-compose.postgresql.yaml', 'up', '-d']), {
      files: ['docker-compose.postgresql.yaml'],
      profiles: [],
      command: 'up',
      services: [],
      dryRun: false,
      detach: true,
      removeVolumes: false,
      follow: false,
      forceRecreate: false,
      removeOrphans: false,
      noDeps: false,
      help: false,
    });
    const logs = parseComposeArgs(['-f', 'docker-compose.kafka.yml', 'logs', '-f', 'kafka']);
    assert.equal(logs.command, 'logs');
    assert.equal(logs.follow, true);
    assert.deepEqual(logs.files, ['docker-compose.kafka.yml']);
    assert.deepEqual(logs.services, ['kafka']);
  });
});

describe('failure explanations', () => {
  it('names the socket protocol mismatch and the sudo secure_path bypass', () => {
    assert.match(SOCKET_EXPLANATION, /docker\.sock/);
    assert.match(SOCKET_EXPLANATION, /different protocols/);
    assert.match(SUDO_EXPLANATION, /secure_path/);
    assert.match(SUDO_EXPLANATION, /without sudo/);
  });
});
