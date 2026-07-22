## Command executed

```json
{
  "metadata": {
    "event_id": "eb93b2b4-f7b0-4b5c-9460-50893968c264",
    "source": { "domain": "CLI" },
    "event_type": "Analytics.Cli.CliCommandExecuted",
    "event_timestamp": "1740670309173"
  },
  "event_payload": {
    "cli_installation_id": "b1f2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "machine_id": "9d0cf582-219e-4bab-8311-d599c55c4ce2",
    "cli_version": "1.5.0",
    "invocation_id": "3e44541a-124b-4c56-9d78-0a2f395e71bd",
    "os": "linux",
    "connection_type": "sqs",
    "user_uuid": null,
    "organization_uuid_v4": null,
    "sqs_installation_id": "47c92694-6739-4fb0-8112-9840a2f39561",
    "caller_agent": null,
    "command": "auth",
    "subcommand": "login",
    "result": "success",
    "distribution": "standalone"
  }
}
```

## Analysis completed

```json
{
  "metadata": {
    "event_id": "eb93b2b4-f7b0-4b5c-9460-50893968c261",
    "source": { "domain": "CLI" },
    "event_type": "Analytics.Cli.CliAnalysisCompleted",
    "event_timestamp": "1740670312415"
  },
  "event_payload": {
    "cli_installation_id": "b1f2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "machine_id": "9d0cf582-219e-4bab-8311-d599c55c4ce2",
    "cli_version": "1.5.0",
    "invocation_id": "3e44541a-124b-4c56-9d78-0a2f395e71bd",
    "os": "linux",
    "connection_type": "sqc",
    "user_uuid": "7a349181-6417-4164-8c89-46e113b5824c",
    "organization_uuid_v4": "c3b587a4-2990-4b0e-8f65-a56a3ef30e0e",
    "sqs_installation_id": null,
    "caller_agent": "claude",
    "caller_command": "analyze secrets",
    "analyzer": "sonar-secrets",
    "analysis_id": "d21d2069-7190-4b0e-8f06-891f7eb0c4ee",
    "findings_count": 3,
    "exit_code": 51,
    "errors_count": 0,
    "failures_count": 0,
    "scan_duration_ms": 272,
    "details": "{\"counts_by_rule\":{\"secrets:S6689\":1,\"secrets:S6731\":1,\"secrets:S6732\":1},\"files_with_findings_count\":1,\"source\":\"files\"}"
  }
}
```

## Integration configured

```json
{
  "metadata": {
    "event_id": "5a824c5e-71bd-4c4e-8e17-2299261d7801",
    "source": { "domain": "CLI" },
    "event_type": "Analytics.Cli.CliIntegrationConfigured",
    "event_timestamp": "1740670318907"
  },
  "event_payload": {
    "cli_installation_id": "b1f2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "machine_id": "9d0cf582-219e-4bab-8311-d599c55c4ce2",
    "cli_version": "1.5.0",
    "invocation_id": "3e44541a-124b-4c56-9d78-0a2f395e71bd",
    "os": "win32",
    "connection_type": "sqc",
    "user_uuid": "7a349181-6417-4164-8c89-46e113b5824c",
    "organization_uuid_v4": "c3b587a4-2990-4b0e-8f65-a56a3ef30e0e",
    "sqs_installation_id": null,
    "caller_agent": null,
    "integration_id": "claude-code",
    "repo_id": "3e2b4c1d0a9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a4938271605f",
    "features_installed": [
      "sonar-secrets-hooks",
      "sonar-sqaa-hook",
      "sqaa-instructions",
      "mcp-server",
      "context-augmentation"
    ],
    "features_declined": [],
    "features_uninstalled": [],
    "is_global": false,
    "is_interactive": true,
    "is_from_router": false
  }
}
```

