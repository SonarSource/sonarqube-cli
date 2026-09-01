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

import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type IntegrationDeclaration, renderCompletionSummary } from '@/core/framework/features';
import type { InstalledIntegrationFeature } from '@/core/state/state.ts';
import type { PhaseItem } from '@/core/ui';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';
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

function renderWithResourcePath(path: string): string[] {
  clearMockUiCalls();
  const integration: IntegrationDeclaration = {
    id: 'test',
    displayName: 'Test',
    features: [{ id: 'a', displayName: 'Feature A' }],
  };

  renderCompletionSummary(
    integration,
    [
      installedFeature('a', {
        resources: [
          {
            id: 'r1',
            resourceType: 'whole-file',
            path,
            updatedByCliVersion: 'test',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ],
    [],
    new TerminalConsole(),
  );

  const phaseCall = getMockUiCalls().find((c) => c.method === 'phase' && c.args[0] === 'Installed');
  const items = (phaseCall?.args[1] ?? []) as PhaseItem[];
  return items[0]?.subItems ?? [];
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

    renderCompletionSummary(integration, [], [], new TerminalConsole());

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

    renderCompletionSummary(
      integration,
      [
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
      ],
      [],
      new TerminalConsole(),
    );

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

  it('lists resource paths owned by subfeatures alongside the container ones', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test',
      features: [{ id: 'a', displayName: 'Feature A' }],
    };

    renderCompletionSummary(
      integration,
      [
        installedFeature('a', {
          resources: [
            {
              id: 'container-file',
              resourceType: 'whole-file',
              path: '/tmp/project/.sonar/hook.sh',
              updatedByCliVersion: 'test',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          subfeatures: [
            {
              featureId: 'sub-a',
              dependencies: [],
              resources: [
                {
                  id: 'sub-file',
                  resourceType: 'whole-file',
                  path: '/tmp/project/.sonar/sub.sh',
                  updatedByCliVersion: 'test',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
            },
            { featureId: 'sub-b', dependencies: [] },
          ],
        }),
      ],
      [],
      new TerminalConsole(),
    );

    const phaseCall = getMockUiCalls().find(
      (c) => c.method === 'phase' && c.args[0] === 'Installed',
    );
    const items = (phaseCall?.args[1] ?? []) as PhaseItem[];
    expect(items[0]?.subItems).toEqual([
      '/tmp/project/.sonar/hook.sh',
      '/tmp/project/.sonar/sub.sh',
    ]);
  });

  it('renders a Removed list for uninstalled features', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test',
      features: [
        { id: 'a', displayName: 'Feature A' },
        { id: 'b', displayName: 'Feature B' },
      ],
    };

    renderCompletionSummary(
      integration,
      [installedFeature('a')],
      [integration.features[1]],
      new TerminalConsole(),
    );

    const removedPhase = getMockUiCalls().find(
      (c) => c.method === 'phase' && c.args[0] === 'Removed',
    );
    const items = (removedPhase?.args[1] ?? []) as PhaseItem[];
    expect(items.map((item) => item.text)).toEqual(['Feature B']);
    expect(getMockUiCalls().find((c) => c.method === 'outro')?.args[0]).toBe('Setup complete!');
  });

  it('abbreviates the home directory with ~ only on a path boundary', () => {
    // Exact home dir collapses to ~
    expect(renderWithResourcePath(homedir())).toEqual(['~']);

    // Paths inside the home dir get a ~ prefix
    expect(renderWithResourcePath(join(homedir(), 'project', '.sonar', 'hook.sh'))).toEqual([
      `~${sep}project${sep}.sonar${sep}hook.sh`,
    ]);

    // A sibling sharing the home prefix is left intact
    // (home=/home/user must not rewrite /home/username/foo to ~name/foo)
    const sibling = `${homedir()}-sibling${sep}foo`;
    expect(renderWithResourcePath(sibling)).toEqual([sibling]);
  });

  it('throws when an installed feature has no matching declaration', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test',
      features: [],
    };

    expect(() =>
      renderCompletionSummary(integration, [installedFeature('orphan')], [], new TerminalConsole()),
    ).toThrow('No declaration found for installed feature test.orphan');
  });

  it('renders a feature post-install example (intro, boxed note, footer)', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test Agent',
      features: [
        {
          id: 'a',
          displayName: 'Feature A',
          postInstallExample: {
            title: 'Verify it',
            intro: 'Paste this into Test Agent:',
            lines: ['do the thing'],
            footer: 'it should work',
          },
        },
      ],
    };

    renderCompletionSummary(integration, [installedFeature('a')], [], new TerminalConsole());

    const calls = getMockUiCalls();
    expect(
      calls.some((c) => c.method === 'info' && c.args[0] === 'Paste this into Test Agent:'),
    ).toBe(true);
    const exampleNote = calls.find((c) => c.method === 'note' && c.args[1] === 'Verify it');
    expect(String(exampleNote?.args[0])).toContain('do the thing');
    expect(calls.some((c) => c.method === 'text' && c.args[0] === 'it should work')).toBe(true);
  });

  it('renders the combined example (and skips per-feature ones) when the integration provides one', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test',
      features: [
        { id: 'a', displayName: 'Feature A', postInstallExample: { lines: ['example a'] } },
        { id: 'b', displayName: 'Feature B', postInstallExample: { lines: ['example b'] } },
      ],
      combinedPostInstallExample: (ids) =>
        ids.includes('a') && ids.includes('b')
          ? { title: 'Combined', lines: ['combined example'] }
          : undefined,
    };

    renderCompletionSummary(
      integration,
      [installedFeature('a'), installedFeature('b')],
      [],
      new TerminalConsole(),
    );

    const notes = getMockUiCalls().filter((c) => c.method === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.args[1]).toBe('Combined');
    expect(String(notes[0]?.args[0])).toContain('combined example');
  });

  it('falls back to per-feature examples when the combiner returns undefined', () => {
    const integration: IntegrationDeclaration = {
      id: 'test',
      displayName: 'Test',
      features: [
        { id: 'a', displayName: 'Feature A', postInstallExample: { lines: ['example a'] } },
        { id: 'b', displayName: 'Feature B', postInstallExample: { lines: ['example b'] } },
      ],
      combinedPostInstallExample: () => undefined,
    };

    renderCompletionSummary(
      integration,
      [installedFeature('a'), installedFeature('b')],
      [],
      new TerminalConsole(),
    );

    const noteBodies = getMockUiCalls()
      .filter((c) => c.method === 'note')
      .map((c) => String(c.args[0]));
    expect(noteBodies).toEqual(['example a', 'example b']);
  });
});
