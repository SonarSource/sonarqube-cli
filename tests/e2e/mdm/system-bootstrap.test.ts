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

// Real-system e2e for the MDM install bootstrap scripts (see _helpers.ts for the run gate).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import type { FakeBinariesServer } from '../../integration/harness/fake-binaries-server.js';
import { FakeBinariesServerBuilder } from '../../integration/harness/fake-binaries-server.js';
import { cliBytes, isRealCli } from '../../integration/specs/mdm/mdm-sandbox';
import {
  CAN_RUN_SYSTEM_E2E,
  forceRemove,
  IS_WINDOWS,
  isolatedEnv,
  makeIsolatedHome,
  removeSystemInstall,
  runBootstrapElevated,
  runUnelevated,
  SYSTEM_BINARY,
} from './_helpers';

setDefaultTimeout(180_000);

function listing(directory: string): string {
  return existsSync(directory) ? readdirSync(directory).join(', ') : 'missing';
}

describe.skipIf(!CAN_RUN_SYSTEM_E2E)('MDM install bootstrap on the real system', () => {
  let home: string;
  let cdn: FakeBinariesServer;

  beforeEach(async () => {
    home = makeIsolatedHome();
    cdn = await new FakeBinariesServerBuilder().withStableVersion('9.9.9').start();
    cdn.publishCliArtifact('9.9.9', cliBytes());
  });

  afterEach(async () => {
    removeSystemInstall();
    forceRemove(home);
    await cdn.stop();
  });

  it('downloads, verifies and installs the CLI system-wide', async () => {
    const result = await runBootstrapElevated(
      IS_WINDOWS ? 'install-bootstrap.ps1' : 'install-bootstrap.sh',
      { baseUrl: cdn.cliArtifactBaseUrl() },
      isolatedEnv(home),
    );

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const waitStartedAt = Date.now();
    while (!existsSync(SYSTEM_BINARY) && Date.now() - waitStartedAt < 30_000) {
      await Bun.sleep(500);
    }
    const waitedMs = Date.now() - waitStartedAt;
    const installedSize = existsSync(SYSTEM_BINARY) ? statSync(SYSTEM_BINARY).size : 'missing';
    expect(
      isRealCli(SYSTEM_BINARY),
      `waited ${String(waitedMs)} ms, installed size ${String(installedSize)}, expected ${String(cliBytes().length)}\ninstall dir: ${listing(dirname(SYSTEM_BINARY))}\nhome: ${listing(home)}\n${result.stdout}${result.stderr}`,
    ).toBe(true);
    const version = await runUnelevated(SYSTEM_BINARY, ['--version'], home);
    expect(version.exitCode).toBe(0);
  });
});
