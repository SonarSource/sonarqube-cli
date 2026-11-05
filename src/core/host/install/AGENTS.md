# Dependency executable installation

- Download into a private staging directory beside the cache. Verify signatures, set permissions, and complete the version probe **before** publishing an executable.
- Normal installs publish with an atomic hard link; concurrent publishers keep the first verified installation. Forced refreshes use atomic rename.
- Preserve the existing executable when replacement fails, including Windows sharing violations. **Never add an unlink-before-rename fallback.**
- Verify archive signatures before extracting dependency executables. Use the shared download transport and declared pinned versions when recording dependencies.
- Dependency artifact naming is separate from CLI release naming; retain each dependency's declared release configuration. Read [build guidance](../../../../build-scripts/AGENTS.md) before changing download conventions.
