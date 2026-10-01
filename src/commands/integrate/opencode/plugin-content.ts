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

export const OPENCODE_PLUGIN_MANAGED_MARKER = 'Managed by `sonar integrate opencode`';

export const OPENCODE_PLUGIN_CONTENT = `// ${OPENCODE_PLUGIN_MANAGED_MARKER} — do not edit by hand.
import type { Plugin } from '@opencode-ai/plugin';

interface PreToolUseDecision {
  block: boolean;
  reason?: string;
}

interface ChatMessageDecision {
  block: boolean;
  reason?: string;
  redactedText?: string;
  secretsFound?: number;
}

// Unlike the other agents' shell hooks (which fail OPEN — skip scanning — when the \`sonar\`
// binary isn't on PATH at all), this plugin fails CLOSED: any error spawning or parsing the
// \`sonar hook\` subprocess response blocks the action as a precaution instead of silently
// letting it through.
async function callSonarHook<T>($: any, subcommand: string, payload: unknown): Promise<T> {
  const result = await $\`sonar hook \${subcommand} < \${new Response(JSON.stringify(payload))}\`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(\`sonar hook \${subcommand} exited with code \${result.exitCode}: \${result.stderr}\`);
  }
  return result.json() as T;
}

function makeSyntheticPart(output: any, text: string): any {
  return {
    id: \`prt_\${crypto.randomUUID().replace(/-/g, '')}\`,
    sessionID: output.message.sessionID,
    messageID: output.message.id,
    type: 'text',
    synthetic: true,
    text,
  };
}

export const SonarPlugin: Plugin = async ({ $ }) => {
  return {
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'read') return;
      const filePath = (output.args as { filePath?: string } | undefined)?.filePath;
      if (!filePath) return;

      let decision: PreToolUseDecision;
      try {
        decision = await callSonarHook<PreToolUseDecision>($, 'opencode-pre-tool-use', {
          tool: input.tool,
          filePath,
          sessionID: input.sessionID,
        });
      } catch (err) {
        throw new Error(
          \`Sonar: could not verify this file for secrets (\${err instanceof Error ? err.message : String(err)}). Blocking as a precaution.\`,
        );
      }

      if (decision.block) {
        throw new Error(decision.reason ?? 'Sonar blocked this file read.');
      }
    },
    'chat.message': async (input, output) => {
      // Collected separately and pushed after the loop — appending directly to
      // output.parts while iterating it would make the for-of visit the new
      // (synthetic) part too, since array iterators re-check .length live.
      const newParts: any[] = [];
      let totalSecretsFound = 0;
      const blockedReasons: string[] = [];

      // Unlike tool.execute.before, a thrown Error here is NOT surfaced usefully to the user —
      // OpenCode shows only a generic "Unexpected server error" for a chat.message failure, with
      // no indication of what happened. So instead of throwing when scanning fails or is
      // unavailable, we replace the message's own text with an explanation: the model still
      // receives a normal user-turn message (just not the original, unverified one) and can tell
      // the user in its own words, instead of the conversation dying on an opaque platform error.
      for (const part of output.parts as any[]) {
        if (typeof part.text !== 'string' || !part.text) continue;

        let decision: ChatMessageDecision;
        try {
          decision = await callSonarHook<ChatMessageDecision>($, 'opencode-chat-message', {
            text: part.text,
            sessionID: input.sessionID,
          });
        } catch (err) {
          const reason = \`could not verify this message for secrets (\${err instanceof Error ? err.message : String(err)})\`;
          part.text = \`[Sonar] Message blocked: \${reason}. Blocked as a precaution — original content was not sent.\`;
          blockedReasons.push(reason);
          continue;
        }

        if (decision.block) {
          const reason = decision.reason ?? 'Sonar blocked this message.';
          part.text = \`[Sonar] Message blocked: \${reason} Blocked as a precaution — original content was not sent.\`;
          blockedReasons.push(reason);
          continue;
        }

        if (decision.redactedText !== undefined) {
          part.text = decision.redactedText;
          totalSecretsFound += decision.secretsFound ?? 0;
        }
      }

      if (blockedReasons.length > 0) {
        newParts.push(
          makeSyntheticPart(
            output,
            \`<system-reminder>\\nSonar Vortex: this message could not be verified for secrets (\${blockedReasons.join('; ')}) and was replaced with a placeholder — it was NOT sent as originally written. Tell the user their message was blocked and why, and ask them to retry once the issue is resolved.\\n</system-reminder>\`,
          ),
        );
      } else if (totalSecretsFound > 0) {
        newParts.push(
          makeSyntheticPart(
            output,
            \`<system-reminder>\\nSonar Vortex: \${totalSecretsFound} secret(s) were detected in this message and masked before being sent. Tell the user which secret(s) were found and masked, and remind them to rotate any real credentials.\\n</system-reminder>\`,
          ),
        );
      }

      if (newParts.length > 0) {
        (output.parts as any[]).push(...newParts);
      }
    },
  };
};
`;
