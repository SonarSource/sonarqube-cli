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

/** When set (1/true/yes), git-pre-push writes a verbose decision trail to stderr for debugging. */
export const GIT_PRE_PUSH_TRACE_ENV = 'SONAR_GIT_PRE_PUSH_TRACE';

export const GIT_PRE_PUSH_TRACE_PREFIX = '[sonar git-pre-push trace]';

const MAX_CAPTURE_CHARS = 8192;

export function isGitPrePushTraceEnabled(): boolean {
  const value = process.env[GIT_PRE_PUSH_TRACE_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function capPrePushTraceText(text: string): string {
  if (text.length <= MAX_CAPTURE_CHARS) return text;
  return `${text.slice(0, MAX_CAPTURE_CHARS)}… (truncated, ${text.length} chars total)`;
}

export function tracePrePush(message: string): void {
  if (!isGitPrePushTraceEnabled()) return;
  process.stderr.write(`${GIT_PRE_PUSH_TRACE_PREFIX} ${message}\n`);
}

function singleLineCapture(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '(empty)';
  return capPrePushTraceText(trimmed.replaceAll('\r\n', '\n').replaceAll('\n', String.raw`\n`));
}

export function tracePrePushGitSpawnResult(
  label: string,
  argv: string[],
  result: { exitCode: number | null; stdout: string; stderr: string },
): void {
  tracePrePush(`${label}: git ${argv.join(' ')}`);
  tracePrePush(`${label}: exit=${result.exitCode ?? 'null'}`);
  tracePrePush(`${label} stdout: ${singleLineCapture(result.stdout)}`);
  tracePrePush(`${label} stderr: ${singleLineCapture(result.stderr)}`);
}
