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
 * Reads Istanbul JSON files from the raw dirs and generates LCOV reports.
 *
 * Integration: tests/coverage/reports/raw/ → tests/coverage/reports/integration/lcov.info
 * Unit:        tests/coverage/reports/raw-unit/ → tests/coverage/reports/unit/lcov.info
 *
 * Each section is processed only when its raw dir exists and is non-empty,
 * so the script can be called from either the unit-tests job (only unit raw
 * data present) or the integration job (only integration raw data present),
 * or both in the full test:coverage local run.
 *
 * At least one raw dir must have data, or the script exits with an error.
 *
 * SonarQube is configured to read both lcov files via
 * sonar.javascript.lcov.reportPaths in sonar-project.properties.
 *
 * Run via: bun build-scripts/report-coverage.ts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type CoverageMapData, createCoverageMap } from 'istanbul-lib-coverage';
import { createContext } from 'istanbul-lib-report';
import reports from 'istanbul-reports';

import {
  COVERAGE_INTEGRATION_REPORT_DIR,
  COVERAGE_RAW_DIR,
  COVERAGE_UNIT_RAW_DIR,
  COVERAGE_UNIT_REPORT_DIR,
} from '../tests/coverage/paths.js';

function processRawDir(rawDir: string, reportDir: string, label: string): boolean {
  if (!existsSync(rawDir)) {
    console.log(`No ${label} raw coverage dir found at ${rawDir}, skipping.`);
    return false;
  }
  const jsonFiles = readdirSync(rawDir).filter((f) => f.endsWith('.json'));
  if (jsonFiles.length === 0) {
    console.log(`No JSON files found in ${rawDir}, skipping ${label} lcov.`);
    return false;
  }
  console.log(`Processing ${jsonFiles.length} ${label} coverage file(s)...`);
  const coverageMap = createCoverageMap({});
  for (const file of jsonFiles) {
    const data = JSON.parse(readFileSync(join(rawDir, file), 'utf-8')) as CoverageMapData;
    coverageMap.merge(data);
  }
  const ctx = createContext({ coverageMap, dir: reportDir });
  reports.create('lcov').execute(ctx);
  console.log(`${label} lcov written to ${reportDir}/lcov.info`);
  return true;
}

const wroteIntegration = processRawDir(
  COVERAGE_RAW_DIR,
  COVERAGE_INTEGRATION_REPORT_DIR,
  'integration',
);
const wroteUnit = processRawDir(COVERAGE_UNIT_RAW_DIR, COVERAGE_UNIT_REPORT_DIR, 'unit');

if (!wroteIntegration && !wroteUnit) {
  console.error('No coverage data found in either raw dir. Run tests with coverage first.');
  process.exit(1);
}
