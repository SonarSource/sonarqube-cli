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

import { renameSync, writeFileSync } from 'node:fs';

if (process.argv[2] === 'info') process.exit(0);

const record = process.env.MCP_TEST_RECORD!;
const suffix = ':/etc/ssl/mcp/jvm-secrets.args:ro';
const path = process.argv.find((arg) => arg.endsWith(suffix))?.slice(0, -suffix.length);

function recordAtomically(target: string, contents: string): void {
  writeFileSync(`${target}.tmp`, contents);
  renameSync(`${target}.tmp`, target);
}

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    recordAtomically(`${record}.signal`, signal);
    if (process.env.MCP_TEST_IGNORE_SIGNAL !== '1') process.exit(0);
  });
}

recordAtomically(
  record,
  JSON.stringify({ pid: process.pid, parentPid: process.ppid, path, ready: true }),
);
setInterval(() => undefined, 1000);
