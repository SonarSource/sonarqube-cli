// Cross-platform browser opening utility

import { spawn } from 'child_process';
import { platform } from 'os';

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
      detached: true
    });

    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Browser command exited with code ${code}`));
      }
    });

    proc.unref();
  });
}
