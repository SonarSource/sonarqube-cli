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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test';

import { confirmServerTrust, resolveServer } from '@/commands/auth/select-server.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import * as lookupPathResolver from '@/core/host/git/lookup-path-resolver.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { discoverOrganizationFromConfig } from '@/core/project-discovery/project-info.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('login connection source', () => {
  const directories: string[] = [];
  let cwdSpy: Mock<typeof process.cwd>;
  let lookupSpy: Mock<typeof lookupPathResolver.resolveLookupPaths>;

  beforeEach(() => {
    cwdSpy = spyOn(process, 'cwd');
    lookupSpy = spyOn(lookupPathResolver, 'resolveLookupPaths').mockImplementation(
      (startDir: string) => {
        const checkPath = canonicalizePath(startDir);
        return Promise.resolve([{ checkPath, projectRoot: checkPath }]);
      },
    );
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    lookupSpy.mockRestore();
    for (const dir of directories.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function useDir(): { dir: string; propertiesFile: string } {
    const dir = mkdtempSync(join(tmpdir(), 'sonar-login-source-'));
    directories.push(dir);
    cwdSpy.mockReturnValue(dir);
    return {
      dir,
      propertiesFile: join(canonicalizePath(dir), 'sonar-project.properties'),
    };
  }

  it('names the project file in the self-hosted trust prompt', async () => {
    const { propertiesFile } = useDir();
    writeFileSync(
      propertiesFile,
      'sonar.host.url=https://sonarqube.example.test\nsonar.projectKey=p\n',
    );
    const fake = new FakeConsole();
    fake.queueResponse(false);

    const resolved = await resolveServer(undefined, fake);

    expect(resolved).toEqual({
      server: 'https://sonarqube.example.test',
      configFile: propertiesFile,
    });
    const prints = fake.calls.filter((call) => call.method === 'print').map((call) => call.args[0]);
    expect(prints).toContain(
      `Found sonar-project.properties (${propertiesFile}): project=p, server=https://sonarqube.example.test`,
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(confirmServerTrust(resolved.server, fake, resolved.configFile)).rejects.toThrow(
      CommandFailedError,
    );
    expect(
      fake.findCall(
        'confirmPrompt',
        `Connect to: https://sonarqube.example.test from ${propertiesFile}?`,
      ),
    ).toBeDefined();
  });

  it('keeps an explicit --server from being attributed to a project file', async () => {
    const { propertiesFile } = useDir();
    writeFileSync(propertiesFile, 'sonar.host.url=https://from-file.example.test\n');
    const fake = new FakeConsole();

    const resolved = await resolveServer('https://sonarqube.example.test', fake);

    expect(resolved).toEqual({ server: 'https://sonarqube.example.test' });
    expect(fake.calls.filter((call) => call.method === 'print')).toHaveLength(0);
  });

  it('names the file that supplied the organization', async () => {
    const { propertiesFile } = useDir();
    writeFileSync(
      propertiesFile,
      'sonar.host.url=https://sonarcloud.io\nsonar.organization=from-props\nsonar.projectKey=p\n',
    );

    const discovered = await discoverOrganizationFromConfig(new FakeConsole());

    expect(discovered).toEqual({ value: 'from-props', configFile: propertiesFile });
  });

  it('does not ask to trust a SonarQube Cloud URL taken from a project file', async () => {
    const fake = new FakeConsole();

    await confirmServerTrust('https://sonarcloud.io', fake, '/repo/.sonar-config.json');

    expect(fake.findCall('confirmPrompt', 'Connect to:')).toBeUndefined();
  });
});
