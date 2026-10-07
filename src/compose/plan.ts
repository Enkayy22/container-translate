import { resolve } from 'node:path';
import { TranslateError } from '../errors.js';
import { PROJECT_LABEL, SERVICE_LABEL, type Mount, type Project, type Service } from './model.js';
import { sanitizeName } from './names.js';

export type PlannedCommand = {
  description: string;
  argv: string[];
};

export type PlannedService = {
  service: Service;
  build?: PlannedCommand;
  run: PlannedCommand;
  image: string;
};

export type UpPlan = {
  warnings: string[];
  networks: PlannedCommand[];
  volumes: PlannedCommand[];
  services: PlannedService[];
};

export function planUp(project: Project, bin: string): UpPlan {
  const ordered = orderServices(project.services);
  const warnings = [...project.warnings];
  const usedNetworks = new Set(ordered.map((service) => service.networkName).filter(Boolean) as string[]);
  const usedVolumeKeys = new Set<string>();
  for (const service of ordered) {
    for (const mount of service.mounts) {
      if (mount.kind === 'volume' && mount.source) usedVolumeKeys.add(mount.source);
    }
  }

  const networks = project.networks
    .filter((network) => usedNetworks.has(network.name) && !network.external)
    .map((network) => ({
      description: `create network ${network.name}`,
      argv: [
        bin, 'network', 'create',
        '--label', `${PROJECT_LABEL}=${project.name}`,
        ...(network.subnet ? ['--subnet', network.subnet] : []),
        network.name,
      ],
    }));

  const volumes = project.volumes
    .filter((volume) => usedVolumeKeys.has(volume.key) && !volume.external)
    .map((volume) => ({
      description: `create volume ${volume.name}`,
      argv: [
        bin, 'volume', 'create',
        '--label', `${PROJECT_LABEL}=${project.name}`,
        volume.name,
      ],
    }));

  const services = ordered.map((service) => {
    const image = service.image || `${project.name}-${service.name}:local`;
    let build: PlannedCommand | undefined;
    if (service.build) {
      const dockerfile = service.build.dockerfile
        ? resolve(service.build.context, service.build.dockerfile)
        : undefined;
      build = {
        description: `build ${image}`,
        argv: [
          bin, 'build',
          '-t', image,
          ...Object.entries(service.build.args).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]),
          ...(dockerfile ? ['-f', dockerfile] : []),
          service.build.context,
        ],
      };
    }
    return {
      service,
      build,
      image,
      run: {
        description: `run ${service.containerName}`,
        argv: runArgv(bin, project, service, image),
      },
    };
  });

  warnHealthyDependencies(ordered, warnings);
  return { warnings, networks, volumes, services };
}

export function orderServices(services: Service[]): Service[] {
  const byName = new Map(services.map((service) => [service.name, service]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: Service[] = [];

  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new TranslateError(`depends_on cycle includes "${name}".`);
    const service = byName.get(name);
    if (!service) throw new TranslateError(`depends_on refers to unknown service "${name}".`);
    visiting.add(name);
    for (const dep of service.dependsOn) visit(dep.service);
    visiting.delete(name);
    visited.add(name);
    ordered.push(service);
  };

  for (const service of services) visit(service.name);
  return ordered;
}

export function selectServices(project: Project, names: string[], noDeps: boolean): Project {
  if (names.length === 0) return project;
  const wanted = new Set(names);
  if (!noDeps) {
    const visit = (name: string) => {
      const service = project.services.find((item) => item.name === name);
      if (!service) throw new TranslateError(`Unknown service "${name}".`);
      for (const dep of service.dependsOn) {
        if (!wanted.has(dep.service)) {
          wanted.add(dep.service);
          visit(dep.service);
        }
      }
    };
    for (const name of [...wanted]) visit(name);
  }
  const services = project.services.filter((service) => wanted.has(service.name));
  if (services.length === 0) throw new TranslateError(`None of the requested services exist: ${names.join(', ')}.`);
  return { ...project, services };
}

function runArgv(bin: string, project: Project, service: Service, image: string): string[] {
  const args = [
    bin, 'run', '-d',
    '--name', service.containerName,
    '--label', `${PROJECT_LABEL}=${project.name}`,
    '--label', `${SERVICE_LABEL}=${service.name}`,
  ];
  if (service.networkName) args.push('--network', service.networkName);
  if (service.entrypoint?.length) args.push('--entrypoint', service.entrypoint[0]);
  if (service.user) args.push('--user', service.user);
  if (service.workdir) args.push('--workdir', service.workdir);
  if (service.platform) args.push('--platform', service.platform);
  if (service.memory) args.push('--memory', service.memory);
  if (service.cpus) args.push('--cpus', service.cpus);
  if (service.shmSize) args.push('--shm-size', service.shmSize);
  if (service.readOnly) args.push('--read-only');
  if (service.init) args.push('--init');
  if (service.interactive) args.push('--interactive');
  if (service.tty) args.push('--tty');
  for (const port of service.ports) args.push('--publish', port);
  for (const item of service.environment) {
    args.push('--env', item.value === undefined ? item.key : `${item.key}=${item.value}`);
  }
  for (const dns of service.dns) args.push('--dns', dns);
  for (const cap of service.capAdd) args.push('--cap-add', cap);
  for (const cap of service.capDrop) args.push('--cap-drop', cap);
  for (const limit of service.ulimits) args.push('--ulimit', limit);
  for (const mount of service.mounts) pushMount(args, project, mount);
  for (const path of service.tmpfs) args.push('--tmpfs', path);
  args.push(image);
  const entrypointArgs = service.entrypoint?.slice(1) ?? [];
  args.push(...entrypointArgs, ...(service.command ?? []));
  return args;
}

function pushMount(args: string[], project: Project, mount: Mount): void {
  if (mount.options === 'tmpfs') {
    args.push('--tmpfs', mount.target);
    return;
  }
  if (mount.kind === 'anonymous') {
    args.push('--volume', mount.target);
    return;
  }
  const source = mount.kind === 'volume' ? volumeRuntimeName(project, mount.source || 'data') : mount.source || '';
  const spec = mount.options ? `${source}:${mount.target}:${mount.options}` : `${source}:${mount.target}`;
  args.push('--volume', spec);
}

function volumeRuntimeName(project: Project, source: string): string {
  const declared = project.volumes.find((volume) => volume.key === source);
  if (declared) return declared.name;
  return `${project.name}_${sanitizeName(source)}`;
}

function warnHealthyDependencies(services: Service[], warnings: string[]): void {
  const byName = new Map(services.map((service) => [service.name, service]));
  for (const service of services) {
    for (const dep of service.dependsOn) {
      if (dep.condition !== 'service_healthy') continue;
      const target = byName.get(dep.service);
      if (!target?.healthcheck) {
        warnings.push(
          `Service "${service.name}" waits for "${dep.service}" to be healthy, but that service has no healthcheck.`,
        );
      }
    }
  }
}
