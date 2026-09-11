---
paths:
  - 'src/core/server/**'
  - 'src/core/vortex/entitlement.ts'
  - 'src/commands/**/*-api.ts'
  - 'src/commands/analyze/sqaa-analysis-client.ts'
---

# SonarQube API layer

HTTP is split in two (CLI-842). `SonarHttpClient` (`src/core/server/http-client.ts`) is the **only**
class that knows about transport: headers, timeouts, request bodies, and how a non-2xx response
becomes a typed error (`get` / `getOrNullIf404` / `getSafe` / `post` / `postForm` / `postFormJson`,
plus `genericRequest` for `sonar api` only); every one of them issues its request through
`fetchAuthenticated`, since they all carry the bearer token. It also exposes `apiHostFor(endpoint)`,
which resolves the region-specific Cloud API host for an endpoint family — call sites pass its
result as `baseUrl` instead of reaching for `resolveFromEndpoint` themselves.

Everything above transport is a small per-domain wrapper taking a `SonarHttpClient`, living next to
whoever uses it. Shared domains stay in `src/core/server/`: `OrganizationsClient`
(`organizations.ts`, also home to `Organization` / `OrganizationRecord` / `OrganizationAccess`),
`ComponentsClient`
(`components.ts`), `UsersClient` (`users.ts`), `SystemClient` (`system.ts`), `EnterprisesClient`
(`enterprises.ts`, Cloud only), `ProjectBindingsClient`
(`project-bindings.ts`) and `ScaClient` (`sca.ts`), alongside the pre-existing `BranchesClient`,
`IssuesClient`, `MeasuresClient`, `MetricsClient`, `ProjectsClient` and `QualityGatesClient`.
Command-specific surfaces sit with their command: `ImportApiClient`
(`src/commands/import/_common/import-api.ts`, owning `DopRepository` / `ProvisionedProject`),
`RemediateApiClient` (`src/commands/remediate/remediate-api.ts`, owning the agent-job types),
`OnboardCiSqsClient` (`src/commands/admin/onboard-ci/gitlab/sqs-api.ts`), `SqaaAnalysisClient`
(`src/commands/analyze/sqaa-analysis-client.ts`, with the wire shapes in `sqaa-wire-types.ts`), the
`ScaScanApi` port (`src/commands/analyze/dependency-risk-helpers/sca-api.ts`), and
`VortexEntitlementClient` (`src/core/vortex/entitlement.ts`, owning `VortexEntitlementResult` /
`VortexEntitlementStatus` and `SERVER_ORGANIZATION_ID_PLACEHOLDER`).

Three rules hold across all eighteen of them, with no exception — keep it that way when adding one.

**Every API client is constructed from a `SonarHttpClient`**, never from a `(serverUrl, token)` pair
it turns into one itself. The command handler builds the transport client once and passes it in, so
a single instance can be shared by every domain client in a run — which is what keeps
`OrganizationsClient`'s organization cache effective instead of one cache per caller.

**A command-level client that needs a shared domain client exposes it as a `readonly` field**
(`ImportApiClient.organizations`, `RemediateApiClient.issues` / `.components`) rather than
re-declaring its methods as one-line forwards. A forwarding method duplicates a signature in a
second file for no gain: it has to be edited whenever the real one changes, and nothing catches a
drift. Callers write `client.organizations.getOrganizationAlmKey(key)`. For the same reason these
classes derive rather than copy what the transport already knows — `ImportApiClient.isCloud` is a
getter over `client.isCloud`, not a field set in the constructor.

**A free function taking a client as its first parameter is the shape to avoid**: when the logic
belongs to one client, it is a private method on it (see `VortexEntitlementClient.sqaaEndpoint`).
A few shapes stay functions. `mergeVortexEntitlement` takes no client at all — it is a pure function
of two results. `checkHubEntitlement` does take one, and stays a function anyway because it belongs
to no single client: it is the response mapper the SQAA and CAG hubs share. Command-local query
helpers whose parameters are command-specific (`fetchEligibleIssues` in
`src/commands/remediate/index.ts`, the measures helpers in `src/commands/quality-gate/status/`)
also stay functions — the filters they hardcode are that command's policy, not the client's.

New API calls belong in the domain wrapper for their area, never back in the transport class.
