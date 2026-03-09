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
import { File } from './file';

export class Dir {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  get path() {
    return this.baseDir;
  }

  dir(...paths: string[]): Dir {
    return new Dir(join(this.baseDir, ...paths));
  }

  file(...paths: string[]): File {
    return new File(join(this.baseDir, ...paths));
  }

  exists(...paths: string[]): boolean {
    return this.file(...paths).exists();
  }

  writeFile(relativePath: string, content: string) {
    mkdirSync(this.baseDir, { recursive: true });
    const fullPath = join(this.baseDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }
}
