// Process management helpers

import { spawn } from 'child_process';

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: 'pipe' | 'ignore' | 'inherit';
  stdout?: 'pipe' | 'ignore' | 'inherit';
  stderr?: 'pipe' | 'ignore' | 'inherit';
  detached?: boolean;
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn process and wait for completion
 */
export async function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [
        options.stdin || 'ignore',
        options.stdout || 'pipe',
        options.stderr || 'pipe'
      ],
      detached: options.detached || false
    });

    let stdout = '';
    let stderr = '';

    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    proc.on('error', reject);

    proc.on('exit', (code) => {
      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}
