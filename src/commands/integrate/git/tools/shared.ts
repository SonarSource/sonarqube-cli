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

import { platform } from 'node:os';

import { CommandFailedError } from '@/core/command-error.ts';
import type {
  InstallDecision,
  IntegrationContext,
  PostInstallExample,
} from '@/core/framework/features';
import { askUser, install, isContainerIntegrationContext, skip } from '@/core/framework/features';

import { assertSafeSonarProjectKeyForHookScript, shellQuoteBash } from '../../_common/hooks.ts';
import type { GitHookType, IntegrateGitOptions } from '../options.ts';
import { PRE_COMMIT_DEP_RISKS_SUBFEATURE_ID } from './git-integration-subfeatures.ts';

export const LEGACY_HOOK_MARKER = 'Sonar secrets scan - installed by sonar integrate git';

export function resolveDepRisksArgs(
  context: IntegrationContext,
  { shellQuote = true }: { shellQuote?: boolean } = {},
): string {
  if (!isContainerIntegrationContext(context)) {
    throw new CommandFailedError('resolveDepRisksArgs requires a ContainerIntegrationContext');
  }
  if (!context.activeSubfeatures.some((s) => s.id === PRE_COMMIT_DEP_RISKS_SUBFEATURE_ID)) {
    return '';
  }
  const projectKey =
    typeof context.attrs?.projectKey === 'string' ? context.attrs.projectKey : undefined;
  if (!projectKey) {
    return '';
  }
  assertSafeSonarProjectKeyForHookScript(projectKey);
  return ` --dependency-risks -p ${shellQuote ? shellQuoteBash(projectKey) : projectKey}`;
}

export function shouldInstallHook(
  hook: GitHookType,
  options: IntegrateGitOptions,
): InstallDecision {
  if (options.hook !== undefined) {
    return options.hook === hook ? install() : skip();
  }
  return askUser();
}
export const SONAR_HOOK_SKIP_SECRETS_MESSAGE = 'sonarqube-cli not found, skipping secrets scan';

export function resolveSonarHookCommand(hook: GitHookType): string {
  return hook === 'pre-commit' ? 'git-pre-commit' : 'git-pre-push';
}

/** Normalize CRLF to LF so hook content comparisons are platform-independent. */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n');
}

const VERIFY_FILE_NAME = 'sonar-hook-verify.js';
const VERIFY_SECRET_CONTENT = 'const API_KEY = "sqp_b4556a16fa2d28519d2451a911d2e073024010bc";';

export function gitHookExample(hook: GitHookType): PostInstallExample {
  const deleteCommand = platform() === 'win32' ? 'del' : 'rm';
  const command = hook === 'pre-commit' ? 'git commit' : 'git push';
  return {
    title: `Verify the ${hook} hook works`,
    lines: [
      `To verify the ${hook} hook works:`,
      `  1. Create a file named ${VERIFY_FILE_NAME} containing:`,
      `       ${VERIFY_SECRET_CONTENT}`,
      hook === 'pre-commit'
        ? `  2. Stage it:      git add ${VERIFY_FILE_NAME}`
        : `  2. Commit it:     git add ${VERIFY_FILE_NAME} && git commit -m "verify"`,
      hook === 'pre-commit'
        ? '  3. Try to commit: git commit -m "verify"'
        : '  3. Try to push:   git push',
      `  4. The ${hook} hook should block the operation and report the secret.`,
      `  5. Delete the file: ${deleteCommand} ${VERIFY_FILE_NAME}`,
      `  To skip hooks when needed, run ${command} with the --no-verify flag.`,
    ],
  };
}

/**
 * Combined example shown when both git hooks are installed. Returns `undefined`
 * so the framework falls back to per-feature examples when only one is present.
 */
export function gitCombinedHookExample(
  installedFeatureIds: string[],
): PostInstallExample | undefined {
  const ids = new Set(installedFeatureIds);
  return ids.has('pre-commit-hook') && ids.has('pre-push-hook') ? gitBothHooksExample() : undefined;
}

function gitBothHooksExample(): PostInstallExample {
  const deleteCommand = platform() === 'win32' ? 'del' : 'rm';
  return {
    title: 'Verify the hooks work',
    lines: [
      `1. Create a file named ${VERIFY_FILE_NAME} containing:`,
      `     ${VERIFY_SECRET_CONTENT}`,
      '',
      '2. Pre-commit — stage and commit:',
      `     git add ${VERIFY_FILE_NAME}`,
      '     git commit -m "verify"',
      '   → the pre-commit hook should block and report the secret.',
      '',
      '3. Pre-push — bypass pre-commit, then push:',
      '     git commit -m "verify" --no-verify',
      '     git push',
      '   → the pre-push hook should block and report the secret.',
      '',
      `4. Clean up: ${deleteCommand} ${VERIFY_FILE_NAME}`,
      '',
      'To skip a hook: git commit --no-verify  /  git push --no-verify',
    ],
  };
}
