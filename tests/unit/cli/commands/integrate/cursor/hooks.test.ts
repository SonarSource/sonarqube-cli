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
  buildCursorHookEntry,
  removeCursorHooks,
  resolveCursorHookMatcher,
  upsertCursorHooks,
} from '../../../../../../src/cli/commands/integrate/cursor/hooks';

const FAKE_CONTEXT = {
  targetRoot: '/project',
  scope: 'project' as const,
  attrs: {},
  state: {} as never,
  executionMode: 'install' as const,
  resolvedDependencies: new Map(),
};

describe('resolveCursorHookMatcher', () => {
  it('returns event-specific matchers documented by Cursor', () => {
    expect(resolveCursorHookMatcher('beforeReadFile')).toBe('Read|TabRead');
    expect(resolveCursorHookMatcher('preToolUse')).toBe('Read');
    expect(resolveCursorHookMatcher('beforeSubmitPrompt')).toBe('UserPromptSubmit');
    expect(resolveCursorHookMatcher('unknown')).toBe('.*');
  });
});

describe('upsertCursorHooks', () => {
  it('inserts an entry into an empty document', () => {
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );

    const result = upsertCursorHooks(null, [entry]);

    expect(result.version).toBe(1);
    expect(result.hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(result.hooks.beforeSubmitPrompt[0].matcher).toBe('UserPromptSubmit');
    expect(result.hooks.beforeSubmitPrompt[0].timeout).toBe(60);
    expect(result.hooks.beforeSubmitPrompt[0].failClosed).toBe(false);
    expect(result.hooks.beforeSubmitPrompt[0].command).toContain('sonar-secrets');
  });

  it('preserves unmanaged entries in the same event bucket', () => {
    const existing = {
      version: 1 as const,
      hooks: {
        beforeSubmitPrompt: [
          { command: '/usr/bin/other-tool', matcher: '*', timeout: 30, failClosed: false },
        ],
      },
    };
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );

    const result = upsertCursorHooks(existing, [entry]);

    expect(result.hooks.beforeSubmitPrompt).toHaveLength(2);
    expect(result.hooks.beforeSubmitPrompt.some((e) => e.command.includes('other-tool'))).toBe(
      true,
    );
    expect(result.hooks.beforeSubmitPrompt.some((e) => e.command.includes('sonar-secrets'))).toBe(
      true,
    );
  });

  it('replaces an existing sonar-secrets entry on re-install (idempotent)', () => {
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );
    const first = upsertCursorHooks(null, [entry]);
    const second = upsertCursorHooks(first, [entry]);

    expect(second.hooks.beforeSubmitPrompt).toHaveLength(1);
  });

  it('inserts entries for multiple event types', () => {
    const promptEntry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );
    const readEntry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeReadFile',
      'sonar-secrets/build-scripts/pretool-secrets',
    );

    const result = upsertCursorHooks(null, [promptEntry, readEntry]);

    expect(result.hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(result.hooks.beforeReadFile).toHaveLength(1);
  });

  it('preserves other top-level keys from the existing document', () => {
    const existing = { version: 1 as const, hooks: {}, extraKey: 'kept' };

    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );
    const result = upsertCursorHooks(existing, [entry]);

    expect((result as Record<string, unknown>).extraKey).toBe('kept');
  });

  it('treats a non-array event value as empty (hand-edited hooks.json)', () => {
    const existing = {
      version: 1 as const,
      hooks: { beforeSubmitPrompt: {} as never }, // hand-edited to an object
    };
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );

    const result = upsertCursorHooks(existing, [entry]);

    expect(Array.isArray(result.hooks.beforeSubmitPrompt)).toBe(true);
    expect(result.hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(result.hooks.beforeSubmitPrompt[0].command).toContain('sonar-secrets');
  });

  it('handles a non-object document gracefully', () => {
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );

    const resultFromNull = upsertCursorHooks(null, [entry]);
    const resultFromArray = upsertCursorHooks(['unexpected'], [entry]);

    expect(resultFromNull.version).toBe(1);
    expect(resultFromArray.version).toBe(1);
  });

  it('does not throw when existing entries have a missing or non-string command', () => {
    const malformed = {
      version: 1 as const,
      hooks: {
        beforeSubmitPrompt: [
          { matcher: '*', timeout: 30, failClosed: false }, // no command field
          { command: 42, matcher: '*', timeout: 30, failClosed: false }, // non-string command
        ] as never,
      },
    };
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );

    expect(() => upsertCursorHooks(malformed, [entry])).not.toThrow();
  });
});

