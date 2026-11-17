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

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { TelemetryFact } from '@/core/commands/invocation-context.ts';
import { commitTelemetryFacts, TELEMETRY_FLUSH_MODE_ENV } from '@/core/telemetry';
import * as identity from '@/core/telemetry/identity.ts';
import * as telemetryEvents from '@/core/telemetry/telemetry-events.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';

const ANALYSIS_PAYLOAD = {
  caller_command: 'analyze agentic',
  analyzer: 'sqaa' as const,
  analysis_id: 'a1',
  findings_count: 0,
  exit_code: 0,
  errors_count: 0,
  failures_count: 0,
  scan_duration_ms: 1,
  details: '',
};

const IDENTITY = {
  connectionType: 'sqc' as const,
  identity: { user_uuid: 'u', organization_uuid_v4: 'o', sqs_installation_id: null },
};

function cloudAuth(token: string): ResolvedAuth {
  return new ResolvedAuth({
    connectionType: 'cloud',
    source: 'state' as const,
    serverUrl: 'https://sonarcloud.io',
    token,
    orgKey: 'my-org',
  });
}

function fact(
  name: string,
  payload: object = ANALYSIS_PAYLOAD,
  auth?: ResolvedAuth,
): TelemetryFact {
  return auth
    ? new TelemetryFact(name, payload, { timestamp: 1_700_000_000_000, auth })
    : new TelemetryFact(name, payload, 1_700_000_000_000);
}

describe('commitTelemetryFacts', () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  it('forwards every fact through emitTelemetryEvent', async () => {
    const emitSpy = spyOn(telemetryEvents, 'emitTelemetryEvent').mockResolvedValue();

    const analysis = fact('CliAnalysisCompleted');
    const integration = fact('CliIntegrationConfigured', {
      integration_id: 'claude',
      repo_id: null,
      features_installed: [],
      features_declined: [],
      features_uninstalled: [],
      is_global: false,
      is_interactive: true,
      is_from_router: false,
    });

    await commitTelemetryFacts([analysis, integration], { agentSessionId: 'sess-1' });

    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy.mock.calls[0][0]).toBe('CliAnalysisCompleted');
    expect(emitSpy.mock.calls[0][1]).toEqual(ANALYSIS_PAYLOAD);
    expect(emitSpy.mock.calls[0][2]).toEqual({
      eventTimestampMs: analysis.timestamp,
      agentSessionId: 'sess-1',
      auth: undefined,
      identity: undefined,
    });
    expect(emitSpy.mock.calls[1][0]).toBe('CliIntegrationConfigured');
  });

  it('forwards fact.auth with its resolved identity to emitTelemetryEvent', async () => {
    const emitSpy = spyOn(telemetryEvents, 'emitTelemetryEvent').mockResolvedValue();
    spyOn(telemetryEvents, 'canEmitTelemetryEvents').mockReturnValue(true);
    spyOn(identity, 'resolveCommandTelemetryIdentity').mockResolvedValue(IDENTITY);
    const auth = cloudAuth('test-token');
    const analysis = fact('CliAnalysisCompleted', ANALYSIS_PAYLOAD, auth);

    await commitTelemetryFacts([analysis]);

    expect(emitSpy.mock.calls[0][2]).toEqual({
      eventTimestampMs: analysis.timestamp,
      agentSessionId: undefined,
      auth,
      identity: IDENTITY,
    });
  });

  it('resolves identity once per connection, however many facts share it', async () => {
    const emitSpy = spyOn(telemetryEvents, 'emitTelemetryEvent').mockResolvedValue();
    spyOn(telemetryEvents, 'canEmitTelemetryEvents').mockReturnValue(true);
    const resolveSpy = spyOn(identity, 'resolveCommandTelemetryIdentity').mockResolvedValue(
      IDENTITY,
    );

    await commitTelemetryFacts(
      [
        fact('CliCommandExecuted'),
        fact('CliTargetProjectResolved', {}, cloudAuth('invocation-token')),
        fact('CliTargetProjectResolved', {}, cloudAuth('other-token')),
        fact('CliTargetProjectResolved', {}, cloudAuth('other-token')),
      ],
      { auth: cloudAuth('invocation-token') },
    );

    expect(emitSpy).toHaveBeenCalledTimes(4);
    expect(resolveSpy.mock.calls.map(([auth]) => auth?.token)).toEqual([
      'invocation-token',
      'other-token',
    ]);
  });

  it('resolves no identity when telemetry events cannot be emitted', async () => {
    spyOn(telemetryEvents, 'emitTelemetryEvent').mockResolvedValue();
    spyOn(telemetryEvents, 'canEmitTelemetryEvents').mockReturnValue(false);
    const resolveSpy = spyOn(identity, 'resolveCommandTelemetryIdentity');

    await commitTelemetryFacts([fact('CliCommandExecuted')], { auth: cloudAuth('token') });

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('swallows emit failures', async () => {
    const emitSpy = spyOn(telemetryEvents, 'emitTelemetryEvent').mockRejectedValue(
      new Error('boom'),
    );
    await commitTelemetryFacts([fact('CliAnalysisCompleted')]);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('no-ops inside a flush worker', async () => {
    const previous = process.env[TELEMETRY_FLUSH_MODE_ENV];
    process.env[TELEMETRY_FLUSH_MODE_ENV] = '1';
    try {
      const emitSpy = spyOn(telemetryEvents, 'emitTelemetryEvent').mockResolvedValue();
      await commitTelemetryFacts([fact('CliAnalysisCompleted')]);
      expect(emitSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv(TELEMETRY_FLUSH_MODE_ENV, previous);
    }
  });
});
