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

// Test fixture compiled to a real executable via `bun build --compile` so
// Windows can spawn it as a PE binary. The text scripts we used to write at
// test time fail synchronously on Windows because the file is named `.exe`
// but contains shell/CMD source.
//
// Parameterized by env vars set per-test via the harness:
//   CAG_STUB_SENTINEL     — path to append one JSON line per non-version call
//   CAG_STUB_INIT_EXIT    — exit code returned for `tool …` subcommands (default 0).
//                           Name kept for backwards compatibility with harness builder
//                           callers; covers `tool integrate` and the legacy `init`
//                           subcommand alike.
//   CAG_STUB_SKILL_EXIT   — exit code returned for the legacy `skill` subcommand (default 0)
//   CAG_STUB_PRINT_SKILL_EXIT — exit code returned for `tool print-skill` (default 0)
//   CAG_STUB_STOP_ALL_EXIT — exit code returned for `tool stop --all` (default 0)
//   CAG_STUB_STDOUT_LINE  — a line emitted to stdout on non-`print-skill` calls
//   CAG_STUB_STDERR_LINE  — a line emitted to stderr on non-`print-skill` calls

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  // Match what verifyInstallation() expects (3- or 4-segment dotted version).
  console.log('sonar-context-augmentation 0.0.0-test');
  process.exit(0);
}

const sentinel = process.env.CAG_STUB_SENTINEL;
if (sentinel) {
  const contextEnv: Record<string, string> = {};
  copyEnvValue(contextEnv, 'SONAR_CONTEXT_ORGANIZATION');
  copyEnvValue(contextEnv, 'SONAR_CONTEXT_PROJECT');
  copyEnvValue(contextEnv, 'SONAR_CONTEXT_TOKEN');
  copyEnvValue(contextEnv, 'SONAR_CONTEXT_URL');
  copyEnvValue(contextEnv, 'SONAR_CONTEXT_INVOCATION_ID');

  const entry = JSON.stringify({
    argv: args,
    env: contextEnv,
  });
  appendFileSync(sentinel, entry + '\n');
}

const RADIX = 10;
if (args[0] === 'tool' && args[1] === 'print-skill') {
  const exitCode = Number.parseInt(process.env.CAG_STUB_PRINT_SKILL_EXIT ?? '0', RADIX);
  if (exitCode === 0) {
    const scaEnabledArg = args.find((arg) => arg.startsWith('--sca-enabled='));
    process.stdout.write(`# Generated CAG skill\n${scaEnabledArg ?? '--sca-enabled=false'}\n`);
  }
  process.exit(exitCode);
}

const stdoutLine = process.env.CAG_STUB_STDOUT_LINE;
const stderrLine = process.env.CAG_STUB_STDERR_LINE;
if (stdoutLine) process.stdout.write(stdoutLine + '\n');
if (stderrLine) process.stderr.write(stderrLine + '\n');

if (args[0] === 'tool' && args[1] === 'stop' && args[2] === '--all') {
  process.exit(Number.parseInt(process.env.CAG_STUB_STOP_ALL_EXIT ?? '0', RADIX));
}
if (args[0] === 'tool' || args[0] === 'init') {
  process.exit(Number.parseInt(process.env.CAG_STUB_INIT_EXIT ?? '0', RADIX));
}
if (args[0] === 'skill') {
  process.exit(Number.parseInt(process.env.CAG_STUB_SKILL_EXIT ?? '0', RADIX));
}
process.exit(0);

function copyEnvValue(target: Record<string, string>, key: string): void {
  const value = process.env[key];
  if (value !== undefined) {
    target[key] = value;
  }
}
