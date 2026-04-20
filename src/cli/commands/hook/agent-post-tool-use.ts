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

// PostToolUse callback handler — runs SQAA analysis after the agent edits or writes a file.
// Replaces the bash/PowerShell logic that was previously embedded in the hook script.

import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { resolveAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import type { SqaaIssue } from '../../../sonarqube/client';
import { SonarQubeClient } from '../../../sonarqube/client';
import { readStdinJson } from './stdin';

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
}

export interface AgentPostToolUseOptions {
  project?: string;
}

export async function agentPostToolUse(options: AgentPostToolUseOptions): Promise<void> {
  let payload: PostToolUsePayload;
  try {
    payload = await readStdinJson<PostToolUsePayload>();
  } catch {
    return; // unparseable stdin — non-blocking
  }

  const toolName = payload.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write') return;

  const filePath = payload.tool_input?.file_path;
  if (!filePath || !existsSync(filePath)) return;

  const auth = await resolveAuth().catch(() => null);
  if (auth?.connectionType !== 'cloud' || !auth.orgKey) return;

  const projectKey = options.project;
  if (!projectKey) return;

  try {
    const fileContent = readFileSync(filePath, 'utf-8');
    const filePath_ = relative(process.cwd(), filePath);
    const client = new SonarQubeClient(auth.serverUrl, auth.token);

    const response = await client.analyzeFile({
      organizationKey: auth.orgKey,
      projectKey,
      filePath: filePath_,
      fileContent,
    });

    const text = formatSqaaResult(response.issues, response.errors);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
      }) + '\n',
    );
  } catch (err) {
    logger.debug(`PostToolUse SQAA analysis failed: ${(err as Error).message}`);
  }
}

function formatSqaaResult(
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): string {
  const lines: string[] = [];

  if (issues.length === 0) {
    lines.push('SQAA analysis completed — no issues found.');
  } else {
    lines.push(`SQAA analysis found ${issues.length} issue${issues.length === 1 ? '' : 's'}:`);
    issues.forEach((issue, idx) => {
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      lines.push(`  [${idx + 1}] ${issue.message}${location} [${issue.rule}]`);
    });
  }

  if (errors && errors.length > 0) {
    lines.push('SQAA errors:');
    errors.forEach((e) => lines.push(`  [${e.code}] ${e.message}`));
  }

  return lines.join('\n');
}
