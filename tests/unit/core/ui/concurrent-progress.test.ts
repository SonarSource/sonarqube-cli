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

import { ImportProgress } from '@/commands/import/import-progress.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';
import { ConcurrentProgress } from '@/core/ui/components/concurrent-progress.ts';

const ITEMS = ['alpha', 'beta', 'gamma'];
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

function newBaseProgress(items: string[], opts: { isTTY?: boolean; maxVisible?: number } = {}) {
  const progress = new ConcurrentProgress({ ...opts, resultTitle: 'Results' });
  progress.setTotal(items.length);
  progress.addItems(items);
  return progress;
}

function newImportProgress(repos: string[], opts: { isTTY?: boolean; maxVisible?: number } = {}) {
  const progress = new ImportProgress(opts);
  progress.setTotal(repos.length);
  progress.addRepos(repos);
  return progress;
}

describe('ConcurrentProgress — non-TTY', () => {
  it('writes nothing on start or during updates', () => {
    const progress = newBaseProgress(ITEMS, { isTTY: false });
    expect(captureStdout(() => progress.start())).toBe('');
    expect(captureStdout(() => progress.update(ITEMS[0], 'running'))).toBe('');
  });

  it('finish() delegates to the static phase() summary', () => {
    const progress = newBaseProgress(ITEMS, { isTTY: false });
    progress.start();
    progress.update(ITEMS[0], 'done', 'OK');
    progress.update(ITEMS[1], 'done', 'OK');
    progress.update(ITEMS[2], 'failed', 'Error');

    const output = captureStdout(() => {
      const { succeeded, failed } = progress.finish();
      expect(succeeded).toBe(2);
      expect(failed).toBe(1);
    });

    expect(output).toContain('Results');
    expect(output).toContain('alpha');
    expect(output).toContain('beta');
    expect(output).toContain('gamma');
    expect(output).toContain('OK');
    expect(output).toContain('Error');
  });

  it('an item never updated stays out of the succeeded/failed counts', () => {
    const progress = newBaseProgress(ITEMS, { isTTY: false });
    let succeeded = 0;
    let failed = 0;
    captureStdout(() => {
      progress.start();
      progress.update(ITEMS[0], 'done', 'OK');
      ({ succeeded, failed } = progress.finish());
    });
    expect(succeeded).toBe(1);
    expect(failed).toBe(0);
  });
});

describe('ConcurrentProgress — TTY', () => {
  it('renders one row per item plus a progress bar, updating in place', () => {
    const progress = newBaseProgress(ITEMS, { isTTY: true });
    const start = captureStdout(() => progress.start());
    for (const item of ITEMS) {
      expect(start).toContain(item);
    }
    expect(start).toContain('0%');
    expect(start).toContain('0/3');

    const afterOne = captureStdout(() => progress.update(ITEMS[0], 'done', 'OK', 'ref-alpha'));
    expect(afterOne).toContain('OK');
    expect(afterOne).toContain('ref-alpha');
    expect(afterOne).toContain('33%');
    expect(afterOne).toContain('1/3');
  });

  it('shows at most maxVisible rows, promoting the next queued item on completion', () => {
    const items = ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'];
    const progress = newBaseProgress(items, { isTTY: true, maxVisible: 3 });

    const start = captureStdout(() => progress.start());
    expect(start).toContain('item-1');
    expect(start).toContain('item-2');
    expect(start).toContain('item-3');
    expect(start).not.toContain('item-4');
    expect(start).not.toContain('item-5');

    const afterFirst = captureStdout(() => progress.update('item-1', 'done', 'OK'));
    expect(afterFirst).not.toContain('item-1');
    expect(afterFirst).toContain('item-2');
    expect(afterFirst).toContain('item-3');
    expect(afterFirst).toContain('item-4');
    expect(afterFirst).not.toContain('item-5');

    const afterSecond = captureStdout(() => progress.update('item-2', 'failed', 'Error'));
    expect(afterSecond).not.toContain('item-2');
    expect(afterSecond).toContain('item-5');

    const afterThird = captureStdout(() => progress.update('item-3', 'done', 'OK'));
    expect(afterThird).toContain('item-3');
    expect(afterThird).toContain('item-4');
    expect(afterThird).toContain('item-5');
  });

  it('finish() renders the final state and a Result section', () => {
    const progress = newBaseProgress(ITEMS, { isTTY: true });
    captureStdout(() => {
      progress.start();
      progress.update(ITEMS[0], 'done', 'OK');
      progress.update(ITEMS[1], 'done', 'OK');
      progress.update(ITEMS[2], 'failed', 'Error');
    });

    const finish = captureStdout(() => progress.finish());
    expect(finish).toContain('100%');
    expect(finish).toContain('3/3');
    expect(finish).toContain('Results');
    expect(finish).toContain('Succeeded: 2');
    expect(finish).toContain('Failed: 1');
  });
});

