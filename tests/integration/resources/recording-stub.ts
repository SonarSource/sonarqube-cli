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

// Test fixture compiled to a real executable via `bun build --compile`, so Windows can spawn it as a PE binary.
// The harness installs it in place of a dependency binary and writes its configuration to `<executable>.stub.json`
// (see tests/integration/harness/recording-stub.ts). A file next to the executable, rather than env vars, keeps the
// configuration of two stubs used in the same run apart.
//
// Each run appends its argv to `invocationsFile`, then either runs `delegate` with the same argv and stdio, so the
// real binary still does the work, or answers with the canned response for its first argument.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

interface StubResponse {
  stdout?: string;
  exitCode?: number;
}

interface StubConfig {
  invocationsFile: string;
  delegate?: string;
  responses?: Record<string, StubResponse>;
  fallback?: StubResponse;
}

const config = JSON.parse(readFileSync(`${process.execPath}.stub.json`, 'utf-8')) as StubConfig;
const args = process.argv.slice(2);
appendFileSync(config.invocationsFile, JSON.stringify({ argv: args }) + '\n');

if (config.delegate) {
  const result = spawnSync(config.delegate, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const response = config.responses?.[args[0] ?? ''] ?? config.fallback ?? {};
if (response.stdout) process.stdout.write(response.stdout);
process.exit(response.exitCode ?? 0);
