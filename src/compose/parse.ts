import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseDurationMs, parseGraceSeconds } from '../duration.js';
import { interpolateTree, loadDotEnv } from '../env.js';
import { TranslateError } from '../errors.js';
import type {
  BuildSpec,
  DependsCondition,
  EnvVar,
  Healthcheck,
  Mount,
  NetworkSpec,
  Project,
  Service,
  VolumeSpec,
} from './model.js';
import { defaultProjectName, isBindSource, resolveHostPath, sanitizeName, splitCommand } from './names.js';

type Raw = Record<string, unknown>;

const KNOWN_SERVICE_KEYS = new Set([
  'image', 'build', 'container_name', 'ports', 'environment', 'env_file', 'command',
  'entrypoint', 'volumes', 'depends_on', 'healthcheck', 'restart', 'networks', 'user',
  'working_dir', 'tmpfs', 'labels', 'dns', 'platform', 'cap_add', 'cap_drop', 'read_only',
  'shm_size', 'init', 'profiles', 'stdin_open', 'tty', 'ulimits', 'mem_limit', 'cpus',
  'stop_grace_period', 'stop_signal', 'expose', 'hostname', 'extra_hosts', 'privileged',
  'devices', 'deploy', 'logging', 'sysctls', 'name',
]);

const IGNORED_WITH_WARNING = new Set([
  'hostname', 'extra_hosts', 'privileged', 'devices', 'deploy', 'logging', 'sysctls',
]);

export type ParseOptions = {
  projectName?: string;
  profiles?: string[];
  env?: Record<string, string>;
};

export function parseCompose(filePaths: string[], options: ParseOptions = {}): Project {
  if (filePaths.length === 0) throw new TranslateError('No compose file was given.');
  const resolved = filePaths.map((file) => resolve(file));
  for (const file of resolved) {
    if (!existsSync(file)) throw new TranslateError(`Compose file not found: ${file}`);
  }

  const composeDir = dirname(resolved[0]);
  const fileEnv = loadDotEnv(resolve(composeDir, '.env'));
  const env = { ...fileEnv, ...cleanEnv(process.env), ...options.env };
  let raw: Raw = {};
  for (const file of resolved) {
    const parsed = parseYaml(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TranslateError(`${file} is not a compose mapping.`);
    }
    raw = mergeRaw(raw, parsed as Raw);
  }
  raw = interpolateTree(raw, env) as Raw;

  if (raw.include) {
    throw new TranslateError('compose include is not translated. Merge the files with repeated -f instead.');
  }

  const warnings: string[] = [];
  if (raw.configs) warnings.push('configs are not translated and were ignored.');
  if (raw.secrets) warnings.push('secrets are not translated and were ignored.');

  const projectName = sanitizeName(options.projectName || stringValue(raw.name) || defaultProjectName(resolved));
  const namedVolumeKeys = new Set(Object.keys(asRecord(raw.volumes)));
  const declaredNetworks = parseNetworks(asRecord(raw.networks), projectName);
  const volumes = parseVolumes(asRecord(raw.volumes), projectName);
  const defaultNetwork = declaredNetworks.find((network) => network.key === 'default')?.name ?? `${projectName}_default`;
  const networks = declaredNetworks.some((network) => network.name === defaultNetwork)
    ? declaredNetworks
    : [{ key: 'default', name: defaultNetwork, external: false }, ...declaredNetworks];
  const services = parseServices(asRecord(raw.services), {
    composeDir,
    env,
    profiles: new Set(options.profiles ?? []),
    namedVolumeKeys,
    networks,
    defaultNetwork,
    warnings,
  });

  if (services.length === 0) {
    throw new TranslateError('The compose file has no services to start for the selected profiles.');
  }

  return {
    name: projectName,
    composeDir,
    filePaths: resolved,
    services,
    networks,
    volumes,
    warnings,
  };
}

export function discoverComposeFiles(cwd: string): string[] {
  for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return [candidate];
  }
  throw new TranslateError(
    `No compose file in ${cwd}. Pass -f docker-compose.yml (or compose.yaml).`,
  );
}