describe('ConcurrentProgress — mock mode options', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => setMockUi(false));

  it('uses default concurrentProgress mock prefix', () => {
    const progress = new ConcurrentProgress({});
    progress.setTotal(1);
    progress.addItems(['item']);
    progress.start();
    progress.update('item', 'done');
    progress.finish();
    const methods = getMockUiCalls().map((c) => c.method);
    expect(methods).toContain('concurrentProgress.start');
    expect(methods).toContain('concurrentProgress.update');
    expect(methods).toContain('concurrentProgress.finish');
  });

  it('showResult: false suppresses the result block on finish', () => {
    const progress = new ConcurrentProgress({ isTTY: false, showResult: false });
    progress.setTotal(1);
    progress.addItems(['item']);
    progress.start();
    progress.update('item', 'done');
    setMockUi(false);
    const output = captureStdout(() => progress.finish());
    expect(output).not.toContain('Succeeded');
    expect(output).not.toContain('Result');
  });

  it('resultTitle appears in TTY result header', () => {
    const progress = new ConcurrentProgress({ isTTY: true, resultTitle: 'My Results' });
    progress.setTotal(1);
    progress.addItems(['item']);
    progress.start();
    progress.update('item', 'done');
    setMockUi(false);
    const output = captureStdout(() => progress.finish());
    expect(output).toContain('My Results');
  });
});

describe('ImportProgress — TTY', () => {
  it('setTotal fixes the bar denominator independently of addRepos, for a streaming job', () => {
    const progress = new ImportProgress({ isTTY: true });
    progress.setTotal(5);

    const start = captureStdout(() => progress.start());
    expect(start).toContain('0/5');

    const afterPage1 = captureStdout(() => {
      progress.addRepos(['org/repo-1', 'org/repo-2']);
      progress.update('org/repo-1', 'done', 'Project created');
      progress.update('org/repo-2', 'done', 'Project created');
    });
    expect(afterPage1).toContain('40%');
    expect(afterPage1).toContain('2/5');

    const afterPage2 = captureStdout(() =>
      progress.addRepos(['org/repo-3', 'org/repo-4', 'org/repo-5']),
    );
    expect(afterPage2).toContain('repo-3');
    expect(afterPage2).toContain('repo-4');
    expect(afterPage2).toContain('repo-5');
  });

  it('a later page takes over rows already finished by an earlier page, instead of stalling in the queue', () => {
    const progress = new ImportProgress({ isTTY: true, maxVisible: 2 });
    progress.setTotal(4);
    progress.start();

    captureStdout(() => {
      progress.addRepos(['org/repo-1', 'org/repo-2']);
      progress.update('org/repo-1', 'done', 'Project created');
      progress.update('org/repo-2', 'done', 'Project created');
    });

    const afterPage2 = captureStdout(() => progress.addRepos(['org/repo-3', 'org/repo-4']));
    expect(afterPage2).toContain('repo-3');
    expect(afterPage2).toContain('repo-4');
    expect(afterPage2).not.toContain('repo-1');
    expect(afterPage2).not.toContain('repo-2');
    expect(afterPage2).not.toContain('Project created');

    const afterThird = captureStdout(() =>
      progress.update('org/repo-3', 'done', 'Project created'),
    );
    expect(afterThird).toContain('Project created');
  });

  it('recordSkipped advances the bar without adding a row', () => {
    const progress = new ImportProgress({ isTTY: true });
    progress.setTotal(3);
    progress.start();

    const afterSkip = captureStdout(() => progress.recordSkipped(2));
    expect(afterSkip).toContain('67%');
    expect(afterSkip).toContain('2/3');
    expect(afterSkip).not.toContain('repo');

    const afterAdd = captureStdout(() => {
      progress.addRepos(['org/only-eligible-repo']);
      progress.update('org/only-eligible-repo', 'done', 'Project created');
    });
    expect(afterAdd).toContain('100%');
    expect(afterAdd).toContain('3/3');
  });
});

describe('ImportProgress — formatLabel', () => {
  it('dims the org/ prefix and bolds the repo name', () => {
    const progress = newImportProgress(['my-org/api-gateway'], { isTTY: true });
    const output = captureStdout(() => progress.start());
    expect(output).toContain('my-org/');
    expect(output).toContain('api-gateway');
  });

  it('bolds the whole slug when there is no slash', () => {
    const progress = newImportProgress(['standalone'], { isTTY: true });
    const output = captureStdout(() => progress.start());
    expect(output).toContain('standalone');
  });
});

describe('ImportProgress — mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => setMockUi(false));

  it('records method calls with importProgress prefix, writes nothing, and tracks counts', () => {
    const progress = newImportProgress(REPOS);

    const output = captureStdout(() => {
      progress.start();
      progress.update(REPOS[0], 'done', 'Project created', 'key-1');
      progress.update(REPOS[1], 'failed', 'CI failed');
      progress.recordSkipped(1);
    });
    const { succeeded, failed } = progress.finish();

    expect(output).toBe('');
    expect(succeeded).toBe(1);
    expect(failed).toBe(1);
    const methods = getMockUiCalls().map((c) => c.method);
    expect(methods).toContain('importProgress.addRepos');
    expect(methods).toContain('importProgress.start');
    expect(methods).toContain('importProgress.update');
    expect(methods).toContain('importProgress.recordSkipped');
    expect(methods).toContain('importProgress.finish');
  });
});
