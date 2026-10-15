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
import { existsSync } from 'node:fs';
import { relative } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
${PI_EXTENSION_HELPERS}
const SQAA_HOOK_TIMEOUT_MS = 20000;
const ANALYZED_TOOLS = new Set(['edit', 'write']);
const REPORT_INSTRUCTION = 'You must report this to the user and say it comes from the Sonar Vortex analysis.';

interface PostToolUseAnswer {
  context?: string;
}

let analyzedFiles: string[] = [];
let deepAnalysisRequested = false;

function systemReminder(text: string): { type: 'text'; text: string } {
  return { type: 'text', text: '<system-reminder>\n' + text + '\n</system-reminder>' };
}

function quoteForShell(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function filesToAnalyzeDeeply(cwd: string): string[] {
  return [...new Set(analyzedFiles)].filter((file) => existsSync(file)).map((file) => relative(cwd, file));
}

function deepAnalysisReminder(files: string[]): string {
  const fileArguments = files.map((file) => '--file ' + quoteForShell(file)).join(' ');
  return 'Before ending your turn, run \`sonar analyze agentic --depth DEEP ' + fileArguments + '\` and summarize the result for the user.';
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_result', async (event, ctx) => {
    if (!ANALYZED_TOOLS.has(event.toolName) || event.isError) return;
    const path = (event.input as { path?: string }).path;
    if (!path) return;
    try {
      const filePath = resolveToCwd(path, ctx.cwd);
      const { context } = await runHook<PostToolUseAnswer>(
        'pi-post-tool-use',
        { tool: event.toolName, filePath, sessionID: ctx.sessionManager.getSessionId() },
        SQAA_HOOK_TIMEOUT_MS,
        ctx.cwd,
      );
      if (typeof context !== 'string' || !context) return;
      analyzedFiles.push(filePath);
      return { content: [...event.content, systemReminder(context + '\n' + REPORT_INSTRUCTION)] };
    } catch {
      return;
    }
  });

  pi.on('before_agent_start', () => {
    analyzedFiles = [];
    deepAnalysisRequested = false;
  });

  pi.on('agent_before_settle', (event, ctx) => {
    const files = filesToAnalyzeDeeply(ctx.cwd);
    analyzedFiles = [];
    if (deepAnalysisRequested || files.length === 0 || (event.outcome && event.outcome !== 'completed')) return;
    deepAnalysisRequested = true;
    return {
      entries: [
        ...(event.entries ?? []),
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
