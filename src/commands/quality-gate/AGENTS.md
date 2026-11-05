# Quality gate status

- Use `QualityGatesClient.getProjectStatus()` for both Cloud and Server; the project-status endpoint has the same contract.
- Keep branch/PR resolution in `resolveQualityGateScope()`. Explicit branch and pull-request options are mutually exclusive and take priority; otherwise reuse `autoResolvePullRequest()` before current/default branch fallback. Always report which scope was used.
- The shared PR resolver queries SonarQube's analyzed PR records, not the DevOps provider; a surviving local branch can still match a merged PR.
- Keep file/directory condition scoping in `file-scope-conditions.ts`. Preserve the `NOT_APPLICABLE` verdict and the distinction between verdict computation and category-controlled breakdowns.
- Format rating values with decimal-aware `formatMetricValue()`.
