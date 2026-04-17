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
 * Reads all Istanbul JSON files from tests/coverage/reports/raw/, merges
 * them, and generates tests/coverage/reports/integration/lcov.info.
 *
 * SonarQube is configured to read both this file and the unit lcov
 * (tests/coverage/reports/unit/lcov.info) separately via
 * sonar.javascript.lcov.reportPaths in sonar-project.properties.
 *
 * Run via: bun build-scripts/report-coverage.ts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type CoverageMapData, createCoverageMap } from 'istanbul-lib-coverage';
import { createContext } from 'istanbul-lib-report';
import reports from 'istanbul-reports';

import { COVERAGE_INTEGRATION_REPORT_DIR, COVERAGE_RAW_DIR } from '../tests/coverage/paths.js';

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

console.log(`Processing ${jsonFiles.length} integration coverage file(s)...`);

const coverageMap = createCoverageMap({});
for (const file of jsonFiles) {
  const data = JSON.parse(readFileSync(join(COVERAGE_RAW_DIR, file), 'utf-8')) as CoverageMapData;
  coverageMap.merge(data);
}

const ctx = createContext({ coverageMap, dir: COVERAGE_INTEGRATION_REPORT_DIR });
reports.create('lcov').execute(ctx);

console.log(`Integration lcov written to ${COVERAGE_INTEGRATION_REPORT_DIR}/lcov.info`);
