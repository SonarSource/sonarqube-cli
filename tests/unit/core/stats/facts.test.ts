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

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { SCA_CALLER_COMMANDS } from '@/commands/analyze/sca-analysis-telemetry.ts';
import { SECRETS_CALLER_COMMANDS } from '@/commands/analyze/secrets-analysis-telemetry.ts';
import {
  SQAA_ANALYZE_AGENTIC_CALLER_COMMAND,
  SQAA_ANALYZE_CALLER_COMMAND,
  SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
  SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND,
  SQAA_VERIFY_CALLER_COMMAND,
} from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import { StatsFact } from '@/core/commands/invocation-context.ts';
import { getStatsDir, STATS_DB_FILENAME } from '@/core/config-constants.ts';
import { type AnalyzerStatsFactPayload, commitStatsFacts } from '@/core/stats/facts.ts';

import { useTempSonarUserHome } from './_helpers.ts';

useTempSonarUserHome('cli-stats-facts-test-');

function readEvents(): Array<{ caller_command: string; run_trigger: string }> {
  const dbPath = join(getStatsDir(), STATS_DB_FILENAME);
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT caller_command, run_trigger FROM stats_events').all() as never;
  } finally {
    db.close();
  }
}

function recordFact(callerCommand: string): void {
  commitStatsFacts([
    new StatsFact<AnalyzerStatsFactPayload>({
      analyzer: 'sonar-secrets',
      callerCommand,
      exitCode: 0,
      findingsCount: 0,
    }),
  ]);
}

describe('commitStatsFacts: run_trigger classification', () => {
  // Coverage test: every real caller-command constant from the three analyzer files
  // must classify as expected against the hand-maintained MANUAL_CALLER_COMMANDS set in
  // facts.ts (deliberately not imported from src/commands — src/core never imports
  // from src/commands elsewhere in this codebase). This is what catches drift.
  it.each([
    [SECRETS_CALLER_COMMANDS.analyze, 'manual'],
    [SECRETS_CALLER_COMMANDS.analyzeSecrets, 'manual'],
    [SECRETS_CALLER_COMMANDS.analyzeDependencyRisks, 'manual'],
    [SECRETS_CALLER_COMMANDS.gitPreCommit, 'hooks'],
    [SECRETS_CALLER_COMMANDS.gitPrePush, 'hooks'],
    [SECRETS_CALLER_COMMANDS.agentPromptSubmit, 'hooks'],
    [SECRETS_CALLER_COMMANDS.cursorPromptSubmit, 'hooks'],
    [SECRETS_CALLER_COMMANDS.claudePreToolUse, 'hooks'],
    [SECRETS_CALLER_COMMANDS.copilotPreToolUse, 'hooks'],
    [SECRETS_CALLER_COMMANDS.antigravityPreToolUse, 'hooks'],
    [SECRETS_CALLER_COMMANDS.cursorPreFileRead, 'hooks'],
    [SECRETS_CALLER_COMMANDS.cursorPreToolUse, 'hooks'],
    [SQAA_ANALYZE_CALLER_COMMAND, 'manual'],
    [SQAA_ANALYZE_AGENTIC_CALLER_COMMAND, 'manual'],
    [SQAA_VERIFY_CALLER_COMMAND, 'manual'],
    [SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND, 'hooks'],
    [SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND, 'hooks'],
    [SCA_CALLER_COMMANDS.analyzeDependencyRisks, 'manual'],
    [SCA_CALLER_COMMANDS.gitPreCommit, 'hooks'],
  ])('classifies "%s" as %s', (callerCommand, expectedTrigger) => {
    recordFact(callerCommand);

    const [event] = readEvents();
    expect(event.run_trigger).toBe(expectedTrigger);
  });
});

describe('commitStatsFacts', () => {
  it('is a no-op for an empty fact list', () => {
    expect(() => commitStatsFacts([])).not.toThrow();
    expect(readEvents()).toEqual([]);
  });
});
