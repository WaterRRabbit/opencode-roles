# Role Plugin Implementation Notes

This document summarizes the implementation approach for the role system plugin only.

It is intended for rebuilding the feature as a standalone OpenCode plugin that other OpenCode users can install without depending on TeamClaw frontend behavior.

## Scope

The plugin is responsible for three things:

1. Injecting lightweight role metadata into the system prompt
2. Providing a role-loading tool
3. Overriding the built-in `skill` tool so role skills can be loaded lazily while normal skills continue to work

This document does not cover:

- TeamClaw sidebar UI
- Settings panels
- runtime plugin installer logic
- local desktop-specific presentation

## Core Plugin Responsibilities

### 1. Inject available roles into the system prompt

The plugin should scan role roots, extract only:

- `name`
- `description`

and append them to the system prompt as:

```xml
<available_roles>
  <role>
    <name>java-sort-reviewer</name>
    <description>Review Java sorting implementations, explain complexity, and improve examples</description>
  </role>
</available_roles>
```

It should also append a short routing rule that tells the model:

- choose a role first
- call `role_load({ name })` to load the role body and role skill index
- use `skill({ name })` afterwards
- role skills are only available after `role_load`

### 2. Provide `role_load`

The plugin should register a tool named:

```text
role_load
```

Responsibilities:

- load one `ROLE.md`
- parse its body sections
- return the role instructions and role skill index
- activate that role for the current session

### 3. Override `skill`

The plugin should register a tool named:

```text
skill
```

This intentionally overrides the built-in OpenCode `skill`.

Responsibilities:

- keep normal skill loading working
- load role skills lazily
- require `role_load` before a role skill can be used

## OpenCode Plugin Hooks

The plugin should use two entry points.

### `experimental.chat.system.transform`

Use this to inject `<available_roles>` into `output.system`.

Important:

- do not depend on `output.session.directory`
- do not depend on `output.directory`
- in practice this hook may expose only `system`

The workspace path must be captured from plugin initialization, not from the transform hook output.

### `tool`

Use this to register:

- `role_load`
- `skill`

## Plugin Skeleton

Recommended shape:

```ts
export default async function RoleSkillPlugin({ directory, worktree, client }) {
  const workspaceDir = directory || worktree

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      // append available_roles
    },
    tool: {
      role_load: {
        // load one role and activate it for the session
      },
      skill: {
        // resolve role skills first when activated, otherwise fall back
      },
    },
  }
}
```

## Reference Implementation Notes

The current in-repo implementation lives in:

[role-skill-plugin.ts.txt](/Users/haigang.ye/project/external/teamclaw/packages/app/src/lib/opencode/templates/role-skill-plugin.ts.txt)

It is a runtime-installed template in TeamClaw today, but its internal logic is the closest reference for a standalone plugin rewrite.

The most important implementation decisions are below.

### Constants and session state

The current implementation keeps a small in-memory session activation store and a fixed set of local/global skill roots:

```ts
const ROLE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const sessionRoleState = new Map()

const NORMAL_SKILL_PATHS = [
  [".opencode", "skills"],
  [".claude", "skills"],
  [".agents", "skills"],
]

const GLOBAL_SKILL_PATHS = [
  [os.homedir(), ".config", "opencode", "skills"],
  [os.homedir(), ".claude", "skills"],
  [os.homedir(), ".agents", "skills"],
]
```

This is good enough for the current plugin, but for a public rewrite it would be better to formalize the session state type and align normal skill lookup with OpenCode's built-in resolution order as closely as possible.

### Role routing rule injection text

The plugin appends a small routing policy string after `<available_roles>`:

```ts
const ROLE_DISCLOSURE_RULES = [
  "Role routing rule:",
  "When a task appears domain-specific, first choose the most relevant role from <available_roles>.",
  "Use role_load({ name }) to load that role's full instructions and its role-specific skill index.",
  "The skill({ name }) tool supports both normal skills and role skills.",
  "Role skills are only available after their role has been activated with role_load({ name }).",
  "If a role is not activated and a normal skill with the same name exists, skill({ name }) falls back to the normal skill.",
].join(" ")
```

