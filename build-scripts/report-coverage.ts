/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
 * 1. Reads all Istanbul JSON files from tests/coverage/reports/raw/, merges
 *    them, and generates tests/coverage/reports/integration/lcov.info.
 * 2. Merges the unit lcov (from bun test --coverage) with the integration lcov
 *    into the final coverage/lcov.info consumed by SonarQube.
 *
 * Run via: bun build-scripts/report-coverage.ts
 */

import { createCoverageMap } from 'istanbul-lib-coverage';
import { createContext } from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  COVERAGE_INTEGRATION_REPORT_DIR,
  COVERAGE_MERGED_LCOV,
  COVERAGE_RAW_DIR,
} from '../tests/coverage/paths.js';

// ---------------------------------------------------------------------------
// Step 1 — integration lcov from Istanbul JSON
// ---------------------------------------------------------------------------

if (!existsSync(COVERAGE_RAW_DIR)) {
  console.error(`No integration coverage data found at ${COVERAGE_RAW_DIR}`);
  console.error('Run the integration tests first with the coverage binary.');
  process.exit(1);
}

const jsonFiles = readdirSync(COVERAGE_RAW_DIR).filter((f) => f.endsWith('.json'));
if (jsonFiles.length === 0) {
  console.error(`No JSON files found in ${COVERAGE_RAW_DIR}`);
  process.exit(1);
}

console.log(`[1/2] Processing ${jsonFiles.length} integration coverage file(s)...`);

const coverageMap = createCoverageMap({});
for (const file of jsonFiles) {
  const data = JSON.parse(readFileSync(join(COVERAGE_RAW_DIR, file), 'utf-8'));
  coverageMap.merge(data);
}

const ctx = createContext({ coverageMap, dir: COVERAGE_INTEGRATION_REPORT_DIR });
// @ts-ignore — istanbul-reports has no bundled type declarations
reports.create('lcov').execute(ctx);

console.log(`    Integration lcov written to ${COVERAGE_INTEGRATION_REPORT_DIR}/lcov.info`);

// ---------------------------------------------------------------------------
// Step 2 — merge unit + integration into coverage/lcov.info
// ---------------------------------------------------------------------------

console.log('[2/2] Merging unit and integration coverage...');

mkdirSync(dirname(COVERAGE_MERGED_LCOV), { recursive: true });

const PROJECT_ROOT = join(import.meta.dir, '..');
const merge = Bun.spawnSync(
  [
    'bunx',
    'lcov-result-merger',
    'tests/coverage/reports/{unit,integration}/lcov.info',
    COVERAGE_MERGED_LCOV,
  ],
  { cwd: PROJECT_ROOT },
);

if (merge.exitCode !== 0) {
  process.stderr.write(new TextDecoder().decode(merge.stderr));
  process.exit(1);
}

console.log(`    Merged coverage written to ${COVERAGE_MERGED_LCOV}`);
