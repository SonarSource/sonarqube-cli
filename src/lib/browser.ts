// Cross-platform browser opening utility

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Open URL in default browser
 */
export async function openBrowser(url: string): Promise<void> {
  const os = platform();

  let command: string;
  let args: string[];

  switch (os) {
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    case 'win32':
      command = 'rundll32';
      args = ['url.dll,FileProtocolHandler', url];
      break;
    default: // linux and others
      command = 'xdg-open';
      args = [url];
      break;
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      shell: false
    });

    proc.on('error', (error: NodeJS.ErrnoException) => {
      // Ignore if command not found (browser might not be available)
      if (error.code === 'ENOENT') {
        reject(new Error(`${command} not found on this system`));
      } else {
        reject(error);
      }
    });

    proc.on('exit', () => {
      // Exit code 0 or null means success, ignore non-zero exit codes
      resolve();
    });

    proc.unref();
  });
}
