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

import { PI_EXTENSION_HELPERS } from './extension-helpers.ts';
import { PI_EXTENSION_MANAGED_MARKER } from './secrets-extension-content.ts';

export const PI_SQAA_EXTENSION_CONTENT = String.raw`// ${PI_EXTENSION_MANAGED_MARKER} — do not edit by hand.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
${PI_EXTENSION_HELPERS}
const ANALYZED_TOOLS = new Set(['edit', 'write']);
const REPORT_INSTRUCTION = 'You must report this to the user and say it comes from the Sonar Vortex analysis.';

interface PostToolUseAnswer {
  context?: string;
}

let editedFilesThisTurn: string[] = [];

function systemReminder(text: string): { type: 'text'; text: string } {
  return { type: 'text', text: '<system-reminder>\n' + text + '\n</system-reminder>' };
}

function deepAnalysisReminder(files: string[]): string {
  const fileArguments = files.map((file) => '--file "' + file + '"').join(' ');
  return 'Before ending your turn, run \`sonar analyze agentic --depth DEEP ' + fileArguments + '\` and summarize the result for the user.';
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_result', async (event, ctx) => {
    if (!ANALYZED_TOOLS.has(event.toolName) || event.isError) return;
    const path = (event.input as { path?: string }).path;
    if (!path) return;
    try {
      const filePath = resolveToCwd(path, ctx.cwd);
      editedFilesThisTurn.push(filePath);
      const { context } = await runHook<PostToolUseAnswer>('pi-post-tool-use', {
        tool: event.toolName,
        filePath,
        sessionID: ctx.sessionManager.getSessionId(),
      });
      if (typeof context === 'string' && context) {
        return { content: [...event.content, systemReminder(context + '\n' + REPORT_INSTRUCTION)] };
      }
    } catch {
      return;
    }
  });

  pi.on('turn_end', () => {
    if (editedFilesThisTurn.length === 0) return;
    const files = [...new Set(editedFilesThisTurn)];
    editedFilesThisTurn = [];
    return {
      entries: [
        {
          type: 'custom_message',
          customType: 'sonar-deep-reminder',
          content: [systemReminder(deepAnalysisReminder(files))],
          display: false,
        },
      ],
      continue: true,
    };
  });
}
`;
