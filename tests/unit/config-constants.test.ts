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

import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { APP_NAME, LOG_DIR, LOG_FILE } from '../../src/lib/config-constants';

describe('config-constants', () => {
  it('LOG_FILE should be inside LOG_DIR', () => {
    expect(LOG_FILE.startsWith(LOG_DIR)).toBe(true);
  });

  it('LOG_FILE should have the correct filename', () => {
    expect(LOG_FILE).toBe(join(LOG_DIR, `${APP_NAME}.log`));
  });
});
