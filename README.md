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

## Release workflow

This repository now includes GitHub Actions workflows for CI and npm publishing:

- `.github/workflows/ci.yml`: runs `npm install`, `npm run check`, and `npm run build` on pushes to `main` and on pull requests.
- `.github/workflows/publish.yml`: publishes to npm when you push a tag like `v0.1.0`.
- `.github/workflows/release.yml`: manual workflow that bumps `package.json`, commits the version change, and creates the matching git tag.

Before the first publish, add an `NPM_TOKEN` repository secret in GitHub with permission to publish this package.

Recommended release flow:

1. In GitHub, set repository secret `NPM_TOKEN`.
2. Run the `Release` workflow and provide a version like `0.1.1`.
3. The workflow commits the version bump and pushes tag `v0.1.1`.
4. The `Publish` workflow validates that the tag matches `package.json`, then publishes to npm.
5. OpenCode users install the package through `opencode.json`.

If you prefer releasing locally, this still works:

```bash
npm install
npm run check
npm run build
npm publish
```

## Notes

- This package currently assumes the published package name is `opencode-roles`.
- The package exports the plugin as both the default export and the named export `OpenCodeRolesPlugin`.
- `role-skill.ts` in this repository is kept as the original reference implementation; the publishable entrypoint is `src/index.ts`.
