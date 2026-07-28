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

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import * as scaScannerInstall from '@/core/host/install/sca-scanner.ts';
import * as secretsInstall from '@/core/host/install/secrets.ts';
import { SCA_SCANNER_BINARY_NAME } from '@/core/host/install-types.ts';
import type { CliState } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import {
  updateScaScannerBinaryIfNeeded,
  updateSecretsBinaryIfNeeded,
} from '@/core/update/binary-refresh.ts';

function makeState(): CliState {
  return getDefaultState('1.0.0');
}

function makeStateWithSecrets(): CliState {
  const state = makeState();
  state.tools = {
    installed: [
      {
        name: 'sonar-secrets',
        version: '0.0.0.1',
        path: '/fake/bin/sonar-secrets-0.0.0.1-linux-x86-64',
        installedAt: '2026-01-01T00:00:00.000Z',
        installedByCliVersion: '1.0.0',
      },
    ],
  };
  return state;
}

describe('updateSecretsBinaryIfNeeded', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let installSecretsBinarySpy: Mock<typeof secretsInstall.installSecretsBinary>;

  beforeEach(() => {
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeStateWithSecrets());
    installSecretsBinarySpy = spyOn(secretsInstall, 'installSecretsBinary').mockResolvedValue(
      '/fake/bin/sonar-secrets',
    );
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    installSecretsBinarySpy.mockRestore();
  });

  it('does nothing when no previous binary is recorded in state', async () => {
    loadStateSpy.mockReturnValue(makeState()); // tools.installed is empty

    await updateSecretsBinaryIfNeeded();

    expect(installSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('calls installSecretsBinary when a previous installation is recorded in state', async () => {
    await updateSecretsBinaryIfNeeded();

    expect(installSecretsBinarySpy).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from installSecretsBinary to the caller', () => {
    installSecretsBinarySpy.mockRejectedValue(new Error('download failed'));

    expect(updateSecretsBinaryIfNeeded()).rejects.toThrow('download failed');
  });
});

function makeStateWithScaScanner(): CliState {
  const state = makeState();
  state.tools = {
    installed: [
      {
        name: SCA_SCANNER_BINARY_NAME,
        version: '0.0.0.1',
        path: '/fake/bin/sca-scanner-cli-0.0.0.1-linux-x86-64',
        installedAt: '2026-01-01T00:00:00.000Z',
        installedByCliVersion: '1.0.0',
      },
    ],
  };
  return state;
}

describe('updateScaScannerBinaryIfNeeded', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let installScaScannerBinarySpy: Mock<typeof scaScannerInstall.installScaScannerBinary>;

  beforeEach(() => {
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeStateWithScaScanner());
    installScaScannerBinarySpy = spyOn(
      scaScannerInstall,
      'installScaScannerBinary',
    ).mockResolvedValue('/fake/bin/sca-scanner-cli');
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    installScaScannerBinarySpy.mockRestore();
  });

  it('does nothing when no previous binary is recorded in state', async () => {
    loadStateSpy.mockReturnValue(makeState()); // tools.installed is empty

    await updateScaScannerBinaryIfNeeded();

    expect(installScaScannerBinarySpy).not.toHaveBeenCalled();
  });

  it('calls installScaScannerBinary when a previous installation is recorded in state', async () => {
    await updateScaScannerBinaryIfNeeded();

    expect(installScaScannerBinarySpy).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from installScaScannerBinary to the caller', () => {
    installScaScannerBinarySpy.mockRejectedValue(new Error('download failed'));

    expect(updateScaScannerBinaryIfNeeded()).rejects.toThrow('download failed');
  });
});
