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

import { beforeEach, describe, expect, it, mock } from 'bun:test';

const binaryModule = await import('../../../../../src/commands/_common/install/binary.ts');

type InstallBinaryFn = typeof binaryModule.installBinary;
type ResolveBinaryPathFn = typeof binaryModule.resolveBinaryPath;

const notConfigured = (name: string) => () => {
  throw new Error(`${name} not configured for this test`);
};

let installBinaryImpl: InstallBinaryFn = notConfigured('installBinary');
let resolveBinaryPathImpl: ResolveBinaryPathFn = notConfigured('resolveBinaryPath');

void mock.module('../../../../../src/commands/_common/install/binary.ts', () => ({
  ...binaryModule,
  installBinary: ((spec, options) => installBinaryImpl(spec, options)) as InstallBinaryFn,
  resolveBinaryPath: ((spec) => resolveBinaryPathImpl(spec)) as ResolveBinaryPathFn,
}));

const { DefaultSecretsInstaller, ResolveOnlySecretsInstaller } =
  await import('../../../../../src/commands/_common/install/secrets.ts');

describe('ResolveOnlySecretsInstaller', () => {
  beforeEach(() => {
    resolveBinaryPathImpl = notConfigured('resolveBinaryPath');
  });

  it('returns the resolved binary path when sonar-secrets is present', async () => {
    resolveBinaryPathImpl = () => '/bin/sonar-secrets';

    const result = await new ResolveOnlySecretsInstaller().install();

    expect(result).toBe('/bin/sonar-secrets');
  });

  it('returns null when sonar-secrets is not installed', async () => {
    resolveBinaryPathImpl = () => null;

    expect(await new ResolveOnlySecretsInstaller().install()).toBeNull();
  });

  it('returns null instead of throwing when resolution fails', async () => {
    resolveBinaryPathImpl = () => {
      throw new Error('keychain unavailable');
    };

    expect(await new ResolveOnlySecretsInstaller().install()).toBeNull();
  });
});

describe('DefaultSecretsInstaller', () => {
  beforeEach(() => {
    installBinaryImpl = notConfigured('installBinary');
  });

  it('installs sonar-secrets and returns the binary path', async () => {
    installBinaryImpl = () =>
      Promise.resolve({ binaryPath: '/bin/sonar-secrets', freshlyInstalled: false });

    const result = await new DefaultSecretsInstaller().install();

    expect(result).toBe('/bin/sonar-secrets');
  });

  it('propagates the install error when the binary cannot be installed', () => {
    installBinaryImpl = () => Promise.reject(new Error('download failed'));

    expect(new DefaultSecretsInstaller().install()).rejects.toThrow(/download failed/);
  });
});
