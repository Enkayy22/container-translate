import { formatCommand } from '../quote.js';
import type { Runtime } from '../runtime.js';
import { TranslateError } from '../errors.js';
import type { Project, Service } from './model.js';
import { planUp, type UpPlan } from './plan.js';
import { readState, removeState, writeState, type ProjectState, type ServiceState } from './state.js';

const MISSING = /not found|no such|does not exist|unknown container/i;
const EXISTS = /already exists/i;

export type UpOptions = {
  dryRun?: boolean;
  forceRecreate?: boolean;
  removeOrphans?: boolean;
};

export async function executeUp(project: Project, bin: string, runtime: Runtime, options: UpOptions = {}): Promise<UpPlan> {
  const plan = planUp(project, bin);
  for (const warning of plan.warnings) console.error(`warning: ${warning}`);
  if (options.dryRun) {
    for (const command of allCommands(plan)) console.log(formatCommand(command.argv));
    return plan;
  }

  await ensureSystem(bin, runtime);
  for (const command of [...plan.networks, ...plan.volumes]) {
    await runAllowing(runtime, command.argv, EXISTS);
  }

  const previous = options.removeOrphans ? readState(project.name) : null;
  const started: ServiceState[] = [];
  for (const planned of plan.services) {
    if (options.forceRecreate) await removeContainer(bin, runtime, planned.service.containerName);
    if (planned.build) await runRequired(runtime, planned.build.argv);
    console.error(`+ ${formatCommand(planned.run.argv)}`);
    const result = await runtime.run(planned.run.argv, { inherit: true });
    if (result.code !== 0) {
      throw new TranslateError(`container run failed for ${planned.service.containerName} (exit ${result.code}).`);
    }
    started.push(serviceState(planned.service));
    writeState(projectState(project, plan, started));
    await waitIfHealthy(project, bin, runtime, planned.service);
  }

  if (previous) await removeRecordedOrphans(bin, runtime, previous, started);
  return plan;
}

export async function executeDown(
  project: Project,
  bin: string,
  runtime: Runtime,
  removeVolumes: boolean,
): Promise<void> {
  const state = readState(project.name);
  const services = state?.services?.length
    ? relevantServices(state, project)
    : project.services.map(serviceState);
  if (services.length === 0 && !state) {
    throw new TranslateError(`No running stack recorded for project "${project.name}".`);
  }

  for (const service of [...services].reverse()) {
    const stop = [bin, 'stop'];
    if (service.stopSignal) stop.push('--signal', service.stopSignal);
    if (service.stopGraceSeconds) stop.push('--time', String(service.stopGraceSeconds));
    stop.push(service.containerName);
    await runAllowing(runtime, stop, MISSING);
    await runAllowing(runtime, [bin, 'delete', '--force', service.containerName], MISSING);
  }

  const network = state?.network ?? project.services[0]?.networkName;
  if (network) await runAllowing(runtime, [bin, 'network', 'delete', network], MISSING);

  if (removeVolumes) {
    const volumes = state?.volumes ?? [];
    for (const volume of volumes) await runAllowing(runtime, [bin, 'volume', 'delete', volume], MISSING);
  }

  const remaining = (state?.services ?? []).filter(
    (service) => !services.some((removed) => removed.containerName === service.containerName),
  );
  if (remaining.length === 0) removeState(project.name);
  else if (state) writeState({ ...state, services: remaining, volumes: removeVolumes ? [] : state.volumes });
}

export async function executeStop(project: Project, bin: string, runtime: Runtime): Promise<void> {
  for (const service of [...containersOf(project)].reverse()) {
    await runAllowing(runtime, [bin, 'stop', service.containerName], MISSING);
  }
}

export async function executeStart(project: Project, bin: string, runtime: Runtime): Promise<void> {
  await ensureSystem(bin, runtime);
  for (const service of containersOf(project)) {
    await runRequired(runtime, [bin, 'start', service.containerName]);
  }
}

export async function executeLogs(
  project: Project,
  bin: string,
  runtime: Runtime,
  serviceName: string | undefined,
  follow: boolean,
  tail: string | undefined,
): Promise<void> {
  const services = serviceName
    ? project.services.filter((service) => service.name === serviceName || service.containerName === serviceName)
    : project.services;
  if (services.length === 0) throw new TranslateError(`Unknown service "${serviceName}".`);
  for (const service of services) {
    const argv = [bin, 'logs'];
    if (follow && service === services[services.length - 1]) argv.push('--follow');
    if (tail) argv.push('-n', tail);
    argv.push(service.containerName);
    await runRequired(runtime, argv, true);
  }
}

