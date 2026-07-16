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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../src/ui';
import { ImportProgress } from '../../../src/ui/components/import-progress.js';

const REPOS = ['my-org/api-gateway', 'my-org/auth-service', 'my-org/billing'];

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('ImportProgress — non-TTY', () => {
  it('writes nothing on start or during updates', () => {
    const progress = new ImportProgress({ repos: REPOS, isTTY: false });
    const start = captureStdout(() => progress.start());
    expect(start).toBe('');

    const update = captureStdout(() => progress.update(REPOS[0], 'running'));
    expect(update).toBe('');
  });

  it('finish() delegates to the static phase() summary', () => {
    const progress = new ImportProgress({ repos: REPOS, isTTY: false });
    progress.start();
    progress.update(REPOS[0], 'done', 'Project created', 'my-org_api-gateway');
    progress.update(REPOS[1], 'done', 'Project created', 'my-org_auth-service');
    progress.update(REPOS[2], 'failed', 'CI failed');

    const output = captureStdout(() => {
      const { succeeded, failed } = progress.finish();
      expect(succeeded).toBe(2);
      expect(failed).toBe(1);
    });

    expect(output).toContain('Import results');
    expect(output).toContain('my-org/api-gateway');
    expect(output).toContain('my-org/auth-service');
    expect(output).toContain('my-org/billing');
    expect(output).toContain('Project created');
    expect(output).toContain('CI failed');
  });

  it('a repo never updated stays out of the succeeded/failed counts', () => {
    const progress = new ImportProgress({ repos: REPOS, isTTY: false });
    let succeeded = 0;
    let failed = 0;
    captureStdout(() => {
      progress.start();
      progress.update(REPOS[0], 'done', 'Project created', 'key');
      ({ succeeded, failed } = progress.finish());
    });
    expect(succeeded).toBe(1);
    expect(failed).toBe(0);
  });
});

describe('ImportProgress — TTY', () => {
  it('renders one row per repo plus a progress bar, updating in place', () => {
    const progress = new ImportProgress({ repos: REPOS, isTTY: true });
    const start = captureStdout(() => progress.start());
    for (const repo of REPOS) {
      expect(start).toContain(repo.split('/')[1]);
    }
    expect(start).toContain('0%');
    expect(start).toContain('0/3');

    const afterOne = captureStdout(() =>
      progress.update(REPOS[0], 'done', 'Project created', 'my-org_api-gateway'),
    );
    expect(afterOne).toContain('Project created');
    expect(afterOne).toContain('my-org_api-gateway');
    expect(afterOne).toContain('33%');
    expect(afterOne).toContain('1/3');
  });

  it('shows at most maxVisible rows, promoting the next queued repo on completion', () => {
    const repos = ['org/repo-1', 'org/repo-2', 'org/repo-3', 'org/repo-4', 'org/repo-5'];
    const progress = new ImportProgress({ repos, isTTY: true, maxVisible: 3 });

    const start = captureStdout(() => progress.start());
    expect(start).toContain('repo-1');
    expect(start).toContain('repo-2');
    expect(start).toContain('repo-3');
    expect(start).not.toContain('repo-4');
    expect(start).not.toContain('repo-5');

    // repo-1 finishes → repo-4 (next queued) takes over its row.
    const afterFirst = captureStdout(() =>
      progress.update('org/repo-1', 'done', 'Project created'),
    );
    expect(afterFirst).not.toContain('repo-1');
    expect(afterFirst).toContain('repo-2');
    expect(afterFirst).toContain('repo-3');
    expect(afterFirst).toContain('repo-4');
    expect(afterFirst).not.toContain('repo-5');

    // repo-2 finishes → repo-5 takes over; the queue is now empty.
    const afterSecond = captureStdout(() => progress.update('org/repo-2', 'failed', 'CI failed'));
    expect(afterSecond).not.toContain('repo-2');
    expect(afterSecond).toContain('repo-5');

    // repo-3 finishes with nothing left to promote — its row stays, showing "done".
    const afterThird = captureStdout(() =>
      progress.update('org/repo-3', 'done', 'Project created'),
    );
    expect(afterThird).toContain('repo-3');
    expect(afterThird).toContain('repo-4');
    expect(afterThird).toContain('repo-5');
  });

  it('finish() renders the final state and a Result section', () => {
    const progress = new ImportProgress({ repos: REPOS, isTTY: true });
    captureStdout(() => {
      progress.start();
      progress.update(REPOS[0], 'done', 'Project created', 'my-org_api-gateway');
      progress.update(REPOS[1], 'done', 'Project created', 'my-org_auth-service');
      progress.update(REPOS[2], 'failed', 'CI failed');
    });

    const finish = captureStdout(() => progress.finish());
    expect(finish).toContain('100%');
    expect(finish).toContain('3/3');
    expect(finish).toContain('Result');
    expect(finish).toContain('Succeeded: 2');
    expect(finish).toContain('Failed: 1');
  });
});

describe('ImportProgress — mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => setMockUi(false));

  it('records method calls, writes nothing, and still tracks counts', () => {
    const progress = new ImportProgress({ repos: REPOS });

    const output = captureStdout(() => {
      progress.start();
      progress.update(REPOS[0], 'done', 'Project created', 'key-1');
      progress.update(REPOS[1], 'failed', 'CI failed');
    });
    const { succeeded, failed } = progress.finish();

    expect(output).toBe('');
    expect(succeeded).toBe(1);
    expect(failed).toBe(1);
    const methods = getMockUiCalls().map((c) => c.method);
    expect(methods).toContain('importProgress.start');
    expect(methods).toContain('importProgress.update');
    expect(methods).toContain('importProgress.finish');
  });
});
