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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { assertScannerConfigurationSafe } from '@/commands/init/scan/scanner-config.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scanner-config-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function check(overrides = new Map<string, string>()) {
  return () => assertScannerConfigurationSafe(root, root, overrides);
}
function config(path: string, content: string) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

describe('scanner configuration boundary', () => {
  it('accepts ordinary analysis settings and missing configuration', () => {
    expect(check()).not.toThrow();
    config('sonar-project.properties', 'sonar.sources=src\nsonar.exclusions=build/**');
    expect(check()).not.toThrow();
  });
  it.each([
    'sonar.scanner.proxyHost=untrusted.invalid',
    'sonar.scanner.proxyPassword: dummy-password',
    'sonar.scanner.truststorePath=untrusted.p12',
    'sonar.scanner.truststorePassword=dummy-password',
    'sonar.scanner.keystorePath=untrusted.p12',
    'sonar.scanner.keystorePassword=dummy-password',
    'sonar.scanner.internal.dumpToFile=',
    'sonar.scanner.proxy\\u0048ost=untrusted.invalid',
    'sonar.scanner.truststore\\\n Path=untrusted.p12',
    'sonar.scanner.internal.dumpToFile dump.properties',
    'sonar.scanner.internal.dumpToFile',
    '# comment ending in a slash\\\nsonar.scanner.proxyHost=untrusted.invalid',
    'sonar.scanner.proxyPort=1234',
    'sonar.scanner.proxyUser=dummy-user',
  ])('refuses managed settings without exposing values: %s', (content) => {
    config('sonar-project.properties', content);
    expect(check()).toThrow(
      'Repository scanner proxy, TLS and diagnostic-dump settings are not allowed.',
    );
  });
  it('checks global scanner properties', () => {
    config('conf/sonar-scanner.properties', 'sonar.scanner.internal.dumpToFile=dump');
    expect(check()).toThrow();
  });
  it.each(['sonar', 'ordinary'])('checks module files for module %s', (id) => {
    config('sonar-project.properties', `sonar.modules=${id}`);
    config(
      `${id}/sonar-project.properties`,
      `${id === 'sonar' ? '' : 'sonar.'}scanner.proxyHost=untrusted.invalid`,
    );
    expect(check()).toThrow();
  });
  it('checks explicit module paths and nested modules', () => {
    config(
      'sonar-project.properties',
      'sonar.modules=a\na.sonar.projectConfigFile=config/a.properties',
    );
    config('config/a.properties', 'sonar.modules=b');
    config('config/b/sonar-project.properties', 'sonar.scanner.internal.dumpToFile=dump');
    expect(check()).toThrow();
  });
  it('checks module paths supplied through scanner properties', () => {
    config('elsewhere/sonar-project.properties', 'sonar.scanner.keystorePath=untrusted.p12');
    expect(
      check(
        new Map([
          ['sonar.modules', 'module'],
          ['module.sonar.projectBaseDir', 'elsewhere'],
        ]),
      ),
    ).toThrow();
  });
  it('preserves Java whitespace rules when locating module properties', () => {
    config('sonar-project.properties', 'sonar.modules=module\u00a0');
    config('module\u00a0/sonar-project.properties', 'sonar.scanner.proxyHost=untrusted.invalid');
    expect(check()).toThrow();
  });
  it('trims scanner-property module paths with Java whitespace rules', () => {
    config('module/sonar-project.properties', 'sonar.scanner.internal.dumpToFile=dump');
    expect(
      check(
        new Map([
          ['sonar.modules', 'a'],
          ['a.sonar.projectBaseDir', ' module '],
        ]),
      ),
    ).toThrow();
  });
  it('refuses cycles without recursing forever', () => {
    config('sonar-project.properties', 'sonar.modules=a\na.sonar.projectBaseDir=.');
    expect(check()).toThrow();
  });
});
