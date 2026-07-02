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

import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { ResolvedAuth } from '../../../src/lib/auth-resolver.js';
import { canonicalizePath } from '../../../src/lib/fs-utils.js';
import type { InstalledIntegrationFeature } from '../../../src/lib/state.js';
import * as findings from '../../../src/telemetry/findings.js';
import { emitIntegrationConfiguredTelemetry } from '../../../src/telemetry/integrate-telemetry.js';

const AUTH: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
};

function makeInstalledFeature(
  featureId: string,
  subfeatureIds: string[] = [],
): InstalledIntegrationFeature {
  return {
    featureId,
    scope: 'project',
    targetRoot: '/repo',
    installedByCliVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedByCliVersion: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dependencies: [],
    resources: [],
    operations: [],
    subfeatures: subfeatureIds.map((id) => ({ featureId: id, dependencies: [] })),
  };
}

let emitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  emitSpy = spyOn(findings, 'emitIntegrationConfigured').mockImplementation(() => {});
});

afterEach(() => {
  emitSpy.mockRestore();
});

describe('emitIntegrationConfiguredTelemetry()', () => {
  it('assembles the full payload for a project-scope run', () => {
    emitIntegrationConfiguredTelemetry({
      auth: AUTH,
      integrationId: 'git',
      scope: 'project',
      nonInteractive: true,
      isFromRouter: false,
      installedFeatures: [
        makeInstalledFeature('pre-commit-hook', [
          'pre-commit-secrets',
          'pre-commit-dependency-risks',
        ]),
      ],
      featuresSkipped: ['sqaa-hooks'],
      repoRoot: '/some/repo',
    });

    const [, fields] = emitSpy.mock.calls[0] as [ResolvedAuth, Record<string, unknown>];
    // features_installed flattens active subfeature ids.
    expect(fields.features_installed).toEqual([
      'pre-commit-hook',
      'pre-commit-secrets',
      'pre-commit-dependency-risks',
    ]);
    expect(fields.features_skipped).toEqual(['sqaa-hooks']);
    // repo_id is the SHA-256 hex of the canonical repo root.
    const expected = createHash('sha256').update(canonicalizePath('/some/repo')).digest('hex');
    expect(fields.repo_id).toBe(expected);
    expect(fields.repo_id as string).toHaveLength(64);
    expect(fields.is_interactive).toBe(false);
  });

  it('sets repo_id to null for global scope', () => {
    emitIntegrationConfiguredTelemetry({
      auth: AUTH,
      integrationId: 'claude',
      scope: 'global',
      nonInteractive: false,
      isFromRouter: true,
      installedFeatures: [makeInstalledFeature('sonar-secrets-hooks')],
      featuresSkipped: [],
      repoRoot: null,
    });

    const [, fields] = emitSpy.mock.calls[0] as [ResolvedAuth, Record<string, unknown>];
    expect(fields.repo_id).toBeNull();
    expect(fields.is_global).toBe(true);
    expect(fields.is_from_router).toBe(true);
  });

  it('sets repo_id to null when repoRoot is null on project scope', () => {
    emitIntegrationConfiguredTelemetry({
      auth: AUTH,
      integrationId: 'claude',
      scope: 'project',
      nonInteractive: false,
      isFromRouter: false,
      installedFeatures: [makeInstalledFeature('sonar-secrets-hooks')],
      featuresSkipped: [],
      repoRoot: null,
    });

    const [, fields] = emitSpy.mock.calls[0] as [ResolvedAuth, Record<string, unknown>];
    expect(fields.repo_id).toBeNull();
  });
});
