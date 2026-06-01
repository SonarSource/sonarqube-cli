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

import type { VerificationExample } from '../../_common/registry';
import type { GitHookType } from '../options';

export const HOOK_MARKER = 'Sonar secrets scan - installed by sonar integrate git';
export const SONAR_HOOK_SKIP_SECRETS_MESSAGE = 'sonarqube-cli not found, skipping secrets scan';

export function resolveSonarHookCommand(hook: GitHookType): string {
  return hook === 'pre-commit' ? 'git-pre-commit' : 'git-pre-push';
}

const VERIFY_FILE_NAME = 'sonar-hook-verify.js';
const VERIFY_SECRET_CONTENT = 'const API_KEY = "sqp_b4556a16fa2d28519d2451a911d2e073024010bc";';

export function gitHookVerificationExample(hook: GitHookType): VerificationExample {
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
