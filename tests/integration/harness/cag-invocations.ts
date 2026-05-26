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

// Shared CAG-invocation log helpers for integration tests. The CAG stub
// (resources/cag-stub.ts) appends one JSON line per non-version call to
// <cliHome>/cag-invocations.jsonl; specs read it back to assert the CLI
// drove CAG with the right subcommand/env.

import type { TestHarness } from './index';

export interface CagInvocation {
  argv: string[];
  env: {
    SONAR_CONTEXT_ORGANIZATION?: string;
    SONAR_CONTEXT_PROJECT?: string;
    SONAR_CONTEXT_TOKEN?: string;
    SONAR_CONTEXT_URL?: string;
  };
}

export function readCagInvocations(harness: TestHarness): CagInvocation[] {
  const file = harness.cliHome.file('cag-invocations.jsonl');
  if (!file.exists()) return [];
  return file
    .asText()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CagInvocation);
}
