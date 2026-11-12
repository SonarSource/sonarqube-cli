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

import type { SearchResults } from '@/core/ui/console.ts';
import type { TreeNode, TreeSource } from '@/core/ui/tree/tree-source.ts';
import { type Scheduler, TreeViewModel } from '@/core/ui/tree/tree-view-model.ts';

const node = (label: string, extra: Partial<TreeNode<string>> = {}): TreeNode<string> => ({
  value: label,
  label,
  ...extra,
});

/** Runs a scheduled search only when the test says so. */
function manualScheduler(): { schedule: Scheduler; run: () => void } {
  let pending: (() => void) | undefined;
  return {
    schedule: (run) => {
      pending = run;
      return () => {
        pending = undefined;
      };
    },
    run: () => {
      const run = pending;
      pending = undefined;
      run?.();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function repository(overrides: Partial<TreeSource<string>> = {}): TreeSource<string> {
  return {
    roots: [node('.', { children: [node('services'), node('web', { leaf: true })] })],
    loadChildren: () => Promise.resolve([node('services/api')]),
    ...overrides,
  };
}

function create(source: TreeSource<string>, multiple = true, schedule?: Scheduler) {
  const errors: unknown[] = [];
  const vm = new TreeViewModel(source, {
    multiple,
    onError: (error) => errors.push(error),
    schedule,
  });
  return { vm, errors };
}

const labels = (vm: TreeViewModel<string>) =>
  vm.snapshot().entries.map((entry) => '  '.repeat(entry.depth) + entry.label);

const cursorLabel = (vm: TreeViewModel<string>) => {
  const snapshot = vm.snapshot();
  return snapshot.entries.at(snapshot.cursor)?.label;
};

describe('TreeViewModel tree navigation', () => {
  it('shows preloaded children expanded and starts on the first root', () => {
    const { vm } = create(repository());

    expect(labels(vm)).toEqual(['.', '  services', '  web']);
    expect(vm.snapshot().entries.map((entry) => entry.marker)).toEqual([
      'expanded',
      'collapsed',
      'leaf',
    ]);
    expect(cursorLabel(vm)).toBe('.');
  });

  it('keeps the cursor within the visible rows', () => {
    const { vm } = create(repository());

    vm.moveBy(-1);
    expect(cursorLabel(vm)).toBe('.');
    vm.moveBy(10);
    expect(cursorLabel(vm)).toBe('web');
  });

  it('loads children on the first expand, then shows them and notifies', async () => {
    const { vm } = create(repository());
    let changes = 0;
    vm.onChange(() => changes++);
    vm.moveBy(1);

    vm.expand();
    expect(vm.snapshot().entries[1].marker).toBe('loading');
    await flush();

    expect(changes).toBe(1);
    expect(labels(vm)).toEqual(['.', '  services', '    services/api', '  web']);
  });

  it('turns a row whose children turn out empty into a leaf', async () => {
    const { vm } = create(repository({ loadChildren: () => Promise.resolve([]) }));
    vm.moveBy(1);

    vm.expand();
    await flush();

    expect(vm.snapshot().entries[1].marker).toBe('leaf');
  });

  it('steps into an expanded row, then back out to its parent and collapses it', () => {
    const { vm } = create(repository());

    vm.expand();
    expect(cursorLabel(vm)).toBe('services');
    vm.collapse();
    expect(cursorLabel(vm)).toBe('.');
    vm.collapse();
    expect(labels(vm)).toEqual(['.']);
  });

  it('reports a failed load', async () => {
    const failure = new Error('unreadable');
    const { vm, errors } = create(repository({ loadChildren: () => Promise.reject(failure) }));
    vm.moveBy(1);

    vm.expand();
    await flush();

    expect(errors).toEqual([failure]);
  });
});

describe('TreeViewModel selection and submit', () => {
  it('ticks in tick order and submits the ticked values', () => {
    const { vm } = create(repository());
    vm.moveBy(2);
    vm.toggle();
    vm.moveBy(-2);
    vm.toggle();

    expect(vm.snapshot().chosen.map((choice) => choice.label)).toEqual(['web', '.']);
    expect(vm.submit()).toEqual({ submitted: ['web', '.'] });
  });

  it('refuses an empty multi-select submit until something is ticked', () => {
    const { vm } = create(repository());

    expect(vm.submit()).toEqual({ blocked: 'empty' });
    expect(vm.snapshot().refused).toBe(true);
    vm.toggle();
    expect(vm.snapshot().refused).toBe(false);
  });

  it('submits what the cursor is on in a single-select tree, without checkboxes', () => {
    const { vm } = create(repository(), false);
    vm.moveBy(1);
    vm.toggle();

    expect(vm.snapshot().entries.every((entry) => entry.checked === undefined)).toBe(true);
    expect(vm.submit()).toEqual({ submitted: ['services'] });
  });
});

describe('TreeViewModel search', () => {
  const found: SearchResults<string> = {
    options: [{ value: 'services/api', label: 'services/api' }],
    total: 1,
  };

  function searchable(search: TreeSource<string>['search']) {
    const scheduler = manualScheduler();
    const { vm } = create(repository({ search }), true, scheduler.schedule);
    return { vm, runScheduled: scheduler.run };
  }

  it('shows results once the debounced search lands, and the tree again when cleared', async () => {
    const { vm, runScheduled } = searchable(() => Promise.resolve(found));

    vm.setQuery('api');
    expect(vm.snapshot().search).toMatchObject({ loading: true, loaded: false });
    expect(vm.submit()).toEqual({ blocked: 'loading' });

    runScheduled();
    await flush();
    expect(vm.snapshot()).toMatchObject({
      searching: true,
      search: { query: 'api', shown: 1, total: 1, loading: false, loaded: true },
    });
    expect(vm.snapshot().entries[0]).toMatchObject({ label: 'services/api', highlight: 'api' });

    vm.setQuery('');
    expect(labels(vm)).toEqual(['.', '  services', '  web']);
  });

  it('keeps a value ticked in search results when back in the tree', async () => {
    const { vm, runScheduled } = searchable(() => Promise.resolve(found));

    vm.setQuery('api');
    runScheduled();
    await flush();
    vm.toggle();
    vm.setQuery('');

    expect(vm.snapshot().chosen).toEqual([{ value: 'services/api', label: 'services/api' }]);
  });

  it('drops a response that arrives after the query changed', async () => {
    let resolveFirst: (results: SearchResults<string>) => void = () => {};
    const queries: string[] = [];
    const { vm, runScheduled } = searchable((query) => {
      queries.push(query);
      if (query !== 'a') return Promise.resolve(found);
      return new Promise<SearchResults<string>>((resolve) => {
        resolveFirst = resolve;
      });
    });

    vm.setQuery('a');
    runScheduled();
    vm.setQuery('api');
    runScheduled();
    await flush();
    resolveFirst({ options: [{ value: 'stale', label: 'stale' }], total: 1 });
    await flush();

    expect(queries).toEqual(['a', 'api']);
    expect(vm.snapshot().entries.map((entry) => entry.label)).toEqual(['services/api']);
  });
});
