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

/**
 * Test helper that backs an in-memory filesystem for code reading the real disk via
 * `existsSync`, `statSync`, `realpathSync.native` (node:fs) and `readFile`, `readdir`
 * (node:fs/promises) — the exact primitives `canonicalizePath` (io/fs-utils.ts),
 * `findGitRoot` (host/git/discover.ts), and the sonar-project.properties/.sonarlint
 * readers (project-info.ts, host/sonarlint-connected-mode.ts) use. Build a tree with
 * `mkdir`/`writeFile` instead of touching the real disk.
 *
 * Call setup() in beforeEach and teardown() in afterEach.
 */

import * as fsModule from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname, sep } from 'node:path';

import { spyOn } from 'bun:test';

export interface FakeFsTestHandle {
  mkdir(path: string): void;
  writeFile(path: string, content: string): void;
  /** Removes `path` and everything nested under it (files and directories alike). */
  rm(path: string): void;
  setup(): void;
  teardown(): void;
}

function enoent(path: string, syscall: string): NodeJS.ErrnoException {
  const err = new Error(
    `ENOENT: no such file or directory, ${syscall} '${path}'`,
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

class FakeFs {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  private ancestorsOf(path: string): string[] {
    const out: string[] = [];
    let current = path;
    for (;;) {
      out.push(current);
      const parent = dirname(current);
      if (parent === current) {
        return out;
      }
      current = parent;
    }
  }

  mkdir(path: string): void {
    for (const ancestor of this.ancestorsOf(path)) {
      this.dirs.add(ancestor);
    }
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
    this.mkdir(dirname(path));
  }

  rm(path: string): void {
    const prefix = `${path}${sep}`;
    for (const file of [...this.files.keys()]) {
      if (file === path || file.startsWith(prefix)) {
        this.files.delete(file);
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === path || dir.startsWith(prefix)) {
        this.dirs.delete(dir);
      }
    }
  }

  exists(path: string): boolean {
    return this.dirs.has(path) || this.files.has(path);
  }

  isDirectory(path: string): boolean {
    return this.dirs.has(path);
  }

  readFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) {
      throw enoent(path, 'open');
    }
    return content;
  }

  readdir(path: string): string[] {
    if (!this.dirs.has(path)) {
      throw enoent(path, 'scandir');
    }
    const prefix = `${path}${sep}`;
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        names.add(file.slice(prefix.length).split(sep)[0]);
      }
    }
    for (const dir of this.dirs) {
      if (dir !== path && dir.startsWith(prefix)) {
        names.add(dir.slice(prefix.length).split(sep)[0]);
      }
    }
    return [...names];
  }
}

/**
 * Wraps a sync, possibly-throwing fn into the shape node:fs/promises functions need — an
 * `async` fn auto-converts a synchronous throw into a rejected promise, no manual catch needed.
 */
function asAsync<T>(fn: (path: fsModule.PathLike) => T): (path: fsModule.PathLike) => Promise<T> {
  return async (path) => await Promise.resolve(fn(path));
}

interface RestorableSpy {
  mockRestore(): void;
}

function installFakeFsSpies(vfs: FakeFs): RestorableSpy[] {
  return [
    spyOn(fsModule, 'existsSync').mockImplementation((path) => vfs.exists(String(path))),
    spyOn(fsModule, 'statSync').mockImplementation(
      ((path: fsModule.PathLike) =>
        ({
          isDirectory: () => vfs.isDirectory(String(path)),
          isFile: () => vfs.exists(String(path)) && !vfs.isDirectory(String(path)),
        }) as fsModule.Stats) as typeof fsModule.statSync,
    ),
    // Stays sync (unlike readFile/readdir below) — realpathSync.native must return a
    // string directly, not a Promise, so it can't go through asAsync.
    spyOn(fsModule.realpathSync, 'native').mockImplementation(((path: fsModule.PathLike) => {
      const p = String(path);
      if (!vfs.exists(p)) {
        throw enoent(p, 'lstat');
      }
      return p;
    }) as typeof fsModule.realpathSync.native),
    spyOn(fsPromises, 'readFile').mockImplementation(
      asAsync((path) => vfs.readFile(String(path))) as typeof fsPromises.readFile,
    ),
    spyOn(fsPromises, 'readdir').mockImplementation(
      asAsync((path) => vfs.readdir(String(path))) as typeof fsPromises.readdir,
    ),
  ];
}

export function createFakeFsTestHandle(): FakeFsTestHandle {
  let vfs: FakeFs;
  let spies: RestorableSpy[] = [];

  return {
    mkdir(path) {
      vfs.mkdir(path);
    },
    writeFile(path, content) {
      vfs.writeFile(path, content);
    },
    rm(path) {
      vfs.rm(path);
    },
    setup() {
      vfs = new FakeFs();
      spies = installFakeFsSpies(vfs);
    },
    teardown() {
      spies.forEach((spy) => spy.mockRestore());
    },
  };
}