The rewrite should keep the rule concise and deterministic.

## Reference Parsing Logic

### Frontmatter parsing

The current implementation uses a minimal parser instead of a full YAML library:

```ts
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    throw new Error("Missing frontmatter")
  }

  let name = ""
  let description = ""

  for (const rawLine of match[1].split("\n")) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("name:")) {
      name = trimmed.slice("name:".length).trim()
      continue
    }

    if (trimmed.startsWith("description:")) {
      description = trimmed.slice("description:".length).trim()
      continue
    }
  }

  if (!name || !ROLE_NAME_PATTERN.test(name)) {
    throw new Error("Invalid or missing role name")
  }

  if (!description) {
    throw new Error("Missing role description")
  }

  return {
    data: { name, description },
    body: match[2].trim(),
  }
}
```

For a public plugin, this is acceptable if the allowed frontmatter remains intentionally tiny. If broader metadata is ever introduced, a proper YAML parser becomes a better choice.

### `## Available role skills` parsing

The current implementation extracts the skill index from the body:

```ts
function parseAvailableRoleSkills(body) {
  const lines = body.split("\n")
  const skills = []
  let inSection = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!inSection) {
      if (/^##\s+Available role skills$/i.test(line)) {
        inSection = true
      }
      continue
    }

    if (/^##\s+/.test(line)) {
      break
    }

    if (!line) continue

    const match = line.match(/^[-*]\s+`?([a-z0-9]+(?:-[a-z0-9]+)*)`?\s*:\s*(.+)$/)
    if (!match) continue

    const [, name, description] = match
    if (!ROLE_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid role skill "${name}" in Available role skills`)
    }
    skills.push({
      name,
      description: description.trim(),
    })
  }

  if (!inSection) {
    throw new Error('Missing "## Available role skills" section')
  }

  return skills
}
```

This is exactly the kind of logic the rewrite should preserve.

## Reference Role Root Resolution

The current implementation reads plugin-owned config from `.opencode/roles/config.json`:

```ts
async function readRoleConfig(workspaceDir) {
  const configPath = path.join(workspaceDir, ".opencode", "roles", "config.json")
  if (!(await pathExists(configPath))) return {}
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"))
  } catch {
    return {}
  }
}

