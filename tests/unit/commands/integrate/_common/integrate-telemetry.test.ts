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

import { describe, expect, it } from 'bun:test';

import { CommandInvocationContext } from '@/commands/command-invocation-context.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import type { InstalledIntegrationFeature } from '@/core/state/state.ts';

import {
  CLI_INTEGRATION_CONFIGURED,
  recordIntegrationConfigured,
} from '../../../../../src/commands/integrate/_common/integrate-telemetry.ts';

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

const AUTH: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
};

function record(params: Omit<Parameters<typeof recordIntegrationConfigured>[1], 'auth'>) {
  const ctx = new CommandInvocationContext();
  recordIntegrationConfigured(ctx, { auth: AUTH, ...params });
  const fact = ctx.telemetryFacts()[0];
  expect(fact.name).toBe(CLI_INTEGRATION_CONFIGURED);
  return fact.payload as Record<string, unknown>;
}

describe('recordIntegrationConfigured()', () => {
  it('assembles the full payload for a project-scope run', () => {
    const payload = record({
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

    expect(payload.features_installed).toEqual([
      'pre-commit-hook',
      'pre-commit-secrets',
      'pre-commit-dependency-risks',
    ]);
    expect(payload.features_declined).toEqual([]);
    expect(payload.features_uninstalled).toEqual([]);
    const expected = createHash('sha256').update(canonicalizePath('/some/repo')).digest('hex');
    expect(payload.repo_id).toBe(expected);
    expect(payload.repo_id as string).toHaveLength(64);
    expect(payload.is_interactive).toBe(false);
  });

  it('sets repo_id to null for global scope', () => {
    const payload = record({
      integrationId: 'claude',
      scope: 'global',
      nonInteractive: false,
      isFromRouter: true,
      installedFeatures: [makeInstalledFeature('sonar-secrets-hooks')],
      featuresDeclined: [],
      featuresUninstalled: [],
      repoRoot: null,
    });

    expect(payload.repo_id).toBeNull();
    expect(payload.is_global).toBe(true);
    expect(payload.is_from_router).toBe(true);
  });

  it('records declined and uninstalled features in separate fields', () => {
    const payload = record({
      integrationId: 'claude',
      scope: 'project',
      nonInteractive: false,
      isFromRouter: false,
      installedFeatures: [makeInstalledFeature('sonar-secrets-hooks')],
      featuresDeclined: ['sqaa-instructions'],
      featuresUninstalled: ['mcp-server'],
      repoRoot: '/some/repo',
    });

    expect(payload.features_installed).toEqual(['sonar-secrets-hooks']);
    expect(payload.features_declined).toEqual(['sqaa-instructions']);
    expect(payload.features_uninstalled).toEqual(['mcp-server']);
  });

  it('sets repo_id to null when repoRoot is null on project scope', () => {
    const payload = record({
      integrationId: 'claude',
      scope: 'project',
      nonInteractive: false,
      isFromRouter: false,
      installedFeatures: [makeInstalledFeature('sonar-secrets-hooks')],
      featuresDeclined: [],
      featuresUninstalled: [],
      repoRoot: null,
    });

    expect(payload.repo_id).toBeNull();
  });
});
