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

import {
  type IntegrationDeclaration,
  renderCompletionSummary,
} from '../../../../../../src/cli/commands/integrate/_common/registry';
import type { InstalledIntegrationFeature } from '../../../../../../src/lib/state';
import type { PhaseItem } from '../../../../../../src/ui';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/ui';

function installedFeature(
  featureId: string,
  overrides: Partial<InstalledIntegrationFeature> = {},
): InstalledIntegrationFeature {
  return {
    featureId,
    scope: 'project',
    targetRoot: '/tmp/project',
    installedByCliVersion: 'test',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedByCliVersion: 'test',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dependencies: [],
    resources: [],
    operations: [],
    ...overrides,
  };
}

describe('renderCompletionSummary', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('renders nothing when no features were installed', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test',
      features: [{ id: 'a', displayName: 'Feature A' }],
    };

    renderCompletionSummary(integration, []);

    expect(getMockUiCalls()).toHaveLength(0);
  });

  it('renders the Installed list (display names + resource path sub-lists) and the outro', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test',
      features: [
        { id: 'a', displayName: 'Feature A' },
        { id: 'b', displayName: 'Feature B' },
      ],
    };

    renderCompletionSummary(integration, [
      installedFeature('a', {
        resources: [
          {
            id: 'r1',
            resourceType: 'whole-file',
            path: '/tmp/project/.sonar/hook.sh',
            updatedByCliVersion: 'test',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      installedFeature('b'),
    ]);

    const phaseCall = getMockUiCalls().find(
      (c) => c.method === 'phase' && c.args[0] === 'Installed',
    );
    const items = (phaseCall?.args[1] ?? []) as PhaseItem[];
    expect(items.map((item) => item.text)).toEqual(['Feature A', 'Feature B']);
    expect(items[0]?.subItems).toEqual(['/tmp/project/.sonar/hook.sh']);
    expect(items[1]?.subItems).toEqual([]);

    const outroCall = getMockUiCalls().find((c) => c.method === 'outro');
    expect(outroCall?.args[0]).toBe('Setup complete!');
    expect(outroCall?.args[1]).toBe('success');
  });

  it('throws when an installed feature has no matching declaration', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test',
      features: [],
    };

    expect(() => renderCompletionSummary(integration, [installedFeature('orphan')])).toThrow(
      'No declaration found for installed feature test.orphan',
    );
  });

  it('renders a feature verification example (intro, boxed note, footer)', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test Agent',
      features: [
        {
          id: 'a',
          displayName: 'Feature A',
          verificationExample: {
            title: 'Verify it',
            intro: 'Paste this into Test Agent:',
            lines: ['do the thing'],
            footer: 'it should work',
          },
        },
      ],
    };

    renderCompletionSummary(integration, [installedFeature('a')]);

    const calls = getMockUiCalls();
    expect(
      calls.some((c) => c.method === 'info' && c.args[0] === 'Paste this into Test Agent:'),
    ).toBe(true);
    const exampleNote = calls.find((c) => c.method === 'note' && c.args[1] === 'Verify it');
    expect(String(exampleNote?.args[0])).toContain('do the thing');
    expect(calls.some((c) => c.method === 'text' && c.args[0] === 'it should work')).toBe(true);
  });
});
