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

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, spyOn } from 'bun:test';

import { CLI_TMP_DIR } from '@/core/config-constants.ts';
import { removeJvmSecretsFile, writeJvmSecretsFile } from '@/core/host/mcp/mcp-jvm-secrets.ts';

function files(): string[] {
  return fs.existsSync(CLI_TMP_DIR)
    ? fs
        .readdirSync(CLI_TMP_DIR)
        .filter((name) => name.startsWith(`mcp-jvm-secrets-${process.pid}-`))
    : [];
}

describe('MCP JVM configuration files', () => {
  it('does not write a file without credentials', () => {
    const before = files();
    expect(writeJvmSecretsFile([])).toBeUndefined();
    expect(files()).toEqual(before);
  });

  it('creates independent readable files inside a private directory', () => {
    const first = writeJvmSecretsFile(['-Dfixture=sample'])!;
    const second = writeJvmSecretsFile(['-Dfixture=sample'])!;
    try {
      expect(first).not.toBe(second);
      if (process.platform !== 'win32') {
        expect(fs.statSync(first).mode & 0o777).toBe(0o644);
        expect(fs.statSync(dirname(first)).mode & 0o777).toBe(0o700);
      }
      removeJvmSecretsFile(first);
      expect(fs.existsSync(second)).toBe(true);
    } finally {
      removeJvmSecretsFile(first);
      removeJvmSecretsFile(second);
    }
  });

  it.each(['\0', '\ud800', '\udc00'])('rejects unsupported characters before writing', (value) => {
    const before = files();
    expect(() => writeJvmSecretsFile([`-Dfixture=sample${value}`])).toThrow(
      'unsupported character',
    );
    expect(files()).toEqual(before);
  });

  it.each(['writeFileSync', 'fchmodSync'] as const)(
    'removes partial files on %s failure',
    (operation) => {
      const before = files();
      const spy = spyOn(fs, operation).mockImplementation(() => {
        throw new Error('synthetic failure');
      });
      try {
        expect(() => writeJvmSecretsFile(['-Dfixture=sample'])).toThrow('Could not prepare');
        expect(files()).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('removes only old copies with dead owners', () => {
    fs.mkdirSync(CLI_TMP_DIR, { recursive: true });
    const suffix = '00000000-0000-4000-8000-000000000000.args';
    const paths = [
      join(CLI_TMP_DIR, `mcp-jvm-secrets-2147483647-${suffix}`),
      join(CLI_TMP_DIR, `mcp-jvm-secrets-2147483646-${suffix}`),
      join(CLI_TMP_DIR, `mcp-jvm-secrets-${process.pid}-${suffix}`),
      join(CLI_TMP_DIR, 'unrelated.args'),
    ];
    for (const path of paths) fs.writeFileSync(path, 'fixture');
    const old = new Date(Date.now() - 16 * 60 * 1000);
    for (const path of [paths[0], paths[2], paths[3]]) fs.utimesSync(path, old, old);
    const owned = writeJvmSecretsFile(['-Dfixture=sample']);
    try {
      expect(paths.map((path) => fs.existsSync(path))).toEqual([false, true, true, true]);
    } finally {
      for (const path of paths) fs.rmSync(path, { force: true });
      removeJvmSecretsFile(owned);
    }
  });

  it.skipIf(Bun.which('java') === null)(
    'round trips JVM argument syntax through Java',
    () => {
      const values = [
        'space value',
        '#marker',
        'single\' double"',
        'back\\slash\\n',
        '日本語🙂',
        'tab\tvalue',
        'line\nvalue',
        'return\rvalue',
        'form\fvalue',
      ];
      const path = writeJvmSecretsFile(values.map((value, index) => `-Dfixture${index}=${value}`));
      const directory = fs.mkdtempSync(join(tmpdir(), 'mcp-java-'));
      const expected = values
        .map((value) => `"${Buffer.from(value).toString('base64')}"`)
        .join(',');
      fs.writeFileSync(
        join(directory, 'Probe.java'),
        `import java.util.Base64; import java.nio.charset.StandardCharsets; class Probe { public static void main(String[] args) { String[] values = {${expected}}; for (int i = 0; i < values.length; i++) if (!new String(Base64.getDecoder().decode(values[i]), StandardCharsets.UTF_8).equals(System.getProperty("fixture" + i))) throw new RuntimeException("Argument mismatch"); } }`,
      );
      try {
        const result = Bun.spawnSync(['java', `@${path}`, join(directory, 'Probe.java')]);
        expect(result.exitCode).toBe(0);
      } finally {
        removeJvmSecretsFile(path);
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    { timeout: 15000 },
  );
});
