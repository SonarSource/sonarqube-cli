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

import { OPENCODE_PLUGIN_HELPERS_CONTENT } from './plugin-helpers-content.ts';
import { OPENCODE_PLUGIN_MANAGED_HEADER } from './secrets-plugin-content.ts';

export const OPENCODE_SQAA_PLUGIN_CONTENT = String.raw`${OPENCODE_PLUGIN_MANAGED_HEADER}
${OPENCODE_PLUGIN_HELPERS_CONTENT}
const HOOK_TIMEOUT_MS = 20000;
const COMPLETION_TIMEOUT_MS = 60000;
const ANALYZED_TOOLS = new Set(['edit', 'write']);

function toContentChunks(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content) return [{ type: 'text', text: content }];
  return [];
}

export default {
  id: 'sonar-sqaa',
  async setup(ctx: any) {
    const directory: string = ctx.location.directory;

    await ctx.tool.hook('execute.after', async (event: any) => {
      try {
        if (event.status !== 'completed' || !ANALYZED_TOOLS.has(event.tool)) return;
        const path = event.input?.path;
        if (typeof path !== 'string' || !path) return;

        const response = await runHook(
          'opencode-post-tool-use',
          { tool: event.tool, filePath: toFullPath(path, directory), sessionID: event.sessionID },
          HOOK_TIMEOUT_MS,
          directory,
        );
        if (!response.context) return;

        const reminder = {
          type: 'text',
          text:
            '<system-reminder>\n' +
            response.context +
            '\nYou must report this to the user and say it comes from the Sonar Vortex analysis.\n</system-reminder>',
        };
        event.result = { ...event.result, content: [...toContentChunks(event.result?.content), reminder] };
      } catch {
        return;
      }
    });

    const controller = new AbortController();
    const handledEvents = new Set<string>();
    async function observeCompletions() {
      try {
        for await (const event of ctx.event.subscribe({
          types: ['session.execution.succeeded'],
          signal: controller.signal,
        })) {
          try {
            if (controller.signal.aborted) break;
            const sessionID = event.data?.sessionID;
            if (event.type !== 'session.execution.succeeded' ||
                typeof event.id !== 'string' || !event.id ||
                typeof sessionID !== 'string' || !sessionID || handledEvents.has(event.id)) continue;
            handledEvents.add(event.id);

            const session = await ctx.session.get({ sessionID });
            if (session.parentID || session.location?.directory !== directory) continue;

            const response = await runHook(
              'agent-stop',
              { sessionID, cwd: directory },
              COMPLETION_TIMEOUT_MS,
              directory,
              ['--agent', 'opencode'],
            );
            if (controller.signal.aborted || response.shouldContinue !== true ||
                typeof response.findings !== 'string' || !response.findings.trim()) continue;
            await ctx.session.prompt({ sessionID, text: response.findings });
          } catch {
            // Completion analysis must never prevent the session from finishing.
          }
        }
      } catch {
        // A failed event stream leaves sessions completed without a follow-up.
      }
    }
    const completionEvents = observeCompletions();
    return async () => {
      controller.abort();
      await completionEvents;
    };
  },
};
`;
