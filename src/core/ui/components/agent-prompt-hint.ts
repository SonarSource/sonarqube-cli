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

import { detectCallerAgent } from '@/core/host/environment/agent-detector.ts';
import type { Console } from '@/core/ui/console.ts';

export function printAgentNonInteractiveAlternativeHint(
  console: Console,
  ...nonInteractiveExamples: string[]
): void {
  if (detectCallerAgent() === null) {
    return;
  }
  console.info('Agent environment detected. To run non-interactively:');
  for (const example of nonInteractiveExamples) {
    console.print(`   → ${example}`);
  }
}

export const AUTH_LOGIN_HINT =
  "Run 'sonar auth login --server <url> --org <key>' in a separate terminal (omit --org for SonarQube Server), or set SONARQUBE_CLI_TOKEN plus SONARQUBE_CLI_ORG for Cloud, plus SONARQUBE_CLI_SERVER for the US region; for SonarQube Server, set SONARQUBE_CLI_TOKEN plus SONARQUBE_CLI_SERVER. Do not paste a token into the agent conversation.";
