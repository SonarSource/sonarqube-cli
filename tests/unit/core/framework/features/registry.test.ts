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

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type {
  ContainerIntegrationContext,
  FeatureApplication,
  FeatureContainer,
  FeatureDeclaration,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationInvocation,
  ResourceDeclaration,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { isContainerIntegrationContext } from '@/core/framework/features/types.ts';
import { getDefaultState, type InstalledIntegrationFeature } from '@/core/state/state.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const binaryInstall = await import('@/core/host/install/binary.ts');
void mock.module('@/core/host/install/binary.ts', () => ({
  ...binaryInstall,
}));

const {
  buildApplications,
  createIntegrationRegistry,
  IntegrationInstaller,
  IntegrationRegistry,
  isFeatureContainer,
  jsonPatch,
  reportFeatureAvailability,
  resolveFeatureSelection,
  sonarSourceBinary,
  textSnippet,
  textSnippetRemover,
  tomlPatch,
  wholeFile,
  yamlPatch,
} = await import('@/core/framework/features');
const { SECRETS_SPEC } = await import('@/core/host/install/secrets.ts');

type Installer = InstanceType<typeof IntegrationInstaller>;

/** Build, report and resolve like installIntegration does. */
async function selectForInvocation<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  excludedFeatureIds: string[] = [],
) {
  const applications = await buildApplications(invocation, integration, excludedFeatureIds);
  reportFeatureAvailability(applications, fake);
  return resolveFeatureSelection(applications, invocation.nonInteractive === true, fake);
}

function activeSubfeatureIds(application: FeatureApplication<any>): string[] {
  return application.subfeatureApplications
    .filter((sub) => sub.active)
    .map((sub) => sub.subfeature.id);
}

let fake: FakeConsole;

beforeEach(() => {
  fake = new FakeConsole();
});

