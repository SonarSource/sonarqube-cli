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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { piIntegration } from '@/commands/integrate/pi/declaration.ts';
import { PI_EXTENSION_MANAGED_MARKER } from '@/commands/integrate/pi/secrets-extension-content.ts';

import { type CliResult, TestHarness } from '../../harness';
import { findInstalledFeature } from './state-helpers';

const SECRETS_EXTENSION_PATH = '.pi/agent/extensions/sonar-secrets.ts';

function findPiFeature(harness: TestHarness, featureId: string) {
  return findInstalledFeature(harness, 'pi', featureId);
}

describe('integrate pi — secrets scanning extension', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'installs the managed secrets extension in ~/.pi/agent/extensions',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const result = await harness.run('integrate pi --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(findPiFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
      const extension = harness.userHome.file(...SECRETS_EXTENSION_PATH.split('/')).asText();
      expect(extension).toContain(PI_EXTENSION_MANAGED_MARKER);
      expect(extension).toContain('pi-pre-tool-use');
      expect(extension).toContain('pi-chat-message');
    },
    { timeout: 30000 },
  );

  it(
    'removes only the secrets extension when the user declines to keep the feature',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness
        .state()
        .withInstalledIntegrationFeature(
          piIntegration,
          'sonar-secrets-hooks',
          'global',
          harness.userHome.path,
        );
      harness.userHome.writeFile(
        SECRETS_EXTENSION_PATH,
        `// ${PI_EXTENSION_MANAGED_MARKER} — do not edit by hand.\n`,
      );
      harness.userHome.writeFile('.pi/agent/extensions/other.ts', 'export default () => {};\n');

      const session = harness.runInteractive('integrate pi');
      await session.decline('secret scanning hooks (currently installed)  Keep?');
      await session.accept('Proceed with removal?');
      const result: CliResult = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(findPiFeature(harness, 'sonar-secrets-hooks')).toBeUndefined();
      expect(harness.userHome.exists(SECRETS_EXTENSION_PATH)).toBe(false);
      expect(harness.userHome.exists('.pi/agent/extensions/other.ts')).toBe(true);
    },
    { timeout: 30000 },
  );
});
