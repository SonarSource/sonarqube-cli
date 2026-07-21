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

// Shared assertions for `printAgentNonInteractiveAlternativeHint` output
// (src/commands/_common/agent-prompt-hint.ts). Callers only supply the
// non-interactive example(s), mirroring the real function's own signature.

import { expect } from 'bun:test';

/** Asserts the hint was printed, with one line per example. */
export function expectAgentPromptHint(output: string, ...examples: string[]): void {
  expect(output).toContain('Agent environment detected. To run non-interactively:');
  for (const example of examples) {
    expect(output).toContain(`   → ${example}`);
  }
}

/** Asserts the hint was not printed at all (e.g. human/non-agent caller). */
export function expectNoAgentPromptHint(output: string): void {
  expect(output).not.toContain('To run non-interactively');
}
