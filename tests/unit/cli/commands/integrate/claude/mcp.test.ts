/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import {
  getMcpConfigFilePath,
  getMcpServerConfig,
  setupMcpServer,
  writeMcpServerEntry,
} from '../../../../../../src/cli/commands/integrate/claude/mcp';
import type { ResolvedAuth } from '../../../../../../src/lib/auth-resolver';
import * as toolDetector from '../../../../../../src/lib/tool-detector';
import { getMockUiCalls, setMockUi } from '../../../../../../src/ui';

const ON_PREMISE_AUTH: ResolvedAuth = {
  token: 'squ_test',
  serverUrl: 'https://sonarqube.example.com',
  connectionType: 'on-premise',
};

const CLOUD_AUTH: ResolvedAuth = {
  token: 'squ_test',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud',
};

const CLOUD_US_AUTH: ResolvedAuth = {
  token: 'squ_test',
  serverUrl: 'https://sonarqube.us',
  connectionType: 'cloud',
};

describe('getMcpServerConfig', () => {
  it('returns a docker command with SONARQUBE_TOKEN and SONARQUBE_URL for on-premise', () => {
    const config = getMcpServerConfig(ON_PREMISE_AUTH, true, '/fake/project', undefined, 'docker');
    expect(config).toEqual({
      command: 'docker',
      args: [
        'run',
        '--init',
        '--pull=always',
        '-i',
        '--rm',
        '-e',
        'SONARQUBE_TOKEN',
        '-e',
        'SONARQUBE_URL',
        'mcp/sonarqube',
      ],
      env: { SONARQUBE_TOKEN: 'squ_test', SONARQUBE_URL: 'https://sonarqube.example.com' },
    });
  });

  it('returns a podman command with SONARQUBE_TOKEN and SONARQUBE_URL for on-premise', () => {
    const config = getMcpServerConfig(ON_PREMISE_AUTH, true, '/fake/project', undefined, 'podman');
    expect(config).toEqual({
      command: 'podman',
      args: [
        'run',
        '--init',
        '--pull=always',
        '-i',
        '--rm',
        '-e',
        'SONARQUBE_TOKEN',
        '-e',
        'SONARQUBE_URL',
        'mcp/sonarqube',
      ],
      env: { SONARQUBE_TOKEN: 'squ_test', SONARQUBE_URL: 'https://sonarqube.example.com' },
    });
  });

  it('returns a docker command with SONARQUBE_ORG for cloud (sonarcloud.io)', () => {
    const auth: ResolvedAuth = { ...CLOUD_AUTH, orgKey: 'my-org' };
    const config = getMcpServerConfig(auth, true, '/fake/project', undefined, 'docker');
    expect(config).toEqual({
      command: 'docker',
      args: [
        'run',
        '--init',
        '--pull=always',
        '-i',
        '--rm',
        '-e',
        'SONARQUBE_TOKEN',
        '-e',
        'SONARQUBE_URL',
        '-e',
        'SONARQUBE_ORG',
        'mcp/sonarqube',
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarcloud.io',
        SONARQUBE_ORG: 'my-org',
      },
    });
  });

  it('returns a docker command with SONARQUBE_ORG for cloud US (sonarqube.us)', () => {
    const auth: ResolvedAuth = { ...CLOUD_US_AUTH, orgKey: 'my-org' };
    const config = getMcpServerConfig(auth, true, '/fake/project', undefined, 'docker');
    expect(config).toEqual({
      command: 'docker',
      args: [
        'run',
        '--init',
        '--pull=always',
        '-i',
        '--rm',
        '-e',
        'SONARQUBE_TOKEN',
        '-e',
        'SONARQUBE_URL',
        '-e',
        'SONARQUBE_ORG',
        'mcp/sonarqube',
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.us',
        SONARQUBE_ORG: 'my-org',
      },
    });
  });

  it('uses forward slashes in the -v host path on Windows-style roots', () => {
    const config = getMcpServerConfig(
      ON_PREMISE_AUTH,
      false,
      String.raw`C:\Users\tdd\source\repos\sonarlint-core`,
      undefined,
      'docker',
    );
    const args = (config as { args: string[] }).args;
    const vIndex = args.indexOf('-v');
    expect(vIndex).toBeGreaterThan(-1);
    expect(args[vIndex + 1]).toBe('C:/Users/tdd/source/repos/sonarlint-core:/app/mcp-workspace:ro');
  });

  it('returns a docker command with -v ${projectRoot}:/app/mcp-workspace:ro for non-global config', () => {
    const config = getMcpServerConfig(ON_PREMISE_AUTH, false, '/fake/project', undefined, 'docker');
    expect(config).toEqual({
      command: 'docker',
      args: [
        'run',
        '--init',
        '--pull=always',
        '-i',
        '--rm',
        '-e',
        'SONARQUBE_TOKEN',
        '-e',
        'SONARQUBE_URL',
        '-v',
        '/fake/project:/app/mcp-workspace:ro',
        'mcp/sonarqube',
      ],
      env: { SONARQUBE_TOKEN: 'squ_test', SONARQUBE_URL: 'https://sonarqube.example.com' },
    });
  });

  it('returns a podman command with -v ${projectRoot}:/app/mcp-workspace:ro for non-global config', () => {
    const config = getMcpServerConfig(ON_PREMISE_AUTH, false, '/fake/project', undefined, 'podman');
    expect(config).toEqual({
      command: 'podman',
      args: [
        'run',
        '--init',
        '--pull=always',
        '-i',
        '--rm',
        '-e',
        'SONARQUBE_TOKEN',
        '-e',
        'SONARQUBE_URL',
        '-v',
        '/fake/project:/app/mcp-workspace:ro',
        'mcp/sonarqube',
      ],
      env: { SONARQUBE_TOKEN: 'squ_test', SONARQUBE_URL: 'https://sonarqube.example.com' },
    });
  });

  it('returns a docker command with SONARQUBE_PROJECT_KEY for non-global config with project key', () => {
    const config = getMcpServerConfig(
      ON_PREMISE_AUTH,
      false,
      '/fake/project',
      'my-project',
      'docker',
    );
    expect(config).toEqual({
      command: 'docker',
      args: [
        'run',
        '--init',
        '--pull=always',
        '-i',
        '--rm',
        '-e',
        'SONARQUBE_TOKEN',
        '-e',
        'SONARQUBE_URL',
        '-e',
        'SONARQUBE_PROJECT_KEY',
        '-v',
        '/fake/project:/app/mcp-workspace:ro',
        'mcp/sonarqube',
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.example.com',
        SONARQUBE_PROJECT_KEY: 'my-project',
      },
    });
  });
});

