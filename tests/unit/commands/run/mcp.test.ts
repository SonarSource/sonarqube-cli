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

// Unit tests for `sonar run mcp`

import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CliAuthenticatedContext } from '@/commands/cli-context.ts';
import { runMcp } from '@/commands/run/mcp.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { SONARQUBE_MCP_DOCKER_IMAGE_NAME } from '@/core/config-constants.ts';
import type { ProxyGroup, ResolvedNetworkConfig } from '@/core/host/connectivity/types.ts';
import type { ClientCertConfig } from '@/core/host/connectivity/types.ts';
import * as pkcs12Module from '@/core/host/crypto/pkcs12.ts';
import * as toolDetector from '@/core/host/environment/tool-detector.ts';
import {
  clientCertCachePath,
  getMcpContainerCommand,
  MCP_CONTAINER_CA_CERT_PATH,
  MCP_CONTAINER_CLIENT_CERT_PATH,
  resolveMcpContainerCommand,
} from '@/core/host/mcp/mcp-helper.ts';
import { createRedactedUrl } from '@/core/host/redacted-url.ts';
import { normalizePath } from '@/core/io/fs-utils.ts';
import * as projectInfo from '@/core/project-info.ts';

const FAKE_AUTH: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'http://localhost:9000',
  connectionType: 'on-premise',
};

const FAKE_CTX = new CliAuthenticatedContext(FAKE_AUTH, false, false);

const NO_NETWORK: ResolvedNetworkConfig = { proxy: null, caCert: null, clientCert: null };

function makeProxyNetwork(proxy: ProxyGroup): ResolvedNetworkConfig {
  return { proxy, caCert: null, clientCert: null };
}

function makeCaCertNetwork(path: string): ResolvedNetworkConfig {
  return { proxy: null, caCert: { source: 'sonar-env', explicit: true, path }, clientCert: null };
}

function makeClientCertNetwork(overrides: Partial<ClientCertConfig> = {}): ResolvedNetworkConfig {
  const clientCert: ClientCertConfig = {
    source: 'sonar-env',
    explicit: true,
    format: 'pkcs12',
    certPath: '/path/to/client.p12',
    keyPath: null,
    passphrase: undefined,
    resolvedCertPem: 'cert-pem',
    resolvedKeyPem: 'key-pem',
    ...overrides,
  };
  return { proxy: null, caCert: null, clientCert };
}

function makeProxy(overrides: Partial<ProxyGroup> = {}): ProxyGroup {
  return {
    source: 'sonar-env',
    explicit: true,
    proxyHttps: null,
    proxyHttp: null,
    noProxy: null,
    ...overrides,
  };
}

function makeFakeChild(exitCode = 0): childProcess.ChildProcess {
  const emitter = new EventEmitter();
  setImmediate(() => emitter.emit('exit', exitCode));
  return emitter as unknown as childProcess.ChildProcess;
}

