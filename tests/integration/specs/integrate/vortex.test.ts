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
import { SQAA_HOOK_FEATURE_ID } from '@/commands/integrate/_common/features/sqaa-instructions-feature.ts';
import {
  VORTEX_CHECK_FAILED_MESSAGE,
  VORTEX_FEATURE_ID,
  VORTEX_OVER_CONSUMPTION_MESSAGE,
  VORTEX_PROMOTION_MESSAGE,
  VORTEX_SERVER_UNAVAILABLE_MESSAGE,
  VORTEX_UNINSTALL_MESSAGE,
} from '@/commands/integrate/_common/vortex.js';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install/install-types.ts';
import {
  SERVER_ORGANIZATION_ID_PLACEHOLDER,
  type VortexEntitlementStatus,
} from '@/core/server/client.js';
import type { CliState } from '@/core/state/state.ts';

import { TestHarness } from '../../harness';
import { hookScriptName } from '../../harness/platform.ts';

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

  /** Hook entries are owned by the marker appearing in their command (see `ownsHookEntry`). */
  function postToolUseHooks(): string {
    const settingsFile = harness.cwd.file('.claude', 'settings.json');
    return settingsFile.exists()
      ? JSON.stringify(settingsFile.asJson().hooks?.PostToolUse ?? [])
      : '';
  }

  function sqaaHookScriptExists(): boolean {
    return harness.cwd.exists(
      '.claude',
      'hooks',
      'sonar-sqaa',
      'build-scripts',
      hookScriptName('posttool-sqaa'),
    );
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
    preserveState?: boolean;
  }

  async function runIntegrateClaude(
    options: RunOptions = {},
  ): Promise<Awaited<ReturnType<TestHarness['run']>>> {
    const { sqaa = 'enabled', cag = 'enabled', scaEnabled, cloud = true, preserveState } = options;
    const persistedState = preserveState ? (harness.stateJsonFile.asJson() as CliState) : undefined;
    const builder = harness.newFakeServer().withAuthToken(TOKEN).withProject(PROJECT_KEY);
    if (scaEnabled !== undefined) {
      builder.withScaEnabled(scaEnabled);
    }
    if (sqaa === 'check_failed') {
      builder.withSqaaEntitlementStatusCode(500);
    } else if (sqaa === 'not_applicable') {
      builder.withSqaaEntitlementStatusCode(404);
    } else {
      const uuid = cloud ? ORG_UUID : SERVER_ORGANIZATION_ID_PLACEHOLDER;
      builder.withSqaaEntitlement(ORG_KEY, uuid, entitlementBody(sqaa));
    }
    if (cag === 'check_failed') {
      builder.withCagEntitlementStatusCode(500);
    } else if (cag === 'not_applicable') {
      builder.withCagEntitlementStatusCode(404);
    } else {
      const uuid = cloud ? ORG_UUID : SERVER_ORGANIZATION_ID_PLACEHOLDER;
      builder.withCagEntitlement(ORG_KEY, uuid, entitlementBody(cag));
    }

    const server = await builder.start();
    const serverUrl = server.baseUrl();
    // withAuth infers connectionType from whether an org is supplied.
    harness.withAuth(serverUrl, TOKEN, cloud ? ORG_KEY : undefined);
    if (persistedState) {
      const activeConnection = persistedState.auth.connections.find(
        (connection) => connection.id === persistedState.auth.activeConnectionId,
      );
      if (activeConnection) {
        activeConnection.serverUrl = serverUrl;
        if (!cloud) {
          activeConnection.type = 'on-premise';
          activeConnection.orgKey = undefined;
        }
      }
      harness.state().withRawState(JSON.stringify(persistedState));
    }
    harness.state().withContextAugmentationBinaryInstalled();
    const projectProperties = [`sonar.host.url=${serverUrl}`, `sonar.projectKey=${PROJECT_KEY}`];
    if (cloud) {
      projectProperties.push(`sonar.organization=${ORG_KEY}`);
    }
    harness.cwd.writeFile('sonar-project.properties', projectProperties.join('\n'));
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
      expect(harness.cwd.file('CLAUDE.md').asText()).toContain('# Vortex analysis protocol');
    },
    { timeout: 30000 },
  );

  it.each([
    [
      'installs Vortex with an over-consumption warning when SQAA is over its limit and CAG is enabled',
      'over_consumption',
      'enabled',
      true,
      VORTEX_OVER_CONSUMPTION_MESSAGE,
    ],
    [
      'installs Vortex with an over-consumption warning when CAG is over its limit and SQAA is enabled',
      'enabled',
      'over_consumption',
      true,
      VORTEX_OVER_CONSUMPTION_MESSAGE,
    ],
    [
      'skips Vortex when SQAA is over its limit but CAG is not entitled',
      'over_consumption',
      'not_entitled',
      false,
      VORTEX_PROMOTION_MESSAGE,
    ],
    [
      'skips Vortex when CAG is over its limit but SQAA is not entitled',
      'not_entitled',
      'over_consumption',
      false,
      VORTEX_PROMOTION_MESSAGE,
    ],
    [
      'skips Vortex when neither feature is entitled',
      'not_entitled',
      'not_entitled',
      false,
      VORTEX_PROMOTION_MESSAGE,
    ],
    [
      'skips Vortex when the SQAA entitlement check fails even though CAG is entitled',
      'check_failed',
      'enabled',
      false,
      VORTEX_CHECK_FAILED_MESSAGE,
    ],
    [
      'skips Vortex when the CAG entitlement check fails even though SQAA is entitled',
      'enabled',
      'check_failed',
      false,
      VORTEX_CHECK_FAILED_MESSAGE,
    ],
    [
      'skips Vortex when one check fails even though the other is over consumption',
      'over_consumption',
      'check_failed',
      false,
      VORTEX_CHECK_FAILED_MESSAGE,
    ],
  ] as const)(
    '%s',
    async (_name, sqaa, cag, expectedInstalled, expectedMessage) => {
      const result = await runIntegrateClaude({ sqaa, cag, scaEnabled: true });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(expectedInstalled);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expectedMessage);
    },
    { timeout: 30000 },
  );

  it(
    'skips Vortex on a SonarQube Server with neither hub',
    async () => {
      const result = await runIntegrateClaude({
        sqaa: 'not_applicable',
        cag: 'not_applicable',
        cloud: false,
      });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_SERVER_UNAVAILABLE_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'installs Vortex on a licensed SonarQube Server when both hubs are entitled',
    async () => {
      const result = await runIntegrateClaude({
        sqaa: 'enabled',
        cag: 'enabled',
        scaEnabled: true,
        cloud: false,
      });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(true);
      expect(harness.cwd.file('CLAUDE.md').asText()).toContain('# Vortex analysis protocol');
      expect(postToolUseHooks()).toContain('sonar-sqaa');
      expect(sqaaHookScriptExists()).toBe(true);
    },
    { timeout: 30000 },
  );

  it.each([
    ['A3S', 'not_applicable', 'enabled'],
    ['CAG', 'enabled', 'not_applicable'],
  ] as const)(
    'does not install Vortex on a Server whose %s hub is absent',
    async (_hub, sqaa, cag) => {
      const result = await runIntegrateClaude({
        sqaa,
        cag,
        scaEnabled: true,
        cloud: false,
      });

      expect(result.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expect(harness.cwd.file('CLAUDE.md').exists()).toBe(false);
      expect(postToolUseHooks()).not.toContain('sonar-sqaa');
      expect(sqaaHookScriptExists()).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_SERVER_UNAVAILABLE_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'tears down Vortex when a Cloud install is repointed at a Server missing a hub',
    async () => {
      const installed = await runIntegrateClaude({ scaEnabled: true });
      expect(installed.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(true);

      const repointed = await runIntegrateClaude({
        sqaa: 'not_applicable',
        cag: 'enabled',
        scaEnabled: true,
        cloud: false,
        preserveState: true,
      });

      expect(repointed.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(postToolUseHooks()).not.toContain('sonar-sqaa');
      expect(sqaaHookScriptExists()).toBe(false);
      expect(harness.cwd.file('CLAUDE.md').exists()).toBe(false);
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expect(`${repointed.stdout}\n${repointed.stderr}`).toContain(VORTEX_UNINSTALL_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'removes an installed Vortex integration when entitlement is lost',
    async () => {
      const installed = await runIntegrateClaude();
      expect(installed.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(true);

      const removed = await runIntegrateClaude({
        sqaa: 'not_entitled',
        cag: 'enabled',
        preserveState: true,
      });

      expect(removed.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(false);
      expect(`${removed.stdout}\n${removed.stderr}`).toContain(VORTEX_UNINSTALL_MESSAGE);

      const state = harness.stateJsonFile.asJson() as CliState;
      const claude = state.integrations.installed.find(
        (integration) => integration.integrationId === 'claude-code',
      );
      expect(claude?.features.some((feature) => feature.featureId === VORTEX_FEATURE_ID)).toBe(
        false,
      );
      expect(claude?.features.some((feature) => feature.featureId === SQAA_HOOK_FEATURE_ID)).toBe(
        false,
      );
      expect(claude?.features.some((feature) => feature.featureId === 'mcp-server')).toBe(true);
      expect(
        state.dependencies.installed.some(
          (dependency) => dependency.id === CONTEXT_AUGMENTATION_BINARY_NAME,
        ),
      ).toBe(true);
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expect(
        harness.cwd.file('.claude', 'settings.json').asJson().hooks?.PostToolUse,
      ).toBeUndefined();
    },
    { timeout: 60000 },
  );

  it(
    'preserves an installed Vortex integration when the entitlement check fails',
    async () => {
      const installed = await runIntegrateClaude();
      expect(installed.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(true);

      const preserved = await runIntegrateClaude({
        sqaa: 'check_failed',
        cag: 'enabled',
        preserveState: true,
      });

      expect(preserved.exitCode).toBe(0);
      expect(isVortexInstalled()).toBe(true);
      expect(`${preserved.stdout}\n${preserved.stderr}`).toContain(VORTEX_CHECK_FAILED_MESSAGE);
      expect(`${preserved.stdout}\n${preserved.stderr}`).not.toContain(VORTEX_UNINSTALL_MESSAGE);
    },
    { timeout: 60000 },
  );
});
