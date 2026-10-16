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

import { openBrowserWithFallback } from '@/core/auth/token.ts';
import {
  CommandFailedError,
  type CommandFailedErrorOptions,
  InvalidOptionError,
} from '@/core/commands/command-error.ts';
import { getImportPatPollIntervalMs, getImportPatWaitTimeoutMs } from '@/core/config-constants.ts';
import { AccessDeniedError } from '@/core/server/errors.ts';
import { HTTP_STATUS_FORBIDDEN, HTTP_STATUS_NOT_FOUND } from '@/core/server/http-constants.ts';
import { fetchServerVersion } from '@/core/server/server-info.ts';
import type { Console } from '@/core/ui/console.ts';

import type { DopRepository } from './import-api.ts';
import type { ImportBackend, ImportPlan, ImportRepoOutcome } from './import-backend.ts';
import type { OnlyPrivateProjects } from './repository-collection';
import { type ResolvedRepo, selectRepos, validateSelectionOptions } from './resolve-options';
import { buildConnectUrl } from './server/connect-url.ts';
import type { PatStatus } from './server/pat-status.ts';
import { SUPPORTED_PLATFORMS } from './server/platforms.ts';
import { deriveProjectKey } from './server/project-key.ts';
import {
  DOP_PLATFORM_LABELS,
  type DopSetting,
  type PatProbe,
  type ServerImportApiClient,
} from './server/server-import-api.ts';
import type { ServerRepository } from './server/server-repository.ts';
import { waitForPat } from './server/wait-for-pat.ts';
import type { ImportOptions } from './types';

/** Every repository is selectable: SonarQube Server has no per-organization visibility rule. */
const NO_VISIBILITY_RESTRICTION: OnlyPrivateProjects = { enabled: false, available: true };

const NETWORK_HINT = 'Check your network connection and authentication, then retry.';

/** SonarQube Server: repositories come from a DevOps platform setting the user has connected to. */
export class ServerBackend implements ImportBackend {
  constructor(
    private readonly api: ServerImportApiClient,
    private readonly serverUrl: string,
  ) {}

  async plan(options: ImportOptions, console: Console): Promise<ImportPlan> {
    validateSelectionOptions({ ...options, nonInteractive: !canPrompt(options) });

    const settings = await this.loadSettings();
    const setting = await selectSetting(settings, options, console);
    const label = DOP_PLATFORM_LABELS[setting.type];
    console.info(`DevOps platform: ${setting.key} (${label})`);

    await this.requireConnectedPat(setting, options, console);

    const support = SUPPORTED_PLATFORMS[setting.type];
    if (!support) {
      throw new CommandFailedError(`Importing from ${label} is not supported yet.`, {
        remediationHint: 'Support for more DevOps platforms is being added.',
      });
    }

    const repositories = new Map<string, ServerRepository>();
    const claimedKeys = new Map<string, string>();
    const fetchServerPage = support.listRepositories(this.api, setting);
    const selection = await selectRepos(
      {
        fetchPage: async (pageIndex, pageSize) => {
          const page = await fetchServerPage(pageIndex, pageSize);
          for (const repository of page.repositories) {
            repositories.set(repository.id, repository);
          }
          return { repositories: page.repositories.map(toDopRepository), total: page.total };
        },
        scope: 'this DevOps platform',
        platformScope: 'this DevOps platform',
        noRepositoriesHint:
          'The personal access token may not see any repository, or the DevOps platform connection may need to be reconfigured.',
        notFoundHint:
          'Check that the repository path(s) are correct and visible to your personal access token.',
        almKey: undefined,
        onlyPrivateProjects: NO_VISIBILITY_RESTRICTION,
      },
      { ...options, nonInteractive: !canPrompt(options), console },
    );

    return {
      selection,
      projectListUrl: `${this.serverUrl.replace(/\/$/, '')}/projects`,
      toResolvedRepo: (repo) => ({ slug: repo.slug, installationKey: repo.id }),
      importRepo: (resolved) => this.importRepository(setting, repositories, claimedKeys, resolved),
    };
  }

