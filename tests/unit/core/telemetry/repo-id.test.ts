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

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { hashRepoRoot } from '@/core/telemetry/repo-id.ts';

describe('hashRepoRoot()', () => {
  it('hashes the canonical repo root path with SHA-256', () => {
    const expected = createHash('sha256').update(canonicalizePath('/some/repo')).digest('hex');

    expect(hashRepoRoot('/some/repo')).toBe(expected);
  });

  it('is null outside a git repository', () => {
    expect(hashRepoRoot(null)).toBeNull();
  });
});
