# Agent Guidance

Prefer deep modules: hide real complexity behind small, stable interfaces.

- Avoid shallow wrappers and pass-through abstractions.
- Keep public APIs minimal and intentional.
- Put complexity inside modules, not in callers.
- Extract only when the boundary makes callers simpler.
- If the depth is unclear, keep the code local and direct.
