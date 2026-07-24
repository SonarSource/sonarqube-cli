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

import { CONTEXT_AUGMENTATION_FEATURE_ID } from '@/commands/integrate/_common/features/context-augmentation-feature.js';
import {
  SQAA_OVER_CONSUMPTION_MESSAGE,
  SQAA_PROMOTION_MESSAGE,
} from '@/commands/integrate/_common/sqaa-entitlement.js';
import type { VortexEntitlementStatus } from '@/core/server/client.js';
import type { CliState } from '@/lib/state.js';

import { TestHarness } from '../../harness';

const PROJECT_KEY = 'my-project';
const ORG_KEY = 'my-org';
const ORG_UUID = `${ORG_KEY}-uuid-v4`;
const TOKEN = 'cloud-token';
const CLAUDE_SKILL_PATH = '.claude/skills/sonar-context-augmentation/SKILL.md';

const CAG_NOT_ENTITLED_MESSAGE = 'not available for your organization';
const CAG_CHECK_FAILED_MESSAGE = 'could not verify entitlement';
const CAG_SERVER_MESSAGE = 'not available on SonarQube Server';

describe('integrate claude — Vortex entitlement', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function isSqaaHookInstalled(): boolean {
    const settingsFile = harness.cwd.file('.claude', 'settings.json');
    return settingsFile.exists() ? Boolean(settingsFile.asJson().hooks?.PostToolUse) : false;
  }

  function isCagInstalled(): boolean {
    const state = harness.stateJsonFile.asJson() as CliState;
    const recorded = state.integrations.installed.some((integration) =>
      integration.features.some((feature) => feature.featureId === CONTEXT_AUGMENTATION_FEATURE_ID),
    );
    return recorded && harness.cwd.file(CLAUDE_SKILL_PATH).exists();
  }

  function entitlementBody(status: Exclude<VortexEntitlementStatus, 'check_failed'>): {
    allowed: boolean;
    hasEntitlement: boolean;
  } {
    return { allowed: status === 'enabled', hasEntitlement: status !== 'not_entitled' };
  }

  interface RunOptions {
    sqaa?: VortexEntitlementStatus;
    cag?: VortexEntitlementStatus;
    scaEnabled?: boolean;
    cloud?: boolean;
  }

  async function runIntegrateClaude(
    options: RunOptions = {},
  ): Promise<Awaited<ReturnType<TestHarness['run']>>> {
    const { sqaa = 'enabled', cag = 'enabled', scaEnabled, cloud = true } = options;
    const builder = harness.newFakeServer().withAuthToken(TOKEN).withProject(PROJECT_KEY);
    if (scaEnabled !== undefined) {
      builder.withScaEnabled(scaEnabled);
    }
    if (sqaa !== 'check_failed') {
      builder.withSqaaEntitlement(ORG_KEY, ORG_UUID, entitlementBody(sqaa));
    }
    if (cag === 'check_failed') {
      builder.withCagEntitlementStatusCode(500);
    } else {
      builder.withCagEntitlement(ORG_KEY, ORG_UUID, entitlementBody(cag));
    }

    const server = await builder.start();
    const serverUrl = server.baseUrl();
    harness.withAuth(serverUrl, TOKEN, ORG_KEY);
    harness.state().withContextAugmentationBinaryInstalled();
    harness.cwd.writeFile(
      'sonar-project.properties',
      [
        `sonar.host.url=${serverUrl}`,
        `sonar.projectKey=${PROJECT_KEY}`,
        `sonar.organization=${ORG_KEY}`,
      ].join('\n'),
    );
    return harness.run('integrate claude --non-interactive', {
      extraEnv: cloud
        ? {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          }
        : {},
    });
  }

  it(
    'installs both SQAA and CAG when both features are entitled',
    async () => {
      const result = await runIntegrateClaude({
        sqaa: 'enabled',
        cag: 'enabled',
        scaEnabled: true,
      });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(true);
      expect(isCagInstalled()).toBe(true);
      expect(harness.cwd.file('CLAUDE.md').asText()).toContain(
        '# SonarQube Agentic Analysis protocol',
      );
    },
    { timeout: 30000 },
  );

  it(
    'installs both with an over-consumption warning when SQAA is over its limit and CAG is enabled',
    async () => {
      const result = await runIntegrateClaude({
        sqaa: 'over_consumption',
        cag: 'enabled',
        scaEnabled: true,
      });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(true);
      expect(isCagInstalled()).toBe(true);
      expect(`${result.stdout}\n${result.stderr}`).toContain(SQAA_OVER_CONSUMPTION_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'installs both with an over-consumption warning when CAG is over its limit and SQAA is enabled',
    async () => {
      const result = await runIntegrateClaude({
        sqaa: 'enabled',
        cag: 'over_consumption',
        scaEnabled: true,
      });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(true);
      expect(isCagInstalled()).toBe(true);
      expect(`${result.stdout}\n${result.stderr}`).toContain(SQAA_OVER_CONSUMPTION_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips both when SQAA is over its limit but CAG is not entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'over_consumption', cag: 'not_entitled' });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(false);
      expect(isCagInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(SQAA_PROMOTION_MESSAGE);
      expect(`${result.stdout}\n${result.stderr}`).toContain(CAG_NOT_ENTITLED_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips both when CAG is over its limit but SQAA is not entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'not_entitled', cag: 'over_consumption' });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(false);
      expect(isCagInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(SQAA_PROMOTION_MESSAGE);
      expect(`${result.stdout}\n${result.stderr}`).toContain(CAG_NOT_ENTITLED_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips both when neither feature is entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'not_entitled', cag: 'not_entitled' });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(false);
      expect(isCagInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(SQAA_PROMOTION_MESSAGE);
      expect(`${result.stdout}\n${result.stderr}`).toContain(CAG_NOT_ENTITLED_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips both when the SQAA entitlement check fails (endpoint error) even though CAG is entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'check_failed', cag: 'enabled' });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(false);
      expect(isCagInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(CAG_CHECK_FAILED_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips both when the CAG entitlement check fails (endpoint error) even though SQAA is entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'enabled', cag: 'check_failed' });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(false);
      expect(isCagInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(CAG_CHECK_FAILED_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips both when one check fails even though the other is over consumption (check_failed wins)',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'over_consumption', cag: 'check_failed' });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(false);
      expect(isCagInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(CAG_CHECK_FAILED_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips both on a SonarQube Server connection',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'enabled', cag: 'enabled', cloud: false });

      expect(result.exitCode).toBe(0);
      expect(isSqaaHookInstalled()).toBe(false);
      expect(isCagInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(SQAA_PROMOTION_MESSAGE);
      expect(`${result.stdout}\n${result.stderr}`).toContain(CAG_SERVER_MESSAGE);
    },
    { timeout: 30000 },
  );
});
