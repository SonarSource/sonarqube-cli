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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { ProjectsClient } from '@/core/server/projects.ts';

import { missingDecision } from '../decision.ts';
import { skipped, type StepResult } from '../flow/step-result.ts';
import type { InitStep, StepRef } from '../flow/step-runner.ts';
import type { InitOutcome, NoProjectPath } from '../init-outcome.ts';
import { generateProjectProposal } from '../key-proposal.ts';
import type { DetectDeps } from './detect.ts';
import { LinkExistingStep } from './link-existing.ts';

const NO_PROJECT = 'No SonarQube project exists for this directory yet.';

/**
 * Nothing binds the repository to a project and no new one is bound to it. A project an earlier
 * run created under the key generated for this directory is offered for linking; otherwise the
 * run ends without creating anything, and says how to link an existing project. Nothing is
 * created either way, so the creation step is skipped, as no one declined it.
 */
export class NoProjectStep implements InitStep<InitOutcome> {
  readonly ref: StepRef;

  constructor(
    private readonly path: NoProjectPath,
    private readonly deps: DetectDeps,
  ) {
    this.ref = { step: 'create_project', root: deps.root };
  }

  async run(): Promise<StepResult<InitOutcome>> {
    const { projectRoot, remote } = this.path;
    const { auth, http, steps } = this.deps;
    const { projectKey } = generateProjectProposal(projectRoot, remote, auth.orgKey);
    const existing = await new ProjectsClient(http).findProject(projectKey, auth.orgKey).orThrow();
    if (existing) {
      const outcome = await steps.run(
        new LinkExistingStep(
          { path: 'link-existing', projectRoot, remote, projectKey: existing.key },
          this.deps,
        ),
      );
      return skipped(outcome);
    }
    return skipped(this.reportNoProject());
  }

  private reportNoProject(): InitOutcome {
    const { repositorySlug } = this.path;
    const { console, interactive, intent } = this.deps;
    if (intent?.kind === 'link') {
      throw new InvalidOptionError(
        '--link found no SonarQube project for this directory.',
        'Name the project with --link <key>.',
      );
    }
    if (!interactive) {
      const options = repositorySlug ? ['--bind', '--link <key>'] : ['--link <key>'];
      throw missingDecision(NO_PROJECT, options);
    }
    console.info(
      `${NO_PROJECT} Creating a project without repository binding is not supported.`,
      'stderr',
    );
    console.info("Run 'sonar init --link <key>' to link an existing project.", 'stderr');
    return { kind: 'declined' };
  }
}
