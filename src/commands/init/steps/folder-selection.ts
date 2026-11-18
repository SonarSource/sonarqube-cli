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

import {
  chooseProjectFolders,
  FolderSelectionCancelledError,
} from '@/commands/link/choose-folder.ts';
import { type FolderPicker, TreeFolderPicker } from '@/commands/link/folder-picker.ts';
import logger from '@/core/observability/logger.ts';
import { relativeProjectPath, resolveProjectTarget } from '@/core/project-discovery/link-target.ts';
import {
  type ConfigItem,
  sharedProjectConfigFile,
  throwOnInvalidConfig,
} from '@/core/project-discovery/shared-project-config.ts';

import type { MonorepoRootOption } from '../options.ts';
import type { DetectDeps } from './detect.ts';

/** What the user picked in the folder tree. */
export type FolderSelection =
  /** One folder, onboarded on the usual single-project path. */
  | { kind: 'project'; projectRoot: string }
  /** Several folders, or `--monorepo`: each is a monorepo root without a key, as `--root <path>` names it. */
  | { kind: 'monorepo'; roots: MonorepoRootOption[] };

/** Only annotates the tree: a config that cannot be read is reported where the mapping is written, with its hint. */
async function readLinkedItems(targetDir: string): Promise<ConfigItem[]> {
  try {
    return await sharedProjectConfigFile.readItems(targetDir, throwOnInvalidConfig);
  } catch (error) {
    logger.debug(`Could not read the linked folders: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Lets the user tick the folders to link under the directory `.sonar-config.json` goes in.
 * Resolves to `undefined` to carry on with `projectRoot` as is. Cancelling the picker fails the
 * run, before anything is written.
 */
export async function pickFolders(
  projectRoot: string,
  monorepo: boolean,
  { console }: Pick<DetectDeps, 'console'>,
  picker: FolderPicker = new TreeFolderPicker(console),
): Promise<FolderSelection | undefined> {
  const { targetDir, inGitRepository } = await resolveProjectTarget(projectRoot);
  const items = await readLinkedItems(targetDir);
  const folders = await chooseProjectFolders(
    targetDir,
    { inGitRepository, items, monorepo },
    picker,
    console,
  );
  if (folders === undefined) {
    return undefined;
  }
  if (folders.length === 1 && !monorepo) {
    return { kind: 'project', projectRoot: folders[0] };
  }
  return {
    kind: 'monorepo',
    roots: folders.map((folder) => ({ path: relativeProjectPath(targetDir, folder) })),
  };
}

/**
 * Asked once the user has agreed to link: the one directory to link, or `cancelled` when the user
 * left the prompts so the caller can step back. The agreed project maps to a single folder, so
 * ticking several asks again; onboarding several folders is what `--monorepo` is for. Without
 * `deps.pickLinkFolder` nothing is asked and `projectRoot` stays.
 */
export async function chooseLinkFolder(
  projectRoot: string,
  deps: DetectDeps,
): Promise<{ projectRoot: string } | { cancelled: true }> {
  if (!deps.pickLinkFolder) {
    return { projectRoot };
  }
  for (;;) {
    let selection: FolderSelection | undefined;
    try {
      selection = await pickFolders(projectRoot, false, deps);
    } catch (error) {
      if (error instanceof FolderSelectionCancelledError) {
        return { cancelled: true };
      }
      throw error;
    }
    if (selection?.kind !== 'monorepo') {
      return { projectRoot: selection?.projectRoot ?? projectRoot };
    }
    deps.console.warn(
      "A project links to one folder. Tick a single folder, or use 'sonar init --monorepo' to onboard several.",
    );
  }
}
