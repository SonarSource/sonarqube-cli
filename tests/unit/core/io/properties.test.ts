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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { parseProperties, removeProperty, setProperty } from '@/core/io/properties.ts';

describe('parseProperties', () => {
  it('skips comments, blank lines and lines without a separator', () => {
    const properties = parseProperties('# comment\n\n  \nnot a property\nlog.level=DEBUG\n');

    expect([...properties]).toEqual([['log.level', 'DEBUG']]);
  });

  it('keeps the value literally after the first separator', () => {
    const properties = parseProperties(
      'network.proxy.https=http://host?a=b\n' + String.raw`network.tls.caCert=C:\certs\ca.pem`,
    );

    // '=' inside the value
    expect(properties.get('network.proxy.https')).toBe('http://host?a=b');
    // backslashes are not escapes
    expect(properties.get('network.tls.caCert')).toBe(String.raw`C:\certs\ca.pem`);
  });

  it('trims keys and values', () => {
    const properties = parseProperties('  log.level  =  DEBUG  \n');

    expect(properties.get('log.level')).toBe('DEBUG');
  });

  it('lets the last duplicate key win', () => {
    const properties = parseProperties('log.level=DEBUG\nlog.level=WARN\n');

    expect(properties.get('log.level')).toBe('WARN');
  });

  it('parses CRLF line endings', () => {
    const properties = parseProperties('log.level=DEBUG\r\ntelemetry.enabled=false\r\n');

    expect(Object.fromEntries(properties)).toEqual({
      'log.level': 'DEBUG',
      'telemetry.enabled': 'false',
    });
  });
});

describe('setProperty', () => {
  it('replaces the last line holding the key in place and keeps every other line', () => {
    const content = '# my settings\nlog.level=DEBUG\n# keep me\nlog.level=INFO\ncustom.key=1\n';

    const updated = setProperty(content, 'log.level', 'WARN');

    expect(updated).toBe(
      '# my settings\nlog.level=DEBUG\n# keep me\nlog.level=WARN\ncustom.key=1\n',
    );
    // the replaced duplicate is the one parsing reads
    expect(parseProperties(updated).get('log.level')).toBe('WARN');
  });

  it('keeps CRLF line endings when replacing and appending', () => {
    // replacing
    expect(setProperty('log.level=DEBUG\r\nother=1\r\n', 'log.level', 'WARN')).toBe(
      'log.level=WARN\r\nother=1\r\n',
    );
    // appending after a trailing line break
    expect(setProperty('other=1\r\n', 'log.level', 'WARN')).toBe('other=1\r\nlog.level=WARN\r\n');
    // appending without a trailing line break
    expect(setProperty('other=1\r\nmore=2', 'log.level', 'WARN')).toBe(
      'other=1\r\nmore=2\r\nlog.level=WARN\r\n',
    );
  });

  it('appends a missing key, adding a line break before it only when needed', () => {
    // trailing line break
    expect(setProperty('other=1\n', 'log.level', 'WARN')).toBe('other=1\nlog.level=WARN\n');
    // no trailing line break
    expect(setProperty('other=1', 'log.level', 'WARN')).toBe('other=1\nlog.level=WARN\n');
    // empty file
    expect(setProperty('', 'log.level', 'WARN')).toBe('log.level=WARN\n');
  });

  it('rejects a value containing a line break', () => {
    expect(() => setProperty('', 'log.level', 'DEBUG\nnetwork.proxy.https=http://secret')).toThrow(
      InvalidOptionError,
    );
    expect(() => setProperty('', 'log.level', 'DEBUG\r')).toThrow(InvalidOptionError);
  });
});

describe('removeProperty', () => {
  it('drops the line holding the key and keeps every other line', () => {
    const content = '# my settings\nlog.level=DEBUG\ncustom.key=1\n';

    expect(removeProperty(content, 'log.level')).toBe('# my settings\ncustom.key=1\n');
  });

  it('drops every duplicate of the key, not just the last', () => {
    const content = 'log.level=DEBUG\ncustom.key=1\nlog.level=WARN\n';

    const updated = removeProperty(content, 'log.level');

    expect(updated).toBe('custom.key=1\n');
    expect(parseProperties(updated).get('log.level')).toBeUndefined();
  });

  it('is a no-op when the key is absent', () => {
    const content = 'custom.key=1\n';

    expect(removeProperty(content, 'log.level')).toBe(content);
  });
});