function parseServices(
  rawServices: Raw,
  ctx: {
    composeDir: string;
    env: Record<string, string>;
    profiles: Set<string>;
    namedVolumeKeys: Set<string>;
    networks: NetworkSpec[];
    defaultNetwork: string;
    warnings: string[];
  },
): Service[] {
  const services: Service[] = [];
  for (const [name, value] of Object.entries(rawServices)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TranslateError(`Service "${name}" is not a mapping.`);
    }
    const raw = value as Raw;
    if (raw.extends) {
      throw new TranslateError(`Service "${name}" uses extends, which is not translated.`);
    }
    const profiles = stringList(raw.profiles);
    if (profiles.length > 0 && !profiles.some((profile) => ctx.profiles.has(profile))) continue;

    for (const key of Object.keys(raw)) {
      if (!KNOWN_SERVICE_KEYS.has(key)) {
        ctx.warnings.push(`Service "${name}" key "${key}" is not translated and was ignored.`);
      } else if (IGNORED_WITH_WARNING.has(key) && raw[key] !== undefined && raw[key] !== false) {
        ctx.warnings.push(`Service "${name}" key "${key}" has no Apple Container equivalent and was ignored.`);
      }
    }

    const restart = stringValue(raw.restart);
    if (restart && restart !== 'no' && restart !== '"no"') {
      ctx.warnings.push(
        `Service "${name}" restart policy "${restart}" was ignored. Apple Container does not restart exited VMs.`,
      );
    }

    const containerName = sanitizeName(stringValue(raw.container_name) || name);
    if (stringValue(raw.container_name) && stringValue(raw.container_name) !== name) {
      ctx.warnings.push(
        `Service "${name}" container_name is "${containerName}". Other containers reach it by that name, because Apple Container DNS uses the container name.`,
      );
    }

    const build = parseBuild(raw.build, ctx.composeDir);
    const image = stringValue(raw.image);
    if (!image && !build) {
      throw new TranslateError(`Service "${name}" needs an image or a build.`);
    }

    services.push({
      name,
      image,
      build,
      containerName,
      ports: parsePorts(raw.ports, name),
      environment: parseEnvironment(raw.environment, raw.env_file, ctx.composeDir, ctx.env),
      command: parseCommand(raw.command),
      entrypoint: parseCommand(raw.entrypoint),
      mounts: parseMounts(raw.volumes, ctx.composeDir, ctx.namedVolumeKeys, name),
      tmpfs: parseTmpfs(raw.tmpfs),
      dependsOn: parseDependsOn(raw.depends_on, name),
      healthcheck: parseHealthcheck(raw.healthcheck),
      restart,
      networkName: parseServiceNetwork(raw.networks, ctx.networks, ctx.defaultNetwork, name, ctx.warnings),
      user: stringValue(raw.user),
      workdir: stringValue(raw.working_dir),
      dns: stringList(raw.dns),
      platform: stringValue(raw.platform),
      capAdd: stringList(raw.cap_add),
      capDrop: stringList(raw.cap_drop),
      readOnly: raw.read_only === true,
      shmSize: stringValue(raw.shm_size),
      init: raw.init === true,
      tty: raw.tty === true,
      interactive: raw.stdin_open === true,
      memory: stringValue(raw.mem_limit),
      cpus: raw.cpus === undefined ? undefined : String(raw.cpus),
      ulimits: parseUlimits(raw.ulimits),
      stopSignal: stringValue(raw.stop_signal),
      stopGraceSeconds: parseGraceSeconds(
        typeof raw.stop_grace_period === 'number' || typeof raw.stop_grace_period === 'string'
          ? raw.stop_grace_period
          : undefined,
      ),
    });
  }
  return services;
}

function parseBuild(value: unknown, composeDir: string): BuildSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { context: resolveHostPath(value, composeDir), args: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Raw;
  const context = stringValue(raw.context) || '.';
  const args: Record<string, string> = {};
  if (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) {
    for (const [key, item] of Object.entries(raw.args)) args[key] = item === null || item === undefined ? '' : String(item);
  } else if (Array.isArray(raw.args)) {
    for (const item of raw.args) {
      const [key, ...rest] = String(item).split('=');
      args[key] = rest.join('=');
    }
  }
  return {
    context: resolveHostPath(context, composeDir),
    dockerfile: stringValue(raw.dockerfile),
    args,
  };
}

