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

import { OPENCODE_PLUGIN_MANAGED_MARKER } from './secrets-plugin-content.ts';

export const OPENCODE_SQAA_PLUGIN_CONTENT = `// ${OPENCODE_PLUGIN_MANAGED_MARKER} — do not edit by hand.
import type { Plugin } from '@opencode-ai/plugin';

interface PostToolUseResult {
  context?: string;
}

const ANALYZED_TOOLS = new Set(['edit', 'write']);

async function analyzeEditedFile($: any, payload: unknown): Promise<string | undefined> {
  try {
    const result = await $\`sonar hook opencode-post-tool-use < \${new Response(JSON.stringify(payload))}\`
      .quiet()
      .nothrow();
    if (result.exitCode !== 0) return undefined;
    return (result.json() as PostToolUseResult).context;
  } catch {
    return undefined;
  }
}

export const SonarSqaaPlugin: Plugin = async ({ $ }) => {
  return {
    'tool.execute.after': async (input, output) => {
      if (!ANALYZED_TOOLS.has(input.tool)) return;
      const filePath = (input.args as { filePath?: string } | undefined)?.filePath;
      if (!filePath) return;

      const context = await analyzeEditedFile($, {
        tool: input.tool,
        filePath,
        sessionID: input.sessionID,
      });
      if (!context) return;

      output.output = \`\${output.output ?? ''}\\n\\n<system-reminder>\\n\${context}\\n</system-reminder>\`;
    },
  };
};
`;
