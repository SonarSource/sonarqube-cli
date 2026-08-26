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

import { TelemetryFact } from '@/commands/command-invocation-context.ts';
import { commitTelemetryFacts } from '@/commands/telemetry-facts.ts';
import { TELEMETRY_FLUSH_MODE_ENV } from '@/core/telemetry';
import * as telemetryEvents from '@/core/telemetry/telemetry-events.ts';

import { restoreEnv } from '../../_common/isolated-cli-env.ts';

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

function fact(name: string, payload: object = ANALYSIS_PAYLOAD): TelemetryFact {
  return new TelemetryFact(name, payload, 1_700_000_000_000);
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
    });
    expect(emitSpy.mock.calls[1][0]).toBe('CliIntegrationConfigured');
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
