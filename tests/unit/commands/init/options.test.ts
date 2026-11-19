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

import {
  assertDryRunOptions,
  parseMonorepoRoots,
  validateIntentOptions,
  validateProjectKey,
  validateProjectName,
  validateVisibility,
  warnIgnoredIntent,
} from '@/commands/init/options.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('validation', () => {
  it('accepts a SonarQube key and trims it', () => {
    expect(validateProjectKey(' my_org:proj-1.x ')).toBe('my_org:proj-1.x');
  });

  it.each(['', '   ', '123', 'has space', 'slash/key', 'a'.repeat(401)])(
    'rejects the key %p',
    (key) => {
      expect(() => validateProjectKey(key)).toThrow(InvalidOptionError);
    },
  );

  it('rejects an empty name or one with control characters', () => {
    expect(validateProjectName('  My project ')).toBe('My project');
    expect(() => validateProjectName('  ')).toThrow(InvalidOptionError);
    expect(() => validateProjectName('bad\nname')).toThrow(InvalidOptionError);
    expect(() => validateProjectName('bad\nname')).toThrow(/^--name must be/);
    expect(() => validateProjectName('bad\nname', 'Project name')).toThrow(/^Project name must be/);
  });

  it('accepts only private or public', () => {
    expect(validateVisibility('public')).toBe('public');
    expect(() => validateVisibility('internal')).toThrow(InvalidOptionError);
  });
});

describe('parseMonorepoRoots', () => {
  it('reads each path and key, normalizing the path', () => {
    expect(parseMonorepoRoots(['services/api=api-key', './web/=web-key', '.=root-key'])).toEqual([
      { path: 'services/api', projectKey: 'api-key' },
      { path: 'web', projectKey: 'web-key' },
      { path: '.', projectKey: 'root-key' },
    ]);
  });

  it('leaves the key out of a root named by its path alone', () => {
    expect(parseMonorepoRoots(['web', './docs/'])).toEqual([
      { path: 'web', projectKey: undefined },
      { path: 'docs', projectKey: undefined },
    ]);
  });

  it('reads a "=" followed by a path separator as part of the path', () => {
    expect(parseMonorepoRoots(['a=b/c'])).toEqual([{ path: 'a=b/c', projectKey: undefined }]);
  });

  it('is empty when no root was named', () => {
    expect(parseMonorepoRoots(undefined)).toEqual([]);
  });

  it('splits at the last "=", as only a path may contain one', () => {
    expect(parseMonorepoRoots(['a=b/c=key'])).toEqual([{ path: 'a=b/c', projectKey: 'key' }]);
  });

  it.each([
    '=key',
    '  =key',
    '/abs/path=key',
    '../outside=key',
    'a/../../outside=key',
    'bad\npath=key',
  ])('rejects the malformed root %p', (root) => {
    expect(() => parseMonorepoRoots([root])).toThrow(InvalidOptionError);
  });

  it('rejects an invalid project key, naming the option', () => {
    expect(() => parseMonorepoRoots(['api=bad key'])).toThrow(/^--root key must contain only/);
    expect(() => parseMonorepoRoots(['api='])).toThrow(/^--root key must contain only/);
  });

  it('rejects a directory or a key named twice', () => {
    expect(() => parseMonorepoRoots(['api=one', './api=two'])).toThrow(/"api" more than once/);
    expect(() => parseMonorepoRoots(['api=one', 'web=one'])).toThrow(/'one' more than once/);
    expect(() => parseMonorepoRoots(['api', './api'])).toThrow(/"api" more than once/);
  });
});

describe('validateIntentOptions', () => {
  it('reads each intent option, and a bare --link as linking the project found', () => {
    expect(validateIntentOptions({})).toBeUndefined();
    expect(validateIntentOptions({ bind: true })).toEqual({ kind: 'bind' });
    expect(validateIntentOptions({ create: true })).toEqual({ kind: 'create' });
    expect(validateIntentOptions({ link: true })).toEqual({ kind: 'link' });
    expect(validateIntentOptions({ link: ' my-key ' })).toEqual({
      kind: 'link',
      projectKey: 'my-key',
    });
  });

  it('rejects an invalid --link key, naming the option', () => {
    expect(() => validateIntentOptions({ link: 'has space' })).toThrow(/^--link must contain/);
  });

  it('rejects more than one intent, naming each', () => {
    expect(() => validateIntentOptions({ link: true, bind: true, create: true })).toThrow(
      '--link, --bind, --create cannot be combined',
    );
  });

  it('rejects --link <key> with --monorepo, whose roots are named with --root', () => {
    expect(() => validateIntentOptions({ link: 'api-key', monorepo: true })).toThrow(
      '--link <key> does not apply with --monorepo',
    );
    expect(validateIntentOptions({ monorepo: true })).toBeUndefined();
  });

  it('accepts a bare --link, --bind or --create with --monorepo', () => {
    expect(validateIntentOptions({ bind: true, monorepo: true })).toEqual({ kind: 'bind' });
    expect(validateIntentOptions({ link: true, monorepo: true })).toEqual({ kind: 'link' });
    expect(validateIntentOptions({ create: true, monorepo: true })).toEqual({ kind: 'create' });
  });
});

describe('warnIgnoredIntent', () => {
  function warnings(console: FakeConsole): string[] {
    return console.calls
      .filter((call) => call.method === 'warn')
      .map((call) => String(call.args[0]));
  }

  it('says nothing without an intent', () => {
    const console = new FakeConsole();
    warnIgnoredIntent(undefined, console);
    expect(warnings(console)).toEqual([]);
  });

  it('names the ignored option, and how to relink to a named key', () => {
    const console = new FakeConsole();
    warnIgnoredIntent({ kind: 'create' }, console);
    warnIgnoredIntent({ kind: 'link', projectKey: 'other' }, console);
    expect(warnings(console)).toEqual([
      '--create ignored: this directory is already linked in .sonar-config.json.',
      "--link ignored: this directory is already linked in .sonar-config.json. To link it to 'other' instead, run 'sonar link other'.",
    ]);
  });
});

describe('assertDryRunOptions', () => {
  const none = {
    scannerProperties: new Map<string, string>(),
    verbose: false,
    detach: false,
    scan: false,
  };

  it('accepts a run without first-analysis options', () => {
    expect(() => assertDryRunOptions(none)).not.toThrow();
  });

  it('names each first-analysis option given, never a property value', () => {
    const flags = {
      ...none,
      scan: true,
      scannerProperties: new Map([['sonar.exclusions', 'secret']]),
    };

    expect(() => assertDryRunOptions(flags)).toThrow(InvalidOptionError);
    expect(() => assertDryRunOptions(flags)).toThrow(
      '--scan, --scanner-property cannot be combined with --dry-run',
    );
    expect(() => assertDryRunOptions(flags)).not.toThrow('secret');
  });
});
