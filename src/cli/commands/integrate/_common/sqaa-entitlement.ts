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

import { SonarQubeClient } from '../../../../sonarqube/client';
import { warn } from '../../../../ui';

/**
 * Check if the organization has SonarQube Agentic Analysis (SQAA) entitlement.
 *
 * Returns false for on-premise, missing org, or failed API call. The underlying
 * `hasSqaaEntitlement` already swallows network/API errors, so the try/catch
 * here is defence-in-depth for unexpected throws (e.g. malformed URLs from the
 * client constructor).
 */
export async function resolveSqaaEntitlement(
  serverURL: string,
  token: string,
  organization: string | undefined,
): Promise<boolean> {
  try {
    const client = new SonarQubeClient(serverURL, token);
    return await client.hasSqaaEntitlement(organization);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(`Could not determine SonarQube Agentic Analysis entitlement — skipping: ${detail}`);
    return false;
  }
}

/**
 * Emit the standard "SQAA is project-scoped" warning when an entitled org runs
 * an integration globally. SQAA hooks and instructions are only installed by
 * per-project integrate runs, so global users need to be steered to re-run.
 *
 * No-op unless both `isGlobal` and `sqaaEntitled` are true — keeps call sites
 * free of nested conditionals.
 *
 * `agentCommand` is the subcommand name (e.g. `claude`, `codex`, `copilot`)
 * that gets baked into the suggested `sonar integrate <agent> --project <key>`.
 */
export function warnSqaaSkippedOnGlobal(
  agentCommand: string,
  isGlobal: boolean,
  sqaaEntitled: boolean,
): void {
  if (!isGlobal || !sqaaEntitled) {
    return;
  }
  warn(
    `SonarQube Agentic Analysis is project-scoped and is not enabled by this global install. Run \`sonar integrate ${agentCommand} --project <key>\` from a project directory to enable it for that project.`,
  );
}
