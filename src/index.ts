import { tool, type Plugin } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const ROLE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ROLE_DISCLOSURE_RULES = [
  "Role routing rule:",
  "When a task appears domain-specific, choose the best role from <available_roles> first.",
  "Call role_load({ name }) to load that role's full instructions and its role-specific skill index.",
  "The skill({ name }) tool resolves both normal skills and role skills.",
  "Role skills are only available after their owning role has been activated with role_load({ name }).",
  "If a role is not activated and a normal skill with the same name exists, skill({ name }) falls back to the normal skill.",
].join(" ")

const NORMAL_SKILL_PATHS = [
  [".opencode", "skills"],
  [".claude", "skills"],
  [".agents", "skills"],
] as const

const GLOBAL_SKILL_PATHS = [
  [os.homedir(), ".config", "opencode", "skills"],
  [os.homedir(), ".claude", "skills"],
  [os.homedir(), ".agents", "skills"],
] as const

type RoleSkill = {
  name: string
  description: string
  path: string
}

type RoleDefinition = {
  slug: string
  name: string
  description: string
  body: string
  filePath: string
  rootPath: string
  skills: RoleSkill[]
}

type RoleIndex = {
  roles: Map<string, RoleDefinition>
  skillOwners: Map<string, string[]>
}

type SessionRoleEntry = {
  activatedRoles: Set<string>
  activatedRoleSkills: Set<string>
  updatedAt: number
}

type PermissionMap = Record<string, string>

const sessionRoleState = new Map<string, SessionRoleEntry>()

function normalizeName(value: unknown) {
  return String(value ?? "").trim().toLowerCase()
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

async function pathExists(target: string) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function parseFrontmatter(content: string) {
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

function parseAvailableRoleSkills(body: string) {
  const lines = body.split("\n")
  const skills: Array<{ name: string; description: string }> = []
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
    return []
  }

  return skills
}

function extractSkillDescription(content: string, fallback: string) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)
  if (frontmatter) {
    const descLine = frontmatter[1]
      .split("\n")
      .find((line) => line.trim().startsWith("description:"))
    if (descLine) {
      const description = descLine.trim().slice("description:".length).trim()
      if (description) return description
    }
  }

  const heading = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"))

  if (heading) {
    const normalized = heading.replace(/^#+\s*/, "").trim()
    if (normalized && normalized !== fallback) return normalized
  }

  return fallback
}

async function readJsonFile(target: string) {
  if (!(await pathExists(target))) return {}

  try {
    return JSON.parse(await fs.readFile(target, "utf8"))
  } catch {
    return {}
  }
}

async function readOpenCodeConfig(workspaceDir: string) {
  return readJsonFile(path.join(workspaceDir, "opencode.json"))
}

async function readRoleConfig(workspaceDir: string) {
  return readJsonFile(path.join(workspaceDir, ".opencode", "roles", "config.json"))
}

function resolveConfiguredPath(workspaceDir: string, configuredPath: string) {
  if (configuredPath === "~") {
    return os.homedir()
  }

  if (configuredPath.startsWith("~/")) {
    return path.join(os.homedir(), configuredPath.slice(2))
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath
  }

  return path.join(workspaceDir, configuredPath)
}

async function resolveRoleRoots(workspaceDir: string) {
  const config = await readRoleConfig(workspaceDir)
  const configuredPaths = Array.isArray(config?.paths) ? config.paths : []
  const resolvedRoots = [path.join(workspaceDir, ".opencode", "roles")]

  for (const configuredPath of configuredPaths) {
    if (typeof configuredPath !== "string") continue
    resolvedRoots.push(resolveConfiguredPath(workspaceDir, configuredPath))
  }

  return Array.from(new Set(resolvedRoots.map((entry) => path.resolve(entry))))
}

function matchesPattern(name: string, pattern: string) {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === name
  return name.startsWith(pattern.slice(0, -1))
}

function resolveSkillPermission(skillName: string, permissions: PermissionMap) {
  if (permissions[skillName]) return permissions[skillName]

  let bestMatch: string | null = null
  for (const pattern of Object.keys(permissions)) {
    if (pattern === "*" || pattern === skillName) continue
    if (!matchesPattern(skillName, pattern)) continue
    if (!bestMatch || pattern.length > bestMatch.length) {
      bestMatch = pattern
    }
  }

  if (bestMatch) return permissions[bestMatch]
  if (permissions["*"]) return permissions["*"]
  return "allow"
}

