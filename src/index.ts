#!/usr/bin/env bun

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

// Main CLI entry point

import { createCommandTree } from '@/commands/command-tree.ts';
import { supportedIntegrations } from '@/commands/integrate';
import { CLAUDE_INTEGRATION_ID } from '@/commands/integrate/claude/declaration.ts';
import { installHooks } from '@/commands/integrate/claude/hooks.ts';
import { resolveAuth, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { resolvePrivateBetaFlags } from '@/core/launch-darkly';
import logger from '@/core/observability/logger.ts';
import { flushSentry } from '@/core/observability/sentry.ts';
import { setFormattedOutputMode } from '@/core/ui';
import * as postUpdate from '@/core/update/post-update.ts';

// Activate formatted output mode early so startup messages are collected
// rather than printed to stdout when the command will produce JSON output.
// Handles both `--format json` (space-separated) and `--format=json` (equals form).
if (
  process.argv.some(
    (a, i) =>
      (a === '--format' && (process.argv[i + 1] === 'json' || process.argv[i + 1] === 'toon')) ||
      a === '--format=json' ||
      a === '--format=toon',
  )
) {
  setFormattedOutputMode(true);
}

await postUpdate.runPostUpdateActions({
  supportedIntegrations,
  claudeIntegrationId: CLAUDE_INTEGRATION_ID,
  installHooks,
});

async function resolveStartupAuth(): Promise<ResolvedAuth | null> {
  try {
    return await resolveAuth({ silent: true });
  } catch (err) {
    logger.debug(`Startup auth resolution failed: ${(err as Error).message}`);
    return null;
  }
}

const tree = await createCommandTree({
  loadPrivateBetaContext: async (flagKeys) => {
    const auth = await resolveStartupAuth();
    const flags = await resolvePrivateBetaFlags(auth, { flagKeys });
    return { auth, flags };
  },
});

await tree.parseAsync(process.argv);
await flushSentry();
