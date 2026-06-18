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

// Stop callback handler for Claude Code — runs git change-set SQAA at end of turn.

import { resolveAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { buildSqaaJsonReport } from '../analyze/sqaa';
import { formatSqaaJsonReportForHook, writeStopHookOutput } from './format-sqaa-hook-context';
import { readStdinJson } from './stdin';

interface StopHookPayload {
  stop_hook_active?: boolean;
}

export interface ClaudeStopOptions {
  project?: string;
}

export async function claudeStop(options: ClaudeStopOptions): Promise<void> {
  const projectKey = options.project;
  if (!projectKey) return;

  try {
    const payload = await readStdinJson<StopHookPayload>();
    if (payload.stop_hook_active === true) return;
  } catch {
    // Missing or unparseable stdin — proceed with analysis (non-blocking).
  }

  const auth = await resolveAuth().catch(() => null);
  if (auth?.connectionType !== 'cloud' || !auth.orgKey) return;

  try {
    const report = await buildSqaaJsonReport(
      { project: projectKey, force: true, format: 'json' },
      auth,
    );
    if (!report) return;

    const text = formatSqaaJsonReportForHook(report);
    if (text) {
      writeStopHookOutput(text);
    }
  } catch (err) {
    logger.debug(`Claude Stop SQAA analysis failed: ${(err as Error).message}`);
  }
}
