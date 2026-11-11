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

import { beforeEach, describe, expect, it } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { applyAnalysisMigrations } from '@/core/vortex/deep-analysis/migrations.ts';

import { createDatabaseStub } from './helpers.ts';

function validSchemaMetadata() {
  return [
    [
      { name: 'agent', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'session_id', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'analysis_count', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ],
    [
      { name: 'fingerprint', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'analyzed_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ],
    [
      { name: 'fingerprint', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'lock_token', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'lock_expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'agent', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'session_id', type: 'TEXT', notnull: 1, pk: 0 },
    ],
  ];
}

describe('deep analysis database setup', () => {
  let fake: ReturnType<typeof createDatabaseStub>;
  beforeEach(() => {
    fake = createDatabaseStub();
  });

  function queueSchema(metadata = validSchemaMetadata()) {
    for (const columns of metadata) fake.all.mockReturnValueOnce(columns);
  }

  it('sets up a new database and saves its version', () => {
    fake.get.mockReturnValueOnce({ user_version: 0 }).mockReturnValueOnce({ count: 0 });
    queueSchema();
    applyAnalysisMigrations(fake.db);
    expect(fake.transaction).toHaveBeenCalledTimes(1);
    expect(fake.immediate).toHaveBeenCalledTimes(1);
    expect(fake.run.mock.calls.filter(([sql]) => sql.startsWith('CREATE TABLE'))).toHaveLength(3);
    expect(fake.run).toHaveBeenLastCalledWith('PRAGMA user_version = 1');
    expect(fake.all).toHaveBeenCalledTimes(3);
  });

  it('checks an existing database without changing its tables', () => {
    fake.get.mockReturnValue({ user_version: 1 });
    queueSchema(
      validSchemaMetadata().map((columns) =>
        columns.map((column) => ({ ...column, type: column.type.toLowerCase() })),
      ),
    );
    applyAnalysisMigrations(fake.db);
    expect(fake.run).not.toHaveBeenCalled();
    expect(fake.all).toHaveBeenCalledTimes(3);
  });

  it.each([-1, 2, null])('rejects unsupported or missing database versions: %s', (version) => {
    fake.get.mockReturnValue(version === null ? null : { user_version: version });
    expect(() => applyAnalysisMigrations(fake.db)).toThrow(CommandFailedError);
    expect(fake.run).not.toHaveBeenCalled();
    expect(fake.all).not.toHaveBeenCalled();
  });

  it('rejects a database with tables but no version', () => {
    fake.get.mockReturnValueOnce({ user_version: 0 }).mockReturnValueOnce({ count: 1 });
    expect(() => applyAnalysisMigrations(fake.db)).toThrow(CommandFailedError);
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each(['counter', 'successful', 'lock', 'primary-key', 'nullable'])(
    'rejects invalid table details: %s',
    (scenario) => {
      const schema = validSchemaMetadata();
      if (scenario === 'counter') schema[0] = [];
      if (scenario === 'successful') schema[1] = [];
      if (scenario === 'lock') schema[2] = [];
      if (scenario === 'primary-key') schema[0][0].pk = 0;
      if (scenario === 'nullable') schema[2][1].notnull = 0;
      fake.get.mockReturnValue({ user_version: 1 });
      queueSchema(schema);
      expect(() => applyAnalysisMigrations(fake.db)).toThrow(CommandFailedError);
      expect(fake.run).not.toHaveBeenCalled();
    },
  );

  it('does not save a new version when database setup fails', () => {
    const failure = new Error('DDL unavailable');
    fake.get.mockReturnValueOnce({ user_version: 0 }).mockReturnValueOnce({ count: 0 });
    fake.run.mockImplementation(() => {
      throw failure;
    });
    expect(() => applyAnalysisMigrations(fake.db)).toThrow(failure);
    expect(fake.run).toHaveBeenCalledTimes(1);
    expect(fake.all).not.toHaveBeenCalled();
  });
});
