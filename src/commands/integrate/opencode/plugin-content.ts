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
  };
};
`;
