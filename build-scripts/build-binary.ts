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
 * Builds the compiled CLI binary and injects the distribution channel as a
 * compile-time constant for downstream channel-specific behavior.
 *
 * Run via: bun build-scripts/build-binary.ts
 */

import { join } from 'node:path';

import { resolveDistribution } from '@/core/host/environment/distribution.ts';

const PROJECT_ROOT = join(import.meta.dir, '..');
const DEFAULT_OUTFILE = join(PROJECT_ROOT, 'dist', 'sonarqube-cli');
const DISTRIBUTION_DEFINE_KEY = 'process.env.SONARQUBE_CLI_DISTRIBUTION';
type BuildTarget = Bun.Build.CompileTarget;

const distribution = resolveDistribution(process.env.SONARQUBE_CLI_DISTRIBUTION);
const outfile = process.env.SONARQUBE_CLI_OUTFILE ?? DEFAULT_OUTFILE;
const target = process.env.SONARQUBE_CLI_TARGET as BuildTarget | undefined;

console.log(`Building CLI binary for distribution: ${distribution} (${target ?? 'host'})`);

const result = await Bun.build({
  entrypoints: [join(PROJECT_ROOT, 'src/index.ts')],
  compile: target ? { target, outfile } : { outfile },
  define: {
    [DISTRIBUTION_DEFINE_KEY]: JSON.stringify(distribution),
  },
});

if (!result.success) {
  const logs = result.logs.map((log) => log.message ?? JSON.stringify(log)).join('\n');
  process.stderr.write(`${logs || 'Failed to build CLI binary'}\n`);
  process.exit(1);
}

console.log(`CLI binary built: ${outfile}`);
