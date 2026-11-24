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

import { SettledStep } from '@/commands/init/flow/settled-step.ts';
import { alreadyDone, skipped, success } from '@/commands/init/flow/step-result.ts';
import { StepRunner } from '@/commands/init/flow/step-runner.ts';

import { ScriptedStep } from '../scripted-step.ts';

const ROOT = { index: 1, path: 'web' };

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('StepRunner', () => {
  it('hands the value of a step on', async () => {
    const steps = new StepRunner();

    expect(
      await steps.run(
        new ScriptedStep({ step: 'org_bind' }, () => Promise.resolve(alreadyDone('github'))),
      ),
    ).toBe('github');
    expect(
      await steps.run(
        new ScriptedStep({ step: 'create_project', root: ROOT }, () =>
          Promise.resolve(success('web-key')),
        ),
      ),
    ).toBe('web-key');
  });

  it('hands on the result of a step settled outside of it', async () => {
    expect(await new StepRunner().run(new SettledStep({ step: 'integrate' }, skipped(3)))).toBe(3);
  });

  it('rethrows the error of a failed step unchanged', async () => {
    const failure = new Error('offline');

    const error = await thrownBy(
      new StepRunner().run(
        new ScriptedStep({ step: 'create_project', root: ROOT }, () => Promise.reject(failure)),
      ),
    );

    expect(error).toBe(failure);
  });
});
