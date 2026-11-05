# Declarative integration framework

- Keep the engine independent of CLI commands. Integration descriptors import factories and operations from `@/core/framework/features`; thin command handlers delegate generic selection, install, and recording to `install-integration.ts`.
- Resource removers must preserve user/other-feature content. Delete emptied snippet files and patch documents pruned to their default value; leave parent directories intact. Whole-file resources require exclusive ownership.
- A container owns shared assets; active subfeatures inherit its scope, target root, and attrs. Resource/operation ids must be unique across the container and subfeatures. Use `recordedFeatureResources()` and `recordedFeatureOperations()` when reading the complete recorded asset set.
- Removal/reconciliation must include recorded subfeature assets and undoable operations, including subfeatures no longer active. Collect dependencies from active subfeatures as well as the container.
- Availability checks distinguish available, unavailable, and unknown (`undefined`, failed check). Unknown must preserve the installed item. Evaluate a subfeature only after its container is available; use `required: true` when it has no further condition.
- Recommendation previews never prompt. Only Customize refines the selection interactively.
- Executable resources add all POSIX execute bits while preserving other permissions; ordinary resources preserve existing modes. Windows does not use these permission checks.
- Finish slow installation/reconciliation outside the state lock, then apply recorded changes against the latest state through `updateState()`. Read [state/auth guidance](../../../docs/development/agent-guidance/state-and-auth.md).
