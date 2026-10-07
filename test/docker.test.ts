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

  it('deletes containers and drops privileged and healthcheck flags', () => {
    assert.deepEqual(argvOf(['rm', '-f', 'db']), [
      'container', 'delete', '--force', 'db',
    ]);
    const translated = translateDocker([
      'run', '--privileged', '--health-cmd', 'pg_isready', '--health-interval', '5s', 'postgres:15',
    ], 'container');
    assert.equal(translated.kind, 'exec');
    if (translated.kind !== 'exec') return;
    assert.deepEqual(translated.argv, ['container', 'run', 'postgres:15']);
    assert.ok(translated.warnings.some((warning) => warning.includes('--privileged')));
    assert.ok(translated.warnings.some((warning) => warning.includes('--health-cmd')));
    assert.ok(translated.warnings.some((warning) => warning.includes('--health-interval')));
  });

  it('maps the remaining translated verbs', () => {
    assert.deepEqual(argvOf(['build', '-t', 'app:1', '-f', 'Dockerfile', '.']), [
      'container', 'build', '--tag', 'app:1', '--file', 'Dockerfile', '.',
    ]);
    assert.deepEqual(argvOf(['push', 'app:1']), ['container', 'image', 'push', 'app:1']);
    assert.deepEqual(argvOf(['start', '-a', 'db']), ['container', 'start', '--attach', 'db']);
    assert.deepEqual(argvOf(['stop', '-t', '10', 'db']), ['container', 'stop', '--time', '10', 'db']);
    assert.deepEqual(argvOf(['kill', '-s', 'SIGTERM', 'db']), ['container', 'kill', '--signal', 'SIGTERM', 'db']);
    assert.deepEqual(argvOf(['cp', 'db:/etc/hosts', './hosts']), ['container', 'copy', 'db:/etc/hosts', './hosts']);
    assert.deepEqual(argvOf(['inspect', 'db']), ['container', 'inspect', 'db']);
    assert.deepEqual(argvOf(['login', 'ghcr.io']), ['container', 'registry', 'login', 'ghcr.io']);
    assert.deepEqual(argvOf(['create', '--name', 'job', 'alpine', 'echo', 'hi']), [
      'container', 'create', '--name', 'job', 'alpine', 'echo', 'hi',
    ]);
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

  it('parses project, profiles, repeated files, and the remaining commands', () => {
    assert.deepEqual(parseComposeArgs([
      '-p', 'demo',
      '--profile', 'debug',
      '-f', 'a.yml',
      '-f', 'b.yml',
      'up',
      '--dry-run',
      '--force-recreate',
      '--remove-orphans',
      '--no-deps',
      'web',
    ]), {
      files: ['a.yml', 'b.yml'],
      projectName: 'demo',
      profiles: ['debug'],
      command: 'up',
      services: ['web'],
      dryRun: true,
      detach: false,
      removeVolumes: false,
      follow: false,
      forceRecreate: true,
      removeOrphans: true,
      noDeps: true,
      help: false,
    });

    const down = parseComposeArgs(['down', '-v']);
    assert.equal(down.command, 'down');
    assert.equal(down.removeVolumes, true);

    for (const command of ['stop', 'start', 'restart', 'pull', 'ps', 'config', 'plan']) {
      assert.equal(parseComposeArgs([command]).command, command);
    }

    const logs = parseComposeArgs(['logs', '--tail', '20', '-f', 'kafka']);
    assert.equal(logs.follow, true);
    assert.equal(logs.tail, '20');
    assert.deepEqual(logs.services, ['kafka']);

    assert.deepEqual(parseComposeArgs(['exec', 'web', 'sh', '-c', 'true']).services, ['web', 'sh', '-c', 'true']);
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
