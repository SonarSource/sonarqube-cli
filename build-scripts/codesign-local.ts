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

const BINARY = 'dist/sonarqube-cli';

if (process.platform !== 'darwin') {
  process.exit(0);
}

const teamId = process.env.APPLE_TEAM_ID;
if (!teamId) {
  // APPLE_TEAM_ID not set — skip code signing
  process.exit(0);
}

const SIGN_IDENTITY = `Developer ID Application: SonarSource SA (${teamId})`;

const findIdentity = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
  encoding: 'utf8',
});

if (!findIdentity.stdout.includes(teamId)) {
  // Developer ID certificate not installed locally — skip silently
  process.exit(0);
}

console.log(`Signing ${BINARY} with Developer ID Application: SonarSource SA...`);
const result = spawnSync(
  '/usr/bin/codesign',
  [
    '--sign',
    SIGN_IDENTITY,
    '--force',
    '--options',
    'runtime',
    '--entitlements',
    'build-scripts/entitlements.plist',
    BINARY,
  ],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
