import { TranslateError } from './errors.js';
import { discoverComposeFiles, parseCompose } from './compose/parse.js';
import { executeDown, executeLogs, executePull, executeStart, executeStop, executeUp } from './compose/execute.js';
import { planUp, selectServices } from './compose/plan.js';
import { formatCommand } from './quote.js';
import { containerBin, LocalRuntime, type Runtime } from './runtime.js';
import { SUDO_EXPLANATION, doctorReport } from './doctor.js';
import { translateDocker } from './docker/translate.js';

export type ComposeInvocation = {
  files: string[];
  projectName?: string;
  profiles: string[];
  command: string;
  services: string[];
  dryRun: boolean;
  detach: boolean;
  removeVolumes: boolean;
  follow: boolean;
  forceRecreate: boolean;
  removeOrphans: boolean;
  noDeps: boolean;
  tail?: string;
  help: boolean;
};

export function parseComposeArgs(args: string[]): ComposeInvocation {
  const parsed: ComposeInvocation = {
    files: [],
    profiles: [],
    command: '',
    services: [],
    dryRun: false,
    detach: false,
    removeVolumes: false,
    follow: false,
    forceRecreate: false,
    removeOrphans: false,
    noDeps: false,
    help: false,
  };
  let commandSeen = false;
  const commands = new Set(['up', 'down', 'ps', 'logs', 'stop', 'start', 'restart', 'plan', 'config', 'pull', 'exec']);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if ((arg === '--file' || arg === '-f') && !(commandSeen && parsed.command === 'logs' && arg === '-f')) {
      const value = args[++i];
      if (!value) throw new TranslateError(`${arg} needs a compose file path.`);
      parsed.files.push(value);
      continue;
    }
    if (arg === '-p' || arg === '--project-name') {
      const value = args[++i];
      if (!value) throw new TranslateError('-p needs a project name.');
      parsed.projectName = value;
      continue;
    }
    if (arg === '--profile') {
      const value = args[++i];
      if (!value) throw new TranslateError('--profile needs a name.');
      parsed.profiles.push(value);
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (!commandSeen && commands.has(arg)) {
      parsed.command = arg;
      commandSeen = true;
      continue;
    }
    if (!commandSeen && arg.startsWith('-')) {
      throw new TranslateError(`Unknown compose flag ${arg}.`);
    }
    if (arg === '-d' || arg === '--detach') {
      parsed.detach = true;
      continue;
    }
    if (arg === '-v' || arg === '--volumes') {
      parsed.removeVolumes = true;
      continue;
    }
    if (arg === '--follow' || (arg === '-f' && parsed.command === 'logs')) {
      parsed.follow = true;
      continue;
    }
    if (arg === '--force-recreate') {
      parsed.forceRecreate = true;
      continue;
    }
    if (arg === '--remove-orphans') {
      parsed.removeOrphans = true;
      continue;
    }
    if (arg === '--no-deps') {
      parsed.noDeps = true;
      continue;
    }
    if (arg === '--tail') {
      parsed.tail = args[++i];
      continue;
    }
    if (parsed.command === 'exec' && parsed.services.length >= 1) {
      parsed.services.push(arg);
      continue;
    }
    if (arg.startsWith('-')) throw new TranslateError(`Unknown compose flag ${arg}.`);
    parsed.services.push(arg);
  }
  return parsed;
}

