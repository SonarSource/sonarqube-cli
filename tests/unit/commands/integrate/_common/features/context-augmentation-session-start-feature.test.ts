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

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { contextAugmentationBinaryDependency } from '@/commands/integrate/_common/context-augmentation-dependency.ts';
import { createContextAugmentationSessionStartFeature } from '@/commands/integrate/_common/features/context-augmentation-session-start-feature.ts';
import type { IntegrationContext } from '@/core/framework/features';
import { install } from '@/core/framework/features';

const IS_WINDOWS = process.platform === 'win32';

function buildFeature() {
  return createContextAugmentationSessionStartFeature({
    configDir: '.claude',
    settingsPath: (context: IntegrationContext) =>
      join(context.targetRoot, '.claude', 'settings.json'),
    sessionStartScriptPath: 'sonar-context-session-start/build-scripts/session-start',
    subagentStartScriptPath: 'sonar-context-session-start/build-scripts/subagent-start',
    sessionStartCommand: 'sonar hook claude-session-start',
    subagentStartCommand: 'sonar hook claude-subagent-start',
    shouldInstall: () => install(),
  });
}

describe('createContextAugmentationSessionStartFeature — declared metadata', () => {
  it('forces scope to global and targetRoot to the user home, regardless of the invocation', async () => {
    const feature = buildFeature();
    expect(feature.scope).toBe('global');

    const targetRootFn = feature.targetRoot as (invocation: unknown) => Promise<string> | string;
    const resolved = await targetRootFn({ targetRoot: '/some/project', scope: 'project' });
    expect(resolved).toBe(homedir());
  });

  it('declares the shared CAG binary dependency', () => {
    const feature = buildFeature();
    expect(feature.dependencies).toContain(contextAugmentationBinaryDependency);
  });

  it('declares three resources: two scripts and one settings patch', () => {
    const feature = buildFeature();
    expect(feature.resources?.map((r) => r.id)).toEqual([
      'context-augmentation-session-start-script',
      'context-augmentation-subagent-start-script',
      'context-augmentation-session-start-hook-config',
    ]);
  });
});

describe('createContextAugmentationSessionStartFeature — applying resources to disk', () => {
  let workDir: string;
  let context: IntegrationContext;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sonar-session-start-feature-test-'));
    context = {
      targetRoot: workDir,
      scope: 'global',
      attrs: {},
      state: {} as never,
      executionMode: 'install',
      resolvedDependencies: new Map(),
    } as unknown as IntegrationContext;
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes executable session-start and subagent-start scripts calling the right sonar hook commands', async () => {
    const feature = buildFeature();
    const [sessionStartScript, subagentStartScript] = feature.resources!;

    await sessionStartScript.apply(context);
    await subagentStartScript.apply(context);

    const ext = IS_WINDOWS ? '.ps1' : '.sh';
    const sessionStartPath = join(
      workDir,
      '.claude',
      'hooks',
      `sonar-context-session-start/build-scripts/session-start${ext}`,
    );
    const subagentStartPath = join(
      workDir,
      '.claude',
      'hooks',
      `sonar-context-session-start/build-scripts/subagent-start${ext}`,
    );

    expect(readFileSync(sessionStartPath, 'utf-8')).toContain('sonar hook claude-session-start');
    expect(readFileSync(subagentStartPath, 'utf-8')).toContain('sonar hook claude-subagent-start');

    if (!IS_WINDOWS) {
      expect(statSync(sessionStartPath).mode & 0o111).not.toBe(0);
      expect(statSync(subagentStartPath).mode & 0o111).not.toBe(0);
    }
  });

  it('registers SessionStart (startup|clear) and SubagentStart (*) entries in settings.json', async () => {
    const feature = buildFeature();
    const settingsResource = feature.resources![2];

    await settingsResource.apply(context);

    const settings = JSON.parse(readFileSync(join(workDir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].matcher).toBe('startup|clear');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('session-start');

    expect(settings.hooks.SubagentStart).toHaveLength(1);
    expect(settings.hooks.SubagentStart[0].matcher).toBe('*');
    expect(settings.hooks.SubagentStart[0].hooks[0].command).toContain('subagent-start');
  });

  it('removing the settings resource drops only its own entries, preserving unrelated hooks', async () => {
    const feature = buildFeature();
    const settingsResource = feature.resources![2];
    const settingsPath = join(workDir, '.claude', 'settings.json');

    await settingsResource.apply(context);
    const beforeRemoval = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    beforeRemoval.hooks.PreToolUse = [
      { matcher: 'Read', hooks: [{ type: 'command', command: 'sonar hook claude-pre-tool-use' }] },
    ];
    writeFileSync(settingsPath, JSON.stringify(beforeRemoval, null, 2));

    await settingsResource.remove(context);

    const afterRemoval = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(afterRemoval.hooks.SessionStart).toBeUndefined();
    expect(afterRemoval.hooks.SubagentStart).toBeUndefined();
    expect(afterRemoval.hooks.PreToolUse).toHaveLength(1);
  });
});
