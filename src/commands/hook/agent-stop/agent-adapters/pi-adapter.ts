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

import type { StopAgentAdapter } from '../types.ts';

interface PiStopPayload {
  sessionID: string;
  cwd: string;
  hasUI: boolean;
}

export const piAdapter: StopAgentAdapter = {
  parse: (payload) => {
    const p = payload as PiStopPayload;
    return {
      sessionId: p.sessionID,
      cwd: p.cwd,
      skipAnalysisReason: p.hasUI
        ? undefined
        : 'Headless Pi sessions are excluded to avoid running completion analysis for subagents',
    };
  },
  emit: ({ findings }) => ({ findings }),
};
