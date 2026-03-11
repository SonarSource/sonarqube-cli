/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Unit tests for sonar integrate git

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { integrateGit } from '../../src/cli/commands/integrate/git';
import * as discovery from '../../src/cli/commands/_common/discovery';
import * as installSecrets from '../../src/cli/commands/install/secrets';
import {
  setMockUi,
  getMockUiCalls,
  clearMockUiCalls,
  queueMockResponse,
  clearMockResponses,
} from '../../src/ui';
import { CommandFailedError } from '../../src/cli/commands/_common/error';

const HOOK_MARKER = 'Sonar secrets scan - installed by sonar integrate git';

function createTempRepo(): string {
  const base = join(process.cwd(), 'tests', 'unit', '.integrate-git-repos');
  const root = join(base, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const hooksDir = join(root, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  return root;
}

const FAKE_PROJECT_INFO_NO_REPO = {
  root: '/some/cwd',
  name: 'cwd',
  isGitRepo: false,
  gitRemote: '',
  hasSonarProps: false,
  sonarPropsData: null,
  hasSonarLintConfig: false,
  sonarLintData: null,
};

describe('integrateGit: discovery', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    clearMockResponses();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('throws when not in a git repository', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(
      FAKE_PROJECT_INFO_NO_REPO,
    );

    try {
      try {
        await integrateGit({});
      } catch (e) {
        expect(e).toBeInstanceOf(CommandFailedError);
        expect((e as Error).message).toMatch(/No git repository found/);
        return;
      }
      expect.fail('integrateGit should have thrown');
    } finally {
      discoverSpy.mockRestore();
    }
  });
});

describe('integrateGit: interactive flow', () => {
  let discoverSpy: ReturnType<typeof spyOn>;
  let installSpy: ReturnType<typeof spyOn>;
  let repoRoot: string;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    clearMockResponses();
    repoRoot = createTempRepo();
    discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue({
      ...FAKE_PROJECT_INFO_NO_REPO,
      root: repoRoot,
      isGitRepo: true,
    });
    installSpy = spyOn(installSecrets, 'performSecretInstall').mockResolvedValue(
      join(repoRoot, 'fake', 'sonar-secrets'),
    );
  });

  afterEach(() => {
    discoverSpy?.mockRestore();
    installSpy?.mockRestore();
    setMockUi(false);
  });

  it('uses confirmPrompt and selectPrompt when interactive', async () => {
    queueMockResponse(true); // Install here?
    queueMockResponse('pre-commit'); // hook type (value for selectPrompt)

    await integrateGit({});

    const calls = getMockUiCalls();
    expect(calls.some((c) => c.method === 'confirmPrompt' && c.args[0] === 'Install here?')).toBe(
      true,
    );
    expect(
      calls.some(
        (c) =>
          c.method === 'selectPrompt' && c.args[0] === 'Install hook for pre-commit or pre-push?',
      ),
    ).toBe(true);
  });

  it('writes pre-commit hook script with marker and sonar analyze secrets', async () => {
    queueMockResponse(true);
    queueMockResponse('pre-commit');

    await integrateGit({});

    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit');
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, 'utf-8');
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain('analyze secrets');
    expect(content).toContain('git diff --cached --name-only --diff-filter=ACMR');
  });

  it('writes pre-push hook script when user selects pre-push', async () => {
    queueMockResponse(true);
    queueMockResponse('pre-push');

    await integrateGit({});

    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-push');
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, 'utf-8');
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain('analyze secrets');
    expect(content).toContain('while read -r local_ref local_sha remote_ref remote_sha');
  });
});

describe('integrateGit: non-interactive and --hook', () => {
  let discoverSpy: ReturnType<typeof spyOn>;
  let installSpy: ReturnType<typeof spyOn>;
  let repoRoot: string;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    clearMockResponses();
    repoRoot = createTempRepo();
    discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue({
      ...FAKE_PROJECT_INFO_NO_REPO,
      root: repoRoot,
      isGitRepo: true,
    });
    installSpy = spyOn(installSecrets, 'performSecretInstall').mockResolvedValue(
      join(repoRoot, 'fake', 'sonar-secrets'),
    );
  });

  afterEach(() => {
    discoverSpy?.mockRestore();
    installSpy?.mockRestore();
    setMockUi(false);
  });

  it('skips confirm and uses default pre-commit with --non-interactive', async () => {
    await integrateGit({ nonInteractive: true });

    const calls = getMockUiCalls();
    expect(calls.some((c) => c.method === 'confirmPrompt')).toBe(false);
    expect(calls.some((c) => c.method === 'selectPrompt')).toBe(false);
    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit');
    expect(existsSync(hookPath)).toBe(true);
  });

  it('uses --hook pre-push when provided', async () => {
    await integrateGit({ nonInteractive: true, hook: 'pre-push' });

    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-push');
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, 'utf-8');
    expect(content).toContain(HOOK_MARKER);
  });
});

describe('integrateGit: overwrite behavior', () => {
  let discoverSpy: ReturnType<typeof spyOn>;
  let installSpy: ReturnType<typeof spyOn>;
  let repoRoot: string;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    clearMockResponses();
    repoRoot = createTempRepo();
    discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue({
      ...FAKE_PROJECT_INFO_NO_REPO,
      root: repoRoot,
      isGitRepo: true,
    });
    installSpy = spyOn(installSecrets, 'performSecretInstall').mockResolvedValue(
      join(repoRoot, 'fake', 'sonar-secrets'),
    );
  });

  afterEach(() => {
    discoverSpy?.mockRestore();
    installSpy?.mockRestore();
    setMockUi(false);
  });

  it('refuses to overwrite existing hook without marker when --force is false', async () => {
    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "other hook"\n', { mode: 0o755 });

    let threw = false;
    try {
      await integrateGit({ nonInteractive: true });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(CommandFailedError);
      expect((e as Error).message).toMatch(/Use --force/);
    }
    expect(threw).toBe(true);

    const content = readFileSync(hookPath, 'utf-8');
    expect(content).toBe('#!/bin/sh\necho "other hook"\n');
  });

  it('overwrites existing hook without marker when --force is true', async () => {
    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "other hook"\n', { mode: 0o755 });

    await integrateGit({ nonInteractive: true, force: true });

    const content = readFileSync(hookPath, 'utf-8');
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain('analyze secrets');
  });

  it('overwrites existing hook with marker (idempotent reinstall)', async () => {
    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit');
    const ourContent = `#!/bin/sh\n# ${HOOK_MARKER}\nsonar analyze secrets -- "$@"\n`;
    writeFileSync(hookPath, ourContent, { mode: 0o755 });

    await integrateGit({ nonInteractive: true });

    const content = readFileSync(hookPath, 'utf-8');
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain('git diff --cached');
  });
});

describe('integrateGit: user cancels', () => {
  let discoverSpy: ReturnType<typeof spyOn>;
  let repoRoot: string;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    clearMockResponses();
    repoRoot = createTempRepo();
    discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue({
      ...FAKE_PROJECT_INFO_NO_REPO,
      root: repoRoot,
      isGitRepo: true,
    });
  });

  afterEach(() => {
    discoverSpy?.mockRestore();
    setMockUi(false);
  });

  it('returns without installing when user confirms No', async () => {
    queueMockResponse(false); // Install here? No

    await integrateGit({});

    const calls = getMockUiCalls();
    expect(calls.some((c) => c.method === 'text' && c.args[0] === 'Cancelled')).toBe(true);
  });
});
