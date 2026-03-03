/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Declarative builder for test file system fixtures

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class FileSystemBuilder {
  private readonly baseDir: string;
  private readonly files: Array<{ path: string; content: string }> = [];
  private readonly dirs: string[] = [];

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  withFile(relativePath: string, content: string): this {
    this.files.push({ path: relativePath, content });
    return this;
  }

  withDirectory(relativePath: string): this {
    this.dirs.push(relativePath);
    return this;
  }

  /**
   * Creates all configured directories and files under baseDir.
   * Returns the absolute path to the root directory.
   */
  build(): Promise<string> {
    mkdirSync(this.baseDir, { recursive: true });

    for (const dir of this.dirs) {
      mkdirSync(join(this.baseDir, dir), { recursive: true });
    }

    for (const file of this.files) {
      const fullPath = join(this.baseDir, file.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, 'utf-8');
    }

    return Promise.resolve(this.baseDir);
  }
}