async function ensureSkillAllowed(workspaceDir: string, skillName: string) {
  const config = await readOpenCodeConfig(workspaceDir)
  const permissions =
    config && typeof config === "object" && config.permission && typeof config.permission === "object"
      ? ((config.permission as Record<string, unknown>).skill as PermissionMap | undefined) ?? {}
      : {}

  if (resolveSkillPermission(skillName, permissions) === "deny") {
    throw new Error(`Access denied for skill "${skillName}" by permission.skill`)
  }
}

async function loadRoleIndex(workspaceDir: string): Promise<RoleIndex> {
  const roleRoots = await resolveRoleRoots(workspaceDir)
  const roles = new Map<string, RoleDefinition>()
  const skillOwners = new Map<string, string[]>()

  for (const roleRoot of roleRoots) {
    if (!(await pathExists(roleRoot))) continue

    const roleSkillRoot = path.join(roleRoot, "skill")
    const roleEntries = await fs.readdir(roleRoot, { withFileTypes: true })

    for (const entry of roleEntries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "skill") continue

      const rolePath = path.join(roleRoot, entry.name, "ROLE.md")
      if (!(await pathExists(rolePath))) continue

      const parsed = parseFrontmatter(await fs.readFile(rolePath, "utf8"))
      const listedSkills = parseAvailableRoleSkills(parsed.body)
      const role: RoleDefinition = {
        slug: entry.name,
        name: parsed.data.name,
        description: parsed.data.description,
        body: parsed.body,
        filePath: rolePath,
        rootPath: roleRoot,
        skills: [],
      }

      if (roles.has(parsed.data.name)) {
        throw new Error(`Duplicate role "${parsed.data.name}" found in multiple role roots`)
      }

      for (const listedSkill of listedSkills) {
        const skillPath = path.join(roleSkillRoot, listedSkill.name, "SKILL.md")
        if (!(await pathExists(skillPath))) {
          throw new Error(`Role "${parsed.data.name}" references missing skill "${listedSkill.name}"`)
        }

        role.skills.push({
          name: listedSkill.name,
          description: listedSkill.description,
          path: skillPath,
        })

        const owners = skillOwners.get(listedSkill.name) ?? []
        if (!owners.includes(parsed.data.name)) {
          owners.push(parsed.data.name)
        }
        skillOwners.set(listedSkill.name, owners)
      }

      roles.set(parsed.data.name, role)
    }
  }

  return { roles, skillOwners }
}

function buildAvailableRolesPrompt(index: RoleIndex) {
  const visibleRoles = Array.from(index.roles.values())

  if (visibleRoles.length === 0) return ""

  const roleEntries = visibleRoles
    .map((role) =>
      [
        "  <role>",
        `    <name>${escapeXml(role.name)}</name>`,
        `    <description>${escapeXml(role.description)}</description>`,
        "  </role>",
      ].join("\n"),
    )
    .join("\n")

  return [
    "<available_roles>",
    roleEntries,
    "</available_roles>",
    "",
    ROLE_DISCLOSURE_RULES,
  ].join("\n")
}

async function getRole(workspaceDir: string, roleName: string) {
  const index = await loadRoleIndex(workspaceDir)
  const normalizedRoleName = normalizeName(roleName)
  const role =
    index.roles.get(normalizedRoleName) ||
    Array.from(index.roles.values()).find(
      (candidate) =>
        normalizeName(candidate.name) === normalizedRoleName ||
        normalizeName(candidate.slug) === normalizedRoleName,
    )

  if (!role) {
    throw new Error(`Role "${roleName}" not found`)
  }

  return { index, role }
}

function getSessionEntry(sessionID: string) {
  let entry = sessionRoleState.get(sessionID)
  if (!entry) {
    entry = {
      activatedRoles: new Set(),
      activatedRoleSkills: new Set(),
      updatedAt: Date.now(),
    }
    sessionRoleState.set(sessionID, entry)
  }

  entry.updatedAt = Date.now()
  return entry
}

