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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { errAsync, okAsync } from '@/core/result.ts';
import { ComputeEngineClient } from '@/core/server/compute-engine.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

type TaskResponse = { task: Record<string, unknown> };

/** Answers each request with the next response; the last one repeats. */
function clientReturning(...responses: Array<TaskResponse | Error>): ComputeEngineClient {
  let index = 0;
  const http = {
    get: () => {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response instanceof Error ? errAsync(response) : okAsync(response);
    },
  } as unknown as SonarHttpClient;
  return new ComputeEngineClient(http);
}

function task(overrides: Record<string, unknown> = {}): TaskResponse {
  return {
    task: {
      id: 'task-1',
      componentKey: 'proj',
      status: 'SUCCESS',
      analysisId: 'an-1',
      ...overrides,
    },
  };
}

const soon = () => Date.now() + 300;

async function failure(client: ComputeEngineClient, deadline = soon()): Promise<string> {
  const error = await client
    .waitForAnalysis('task-1', 'proj', deadline)
    .catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(CommandFailedError);
  return (error as CommandFailedError).message;
}

describe('ComputeEngineClient.waitForAnalysis', () => {
  it('resolves to the analysis id of a successful task', async () => {
    const analysisId = await clientReturning(task()).waitForAnalysis('task-1', 'proj', soon());

    expect(analysisId).toBe('an-1');
  });

  it('accepts a task that does not name its component', async () => {
    const response = task({ componentKey: undefined });

    expect(await clientReturning(response).waitForAnalysis('task-1', 'proj', soon())).toBe('an-1');
  });

  it.each(['PENDING', 'IN_PROGRESS'])('keeps waiting while the task is %s', async (status) => {
    const client = clientReturning(task({ status }), task());

    expect(await client.waitForAnalysis('task-1', 'proj', soon())).toBe('an-1');
  });

  it('tolerates one transient request failure', async () => {
    const client = clientReturning(new Error('502'), task());

    expect(await client.waitForAnalysis('task-1', 'proj', soon())).toBe('an-1');
  });

  it('reports a timeout when the task never finishes before the deadline', async () => {
    const message = await failure(
      clientReturning(task({ status: 'IN_PROGRESS' })),
      Date.now() + 50,
    );

    expect(message).toContain("Analysis 'task-1' is still being processed");
  });

  it('reports a timeout when requests keep failing until the deadline', async () => {
    const message = await failure(clientReturning(new Error('502')), Date.now() + 50);

    expect(message).toContain('still being processed');
  });

  it('fails with the server message when processing failed', async () => {
    const message = await failure(clientReturning(task({ status: 'FAILED', errorMessage: 'bad' })));

    expect(message).toBe('Analysis processing failed: bad');
  });

  it('names the task when a canceled task has no message', async () => {
    const message = await failure(clientReturning(task({ status: 'CANCELED' })));

    expect(message).toBe('Analysis processing canceled: task-1');
  });

  it('rejects a task with another id', async () => {
    const message = await failure(clientReturning(task({ id: 'other' })));

    expect(message).toBe('The analysis task does not match the project.');
  });

  it('rejects a task of another component', async () => {
    const message = await failure(clientReturning(task({ componentKey: 'other' })));

    expect(message).toBe('The analysis task does not match the project.');
  });

  it('rejects a successful task without an analysis id', async () => {
    const message = await failure(clientReturning(task({ analysisId: undefined })));

    expect(message).toBe('The completed analysis has no analysis ID.');
  });

  it('rejects an unknown status', async () => {
    const message = await failure(clientReturning(task({ status: 'SURPRISE' })));

    expect(message).toBe('The server returned an unknown analysis task status.');
  });
});
