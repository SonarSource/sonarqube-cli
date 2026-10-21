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

// Integration tests for `sonar architecture install-skill`

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';

import { ARCHITECTURE_SKILL } from '@/commands/architecture/skill-content.ts';
import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';

import { TestHarness } from '../../harness';

const SKILL_PATHS = [
  join('.claude', 'skills', 'sonar-architecture', 'SKILL.md'),
  join('.agents', 'skills', 'sonar-architecture', 'SKILL.md'),
];

describe('sonar architecture install-skill', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ [ALPHA_ENV_VAR]: 'true' });
    const server = await harness.newFakeServer().asSonarCloud().withAuthToken('test-token').start();
    harness.withAuth(server.recordedAuthServerUrl(), 'test-token', 'my-org');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('requires authentication before installing any files', async () => {
    await harness.dispose();
    harness = await TestHarness.create();
    harness.withExtraEnv({ [ALPHA_ENV_VAR]: 'true' });
    const result = await harness.run('arch install-skill');
    expect(result.exitCode).not.toBe(0);
    expect(harness.cwd.exists(SKILL_PATHS[0])).toBe(false);
    expect(harness.cwd.exists(SKILL_PATHS[1])).toBe(false);
  });

  it(
    'installs the skill for authenticated users, and a re-run changes nothing',
    async () => {
      const first = await harness.run('arch install-skill');

      expect(first.exitCode).toBe(0);
      for (const path of SKILL_PATHS) {
        const content = readFileSync(join(harness.cwd.path, path), 'utf8');
        expect(content).toBe(ARCHITECTURE_SKILL);
        expect(content).toContain('name: sonar-architecture');
        expect(content).toContain('<!-- sonar:architecture-skill -->');
        expect(content).toContain('# Architecture data operations');
        const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
        expect(frontmatter).not.toBeNull();
        const metadata = load(frontmatter?.[1] ?? '') as { description: string };
        expect(metadata.description).toContain(
          'The write replaces the complete intended model; omitted content is removed.',
        );
        expect(content).toContain('Use the installed CLI help or the exposed MCP tool definitions');
        expect(content).toContain('Do not bypass those limits');
        expect(first.stdout).toContain(`Installed ${join(harness.cwd.path, path)}`);
      }

      const second = await harness.run('arch install-skill');
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain('Already up to date');
      expect(second.stdout).not.toContain('Installed');
    },
    { timeout: 15000 },
  );

  it(
    'refuses to overwrite a SKILL.md it did not write, unless --force',
    async () => {
      harness.cwd.writeFile(SKILL_PATHS[0], '# my own skill\n');

      const refused = await harness.run('architecture install-skill');
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('A different architecture skill already exists');
      expect(refused.stderr).toContain('--force');
      expect(readFileSync(join(harness.cwd.path, SKILL_PATHS[0]), 'utf8')).toBe('# my own skill\n');

      const forced = await harness.run('architecture install-skill --force');
      expect(forced.exitCode).toBe(0);
      expect(readFileSync(join(harness.cwd.path, SKILL_PATHS[0]), 'utf8')).toContain(
        'name: sonar-architecture',
      );
    },
    { timeout: 15000 },
  );

  it(
    'updates a previously managed skill without requiring force',
    async () => {
      for (const path of SKILL_PATHS) {
        harness.cwd.writeFile(path, '<!-- sonar:architecture-skill -->\n# Previous skill\n');
      }

      const result = await harness.run('arch install-skill');

      expect(result.exitCode).toBe(0);
      for (const path of SKILL_PATHS) {
        expect(readFileSync(join(harness.cwd.path, path), 'utf8')).toBe(ARCHITECTURE_SKILL);
      }
    },
    { timeout: 15000 },
  );

  it(
    '--global installs in the home directory',
    async () => {
      const result = await harness.run('architecture install-skill --global');

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.exists(SKILL_PATHS[0])).toBe(true);
      expect(harness.userHome.exists(SKILL_PATHS[1])).toBe(true);
      expect(harness.cwd.exists(SKILL_PATHS[0])).toBe(false);
    },
    { timeout: 15000 },
  );
});
