import { TranslateError } from '../errors.js';

export type DockerTranslation =
  | { kind: 'exec'; argv: string[]; warnings: string[] }
  | { kind: 'compose'; args: string[]; warnings: string[] }
  | { kind: 'error'; message: string; warnings: string[] };

const RUN_VALUE = new Set([
  '-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--cwd', '-c', '--cpus',
  '-m', '--memory', '--dns', '--dns-search', '--dns-option', '--dns-domain', '--entrypoint',
  '-l', '--label', '--mount', '--name', '--network', '-p', '--publish', '--platform',
  '--shm-size', '--tmpfs', '-v', '--volume', '--cap-add', '--cap-drop', '--ulimit',
  '-a', '--arch', '--cidfile', '--restart', '--health-cmd', '--health-interval',
  '--health-retries', '--health-timeout', '--health-start-period', '--add-host', '--link',
  '--log-driver', '--log-opt', '--security-opt', '--device', '--gpus', '--pid', '--ipc',
  '--hostname', '-h', '--memory-swap', '--stop-signal', '--stop-timeout',
]);

const RUN_BOOL = new Set([
  '-i', '--interactive', '-t', '--tty', '-d', '--detach', '--init', '--read-only',
  '--rm', '--remove', '--privileged',
]);

const RUN_DROP = new Set([
  '--restart', '--health-cmd', '--health-interval', '--health-retries', '--health-timeout',
  '--health-start-period', '--privileged', '--pid', '--ipc', '--add-host', '--link',
  '--log-driver', '--log-opt', '--security-opt', '--device', '--gpus', '--memory-swap',
  '--hostname', '-h', '--stop-signal', '--stop-timeout',
]);

const BUILD_VALUE = new Set([
  '-a', '--arch', '--build-arg', '-c', '--cpus', '--dns', '--dns-domain', '--dns-option',
  '--dns-search', '-f', '--file', '-l', '--label', '-m', '--memory', '-o', '--output',
  '--os', '--platform', '--progress', '--secret', '--ssh', '-t', '--tag', '--target',
]);

const BUILD_BOOL = new Set(['--no-cache', '--pull', '-q', '--quiet']);

export function translateDocker(args: string[], bin: string): DockerTranslation {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    return { kind: 'error', message: dockerHelp(), warnings: [] };
  }
  if (args[0] === '--version' || args[0] === 'version') {
    return { kind: 'exec', argv: [bin, 'system', 'version'], warnings: [] };
  }
  if (args[0] === 'compose') return { kind: 'compose', args: args.slice(1), warnings: [] };

  const command = args[0];
  const rest = args.slice(1);
  switch (command) {
    case 'ps':
      return translatePs(rest, bin);
    case 'container':
      if (!rest[0] || rest[0] === 'ls' || rest[0] === 'list' || rest[0] === 'ps') {
        return translatePs(rest.slice(rest[0] ? 1 : 0), bin);
      }
      return translateDocker(rest, bin);
    case 'images':
      return translateImages(rest, bin);
    case 'pull':
      return { kind: 'exec', argv: [bin, 'image', 'pull', ...rest], warnings: [] };
    case 'push':
      return { kind: 'exec', argv: [bin, 'image', 'push', ...rest], warnings: [] };
    case 'rmi':
      return translateImageDelete(rest, bin);
    case 'build':
      return translateBuild(rest, bin);
    case 'run':
    case 'create':
      return translateRun(command === 'create' ? 'create' : 'run', rest, bin);
    case 'start':
      return translateStart(rest, bin);
    case 'stop':
      return translateSignalCommand('stop', rest, bin, '--time', ['-t', '--time']);
    case 'kill':
      return translateSignalCommand('kill', rest, bin, '--signal', ['-s', '--signal']);
    case 'rm':
      return translateRm(rest, bin);
    case 'logs':
      return translateLogs(rest, bin);
    case 'exec':
      return translateExec(rest, bin);
    case 'cp':
      return { kind: 'exec', argv: [bin, 'copy', ...rest], warnings: [] };
    case 'inspect':
      return { kind: 'exec', argv: [bin, 'inspect', ...rest], warnings: [] };
    case 'stats':
      return { kind: 'exec', argv: [bin, 'stats', ...rest.filter((arg) => arg !== '--no-stream')], warnings: [] };
    case 'export':
      return { kind: 'exec', argv: [bin, 'export', ...rest], warnings: [] };
    case 'login':
      return { kind: 'exec', argv: [bin, 'registry', 'login', ...rest], warnings: [] };
    case 'logout':
      return { kind: 'exec', argv: [bin, 'registry', 'logout', ...rest], warnings: [] };
    case 'info':
      return { kind: 'exec', argv: [bin, 'system', 'status'], warnings: [] };
    case 'volume':
      return translateResource('volume', rest, bin);
    case 'network':
      return translateResource('network', rest, bin);
    case 'image':
      return translateResource('image', rest, bin);
    case 'system':
      return { kind: 'exec', argv: [bin, 'system', ...rest], warnings: [] };
    case 'builder':
      return { kind: 'exec', argv: [bin, 'builder', ...rest], warnings: [] };
    default:
      return {
        kind: 'error',
        message: `docker ${command} has no Apple Container equivalent. This shim translates the Docker CLI; it does not speak the Docker Engine API.`,
        warnings: [],
      };
  }
}