export async function runCompose(args: string[], runtime: Runtime = new LocalRuntime()): Promise<void> {
  const parsed = parseComposeArgs(args);
  if (parsed.help || args.length === 0) {
    console.log(composeHelp());
    return;
  }
  if (!parsed.command) throw new TranslateError('A compose command is required: up, down, ps, logs, stop, start, plan, config.');
  const files = parsed.files.length > 0 ? parsed.files : discoverComposeFiles(process.cwd());
  const profiles = [...parsed.profiles, ...(process.env.COMPOSE_PROFILES || '').split(',').filter(Boolean)];
  const project = selectServices(
    parseCompose(files, { projectName: parsed.projectName, profiles }),
    parsed.command === 'logs' || parsed.command === 'exec' ? [] : parsed.services,
    parsed.noDeps,
  );
  const bin = containerBin();

  if (parsed.command === 'plan' || parsed.command === 'config' || (parsed.command === 'up' && parsed.dryRun)) {
    const plan = planUp(project, bin);
    for (const warning of plan.warnings) console.error(`warning: ${warning}`);
    if (parsed.command === 'config') console.log(JSON.stringify(project, null, 2));
    else {
      for (const step of [...plan.networks, ...plan.volumes, ...plan.services.flatMap((service) => service.build ? [service.build, service.run] : [service.run])]) {
        console.log(formatCommand(step.argv));
      }
    }
    return;
  }

  if (parsed.command === 'up') {
    if (!parsed.detach) console.error('Starting detached. Apple Container keeps each container in its own VM; logs stay available with logs -f.');
    await executeUp(project, bin, runtime, {
      dryRun: false,
      forceRecreate: parsed.forceRecreate,
      removeOrphans: parsed.removeOrphans,
    });
    return;
  }
  if (parsed.command === 'down') {
    await executeDown(project, bin, runtime, parsed.removeVolumes);
    return;
  }
  if (parsed.command === 'stop') {
    await executeStop(project, bin, runtime);
    return;
  }
  if (parsed.command === 'start' || parsed.command === 'restart') {
    if (parsed.command === 'restart') await executeStop(project, bin, runtime);
    await executeStart(project, bin, runtime);
    return;
  }
  if (parsed.command === 'logs') {
    const service = parsed.services[0];
    await executeLogs(project, bin, runtime, service, parsed.follow, parsed.tail);
    return;
  }
  if (parsed.command === 'pull') {
    await executePull(project, bin, runtime);
    return;
  }
  if (parsed.command === 'ps') {
    const result = await runtime.run([bin, 'list', '--all'], { inherit: true });
    if (result.code !== 0) throw new TranslateError('container list failed.');
    return;
  }
  if (parsed.command === 'exec') {
    if (parsed.services.length < 2) throw new TranslateError('exec needs a service and a command.');
    const service = project.services.find((item) => item.name === parsed.services[0] || item.containerName === parsed.services[0]);
    if (!service) throw new TranslateError(`Unknown service "${parsed.services[0]}".`);
    const result = await runtime.run([bin, 'exec', service.containerName, ...parsed.services.slice(1)], { inherit: true });
    if (result.code !== 0) throw new TranslateError(`container exec failed (exit ${result.code}).`);
    return;
  }
  throw new TranslateError(`Unknown compose command "${parsed.command}".`);
}

export async function runDocker(args: string[], runtime: Runtime = new LocalRuntime()): Promise<void> {
  if (process.getuid?.() === 0) console.error(`warning: ${SUDO_EXPLANATION}`);
  const translated = translateDocker(args, containerBin());
  for (const warning of translated.warnings) console.error(`warning: ${warning}`);
  if (translated.kind === 'error') {
    const help = args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help';
    if (help) {
      console.log(translated.message);
      return;
    }
    throw new TranslateError(translated.message);
  }
  if (translated.kind === 'compose') {
    await runCompose(translated.args, runtime);
    return;
  }
  if (process.env.DOCKER_HOST) {
    console.error('warning: DOCKER_HOST is ignored. This shim calls the container CLI directly.');
  }
  const result = await runtime.run(translated.argv, { inherit: true });
  if (result.code !== 0) throw new TranslateError(`container command failed (exit ${result.code}).`);
}

export async function main(argv = process.argv.slice(2), argv0 = process.env.CONTAINER_TRANSLATE_ARGV0 || 'container-translate'): Promise<void> {
  if (argv0 === 'docker') {
    await runDocker(argv);
    return;
  }
  if (argv0 === 'docker-compose') {
    await runCompose(argv);
    return;
  }
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(topHelp());
    return;
  }
  if (command === 'doctor') {
    for (const line of await doctorReport(new LocalRuntime())) console.log(line);
    return;
  }
  if (command === 'compose') {
    await runCompose(argv.slice(1));
    return;
  }
  if (command === 'docker') {
    await runDocker(argv.slice(1));
    return;
  }
  if (command === 'plan' || command === 'config') {
    await runCompose(argv);
    return;
  }
  throw new TranslateError(`Unknown command "${command}". ${topHelp()}`);
}

function topHelp(): string {
  return [
    'container-translate — run Docker CLI and Compose workflows on Apple Container',
    '',
    '  container-translate doctor',
    '  container-translate compose -f docker-compose.yml up -d',
    '  container-translate plan -f docker-compose.yml',
    '  container-translate docker ps',
    '',
    'Install the shims so existing Makefiles keep calling docker-compose:',
    '  ./scripts/install.sh',
  ].join('\n');
}

function composeHelp(): string {
  return [
    'container-translate compose',
    '',
    '  up [-d] [--dry-run] [--force-recreate] [services...]',
    '  down [-v]',
    '  ps | logs [service] | stop | start | pull | plan | config | exec <service> <cmd>',
    '',
    '  -f, --file           Compose file. Repeat to merge.',
    '  -p, --project-name   Project name. Default is the compose file slug,',
    '                       so several compose files in one repo stay separate.',
    '  --profile            Enable a service profile.',
  ].join('\n');
}
