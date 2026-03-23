/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import * as toolDetector from '../../src/lib/tool-detector';
import {
  setupMcpServer,
  getMcpConfigFilePath,
  getMcpServerConfig,
  writeMcpServerEntry,
} from '../../src/cli/commands/integrate/claude/mcp';
import { setMockUi, getMockUiCalls } from '../../src/ui';
import type { ResolvedAuth } from '../../src/lib/auth-resolver';

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
    const config = getMcpServerConfig(ON_PREMISE_AUTH, true, '/fake/project');
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

  it('returns a docker command with SONARQUBE_ORG for cloud (sonarcloud.io)', () => {
    const auth: ResolvedAuth = { ...CLOUD_AUTH, orgKey: 'my-org' };
    const config = getMcpServerConfig(auth, true, '/fake/project');
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
    const config = getMcpServerConfig(auth, true, '/fake/project');
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

  it('returns a docker command with -v ${projectRoot}:/app/mcp-workspace:ro for non-global config', () => {
    const config = getMcpServerConfig(ON_PREMISE_AUTH, false, '/fake/project');
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
  let dockerSpy: ReturnType<typeof spyOn>;
  let writeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    dockerSpy.mockRestore();
    writeSpy?.mockRestore();
    setMockUi(false);
  });

  it('skips MCP configuration and prints an error when docker is unavailable for cloud auth', async () => {
    setMockUi(true);
    dockerSpy = spyOn(toolDetector, 'isDockerAvailable').mockResolvedValue(false);

    await setupMcpServer('claude', '/fake/project', false, CLOUD_AUTH);

    const messages = getMockUiCalls().map((c) => String(c.args[0]));
    expect(messages.some((m) => m.includes('Docker is required'))).toBe(true);
    expect(messages.some((m) => m.includes('Skipping MCP server configuration'))).toBe(true);
  });

  it('logs an error when writing the MCP entry fails', async () => {
    setMockUi(true);
    dockerSpy = spyOn(toolDetector, 'isDockerAvailable').mockResolvedValue(true);
    writeSpy = spyOn(
      await import('../../src/cli/commands/integrate/claude/mcp'),
      'writeMcpServerEntry',
    ).mockRejectedValue(new Error('disk full'));

    await setupMcpServer('claude', '/fake/project', false, ON_PREMISE_AUTH);

    const errors = getMockUiCalls()
      .filter((c) => c.method === 'error')
      .map((c) => String(c.args[0]));
    expect(errors.some((m) => m.includes('disk full'))).toBe(true);
  });
});