export function dockerHelp(): string {
  return [
    'container-translate docker shim',
    '',
    'Maps docker commands onto Apple\'s container CLI.',
    'docker compose and docker-compose are translated from the compose file.',
    'There is no Docker Engine socket. Do not symlink /var/run/docker.sock.',
    '',
    'Translated: run, ps, images, pull, push, rmi, build, exec, logs, start, stop,',
    'kill, rm, cp, inspect, volume, network, login, compose.',
  ].join('\n');
}

function translatePs(args: string[], bin: string): DockerTranslation {
  const warnings: string[] = [];
  const argv = [bin, 'ls'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-a' || arg === '--all') argv.push('--all');
    else if (arg === '-q' || arg === '--quiet') argv.push('--quiet');
    else if (arg === '--format') {
      const value = args[++i];
      if (value === 'json' || value === 'table' || value === 'yaml' || value === 'toml') argv.push('--format', value);
      else warnings.push(`docker ps --format ${value} is a Go template. Apple Container accepts json, table, yaml, or toml.`);
    } else if (arg === '-n' || arg === '--last' || arg === '--filter' || arg === '-f') {
      warnings.push(`docker ps ${arg} was ignored.`);
      if (!arg.startsWith('--filter') && arg !== '-f') i++;
      else i++;
    } else if (!arg.startsWith('-')) {
      warnings.push(`docker ps does not take container names on Apple Container. Listing all containers.`);
    } else warnings.push(`docker ps ${arg} was ignored.`);
  }
  return { kind: 'exec', argv, warnings };
}

function translateRun(command: 'run' | 'create', args: string[], bin: string): DockerTranslation {
  const warnings: string[] = [];
  const argv = [bin, command];
  const commandArgs: string[] = [];
  let image: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (image) {
      commandArgs.push(arg);
      continue;
    }
    if (arg === '-it' || arg === '-ti') {
      argv.push('--interactive', '--tty');
      continue;
    }
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2) {
      const short = arg.slice(0, 2);
      if (RUN_VALUE.has(short)) {
        argv.push(longFlag(short), arg.slice(2));
        continue;
      }
    }
    const eq = arg.indexOf('=');
    const flag = eq > 1 && arg.startsWith('--') ? arg.slice(0, eq) : arg;
    const inline = eq > 1 && arg.startsWith('--') ? arg.slice(eq + 1) : undefined;
    if (RUN_DROP.has(flag)) {
      warnings.push(`docker ${command} ${flag} was ignored. Apple Container has no equivalent.`);
      if (inline === undefined && takesValue(flag, args[i + 1])) i++;
      continue;
    }
    if (RUN_BOOL.has(flag) || (flag.startsWith('-') && !flag.startsWith('--') && [...flag.slice(1)].every((ch) => RUN_BOOL.has(`-${ch}`)))) {
      if (flag.startsWith('--')) argv.push(flag);
      else if (flag !== '-it') {
        for (const ch of flag.slice(1)) argv.push(shortBool(ch));
      }
      continue;
    }
    if (RUN_VALUE.has(flag)) {
      const value = inline ?? args[++i];
      if (value === undefined) return { kind: 'error', message: `docker ${command} ${flag} needs a value.`, warnings };
      argv.push(longFlag(flag), value);
      continue;
    }
    if (arg.startsWith('-')) {
      warnings.push(`docker ${command} ${arg} was ignored.`);
      continue;
    }
    image = arg;
  }
  if (!image) return { kind: 'error', message: `docker ${command} needs an image.`, warnings };
  argv.push(image, ...commandArgs);
  return { kind: 'exec', argv, warnings };
}