function parsePorts(value: unknown, service: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TranslateError(`Service "${service}" ports must be a list.`);
  return value.map((item) => {
    if (typeof item === 'string' || typeof item === 'number') return String(item);
    if (!item || typeof item !== 'object') {
      throw new TranslateError(`Service "${service}" has a port that is not a string or mapping.`);
    }
    const raw = item as Raw;
    const target = raw.target;
    const published = raw.published ?? target;
    const hostIp = stringValue(raw.host_ip);
    const protocol = stringValue(raw.protocol);
    const mapping = `${hostIp ? `${hostIp}:` : ''}${published}:${target}`;
    return protocol ? `${mapping}/${protocol}` : mapping;
  });
}

function parseEnvironment(
  value: unknown,
  envFile: unknown,
  composeDir: string,
  env: Record<string, string>,
): EnvVar[] {
  const fromFiles: EnvVar[] = [];
  for (const file of stringList(envFile)) {
    const loaded = loadDotEnv(isAbsolute(file) ? file : resolve(composeDir, file));
    for (const [key, item] of Object.entries(loaded)) fromFiles.push({ key, value: item });
  }
  const direct: EnvVar[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = String(item);
      const eq = text.indexOf('=');
      if (eq === -1) direct.push({ key: text, value: env[text] });
      else direct.push({ key: text.slice(0, eq), value: text.slice(eq + 1) });
    }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) direct.push({ key, value: env[key] });
      else direct.push({ key, value: String(item) });
    }
  }
  const merged = new Map<string, EnvVar>();
  for (const item of [...fromFiles, ...direct]) merged.set(item.key, item);
  return [...merged.values()];
}

function parseCommand(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return splitCommand(value);
  return undefined;
}

function parseMounts(value: unknown, composeDir: string, namedVolumeKeys: Set<string>, service: string): Mount[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TranslateError(`Service "${service}" volumes must be a list.`);
  return value.map((item) => {
    if (typeof item === 'string') return parseShortMount(item, composeDir, namedVolumeKeys);
    if (!item || typeof item !== 'object') {
      throw new TranslateError(`Service "${service}" has a volume that is not a string or mapping.`);
    }
    const raw = item as Raw;
    const type = stringValue(raw.type) || 'volume';
    const target = stringValue(raw.target) || stringValue(raw.destination);
    if (!target) throw new TranslateError(`Service "${service}" has a volume without a target.`);
    if (type === 'tmpfs') return { kind: 'anonymous', target, options: 'tmpfs' };
    const source = stringValue(raw.source);
    const options = raw.read_only === true ? 'ro' : undefined;
    if (type === 'bind') {
      if (!source) throw new TranslateError(`Service "${service}" has a bind mount without a source.`);
      return { kind: 'bind', source: resolveHostPath(source, composeDir), target, options };
    }
    if (!source) return { kind: 'anonymous', target, options };
    return { kind: 'volume', source, target, options };
  });
}

function parseShortMount(spec: string, composeDir: string, namedVolumeKeys: Set<string>): Mount {
  const parts = spec.split(':');
  if (parts.length === 1) return { kind: 'anonymous', target: parts[0] };
  const options = parts.length > 2 ? parts.slice(2).join(':') : undefined;
  const source = parts[0];
  const target = parts[1];
  if (namedVolumeKeys.has(source) || !isBindSource(source)) {
    return { kind: 'volume', source, target, options };
  }
  return { kind: 'bind', source: resolveHostPath(source, composeDir), target, options };
}

