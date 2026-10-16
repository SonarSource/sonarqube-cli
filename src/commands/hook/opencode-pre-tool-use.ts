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

// tool.execute.before callback handler for OpenCode — scans files for secrets before the agent
// reads them. Unlike the other agents' shell-script hooks, the OpenCode plugin calls this
// subcommand directly (no intermediate hook script) and always expects a JSON decision on
// stdout, whether the read is allowed or blocked — OpenCode has no "silent stdout means allow"
// convention to mirror, so we define our own explicit contract instead.

import { SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';

import { createPreToolUseHook } from './agent-secrets-hooks.ts';

export const opencodePreToolUse = createPreToolUseHook({
  callerCommand: SECRETS_CALLER_COMMANDS.opencodePreToolUse,
  logPrefix: 'opencode-pre-tool-use',
  blockOnUnexpectedExitCode: false,
  blockedFileReason: (filePath) => `Sonar detected secrets in file: ${filePath}`,
});
