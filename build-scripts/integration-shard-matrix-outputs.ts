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
 * Reads `.github/integration-shards.yml` and appends GitHub Actions outputs for
 * Linux/Windows shard totals and [0..total-1] matrix JSON arrays.
 *
 * Usage (CI): bun build-scripts/integration-shard-matrix-outputs.ts
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_PATH = join(import.meta.dir, '../.github/integration-shards.yml');

function readTotal(configText: string, key: 'linux' | 'windows'): number {
  const pattern = key === 'linux' ? /^linux:\s*(\d+)\s*$/m : /^windows:\s*(\d+)\s*$/m;
  const match = pattern.exec(configText);
  if (!match) {
    throw new Error(`Missing or invalid "${key}:" in ${CONFIG_PATH}`);
  }
  const total = Number(match[1]);
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`"${key}" must be a positive integer in ${CONFIG_PATH}, got: ${match[1]}`);
  }
  return total;
}

function shardMatrix(total: number): number[] {
  return Array.from({ length: total }, (_, index) => index);
}

function writeGithubOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    throw new Error('GITHUB_OUTPUT is not set');
  }
  appendFileSync(outputFile, `${name}=${value}\n`);
}

const configText = readFileSync(CONFIG_PATH, 'utf8');
const linuxTotal = readTotal(configText, 'linux');
const windowsTotal = readTotal(configText, 'windows');

writeGithubOutput('linux_total', String(linuxTotal));
writeGithubOutput('linux_matrix', JSON.stringify(shardMatrix(linuxTotal)));
writeGithubOutput('windows_total', String(windowsTotal));
writeGithubOutput('windows_matrix', JSON.stringify(shardMatrix(windowsTotal)));
