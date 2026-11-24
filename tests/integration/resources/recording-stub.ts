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

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

interface StubResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

interface StubConfig {
  invocationsFile: string;
  captureEnv?: string[];
  delegate?: string;
  responses?: Record<string, StubResponse>;
  fallback?: StubResponse;
}

const config = JSON.parse(readFileSync(`${process.execPath}.stub.json`, 'utf-8')) as StubConfig;
const args = process.argv.slice(2);
const env =
  config.captureEnv && Object.fromEntries(config.captureEnv.map((key) => [key, process.env[key]]));
appendFileSync(config.invocationsFile, JSON.stringify({ argv: args, env }) + '\n');

if (config.delegate) {
  const result = spawnSync(config.delegate, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const response = config.responses?.[args[0] ?? ''] ?? config.fallback ?? {};
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.exitCode ?? 0);
