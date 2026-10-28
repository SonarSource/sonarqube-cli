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

export const OPENCODE_PLUGIN_MANAGED_MARKER = 'Managed by `sonar integrate opencode`';

export const OPENCODE_PLUGIN_MANAGED_HEADER = `// ${OPENCODE_PLUGIN_MANAGED_MARKER} — do not edit by hand.`;

export const OPENCODE_SECRETS_PLUGIN_CONTENT = String.raw`${OPENCODE_PLUGIN_MANAGED_HEADER}
${OPENCODE_PLUGIN_HELPERS_CONTENT}
const HOOK_TIMEOUT_MS = 60000;
const BYPASS_WARNING =
  'Do not attempt to access this file another way (e.g. via bash) — inform the user of the block and ask before taking any other action.';

const MASKED_NOTICE = '[Sonar] A secret was detected in this message and masked before it was sent.';

function isDecision(value: any): boolean {
  return (
    typeof value?.block === 'boolean' &&
    (value.redactedText === undefined || typeof value.redactedText === 'string')
  );
}

function dropMentions(prompt: any): void {
  for (const attachments of [prompt.files, prompt.agents, prompt.skills]) {
    for (const attachment of attachments ?? []) delete attachment.mention;
  }
}

function blockedMessage(reason: string): string {
  return '[Sonar] Message blocked: ' + reason + '. Blocked as a precaution — original content was not sent.';
}

export default {
  id: 'sonar-secrets',
  async setup(ctx: any) {
    const directory: string = ctx.location.directory;

    await ctx.tool.hook('execute.before', async (event: any) => {
      if (event.tool !== 'read') return;
      const path = event.input?.path;
      if (typeof path !== 'string' || !path) return;

      let decision: { block: boolean; reason?: string };
      try {
        decision = await runHook(
          'opencode-pre-tool-use',
          { tool: event.tool, filePath: toFullPath(path, directory), sessionID: event.sessionID },
          HOOK_TIMEOUT_MS,
          directory,
        );
        if (!isDecision(decision)) throw new Error('unexpected answer from sonar');
      } catch (error) {
        throw new Error('Sonar: could not verify this file for secrets (' + errorMessage(error) + '). Blocking as a precaution.');
      }

      if (decision.block) {
        throw new Error((decision.reason ?? 'Sonar blocked this file read.') + ' ' + BYPASS_WARNING);
      }
    });

    await ctx.session.hook('prompt', async (event: any) => {
      try {
        const decision: { block: boolean; reason?: string; redactedText?: string; secretsFound?: number } =
          await runHook(
            'opencode-chat-message',
            { text: event.prompt.text, sessionID: event.sessionID },
            HOOK_TIMEOUT_MS,
            directory,
          );
        if (!isDecision(decision)) throw new Error('unexpected answer from sonar');

        if (decision.block) {
          const reason = (decision.reason ?? 'Sonar blocked this message').replace(/\.$/, '');
          event.prompt.text = blockedMessage(reason);
          dropMentions(event.prompt);
          return;
        }

        if (decision.redactedText !== undefined) {
          event.prompt.text = decision.redactedText + '\n\n' + MASKED_NOTICE;
          dropMentions(event.prompt);
        }
      } catch (error) {
        event.prompt.text = blockedMessage('could not verify this message for secrets (' + errorMessage(error) + ')');
        dropMentions(event.prompt);
      }
    });
  },
};
`;
