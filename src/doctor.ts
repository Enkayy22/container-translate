import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from './runtime.js';

export const SUDO_EXPLANATION = [
  'sudo does not run your shell functions or aliases.',
  'On macOS it searches secure_path, usually /usr/bin:/bin:/usr/sbin:/sbin.',
  '/usr/local/bin/docker and ~/.local/bin/docker are outside that path, so sudo docker looks for a Docker Desktop binary that is no longer installed.',
  'Apple Container runs as your user. Run docker, docker-compose, and container-translate without sudo.',
].join(' ');

export const SOCKET_EXPLANATION = [
  'docker compose talks to a Docker Engine over the HTTP API on unix:///var/run/docker.sock.',
  'Apple Container manages micro-VMs through container-apiserver and does not expose that API.',
  'Symlinking or remapping the socket fails because the daemons speak different protocols.',
  'This tool translates compose files and docker CLI arguments into container commands instead.',
].join(' ');

export function findOnPath(bin: string, pathValue = process.env.PATH || ''): string | null {
  for (const dir of pathValue.split(':')) {
    if (!dir) continue;
    const full = join(dir, bin);
    if (existsSync(full)) return full;
  }
  return null;
}

export async function doctorReport(runtime: Runtime): Promise<string[]> {
  const lines: string[] = [];
  const container = findOnPath('container');
  lines.push(container ? `container CLI: ${container}` : 'container CLI: not on PATH');
  const docker = findOnPath('docker');
  lines.push(docker ? `first docker on PATH: ${docker}` : 'first docker on PATH: none');
  const compose = findOnPath('docker-compose');
  lines.push(compose ? `first docker-compose on PATH: ${compose}` : 'first docker-compose on PATH: none');

  if (process.getuid?.() === 0) lines.push(`running as root. ${SUDO_EXPLANATION}`);
  if (process.env.DOCKER_HOST) {
    lines.push(`DOCKER_HOST=${process.env.DOCKER_HOST} is set. This translator ignores it. ${SOCKET_EXPLANATION}`);
  }
  if (existsSync('/var/run/docker.sock')) {
    lines.push(`Found /var/run/docker.sock. ${SOCKET_EXPLANATION}`);
  } else {
    lines.push('No /var/run/docker.sock. That is expected after Docker Desktop is removed.');
  }

  if (!container) {
    lines.push('Install Apple Container, then run: container system start');
    return lines;
  }
  const status = await runtime.run([container, 'system', 'status']);
  lines.push(status.code === 0
    ? 'container system status: running'
    : 'container system status: not running. Start it with: container system start');
  return lines;
}
