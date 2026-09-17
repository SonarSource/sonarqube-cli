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

// Shared scaffolding for remaining `tests/e2e/context/*` suites.

export {
  ALLOWLISTED_CAG_ORG_KEY,
  findRecordedCagDependency,
  SEEDED_PROJECT_KEY,
  seedState,
  STALE_CLI_VERSION,
} from '../../integration/harness/cag-state.ts';

export function buildCompressibleGradleStdout(): string {
  const taskLines = Array.from(
    { length: 10 },
    (_, index) => `> Task :module${index}:compileJava UP-TO-DATE`,
  );
  return [...taskLines, 'BUILD SUCCESSFUL in 4s', '10 actionable tasks: 10 up-to-date', ''].join(
    '\n',
  );
}