async function resolveRoleRoots(workspaceDir) {
  const config = await readRoleConfig(workspaceDir)
  const configuredPaths = Array.isArray(config?.paths) ? config.paths : []
  const resolvedRoots = [path.join(workspaceDir, ".opencode", "roles")]

  for (const configuredPath of configuredPaths) {
    if (typeof configuredPath !== "string") continue
    resolvedRoots.push(
      configuredPath === "~"
        ? os.homedir()
        : configuredPath.startsWith("~/")
          ? path.join(os.homedir(), configuredPath.slice(2))
          : path.isAbsolute(configuredPath)
            ? configuredPath
            : path.join(workspaceDir, configuredPath),
    )
  }

  return Array.from(new Set(resolvedRoots.map((entry) => path.resolve(entry))))
}
```

This behavior should be kept in the standalone rewrite:

- default role root first
- plugin-owned config file
- support `~/...`, absolute, and relative roots

## Reference Role Index Builder

The current index builder is the core of the plugin. It:

- resolves role roots
- scans `ROLE.md`
- parses role frontmatter
- parses the role skill index
- validates referenced `SKILL.md` files
- tracks duplicate skill ownership

Representative structure:

```ts
async function loadRoleIndex(workspaceDir) {
  const roleRoots = await resolveRoleRoots(workspaceDir)
  const roles = new Map()
  const skillOwners = new Map()
  const conflicts = new Map()

  for (const roleRoot of roleRoots) {
    const roleSkillRoot = path.join(roleRoot, "skill")
    const roleEntries = await fs.readdir(roleRoot, { withFileTypes: true })

    for (const entry of roleEntries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue

      const rolePath = path.join(roleRoot, entry.name, "ROLE.md")
      if (!(await pathExists(rolePath))) continue

      const parsed = parseFrontmatter(await fs.readFile(rolePath, "utf8"))
      const listedSkills = parseAvailableRoleSkills(parsed.body)

      // build role object
      // verify skill files exist
      // track skill ownership
    }
  }

  for (const [skillName, owners] of skillOwners.entries()) {
    if (owners.length > 1) {
      conflicts.set(skillName, owners)
    }
  }

  return { roles, skillOwners, conflicts }
}
```

For a standalone rewrite, this is the most important internal module to keep clear and testable.

## Reference Prompt Injection

The current plugin injects roles through `experimental.chat.system.transform`:

```ts
export const RoleSkillPlugin = async ({ directory, worktree }) => {
  const pluginWorkspaceDir = directory || worktree

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const workspaceDir =
        pluginWorkspaceDir ||
        output.session?.directory ||
        output.session?.worktree ||
        output.directory ||
        output.worktree
      if (!workspaceDir) {
        console.error("[RolePlugin] system transform failed: missing workspace directory")
        return
      }

      const index = await loadRoleIndex(workspaceDir)
      const rolePrompt = buildAvailableRolesPrompt(index)
      if (!rolePrompt) return

      if (!Array.isArray(output.system)) {
        output.system = []
      }

      output.system.push(rolePrompt)
    },
  }
}
```

Important note for the rewrite:

- the fallback to `output.session?.directory` exists only as a defensive fallback
- the real fix was capturing `directory` / `worktree` at plugin initialization time
- the published plugin should rely on plugin init context first

## Reference `role_load` Implementation

The current implementation:

- resolves `context.directory || context.worktree`
- finds the role
- activates the role in memory
- loads and returns the role skill index

Representative code:

```ts
async function roleReadExecute(args, context) {
  const workspaceDir = context.directory || context.worktree
  if (!workspaceDir) {
    throw new Error("role_load requires a workspace directory")
  }

  const requestedRoleName = args?.name ?? args?.role
  if (!requestedRoleName || !String(requestedRoleName).trim()) {
    throw new Error("role_load requires a role name in args.name")
  }

  const { role } = await getRole(workspaceDir, requestedRoleName)
  const sessionEntry = getSessionEntry(context.sessionID)
  sessionEntry.activatedRoles.add(role.name)

  const skills = []
  for (const skill of role.skills) {
    const content = await fs.readFile(skill.path, "utf8")
    sessionEntry.activatedRoleSkills.add(skill.name)
    skills.push({
      name: skill.name,
      description: skill.description || extractSkillDescription(content, skill.name),
      source: "role",
    })
  }

  return [
    `# Role ${role.name}`,
    "",
    `Description: ${role.description}`,
    "",
    "## Instructions",
    role.body || "(empty)",
    "",
    "## Role Skills",
    ...skills.map((skill, index) => `${index + 1}. ${skill.name}: ${skill.description}`),
  ].join("\n")
}
```

Notes for the rewrite:

- this currently returns a Markdown string
- a public plugin may prefer returning structured JSON if OpenCode tool UX supports it well
- the session activation behavior should stay the same

## Reference Overridden `skill` Implementation

The current implementation resolves role skills first only when activated:

```ts
async function skillExecute(args, context) {
  const workspaceDir = context.directory || context.worktree
  if (!workspaceDir) {
    throw new Error("skill requires a workspace directory")
  }

  await ensureSkillAllowed(workspaceDir, args.name)

  const sessionEntry = getSessionEntry(context.sessionID)
  if (sessionEntry.activatedRoleSkills.has(args.name)) {
    const roleSkill = await resolveRoleSkill(args.name, workspaceDir)
    if (roleSkill?.path && (await pathExists(roleSkill.path))) {
      return await fs.readFile(roleSkill.path, "utf8")
    }
  }

  const normalSkill = await resolveNormalSkill(args.name, workspaceDir)
  if (normalSkill) {
    return normalSkill.content
  }

  const roleOwner = await findRoleOwnerForSkill(args.name, workspaceDir)
  if (roleOwner) {
    throw new Error(
      `Skill "${args.name}" belongs to role "${roleOwner}"; call role_load({ name: "${roleOwner}" }) first.`,
    )
  }

  throw new Error(`Skill "${args.name}" not found`)
}
```

This is the exact behavior the public rewrite should preserve:

- activated role skill wins
- otherwise normal skill wins
- otherwise prompt for `role_load`

## Reference Tool Registration

The current plugin registers both tools with `@opencode-ai/plugin`:

```ts
tool: {
  role_load: tool({
    description: "Load a role's full instructions and its role-specific skill index",
    args: {
      name: tool.schema.string().optional().describe("Role name to load"),
      role: tool.schema.string().optional().describe("Fallback role name field"),
    },
    execute: roleReadExecute,
  }),
  skill: tool({
    description: "Load a skill by name, supporting both normal skills and role skills",
    args: {
      name: tool.schema.string().describe("Skill name to load"),
    },
    execute: skillExecute,
  }),
}
```

For a cleaner public plugin, the fallback `args.role` compatibility can be removed if not needed.

## Workspace Resolution

Use the official plugin initialization fields:

- `directory`
- `worktree`

Do not resolve the workspace path from the transform hook payload.

Recommended rule:

```ts
const workspaceDir = directory || worktree
```

## Role Directory Layout

Default role root:

```text
<workspace>/.opencode/roles
```

Default role skill root:

```text
<workspace>/.opencode/roles/skill
```

Each role is stored as:

```text
<role-root>/<role-name>/ROLE.md
```

Each role skill is stored as:

```text
<role-root>/skill/<skill-name>/SKILL.md
```

## Extra Role Roots

Do not use `opencode.json` for custom role paths.

In practice, adding custom fields there may break OpenCode startup.

Instead, use plugin-owned config:

```text
<workspace>/.opencode/roles/config.json
```

Recommended format:

```json
{
  "paths": [],
  "_example": {
    "paths": [
      "<relative-role-root>",
      "<absolute-or-home-role-root>"
    ]
  }
}
```

Resolution rules:

- always scan `<workspace>/.opencode/roles` first
- then scan `paths` from `config.json`
- support relative paths
- support absolute paths
- support `~/...`

## `ROLE.md` Rules

Each role file is:

```text
ROLE.md
```

Frontmatter should contain only:

- `name`
- `description`

Example:

```md
---
name: java-sort-reviewer
description: Review Java sorting implementations, explain complexity, and improve examples
---
```

Do not place the role skill index in frontmatter.

Role skill exposure must remain progressive.

### Required body section for skill indexing

The plugin should read role skill links from:

```md
## Available role skills
- `java-complexity-review`: Review Java sorting implementations for complexity, edge cases, and example quality
- `java-cross-language-port`: Port Java sorting examples to other languages while preserving logic and intent
```

Expected bullet format:

```text
- `skill-name`: description
```

## `SKILL.md` Rules

Role skills should follow the same shape as Claude Agent Skills.

That means:

- YAML frontmatter
- `name`
- `description`
- body instructions in Markdown

Recommended example:

```md
---
name: java-complexity-review
description: Review Java sorting implementations for complexity, edge cases, and example quality. Use when reviewing Java sorting code or explaining time and space complexity.
---

