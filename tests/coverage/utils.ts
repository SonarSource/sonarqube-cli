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

// Shared Istanbul coverage serialization helpers used by both
// tests/coverage/index-coverage.ts (integration binary) and
// tests/coverage/preload-instrumenter.ts (unit test preload).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Writes globalThis.__coverage__ to the given file path.
 * Creates parent directories as needed. No-ops silently on any error so that
 * coverage serialization never crashes the process or test suite.
 */
export function serializeCoverageToFile(outputPath: string): void {
  const cov = (globalThis as Record<string, unknown>).__coverage__;
  if (!cov) return;
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(cov));
  } catch {
    // best-effort: do not crash the process over coverage serialization
  }
}
