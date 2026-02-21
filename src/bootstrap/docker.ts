// Docker checks - verify Docker installation and MCP image

import { spawnProcess } from '../lib/process.js';
import { text, success } from '../ui/index.js';

/**
 * Check if Docker is installed
 */
export async function isDockerInstalled(): Promise<boolean> {
  try {
    const result = await spawnProcess('docker', ['--version']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if Docker is running
 */
export async function isDockerRunning(): Promise<boolean> {
  try {
    const result = await spawnProcess('docker', ['info']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if Docker image exists
 */
export async function hasImage(imageName: string): Promise<boolean> {
  try {
    const result = await spawnProcess('docker', ['images', '-q', imageName]);
    return result.exitCode === 0 && result.stdout.length > 0;
  } catch {
    return false;
  }
}

/**
 * Pull MCP Docker image
 */
export async function pullMcpImage(): Promise<void> {
  text('Pulling SonarQube MCP Server Docker image...');

  const result = await spawnProcess('docker', ['pull', 'mcp/sonarqube'], {
    stdout: 'inherit',
    stderr: 'inherit'
  });

  if (result.exitCode !== 0) {
    throw new Error('Failed to pull Docker image');
  }

  success('Docker image pulled');
}
