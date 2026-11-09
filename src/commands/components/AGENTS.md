# Shared command UI

A component belongs here only when it renders user-visible output or drives a prompt, and at least two commands use it (or a second consumer is named in a ticket).

Keep single-command UI beside its command. Put domain logic and data shaping in the owning `src/core/` module; console primitives belong in `src/core/ui/`. Group shared components by domain.
