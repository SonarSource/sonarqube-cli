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
 * Builds the unbundled CLI with external source maps for `sentry:upload-sourcemaps`.
 * Single-file executables do not emit source maps, so this mirrors the binary build.
 *
 * Run via: bun build-scripts/build-sourcemaps.ts
 */

import { join } from 'node:path';

import { createSentryPlugins } from './sentry-plugins.ts';

const PROJECT_ROOT = join(import.meta.dir, '..');

const result = await Bun.build({
  entrypoints: [join(PROJECT_ROOT, 'src/index.ts')],
  outdir: join(PROJECT_ROOT, 'dist'),
  sourcemap: 'external',
  target: 'bun',
  plugins: createSentryPlugins(),
});

if (!result.success) {
  const logs = result.logs.map((log) => log.message ?? JSON.stringify(log)).join('\n');
  process.stderr.write(`${logs || 'Failed to build source maps'}\n`);
  process.exit(1);
}
