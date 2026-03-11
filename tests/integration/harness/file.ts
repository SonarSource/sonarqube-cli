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

import { existsSync, readFileSync, statSync } from 'node:fs';

export class File {
  public readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  asJson(): any {
    return JSON.parse(readFileSync(this.path, 'utf-8'));
  }

  asText(): string {
    return readFileSync(this.path, 'utf-8');
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  get isExecutable(): boolean {
    const stats = statSync(this.path);
    return !!(stats.mode & 0o100);
  }
}
