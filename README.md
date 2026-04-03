# opencode-roles

**English** | [简体中文](./README.zh-CN.md)

`opencode-roles` is an OpenCode plugin that adds a role layer on top of the normal skill system.

It helps the model choose a domain-specific role first, then load that role's full instructions and role-specific skills only when needed.

## Important

This plugin supports progressive skill disclosure through roles.

That matters because a traditional skill-only setup tends to expose every available skill up front. As the number of skills grows, too many unrelated skills get pulled into the model's decision space at the same time.

That usually leads to three problems:

- unnecessary context usage
- weaker task routing
- more confusion between similar skills

With `opencode-roles`, the model only sees lightweight role metadata first. The full role instructions and role-specific skills are revealed only after that role is selected and loaded.

In practice, this keeps the prompt cleaner, reduces noise, and makes it easier for the model to use the right skills for the right task.

## What is a role

In this plugin, a `role` is a reusable expert identity for a specific domain or task type.

A role usually defines:

- who the model should act as
- what it should pay attention to
- how it should reason
- which role-specific skills it can use

Examples:

- `frontend-architect`
- `backend-reviewer`
- `code-reviewer`

A normal skill is a single capability.

A role is a full working perspective.

The role decides how the model should approach the task. The skill helps the model perform a more specific subtask inside that role.

## Why use roles

Roles are useful when you want OpenCode to behave differently across different kinds of work.

Common use cases:

- frontend architecture questions should be handled like a frontend architect
- API design reviews should be handled like a backend reviewer
- code review tasks should follow a consistent review style
- role-specific instructions should not always live in the global system prompt
- large skill libraries should not all be exposed to the model at once

## What this plugin does

The plugin adds three behaviors:

1. It scans your available roles and injects only each role's `name` and `description` into the system prompt.
2. It provides a `role_load` tool that loads one role's full instructions.
3. It overrides `skill({ name })` so role skills are only available after their role is activated.

This keeps the default prompt lightweight while still allowing rich domain-specific behavior.

## Installation

Create or update `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-roles"]
}
```

Then restart OpenCode.

OpenCode will install the npm package through its normal plugin mechanism.

## Directory layout

Default layout:

```text
.opencode/
  roles/
    frontend-architect/
      ROLE.md
    backend-reviewer/
      ROLE.md
    skill/
      react-performance/
        SKILL.md
      api-contracts/
        SKILL.md
```

Rules:

- each role has its own directory
- each role directory must contain `ROLE.md`
- role skills live under `.opencode/roles/skill/<skill-name>/SKILL.md`

## ROLE.md format

Each role must include frontmatter with:

- `name`
- `description`

Example:

```md
---
name: frontend-architect
description: Design frontend architecture, component boundaries, and UI implementation strategy
---

You are the frontend architect role.

Focus on:
- component boundaries
- state placement
- rendering behavior
- maintainable UI structure

## Available role skills

- `react-performance`: Optimize React rendering, state boundaries, and unnecessary rerenders
```

Requirements:

- `name` must use lower-case hyphenated format such as `frontend-architect`
- `description` is exposed to the model as role metadata
- the file must contain a `## Available role skills` section
- every listed skill must exist under `.opencode/roles/skill/`

## SKILL.md format

Role skills use the same `SKILL.md` format as normal skills.

Example:

```md
---
description: Improve React rendering performance and state boundaries
---

# React Performance

Use this skill when reviewing React code for:
- unnecessary rerenders
- state placed too high in the tree
- unstable props or closures
- over-coupled components
```

## How it works at runtime

The expected flow is:

1. the model sees the available roles
2. it chooses the best role for the task
3. it calls `role_load({ name })`
4. the role becomes active for the session
5. it can then call `skill({ name })` for that role's skills

Example task routing:

- React architecture problem -> `frontend-architect`
- API contract review -> `backend-reviewer`
- code review task -> `code-reviewer`

## Behavior rules

- only role `name` and `description` are injected into the system prompt
- full role instructions are loaded lazily through `role_load`
- role skills require their role to be activated first
- if a role skill is requested too early, the plugin tells the model to call `role_load`
- if a normal skill and a role skill share the same name, normal skill fallback still works until the role is activated
- multiple roles can declare the same role skill, because role skills are treated as a shared skill library

## Optional extra role roots

If you do not want to keep all roles under `.opencode/roles`, add extra roots in `.opencode/roles/config.json`:

```json
{
  "paths": [
    ".shared/opencode-roles",
    "~/company/opencode-roles"
  ]
}
```

Notes:

- relative paths are resolved from the workspace root
- `~/` is resolved from the user home directory
- roles from all configured roots are merged

## Troubleshooting

If the plugin does not appear to work, check these first:

1. `opencode.json` includes `"plugin": ["opencode-roles"]`
2. OpenCode was restarted after editing config
3. `ROLE.md` contains valid frontmatter
4. `ROLE.md` contains `## Available role skills`
5. every listed role skill exists in `.opencode/roles/skill/<skill-name>/SKILL.md`

Common mistakes:

- invalid role name format
- missing `description`
- missing `## Available role skills`
- a role references a skill that does not exist
- a shared role skill exists on disk, but the relevant role was not loaded before calling it

## Minimal example

```text
.opencode/
  roles/
    code-reviewer/
      ROLE.md
    skill/
      review-checklist/
        SKILL.md
```

`ROLE.md`

```md
---
name: code-reviewer
description: Perform practical code review with emphasis on bugs, regressions, and missing tests
---

You are the code reviewer role.

Focus on:
- correctness
- regressions
- missing tests

## Available role skills

- `review-checklist`: Review code using a checklist for bugs, regressions, and missing tests
```

`SKILL.md`

```md
---
description: Review code using a checklist for bugs, regressions, and missing tests
---

# Review Checklist

When reviewing code, check:
- correctness under edge cases
- behavioral regressions
- missing tests for changed paths
```

## Final config

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-roles"]
}
```
