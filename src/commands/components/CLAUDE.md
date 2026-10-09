# Components

This folder holds UI pieces that more than one command reuses, such as a formatted row list or an interactive picker. Each subfolder groups the pieces for one domain (for example `organization/`).

A file belongs here only when both conditions hold:

- It renders output or drives a prompt that the user sees.
- At least two commands use it, or a second command is planned and named in a ticket.

Do not add these here:

- Code used by one command. Keep it next to that command.
- Domain logic or data shaping with no display. Use `src/core/`.
- Generic helpers with no UI role. Put them in the module that owns the concept.
- Console primitives such as colors, notes and base prompts. They live in `src/core/ui/`.
