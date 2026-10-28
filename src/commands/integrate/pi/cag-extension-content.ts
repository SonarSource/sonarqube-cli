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

export const PI_CAG_EXTENSION_CONTENT = `// ${PI_EXTENSION_MANAGED_MARKER} — do not edit by hand.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
${PI_EXTENSION_HELPERS}
const SESSION_START_HOOK_TIMEOUT_MS = 20000;
const ANNOUNCE_CUSTOM_TYPE = 'sonar-cag-announce';

interface SessionStartAnswer {
  additionalContext?: string;
  userMessage?: string;
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    const alreadyAnnounced = ctx.sessionManager
      .getEntries()
      .some((entry) => (entry as { customType?: string }).customType === ANNOUNCE_CUSTOM_TYPE);
    if (alreadyAnnounced) return;
    try {
      const { additionalContext, userMessage } = await runHook<SessionStartAnswer>(
        'agent-session-start --agent pi',
        { sessionID: ctx.sessionManager.getSessionId(), cwd: ctx.cwd },
        SESSION_START_HOOK_TIMEOUT_MS,
        ctx.cwd,
      );
      if (typeof userMessage === 'string' && userMessage) {
        pi.sendMessage({
          customType: 'sonar-cag-warning',
          content: [{ type: 'text', text: userMessage }],
          display: true,
        });
        return;
      }
      if (typeof additionalContext !== 'string' || !additionalContext) return;
      pi.sendMessage({
        customType: ANNOUNCE_CUSTOM_TYPE,
        content: [{ type: 'text', text: additionalContext }],
        display: false,
      });
    } catch {
      return;
    }
  });
}
`;
