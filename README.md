# opencode-roles

`opencode-roles` is an OpenCode plugin that adds role routing, lazy role activation, and role-scoped skill loading.

It is designed for public npm distribution so any OpenCode user can install it through the standard plugin mechanism documented by OpenCode.

## What it does

The plugin does three things:

1. Injects `<available_roles>` metadata into the system prompt.
2. Registers a `role_load` tool that loads one role and activates its role skills for the current session.
3. Overrides `skill({ name })` so normal skills keep working, while role skills remain unavailable until their role is activated.

## Install

OpenCode supports public plugins from npm through `opencode.json`.

Add this plugin package name to your config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-roles"]
}
```

After restarting OpenCode, it will install the package automatically with Bun and cache it under `~/.cache/opencode/node_modules/`.

Source: [OpenCode plugin docs](https://opencode.ai/docs/zh-cn/plugins/)

## Local development install

If you are developing this plugin locally before publishing, build it and reference the built file from a local plugin directory:

```bash
npm install
npm run build
```

Then copy or symlink `dist/index.js` into one of the official plugin directories:

- `.opencode/plugins/`
- `~/.config/opencode/plugins/`

Public distribution should use the npm install path above.

## Role layout

The default workspace layout is:

```text
.opencode/
  roles/
    config.json
    frontend-architect/
      ROLE.md
    backend-reviewer/
      ROLE.md
    skill/
      react-performance/
        SKILL.md
      sql-safety/
        SKILL.md
```

`ROLE.md` must contain frontmatter:

```md
---
name: frontend-architect
description: Design frontend architecture and enforce maintainable UI decisions
---
```

Each role must also include a section named `## Available role skills`, for example:

```md
## Available role skills

- `react-performance`: Optimize rendering, state boundaries, and hydration behavior
- `design-systems`: Enforce reusable UI primitives and token discipline
```

Role skills are resolved from:

```text
.opencode/roles/skill/<skill-name>/SKILL.md
```

## Optional role roots

You can add extra role roots in `.opencode/roles/config.json`:

```json
{
  "paths": [
    ".shared/opencode-roles",
    "~/company/opencode-roles"
  ]
}
```

Relative paths resolve from the workspace root.

## Runtime behavior

- The plugin injects only role `name` and `description` into the system prompt.
- The model is expected to call `role_load({ name })` before using a role skill.
- `skill({ name })` first checks activated role skills, then falls back to normal OpenCode skills.
- If a role skill exists but its role was not activated, the tool returns a directed error telling the model to call `role_load`.
- If multiple roles declare the same role skill, the plugin reports a conflict instead of guessing.

## Publish

Publish this package as a normal npm package:

```bash
npm publish --access public
```

Recommended release workflow:

1. Run `npm install`
2. Run `npm run check`
3. Run `npm run build`
4. Publish to npm
5. Add the package name to `opencode.json`

## Notes

- This package currently assumes the published package name is `opencode-roles`.
- The package exports the plugin as both the default export and the named export `OpenCodeRolesPlugin`.
- `role-skill.ts` in this repository is kept as the original reference implementation; the publishable entrypoint is `src/index.ts`.
