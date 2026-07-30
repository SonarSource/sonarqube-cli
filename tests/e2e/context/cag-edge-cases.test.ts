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

/**
 * Offline e2e covering the post-update edge cases for sonar-context-augmentation:
 * skills with missing project roots, multi-skill refresh, no-op when the CLI
 * version is already current, and stale-binary cleanup.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { CLAUDE_INTEGRATION_ID } from '@/commands/integrate/claude/declaration.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalCagBinaryName } from '@/core/host/install/context-augmentation.ts';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install/install-types.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';
import type { CliState } from '@/core/state/state.ts';

import { version as CURRENT_CLI_VERSION } from '../../../package.json';
import { TestHarness } from '../../integration/harness';
import {
  CLAUDE_SKILL_RELATIVE_PATH,
  expectSkillRendersWithWrapperInvocation,
  findRecordedCagDependency,
  findRecordedCagFeature,
  findRecordedCagSkillResource,
  seedState,
  STALE_CLI_VERSION,
  STALE_SKILL_VERSION,
} from './_helpers';

const DEFAULT_TIMEOUT_MS = 180_000;
const POST_UPDATE_TIMEOUT_MS = 150_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

describe('sonar-context-augmentation post-update edge cases (offline, real binary)', () => {
  let harness: TestHarness;
  let cagBinaryPath: string;

  beforeEach(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    cagBinaryPath = join(harness.cliHome.path, 'bin', buildLocalCagBinaryName(detectPlatform()));
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('skips skill refresh when the recorded project root no longer exists', async () => {
    const missingRoot = join(harness.cwd.path, 'has-been-deleted');
    seedState(harness, {
      skills: [{ agentId: 'claude-code', projectRoot: missingRoot }],
    });

    const result = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);

    expect(existsSync(cagBinaryPath), 'binary should not be downloaded for a deleted project').toBe(
      false,
    );
    expect(existsSync(join(missingRoot, CLAUDE_SKILL_RELATIVE_PATH))).toBe(false);

    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
    expect(findRecordedCagDependency(state)).toBeUndefined();
    const feature = findRecordedCagFeature(
      state,
      ({ integrationId, feature: installedFeature }) =>
        integrationId === CLAUDE_INTEGRATION_ID && installedFeature.targetRoot === missingRoot,
    );
    expect(feature).toBeDefined();
    if (!feature) {
      throw new Error('Expected the deleted-root declarative CAG feature to remain recorded');
    }
    const resource = findRecordedCagSkillResource(feature);
    expect(resource).toBeDefined();
    expect(resource?.version).toBe(STALE_SKILL_VERSION);
  });

  it('refreshes every recorded skill across multiple project roots in one post-update', async () => {
    const projectA = join(harness.userHome.path, 'project-a');
    const projectB = join(harness.userHome.path, 'project-b');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });

    seedState(harness, {
      skills: [
        { agentId: 'claude-code', projectRoot: projectA },
        { agentId: 'claude-code', projectRoot: projectB },
      ],
    });

    const skillPathA = join(projectA, CLAUDE_SKILL_RELATIVE_PATH);
    const skillPathB = join(projectB, CLAUDE_SKILL_RELATIVE_PATH);
    const sentinelA = '<<stale-skill-A-multi-refresh-e2e>>';
    const sentinelB = '<<stale-skill-B-multi-refresh-e2e>>';
    mkdirSync(dirname(skillPathA), { recursive: true });
    mkdirSync(dirname(skillPathB), { recursive: true });
    writeFileSync(skillPathA, sentinelA, 'utf-8');
    writeFileSync(skillPathB, sentinelB, 'utf-8');

    const result = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);

    expect(existsSync(skillPathA)).toBe(true);
    expect(existsSync(skillPathB)).toBe(true);
    const contentA = readFileSync(skillPathA, 'utf-8');
    const contentB = readFileSync(skillPathB, 'utf-8');
    expect(contentA).not.toContain(sentinelA);
    expect(contentB).not.toContain(sentinelB);
    expectSkillRendersWithWrapperInvocation(contentA);
    expectSkillRendersWithWrapperInvocation(contentB);

    const state = harness.stateJsonFile.asJson() as CliState;
    expect(findRecordedCagDependency(state)?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
    const featureA = findRecordedCagFeature(
      state,
      ({ integrationId, feature }) =>
        integrationId === CLAUDE_INTEGRATION_ID && feature.targetRoot === projectA,
    );
    const featureB = findRecordedCagFeature(
      state,
      ({ integrationId, feature }) =>
        integrationId === CLAUDE_INTEGRATION_ID && feature.targetRoot === projectB,
    );
    expect(featureA).toBeDefined();
    expect(featureB).toBeDefined();
    if (!featureA || !featureB) {
      throw new Error('Expected both declarative Claude CAG features to remain recorded');
    }
    const resourceA = findRecordedCagSkillResource(featureA);
    const resourceB = findRecordedCagSkillResource(featureB);
    expect(resourceA).toBeDefined();
    expect(resourceB).toBeDefined();
    expect(resourceA?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
    expect(resourceB?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
    expect(resourceA?.path).toBe(skillPathA);
    expect(resourceB?.path).toBe(skillPathB);
  });

  it('is a no-op when state.config.cliVersion already matches the current CLI version', async () => {
    seedState(harness, {
      cliVersion: CURRENT_CLI_VERSION,
      skills: [{ agentId: 'claude-code', projectRoot: harness.cwd.path }],
    });

    const result = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);

    expect(existsSync(cagBinaryPath), 'no binary should be downloaded on no-op').toBe(false);
    expect(existsSync(join(harness.cwd.path, CLAUDE_SKILL_RELATIVE_PATH))).toBe(false);

    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.config.cliVersion).toBe(CURRENT_CLI_VERSION);
    expect(findRecordedCagDependency(state)).toBeUndefined();
    const feature = findRecordedCagFeature(
      state,
      ({ integrationId, feature: installedFeature }) =>
        integrationId === CLAUDE_INTEGRATION_ID && installedFeature.targetRoot === harness.cwd.path,
    );
    expect(feature).toBeDefined();
    if (!feature) {
      throw new Error('Expected the no-op declarative CAG feature to remain recorded');
    }
    const resource = findRecordedCagSkillResource(feature);
    expect(resource).toBeDefined();
    expect(resource?.version).toBe(STALE_SKILL_VERSION);
  });

  it('removes stale-version binaries left in the bin directory after a refresh', async () => {
    const binDir = join(harness.cliHome.path, 'bin');
    mkdirSync(binDir, { recursive: true });
    const oldBinaryName = `${CONTEXT_AUGMENTATION_BINARY_NAME}-0.5.0.0-${detectPlatform().os}-${detectPlatform().arch}`;
    const oldBinaryPath = join(binDir, oldBinaryName);
    writeFileSync(oldBinaryPath, 'stale binary contents', 'utf-8');

    seedState(harness, {
      skills: [{ agentId: 'claude-code', projectRoot: harness.cwd.path }],
    });

    const result = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);

    expect(existsSync(cagBinaryPath), 'new versioned binary should be present').toBe(true);
    expect(existsSync(oldBinaryPath), 'stale versioned binary should be removed').toBe(false);

    const lingeringCagBinaries = readdirSync(binDir).filter((f) =>
      f.startsWith(`${CONTEXT_AUGMENTATION_BINARY_NAME}-`),
    );
    expect(lingeringCagBinaries).toEqual([buildLocalCagBinaryName(detectPlatform())]);

    const state = harness.stateJsonFile.asJson() as CliState;
    expect(findRecordedCagDependency(state)?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
  });
});
