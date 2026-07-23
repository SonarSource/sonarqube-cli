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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { setupMcpServer } from '@/commands/integrate/claude/mcp.ts';
import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';
import type { ClientCertConfig, ResolvedNetworkConfig } from '@/core/host/connectivity/types.ts';
import * as pkcs12Module from '@/core/host/crypto/pkcs12.ts';
import {
  getMcpConfigFilePath,
  getMcpContainerCommand,
  MCP_DEFAULT_TOOLSETS,
  resolveMcpContainerCommand,
  writeMcpServerEntry,
} from '@/core/host/mcp/mcp-helper.ts';
import { DiscoveredProject } from '@/core/project-info.ts';
import { getMockUiCalls, setMockUi } from '@/core/ui';

import {
  CLI_TMP_DIR,
  SONARQUBE_MCP_DOCKER_IMAGE_NAME,
} from '../../../../../src/lib/config-constants.ts';
import { normalizePath } from '../../../../../src/lib/fs-utils.ts';

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

const NO_NETWORK: ResolvedNetworkConfig = { proxy: null, caCert: null, clientCert: null };

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
    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: false },
      {},
      NO_NETWORK,
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
        'SONARQUBE_TOOLSETS',
        SONARQUBE_MCP_DOCKER_IMAGE_NAME,
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.example.com',
        SONARQUBE_TOOLSETS: MCP_DEFAULT_TOOLSETS,
      },
    });
  });

  it('returns a podman command with SONARQUBE_TOKEN and SONARQUBE_URL for on-premise', () => {
    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'podman',
      { withFsMount: false },
      {},
      NO_NETWORK,
    );
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
        '-e',
        'SONARQUBE_TOOLSETS',
        SONARQUBE_MCP_DOCKER_IMAGE_NAME,
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.example.com',
        SONARQUBE_TOOLSETS: MCP_DEFAULT_TOOLSETS,
      },
    });
  });

  it('returns a docker command with SONARQUBE_ORG for cloud (sonarcloud.io)', () => {
    const auth: ResolvedAuth = { ...CLOUD_AUTH, orgKey: 'my-org' };
    const config = getMcpContainerCommand(auth, 'docker', { withFsMount: false }, {}, NO_NETWORK);
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
        '-e',
        'SONARQUBE_TOOLSETS',
        SONARQUBE_MCP_DOCKER_IMAGE_NAME,
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarcloud.io',
        SONARQUBE_ORG: 'my-org',
        SONARQUBE_TOOLSETS: MCP_DEFAULT_TOOLSETS,
      },
    });
  });

  it('returns a docker command with SONARQUBE_ORG for cloud US (sonarqube.us)', () => {
    const auth: ResolvedAuth = { ...CLOUD_US_AUTH, orgKey: 'my-org' };
    const config = getMcpContainerCommand(auth, 'docker', { withFsMount: false }, {}, NO_NETWORK);
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
        '-e',
        'SONARQUBE_TOOLSETS',
        SONARQUBE_MCP_DOCKER_IMAGE_NAME,
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.us',
        SONARQUBE_ORG: 'my-org',
        SONARQUBE_TOOLSETS: MCP_DEFAULT_TOOLSETS,
      },
    });
  });

  it('uses forward slashes in the -v host path on Windows-style roots', () => {
    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      {
        withFsMount: true,
        projectRoot: String.raw`C:\Users\tdd\source\repos\sonarlint-core`,
      },
      {},
      NO_NETWORK,
    );
    const args = (config as { args: string[] }).args;
    const vIndex = args.indexOf('-v');
    expect(vIndex).toBeGreaterThan(-1);
    expect(args[vIndex + 1]).toBe('C:/Users/tdd/source/repos/sonarlint-core:/app/mcp-workspace:ro');
  });

  it('returns a docker command with -v ${projectRoot}:/app/mcp-workspace:ro for non-global config', () => {
    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: true, projectRoot: '/fake/project' },
      {},
      NO_NETWORK,
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
        '-v',
        '/fake/project:/app/mcp-workspace:ro',
        '-e',
        'SONARQUBE_TOOLSETS',
        SONARQUBE_MCP_DOCKER_IMAGE_NAME,
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.example.com',
        SONARQUBE_TOOLSETS: MCP_DEFAULT_TOOLSETS,
      },
    });
  });

  it('returns a podman command with -v ${projectRoot}:/app/mcp-workspace:ro for non-global config', () => {
    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'podman',
      { withFsMount: true, projectRoot: '/fake/project' },
      {},
      NO_NETWORK,
    );
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
        '-e',
        'SONARQUBE_TOOLSETS',
        SONARQUBE_MCP_DOCKER_IMAGE_NAME,
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.example.com',
        SONARQUBE_TOOLSETS: MCP_DEFAULT_TOOLSETS,
      },
    });
  });

  it('returns a docker command with SONARQUBE_PROJECT_KEY for non-global config with project key', () => {
    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: true, projectRoot: '/fake/project', projectKey: 'my-project' },
      {},
      NO_NETWORK,
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
        '-e',
        'SONARQUBE_TOOLSETS',
        SONARQUBE_MCP_DOCKER_IMAGE_NAME,
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.example.com',
        SONARQUBE_PROJECT_KEY: 'my-project',
        SONARQUBE_TOOLSETS: MCP_DEFAULT_TOOLSETS,
      },
    });
  });
});

