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

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Force color functions to identity so preview-line assertions are independent
// of whether the test process is attached to a TTY.
void mock.module('../../../../../../../src/ui/colors.js', () => ({
  isTTY: false,
  bold: (s: string) => s,
  dim: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
  cyan: (s: string) => s,
  gray: (s: string) => s,
  white: (s: string) => s,
  stripAnsi: (s: string) => s,
  visibleLength: (s: string) => s.length,
}));

import {
  buildInstallPreviewLines,
  renderInstallPreviewAndConfirm,
} from '../../../../../../src/commands/integrate/_common/registry/install-preview.ts';
import type {
  FeatureApplication,
  FeatureContainer,
  FeatureDeclaration,
} from '../../../../../../src/commands/integrate/_common/registry/types.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/core/ui';

function application(feature: FeatureDeclaration): FeatureApplication {
  return { feature, targetRoot: '/repo', scope: 'project' };
}

describe('install preview', () => {
  describe('buildInstallPreviewLines', () => {
    it('renders name lines with indented descriptions, separates features with a blank line, and omits missing descriptions', () => {
      const lines = buildInstallPreviewLines([
        application({ id: 'a', displayName: 'Feature A' }),
        application({
          id: 'mcp-server',
          displayName: 'MCP server',
          previewDescription: 'Gives the agent direct access to your SonarQube project.',
        }),
      ]);

      expect(lines).toEqual([
        'Feature A',
        '',
        'MCP server',
        '  Gives the agent direct access to your SonarQube project.',
      ]);
    });

    it('resolves a handler previewDescription from the active subfeature ids', () => {
      const container: FeatureContainer = {
        id: 'pre-commit-hook',
        displayName: 'pre-commit code scanning hook',
        previewDescription: (activeSubfeatureIds) =>
          activeSubfeatureIds.includes('pre-commit-dependency-risks')
            ? 'Scans files for secrets and checks dependencies before each commit.'
            : 'Scans files for secrets before each commit.',
        subfeatures: [
          { id: 'pre-commit-secrets', displayName: 'pre-commit secrets scan' },
          { id: 'pre-commit-dependency-risks', displayName: 'pre-commit dependency-risks scan' },
        ],
        defaultInstallSubfeatureIds: ['pre-commit-secrets'],
      };

      const withDeps = buildInstallPreviewLines([application(container)]);
      expect(withDeps).toEqual([
        'pre-commit code scanning hook',
        '  Scans files for secrets and checks dependencies before each commit.',
      ]);

      // Secrets-only: the handler omits the dependency clause.
      const secretsOnlyContainer: FeatureContainer = {
        ...container,
        subfeatures: [container.subfeatures[0]],
      };
      const secretsOnly = buildInstallPreviewLines([application(secretsOnlyContainer)]);
      expect(secretsOnly).toEqual([
        'pre-commit code scanning hook',
        '  Scans files for secrets before each commit.',
      ]);
    });

    it('wraps long descriptions across indented continuation lines', () => {
      const long =
        'Scans files and prompts for hardcoded secrets before the agent can read or act on them, ' +
        'blocking the dangerous operation entirely.';
      const lines = buildInstallPreviewLines([
        application({ id: 'x', displayName: 'X', previewDescription: long }),
      ]);

      expect(lines[0]).toBe('X');
      const descriptionLines = lines.slice(1);
      expect(descriptionLines.length).toBeGreaterThan(1); // wrapped across rows
      expect(descriptionLines.every((line) => line.startsWith('  '))).toBe(true);
      expect(descriptionLines.every((line) => line.length <= 76)).toBe(true);
      // No content is dropped — the wrapped lines reconstruct the original text.
      expect(descriptionLines.map((line) => line.trim()).join(' ')).toBe(long);
    });
  });

  describe('renderInstallPreviewAndConfirm', () => {
    beforeEach(() => {
      setMockUi(true);
      clearMockUiCalls();
    });

    afterEach(() => {
      setMockUi(false);
    });

    it('prints the box and waits for Enter in interactive mode', async () => {
      await renderInstallPreviewAndConfirm(
        [application({ id: 'a', displayName: 'Feature A', previewDescription: 'Does A.' })],
        false,
      );

      const methods = getMockUiCalls().map((call) => call.method);
      expect(methods).toContain('note');
      expect(methods).toContain('pressAnyKeyPrompt');
    });

    it('prints the box but does not wait in non-interactive mode', async () => {
      await renderInstallPreviewAndConfirm(
        [application({ id: 'a', displayName: 'Feature A', previewDescription: 'Does A.' })],
        true,
      );

      const methods = getMockUiCalls().map((call) => call.method);
      expect(methods).toContain('note');
      expect(methods).not.toContain('pressAnyKeyPrompt');
    });

    it('renders nothing when there is nothing to install', async () => {
      await renderInstallPreviewAndConfirm([], false);
      expect(getMockUiCalls()).toHaveLength(0);
    });
  });
});
