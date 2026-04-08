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

import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dir, '../..');

export const COVERAGE_BINARY = join(PROJECT_ROOT, 'dist', 'sonarqube-cli-coverage');
export const COVERAGE_RAW_DIR = join(PROJECT_ROOT, 'tests', 'coverage', 'reports', 'raw');
export const COVERAGE_INTEGRATION_REPORT_DIR = join(
  PROJECT_ROOT,
  'tests',
  'coverage',
  'reports',
  'integration',
);
