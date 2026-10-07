import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ServiceState = {
  name: string;
  containerName: string;
  stopSignal?: string;
  stopGraceSeconds?: number;
};

export type ProjectState = {
  project: string;
  network?: string;
  volumes: string[];
  services: ServiceState[];
};

export function stateFile(project: string): string {
  const root = process.env.CT_STATE_DIR || join(homedir(), '.container-translate', 'projects');
  return join(root, `${project}.json`);
}

export function readState(project: string): ProjectState | null {
  try {
    return JSON.parse(readFileSync(stateFile(project), 'utf8')) as ProjectState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function writeState(state: ProjectState): void {
  const file = stateFile(state.project);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export function removeState(project: string): void {
  rmSync(stateFile(project), { force: true });
}