describe('declarative integration framework', () => {
  const installer = new IntegrationInstaller();
  let tempDir: string;
  let installBinarySpy: ReturnType<typeof spyOn>;
  let resolveBinaryPathSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-cli-framework-'));
    installBinarySpy = spyOn(binaryInstall, 'installBinary').mockResolvedValue({
      binaryPath: join(tempDir, 'bin', 'sonar-secrets'),
      freshlyInstalled: true,
    });
    resolveBinaryPathSpy = spyOn(binaryInstall, 'resolveBinaryPath').mockReturnValue(null);
  });

  afterEach(() => {
    installBinarySpy.mockRestore();
    resolveBinaryPathSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects duplicate integration registrations', () => {
    const registry = new IntegrationRegistry();
    const declaration = makeIntegration();

    registry.register(declaration);

    expect(() => registry.register(declaration)).toThrow(
      'Integration declaration already registered: test-integration',
    );
  });

  it('rejects duplicate integration ids when seeding a registry from static data', () => {
    expect(() => createIntegrationRegistry([makeIntegration(), makeIntegration()])).toThrow(
      'Integration declaration already registered: test-integration',
    );
  });

  it('rejects duplicate feature, dependency, resource, and operation ids', () => {
    const registry = new IntegrationRegistry();

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            { id: 'same', displayName: 'One' },
            { id: 'same', displayName: 'Two' },
          ],
        }),
      ),
    ).toThrow('Duplicate feature id in integration test-integration');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              dependencies: [
                sonarSourceBinary({ id: 'same', spec: SECRETS_SPEC }),
                sonarSourceBinary({ id: 'same', spec: SECRETS_SPEC }),
              ],
            },
          ],
        }),
      ),
    ).toThrow('Duplicate dependency id in feature test-integration.feature');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              resources: [
                wholeFile({ id: 'same', targetPath: '/tmp/a', content: 'a' }),
                wholeFile({ id: 'same', targetPath: '/tmp/b', content: 'b' }),
              ],
            },
          ],
        }),
      ),
    ).toThrow('Duplicate resource id in feature test-integration.feature');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              operations: [
                { id: 'same', apply: () => undefined },
                { id: 'same', apply: () => undefined },
              ],
            },
          ],
        }),
      ),
    ).toThrow('Duplicate operation id in feature test-integration.feature');

    expect(() =>
      registry.register(
        makeIntegration({
          legacyFeatures: [
            { id: 'legacy', removable: true },
            { id: 'legacy', removable: false },
          ],
        }),
      ),
    ).toThrow('Duplicate legacy feature id in integration test-integration');
  });

  it('rejects empty declaration ids', () => {
    const registry = new IntegrationRegistry();

    expect(() => registry.register(makeIntegration({ id: ' ' }))).toThrow(
      'Integration id must not be empty',
    );
    expect(() =>
      registry.register(
        makeIntegration({
          features: [{ id: ' ', displayName: 'Feature' }],
        }),
      ),
    ).toThrow('Feature id must not be empty');
    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              dependencies: [sonarSourceBinary({ id: ' ', spec: SECRETS_SPEC })],
            },
          ],
        }),
      ),
    ).toThrow('Dependency id must not be empty');
    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              resources: [wholeFile({ id: ' ', targetPath: '/tmp/file', content: '' })],
            },
          ],
        }),
      ),
    ).toThrow('Resource id must not be empty');
    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              operations: [{ id: ' ', apply: () => undefined }],
            },
          ],
        }),
      ),
    ).toThrow('Operation id must not be empty');
    expect(() =>
      registry.register(
        makeIntegration({
          legacyFeatures: [{ id: ' ', removable: true }],
        }),
      ),
    ).toThrow('Legacy feature id must not be empty');
  });

  // Feature replacement (`replacedIds`) :O

  const expectReplacementRejected = (features: FeatureDeclaration[], expectedError: string) =>
    expect(() =>
      new IntegrationRegistry().register(makeIntegration({ id: 'claude-code', features })),
    ).toThrow(expectedError);

  it('rejects empty replaced feature ids', () => {
    expectReplacementRejected(
      [{ id: 'vortex', displayName: 'Vortex', replacedIds: [' '] }],
      'Replaced feature id must not be empty',
    );
  });

  it('rejects replacing an active feature id, including the feature itself', () => {
    expectReplacementRejected(
      [
        { id: 'vortex', displayName: 'Vortex', replacedIds: ['sqaa-instructions'] },
        { id: 'sqaa-instructions', displayName: 'SQAA instructions' },
      ],
      'Feature claude-code.vortex replaces an active feature id: sqaa-instructions',
    );

    expectReplacementRejected(
      [{ id: 'vortex', displayName: 'Vortex', replacedIds: ['vortex'] }],
      'Feature claude-code.vortex replaces an active feature id: vortex',
    );
  });

  it('rejects the same replaced feature id claimed twice in one integration', () => {
    const duplicateClaim = 'Duplicate replaced feature id in integration claude-code';

    expectReplacementRejected(
      [
        { id: 'vortex-sqaa', displayName: 'Vortex SQAA', replacedIds: ['context-augmentation'] },
        { id: 'vortex-cag', displayName: 'Vortex CAG', replacedIds: ['context-augmentation'] },
      ],
      duplicateClaim,
    );

    expectReplacementRejected(
      [
        {
          id: 'vortex',
          displayName: 'Vortex',
          replacedIds: ['sonar-sqaa-hook', 'sonar-sqaa-hook'],
        },
      ],
      duplicateClaim,
    );
  });

  it('accepts the same replaced feature ids in different agent integrations', () => {
    const registry = new IntegrationRegistry();
    const replacedIds = ['sonar-sqaa-hook', 'sqaa-instructions', 'context-augmentation'];

    registry.register(
      makeIntegration({
        id: 'claude-code',
        features: [{ id: 'vortex', displayName: 'Vortex', replacedIds }],
      }),
    );
    registry.register(
      makeIntegration({
        id: 'copilot-cli',
        features: [{ id: 'vortex', displayName: 'Vortex', replacedIds }],
      }),
    );

    expect(registry.get('claude-code')?.features[0].replacedIds).toEqual(replacedIds);
    expect(registry.get('copilot-cli')?.features[0].replacedIds).toEqual(replacedIds);
  });

  it('rejects duplicate and empty subfeature ids in a FeatureContainer', () => {
    const registry = new IntegrationRegistry();

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'container',
              displayName: 'Container',
              subfeatures: [
                { id: 'same', displayName: 'Sub A' },
                { id: 'same', displayName: 'Sub B' },
              ],
            } as FeatureContainer,
          ],
        }),
      ),
    ).toThrow('Duplicate subfeature id in container test-integration.container');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'container',
              displayName: 'Container',
              subfeatures: [{ id: ' ', displayName: 'Sub' }],
            } as FeatureContainer,
          ],
        }),
      ),
    ).toThrow('Subfeature id must not be empty');
  });

  it('rejects subfeature asset ids that collide with the container or are empty', () => {
    const registry = new IntegrationRegistry();
    const container = (subfeature: Partial<SubfeatureDeclaration>): FeatureContainer => ({
      id: 'container',
      displayName: 'Container',
      resources: [wholeFile({ id: 'shared-resource', targetPath: '/tmp/a', content: 'a' })],
      operations: [{ id: 'shared-operation', apply: () => undefined }],
      subfeatures: [{ id: 'sub-a', displayName: 'Sub A', ...subfeature }],
      defaultInstallSubfeatureIds: [],
    });

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            container({
              resources: [wholeFile({ id: 'shared-resource', targetPath: '/tmp/b', content: 'b' })],
            }),
          ],
        }),
      ),
    ).toThrow('Duplicate resource id in feature test-integration.container');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            container({ operations: [{ id: 'shared-operation', apply: () => undefined }] }),
          ],
        }),
      ),
    ).toThrow('Duplicate operation id in feature test-integration.container');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            container({ resources: [wholeFile({ id: ' ', targetPath: '/tmp/c', content: 'c' })] }),
          ],
        }),
      ),
    ).toThrow('Resource id must not be empty');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [container({ operations: [{ id: ' ', apply: () => undefined }] })],
        }),
      ),
    ).toThrow('Operation id must not be empty');
  });

  it('isFeatureContainer returns true only for features with a subfeatures array', () => {
    const plain: FeatureDeclaration = { id: 'plain', displayName: 'Plain' };
    const container: FeatureContainer = {
      id: 'container',
      displayName: 'Container',
      subfeatures: [],
      defaultInstallSubfeatureIds: [],
    };

    expect(isFeatureContainer(plain)).toBe(false);
    expect(isFeatureContainer(container)).toBe(true);
  });

  it('resolveFeatureSelection activates subfeatures by availability', async () => {
    const dep = sonarSourceBinary({ id: 'test-dep', spec: SECRETS_SPEC });
    const container: FeatureContainer<{ enableSca?: boolean }> = {
      id: 'container',
      displayName: 'Container',
      subfeatures: [
        { id: 'mandatory', displayName: 'Mandatory', dependencies: [dep] },
        {
          id: 'optional',
          displayName: 'Optional',
          isAvailable: ({ options }) => ({ available: options.enableSca === true }),
        },
      ],
      defaultInstallSubfeatureIds: [],
    };
    const integration = makeIntegration<{ enableSca?: boolean }>({ features: [container] });

    const withoutSca = await selectForInvocation(integration, {
      options: {},
      targetRoot: '/tmp',
      scope: 'project',
      nonInteractive: true,
      state: getDefaultState('test'),
    });
    expect(activeSubfeatureIds(withoutSca.toInstall[0])).toEqual(['mandatory']);

    const withSca = await selectForInvocation(integration, {
      options: { enableSca: true },
      targetRoot: '/tmp',
      scope: 'project',
      nonInteractive: true,
      state: getDefaultState('test'),
    });
    expect(activeSubfeatureIds(withSca.toInstall[0])).toEqual(['mandatory', 'optional']);
  });

  it('populates activeSubfeatures in context for container operations', async () => {
    let integrationContext: IntegrationContext | undefined;
    const container: FeatureContainer = {
      id: 'container',
      displayName: 'Container',
      subfeatures: [
        { id: 'mandatory', displayName: 'Mandatory' },
        { id: 'optional', displayName: 'Optional' },
      ],
      defaultInstallSubfeatureIds: [],
      operations: [
        {
          id: 'capture-op',
          apply: (ctx) => {
            integrationContext = ctx;
          },
        },
      ],
    };
    const integration = makeIntegration({ features: [container] });
    const state = getDefaultState('test');

    await installer.applyAndRecordFeatures(
      state,
      integration,
      [makeApplication(container, tempDir, ['mandatory'])],
      { console: fake },
    );

    expect(integrationContext).toBeDefined();
    expect(isContainerIntegrationContext(integrationContext!)).toBeTrue();
    expect(
      (integrationContext as ContainerIntegrationContext)?.activeSubfeatures?.map((s) => s.id),
    ).toEqual(['mandatory']);
  });

  it('resolveFeatureSelection prompts for each subfeature, activating on confirm and declining otherwise', async () => {
    const container: FeatureContainer<Record<string, unknown>> = {
      id: 'container',
      displayName: 'Container',
      required: true,
      subfeatures: [
        { id: 'opted-in', displayName: 'Opted-in feature' },
        { id: 'declined', displayName: 'Declined feature' },
      ],
      defaultInstallSubfeatureIds: [],
    };
    const integration = makeIntegration({ features: [container] });
    fake.queueResponse(true); // accept 'opted-in'
    fake.queueResponse(false); // decline 'declined'

    const result = await selectForInvocation(integration, {
      options: {},
      targetRoot: '/tmp',
      scope: 'project',
      nonInteractive: false,
      state: getDefaultState('test'),
    });

    expect(activeSubfeatureIds(result.toInstall[0])).toEqual(['opted-in']);
    expect(result.declined).toEqual(['declined']);
    const confirmCalls = fake.calls.filter((c) => c.method === 'confirmPrompt');
    expect(confirmCalls).toHaveLength(2);
    expect(confirmCalls[0]?.args[0]).toBe('Install Opted-in feature?');
  });

  it('resolveFeatureSelection throws CommandFailedError on Ctrl+C at subfeature prompt', async () => {
    const container: FeatureContainer<Record<string, unknown>> = {
      id: 'container',
      displayName: 'Container',
      required: true,
      subfeatures: [{ id: 'optional', displayName: 'Optional feature' }],
      defaultInstallSubfeatureIds: [],
    };
    const integration = makeIntegration({ features: [container] });
    fake.queueResponse(null); // Ctrl+C

    let caughtError: unknown;
    try {
      await selectForInvocation(integration, {
        options: {},
        targetRoot: '/tmp',
        scope: 'project',
        nonInteractive: false,
        state: getDefaultState('test'),
      });
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain('Installation cancelled');
  });

  it('resolveFeatureSelection throws CommandFailedError on Ctrl+C at the Keep? prompt', async () => {
    const integration = makeIntegration({ features: [{ id: 'feature', displayName: 'Feature' }] });
    const state = getDefaultState('test');
    // Seed the feature as already installed so the keep/remove flow kicks in.
    await installer.applyAndRecordFeatures(
      state,
      integration,
      [makeApplication(integration.features[0], tempDir)],
      { console: fake },
    );
    fake.queueResponse(null); // Ctrl+C at "Keep?"

    let caughtError: unknown;
    try {
      await selectForInvocation(integration, {
        options: {},
        targetRoot: tempDir,
        scope: 'project',
        nonInteractive: false,
        state,
      });
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain('Installation cancelled');
  });

  it('resolveFeatureSelection throws CommandFailedError on Ctrl+C at the removal confirmation', async () => {
    const integration = makeIntegration({ features: [{ id: 'feature', displayName: 'Feature' }] });
    const state = getDefaultState('test');
    await installer.applyAndRecordFeatures(
      state,
      integration,
      [makeApplication(integration.features[0], tempDir)],
      { console: fake },
    );
    fake.queueResponse(false); // decline "Keep?"
    fake.queueResponse(null); // Ctrl+C at "Proceed with removal?"

    let caughtError: unknown;
    try {
      await selectForInvocation(integration, {
        options: {},
        targetRoot: tempDir,
        scope: 'project',
        nonInteractive: false,
        state,
      });
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain('Installation cancelled');
  });

  it('routes a user-confirmed uninstall to toRemove, not declined', async () => {
    const integration = makeIntegration({ features: [{ id: 'feature', displayName: 'Feature' }] });
    const state = getDefaultState('test');
    await installer.applyAndRecordFeatures(
      state,
      integration,
      [makeApplication(integration.features[0], tempDir)],
      { console: fake },
    );
    fake.queueResponse(false); // decline "Keep?"
    fake.queueResponse(true); // confirm "Proceed with removal?"

    const selected = await selectForInvocation(integration, {
      options: {},
      targetRoot: tempDir,
      scope: 'project',
      nonInteractive: false,
      state,
    });

    expect(selected.toRemove.map((application) => application.feature.id)).toEqual(['feature']);
    expect(selected.toInstall).toEqual([]);
    expect(selected.declined).toEqual([]);
  });

  it.each([true, false])(
    'removes an installed feature that is no longer available, reporting reason and removal (nonInteractive: %p)',
    async (nonInteractive) => {
      const integration = makeIntegration({
        features: [
          {
            id: 'feature',
            displayName: 'Feature',
            isAvailable: () => ({ available: false, unavailableReason: 'Not offered anymore' }),
          },
        ],
      });
      const state = getDefaultState('test');
      await installer.applyAndRecordFeatures(
        state,
        integration,
        [makeApplication(integration.features[0], tempDir)],
        { console: fake },
      );

      const selected = await selectForInvocation(integration, {
        options: {},
        targetRoot: tempDir,
        scope: 'project',
        nonInteractive,
        state,
      });

      expect(selected.toRemove.map((application) => application.feature.id)).toEqual(['feature']);
      expect(selected.toInstall).toEqual([]);
      expect(fake.calls.filter((call) => call.method === 'confirmPrompt')).toEqual([]);
      expect(fake.findCall('info', 'Not offered anymore')).toBeDefined();
      expect(fake.findCall('info', 'Feature is no longer available. Removing it.')).toBeDefined();
    },
  );

  it('reports the reason but not a removal for an unavailable feature that is not installed', async () => {
    const integration = makeIntegration({
      features: [
        {
          id: 'feature',
          displayName: 'Feature',
          isAvailable: () => ({ available: false, unavailableReason: 'Not offered' }),
        },
      ],
    });

    const selected = await selectForInvocation(integration, {
      options: {},
      targetRoot: tempDir,
      scope: 'project',
      state: getDefaultState('test'),
    });

    expect(selected.toInstall).toEqual([]);
    expect(selected.toRemove).toEqual([]);
    expect(fake.findCall('info', 'Not offered')).toBeDefined();
    expect(fake.findCall('info', 'no longer available')).toBeUndefined();
  });

  it('warns and leaves an installed feature untouched when its availability is unknown', async () => {
    const integration = makeIntegration({
      features: [
        { id: 'feature', displayName: 'Feature', isAvailable: () => ({ available: undefined }) },
      ],
    });
    const state = getDefaultState('test');
    await installer.applyAndRecordFeatures(
      state,
      integration,
      [makeApplication(integration.features[0], tempDir)],
      { console: fake },
    );

    const selected = await selectForInvocation(integration, {
      options: {},
      targetRoot: tempDir,
      scope: 'project',
      state,
    });

    expect(selected.toInstall).toEqual([]);
    expect(selected.toRemove).toEqual([]);
    expect(fake.findCall('warn', 'Could not check whether Feature is available.')).toBeDefined();
  });

  it('records active subfeatures nested under the container feature in state', async () => {
    const dep = sonarSourceBinary({ id: 'sub-dep', spec: SECRETS_SPEC });
    const container: FeatureContainer = {
      id: 'container',
      displayName: 'Container',
      subfeatures: [
        { id: 'sub-a', displayName: 'Sub A', dependencies: [dep] },
        { id: 'sub-b', displayName: 'Sub B' },
      ],
      defaultInstallSubfeatureIds: [],
    };
    const integration = makeIntegration({ features: [container] });
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);

    await installer.applyAndRecordFeatures(
      state,
      integration,
      [makeApplication(container, tempDir, ['sub-a'])],
      { console: fake },
    );

    const recorded = state.integrations.installed[0]?.features[0];
    expect(recorded?.featureId).toBe('container');
    expect(recorded?.subfeatures).toHaveLength(1);
    expect(recorded?.subfeatures?.[0]).toMatchObject({
      featureId: 'sub-a',
      dependencies: [{ id: 'sub-dep' }],
    });
    expect(context).toBeDefined();
  });

  it('reconciles subfeature dependency references across re-installs', async () => {
    const depOld = sonarSourceBinary({ id: 'dep-old', spec: SECRETS_SPEC });
    const depNew = sonarSourceBinary({ id: 'dep-new', spec: SECRETS_SPEC });

    const makeContainer = (dep: typeof depOld): FeatureContainer => ({
      id: 'container',
      displayName: 'Container',
      subfeatures: [{ id: 'sub-a', displayName: 'Sub A', dependencies: [dep] }],
      defaultInstallSubfeatureIds: [],
    });

    const integration = makeIntegration({ features: [makeContainer(depOld)] });
    const state = getDefaultState('test');

    // First install: subfeature declares dep-old
    await installer.applyAndRecordFeatures(
      state,
      integration,
      [makeApplication(makeContainer(depOld), tempDir)],
      { console: fake },
    );
    expect(state.integrations.installed[0]?.features[0]?.subfeatures?.[0]?.dependencies).toEqual([
      { id: 'dep-old' },
    ]);

    // Re-install: subfeature now declares dep-new instead
    await installer.applyAndRecordFeatures(
      state,
      integration,
      [makeApplication(makeContainer(depNew), tempDir)],
      { console: fake },
    );
    const subfeature = state.integrations.installed[0]?.features[0]?.subfeatures?.[0];
    expect(subfeature?.dependencies).toEqual([{ id: 'dep-new' }]);
  });

  it('records subfeature resources and operations under the subfeature, not the container', async () => {
    const containerPath = join(tempDir, 'container.txt');
    const subPath = join(tempDir, 'sub.txt');
    const container: FeatureContainer = {
      id: 'container',
      displayName: 'Container',
      resources: [wholeFile({ id: 'container-file', targetPath: containerPath, content: 'c' })],
      subfeatures: [
        {
          id: 'sub-a',
          displayName: 'Sub A',
          resources: [wholeFile({ id: 'sub-file', targetPath: subPath, content: 's' })],
          operations: [{ id: 'sub-op', version: '1', apply: () => undefined }],
        },
      ],
      defaultInstallSubfeatureIds: [],
    };
    const integration = makeIntegration({ features: [container] });
    const state = getDefaultState('test');

    await applyAndRecord(installer, makeContext(state, tempDir), integration, container);

    expect(await readFile(subPath, 'utf-8')).toBe('s');
    const recorded = state.integrations.installed[0]?.features[0];
    expect(recorded?.resources.map((r) => r.id)).toEqual(['container-file']);
    expect(recorded?.operations).toEqual([]);
    expect(recorded?.subfeatures?.[0]?.resources?.map((r) => r.id)).toEqual(['sub-file']);
    expect(recorded?.subfeatures?.[0]?.operations?.map((o) => o.id)).toEqual(['sub-op']);
  });

  it('skips reapplying a subfeature resource recorded as already applied', async () => {
    let applyCount = 0;
    const container: FeatureContainer = {
      id: 'container',
      displayName: 'Container',
      subfeatures: [
        {
          id: 'sub-a',
          displayName: 'Sub A',
          resources: [
            {
              id: 'sub-resource',
              resourceType: 'custom',
              version: '1',
              apply: () => {
                applyCount += 1;
                return { id: 'sub-resource', resourceType: 'custom', version: '1' };
              },
              isApplied: () => true,
              remove: () => undefined,
            },
          ],
        },
      ],
      defaultInstallSubfeatureIds: [],
    };
    const integration = makeIntegration({ features: [container] });
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);

    await applyAndRecord(installer, context, integration, container);
    await applyAndRecord(installer, context, integration, container);

    expect(applyCount).toBe(1);
  });

  it('removes recorded assets of a subfeature that is no longer active', async () => {
    const subPath = join(tempDir, 'sub.txt');
    const undoneOperations: string[] = [];
    const removedResources: string[] = [];
    const subfeatureResources: ResourceDeclaration[] = [
      {
        id: 'sub-file',
        resourceType: 'custom',
        apply: async () => {
          await writeFile(subPath, 's');
          return { id: 'sub-file', resourceType: 'custom' };
        },
        isApplied: () => existsSync(subPath),
        remove: async () => {
          removedResources.push('sub-file');
          await rm(subPath, { force: true });
        },
      },
    ];
    const container: FeatureContainer = {
      id: 'container',
      displayName: 'Container',
      subfeatures: [
        {
          id: 'sub-a',
          displayName: 'Sub A',
          resources: subfeatureResources,
          operations: [
            {
              id: 'sub-op',
              apply: () => undefined,
              undo: () => {
                undoneOperations.push('sub-op');
              },
            },
          ],
        },
      ],
      defaultInstallSubfeatureIds: [],
    };
    const state = getDefaultState('test');

    const integrate = (activeSubfeatureIds: string[]) =>
      installer.applyAndRecordFeatures(
        state,
        makeIntegration({ features: [container] }),
        [makeApplication(container, tempDir, activeSubfeatureIds)],
        { console: fake },
      );

    await integrate(['sub-a']);
    expect(existsSync(subPath)).toBe(true);

    // A later CLI version declares one more resource on sub-a, which this
    // install never applied, and sub-a is now deselected.
    subfeatureResources.push({
      id: 'added-later',
      resourceType: 'custom',
      apply: () => ({ id: 'added-later', resourceType: 'custom' }),
      isApplied: () => false,
      remove: () => {
        removedResources.push('added-later');
      },
    });

    await integrate([]);

    expect(existsSync(subPath)).toBe(false);
    expect(removedResources).toEqual(['sub-file']);
    expect(undoneOperations).toEqual(['sub-op']);
    expect(state.integrations.installed[0]?.features[0]?.subfeatures).toEqual([]);
  });

  it('lists registered integrations', () => {
    const registry = new IntegrationRegistry();
    const first = makeIntegration({ id: 'first' });
    const second = makeIntegration({ id: 'second' });

    registry.register(first);
    registry.register(second);

    expect(registry.get('first')).toBe(first);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.list()).toEqual([first, second]);
  });

  it('selects available features and drops excluded ones', async () => {
    const integration = makeIntegration({
      features: [
        { id: 'pre-commit', displayName: 'Pre-commit' },
        { id: 'pre-push', displayName: 'Pre-push' },
        { id: 'never', displayName: 'Never', isAvailable: () => ({ available: false }) },
      ],
    });
    const invocation = {
      options: {},
      targetRoot: tempDir,
      scope: 'project' as const,
      nonInteractive: true,
      state: getDefaultState('test'),
    };

    expect(
      (await selectForInvocation(integration, invocation)).toInstall.map(
        (application) => application.feature.id,
      ),
    ).toEqual(['pre-commit', 'pre-push']);
    expect(
      (await selectForInvocation(integration, invocation, ['pre-commit'])).toInstall.map(
        (application) => application.feature.id,
      ),
    ).toEqual(['pre-push']);
  });

  it('leaves an installed excluded feature untouched and silent', async () => {
    const integration = makeIntegration({
      features: [
        { id: 'kept', displayName: 'Kept' },
        { id: 'other', displayName: 'Other' },
      ],
    });
    const state = getDefaultState('test');
    await installer.applyAndRecordFeatures(
      state,
      integration,
      [makeApplication(integration.features[1], tempDir)],
      { console: fake },
    );

    const selected = await selectForInvocation(
      integration,
      { options: {}, targetRoot: tempDir, scope: 'project', nonInteractive: true, state },
      ['other'],
    );

    expect(selected.toInstall.map((application) => application.feature.id)).toEqual(['kept']);
    expect(selected.toRemove).toEqual([]);
  });

  it('prints an unavailable reason only when one is provided', async () => {
    const integration = makeIntegration({
      features: [
        {
          id: 'with-reason',
          displayName: 'With reason',
          isAvailable: () => ({ available: false, unavailableReason: 'covered' }),
        },
        { id: 'silent', displayName: 'Silent', isAvailable: () => ({ available: false }) },
      ],
    });

    const selected = await selectForInvocation(integration, {
      options: {},
      targetRoot: tempDir,
      scope: 'project',
      state: getDefaultState('test'),
    });

    expect(selected.toInstall).toEqual([]);
    expect(selected.declined).toEqual([]);
    expect(fake.findCall('info', 'covered')).toBeDefined();
    expect(fake.calls.filter((call) => call.method === 'info')).toHaveLength(1);
  });

  it('prompts the user for each feature, installing on confirm and declining otherwise', async () => {
    const integration = makeIntegration({
      features: [
        { id: 'accepted', displayName: 'Accepted' },
        { id: 'declined', displayName: 'Declined', benefitDescription: 'some benefit' },
      ],
    });
    fake.queueResponse(true);
    fake.queueResponse(false);

    const selected = await selectForInvocation(integration, {
      options: {},
      targetRoot: tempDir,
      scope: 'project',
      state: getDefaultState('test'),
    });

    expect(selected.toInstall.map((application) => application.feature.id)).toEqual(['accepted']);
    expect(selected.declined).toEqual(['declined']);
    expect(selected.toRemove).toEqual([]);
    const confirmCalls = fake.calls.filter((call) => call.method === 'confirmPrompt');
    expect(confirmCalls).toHaveLength(2);
    expect(confirmCalls[0]?.args[0]).toBe('Install Accepted?');
    expect(confirmCalls[1]?.args[0]).toBe('Install Declined? (some benefit)');
  });

  it('auto-confirms in non-interactive mode and never prompts for required features', async () => {
    const integration = makeIntegration({
      features: [
        { id: 'asked', displayName: 'Asked' },
        { id: 'required', displayName: 'Required', required: true },
      ],
    });
    const invocation = {
      options: {},
      targetRoot: tempDir,
      scope: 'project' as const,
      state: getDefaultState('test'),
    };

    const nonInteractive = await selectForInvocation(integration, {
      ...invocation,
      nonInteractive: true,
    });
    expect(nonInteractive.toInstall.map((application) => application.feature.id)).toEqual([
      'asked',
      'required',
    ]);
    expect(nonInteractive.declined).toEqual([]);
    expect(fake.calls.filter((call) => call.method === 'confirmPrompt')).toHaveLength(0);

    fake.queueResponse(true);
    const interactive = await selectForInvocation(integration, invocation);
    expect(interactive.toInstall.map((application) => application.feature.id)).toEqual([
      'asked',
      'required',
    ]);
    expect(fake.calls.filter((call) => call.method === 'confirmPrompt')).toHaveLength(1);
  });

  it('runs legacy cleanups unconditionally even when state records resource at a higher version', async () => {
    const state = getDefaultState('test');
    const targetPath = join(tempDir, 'managed-file');
    const legacyStartMarker = '# legacy:begin';
    const legacyEndMarker = '# legacy:end';
    const currentStartMarker = '# sonar:begin';

    const feature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      resources: [
        textSnippet({
          id: 'resource',
          version: '1',
          targetPath,
          content: 'new content',
          startMarker: currentStartMarker,
        }),
      ],
      legacyCleanups: [
        textSnippetRemover({
          id: 'resource',
          version: '0',
          targetPath,
          startMarker: legacyStartMarker,
          endMarker: legacyEndMarker,
        }),
      ],
    };
    const integration = makeIntegration({ features: [feature] });
    const context = makeContext(state, tempDir);

    // First install: state is empty so legacy cleanup runs, recording resource at version '1'.
    await writeFile(targetPath, `${legacyStartMarker}\nold\n${legacyEndMarker}\n`);
    await applyAndRecord(installer, context, integration, feature);
    expect(state.integrations.installed[0]?.features[0]?.resources[0]?.version).toBe('1');

    // Simulate file reversion (e.g. git reset) while state still records version '1'.
    await writeFile(targetPath, `${legacyStartMarker}\nold\n${legacyEndMarker}\n`);

    // Re-install: legacy cleanup must run unconditionally despite state having version '1'.
    await applyAndRecord(installer, context, integration, feature);

    const content = await readFile(targetPath, 'utf-8');
    expect(content).not.toContain(legacyStartMarker);
    expect(content).toContain(currentStartMarker);
    expect(content).toContain('new content');
  });

  it('applies declared resources and records the feature once', async () => {
    const state = getDefaultState('test');
    const operationCalls: string[] = [];
    const feature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      dependencies: [
        sonarSourceBinary({
          id: 'binary',
          spec: SECRETS_SPEC,
        }),
      ],
      resources: [
        wholeFile({
          id: 'whole',
          version: '1',
          targetPath: join(tempDir, 'script.sh'),
          content: '#!/bin/sh\necho sonar\n',
          executable: true,
        }),
        jsonPatch({
          id: 'json',
          targetPath: join(tempDir, 'settings.json'),
          patch: (document) => ({ ...(document as Record<string, unknown>), enabled: true }),
          removePatch: (document) => document,
        }),
        yamlPatch({
          id: 'yaml',
          targetPath: join(tempDir, 'config.yml'),
          patch: () => ({ repos: [{ repo: 'local' }] }),
          removePatch: (document) => document,
        }),
        tomlPatch({
          id: 'toml',
          targetPath: join(tempDir, 'config.toml'),
          patch: (document) => ({ ...document, enabled: true }),
          removePatch: (document) => document,
        }),
        textSnippet({
          id: 'text',
          targetPath: join(tempDir, 'pre-commit-config.yaml'),
          content: 'repos: []',
          executable: true,
          startMarker: '# sonar:begin text',
        }),
      ],
      operations: [
        {
          id: 'operation',
          version: '1',
          apply: () => {
            operationCalls.push('operation');
          },
        },
      ],
    };
    const integration = makeIntegration({ features: [feature] });
    const context = makeContext(state, tempDir, { projectKey: 'project' });

    const first = await applyAndRecord(installer, context, integration, feature);
    const second = await applyAndRecord(installer, context, integration, feature);

    expect(first.featureId).toBe(second.featureId);
    expect(state.integrations.installed).toHaveLength(1);
    expect(state.integrations.installed[0].features).toHaveLength(1);
    expect(state.integrations.installed[0].features[0].attrs?.projectKey).toBe('project');
    expect(state.integrations.installed[0].features[0].targetRoot).toBe(tempDir);
    expect(second.dependencies).toEqual([{ id: 'binary' }]);
    expect(second.resources.map((resource) => resource.id).sort()).toEqual([
      'json',
      'text',
      'toml',
      'whole',
      'yaml',
    ]);
    expect(second.operations.map((operation) => operation.id)).toEqual(['operation']);
    expect(operationCalls).toEqual(['operation', 'operation']);
    expect(await readFile(join(tempDir, 'script.sh'), 'utf-8')).toBe('#!/bin/sh\necho sonar\n');
    expect(JSON.parse(await readFile(join(tempDir, 'settings.json'), 'utf-8'))).toEqual({
      enabled: true,
    });
    expect(await readFile(join(tempDir, 'pre-commit-config.yaml'), 'utf-8')).toContain(
      '# sonar:begin text',
    );
  });

  it('supports whole-file static, dynamic, and platform-specific content', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir, { projectKey: 'project' });
    const staticResource = wholeFile({
      id: 'static',
      targetPath: join(tempDir, 'static.txt'),
      content: 'static content',
    });
    const dynamicResource = wholeFile({
      id: 'dynamic',
      targetPath: join(tempDir, 'dynamic.txt'),
      content: (currentContext) => `project=${currentContext.attrs?.projectKey}`,
    });
    const platformResource = wholeFile({
      id: 'platform',
      targetPath: join(tempDir, 'platform.txt'),
      content: {
        unix: 'unix content',
        windows: 'windows content',
      },
    });

    await staticResource.apply(context);
    await dynamicResource.apply(context);
    await platformResource.apply(context);

    expect(await readFile(join(tempDir, 'static.txt'), 'utf-8')).toBe('static content');
    expect(await readFile(join(tempDir, 'dynamic.txt'), 'utf-8')).toBe('project=project');
    expect(await readFile(join(tempDir, 'platform.txt'), 'utf-8')).toBe(
      process.platform === 'win32' ? 'windows content' : 'unix content',
    );
    expect(await staticResource.isApplied(context)).toBe(true);
    expect(await dynamicResource.isApplied(context)).toBe(true);
    expect(await platformResource.isApplied(context)).toBe(true);
  });

  it('requires force to overwrite protected whole files unless the file is already managed', async () => {
    const state = getDefaultState('test');
    const targetPath = join(tempDir, 'hook.sh');
    const resource = wholeFile({
      id: 'hook',
      displayName: 'pre-commit hook',
      targetPath,
      content: '#!/bin/sh\n# sonar-managed\necho sonar\n',
      executable: true,
      requiresForce: true,
      managedMarker: '# sonar-managed',
    });

    await writeFile(targetPath, '#!/bin/sh\necho user-defined\n');

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(resource.apply(makeContext(state, tempDir))).rejects.toThrow(
      `A different pre-commit hook already exists at ${targetPath}`,
    );

    await resource.apply(makeContext(state, tempDir, undefined, true));
    expect(await readFile(targetPath, 'utf-8')).toBe('#!/bin/sh\n# sonar-managed\necho sonar\n');

    await writeFile(targetPath, '#!/bin/sh\n# sonar-managed\necho older sonar\n');
    await resource.apply(makeContext(state, tempDir));
    expect(await readFile(targetPath, 'utf-8')).toBe('#!/bin/sh\n# sonar-managed\necho sonar\n');
  });
});

