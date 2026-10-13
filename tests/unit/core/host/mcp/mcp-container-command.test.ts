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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CLI_TMP_DIR, SONARQUBE_MCP_DOCKER_IMAGE_NAME } from '@/core/config-constants.ts';
import type { ClientCertConfig, ResolvedNetworkConfig } from '@/core/host/connectivity/types.ts';
import * as pkcs12Module from '@/core/host/crypto/pkcs12.ts';
import {
  getMcpContainerCommand,
  MCP_DEFAULT_TOOLSETS,
  resolveMcpContainerCommand,
} from '@/core/host/mcp/mcp-helper.ts';
import { normalizePath } from '@/core/io/fs-utils.ts';

const ON_PREMISE_AUTH = new ResolvedAuth({
  token: 'squ_test',
  serverUrl: 'https://sonarqube.example.com',
  connectionType: 'on-premise',
  source: 'state' as const,
});

const CLOUD_AUTH = new ResolvedAuth({
  token: 'squ_test',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud',
  source: 'state' as const,
});

const CLOUD_US_AUTH = new ResolvedAuth({
  token: 'squ_test',
  serverUrl: 'https://sonarqube.us',
  connectionType: 'cloud',
  source: 'state' as const,
});

const NO_NETWORK: ResolvedNetworkConfig = { proxy: null, caCert: null, clientCert: null };

function withCaCertificate(
  assertMount: (
    sourcePath: string,
    contents: Buffer,
    track: (path: string | undefined) => string,
  ) => void,
): void {
  const sourceDir = mkdtempSync(join(tmpdir(), 'sonar-mcp-ca-'));
  const sourcePath = join(sourceDir, 'corp-ca.pem');
  const contents = Buffer.from(`test CA certificate ${sourceDir}`);
  const cachedPaths: string[] = [];
  const track = (path: string | undefined): string => {
    if (!path) {
      throw new Error('Expected a cached CA path');
    }
    cachedPaths.push(path);
    return path;
  };
  writeFileSync(sourcePath, contents);
  try {
    assertMount(sourcePath, contents, track);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
    for (const path of cachedPaths) {
      rmSync(path, { force: true });
    }
  }
}

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
    const auth = new ResolvedAuth({ ...CLOUD_AUTH, orgKey: 'my-org' });
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
    const auth = new ResolvedAuth({ ...CLOUD_US_AUTH, orgKey: 'my-org' });
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
    const auth = new ResolvedAuth({ ...CLOUD_AUTH, orgKey: 'my-org' });
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

