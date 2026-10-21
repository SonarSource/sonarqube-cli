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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import { persistIntegrationChanges } from '@/core/framework/features/integration-state-updates.ts';
import type { InstalledIntegration } from '@/core/state/state.ts';
import { loadState } from '@/core/state/state-repository.ts';

const testHome = mkdtempSync(join(tmpdir(), 'integration-state-updates-'));
process.env.SONAR_USER_HOME = testHome;

afterEach(() => {
  rmSync(join(testHome, 'sonarqube-cli'), { recursive: true, force: true });
});
afterAll(() => {
  delete process.env.SONAR_USER_HOME;
  rmSync(testHome, { recursive: true, force: true });
});

function integration(id: string, targetRoot: string): InstalledIntegration {
  return {
    id,
    integrationId: 'git',
    installedByCliVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedByCliVersion: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    features: [
      {
        featureId: 'hooks',
        scope: 'project',
        targetRoot,
        installedByCliVersion: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '1.0.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        dependencies: [],
        resources: [],
        operations: [],
      },
    ],
  };
}

describe('persistIntegrationChanges', () => {
  it('upserts concurrent creations by integration and target root', () => {
    const before = loadState();
    const first = structuredClone(before);
    const second = structuredClone(before);
    first.integrations.installed.push(integration('first-random-id', '/project'));
    second.integrations.installed.push(integration('second-random-id', '/project'));

    persistIntegrationChanges(before, first);
    persistIntegrationChanges(before, second);

    const installed = loadState().integrations.installed;
    expect(installed).toHaveLength(1);
    expect(installed[0].id).toBe('first-random-id');
    expect(installed[0].features).toHaveLength(1);
  });

  it('preserves features installed in different target roots', () => {
    const before = loadState();
    const first = structuredClone(before);
    const second = structuredClone(before);
    first.integrations.installed.push(integration('first-random-id', '/first'));
    second.integrations.installed.push(integration('second-random-id', '/second'));

    persistIntegrationChanges(before, first);
    persistIntegrationChanges(before, second);

    const installed = loadState().integrations.installed;
    expect(installed).toHaveLength(1);
    expect(installed[0].features.map((feature) => feature.targetRoot)).toEqual([
      '/first',
      '/second',
    ]);
  });

  it('removes one recorded feature while preserving a concurrent install', () => {
    const empty = loadState();
    const original = structuredClone(empty);
    original.integrations.installed.push(integration('original', '/first'));
    persistIntegrationChanges(empty, original);

    const beforeRemoval = loadState();
    const afterRemoval = structuredClone(beforeRemoval);
    afterRemoval.integrations.installed[0].features = [];
    const concurrent = structuredClone(beforeRemoval);
    concurrent.integrations.installed[0].features.push(integration('other', '/second').features[0]);

    persistIntegrationChanges(beforeRemoval, concurrent);
    persistIntegrationChanges(beforeRemoval, afterRemoval);

    const installed = loadState().integrations.installed;
    expect(installed).toHaveLength(1);
    expect(installed[0].features.map((feature) => feature.targetRoot)).toEqual(['/second']);
  });

  it('removes the integration when its final feature is removed', () => {
    const empty = loadState();
    const original = structuredClone(empty);
    original.integrations.installed.push(integration('original', '/project'));
    persistIntegrationChanges(empty, original);

    const beforeRemoval = loadState();
    const afterRemoval = structuredClone(beforeRemoval);
    afterRemoval.integrations.installed = [];
    persistIntegrationChanges(beforeRemoval, afterRemoval);

    expect(loadState().integrations.installed).toEqual([]);
  });

  it('updates a recorded feature without replacing another target', () => {
    const empty = loadState();
    const original = structuredClone(empty);
    original.integrations.installed.push(integration('original', '/first'));
    persistIntegrationChanges(empty, original);

    const beforeUpdate = loadState();
    const afterUpdate = structuredClone(beforeUpdate);
    afterUpdate.integrations.installed[0].features[0].updatedAt = '2026-02-01T00:00:00.000Z';
    const concurrent = structuredClone(beforeUpdate);
    concurrent.integrations.installed[0].features.push(integration('other', '/second').features[0]);

    persistIntegrationChanges(beforeUpdate, concurrent);
    persistIntegrationChanges(beforeUpdate, afterUpdate);

    const installed = loadState().integrations.installed[0];
    expect(installed.features).toHaveLength(2);
    expect(installed.features[0].updatedAt).toBe('2026-02-01T00:00:00.000Z');
  });
});
