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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildContextAugmentationEnv } from '../../../../../src/cli/commands/_common/context-augmentation-env';

const KEYS = [
  'SONAR_CONTEXT_ORGANIZATION',
  'SONAR_CONTEXT_PROJECT',
  'SONAR_CONTEXT_TOKEN',
  'SONAR_CONTEXT_URL',
] as const;

describe('buildContextAugmentationEnv', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const key of KEYS) {
      process.env[key] = `inherited-${key}`;
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('passes the parent SONAR_CONTEXT_* env through unchanged when called with no argument', () => {
    const env = buildContextAugmentationEnv();

    for (const key of KEYS) {
      expect(env[key]).toBe(`inherited-${key}`);
    }
  });

  it('sets every SONAR_CONTEXT_* key when a fully-populated context is provided', () => {
    const env = buildContextAugmentationEnv({
      organization: 'my-org',
      projectKey: 'my-project',
      serverUrl: 'https://sonar.example',
      token: 'tok',
    });

    expect(env.SONAR_CONTEXT_ORGANIZATION).toBe('my-org');
    expect(env.SONAR_CONTEXT_PROJECT).toBe('my-project');
    expect(env.SONAR_CONTEXT_URL).toBe('https://sonar.example');
    expect(env.SONAR_CONTEXT_TOKEN).toBe('tok');
  });

  it('deletes each SONAR_CONTEXT_* key when its context field is undefined', () => {
    const env = buildContextAugmentationEnv({});

    for (const key of KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('deletes each SONAR_CONTEXT_* key when its context field is the empty string', () => {
    const env = buildContextAugmentationEnv({
      organization: '',
      projectKey: '',
      serverUrl: '',
      token: '',
    });

    for (const key of KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('mixes set and delete branches per-key without leaking inherited values for unset fields', () => {
    const env = buildContextAugmentationEnv({
      organization: 'my-org',
      // projectKey omitted → deleted
      serverUrl: '',
      // token omitted → deleted
    });

    expect(env.SONAR_CONTEXT_ORGANIZATION).toBe('my-org');
    expect(env.SONAR_CONTEXT_PROJECT).toBeUndefined();
    expect(env.SONAR_CONTEXT_URL).toBeUndefined();
    expect(env.SONAR_CONTEXT_TOKEN).toBeUndefined();
  });

  it('returns a copy — mutating the result does not affect process.env', () => {
    const env = buildContextAugmentationEnv({ organization: 'my-org' });
    env.SONAR_CONTEXT_ORGANIZATION = 'mutated';

    expect(process.env.SONAR_CONTEXT_ORGANIZATION).toBe('inherited-SONAR_CONTEXT_ORGANIZATION');
  });
});