function parseTmpfs(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function parseDependsOn(value: unknown, service: string): Service['dependsOn'] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((item) => ({ service: String(item), condition: 'service_started' as const }));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([dep, spec]) => {
      const condition = spec && typeof spec === 'object'
        ? stringValue((spec as Raw).condition) || 'service_started'
        : 'service_started';
      if (
        condition !== 'service_started' &&
        condition !== 'service_healthy' &&
        condition !== 'service_completed_successfully'
      ) {
        throw new TranslateError(`Service "${service}" has unknown depends_on condition "${condition}".`);
      }
      return { service: dep, condition: condition as DependsCondition };
    });
  }
  throw new TranslateError(`Service "${service}" depends_on must be a list or mapping.`);
}

function parseHealthcheck(value: unknown): Healthcheck | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Raw;
  if (raw.disable === true) return undefined;
  const test = parseHealthTest(raw.test);
  if (!test) return undefined;
  return {
    test,
    intervalMs: parseDurationMs(asDuration(raw.interval), 30_000),
    timeoutMs: parseDurationMs(asDuration(raw.timeout), 30_000),
    retries: typeof raw.retries === 'number' ? raw.retries : 3,
    startPeriodMs: parseDurationMs(asDuration(raw.start_period), 0),
  };
}

function parseHealthTest(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    if (value[0] === 'CMD-SHELL') return ['sh', '-c', value.slice(1).join(' ')];
    if (value[0] === 'CMD') return value.slice(1).map(String);
    if (value[0] === 'NONE') return undefined;
    return value.map(String);
  }
  if (typeof value === 'string') {
    const stripped = value.replace(/^CMD-SHELL\s+/, '').replace(/^CMD\s+/, '');
    return ['sh', '-c', stripped];
  }
  return undefined;
}

function parseServiceNetwork(
  value: unknown,
  networks: NetworkSpec[],
  defaultNetwork: string,
  service: string,
  warnings: string[],
): string {
  if (value === undefined) return defaultNetwork;
  const names = Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item : String(item)))
    : value && typeof value === 'object'
      ? Object.keys(value)
      : [];
  if (names.length === 0) return defaultNetwork;
  if (names.length > 1) {
    warnings.push(
      `Service "${service}" joins ${names.join(', ')}. Apple Container attaches one network, so only "${names[0]}" is used.`,
    );
  }
  const spec = networks.find((network) => network.key === names[0] || network.name === names[0]);
  return spec?.name ?? `${defaultNetwork.split('_')[0]}_${sanitizeName(names[0])}`;
}

function parseNetworks(value: Raw, projectName: string): NetworkSpec[] {
  return Object.entries(value).map(([key, spec]) => {
    const raw = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec as Raw : {};
    const external = raw.external === true;
    const subnet = firstSubnet(raw.ipam);
    return {
      key,
      name: stringValue(raw.name) || (key === 'default' ? `${projectName}_default` : `${projectName}_${sanitizeName(key)}`),
      external,
      subnet,
    };
  });
}

function parseVolumes(value: Raw, projectName: string): VolumeSpec[] {
  return Object.entries(value).map(([key, spec]) => {
    const raw = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec as Raw : {};
    return {
      key,
      name: stringValue(raw.name) || `${projectName}_${sanitizeName(key)}`,
      external: raw.external === true,
    };
  });
}

function parseUlimits(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, spec]) => {
    if (typeof spec === 'number' || typeof spec === 'string') return `${key}=${spec}`;
    if (spec && typeof spec === 'object') {
      const raw = spec as Raw;
      const soft = raw.soft ?? '';
      const hard = raw.hard ?? soft;
      return `${key}=${soft}:${hard}`;
    }
    return `${key}=${String(spec)}`;
  });
}

function firstSubnet(ipam: unknown): string | undefined {
  if (!ipam || typeof ipam !== 'object') return undefined;
  const config = (ipam as Raw).config;
  if (!Array.isArray(config) || !config[0] || typeof config[0] !== 'object') return undefined;
  return stringValue((config[0] as Raw).subnet);
}

function asDuration(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function stringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

function asRecord(value: unknown): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Raw;
}

function mergeRaw(base: Raw, extra: Raw): Raw {
  const out: Raw = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    if (isRecord(current) && isRecord(value)) out[key] = mergeRaw(current, value);
    else out[key] = value;
  }
  return out;
}

function isRecord(value: unknown): value is Raw {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