describe('resolveMcpContainerCommand (via WSL)', () => {
  it('returns a wsl.exe/sh -c command with SONARQUBE_TOKEN and SONARQUBE_URL forwarded via WSLENV', () => {
    const config = resolveMcpContainerCommand(
      ON_PREMISE_AUTH,
      { runtime: 'docker', viaWsl: true },
      { withFsMount: false },
      {},
      NO_NETWORK,
    );
    expect(config).toEqual({
      command: 'wsl.exe',
      args: [
        'sh',
        '-c',
        `docker run --init --pull=always -i --rm -e SONARQUBE_TOKEN -e SONARQUBE_URL -e SONARQUBE_TOOLSETS ${SONARQUBE_MCP_DOCKER_IMAGE_NAME}`,
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.example.com',
        SONARQUBE_TOOLSETS: MCP_DEFAULT_TOOLSETS,
        WSLENV: 'SONARQUBE_TOKEN/u:SONARQUBE_URL/u:SONARQUBE_TOOLSETS/u',
      },
    });
  });

  it('runs the detected runtime (e.g. podman) inside WSL', () => {
    const config = resolveMcpContainerCommand(
      ON_PREMISE_AUTH,
      { runtime: 'podman', viaWsl: true },
      { withFsMount: false },
      {},
      NO_NETWORK,
    );
    expect(config.command).toBe('wsl.exe');
    expect(config.args[2]).toStartWith('podman run ');
  });

  it('includes SONARQUBE_ORG for cloud, forwarded via WSLENV', () => {
    const auth: ResolvedAuth = { ...CLOUD_AUTH, orgKey: 'my-org' };
    const config = resolveMcpContainerCommand(
      auth,
      { runtime: 'docker', viaWsl: true },
      { withFsMount: false },
      {},
      NO_NETWORK,
    );
    expect(config.args[2]).toContain('-e SONARQUBE_ORG');
    expect(config.env.SONARQUBE_ORG).toBe('my-org');
    expect(config.env.WSLENV).toContain('SONARQUBE_ORG/u');
  });

  it('references the project root via a WSLENV-translated shell variable instead of a literal path', () => {
    const config = resolveMcpContainerCommand(
      ON_PREMISE_AUTH,
      { runtime: 'docker', viaWsl: true },
      { withFsMount: true, projectRoot: String.raw`C:\Users\tdd\source\repos\sonarlint-core` },
      {},
      NO_NETWORK,
    );
    expect(config).toEqual({
      command: 'wsl.exe',
      args: [
        'sh',
        '-c',
        `docker run --init --pull=always -i --rm -e SONARQUBE_TOKEN -e SONARQUBE_URL -v "$SONARQUBE_MCP_HOST_PATH":/app/mcp-workspace:ro -e SONARQUBE_TOOLSETS ${SONARQUBE_MCP_DOCKER_IMAGE_NAME}`,
      ],
      env: {
        SONARQUBE_TOKEN: 'squ_test',
        SONARQUBE_URL: 'https://sonarqube.example.com',
        SONARQUBE_TOOLSETS: MCP_DEFAULT_TOOLSETS,
        // Left untranslated (native Windows separators) so WSL can translate it via the `/p` flag.
        SONARQUBE_MCP_HOST_PATH: String.raw`C:\Users\tdd\source\repos\sonarlint-core`,
        WSLENV: 'SONARQUBE_TOKEN/u:SONARQUBE_URL/u:SONARQUBE_TOOLSETS/u:SONARQUBE_MCP_HOST_PATH/p',
      },
    });
  });

  it('includes SONARQUBE_PROJECT_KEY for project-scoped config, forwarded via WSLENV', () => {
    const config = resolveMcpContainerCommand(
      ON_PREMISE_AUTH,
      { runtime: 'docker', viaWsl: true },
      { withFsMount: true, projectRoot: '/fake/project', projectKey: 'my-project' },
      {},
      NO_NETWORK,
    );
    expect(config.args[2]).toContain('-e SONARQUBE_PROJECT_KEY');
    expect(config.env.SONARQUBE_PROJECT_KEY).toBe('my-project');
    expect(config.env.WSLENV).toContain('SONARQUBE_PROJECT_KEY/u');
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
    expect(() => getMcpConfigFilePath('unknown-agent', false, '/fake/project')).toThrow(
      'Unsupported agent: unknown-agent',
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

  it('treats an empty existing file as an empty object', async () => {
    writeFileSync(tmpFile, '', 'utf-8');

    const serverConfig = { command: 'sonar', args: ['run', 'mcp'] };
    await writeMcpServerEntry(tmpFile, serverConfig);

    const written = JSON.parse(readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
    expect(written.mcpServers).toEqual({ sonarqube: serverConfig });
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
      await import('@/core/host/mcp/mcp-helper.ts'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer(FAKE_PROJECT, true, undefined);

    const config = (writeSpy.mock.calls[0] as unknown[])[1] as { command: string; args: string[] };
    expect(typeof config.command).toBe('string');
    expect(config.command.length).toBeGreaterThan(0);
    expect(config.args).toEqual(['run', 'mcp']);
  });

  it('writes to ~/.claude.json for the global case', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('@/core/host/mcp/mcp-helper.ts'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer(FAKE_PROJECT, true, undefined);

    const filePath = (writeSpy.mock.calls[0] as unknown[])[0] as string;
    expect(filePath).toBe(join(homedir(), '.claude.json'));
  });

  it('writes to <projectRoot>/.mcp.json for the non-global case', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('@/core/host/mcp/mcp-helper.ts'),
      'writeMcpServerEntry',
    ).mockResolvedValue(undefined);

    await setupMcpServer(FAKE_PROJECT, false, undefined);

    const filePath = (writeSpy.mock.calls[0] as unknown[])[0] as string;
    expect(filePath).toBe(join('/fake/project', '.mcp.json'));
  });

  it('includes --project flag when a project key is provided', async () => {
    setMockUi(true);
    writeSpy = spyOn(
      await import('@/core/host/mcp/mcp-helper.ts'),
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
      await import('@/core/host/mcp/mcp-helper.ts'),
      'writeMcpServerEntry',
    ).mockRejectedValue(new Error('disk full'));

    await setupMcpServer(FAKE_PROJECT, false, undefined);

    const warns = getMockUiCalls()
      .filter((c) => c.method === 'warn')
      .map((c) => String(c.args[0]));
    expect(warns.some((m) => m.includes('disk full'))).toBe(true);
  });
});

describe('getMcpContainerCommand — client cert mount', () => {
  const FIXTURE_DIR = join(import.meta.dir, '../../../../fixtures/client-cert');
  const CERT_PEM = readFileSync(join(FIXTURE_DIR, 'client-cert.pem'), 'utf-8');
  const KEY_PEM = readFileSync(join(FIXTURE_DIR, 'client-key.pem'), 'utf-8');
  const P12_PATH = join(FIXTURE_DIR, 'client-cert.p12');

  const certHash = createHash('sha256').update(CERT_PEM).digest('hex').slice(0, 16);
  const expectedCachedPath = join(CLI_TMP_DIR, `mcp-client-cert-${certHash}.p12`);

  const altCertPem = CERT_PEM + '\n';
  const altCertHash = createHash('sha256').update(altCertPem).digest('hex').slice(0, 16);
  const altCachedPath = join(CLI_TMP_DIR, `mcp-client-cert-${altCertHash}.p12`);

  const pemClientCert: ClientCertConfig = {
    source: 'sonar-env',
    explicit: true,
    format: 'pem',
    certPath: join(FIXTURE_DIR, 'client-cert.pem'),
    keyPath: join(FIXTURE_DIR, 'client-key.pem'),
    passphrase: undefined,
    resolvedCertPem: CERT_PEM,
    resolvedKeyPem: KEY_PEM,
  };

  const pkcs12ClientCert: ClientCertConfig = {
    source: 'sonar-env',
    explicit: true,
    format: 'pkcs12',
    certPath: P12_PATH,
    keyPath: null,
    passphrase: 'sonar',
    resolvedCertPem: CERT_PEM,
    resolvedKeyPem: KEY_PEM,
  };

  let pemToPkcs12Spy: ReturnType<typeof spyOn>;

  afterEach(() => {
    pemToPkcs12Spy?.mockRestore();
    rmSync(expectedCachedPath, { force: true });
    rmSync(altCachedPath, { force: true });
  });

  it('converts PEM cert+key to PKCS12, writes with restricted permissions, and mounts it', () => {
    pemToPkcs12Spy = spyOn(pkcs12Module, 'pemToPkcs12').mockReturnValue(Buffer.from('stub-p12'));

    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: false },
      {},
      { proxy: null, caCert: null, clientCert: pemClientCert },
    );

    expect(pemToPkcs12Spy).toHaveBeenCalledWith(CERT_PEM, KEY_PEM, undefined);
    expect(config.args).toContain(
      `${normalizePath(expectedCachedPath)}:/etc/ssl/mcp/client.p12:ro`,
    );
    expect(existsSync(expectedCachedPath)).toBe(true);
    if (process.platform !== 'win32') {
      // 0o644: chmodSync bypasses umask so the container user (different UID) can always read the file.
      expect(statSync(expectedCachedPath).mode & 0o777).toBe(0o644);
      // 0o700: blocks dir enumeration from outside; Docker daemon (root) still sets up bind mounts.
      expect(statSync(dirname(expectedCachedPath)).mode & 0o777).toBe(0o700);
    }
  });

  it('forwards the passphrase to pemToPkcs12 when the PEM key is encrypted', () => {
    pemToPkcs12Spy = spyOn(pkcs12Module, 'pemToPkcs12').mockReturnValue(Buffer.from('stub-p12'));
    const encryptedPemClientCert: ClientCertConfig = {
      ...pemClientCert,
      passphrase: 'secret',
    };

    getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: false },
      {},
      { proxy: null, caCert: null, clientCert: encryptedPemClientCert },
    );

    expect(pemToPkcs12Spy).toHaveBeenCalledWith(CERT_PEM, KEY_PEM, 'secret');
  });

  it('reuses the cached PKCS12 and skips conversion when the same cert is presented again', () => {
    mkdirSync(dirname(expectedCachedPath), { recursive: true });
    writeFileSync(expectedCachedPath, Buffer.from('pre-existing'));
    pemToPkcs12Spy = spyOn(pkcs12Module, 'pemToPkcs12').mockReturnValue(Buffer.from('stub-p12'));

    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: false },
      {},
      { proxy: null, caCert: null, clientCert: pemClientCert },
    );

    expect(pemToPkcs12Spy).not.toHaveBeenCalled();
    expect(config.args).toContain(
      `${normalizePath(expectedCachedPath)}:/etc/ssl/mcp/client.p12:ro`,
    );
  });

  it('produces a different cached path for a different cert', () => {
    pemToPkcs12Spy = spyOn(pkcs12Module, 'pemToPkcs12').mockReturnValue(Buffer.from('stub-p12'));
    const altClientCert: ClientCertConfig = { ...pemClientCert, resolvedCertPem: altCertPem };

    const configA = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: false },
      {},
      { proxy: null, caCert: null, clientCert: pemClientCert },
    );
    const configB = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: false },
      {},
      { proxy: null, caCert: null, clientCert: altClientCert },
    );

    expect(configA.args).toContain(
      `${normalizePath(expectedCachedPath)}:/etc/ssl/mcp/client.p12:ro`,
    );
    expect(configB.args).toContain(`${normalizePath(altCachedPath)}:/etc/ssl/mcp/client.p12:ro`);
  });

  it('mounts the PKCS12 file directly and forwards the passphrase without conversion', () => {
    pemToPkcs12Spy = spyOn(pkcs12Module, 'pemToPkcs12').mockReturnValue(Buffer.from('stub-p12'));

    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: false },
      {},
      { proxy: null, caCert: null, clientCert: pkcs12ClientCert },
    );

    expect(pemToPkcs12Spy).not.toHaveBeenCalled();
    expect(config.args).toContain(`${normalizePath(P12_PATH)}:/etc/ssl/mcp/client.p12:ro`);
    expect(config.env.JAVA_OPTS).toContain('javax.net.ssl.keyStorePassword=sonar');
  });
});
