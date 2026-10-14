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

import { describe, expect, it } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import {
  isLoopbackServerUrl,
  mcpLoopbackAdvice,
  resolveMcpContainerNetworking,
} from '@/core/host/mcp/mcp-network.ts';

const ON_PREMISE_AUTH = new ResolvedAuth({
  token: 'test-token',
  serverUrl: 'http://localhost:9000',
  connectionType: 'on-premise',
  source: 'state' as const,
});

const CLOUD_AUTH = new ResolvedAuth({
  token: 'test-token',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud',
  source: 'state' as const,
});

describe('MCP container networking', () => {
  it.each([
    ['localhost', true],
    ['api.localhost', true],
    ['127.0.0.1', true],
    ['127.2.3.4', true],
    ['0.0.0.0', true],
    ['[::1]', true],
    ['sonarqube', false],
  ])('classifies %s as loopback: %s', (host, expected) => {
    expect(isLoopbackServerUrl(`http://${host}:9000`)).toBe(expected);
  });

  it.each(['docker', 'podman', 'nerdctl'] as const)(
    'uses host networking on native Linux with %s',
    (runtime) => {
      expect(
        resolveMcpContainerNetworking(ON_PREMISE_AUTH, { runtime, viaWsl: false }, {}, 'linux'),
      ).toEqual({ serverUrl: 'http://localhost:9000', network: 'host' });
    },
  );

  it.each([
    ['docker', 'host.docker.internal'],
    ['podman', 'host.containers.internal'],
  ] as const)('uses the %s host alias outside native Linux', (runtime, alias) => {
    expect(
      resolveMcpContainerNetworking(ON_PREMISE_AUTH, { runtime, viaWsl: true }, {}, 'win32'),
    ).toEqual({ serverUrl: `http://${alias}:9000/` });
  });

  it('keeps explicit settings and the container-only URL for a user-defined network', () => {
    expect(
      resolveMcpContainerNetworking(
        ON_PREMISE_AUTH,
        { runtime: 'podman', viaWsl: true },
        { network: 'sonar-net', serverUrl: 'http://sonarqube:9000' },
        'win32',
      ),
    ).toEqual({
      serverUrl: 'http://sonarqube:9000',
      network: 'sonar-net',
      addHost: undefined,
    });
    expect(ON_PREMISE_AUTH.serverUrl).toBe('http://localhost:9000');
  });

  it('ignores on-premise networking settings for Cloud', () => {
    expect(
      resolveMcpContainerNetworking(
        CLOUD_AUTH,
        { runtime: 'docker', viaWsl: false },
        { network: 'host', addHost: 'example:host-gateway', serverUrl: 'http://sonarqube:9000' },
        'linux',
      ),
    ).toEqual({ serverUrl: 'https://sonarcloud.io' });
  });

  it.each(['ftp://sonarqube', 'http://user:password@sonarqube', 'not-a-url'])(
    'rejects an invalid container URL: %s',
    (serverUrl) => {
      expect(() =>
        resolveMcpContainerNetworking(
          ON_PREMISE_AUTH,
          { runtime: 'docker', viaWsl: false },
          { serverUrl },
        ),
      ).toThrow('mcp.container.serverUrl must be an HTTP or HTTPS URL');
    },
  );

  it('advises a container URL override when an explicit network retains loopback', () => {
    expect(mcpLoopbackAdvice(ON_PREMISE_AUTH, { network: 'sonar-net' })).toContain(
      'Set mcp.container.serverUrl',
    );
    expect(
      mcpLoopbackAdvice(ON_PREMISE_AUTH, {
        network: 'sonar-net',
        serverUrl: 'http://sonarqube:9000',
      }),
    ).toBeUndefined();
  });
});