describe('getMcpContainerCommand — CA cert mount', () => {
  it('mounts a readable cached copy of the CA certificate', () => {
    withCaCertificate((sourcePath, contents, track) => {
      const config = getMcpContainerCommand(
        ON_PREMISE_AUTH,
        'docker',
        { withFsMount: false },
        {},
        {
          proxy: null,
          caCert: { source: 'sonar-env', explicit: true, path: sourcePath },
          clientCert: null,
        },
      );
      const cachedPath = track(config.cachedCaCertPath);
      const certHash = createHash('sha256').update(contents).digest('hex').slice(0, 16);

      expect(config.args).toContain(
        `${normalizePath(cachedPath)}:/usr/local/share/ca-certificates/sonar-ca.crt:ro`,
      );
      expect(cachedPath).toStartWith(join(CLI_TMP_DIR, `mcp-ca-${certHash}-`));
      expect(config.args.join(' ')).not.toContain(sourcePath);
      expect(readFileSync(cachedPath)).toEqual(readFileSync(sourcePath));
      if (process.platform !== 'win32') {
        expect(statSync(cachedPath).mode & 0o777).toBe(0o644);
        expect(statSync(dirname(cachedPath)).mode & 0o777).toBe(0o700);
      }
    });
  });

  it('keeps one run copy when another run removes its own CA copy', () => {
    withCaCertificate((sourcePath, _contents, track) => {
      const network: ResolvedNetworkConfig = {
        proxy: null,
        caCert: { source: 'sonar-env', explicit: true, path: sourcePath },
        clientCert: null,
      };
      const first = getMcpContainerCommand(
        ON_PREMISE_AUTH,
        'docker',
        { withFsMount: false },
        {},
        network,
      );
      const firstPath = track(first.cachedCaCertPath);
      const second = getMcpContainerCommand(
        ON_PREMISE_AUTH,
        'docker',
        { withFsMount: false },
        {},
        network,
      );
      const secondPath = track(second.cachedCaCertPath);

      expect(secondPath).not.toBe(firstPath);
      rmSync(firstPath);
      expect(existsSync(secondPath)).toBe(true);
      expect(second.args).toContain(
        `${normalizePath(secondPath)}:/usr/local/share/ca-certificates/sonar-ca.crt:ro`,
      );
    });
  });

  it('removes orphaned CA copies but preserves copies owned by a running process', () => {
    withCaCertificate((sourcePath, contents, track) => {
      mkdirSync(CLI_TMP_DIR, { recursive: true });
      const certHash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
      const suffix = '00000000-0000-4000-8000-000000000000.crt';
      const orphanPath = join(CLI_TMP_DIR, `mcp-ca-${certHash}-2147483647-${suffix}`);
      const activePath = join(CLI_TMP_DIR, `mcp-ca-${certHash}-${process.pid}-${suffix}`);
      writeFileSync(orphanPath, contents);
      writeFileSync(activePath, contents);

      try {
        const config = getMcpContainerCommand(
          ON_PREMISE_AUTH,
          'docker',
          { withFsMount: false },
          {},
          {
            proxy: null,
            caCert: { source: 'sonar-env', explicit: true, path: sourcePath },
            clientCert: null,
          },
        );
        track(config.cachedCaCertPath);

        expect(existsSync(orphanPath)).toBe(false);
        expect(existsSync(activePath)).toBe(true);
      } finally {
        rmSync(orphanPath, { force: true });
        rmSync(activePath, { force: true });
      }
    });
  });

  it.each([
    ['Docker', false],
    ['WSL', true],
  ])(
    'does not create a CA copy when client certificate conversion fails through %s',
    (_name, viaWsl) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'sonar-mcp-ca-failure-'));
      const sourcePath = join(sourceDir, 'corp-ca.pem');
      const contents = Buffer.from(`test CA certificate ${sourceDir}`);
      const certHash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
      const cachePrefix = `mcp-ca-${certHash}-`;
      writeFileSync(sourcePath, contents);
      const conversionSpy = spyOn(pkcs12Module, 'pemToPkcs12').mockImplementation(() => {
        throw new Error('conversion failed');
      });
      const clientCert: ClientCertConfig = {
        source: 'sonar-env',
        explicit: true,
        format: 'pem',
        certPath: join(sourceDir, 'client.pem'),
        keyPath: join(sourceDir, 'client.key'),
        passphrase: undefined,
        resolvedCertPem: 'client certificate',
        resolvedKeyPem: 'client key',
      };

      try {
        expect(() =>
          resolveMcpContainerCommand(
            ON_PREMISE_AUTH,
            { runtime: 'docker', viaWsl },
            { withFsMount: false },
            {},
            {
              proxy: null,
              caCert: { source: 'sonar-env', explicit: true, path: sourcePath },
              clientCert,
            },
          ),
        ).toThrow('conversion failed');
        const cachedFiles = existsSync(CLI_TMP_DIR) ? readdirSync(CLI_TMP_DIR) : [];
        expect(cachedFiles.some((file) => file.startsWith(cachePrefix))).toBe(false);
      } finally {
        conversionSpy.mockRestore();
        rmSync(sourceDir, { recursive: true, force: true });
        if (existsSync(CLI_TMP_DIR)) {
          for (const file of readdirSync(CLI_TMP_DIR)) {
            if (file.startsWith(cachePrefix)) {
              rmSync(join(CLI_TMP_DIR, file), { force: true });
            }
          }
        }
      }
    },
  );

  it('keeps the original mount path when the CA cannot be read', () => {
    const sourcePath = join(tmpdir(), 'missing-sonar-mcp-ca.pem');
    const config = getMcpContainerCommand(
      ON_PREMISE_AUTH,
      'docker',
      { withFsMount: false },
      {},
      {
        proxy: null,
        caCert: { source: 'sonar-env', explicit: true, path: sourcePath },
        clientCert: null,
      },
    );

    expect(config.args).toContain(
      `${normalizePath(sourcePath)}:/usr/local/share/ca-certificates/sonar-ca.crt:ro`,
    );
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