  private async importRepository(
    setting: DopSetting,
    repositories: Map<string, ServerRepository>,
    claimedKeys: Map<string, string>,
    resolved: ResolvedRepo,
  ): Promise<ImportRepoOutcome> {
    const repository = repositories.get(resolved.installationKey);
    if (!repository) {
      throw new CommandFailedError(`Repository '${resolved.slug}' is no longer listed.`);
    }
    const projectKey = deriveProjectKey(repository.slug);
    const claimedBy = claimedKeys.get(projectKey);
    if (claimedBy !== undefined && claimedBy !== repository.id) {
      throw new CommandFailedError(
        `Repository '${repository.slug}' would get the project key '${projectKey}', already used by another repository in this run.`,
        { remediationHint: 'Import it from SonarQube Server in your browser instead.' },
      );
    }
    claimedKeys.set(projectKey, repository.id);
    const { newProjectCreated } = await this.api.putBoundProject({
      projectKey,
      projectName: repository.name,
      devOpsPlatformSettingId: setting.id,
      repositoryIdentifier: repository.repositoryIdentifier,
      projectIdentifier: repository.projectIdentifier,
    });
    return newProjectCreated ? {} : { detail: 'project already existed, binding updated' };
  }

  private async loadSettings(): Promise<DopSetting[]> {
    try {
      return await this.api.listDopSettings();
    } catch (error) {
      throw await this.mapDopSettingsError(error);
    }
  }

  private async mapDopSettingsError(error: unknown): Promise<unknown> {
    if (error instanceof AccessDeniedError && error.status === HTTP_STATUS_NOT_FOUND) {
      const version = await fetchServerVersion(this.serverUrl).catch(() => undefined);
      const detected = version ? ` Detected server version: ${version}.` : '';
      return new CommandFailedError(
        `This SonarQube Server does not support importing repositories (the DevOps platform settings API was not found).${detected}`,
        { remediationHint: 'Upgrade SonarQube Server, then retry.' },
      );
    }
    return mapRequestError(error, 'list the configured DevOps platforms');
  }

  /**
   * Returns once the caller has a working personal access token for `setting`. When the run can
   * prompt it waits for the user to connect one in the browser; otherwise it ends the run.
   */
  private async requireConnectedPat(
    setting: DopSetting,
    options: ImportOptions,
    console: Console,
  ): Promise<void> {
    const status = await this.statusOf(setting);
    if (status === 'valid') {
      return;
    }
    const label = DOP_PLATFORM_LABELS[setting.type];
    const url = this.reconnectUrl(setting, status);
    const problem =
      status === 'missing'
        ? `No personal access token is connected for ${label} setting '${setting.key}'.`
        : this.rejectedProblem(setting);
    if (!canPrompt(options)) {
      throw new CommandFailedError(problem, {
        remediationHint: `Connect it at ${url}, then run 'sonar import' again.`,
      });
    }

    console.info(`${problem} Connect it in your browser:`);
    console.print(url);
    await openBrowserWithFallback(url, console);
    await console.withSpinner(
      `Waiting for the ${label} personal access token to be connected`,
      () => this.waitForConnectedPat(setting, status, url, problem),
    );
    console.discreetSuccess(
      `Personal access token connected for ${label} setting '${setting.key}'.`,
    );
  }

  private async waitForConnectedPat(
    setting: DopSetting,
    initial: Exclude<PatStatus, 'valid'>,
    url: string,
    problem: string,
  ): Promise<void> {
    const label = DOP_PLATFORM_LABELS[setting.type];
    const abort = new AbortController();
    const onSigint = () => {
      abort.abort();
    };
    process.on('SIGINT', onSigint);
    let result;
    try {
      result = await waitForPat({
        check: () => this.statusOf(setting),
        initial,
        intervalMs: getImportPatPollIntervalMs(),
        timeoutMs: getImportPatWaitTimeoutMs(),
        signal: abort.signal,
      });
    } finally {
      process.off('SIGINT', onSigint);
    }

    const rerun = `run 'sonar import' again.`;
    switch (result) {
      case 'valid':
        return;
      case 'invalid':
        throw new CommandFailedError(this.rejectedProblem(setting), {
          remediationHint: `Reconnect it at ${this.reconnectUrl(setting, 'invalid')}, then ${rerun}`,
        });
      case 'timeout':
        throw new CommandFailedError(
          `Timed out waiting for the ${label} personal access token to be connected.`,
          { remediationHint: `Connect it at ${url}, then ${rerun}` },
        );
      case 'aborted':
        throw new CommandFailedError(`Stopped waiting. ${problem}`, {
          remediationHint: `Connect it at ${url}, then ${rerun}`,
        });
    }
  }

