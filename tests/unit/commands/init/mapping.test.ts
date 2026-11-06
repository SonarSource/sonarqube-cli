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

import { describe, expect, it } from 'bun:test';

import { showAnalysisResults } from '@/commands/init/steps/mapping.ts';
import { errAsync, okAsync, type ResultAsync } from '@/core/result.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const NO_RESULTS = 'No analysis results on the server yet.';

function printed(console: FakeConsole): string[] {
  return console.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
}

async function show(response: ResultAsync<unknown, unknown>) {
  const console = new FakeConsole();
  const http = { getOrNullIf404: () => response } as unknown as SonarHttpClient;
  await showAnalysisResults(http, 'k', console, NO_RESULTS);
  return printed(console);
}

describe('showAnalysisResults', () => {
  it('reports a passed quality gate', async () => {
    const lines = await show(okAsync({ projectStatus: { status: 'OK' } }));

    expect(lines[0]).toContain('Quality gate: passed');
  });

  it('uses the caller note when the project has no analysis', async () => {
    expect(await show(okAsync(null))).toEqual([NO_RESULTS]);
  });

  it('does not report a failed lookup as missing results', async () => {
    const lines = await show(errAsync(new Error('403 Forbidden')));

    expect(lines).toEqual(['Could not fetch the analysis results.']);
  });
});
