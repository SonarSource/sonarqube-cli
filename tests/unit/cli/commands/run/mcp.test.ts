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
import * as os from 'node:os';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '../../../../../src/cli/commands/_common/error.js';
import { runMcp } from '../../../../../src/cli/commands/run/mcp.js';
import type { ResolvedAuth } from '../../../../../src/lib/auth-resolver.js';
import { SONARQUBE_MCP_DOCKER_IMAGE_NAME } from '../../../../../src/lib/config-constants.js';
import type {
  ProxyGroup,
  ResolvedNetworkConfig,
} from '../../../../../src/lib/connectivity/types.js';
import { getMcpContainerCommand } from '../../../../../src/lib/mcp/mcp-helper.js';
import * as projectInfo from '../../../../../src/lib/project-workspace/project-info.js';
import { createRedactedUrl } from '../../../../../src/lib/redacted-url.js';
import * as toolDetector from '../../../../../src/lib/tool-detector.js';

const FAKE_AUTH: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'http://localhost:9000',
  connectionType: 'on-premise',
};

const NO_NETWORK: ResolvedNetworkConfig = { proxy: null, caCert: null, clientCert: null };

function makeProxyNetwork(proxy: ProxyGroup): ResolvedNetworkConfig {
  return { proxy, caCert: null, clientCert: null };
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

  it('throws CommandFailedError when no container runtime is available', () => {
    detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
      runtime: null,
      viaWsl: false,
    });

    expect(runMcp(FAKE_AUTH)).rejects.toBeInstanceOf(CommandFailedError);
  });

  it.each(['docker', 'podman', 'nerdctl'] as const)(
    'runs a WSL-wrapped command when detection reports viaWsl for %s',
    async (runtime) => {
      detectRuntimeSpy = spyOn(toolDetector, 'detectContainerRuntime').mockResolvedValue({
        runtime,
        viaWsl: true,
      });
      spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(makeFakeChild());

      await runMcp(FAKE_AUTH);

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

    await runMcp(FAKE_AUTH);

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

    await runMcp(FAKE_AUTH, { debug: true });

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

    await runMcp(FAKE_AUTH, { readOnly: true });

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

    await runMcp(FAKE_AUTH, { toolsets: 'issues,rules' });

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

    await runMcp(FAKE_AUTH, { project: 'my-project' });

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

    await runMcp(FAKE_AUTH, { project: 'my-project' });

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

    await runMcp(FAKE_AUTH, { project: 'my-project' });

    expect(discoverProjectSpy).not.toHaveBeenCalled();
    expect(spawnSpy.mock.calls[0][1]).toContain('SONARQUBE_PROJECT_KEY');
    expect(spawnSpy.mock.calls[0][1]).not.toContain('-v');
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