  /**
   * GitHub answers a dead or expired token, or an app installed nowhere the user can see, with a
   * successful but empty organizations listing, and its web flow authorizes again on every visit.
   * So a valid probe with no organizations is treated like a rejected token: the user goes through
   * the browser, and the wait ends once organizations show up.
   */
  private async statusOf(setting: DopSetting): Promise<PatStatus> {
    const probe = await this.probeOf(setting);
    return setting.type === 'github' && probe.status === 'valid' && probe.organizationCount === 0
      ? 'invalid'
      : probe.status;
  }

  private rejectedProblem(setting: DopSetting): string {
    if (setting.type === 'github') {
      return `GitHub returned no organizations for setting '${setting.key}': its authorization is missing or has expired, or the GitHub App is not installed for your GitHub account.`;
    }
    const label = DOP_PLATFORM_LABELS[setting.type];
    return `The personal access token for ${label} setting '${setting.key}' was rejected by ${label}.`;
  }

  /** The web UI ignores `resetPat` for GitHub: it authorizes again on every visit. */
  private reconnectUrl(setting: DopSetting, status: PatStatus): string {
    return buildConnectUrl(this.serverUrl, setting, {
      resetPat: status === 'invalid' && setting.type !== 'github',
    });
  }

  private async probeOf(setting: DopSetting): Promise<PatProbe> {
    try {
      return setting.type === 'github'
        ? await this.api.probeGithubPat(setting.key)
        : { status: await this.api.checkPat(setting.key) };
    } catch (error) {
      if (error instanceof AccessDeniedError && error.status === HTTP_STATUS_NOT_FOUND) {
        throw new CommandFailedError(`DevOps platform setting '${setting.key}' was not found.`, {
          remediationHint:
            'The server answered 404: the setting may have been removed, or this server may not offer the token check. Run the command again to pick another setting.',
        });
      }
      throw mapRequestError(error, 'check the personal access token');
    }
  }
}

function toDopRepository(repository: ServerRepository): DopRepository {
  const bound = repository.boundProjectKey;
  return {
    id: repository.id,
    name: repository.name,
    slug: repository.slug,
    private: false,
    archived: false,
    boundProjectIds: bound ? [bound] : [],
    importedInCurrentOrg: bound !== undefined,
  };
}

function mapRequestError(error: unknown, action: string): unknown {
  if (error instanceof AccessDeniedError && error.status === HTTP_STATUS_FORBIDDEN) {
    return new CommandFailedError(
      "You need the 'Create Projects' permission to import repositories.",
      {
        remediationHint:
          "Ask a SonarQube administrator to grant you the global 'Create Projects' permission.",
      },
    );
  }
  if (error instanceof Error) {
    const options: CommandFailedErrorOptions = { remediationHint: NETWORK_HINT };
    return new CommandFailedError(`Failed to ${action}: ${error.message}`, options);
  }
  return error;
}

/** Whether the run may stop and ask the user something. */
function canPrompt(options: ImportOptions): boolean {
  return (
    !options.nonInteractive &&
    process.env.CI !== 'true' &&
    Boolean(process.stdin.isTTY || process.env.SONARQUBE_CLI_MOCK_TTY)
  );
}

async function selectSetting(
  settings: DopSetting[],
  options: ImportOptions,
  console: Console,
): Promise<DopSetting> {
  if (settings.length === 0) {
    throw new CommandFailedError(
      'No DevOps platform integration is configured on this SonarQube Server.',
      {
        remediationHint:
          'A SonarQube administrator must configure one under Administration > DevOps Platform Integration, then retry.',
      },
    );
  }

  const keys = settings.map((setting) => setting.key).join(', ');

  if (options.dopSetting !== undefined) {
    const chosen = settings.find((setting) => setting.key === options.dopSetting);
    if (!chosen) {
      throw new InvalidOptionError(
        `No DevOps platform setting has the key '${options.dopSetting}'.`,
        `Available keys: ${keys}.`,
      );
    }
    return chosen;
  }

  if (settings.length === 1) {
    return settings[0];
  }

  if (!canPrompt(options)) {
    throw new InvalidOptionError(
      'Several DevOps platform settings are configured: pass --dop-setting <key> to choose one.',
      `Available keys: ${keys}.`,
    );
  }

  const chosen = await console.selectPrompt(
    'Which DevOps platform do you want to import from?',
    settings.map((setting) => ({
      value: setting,
      label: `${setting.key} (${DOP_PLATFORM_LABELS[setting.type]})`,
    })),
  );
  if (chosen === null) {
    throw new CommandFailedError('DevOps platform selection cancelled');
  }
  return chosen;
}
