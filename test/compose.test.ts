import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parseCompose } from '../src/compose/parse.js';
import { planUp, selectServices } from '../src/compose/plan.js';
import { TranslateError } from '../src/errors.js';

const fixtures = join(process.cwd(), 'test/fixtures');

function planFile(name: string) {
  const project = parseCompose([join(fixtures, name)]);
  return { project, plan: planUp(project, 'container') };
}

function runArgs(plan: ReturnType<typeof planUp>, containerName: string): string[] {
  const service = plan.services.find((item) => item.service.containerName === containerName);
  assert.ok(service, `missing ${containerName}`);
  return service.run.argv;
}

describe('compose translation', () => {
  it('plans postgres as a named container, volume, network, and published port', () => {
    const { project, plan } = planFile('docker-compose.postgresql.yaml');
    assert.equal(project.name, 'postgresql');
    assert.deepEqual(plan.networks[0].argv, [
      'container', 'network', 'create',
      '--label', 'dev.container-translate.project=postgresql',
      'postgresql_default',
    ]);
    assert.deepEqual(plan.volumes[0].argv.slice(-1), ['postgresql_postgres-data']);
    const argv = runArgs(plan, 'db');
    assert.ok(argv.includes('--publish'));
    assert.ok(argv.includes('5432:5432'));
    assert.ok(argv.includes('--env'));
    assert.ok(argv.includes('POSTGRES_DB=app'));
    assert.ok(argv.includes('--volume'));
    assert.ok(argv.includes('postgresql_postgres-data:/var/lib/postgresql/data'));
    assert.equal(argv.at(-1), 'postgres:15-alpine');
    assert.ok(project.warnings.some((warning) => warning.includes('container_name')));
    assert.equal(argv.some((arg) => arg.includes('docker.sock')), false);
  });

  it('starts kafka after zookeeper and keeps service DNS names', () => {
    const { plan } = planFile('docker-compose.kafka.yml');
    assert.deepEqual(
      plan.services.map((service) => service.service.containerName),
      ['zookeeper', 'kafka', 'kafka-ui'],
    );
    const kafka = runArgs(plan, 'kafka');
    assert.ok(kafka.includes('KAFKA_ZOOKEEPER_CONNECT=zookeeper:2181'));
    assert.ok(kafka.includes('--network'));
    assert.ok(kafka.includes('kafka_default'));
    assert.ok(kafka.includes('9092:9092'));
    const ui = runArgs(plan, 'kafka-ui');
    const config = ui.find((arg) => arg.startsWith('AKHQ_CONFIGURATION='));
    assert.ok(config);
    assert.match(config, /bootstrap\.servers: "kafka:29092"/);
  });

  it('passes the redis command and named volume through', () => {
    const { plan } = planFile('docker-compose.redis.yml');
    const argv = runArgs(plan, 'redis');
    assert.deepEqual(argv.slice(-4), ['redis:7-alpine', 'redis-server', '--appendonly', 'yes']);
    assert.ok(argv.includes('redis_redis-data:/data'));
    assert.ok(argv.includes('6379:6379'));
  });

  it('publishes statsd tcp and udp ports and warns that restart is ignored', () => {
    const { project, plan } = planFile('docker-compose.statsd.yml');
    const argv = runArgs(plan, 'statsd');
    assert.ok(argv.includes('9102:9102/tcp'));
    assert.ok(argv.includes('9125:9125/udp'));
    assert.ok(project.warnings.some((warning) => warning.includes('restart')));
  });

  it('gives each compose file its own project name', () => {
    const postgres = parseCompose([join(fixtures, 'docker-compose.postgresql.yaml')]);
    const kafka = parseCompose([join(fixtures, 'docker-compose.kafka.yml')]);
    assert.equal(postgres.name, 'postgresql');
    assert.equal(kafka.name, 'kafka');
    assert.notEqual(postgres.services[0].networkName, kafka.services[0].networkName);
  });

  it('interpolates ${VAR:-default} and rejects depends_on cycles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-compose-'));
    writeFileSync(join(dir, 'compose.yml'), [
      'services:',
      '  web:',
      '    image: nginx:${CT_TEST_TAG:-1.27}',
      '    environment:',
      '      GREETING: ${CT_TEST_GREETING:-hello}',
    ].join('\n'));
    const project = parseCompose([join(dir, 'compose.yml')], { env: {} });
    assert.equal(project.services[0].image, 'nginx:1.27');
    assert.deepEqual(project.services[0].environment, [{ key: 'GREETING', value: 'hello' }]);

    writeFileSync(join(dir, 'cycle.yml'), [
      'services:',
      '  a:',
      '    image: alpine',
      '    depends_on: [b]',
      '  b:',
      '    image: alpine',
      '    depends_on: [a]',
    ].join('\n'));
    assert.throws(() => planUp(parseCompose([join(dir, 'cycle.yml')]), 'container'), TranslateError);
  });

  it('builds from a dockerfile and build-args when the service has no image', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-compose-'));
    writeFileSync(join(dir, 'compose.yml'), [
      'services:',
      '  web:',
      '    build:',
      '      context: .',
      '      dockerfile: Dockerfile',
      '      args:',
      '        FOO: bar',
    ].join('\n'));
    const plan = planUp(parseCompose([join(dir, 'compose.yml')], { projectName: 'demo' }), 'container');
    const planned = plan.services[0];
    assert.equal(planned.image, 'demo-web:local');
    assert.deepEqual(planned.build?.argv, [
      'container', 'build',
      '-t', 'demo-web:local',
      '--build-arg', 'FOO=bar',
      '-f', resolve(dir, 'Dockerfile'),
      dir,
    ]);
  });

  it('passes entrypoint, env files, bind mounts, and tmpfs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-compose-'));
    writeFileSync(join(dir, '.env'), 'CT_FIXTURE_IMAGE=alpine:3.20\n');
    writeFileSync(join(dir, '.env.web'), [
      'FROM_FILE="from-file"',
      'ONLY_FILE=kept',
    ].join('\n'));
    writeFileSync(join(dir, 'compose.yml'), [
      'services:',
      '  web:',
      '    image: ${CT_FIXTURE_IMAGE}',
      '    entrypoint: ["/bin/sh", "-c"]',
      '    command: echo hi',
      '    env_file: .env.web',
      '    environment:',
      '      FROM_FILE: overridden',
      '      ONLY_DIRECT: yes',
      '    volumes:',
      '      - ./data:/var/data:ro',
      '      - /tmp/host:/var/host',
      '    tmpfs:',
      '      - /run/lock',
    ].join('\n'));
    delete process.env.CT_FIXTURE_IMAGE;
    const project = parseCompose([join(dir, 'compose.yml')], { projectName: 'demo' });
    assert.equal(project.services[0].image, 'alpine:3.20');
    assert.deepEqual(
      Object.fromEntries(project.services[0].environment.map((item) => [item.key, item.value])),
      { ONLY_FILE: 'kept', FROM_FILE: 'overridden', ONLY_DIRECT: 'yes' },
    );
    const argv = planUp(project, 'container').services[0].run.argv;
    assert.equal(argv[argv.indexOf('--entrypoint') + 1], '/bin/sh');
    assert.deepEqual(argv.slice(-4), ['alpine:3.20', '-c', 'echo', 'hi']);
    assert.ok(argv.includes(`${resolve(dir, 'data')}:/var/data:ro`));
    assert.ok(argv.includes('/tmp/host:/var/host'));
    assert.ok(argv.includes('/run/lock'));
  });

  it('warns on engine-only keys and rejects include and extends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-compose-'));
    const file = join(dir, 'compose.yml');
    writeFileSync(file, [
      'services:',
      '  web:',
      '    image: alpine',
      '    privileged: true',
      '    devices:',
      '      - /dev/kvm',
      '    deploy:',
      '      replicas: 2',
      '    extra_hosts:',
      '      - "db:1.2.3.4"',
    ].join('\n'));
    const project = parseCompose([file], { projectName: 'demo' });
    for (const key of ['privileged', 'devices', 'deploy', 'extra_hosts']) {
      assert.ok(project.warnings.some((warning) => warning.includes(`"${key}"`)), key);
    }

    writeFileSync(file, [
      'include:',
      '  - other.yml',
      'services:',
      '  web:',
      '    image: alpine',
    ].join('\n'));
    assert.throws(() => parseCompose([file]), /include is not translated/);

    writeFileSync(file, [
      'services:',
      '  web:',
      '    image: alpine',
      '    extends:',
      '      service: base',
    ].join('\n'));
    assert.throws(() => parseCompose([file]), /extends/);
  });

  it('warns when service_healthy has no healthcheck and applies -p', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-compose-'));
    const file = join(dir, 'compose.yml');
    writeFileSync(file, [
      'services:',
      '  db:',
      '    image: postgres:15',
      '  app:',
      '    image: alpine',
      '    depends_on:',
      '      db:',
      '        condition: service_healthy',
    ].join('\n'));
    const missing = planUp(parseCompose([file], { projectName: 'custom' }), 'container');
    assert.equal(missing.services[0].service.networkName, 'custom_default');
    assert.ok(missing.warnings.some((warning) => warning.includes('healthy')));

    writeFileSync(file, [
      'services:',
      '  db:',
      '    image: postgres:15',
      '    healthcheck:',
      '      test: ["CMD", "pg_isready"]',
      '  app:',
      '    image: alpine',
      '    depends_on:',
      '      db:',
      '        condition: service_healthy',
    ].join('\n'));
    const ready = planUp(parseCompose([file], { projectName: 'custom' }), 'container');
    assert.equal(ready.warnings.some((warning) => warning.includes('healthy')), false);

    writeFileSync(file, [
      'services:',
      '  app:',
      '    image: alpine',
      '    depends_on:',
      '      db:',
      '        condition: service_started_soon',
    ].join('\n'));
    assert.throws(() => parseCompose([file]), /unknown depends_on condition/);
  });

  it('skips unselected profiles, merges repeated -f files, and can drop dependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-compose-'));
    const base = join(dir, 'base.yml');
    const extra = join(dir, 'extra.yml');
    writeFileSync(base, [
      'services:',
      '  web:',
      '    image: nginx:1',
      '    environment:',
      '      A: "1"',
      '  debug:',
      '    image: alpine',
      '    profiles: [debug]',
      '  app:',
      '    image: alpine',
      '    depends_on: [web]',
    ].join('\n'));
    writeFileSync(extra, [
      'services:',
      '  web:',
      '    image: nginx:2',
      '    environment:',
      '      B: "2"',
    ].join('\n'));

    const quiet = parseCompose([base], { projectName: 'demo' });
    assert.deepEqual(quiet.services.map((service) => service.name), ['web', 'app']);
    const debug = parseCompose([base], { projectName: 'demo', profiles: ['debug'] });
    assert.deepEqual(debug.services.map((service) => service.name), ['web', 'debug', 'app']);

    const merged = parseCompose([base, extra], { projectName: 'demo' });
    const web = merged.services.find((service) => service.name === 'web');
    assert.equal(web?.image, 'nginx:2');
    assert.deepEqual(
      Object.fromEntries((web?.environment ?? []).map((item) => [item.key, item.value])),
      { A: '1', B: '2' },
    );

    const alone = selectServices(quiet, ['app'], true);
    assert.deepEqual(alone.services.map((service) => service.name), ['app']);
    assert.deepEqual(alone.services[0].dependsOn, []);
    assert.deepEqual(selectServices(quiet, ['app'], false).services.map((service) => service.name), ['web', 'app']);
    assert.throws(() => selectServices(quiet, ['missing'], false), /Unknown service/);
    assert.throws(() => selectServices(quiet, ['missing'], true), /None of the requested services exist/);
  });
});
