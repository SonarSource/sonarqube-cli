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
 * Builds a coverage-instrumented binary using Istanbul.
 *
 * Every .ts file under src/ is intercepted by a Bun build plugin that runs
 * istanbul-lib-instrument on it before bundling.  The entry point is
 * src/index-coverage.ts, which registers a process.on('exit') handler that
 * writes globalThis.__coverage__ to COVERAGE_OUTPUT_FILE, then delegates to
 * src/index.ts.
 *
 * Run via: bun build-scripts/build-coverage-binary.ts
 */

import { join } from 'node:path';

import type { BunPlugin } from 'bun';
import { createInstrumenter } from 'istanbul-lib-instrument';

const PROJECT_ROOT = join(import.meta.dir, '..');
const SRC_DIR = join(PROJECT_ROOT, 'src') + '/';

const instrumenter = createInstrumenter({
  esModules: true,
  preserveComments: true,
  parserPlugins: ['typescript'],
  produceSourceMap: false,
});

const istanbulPlugin: BunPlugin = {
  name: 'istanbul-instrumenter',
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      if (!args.path.startsWith(SRC_DIR)) return;

      const source = await Bun.file(args.path).text();
      try {
        const instrumented = instrumenter.instrumentSync(source, args.path);
        return { contents: instrumented, loader: 'ts' };
      } catch (err) {
        // If instrumentation fails for a file, fall back to plain TypeScript
        process.stderr.write(
          `[istanbul] warning: failed to instrument ${args.path}: ${String(err)}\n`,
        );
        return { contents: source, loader: 'ts' };
      }
    });
  },
};

const outfile = join(PROJECT_ROOT, 'dist/sonarqube-cli-coverage');

console.log('Building coverage-instrumented binary...');

const result = await Bun.build({
  entrypoints: [join(PROJECT_ROOT, 'tests/coverage/index-coverage.ts')],
  target: 'bun',
  compile: { outfile },
  plugins: [istanbulPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log.message ?? JSON.stringify(log)}\n`);
  }
  process.exit(1);
}

console.log(`Coverage binary built: ${outfile}`);
