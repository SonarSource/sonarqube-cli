# Command lifecycle

CLI labels map to the company lifecycle definitions: Experimental = Alpha, Preview = Beta, and Stable = GA.

Commands and staged options use `[EXPERIMENTAL]` for `Stage.Alpha` and `[PREVIEW]` for `Stage.Beta()`, including gated Private Beta. Stable has no tag. Deprecated retains `[DEPRECATED]`.

Experimental commands require `SONARQUBE_CLI_ALPHA=true|1`. They appear in a separate help group and print an informational notice on stderr on every invocation. Public documentation excludes them.

Preview commands print an informational notice on stderr once per CLI version. Private Beta still requires its existing feature flag. Public documentation includes Open Beta with a preview badge.

Machine-readable stage values remain `alpha` and `beta`. The Stage API, feature flag keys and persisted notice keys retain these names for compatibility.
