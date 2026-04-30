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

// Bun preload script for Istanbul-based unit test coverage.
//
// When COVERAGE_RAW_UNIT_DIR is set, this script registers a Bun plugin that
// instruments every src/**/*.ts file with istanbul-lib-instrument before it is
// loaded, then serializes globalThis.__coverage__ to a unique JSON file inside
// COVERAGE_RAW_UNIT_DIR via a global afterAll hook.
//
// bun test runs each test file in a separate worker process; process.on('exit')
// does not fire in Bun 1.x workers, so we use afterAll from bun:test instead.
// Using a unique output path per worker (PID + timestamp) ensures workers don't
// race on the same file, mirroring how the integration harness generates filenames.
//
// Usage:
//   COVERAGE_RAW_UNIT_DIR=tests/coverage/reports/raw-unit \
//   bun test --preload ./tests/coverage/preload-instrumenter.ts ./tests/unit/

import { join } from 'node:path';

import { afterAll } from 'bun:test';
import { createInstrumenter } from 'istanbul-lib-instrument';

import { serializeCoverageToFile } from './utils.js';

const coverageRawUnitDir = process.env.COVERAGE_RAW_UNIT_DIR;

if (coverageRawUnitDir) {
  const PROJECT_ROOT = join(import.meta.dir, '../..');
  const SRC_DIR = join(PROJECT_ROOT, 'src') + '/';

  const instrumenter = createInstrumenter({
    esModules: true,
    preserveComments: true,
    parserPlugins: ['typescript'],
    produceSourceMap: false,
  });

  Bun.plugin({
    name: 'istanbul-instrumenter',
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async (args) => {
        const source = await Bun.file(args.path).text();

        // Only instrument files under src/ — pass others through unchanged.
        if (!args.path.startsWith(SRC_DIR)) {
          return { contents: source, loader: 'ts' };
        }

        try {
          const instrumented = instrumenter.instrumentSync(source, args.path);
          return { contents: instrumented, loader: 'ts' };
        } catch (err) {
          process.stderr.write(
            `[istanbul] warning: failed to instrument ${args.path}: ${String(err)}\n`,
          );
          return { contents: source, loader: 'ts' };
        }
      });
    },
  });

  afterAll(() => {
    const unique = `${Date.now()}-${process.pid}`;
    const outputFile = join(coverageRawUnitDir, `coverage-${unique}.json`);
    serializeCoverageToFile(outputFile);
  });
}
