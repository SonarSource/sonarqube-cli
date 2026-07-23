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

import type { ResolvedAuth } from '@/core/server/auth-resolver.ts';
import { emitIntegrationConfiguredTelemetry } from '@/core/telemetry/integrate-telemetry.ts';
import * as telemetryEvents from '@/core/telemetry/telemetry-events.ts';
import { canonicalizePath } from '@/lib/fs-utils.ts';
import type { InstalledIntegrationFeature } from '@/lib/state.ts';

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
  emitSpy = spyOn(telemetryEvents, 'emitIntegrationConfigured').mockResolvedValue(undefined);
});

afterEach(() => {
  emitSpy.mockRestore();
});

describe('emitIntegrationConfiguredTelemetry()', () => {
  it('assembles the full payload for a project-scope run', async () => {
    await emitIntegrationConfiguredTelemetry({
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
      featuresDeclined: [],
      featuresUninstalled: [],
      repoRoot: '/some/repo',
    });

    const [, fields] = emitSpy.mock.calls[0] as [ResolvedAuth, Record<string, unknown>];
    // features_installed flattens active subfeature ids.
    expect(fields.features_installed).toEqual([
      'pre-commit-hook',
      'pre-commit-secrets',
      'pre-commit-dependency-risks',
    ]);
    expect(fields.features_declined).toEqual([]);
    expect(fields.features_uninstalled).toEqual([]);
    // repo_id is the SHA-256 hex of the canonical repo root.
    const expected = createHash('sha256').update(canonicalizePath('/some/repo')).digest('hex');
    expect(fields.repo_id).toBe(expected);
    expect(fields.repo_id as string).toHaveLength(64);
    expect(fields.is_interactive).toBe(false);
  });

  it('sets repo_id to null for global scope', async () => {
    await emitIntegrationConfiguredTelemetry({
      auth: AUTH,
      integrationId: 'claude',
      scope: 'global',
      nonInteractive: false,
      isFromRouter: true,
      installedFeatures: [makeInstalledFeature('sonar-secrets-hooks')],
      featuresDeclined: [],
      featuresUninstalled: [],
      repoRoot: null,
    });

    const [, fields] = emitSpy.mock.calls[0] as [ResolvedAuth, Record<string, unknown>];
    expect(fields.repo_id).toBeNull();
    expect(fields.is_global).toBe(true);
    expect(fields.is_from_router).toBe(true);
  });

  it('records declined and uninstalled features in separate fields', async () => {
    // Interactive run: install one feature, decline another offered via `ask`,
    // and remove a previously-installed one.
    await emitIntegrationConfiguredTelemetry({
      auth: AUTH,
      integrationId: 'claude',
      scope: 'project',
      nonInteractive: false,
      isFromRouter: false,
      installedFeatures: [makeInstalledFeature('sonar-secrets-hooks')],
      featuresDeclined: ['sqaa-instructions'],
      featuresUninstalled: ['mcp-server'],
      repoRoot: '/some/repo',
    });

    const [, fields] = emitSpy.mock.calls[0] as [ResolvedAuth, Record<string, unknown>];
    expect(fields.features_installed).toEqual(['sonar-secrets-hooks']);
    expect(fields.features_declined).toEqual(['sqaa-instructions']);
    expect(fields.features_uninstalled).toEqual(['mcp-server']);
  });

  it('sets repo_id to null when repoRoot is null on project scope', async () => {
    await emitIntegrationConfiguredTelemetry({
      auth: AUTH,
      integrationId: 'claude',
      scope: 'project',
      nonInteractive: false,
      isFromRouter: false,
      installedFeatures: [makeInstalledFeature('sonar-secrets-hooks')],
      featuresDeclined: [],
      featuresUninstalled: [],
      repoRoot: null,
    });

    const [, fields] = emitSpy.mock.calls[0] as [ResolvedAuth, Record<string, unknown>];
    expect(fields.repo_id).toBeNull();
  });
});
