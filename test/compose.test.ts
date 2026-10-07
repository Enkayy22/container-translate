import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseCompose } from '../src/compose/parse.js';
import { planUp } from '../src/compose/plan.js';
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
});
