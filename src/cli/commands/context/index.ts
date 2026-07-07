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

import { spawn } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';

import { resolveAuth, type ResolvedAuth } from '../../../lib/auth-resolver';
import { SONAR_CONTEXT_INVOCATION } from '../../../lib/config-constants';
import { canonicalizePath, pathCompareKey } from '../../../lib/fs-utils';
import { getToken } from '../../../lib/keychain';
import logger from '../../../lib/logger';
import {
  resolveContextWorkspaceRoot,
  resolveWorktreeEquivalentPaths,
} from '../../../lib/project-workspace/git-worktree';
import type { InstalledIntegrationFeature, IntegrationStateAttribute } from '../../../lib/state';
import { loadState } from '../../../lib/state-manager';
import { buildContextAugmentationEnv } from '../_common/context-augmentation-env';
import { CommandFailedError } from '../_common/error';
import { resolveContextAugmentationBinaryPath } from '../_common/install/context-augmentation';
import { CONTEXT_AUGMENTATION_FEATURE_ID } from '../integrate/_common/features/context-augmentation-feature';

// Commander may assign --help/-h to the optional [action] positional on some platforms.
function buildForwardedArgs(
  action: string | undefined,
  args: string[],
): { forwarded: string[]; isHelp: boolean } {
  let forwarded: string[];
  if (action) {
    forwarded = [action, ...args];
  } else if (args.length > 0) {
    forwarded = args;
  } else {
    forwarded = ['--help'];
  }
  const isHelp = forwarded[0] === '--help' || forwarded[0] === '-h';
  return { forwarded, isHelp };
}

/**
 * Derive the telemetry subcommand for a `sonar context` passthrough invocation.
 * Records `help` for --help/-h, leading positional tokens up to the first flag
 * for normal actions (e.g. `tool stop` for `tool stop --all`), and null for bare
 * `sonar context`. Whitespace inside or between tokens is collapsed to a single
 * space so quoting quirks don't create separate telemetry buckets. Option values
 * are intentionally never captured.
 */
export function derivePassthroughSubcommand(
  action: string | undefined,
  args: string[],
): string | null {
  const all = action ? [action, ...args] : args;
  if (all.length === 0) return null;
  if (all[0] === '--help' || all[0] === '-h') return 'help';
  const positionals: string[] = [];
  for (const token of all) {
    if (token.startsWith('-')) break;
    for (const word of token.split(/\s+/)) {
      if (word.length > 0) positionals.push(word);
    }
  }
  return positionals.length > 0 ? positionals.join(' ') : null;
}

interface RecordedContextAugmentationConfig {
  organization?: string;
  projectKey?: string;
  serverUrl?: string;
  /** Git working tree root containing the current invocation; set only when a recorded integration matched. */
  workspaceDir?: string;
}

/** Case-insensitive path key for matching recorded integration roots on Windows. */
function comparePath(path: string): string {
  return pathCompareKey(path);
}

function isPathInside(parent: string, child: string): boolean {
  if (pathCompareKey(child) === pathCompareKey(parent)) {
    return true;
  }
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isProjectContextAugmentationFeature(feature: InstalledIntegrationFeature): boolean {
  // Global CAG installs are skipped, so only project-scoped feature entries
  // can provide passthrough context.
  return feature.featureId === CONTEXT_AUGMENTATION_FEATURE_ID && feature.scope === 'project';
}

function getOptionalStringAttr(
  attrs: Record<string, IntegrationStateAttribute> | undefined,
  key: string,
): string | undefined {
  const value = attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function resolveRecordedContextAugmentationConfig(
  cwd: string,
): Promise<RecordedContextAugmentationConfig> {
  try {
    // Consult cwd, then its equivalent in the main working tree, so a linked
    // worktree still matches state recorded in the main checkout.
    const candidates = (await resolveWorktreeEquivalentPaths(cwd)).map(comparePath);
    const matches = loadState()
      .integrations.installed.flatMap((integration) =>
        integration.features.filter(isProjectContextAugmentationFeature).map((feature) => ({
          feature,
          // Prefer the stable main-working-tree key recorded at integrate time;
          // fall back to targetRoot for state written by older CLI versions.
          projectRoot: comparePath(
            getOptionalStringAttr(feature.attrs, 'repoRoot') ?? feature.targetRoot,
          ),
        })),
      )
      .filter(({ projectRoot }) => candidates.some((path) => isPathInside(projectRoot, path)))
      .sort(
        (a, b) =>
          b.projectRoot.length - a.projectRoot.length ||
          getUpdatedAtTimestamp(b.feature) - getUpdatedAtTimestamp(a.feature),
      );
    const match = matches.at(0)?.feature;
    if (!match) {
      return {};
    }
    return {
      organization: getOptionalStringAttr(match.attrs, 'orgKey'),
      projectKey: getOptionalStringAttr(match.attrs, 'projectKey'),
      serverUrl: getOptionalStringAttr(match.attrs, 'serverUrl'),
      // CAG daemon folder: git working-tree root (climbs up from subdirs), or the
      // physical integrate targetRoot outside a git repo. Project metadata above
      // comes from recorded state matched via repoRoot / targetRoot.
      workspaceDir: canonicalizePath(await resolveContextWorkspaceRoot(cwd, match.targetRoot)),
    };
  } catch (err) {
    logger.debug(
      `Failed to resolve recorded context augmentation config: ${(err as Error).message}`,
    );
    return {};
  }
}

function getUpdatedAtTimestamp(feature: InstalledIntegrationFeature): number {
  const timestamp = Date.parse(feature.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

async function resolveContextToken(
  auth: ResolvedAuth,
  serverUrl: string,
  organization: string | undefined,
): Promise<string> {
  if (auth.serverUrl === serverUrl && auth.orgKey === organization) {
    return auth.token;
  }

  const token = await getToken(serverUrl, organization);
  if (token) {
    return token;
  }

  const connection = organization ? `${serverUrl} (${organization})` : serverUrl;
  throw new CommandFailedError(
    `Not authenticated for the recorded Vortex context augmentation connection: ${connection}.`,
    {
      remediationHint:
        'Run: sonar auth login, then re-run sonar integrate claude or sonar integrate copilot from this project.',
    },
  );
}

export async function runContextPassthrough(
  action: string | undefined,
  args: string[],
): Promise<void> {
  const binaryPath = resolveContextAugmentationBinaryPath() ?? 'sonar-context-augmentation';
  const { forwarded, isHelp } = buildForwardedArgs(action, args);

  let env: NodeJS.ProcessEnv;
  if (isHelp) {
    env = buildContextAugmentationEnv();
  } else {
    const auth = await resolveAuth();
    if (!auth) {
      throw new CommandFailedError('Not authenticated.', {
        remediationHint: 'Run: sonar auth login',
      });
    }
    const recordedConfig = await resolveRecordedContextAugmentationConfig(process.cwd());
    const serverUrl = recordedConfig.serverUrl ?? auth.serverUrl;
    const organization = recordedConfig.organization ?? auth.orgKey;
    env = buildContextAugmentationEnv({
      organization,
      projectKey: recordedConfig.projectKey,
      serverUrl,
      token: await resolveContextToken(auth, serverUrl, organization),
      workspaceDir: recordedConfig.workspaceDir,
    });
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, forwarded, {
      stdio: 'inherit',
      env,
      argv0: SONAR_CONTEXT_INVOCATION,
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new CommandFailedError('Vortex context augmentation is not installed.', {
            remediationHint:
              'Run "sonar integrate claude" or "sonar integrate copilot" to install it.',
          }),
        );
      } else {
        reject(err);
      }
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
