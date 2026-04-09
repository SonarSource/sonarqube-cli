#!/usr/bin/env bun

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

// Coverage entry point — registers a process.on('exit') handler to serialize
// Istanbul's __coverage__ global to COVERAGE_OUTPUT_FILE, then delegates to
// the real entry point (src/index.ts) via a dynamic import so the handler is
// registered before any CLI code runs.
//
// Only used when building the coverage-instrumented binary.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const coverageOutputFile = process.env.COVERAGE_OUTPUT_FILE;
if (coverageOutputFile) {
  process.on('exit', () => {
    const cov = (globalThis as Record<string, unknown>).__coverage__;
    if (cov) {
      try {
        mkdirSync(dirname(coverageOutputFile), { recursive: true });
        writeFileSync(coverageOutputFile, JSON.stringify(cov));
      } catch {
        // best-effort: do not crash the process over coverage serialization
      }
    }
  });
}

await import('../../src/index');