describe('getMcpConfigFilePath', () => {
  it('returns ~/.claude.json for the claude agent', () => {
    expect(getMcpConfigFilePath('claude')).toBe(join(homedir(), '.claude.json'));
  });

  it('throws for an unsupported agent', () => {
    expect(() => getMcpConfigFilePath('cursor')).toThrow('Unsupported agent: cursor');
  });
});

describe('writeMcpServerEntry', () => {
  const tmpFile = join(tmpdir(), `mcp-test-${Date.now()}.json`);

  afterEach(() => {
    rmSync(tmpFile, { force: true });
  });

  it('throws when the existing file contains invalid JSON', () => {
    writeFileSync(tmpFile, 'not valid json', 'utf-8');
    expect(
      writeMcpServerEntry(tmpFile, { command: 'docker' }, true, '/fake/project'),
    ).rejects.toThrow('contains invalid JSON');
  });

  it('merges sonarqube entry into existing project-specific mcpServers without overwriting other entries', async () => {
    const projectRoot = '/fake/project';
    const existing = {
      projects: {
        [projectRoot]: { mcpServers: { other: { command: 'npx', args: ['other-mcp'] } } },
      },
    };
    writeFileSync(tmpFile, JSON.stringify(existing), 'utf-8');

    const serverConfig = { command: 'docker', args: ['run', 'mcp/sonarqube'] };
    await writeMcpServerEntry(tmpFile, serverConfig, false, projectRoot);

    const written = JSON.parse(readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
    const projects = written.projects as Record<string, unknown>;
    const mcpServers = (projects[projectRoot] as Record<string, unknown>).mcpServers as Record<
      string,
      unknown
    >;
    expect(mcpServers['other']).toEqual({ command: 'npx', args: ['other-mcp'] });
    expect(mcpServers['sonarqube']).toEqual(serverConfig);
  });

  it('writes projects keys with forward slashes when projectRoot uses backslashes', async () => {
    const winRoot = String.raw`C:\Users\tdd\source\repos\sonarlint-core`;
    const serverConfig = { command: 'docker', args: ['run', 'mcp/sonarqube'] };
    await writeMcpServerEntry(tmpFile, serverConfig, false, winRoot);

    const written = JSON.parse(readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
    const projects = written.projects as Record<string, unknown>;
    expect(Object.keys(projects)).toEqual(['C:/Users/tdd/source/repos/sonarlint-core']);
  });

  it('merges sonarqube entry into existing global mcpServers without overwriting other entries', async () => {
    const existing = { mcpServers: { other: { command: 'npx', args: ['other-mcp'] } } };
    writeFileSync(tmpFile, JSON.stringify(existing), 'utf-8');

    const serverConfig = { command: 'docker', args: ['run', 'mcp/sonarqube'] };
    await writeMcpServerEntry(tmpFile, serverConfig, true, '/fake/project');

    const written = JSON.parse(readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
    const mcpServers = written.mcpServers as Record<string, unknown>;
    expect(mcpServers['other']).toEqual({ command: 'npx', args: ['other-mcp'] });
    expect(mcpServers['sonarqube']).toEqual(serverConfig);
  });
});

describe('setupMcpServer', () => {
  let runtimeSpy: ReturnType<typeof spyOn>;
  let writeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    runtimeSpy.mockRestore();
    writeSpy?.mockRestore();
    setMockUi(false);
  });

  it('skips MCP configuration and prints an error when no container runtime is available', async () => {
    setMockUi(true);
    runtimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue(null);

    await setupMcpServer('claude', '/fake/project', false, CLOUD_AUTH, undefined);

    const messages = getMockUiCalls().map((c) => String(c.args[0]));
    expect(messages.some((m) => m.includes('container runtime (Docker/Podman/Nerdctl)'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('Skipping SonarQube MCP Server configuration'))).toBe(
      true,
    );
  });

  it('uses docker command when docker runtime is detected', async () => {
    setMockUi(true);
    runtimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('docker');
    writeSpy = spyOn(
      await import('../../../../../../src/cli/commands/integrate/claude/mcp'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer('claude', '/fake/project', true, ON_PREMISE_AUTH, undefined);

    const config = (writeSpy.mock.calls[0] as unknown[])[1] as { command: string };
    expect(config.command).toBe('docker');
  });

  it('uses podman command when podman runtime is detected', async () => {
    setMockUi(true);
    runtimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('podman');
    writeSpy = spyOn(
      await import('../../../../../../src/cli/commands/integrate/claude/mcp'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer('claude', '/fake/project', true, ON_PREMISE_AUTH, undefined);

    const config = (writeSpy.mock.calls[0] as unknown[])[1] as { command: string };
    expect(config.command).toBe('podman');
  });

  it('uses nerdctl command when nerdctl runtime is detected', async () => {
    setMockUi(true);
    runtimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('nerdctl');
    writeSpy = spyOn(
      await import('../../../../../../src/cli/commands/integrate/claude/mcp'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer('claude', '/fake/project', true, ON_PREMISE_AUTH, undefined);

    const config = (writeSpy.mock.calls[0] as unknown[])[1] as { command: string };
    expect(config.command).toBe('nerdctl');
  });

  it('logs an error when writing the MCP entry fails', async () => {
    setMockUi(true);
    runtimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue('docker');
    writeSpy = spyOn(
      await import('../../../../../../src/cli/commands/integrate/claude/mcp'),
      'writeMcpServerEntry',
    ).mockRejectedValue(new Error('disk full'));

    await setupMcpServer('claude', '/fake/project', false, ON_PREMISE_AUTH, undefined);

    const errors = getMockUiCalls()
      .filter((c) => c.method === 'error')
      .map((c) => String(c.args[0]));
    expect(errors.some((m) => m.includes('disk full'))).toBe(true);
  });
});
