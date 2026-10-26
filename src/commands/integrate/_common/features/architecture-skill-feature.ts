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

import { join } from 'node:path';

import {
  ARCHITECTURE_SKILL,
  ARCHITECTURE_SKILL_MARKER,
} from '@/commands/architecture/skill-content.ts';
import type { FeatureDeclaration, IntegrationContext } from '@/core/framework/features';
import { textSnippet, wholeFile } from '@/core/framework/features';
import { readTextFile } from '@/core/framework/resources/common.ts';

import { sonarBeginMarker, sonarEndMarker } from '../instructions-templates.ts';
import type { IntegrateAgentOptions } from '../types.ts';

export const ARCHITECTURE_SKILL_FEATURE_ID = 'architecture-skill';
export const ARCHITECTURE_SKILL_FILE = join('sonar-architecture', 'SKILL.md');

interface ArchitectureSkillOptions {
  targetRoot?: () => string;
  targetPath: (context: IntegrationContext) => string;
  instructionsTargetPath?: (context: IntegrationContext) => string;
}

export function createArchitectureSkillFeature<TOptions extends IntegrateAgentOptions>(
  options: ArchitectureSkillOptions,
): FeatureDeclaration<TOptions> {
  return {
    id: ARCHITECTURE_SKILL_FEATURE_ID,
    targetRoot: options.targetRoot,
    displayName: 'architecture skill',
    previewDescription:
      'Reads architecture data and applies intended-model changes you explicitly request.',
    resources: [
      wholeFile({
        id: 'architecture-skill-file',
        displayName: 'architecture skill',
        targetPath: options.targetPath,
        content: ARCHITECTURE_SKILL,
        requiresForce: true,
        managedMarker: ARCHITECTURE_SKILL_MARKER,
        overwriteRemediationHint: 'Move your existing skill before running sonar integrate again.',
      }),
      ...(options.instructionsTargetPath
        ? [
            textSnippet({
              id: 'architecture-skill-instructions',
              displayName: 'architecture skill instructions',
              targetPath: options.instructionsTargetPath,
              startMarker: sonarBeginMarker(ARCHITECTURE_SKILL_FEATURE_ID),
              endMarker: sonarEndMarker(ARCHITECTURE_SKILL_FEATURE_ID),
              content: (context) =>
                `For requested SonarQube architecture reads or intended-model edits, first read the architecture skill at ${JSON.stringify(options.targetPath(context))}. Follow its confirmation and complete-model replacement guidance.`,
            }),
          ]
        : []),
    ],
    operations: [
      {
        id: 'refresh-legacy-architecture-skills',
        shouldApply: (context) => context.scope === 'global',
        apply: refreshLegacySkills,
      },
    ],
  };
}

async function refreshLegacySkills(context: IntegrationContext): Promise<void> {
  // Refresh existing Alpha copies without claiming ownership or deleting another agent's skill.
  for (const directory of ['.claude', '.agents']) {
    const path = join(context.targetRoot, directory, 'skills', ARCHITECTURE_SKILL_FILE);
    try {
      const existing = await readTextFile(path);
      if (existing?.includes(ARCHITECTURE_SKILL_MARKER)) {
        await wholeFile({
          id: 'legacy-architecture-skill',
          targetPath: path,
          content: ARCHITECTURE_SKILL,
          requiresForce: true,
          managedMarker: ARCHITECTURE_SKILL_MARKER,
        }).apply(context);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      context.console.warn(`Could not refresh a previous architecture skill at ${path}: ${reason}`);
    }
  }
}
