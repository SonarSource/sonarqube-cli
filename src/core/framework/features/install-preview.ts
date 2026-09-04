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

// Framework-rendered "What will be installed" preview shared by every
// `sonar integrate` command.

import { bold, dim, wrapText } from '@/core/ui';
import type { Console } from '@/core/ui/console.ts';

import type { FeatureApplication, FeatureDeclaration } from './types.ts';
import { isFeatureContainer } from './types.ts';

const PREVIEW_BOX_TITLE = 'What will be installed';
const INSTALL_PROMPT = 'Press Enter to install…';
const DESCRIPTION_INDENT = '  ';
const DESCRIPTION_WRAP_WIDTH = 72;

export function buildInstallPreviewLines<TOptions>(
  toInstall: FeatureApplication<TOptions>[],
): string[] {
  const blocks = toInstall.map(({ feature }) => {
    const block = [bold(feature.displayName)];
    const description = resolvePreviewDescription(feature);
    if (description) {
      for (const line of wrapText(description, DESCRIPTION_WRAP_WIDTH)) {
        block.push(dim(`${DESCRIPTION_INDENT}${line}`));
      }
    }
    return block;
  });
  // Separate feature blocks with a blank line.
  return blocks.flatMap((block, index) => (index === 0 ? block : ['', ...block]));
}

function resolvePreviewDescription<TOptions>(
  feature: FeatureDeclaration<TOptions>,
): string | undefined {
  const { previewDescription } = feature;
  if (typeof previewDescription !== 'function') {
    return previewDescription;
  }
  const activeSubfeatureIds = isFeatureContainer(feature)
    ? feature.subfeatures.map((subfeature) => subfeature.id)
    : [];
  return previewDescription(activeSubfeatureIds);
}

/**
 * Render the install preview box, then — unless non-interactive — wait for the
 * user to press Enter before installation proceeds.
 */
export async function renderInstallPreviewAndConfirm<TOptions>(
  toInstall: FeatureApplication<TOptions>[],
  nonInteractive: boolean | undefined,
  console: Console,
): Promise<void> {
  if (toInstall.length === 0) {
    return;
  }
  console.note(buildInstallPreviewLines(toInstall), PREVIEW_BOX_TITLE);
  if (!nonInteractive) {
    await console.pressEnterKeyPrompt(INSTALL_PROMPT);
  }
}