describe('runMcp', () => {
  let detectRuntimeSpy: ReturnType<typeof spyOn>;
  let discoverProjectSpy: ReturnType<typeof spyOn>;
  let spawnSpy: ReturnType<typeof spyOn>;
  let homeDirSpy: ReturnType<typeof spyOn>;
  let cwdSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      projectKey: undefined,
      rootDir: '/tmp/non-git-dir',
      isGitRepo: false,
      configSources: [],
    });
  });

  afterEach(() => {
    detectRuntimeSpy?.mockRestore();
    discoverProjectSpy.mockRestore();
    spawnSpy?.mockRestore();
    homeDirSpy?.mockRestore();
    cwdSpy?.mockRestore();
  });

  it('throws CommandFailedError when no container runtime is available', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: null,
      viaWsl: false,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(runMcp(FAKE_CTX, {}, NO_NETWORK)).rejects.toBeInstanceOf(CommandFailedError);
  });

  it.each(['docker', 'podman', 'nerdctl'] as const)(
    'runs a WSL-wrapped command when detection reports viaWsl for %s',
    async (runtime) => {
      detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
        runtime,
        viaWsl: true,
      });
      spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

      await runMcp(FAKE_CTX);

      expect(spawnSpy).toHaveBeenCalledWith(
        'wsl.exe',
        ['sh', '-c', expect.stringContaining(`${runtime} run`)],
        expect.objectContaining({ stdio: 'inherit' }),
      );
      const spawnEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>;
      expect(spawnEnv.WSLENV).toContain('SONARQUBE_TOKEN/u');
    },
  );

  it('spawns with podman when podman is the detected runtime', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: 'podman',
      viaWsl: false,
    });
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_CTX, {}, NO_NETWORK);

    expect(spawnSpy).toHaveBeenCalledWith(
      'podman',
      expect.arrayContaining(['run', SONARQUBE_MCP_DOCKER_IMAGE_NAME]),
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('sets SONARQUBE_DEBUG_ENABLED=true in spawn env when --debug is set', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: 'docker',
      viaWsl: false,
    });
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_CTX, { debug: true }, NO_NETWORK);

    const spawnEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.SONARQUBE_DEBUG_ENABLED).toBe('true');
    expect(spawnSpy.mock.calls[0][1]).toContain('-e');
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_DEBUG_ENABLED');
  });

  it('sets SONARQUBE_READ_ONLY=true in spawn env when --read-only is set', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: 'docker',
      viaWsl: false,
    });
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_CTX, { readOnly: true }, NO_NETWORK);

    const spawnEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.SONARQUBE_READ_ONLY).toBe('true');
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_READ_ONLY');
  });

  it('sets SONARQUBE_TOOLSETS in spawn env when --toolsets is set', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: 'docker',
      viaWsl: false,
    });
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_CTX, { toolsets: 'issues,rules' }, NO_NETWORK);

    const spawnEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.SONARQUBE_TOOLSETS).toBe('issues,rules');
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_TOOLSETS');
  });

  it('sets SONARQUBE_PROJECT_KEY in spawn env when --project is set even when discovery runs', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: 'docker',
      viaWsl: false,
    });
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_CTX, { project: 'my-project' }, NO_NETWORK);

    const spawnEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.SONARQUBE_PROJECT_KEY).toBe('my-project');
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_PROJECT_KEY');
    expect(discoverProjectSpy).toHaveBeenCalledTimes(1);
  });

  it('adds fs mount when --project is set and discovered root is a git repo', async () => {
    discoverProjectSpy.mockResolvedValue({
      projectKey: undefined,
      rootDir: '/tmp/git-repo',
      isGitRepo: true,
      configSources: [],
    });
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: 'docker',
      viaWsl: false,
    });
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_CTX, { project: 'my-project' }, NO_NETWORK);

    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_PROJECT_KEY');
    expect(spawnSpy.mock.calls[0][1]).toContain('-v');
    expect(spawnSpy.mock.calls[0][1]).toContain('/tmp/git-repo:/app/mcp-workspace:ro');
  });

  it('skips project discovery when cwd is user home directory', async () => {
    homeDirSpy = spyOn(os, 'homedir').mockReturnValue('/tmp/home');
    cwdSpy = spyOn(process, 'cwd').mockReturnValue('/tmp/home');
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: 'docker',
      viaWsl: false,
    });
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

    await runMcp(FAKE_CTX, { project: 'my-project' }, NO_NETWORK);

    expect(discoverProjectSpy).not.toHaveBeenCalled();
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_PROJECT_KEY');
    expect(spawnSpy.mock.calls[0][1]).not.toContain('-v');
  });

  it('deletes the cached PKCS12 file after the MCP container exits', async () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: 'docker',
      viaWsl: false,
    });
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());
    // Unique resolvedCertPem gives a cache path that doesn't collide with other test files
    // that use real fixture certs.
    const pemToPkcs12Spy = spyOn(pkcs12Module, 'pemToPkcs12').mockReturnValue(Buffer.from('stub'));

    const clientCert: ClientCertConfig = {
      source: 'sonar-env',
      explicit: true,
      format: 'pem',
      certPath: '/path/to/client.pem',
      keyPath: '/path/to/client.key',
      passphrase: undefined,
      resolvedCertPem: 'cleanup-test-cert',
      resolvedKeyPem: 'cleanup-test-key',
    };
    const cachedPath = clientCertCachePath(clientCert);

    try {
      await runMcp(FAKE_CTX, {}, { proxy: null, caCert: null, clientCert });

      expect(existsSync(cachedPath)).toBe(false);
    } finally {
      pemToPkcs12Spy.mockRestore();
      rmSync(cachedPath, { force: true });
    }
  });
});