export async function executePull(project: Project, bin: string, runtime: Runtime): Promise<void> {
  for (const service of project.services) {
    if (!service.image) continue;
    await runRequired(runtime, [bin, 'image', 'pull', service.image]);
  }
}

async function ensureSystem(bin: string, runtime: Runtime): Promise<void> {
  const status = await runtime.run([bin, 'system', 'status']);
  if (status.code === 0) return;
  if (status.code === 127) throw new TranslateError('Apple Container CLI was not found. Install it and retry.');
  console.error('Apple Container is not running. Starting it.');
  const start = await runtime.run([bin, 'system', 'start'], { inherit: true });
  if (start.code !== 0) throw new TranslateError('container system start failed.');
}

async function waitIfHealthy(project: Project, bin: string, runtime: Runtime, service: Service): Promise<void> {
  const needed = project.services.some((item) =>
    item.dependsOn.some((dep) => dep.service === service.name && dep.condition === 'service_healthy'),
  );
  if (!needed || !service.healthcheck) return;
  const health = service.healthcheck;
  if (health.startPeriodMs > 0) await delay(health.startPeriodMs);
  for (let attempt = 1; attempt <= health.retries; attempt++) {
    const result = await runtime.run([bin, 'exec', service.containerName, ...health.test]);
    if (result.code === 0) return;
    if (attempt === health.retries) {
      throw new TranslateError(`Healthcheck failed for ${service.containerName} after ${health.retries} attempts.`);
    }
    await delay(health.intervalMs);
  }
}

async function removeContainer(bin: string, runtime: Runtime, name: string): Promise<void> {
  await runAllowing(runtime, [bin, 'stop', name], MISSING);
  await runAllowing(runtime, [bin, 'delete', '--force', name], MISSING);
}

async function removeRecordedOrphans(
  bin: string,
  runtime: Runtime,
  previous: ProjectState,
  started: ServiceState[],
): Promise<void> {
  const live = new Set(started.map((service) => service.containerName));
  for (const service of previous.services) {
    if (!live.has(service.containerName)) await removeContainer(bin, runtime, service.containerName);
  }
}

function containersOf(project: Project): ServiceState[] {
  const state = readState(project.name);
  if (state?.services.length) return relevantServices(state, project);
  return project.services.map(serviceState);
}

function relevantServices(state: ProjectState, project: Project): ServiceState[] {
  const names = new Set(project.services.map((service) => service.containerName));
  const matched = state.services.filter((service) => names.has(service.containerName));
  return matched.length > 0 ? matched : project.services.map(serviceState);
}

function projectState(project: Project, plan: UpPlan, services: ServiceState[]): ProjectState {
  return {
    project: project.name,
    network: project.services.find((service) => service.networkName)?.networkName,
    volumes: plan.volumes.map((command) => command.argv[command.argv.length - 1]),
    services,
  };
}

function serviceState(service: Service): ServiceState {
  return {
    name: service.name,
    containerName: service.containerName,
    stopSignal: service.stopSignal,
    stopGraceSeconds: service.stopGraceSeconds,
  };
}

function allCommands(plan: UpPlan): Array<{ argv: string[] }> {
  return [
    ...plan.networks,
    ...plan.volumes,
    ...plan.services.flatMap((service) => service.build ? [service.build, service.run] : [service.run]),
  ];
}

async function runRequired(runtime: Runtime, argv: string[], inherit = true): Promise<void> {
  console.error(`+ ${formatCommand(argv)}`);
  const result = await runtime.run(argv, { inherit });
  if (result.code !== 0) {
    if (!inherit && result.stderr) console.error(result.stderr.trim());
    throw new TranslateError(`${formatCommand(argv)} failed (exit ${result.code}).`);
  }
}

async function runAllowing(runtime: Runtime, argv: string[], pattern: RegExp): Promise<void> {
  console.error(`+ ${formatCommand(argv)}`);
  const result = await runtime.run(argv);
  if (result.code === 0) return;
  const text = `${result.stdout}\n${result.stderr}`;
  if (pattern.test(text)) return;
  if (result.stderr) console.error(result.stderr.trim());
  throw new TranslateError(`${formatCommand(argv)} failed (exit ${result.code}).`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
