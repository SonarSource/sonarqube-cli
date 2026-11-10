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

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

if (process.argv[2] === 'info') process.exit(0);

const suffix = ':/etc/ssl/mcp/jvm-secrets.args:ro';
const mount = process.argv.find((arg) => arg.endsWith(suffix));
const path = mount?.slice(0, -suffix.length);
const text = path ? readFileSync(path, 'utf8') : '';

writeFileSync(
  process.env.MCP_TEST_RECORD!,
  JSON.stringify({
    path,
    matched:
      text.includes('-Dhttps.proxyUser=fixture-user') &&
      text.includes('-Dhttps.proxyPassword=fixture-password'),
    fileMode: path ? statSync(path).mode & 0o777 : 0,
    directoryMode: path ? statSync(dirname(path)).mode & 0o777 : 0,
    javaOpts: process.env.JAVA_OPTS,
    args: process.argv,
  }),
);
process.exit(Number(process.env.MCP_TEST_EXIT_CODE));