# Java Complexity Review

## Quick start

Use this skill when reviewing Java sorting implementations, explaining complexity tradeoffs, or improving teaching examples.

## What to check

- Verify partition logic and recursion boundaries
- Explain best-case, average-case, and worst-case complexity
- Call out instability, pivot choice, and duplicate-value behavior
- Identify unclear examples, weak naming, or missing tests

## Review style

- Prioritize correctness before style
- Keep explanations concrete and code-specific
- Prefer the smallest safe fix
- State when behavior depends on input distribution
```

Do not encode the owning role in the skill frontmatter.

The role owns the index. The skill keeps standard skill structure.

## Role Index Build Strategy

The plugin should build a workspace role index with these outputs:

- valid roles
- role metadata for startup disclosure
- role body data
- role-to-skill mapping
- skill-to-role mapping

During indexing, exclude invalid roles from startup disclosure.

Recommended validation:

- valid `ROLE.md`
- valid frontmatter
- non-empty `name`
- non-empty `description`
- valid `## Available role skills` section
- all referenced role skills exist
- no duplicate role names
- no duplicate role skill names

## Session Activation Model

The plugin should keep role activation state in memory, scoped by `sessionID`.

Recommended structure:

```ts
Map<string, {
  activatedRoles: Set<string>
  activatedRoleSkills: Set<string>
}>
```