describe('removeCursorHooks', () => {
  it('removes entries whose command contains the marker', () => {
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );
    const patched = upsertCursorHooks(null, [entry]);

    const result = removeCursorHooks(patched, ['sonar-secrets']);

    expect(result.hooks.beforeSubmitPrompt).toBeUndefined();
  });

  it('is a no-op for unrelated markers', () => {
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );
    const patched = upsertCursorHooks(null, [entry]);

    const result = removeCursorHooks(patched, ['other-tool']);

    expect(result.hooks.beforeSubmitPrompt).toHaveLength(1);
  });

  it('preserves unmanaged entries when removing sonar-secrets', () => {
    const existing = {
      version: 1 as const,
      hooks: {
        beforeSubmitPrompt: [
          { command: '/usr/bin/other-tool', matcher: '*', timeout: 30, failClosed: false },
          {
            command: '.cursor/hooks/sonar-secrets/prompt.sh',
            matcher: '*',
            timeout: 60,
            failClosed: false,
          },
        ],
      },
    };

    const result = removeCursorHooks(existing, ['sonar-secrets']);

    expect(result.hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(result.hooks.beforeSubmitPrompt?.[0].command).toContain('other-tool');
  });

  it('does not throw when existing entries have a missing or non-string command', () => {
    const malformed = {
      version: 1 as const,
      hooks: {
        beforeSubmitPrompt: [
          { matcher: '*', timeout: 30, failClosed: false }, // no command field
          { command: 42, matcher: '*', timeout: 30, failClosed: false }, // non-string command
        ] as never,
      },
    };

    expect(() => removeCursorHooks(malformed, ['sonar-secrets'])).not.toThrow();
  });

  it('removes entries across multiple event types', () => {
    const promptEntry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );
    const readEntry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeReadFile',
      'sonar-secrets/build-scripts/pretool-secrets',
    );
    const patched = upsertCursorHooks(null, [promptEntry, readEntry]);

    const result = removeCursorHooks(patched, ['sonar-secrets']);

    expect(result.hooks.beforeSubmitPrompt).toBeUndefined();
    expect(result.hooks.beforeReadFile).toBeUndefined();
  });
});

describe('buildCursorHookEntry', () => {
  it('uses a relative command path for project scope', () => {
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );

    expect(entry.entry.command).not.toMatch(/^[/\\]/);
    expect(entry.entry.command).toContain('.cursor');
  });

  it('uses an absolute command path for global scope', () => {
    const globalContext = { ...FAKE_CONTEXT, scope: 'global' as const };
    const entry = buildCursorHookEntry(
      globalContext,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );

    // On Windows the command is prefixed with 'powershell -NoProfile -ExecutionPolicy Bypass -File'; strip it before checking absoluteness.
    const commandPath = entry.entry.command.replace(
      /^powershell -NoProfile -ExecutionPolicy Bypass -File /,
      '',
    );
    // The path is quoted (single quotes on Unix, double quotes on Windows); allow a leading quote.
    expect(commandPath).toMatch(/^['"]?[/\\]/);
  });

  it('sets failClosed to false by default', () => {
    const entry = buildCursorHookEntry(
      FAKE_CONTEXT,
      '.cursor',
      'beforeSubmitPrompt',
      'sonar-secrets/build-scripts/prompt-secrets',
    );

    expect(entry.entry.failClosed).toBe(false);
  });
});
