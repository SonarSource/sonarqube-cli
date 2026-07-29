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
import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.js';
import {
  VORTEX_CHECK_FAILED_MESSAGE,
  VORTEX_OVER_CONSUMPTION_MESSAGE,
  VORTEX_PROMOTION_MESSAGE,
} from '@/commands/integrate/_common/vortex-setup.js';
import type { VortexEntitlementStatus } from '@/core/server/client.js';
import type { CliState } from '@/core/state/state.ts';

import { TestHarness } from '../../harness';

const PROJECT_KEY = 'my-project';
const ORG_KEY = 'my-org';
const ORG_UUID = `${ORG_KEY}-uuid-v4`;
const TOKEN = 'cloud-token';
const CLAUDE_SKILL_PATH = '.claude/skills/sonar-context-augmentation/SKILL.md';

describe('integrate claude — Vortex entitlement', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  /** SQAA and CAG ship together as Vortex, so one probe covers both. */
  function isVortexInstalled(): boolean {
    const settingsFile = harness.cwd.file('.claude', 'settings.json');
    const sqaaHook = settingsFile.exists()
      ? Boolean(settingsFile.asJson().hooks?.PostToolUse)
      : false;
    const state = harness.stateJsonFile.asJson() as CliState;
    const recordedCag = state.integrations.installed.some((integration) =>
      integration.features.some(
        (feature) =>
          feature.featureId === VORTEX_FEATURE_ID &&
          (feature.subfeatures ?? []).some(
            (subfeature) => subfeature.featureId === CONTEXT_AUGMENTATION_FEATURE_ID,
          ),
      ),
    );
    return sqaaHook && recordedCag && harness.cwd.file(CLAUDE_SKILL_PATH).exists();
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
    'installs Vortex when both SQAA and CAG are entitled',
    async () => {
      const result = await runIntegrateClaude({
        sqaa: 'enabled',
        cag: 'enabled',
        scaEnabled: true,
      });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(true);
      expect(harness.cwd.file('CLAUDE.md').asText()).toContain(
        '# SonarQube Agentic Analysis protocol',
      );
    },
    { timeout: 30000 },
  );

  it(
    'installs Vortex with an over-consumption warning when SQAA is over its limit and CAG is enabled',
    async () => {
      const result = await runIntegrateClaude({
        sqaa: 'over_consumption',
        cag: 'enabled',
        scaEnabled: true,
      });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(true);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_OVER_CONSUMPTION_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'installs Vortex with an over-consumption warning when CAG is over its limit and SQAA is enabled',
    async () => {
      const result = await runIntegrateClaude({
        sqaa: 'enabled',
        cag: 'over_consumption',
        scaEnabled: true,
      });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(true);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_OVER_CONSUMPTION_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips Vortex when SQAA is over its limit but CAG is not entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'over_consumption', cag: 'not_entitled' });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_PROMOTION_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips Vortex when CAG is over its limit but SQAA is not entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'not_entitled', cag: 'over_consumption' });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_PROMOTION_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips Vortex when neither feature is entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'not_entitled', cag: 'not_entitled' });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_PROMOTION_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips Vortex when the SQAA entitlement check fails (endpoint error) even though CAG is entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'check_failed', cag: 'enabled' });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_CHECK_FAILED_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips Vortex when the CAG entitlement check fails (endpoint error) even though SQAA is entitled',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'enabled', cag: 'check_failed' });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_CHECK_FAILED_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips Vortex when one check fails even though the other is over consumption (check_failed wins)',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'over_consumption', cag: 'check_failed' });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_CHECK_FAILED_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'skips Vortex on a SonarQube Server connection',
    async () => {
      const result = await runIntegrateClaude({ sqaa: 'enabled', cag: 'enabled', cloud: false });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_PROMOTION_MESSAGE);
    },
    { timeout: 30000 },
  );
});