This does not need to be persisted.

It only exists to control whether a role skill is currently available.

## `role_load` Behavior

### Input

```ts
{ name: string }
```

### Responsibilities

- find the requested role
- parse the full `ROLE.md`
- extract structured body sections
- return role information and the role skill index
- mark the role as activated for the current session

### Recommended return shape

```ts
{
  role: {
    name: string,
    description: string,
    role: string,
    whenToUse: string,
    workingStyle: string
  },
  skills: Array<{
    name: string,
    description: string
  }>
}
```

## Overridden `skill` Behavior

The plugin must preserve normal OpenCode skill behavior while adding role skill gating.

Recommended resolution order:

1. If `name` is a role skill for an activated role, return that role skill
2. Otherwise resolve normal skills
3. If normal skill exists, return normal skill
4. If no normal skill exists, but `name` belongs to a role skill whose role is not activated, tell the model to call `role_load`
5. Otherwise return not found

## Normal Skill Compatibility

Overriding `skill` must not break existing OpenCode skills.

The plugin should continue to search standard OpenCode skill roots.

If this is being rebuilt as a public plugin, prefer matching the built-in OpenCode skill lookup order exactly instead of depending on TeamClaw-specific assumptions.

## Conflict Rules

These rules should be explicit and stable:

1. Role skill names are globally unique across all role roots
2. If a role skill name conflicts with a normal skill name:
   - activated role skill wins
   - otherwise normal skill wins
3. If a role skill exists but its role is not activated and there is no normal skill with that name:
   - instruct the model to call `role_load` first

## Logging

Keep plugin logs minimal.

Recommended logs:

- `system transform failed`
- `role_load failed`

Avoid verbose startup or success logs in the published plugin.

## Recommended Internal Module Split

If another agent rewrites this plugin, this split is recommended:

1. role root resolution
2. `ROLE.md` parsing
3. `SKILL.md` parsing
4. role index building
5. session activation store
6. overridden skill resolution
7. system prompt injection

## Public Plugin Expectations

For a downloadable plugin intended for other OpenCode users:

- do not depend on TeamClaw frontend code
- do not depend on runtime-installed template injection
- do not use TeamClaw-specific naming
- use OpenCode plugin conventions directly
- ship clear README examples
- ship at least one sample role and one sample role skill
- document `.opencode/roles` and `.opencode/roles/config.json`

## Minimal End-To-End Flow

1. Plugin starts and captures `directory` / `worktree`
2. Plugin scans `.opencode/roles` and optional extra roots
3. `experimental.chat.system.transform` appends `<available_roles>`
4. Model chooses a role
5. Model calls `role_load({ name })`
6. Plugin returns role body and role skill index, and activates the role for the session
7. Model calls `skill({ name })`
8. Plugin resolves either:
   - activated role skill
   - normal skill
   - or a prompt to call `role_load` first
