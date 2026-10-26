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

import type { SecretsMaskingAgentAdapter } from '../types.ts';

type ToolOutput = string | number | boolean | null | ToolOutput[] | { [key: string]: ToolOutput };

interface PostToolUsePayload {
  session_id: string;
  tool_response: ToolOutput;
}

export const codexAdapter: SecretsMaskingAgentAdapter = {
  parse: (payload) => {
    const p = payload as PostToolUsePayload;
    return {
      sessionId: p.session_id,
      toolOutput: p.tool_response == null ? undefined : toolOutputText(p.tool_response),
    };
  },
  emit: ({ replacementToolOutput }) => ({ decision: 'block', reason: replacementToolOutput }),
};

function toolOutputText(value: ToolOutput): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(toolOutputText).join('\n');
  return Object.entries(value)
    .map(([key, entry]) => `${key}: ${toolOutputText(entry)}`)
    .join('\n');
}
