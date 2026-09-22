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

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import {
  applyMigrations,
  applyStatsMigrations,
  type StatsMigration,
} from '@/core/stats/migrations.ts';

function userVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('applyStatsMigrations', () => {
  it('brings a fresh database to the latest version and creates its tables', () => {
    const db = new Database(':memory:');

    applyStatsMigrations(db);

    expect(userVersion(db)).toBeGreaterThan(0);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(['rule_descriptions', 'seen_fingerprints', 'stats_events']);
  });

  it('is a no-op when the database is already at the latest version', () => {
    const db = new Database(':memory:');
    applyStatsMigrations(db);
    const versionAfterFirstRun = userVersion(db);

    expect(() => applyStatsMigrations(db)).not.toThrow();
    expect(userVersion(db)).toBe(versionAfterFirstRun);
  });

  it('preserves existing rows when re-applied, instead of wiping the database', () => {
    const db = new Database(':memory:');
    applyStatsMigrations(db);
    db.run(
      `INSERT INTO stats_events (timestamp_ms, event_class, caller_command, caller_agent, run_trigger, details)
       VALUES (1, 'analyzer', 'analyze', 'claude', 'manual', '{}')`,
    );

    applyStatsMigrations(db);

    const count = (
      db.prepare('SELECT COUNT(*) as count FROM stats_events').get() as { count: number }
    ).count;
    expect(count).toBe(1);
  });
});

describe('applyMigrations', () => {
  it('applies only the pending migrations, in ascending version order regardless of list order', () => {
    const db = new Database(':memory:');
    applyMigrations(db, [{ version: 1, up: () => {} }]);
    expect(userVersion(db)).toBe(1);

    const applied: number[] = [];
    const migrations: StatsMigration[] = [
      { version: 1, up: () => applied.push(1) },
      { version: 3, up: () => applied.push(3) },
      { version: 2, up: () => applied.push(2) },
    ];

    applyMigrations(db, migrations);

    expect(applied).toEqual([2, 3]);
    expect(userVersion(db)).toBe(3);
  });
});