describe('getMcpContainerCommand — proxy → JAVA_OPTS', () => {
  const context = { withFsMount: false } as const;

  it('does not set JAVA_OPTS when no proxy is configured', () => {
    const result = getMcpContainerCommand(FAKE_AUTH, 'docker', context, {}, NO_NETWORK);

    expect(result.env.JAVA_OPTS).toBeUndefined();
    expect(result.args).not.toContain('JAVA_OPTS');
  });

  it('sets https proxy host and port from proxyHttps', () => {
    const network = makeProxyNetwork(
      makeProxy({ proxyHttps: createRedactedUrl('http://proxy.corp.com:3128') }),
    );
    const result = getMcpContainerCommand(FAKE_AUTH, 'docker', context, {}, network);

    expect(result.env.JAVA_OPTS).toContain('-Dhttps.proxyHost=proxy.corp.com');
    expect(result.env.JAVA_OPTS).toContain('-Dhttps.proxyPort=3128');
    expect(result.args).toContain('JAVA_OPTS');
  });

  it('sets https proxy credentials when present in URL', () => {
    const network = makeProxyNetwork(
      makeProxy({ proxyHttps: createRedactedUrl('http://alice:secret@proxy.corp.com:3128') }),
    );
    const result = getMcpContainerCommand(FAKE_AUTH, 'docker', context, {}, network);

    expect(result.env.JAVA_OPTS).toContain('-Dhttps.proxyUser=alice');
    expect(result.env.JAVA_OPTS).toContain('-Dhttps.proxyPassword=secret');
  });

  it('sets http proxy host and port from proxyHttp', () => {
    const network = makeProxyNetwork(
      makeProxy({ proxyHttp: createRedactedUrl('http://proxy.corp.com:8080') }),
    );
    const result = getMcpContainerCommand(FAKE_AUTH, 'docker', context, {}, network);

    expect(result.env.JAVA_OPTS).toContain('-Dhttp.proxyHost=proxy.corp.com');
    expect(result.env.JAVA_OPTS).toContain('-Dhttp.proxyPort=8080');
  });

  describe('noProxy → http.nonProxyHosts conversion', () => {
    function nonProxyHosts(noProxy: string): string {
      const network = makeProxyNetwork(
        makeProxy({ proxyHttps: createRedactedUrl('http://proxy.corp.com:3128'), noProxy }),
      );
      const result = getMcpContainerCommand(FAKE_AUTH, 'docker', context, {}, network);
      const match = /-Dhttp\.nonProxyHosts=(\S+)/.exec(result.env.JAVA_OPTS ?? '');
      return match?.[1] ?? '';
    }

    it('converts comma separator to pipe', () => {
      expect(nonProxyHosts('localhost,internal.corp.com')).toBe('localhost|internal.corp.com');
    });

    it('strips whitespace around comma-separated entries', () => {
      expect(nonProxyHosts('localhost, internal.corp.com')).toBe('localhost|internal.corp.com');
    });

    it('converts leading dot to wildcard prefix (.corp.com → *.corp.com)', () => {
      expect(nonProxyHosts('.corp.com')).toBe('*.corp.com');
    });

    it('passes through * unchanged (no double-wildcard)', () => {
      expect(nonProxyHosts('*')).toBe('*');
    });

    it('passes through already-wildcarded entries unchanged (*.corp.com)', () => {
      expect(nonProxyHosts('*.corp.com')).toBe('*.corp.com');
    });

    it('passes through CIDR entries unchanged (neither CLI nor Java support them)', () => {
      expect(nonProxyHosts('10.0.0.0/8')).toBe('10.0.0.0/8');
    });
  });

  it('omits proxyPort when URL has no explicit port (Java uses its own defaults)', () => {
    const network = makeProxyNetwork(
      makeProxy({ proxyHttps: createRedactedUrl('https://proxy.corp.com') }),
    );
    const result = getMcpContainerCommand(FAKE_AUTH, 'docker', context, {}, network);

    expect(result.env.JAVA_OPTS).not.toContain('proxyPort');
  });
});

