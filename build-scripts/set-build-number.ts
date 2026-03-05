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

// Appends a build number to the version in package.json and prints the result.
//
// Usage:
//   bun build-scripts/set-build-number.ts <build-number>
//
// Example:
//   bun build-scripts/set-build-number.ts 42
//   → updates package.json: "0.6.0" → "0.6.0.42"
//   → prints "0.6.0.42" to stdout

import { readFileSync, writeFileSync } from 'node:fs';

const buildNumber = process.argv[2];

if (!buildNumber) {
  console.error('Usage: bun build-scripts/set-build-number.ts <build-number>');
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
packageJson.version += `.${buildNumber}`;
writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');
console.log(packageJson.version);