function makeIntegration<TOptions = Record<string, unknown>>(
  overrides: Partial<IntegrationDeclaration<TOptions>> = {},
): IntegrationDeclaration<TOptions> {
  return {
    id: 'test-integration',
    displayName: 'Test Integration',
    features: [{ id: 'feature', displayName: 'Feature' }],
    ...overrides,
  };
}

function makeContext(
  state: ReturnType<typeof getDefaultState>,
  targetRoot: string,
  attrs?: IntegrationContext['attrs'],
  force?: boolean,
  executionMode: IntegrationContext['executionMode'] = 'install',
): IntegrationContext {
  return {
    state,
    targetRoot,
    scope: 'project',
    executionMode,
    console: new FakeConsole(),
    force,
    attrs,
    resolvedDependencies: new Map(),
  };
}

async function applyAndRecord<TOptions>(
  installer: Installer,
  context: IntegrationContext,
  integration: IntegrationDeclaration<TOptions>,
  feature: FeatureDeclaration<TOptions>,
): Promise<InstalledIntegrationFeature> {
  const installed = await installer.applyAndRecordFeatures(
    context.state,
    integration,
    [
      makeApplication(feature, context.targetRoot, undefined, {
        scope: context.scope,
        force: context.force,
        attrs: context.attrs,
      }),
    ],
    { console: context.console },
  );

  if (installed.length === 0) {
    throw new Error('Feature was not recorded');
  }

  return installed[0];
}

function makeApplication<TOptions>(
  feature: FeatureDeclaration<TOptions>,
  targetRoot: string,
  activeSubfeatureIds?: string[],
  overrides: Partial<FeatureApplication<TOptions>> = {},
): FeatureApplication<TOptions> {
  const subfeatures = isFeatureContainer(feature) ? feature.subfeatures : [];
  return {
    feature,
    targetRoot,
    scope: 'project',
    installed: false,
    available: true,
    subfeatureApplications: subfeatures.map((subfeature) => ({
      subfeature,
      installed: false,
      available: true,
      active: activeSubfeatureIds?.includes(subfeature.id) ?? true,
    })),
    ...overrides,
  };
}