describe('getMcpContainerCommand — CA cert → volume mount', () => {
  const context = { withFsMount: false } as const;

  it('does not add a CA cert volume mount when no CA cert is configured', () => {
    const result = getMcpContainerCommand(FAKE_AUTH, 'docker', context, {}, NO_NETWORK);

    expect(result.args).not.toContain('-v');
  });

  it('mounts the CA cert to the container system CA directory', () => {
    const result = getMcpContainerCommand(
      FAKE_AUTH,
      'docker',
      context,
      {},
      makeCaCertNetwork('/etc/ssl/corp-ca.pem'),
    );

    expect(result.args).toContain('-v');
    expect(result.args).toContain(`/etc/ssl/corp-ca.pem:${MCP_CONTAINER_CA_CERT_PATH}:ro`);
  });
});

describe('getMcpContainerCommand — client cert → volume mount + JAVA_OPTS', () => {
  const context = { withFsMount: false } as const;

  it('does not add a client cert mount or JAVA_OPTS when no client cert is configured', () => {
    const result = getMcpContainerCommand(FAKE_AUTH, 'docker', context, {}, NO_NETWORK);

    expect(result.args).not.toContain('-v');
    expect(result.env.JAVA_OPTS).toBeUndefined();
  });

  it('mounts the PKCS12 file to the fixed container path', () => {
    const result = getMcpContainerCommand(
      FAKE_AUTH,
      'docker',
      context,
      {},
      makeClientCertNetwork({ certPath: '/path/to/client.p12' }),
    );

    expect(result.args).toContain(`/path/to/client.p12:${MCP_CONTAINER_CLIENT_CERT_PATH}:ro`);
  });

  it('sets keyStore and keyStoreType in JAVA_OPTS', () => {
    const result = getMcpContainerCommand(
      FAKE_AUTH,
      'docker',
      context,
      {},
      makeClientCertNetwork(),
    );

    expect(result.env.JAVA_OPTS).toContain(
      `-Djavax.net.ssl.keyStore=${MCP_CONTAINER_CLIENT_CERT_PATH}`,
    );
    expect(result.env.JAVA_OPTS).toContain('-Djavax.net.ssl.keyStoreType=PKCS12');
    expect(result.args).toContain('JAVA_OPTS');
  });

  it('sets keyStorePassword in JAVA_OPTS when passphrase is present', () => {
    const result = getMcpContainerCommand(
      FAKE_AUTH,
      'docker',
      context,
      {},
      makeClientCertNetwork({ passphrase: 'secret' }),
    );

    expect(result.env.JAVA_OPTS).toContain('-Djavax.net.ssl.keyStorePassword=secret');
  });

  it('omits keyStorePassword from JAVA_OPTS when no passphrase', () => {
    const result = getMcpContainerCommand(
      FAKE_AUTH,
      'docker',
      context,
      {},
      makeClientCertNetwork(),
    );

    expect(result.env.JAVA_OPTS).not.toContain('keyStorePassword');
  });

  it('combines proxy and client cert opts into a single JAVA_OPTS', () => {
    const network: ResolvedNetworkConfig = {
      proxy: {
        source: 'sonar-env',
        explicit: true,
        proxyHttps: createRedactedUrl('http://proxy.corp.com:3128'),
        proxyHttp: null,
        noProxy: null,
      },
      caCert: null,
      clientCert: {
        source: 'sonar-env',
        explicit: true,
        format: 'pkcs12',

        certPath: '/path/to/client.p12',
        keyPath: null,
        passphrase: undefined,
        resolvedCertPem: '',
        resolvedKeyPem: '',
      },
    };
    const result = getMcpContainerCommand(FAKE_AUTH, 'docker', context, {}, network);

    expect(result.env.JAVA_OPTS).toContain('-Dhttps.proxyHost=proxy.corp.com');
    expect(result.env.JAVA_OPTS).toContain(
      `-Djavax.net.ssl.keyStore=${MCP_CONTAINER_CLIENT_CERT_PATH}`,
    );
  });

  it('converts PEM cert+key to PKCS12, mounts temp file, sets keystore opts without password', () => {
    const FIXTURE_DIR = join(import.meta.dir, '../../../fixtures/client-cert');
    const certPem = readFileSync(join(FIXTURE_DIR, 'client-cert.pem'), 'utf-8');
    const keyPem = readFileSync(join(FIXTURE_DIR, 'client-key.pem'), 'utf-8');

    const clientCert: ClientCertConfig = {
      source: 'sonar-env',
      explicit: true,
      format: 'pem',
      certPath: join(FIXTURE_DIR, 'client-cert.pem'),
      keyPath: join(FIXTURE_DIR, 'client-key.pem'),
      passphrase: undefined,
      resolvedCertPem: certPem,
      resolvedKeyPem: keyPem,
    };

    try {
      const result = getMcpContainerCommand(
        FAKE_AUTH,
        'docker',
        context,
        {},
        { proxy: null, caCert: null, clientCert },
      );

      expect(result.args.some((arg) => arg.includes(MCP_CONTAINER_CLIENT_CERT_PATH))).toBe(true);
      expect(result.env.JAVA_OPTS).toContain(
        `-Djavax.net.ssl.keyStore=${MCP_CONTAINER_CLIENT_CERT_PATH}`,
      );
      expect(result.env.JAVA_OPTS).not.toContain('keyStorePassword');
    } finally {
      rmSync(clientCertCachePath(clientCert), { force: true });
    }
  });
});

