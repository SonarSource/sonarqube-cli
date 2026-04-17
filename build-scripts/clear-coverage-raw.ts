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

/**
 * Clears raw Istanbul JSON files left from a previous integration-test run.
 * Call this before starting a new coverage run to avoid stale data from
 * accumulating in tests/coverage/raw/.
 *
 * Run via: bun build-scripts/clear-coverage-raw.ts
 */

import { existsSync, rmSync } from 'node:fs';

import { COVERAGE_RAW_DIR } from '../tests/coverage/paths.js';

if (existsSync(COVERAGE_RAW_DIR)) {
  rmSync(COVERAGE_RAW_DIR, { recursive: true, force: true });
  console.log(`Cleared: ${COVERAGE_RAW_DIR}`);
} else {
  console.log(`Nothing to clear at: ${COVERAGE_RAW_DIR}`);
}
