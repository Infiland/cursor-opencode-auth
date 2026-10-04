---
description: Let Cursor make a change in a temporary worktree, then apply it
agent: build
---
Call the `cursor_cli_patch` tool with `apply: true` and this task as the prompt:

$ARGUMENTS

If the tool reports uncommitted changes, ask me whether to retry with `allowDirty: true` (Cursor then starts from my current files).

Afterwards, list the files that changed and summarize what Cursor did. If the patch is empty, explain why and stop. If applying the patch failed, show the error and the patch, and do not apply it another way.