describe('resolveMcpContainerCommand — WSL cert path forwarding', () => {
  const WSL_DETECTION = { runtime: 'docker', viaWsl: true } as const;
  const context = { withFsMount: false } as const;

  it('forwards CA cert path via WSLENV /p translation instead of embedding it literally', () => {
    const result = resolveMcpContainerCommand(
      FAKE_AUTH,
      WSL_DETECTION,
      context,
      {},
      makeCaCertNetwork('/home/user/sonar-ca.pem'),
    );

    expect(result.command).toBe('wsl.exe');
    expect(result.env.SONARQUBE_MCP_CA_PATH).toBe('/home/user/sonar-ca.pem');
    expect(result.env.WSLENV).toContain('SONARQUBE_MCP_CA_PATH/p');
    expect(result.args[2]).toContain(`"$SONARQUBE_MCP_CA_PATH":${MCP_CONTAINER_CA_CERT_PATH}:ro`);
    expect(result.args[2]).not.toContain('/home/user/sonar-ca.pem');
  });

  it('forwards PKCS12 client cert path via WSLENV /p translation instead of embedding it literally', () => {
    const result = resolveMcpContainerCommand(
      FAKE_AUTH,
      WSL_DETECTION,
      context,
      {},
      makeClientCertNetwork({ certPath: '/home/user/client.p12' }),
    );

    expect(result.env.SONARQUBE_MCP_CLIENT_CERT_PATH).toBe('/home/user/client.p12');
    expect(result.env.WSLENV).toContain('SONARQUBE_MCP_CLIENT_CERT_PATH/p');
    expect(result.args[2]).toContain(
      `"$SONARQUBE_MCP_CLIENT_CERT_PATH":${MCP_CONTAINER_CLIENT_CERT_PATH}:ro`,
    );
    expect(result.args[2]).not.toContain('/home/user/client.p12');
  });

  it('forwards PEM-derived PKCS12 cache path via WSLENV /p translation', () => {
    const pemToPkcs12Spy = spyOn(pkcs12Module, 'pemToPkcs12').mockReturnValue(Buffer.from('stub'));
    const clientCert: ClientCertConfig = {
      source: 'sonar-env',
      explicit: true,
      format: 'pem',
      certPath: '/path/to/cert.pem',
      keyPath: '/path/to/key.pem',
      passphrase: undefined,
      resolvedCertPem: 'wsl-test-cert',
      resolvedKeyPem: 'wsl-test-key',
    };
    const cachedPath = clientCertCachePath(clientCert);

    try {
      const result = resolveMcpContainerCommand(
        FAKE_AUTH,
        WSL_DETECTION,
        context,
        {},
        {
          proxy: null,
          caCert: null,
          clientCert,
        },
      );

      expect(result.env.SONARQUBE_MCP_CLIENT_CERT_PATH).toBe(normalizePath(cachedPath));
      expect(result.env.WSLENV).toContain('SONARQUBE_MCP_CLIENT_CERT_PATH/p');
      expect(result.args[2]).toContain(
        `"$SONARQUBE_MCP_CLIENT_CERT_PATH":${MCP_CONTAINER_CLIENT_CERT_PATH}:ro`,
      );
      expect(result.args[2]).not.toContain(cachedPath);
    } finally {
      pemToPkcs12Spy.mockRestore();
      rmSync(cachedPath, { force: true });
    }
  });
});