function translateBuild(args: string[], bin: string): DockerTranslation {
  const warnings: string[] = [];
  const argv = [bin, 'build'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const flag = eq > 1 && arg.startsWith('--') ? arg.slice(0, eq) : arg;
    const inline = eq > 1 && arg.startsWith('--') ? arg.slice(eq + 1) : undefined;
    if (BUILD_BOOL.has(flag)) {
      argv.push(flag === '-q' ? '--quiet' : flag);
      continue;
    }
    if (BUILD_VALUE.has(flag)) {
      const value = inline ?? args[++i];
      if (value === undefined) return { kind: 'error', message: `docker build ${flag} needs a value.`, warnings };
      argv.push(flag.startsWith('--') ? flag : buildShort(flag), value);
      continue;
    }
    if (arg.startsWith('-')) warnings.push(`docker build ${arg} was ignored.`);
    else argv.push(arg);
  }
  return { kind: 'exec', argv, warnings };
}

function translateLogs(args: string[], bin: string): DockerTranslation {
  const warnings: string[] = [];
  const argv = [bin, 'logs'];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-f' || arg === '--follow') argv.push('--follow');
    else if (arg === '--tail' || arg === '-n') {
      const value = args[++i];
      if (value === undefined) return { kind: 'error', message: 'docker logs --tail needs a number.', warnings };
      argv.push('-n', value);
    } else if (arg === '--since' || arg === '--until' || arg === '-t' || arg === '--timestamps') {
      warnings.push(`docker logs ${arg} was ignored.`);
      if (arg === '--since' || arg === '--until') i++;
    } else if (arg.startsWith('-')) warnings.push(`docker logs ${arg} was ignored.`);
    else positional.push(arg);
  }
  if (positional.length === 0) return { kind: 'error', message: 'docker logs needs a container name.', warnings };
  argv.push(...positional);
  return { kind: 'exec', argv, warnings };
}

function translateExec(args: string[], bin: string): DockerTranslation {
  const warnings: string[] = [];
  const argv = [bin, 'exec'];
  const valueFlags = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--cwd']);
  let seenContainer = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seenContainer) {
      argv.push(arg);
      continue;
    }
    if (arg === '-it' || arg === '-ti') {
      argv.push('--interactive', '--tty');
      continue;
    }
    if (arg === '-i' || arg === '--interactive') {
      argv.push('--interactive');
      continue;
    }
    if (arg === '-t' || arg === '--tty') {
      argv.push('--tty');
      continue;
    }
    if (arg === '-d' || arg === '--detach') {
      argv.push('--detach');
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = args[++i];
      if (value === undefined) return { kind: 'error', message: `docker exec ${arg} needs a value.`, warnings };
      argv.push(arg === '-e' ? '--env' : arg === '-u' ? '--user' : arg === '-w' ? '--workdir' : arg, value);
      continue;
    }
    if (arg.startsWith('-')) {
      warnings.push(`docker exec ${arg} was ignored.`);
      continue;
    }
    seenContainer = true;
    argv.push(arg);
  }
  if (!seenContainer) return { kind: 'error', message: 'docker exec needs a container and a command.', warnings };
  return { kind: 'exec', argv, warnings };
}

function translateRm(args: string[], bin: string): DockerTranslation {
  const warnings: string[] = [];
  const argv = [bin, 'delete'];
  for (const arg of args) {
    if (arg === '-f' || arg === '--force') argv.push('--force');
    else if (arg === '-v' || arg === '--volumes') warnings.push('docker rm -v was ignored. Delete volumes with container volume delete.');
    else if (arg.startsWith('-')) warnings.push(`docker rm ${arg} was ignored.`);
    else argv.push(arg);
  }
  return { kind: 'exec', argv, warnings };
}

