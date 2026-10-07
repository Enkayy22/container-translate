import { spawn } from 'node:child_process';

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export interface Runtime {
  run(argv: string[], options?: { inherit?: boolean }): Promise<CommandResult>;
}

export function containerBin(): string {
  return process.env.CONTAINER_BIN || 'container';
}

export class LocalRuntime implements Runtime {
  async run(argv: string[], options?: { inherit?: boolean }): Promise<CommandResult> {
    const inherit = options?.inherit ?? false;
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      if (!inherit) {
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });
      }
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          resolve({ code: 127, stdout: '', stderr: `command not found: ${argv[0]}` });
          return;
        }
        reject(err);
      });
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}
