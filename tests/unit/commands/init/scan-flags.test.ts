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

import { describe, expect, it } from 'bun:test';

import { validateScanFlags, warnIgnoredScanFlags } from '@/commands/init/flags.ts';
import { parseScannerProperties } from '@/commands/init/scan/scanner-property.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

function warnings(console: FakeConsole): string {
  return console.calls
    .filter((call) => call.method === 'warn')
    .map((call) => String(call.args[0]))
    .join('\n');
}

describe('parseScannerProperties', () => {
  it('keeps the value after the first equals sign and lets the last duplicate win', () => {
    const properties = parseScannerProperties(['sonar.exclusions=a=b', 'sonar.exclusions=c']);
    expect(properties.get('sonar.exclusions')).toBe('c');
    expect(parseScannerProperties(['sonar.x=a=b']).get('sonar.x')).toBe('a=b');
  });

  it.each(['novalue', '=value', '1key=v', 'bad key=v', 'a$b=v'])('rejects %p', (entry) => {
    expect(() => parseScannerProperties([entry])).toThrow(InvalidOptionError);
  });

  it('rejects control characters without echoing the value', () => {
    const attempt = () => parseScannerProperties(['sonar.x=secret\nvalue']);
    expect(attempt).toThrow(InvalidOptionError);
    expect(attempt).not.toThrow(/secret/);
  });

  it.each(['sonar.token', 'sonar.host.url', 'sonar.projectKey', 'sonar.scanner.proxyPassword'])(
    'rejects the managed key %s',
    (key) => {
      expect(() => parseScannerProperties([`${key}=x`])).toThrow(/managed by 'sonar init'/);
    },
  );
});

describe('validateScanFlags', () => {
  it('rejects --detach together with --verbose', () => {
    expect(() => validateScanFlags({ detach: true, verbose: true })).toThrow(InvalidOptionError);
  });
});

describe('warnIgnoredScanFlags', () => {
  it('names the flags but never a property value', () => {
    const console = new FakeConsole();
    const flags = validateScanFlags({
      scannerProperty: ['sonar.password2=hunter2xyz'],
      detach: true,
    });
    warnIgnoredScanFlags(flags, console);
    const warning = warnings(console);
    expect(warning).toContain('--scanner-property, --detach');
    expect(warning).not.toContain('hunter2xyz');
  });

  it('stays silent when no scan-only flag was given', () => {
    const console = new FakeConsole();
    warnIgnoredScanFlags(validateScanFlags({ verbose: true }), console);
    expect(warnings(console)).toBe('');
  });
});