function translateStart(args: string[], bin: string): DockerTranslation {
  const argv = [bin, 'start'];
  for (const arg of args) {
    if (arg === '-a' || arg === '--attach') argv.push('--attach');
    else if (arg === '-i' || arg === '--interactive') argv.push('--interactive');
    else argv.push(arg);
  }
  return { kind: 'exec', argv, warnings: [] };
}

function translateSignalCommand(
  command: 'stop' | 'kill',
  args: string[],
  bin: string,
  canonical: string,
  aliases: string[],
): DockerTranslation {
  const argv = [bin, command];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (aliases.includes(arg)) {
      const value = args[++i];
      if (value === undefined) return { kind: 'error', message: `docker ${command} ${arg} needs a value.`, warnings: [] };
      argv.push(canonical, value);
    } else if (arg === '-a' || arg === '--all') argv.push('--all');
    else argv.push(arg);
  }
  return { kind: 'exec', argv, warnings: [] };
}

function translateImageDelete(args: string[], bin: string): DockerTranslation {
  const argv = [bin, 'image', 'delete'];
  for (const arg of args) {
    if (arg === '-f' || arg === '--force') argv.push('--force');
    else argv.push(arg);
  }
  return { kind: 'exec', argv, warnings: [] };
}

function translateResource(resource: 'volume' | 'network' | 'image', args: string[], bin: string): DockerTranslation {
  if (args.length === 0) return { kind: 'error', message: `docker ${resource} needs a subcommand.`, warnings: [] };
  const map: Record<string, string> = {
    ls: 'list', list: 'list', rm: 'delete', remove: 'delete', create: 'create',
    inspect: 'inspect', prune: 'prune', pull: 'pull', push: 'push', tag: 'tag',
  };
  const sub = map[args[0]] || args[0];
  const rest = args.slice(1).map((arg) => (arg === '-q' || arg === '--quiet' ? '--quiet' : arg === '-f' || arg === '--force' ? '--force' : arg));
  return { kind: 'exec', argv: [bin, resource, sub, ...rest], warnings: [] };
}

function translateImages(args: string[], bin: string): DockerTranslation {
  const warnings: string[] = [];
  const argv = [bin, 'image', 'ls'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-q' || arg === '--quiet') argv.push('--quiet');
    else if (arg === '--format') {
      const value = args[++i];
      if (value === 'json' || value === 'table' || value === 'yaml' || value === 'toml') argv.push('--format', value);
      else warnings.push(`docker images --format ${value} is a Go template. Apple Container accepts json, table, yaml, or toml.`);
    } else if (arg === '-a' || arg === '--all') warnings.push('docker images --all was ignored.');
    else if (!arg.startsWith('-')) argv.push(arg);
    else warnings.push(`docker images ${arg} was ignored.`);
  }
  return { kind: 'exec', argv, warnings };
}

function takesValue(flag: string, next: string | undefined): boolean {
  return RUN_VALUE.has(flag) && next !== undefined;
}

function longFlag(flag: string): string {
  const shorts: Record<string, string> = {
    '-e': '--env', '-u': '--user', '-w': '--workdir', '-c': '--cpus', '-m': '--memory',
    '-l': '--label', '-p': '--publish', '-v': '--volume', '-a': '--arch', '-h': '--hostname',
  };
  return shorts[flag] || flag;
}

function shortBool(ch: string): string {
  if (ch === 'i') return '--interactive';
  if (ch === 't') return '--tty';
  if (ch === 'd') return '--detach';
  return `-${ch}`;
}

function buildShort(flag: string): string {
  if (flag === '-f') return '--file';
  if (flag === '-t') return '--tag';
  if (flag === '-m') return '--memory';
  if (flag === '-c') return '--cpus';
  if (flag === '-l') return '--label';
  if (flag === '-a') return '--arch';
  if (flag === '-o') return '--output';
  return flag;
}

export function assertTranslated(translation: DockerTranslation): Extract<DockerTranslation, { kind: 'exec' }> {
  if (translation.kind === 'error') throw new TranslateError(translation.message);
  if (translation.kind === 'compose') throw new TranslateError('compose dispatch is handled by the CLI.');
  return translation;
}
