# dal-workflow-tools (source only)

This package is the **pinned source** of a future workspace plugin that would expose the workflow-state tools (read task, apply refund, change booking) to dsh sessions in this benchmark workspace.

It is deliberately not installed:

- Installing a plugin into a profile is a sensitive action in dal and requires an exact, unexpired human approval verified with `dal approval verify`.
- The intended deployment is install-from-local-path: the profile installs this workspace-owned source as a derived generation; rollback reinstalls the previous pinned generation.
- The improvement loop edits this source (a `harness_code` / `tool_descriptions` editable surface), never the installed profile directly.

No `src/index.ts` ships yet; adding it is the first implementation milestone behind the promotion gates.
