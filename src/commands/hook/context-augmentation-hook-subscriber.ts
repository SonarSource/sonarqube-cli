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

// CAG owns a richer response shape than additionalContext, so it's forwarded untouched.

import logger from '@/core/observability/logger.ts';
import type { Console } from '@/core/ui/console.ts';

import { runContextPassthrough } from '../context/index.ts';
import type { ClaudePostToolUseSubscriber } from './claude-hook-dispatch.ts';

export const CONTEXT_AUGMENTATION_TOOL_MATCHER = 'Bash|PowerShell|Monitor|Read';

const CONTEXT_AUGMENTATION_TOOL_NAMES = new Set(CONTEXT_AUGMENTATION_TOOL_MATCHER.split('|'));

export function matchesContextAugmentationTool(toolName: string): boolean {
  return CONTEXT_AUGMENTATION_TOOL_NAMES.has(toolName);
}

export function createContextAugmentationPostToolUseSubscriber(
  console: Console,
): ClaudePostToolUseSubscriber {
  return {
    id: 'context-augmentation',
    matches: matchesContextAugmentationTool,
    handle: async (_payload, rawStdin) => {
      try {
        await runContextPassthrough('__hook', ['Claude'], { stdinPayload: rawStdin, console });
        return { decision: 'handled' };
      } catch (err) {
        logger.debug(`CAG PostToolUse forward failed: ${(err as Error).message}`);
        return { decision: 'none' };
      }
    },
  };
}
