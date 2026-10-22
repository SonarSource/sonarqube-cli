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

// `prompt` hook handler for OpenCode 2.0 — scans the prompt text for secrets and, if every
// finding can be masked, returns the text with each secret masked in place so the plugin can
// replace the prompt text before the message is sent (the plugin appends a visible `[Sonar]`
// notice to say what was masked, since OpenCode 2.0 has no hidden part). Unlike
// `opencode-pre-tool-use`, this does not block on a well-formed finding — but if any finding
// can't be masked (missing location/mask, or an unparseable scan result), it fails closed and
// blocks the message rather than letting an unmasked secret through.
//
// Same explicit-JSON-always contract as `opencode-pre-tool-use` (see that file's comment).

import { SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';

import { createChatMessageHook } from './agent-secrets-hooks.ts';

export const opencodeChatMessage = createChatMessageHook({
  callerCommand: SECRETS_CALLER_COMMANDS.opencodeChatMessage,
  logPrefix: 'opencode-chat-message',
  blockOnUnexpectedExitCode: false,
});
