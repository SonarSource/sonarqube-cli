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

import { afterEach, describe, expect, it } from 'bun:test';

import {
  GIT_PRE_PUSH_TRACE_ENV,
  GIT_PRE_PUSH_TRACE_PREFIX,
  isGitPrePushTraceEnabled,
  tracePrePush,
} from '@/commands/hook/git-pre-push-trace.ts';

describe('git-pre-push trace', () => {
  const previous = process.env[GIT_PRE_PUSH_TRACE_ENV];

  afterEach(() => {
    if (previous === undefined) delete process.env[GIT_PRE_PUSH_TRACE_ENV];
    else process.env[GIT_PRE_PUSH_TRACE_ENV] = previous;
  });

  it('is disabled unless SONAR_GIT_PRE_PUSH_TRACE is truthy', () => {
    delete process.env[GIT_PRE_PUSH_TRACE_ENV];
    expect(isGitPrePushTraceEnabled()).toBe(false);

    process.env[GIT_PRE_PUSH_TRACE_ENV] = '1';
    expect(isGitPrePushTraceEnabled()).toBe(true);

    process.env[GIT_PRE_PUSH_TRACE_ENV] = 'true';
    expect(isGitPrePushTraceEnabled()).toBe(true);

    process.env[GIT_PRE_PUSH_TRACE_ENV] = '0';
    expect(isGitPrePushTraceEnabled()).toBe(false);
  });

  it('writes prefixed lines to stderr when enabled', () => {
    process.env[GIT_PRE_PUSH_TRACE_ENV] = '1';
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    };

    try {
      tracePrePush('hello');
      expect(chunks.join('')).toContain(GIT_PRE_PUSH_TRACE_PREFIX);
      expect(chunks.join('')).toContain('hello');
    } finally {
      process.stderr.write = original;
    }
  });
});
