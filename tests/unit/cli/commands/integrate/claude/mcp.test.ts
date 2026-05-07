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

import { setupMcpServer } from '../../../../../../src/cli/commands/integrate/claude/mcp';
import type { ResolvedAuth } from '../../../../../../src/lib/auth-resolver';
import { CLI_COMMAND } from '../../../../../../src/lib/config-constants';
import {
  getMcpConfigFilePath,
  getMcpContainerCommand,
  writeMcpServerEntry,
} from '../../../../../../src/lib/mcp/mcp-helper';
import { DiscoveredProject } from '../../../../../../src/lib/project-workspace';
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

const FAKE_PROJECT: DiscoveredProject = {
  rootDir: '/fake/project',
  isGitRepo: false,
  serverUrl: 'https://sonarqube.example.com',
  organization: 'my-org',
  projectKey: 'my-project',
  configSources: [],
};

describe('getMcpContainerConfig', () => {
  it('returns a docker command with SONARQUBE_TOKEN and SONARQUBE_URL for on-premise', () => {
    const config = getMcpContainerCommand(ON_PREMISE_AUTH, 'docker', { withFsMount: false });
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
    const config = getMcpContainerCommand(ON_PREMISE_AUTH, 'podman', { withFsMount: false });
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
    const config = getMcpContainerCommand(auth, 'docker', { withFsMount: false });
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
    const config = getMcpContainerCommand(auth, 'docker', { withFsMount: false });
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
    const config = getMcpContainerCommand(ON_PREMISE_AUTH, 'docker', {
      withFsMount: true,
      projectRoot: String.raw`C:\Users\tdd\source\repos\sonarlint-core`,
    });
    const args = (config as { args: string[] }).args;
    const vIndex = args.indexOf('-v');
    expect(vIndex).toBeGreaterThan(-1);
    expect(args[vIndex + 1]).toBe('C:/Users/tdd/source/repos/sonarlint-core:/app/mcp-workspace:ro');
  });

  it('returns a docker command with -v ${projectRoot}:/app/mcp-workspace:ro for non-global config', () => {
    const config = getMcpContainerCommand(ON_PREMISE_AUTH, 'docker', {
      withFsMount: true,
      projectRoot: '/fake/project',
    });
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
    const config = getMcpContainerCommand(ON_PREMISE_AUTH, 'podman', {
      withFsMount: true,
      projectRoot: '/fake/project',
    });
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
    const config = getMcpContainerCommand(ON_PREMISE_AUTH, 'docker', {
      withFsMount: true,
      projectRoot: '/fake/project',
      projectKey: 'my-project',
    });
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
  it('returns ~/.claude.json for the global claude case', () => {
    expect(getMcpConfigFilePath('claude', true, '/fake/project')).toBe(
      join(homedir(), '.claude.json'),
    );
  });

  it('returns <projectRoot>/.mcp.json for the project-level claude case', () => {
    expect(getMcpConfigFilePath('claude', false, '/fake/project')).toBe(
      join('/fake/project', '.mcp.json'),
    );
  });

  it('throws for an unsupported agent', () => {
    expect(() => getMcpConfigFilePath('cursor', false, '/fake/project')).toThrow(
      'Unsupported agent: cursor',
    );
  });
});

describe('writeMcpServerEntry', () => {
  const tmpFile = join(tmpdir(), `mcp-test-${Date.now()}.json`);

  afterEach(() => {
    rmSync(tmpFile, { force: true });
  });

  it('throws when the existing file contains invalid JSON', () => {
    writeFileSync(tmpFile, 'not valid json', 'utf-8');
    expect(writeMcpServerEntry(tmpFile, { command: 'sonar' })).rejects.toThrow(
      'contains invalid JSON',
    );
  });

  it('merges sonarqube entry into existing mcpServers without overwriting other entries', async () => {
    const existing = { mcpServers: { other: { command: 'npx', args: ['other-mcp'] } } };
    writeFileSync(tmpFile, JSON.stringify(existing), 'utf-8');

    const serverConfig = { command: 'sonar', args: ['run', 'mcp'] };
    await writeMcpServerEntry(tmpFile, serverConfig);

    const written = JSON.parse(readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
    const mcpServers = written.mcpServers as Record<string, unknown>;
    expect(mcpServers['other']).toEqual({ command: 'npx', args: ['other-mcp'] });
    expect(mcpServers['sonarqube']).toEqual(serverConfig);
  });
});

describe('setupMcpServerForAgent (claude)', () => {
  let writeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    writeSpy?.mockRestore();
    setMockUi(false);
  });

  it('writes a sonar CLI config with the platform CLI command', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer(FAKE_PROJECT, true, undefined);

    const config = (writeSpy.mock.calls[0] as unknown[])[1] as { command: string; args: string[] };
    expect(config.command).toBe(CLI_COMMAND);
    expect(config.args).toEqual(['run', 'mcp']);
  });

  it('writes to ~/.claude.json for the global case', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer(FAKE_PROJECT, true, undefined);

    const filePath = (writeSpy.mock.calls[0] as unknown[])[0] as string;
    expect(filePath).toBe(join(homedir(), '.claude.json'));
  });

  it('writes to <projectRoot>/.mcp.json for the non-global case', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer(FAKE_PROJECT, false, undefined);

    const filePath = (writeSpy.mock.calls[0] as unknown[])[0] as string;
    expect(filePath).toBe(join('/fake/project', '.mcp.json'));
  });

  it('includes --project flag when a project key is provided', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer(FAKE_PROJECT, false, 'my-project');

    const config = (writeSpy.mock.calls[0] as unknown[])[1] as { args: string[] };
    expect(config.args).toContain('--project');
    expect(config.args).toContain('my-project');
  });

  it('warns when writing the MCP entry fails', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('../../../../../../src/lib/mcp/mcp-helper'),
      'writeMcpServerEntry',
    ).mockRejectedValue(new Error('disk full'));

    await setupMcpServer(FAKE_PROJECT, false, undefined);

    const warns = getMockUiCalls()
      .filter((c) => c.method === 'warn')
      .map((c) => String(c.args[0]));
    expect(warns.some((m) => m.includes('disk full'))).toBe(true);
  });
});
