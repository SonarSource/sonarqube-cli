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

import { workspaceRootToPath } from '../../cursor-ignore.ts';
import type { SessionStartAgentAdapter } from '../types.ts';

interface CursorSessionStartPayload {
  conversation_id: string;
  /** Normally one entry; a multiroot workspace has several, and the docs allow none. */
  workspace_roots: string[];
}

export const cursorAdapter: SessionStartAgentAdapter = {
  parse: (payload) => {
    const p = payload as CursorSessionStartPayload;
    const root = p.workspace_roots[0];
    return {
      sessionId: p.conversation_id,
      startDir: root ? workspaceRootToPath(root) : undefined,
      eventName: undefined,
    };
  },
  emit: ({ additionalContext }) => ({ additional_context: additionalContext }),
};