async function resolveNormalSkill(name: string, workspaceDir: string) {
  const candidateDirs: string[] = []

  for (const parts of NORMAL_SKILL_PATHS) {
    candidateDirs.push(path.join(workspaceDir, ...parts))
  }

  for (const parts of GLOBAL_SKILL_PATHS) {
    candidateDirs.push(path.join(...parts))
  }

  const config = await readOpenCodeConfig(workspaceDir)
  const configuredPaths = Array.isArray(config?.skills?.paths) ? config.skills.paths : []
  for (const configuredPath of configuredPaths) {
    if (typeof configuredPath !== "string") continue
    candidateDirs.push(resolveConfiguredPath(workspaceDir, configuredPath))
  }

  for (const dir of candidateDirs) {
    const skillPath = path.join(dir, name, "SKILL.md")
    if (await pathExists(skillPath)) {
      return {
        path: skillPath,
        content: await fs.readFile(skillPath, "utf8"),
      }
    }
  }

  return null
}

async function findRolesForSkill(name: string, workspaceDir: string) {
  const { skillOwners } = await loadRoleIndex(workspaceDir)
  const owners = skillOwners.get(name) ?? []
  return owners
}

async function resolveRoleSkill(name: string, workspaceDir: string) {
  const index = await loadRoleIndex(workspaceDir)
  for (const role of index.roles.values()) {
    const skill = role.skills.find((candidate) => candidate.name === name)
    if (skill) {
      return {
        owner: role.name,
        path: skill.path,
      }
    }
  }

  return null
}

async function roleLoadExecute(
  args: { name?: string; role?: string },
  context: { directory?: string; worktree?: string; sessionID: string },
) {
  const workspaceDir = context.directory || context.worktree
  if (!workspaceDir) {
    throw new Error("role_load requires a workspace directory")
  }

  const requestedRoleName = args.name ?? args.role
  if (!requestedRoleName || !requestedRoleName.trim()) {
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
    ...(skills.length > 0
      ? skills.map((skill, index) => `${index + 1}. ${skill.name}: ${skill.description}`)
      : ["(none)"]),
  ].join("\n")
}

async function skillExecute(
  args: { name: string },
  context: { directory?: string; worktree?: string; sessionID: string },
) {
  const workspaceDir = context.directory || context.worktree
  if (!workspaceDir) {
    throw new Error("skill requires a workspace directory")
  }

  await ensureSkillAllowed(workspaceDir, args.name)

  const sessionEntry = getSessionEntry(context.sessionID)
  if (sessionEntry.activatedRoleSkills.has(args.name)) {
    const roleSkill = await resolveRoleSkill(args.name, workspaceDir)
    if (roleSkill && (await pathExists(roleSkill.path))) {
      return fs.readFile(roleSkill.path, "utf8")
    }
  }

  const normalSkill = await resolveNormalSkill(args.name, workspaceDir)
  if (normalSkill) {
    return normalSkill.content
  }

  const roleOwners = await findRolesForSkill(args.name, workspaceDir)
  if (roleOwners.length > 0) {
    if (roleOwners.length === 1) {
      throw new Error(`Skill "${args.name}" is declared by role "${roleOwners[0]}"; call role_load({ name: "${roleOwners[0]}" }) first.`)
    }

    throw new Error(
      `Skill "${args.name}" is shared by roles ${roleOwners.map((name) => `"${name}"`).join(", ")}; call role_load for one of them first.`,
    )
  }

  throw new Error(`Skill "${args.name}" not found`)
}

export const OpenCodeRolesPlugin: Plugin = async ({ directory, worktree }) => {
  const pluginWorkspaceDir = directory || worktree

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!pluginWorkspaceDir) {
        return
      }

      const index = await loadRoleIndex(pluginWorkspaceDir)
      const rolePrompt = buildAvailableRolesPrompt(index)
      if (!rolePrompt) {
        return
      }

      if (!Array.isArray(output.system)) {
        output.system = []
      }

      output.system.push(rolePrompt)
    },
    tool: {
      role_load: tool({
        description: "Load a role's full instructions and its role-specific skill index",
        args: {
          name: tool.schema.string().optional().describe("Role name to load"),
          role: tool.schema.string().optional().describe("Fallback role name field"),
        },
        execute: roleLoadExecute,
      }),
      skill: tool({
        description: "Load a skill by name, supporting both normal skills and role skills",
        args: {
          name: tool.schema.string().describe("Skill name to load"),
        },
        execute: skillExecute,
      }),
    },
  }
}

export default OpenCodeRolesPlugin
