#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

REQUEST_TIMEOUT_SECONDS = 30
TOKEN_LIFETIME = timedelta(hours=6)
BROWSE_ROLE = "user"
EXPIRY_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def require_environment(*names: str) -> dict[str, str]:
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        sys.exit(f"sonar-run-token: {', '.join(missing)} must be set")
    return {name: os.environ[name] for name in names}


def call(method: str, api_url: str, admin_token: str, path: str, payload: dict | None = None) -> dict | list:
    request = urllib.request.Request(
        f"{api_url}/{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        sys.exit(f"sonar-run-token: {method} {path.split('?')[0]} failed with HTTP {error.code}")
    except OSError as error:
        sys.exit(f"sonar-run-token: {method} {path.split('?')[0]} failed: {type(error).__name__}")
    return json.loads(body) if body else {}


def find_identifiers(api_url: str, admin_token: str, organization_key: str, project_key: str) -> tuple[str, str]:
    organizations = call(
        "GET",
        api_url,
        admin_token,
        "organizations/organizations?"
        + urllib.parse.urlencode({"organizationKey": organization_key, "excludeEligibility": "true"}),
    )
    if not organizations:
        sys.exit(f"sonar-run-token: organization {organization_key} not found")
    organization_id = organizations[0]["uuidV4"]
    projects = call(
        "GET",
        api_url,
        admin_token,
        "projects/projects?" + urllib.parse.urlencode({"keys": project_key, "organizationIds": organization_id}),
    )["projects"]
    if not projects:
        sys.exit(f"sonar-run-token: project {project_key} not found")
    return organization_id, projects[0]["id"]


def delete_token(api_url: str, admin_token: str, token_id: str) -> None:
    call("DELETE", api_url, admin_token, f"authentication/token-definitions/{urllib.parse.quote(token_id, safe='')}")


def create_token(name: str) -> dict[str, str]:
    environment = require_environment("HB_SONAR_API_URL", "HB_SONAR_ADMIN_TOKEN", "HB_SONAR_ORG", "HB_SONAR_PROJECT")
    api_url = environment["HB_SONAR_API_URL"]
    admin_token = environment["HB_SONAR_ADMIN_TOKEN"]
    organization_id, project_id = find_identifiers(
        api_url, admin_token, environment["HB_SONAR_ORG"], environment["HB_SONAR_PROJECT"]
    )
    created = call(
        "POST",
        api_url,
        admin_token,
        "authentication/token-definitions",
        {
            "name": name,
            "organizationId": organization_id,
            "expiresAt": (datetime.now(timezone.utc) + TOKEN_LIFETIME).strftime(EXPIRY_FORMAT),
            "roleAssignments": [{"resourceType": "project", "roles": [BROWSE_ROLE]}],
            "autoGrantProjectPermissions": False,
        },
    )
    try:
        call(
            "POST",
            api_url,
            admin_token,
            "authentication/token-resource-links",
            {"organizationTokenId": created["id"], "resourceType": "project", "resourceId": project_id},
        )
    except SystemExit:
        delete_token(api_url, admin_token, created["id"])
        raise
    return {"id": created["id"], "token": created["token"]}


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("create").add_argument("--name", required=True)
    commands.add_parser("delete").add_argument("--id", required=True)
    return parser.parse_args(argv)


def main(argv: list[str]) -> None:
    arguments = parse_arguments(argv)
    if arguments.action == "create":
        print(json.dumps(create_token(arguments.name)))
    else:
        environment = require_environment("HB_SONAR_API_URL", "HB_SONAR_ADMIN_TOKEN")
        delete_token(environment["HB_SONAR_API_URL"], environment["HB_SONAR_ADMIN_TOKEN"], arguments.id)


if __name__ == "__main__":
    main(sys.argv[1:])
