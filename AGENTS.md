# Agent Guidance

# Tasks
- When picking up a task, mark it as in progress.
- Add comments to the task whenever changes are made by request, with justification and explanation.
- Do not automatically commit, push or close a task until confirmation is given.

# Deep modules

Prefer deep modules: hide real complexity behind small, stable interfaces.

- Avoid shallow wrappers and pass-through abstractions.
- Keep public APIs minimal and intentional.
- Put complexity inside modules, not in callers.
- Extract only when the boundary makes callers simpler.
- If the depth is unclear, keep the code local and direct.

# Testing

- All new work requires tests. Tests live alongside the file they're testing e.g. scanner.ts -> scanner.spec.ts.
- BDD GIVEN, WHEN, THEN, SHOULD, SHOULD NOT syntax is required.
- Only 1 GIVEN, WHEN, THEN keyword per describe. Prefer nested if needed.

# Self-review

When work is considered complete, and before comitting, pushing and opening a PR, perform a review. Fix any issues that are flagged. Repeat until no issues remain. Then continue with PR creation.
