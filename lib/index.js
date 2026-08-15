// DeepSeek Harness plugin "manage-hub": settings pages for managing user
// skills and MCP servers.
//
// Host half: plain HTTP JSON routes under /dsh-manage, served through the
// webServer service. The browser half (./client.js) renders the two settings
// sections and calls these routes with fetch. The host imports nothing from
// @deepseek-ai packages so out-of-tree resolution stays reliable (the modlens
// precedent); only `yaml` and the MCP SDK are runtime dependencies, both
// already present in every dsh install.
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { unzipSync } from 'fflate/node'

export const name = 'manage-hub'
export const inject = []

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MCP_CONFIG_FILENAME = 'mcp-servers.yaml'
const MCP_PROFILE_ROW_PREFIX = 'mcp-'
const ROUTE_BASE = '/dsh-manage'
const MAX_BODY_BYTES = 16 * 1024 * 1024

/** Domain error carrying a stable wire code. */
class ManageError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** The harness home ($DSH_HOME or ~/.dsh). */
function dshHome() {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim() !== '' ? resolve(env) : join(homedir(), '.dsh')
}

/** The user-owned skill root under the harness home. */
function skillsRoot() {
  return join(dshHome(), 'skills')
}

/** Whether a resolved path stays inside a root (containment guard). */
function isContained(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Same kebab-case grammar as @deepseek-ai/dsh-skill's isSkillName. */
function isSkillName(value) {
  return typeof value === 'string' && SKILL_NAME.test(value)
}

/** Parse a skill file's YAML frontmatter; undefined when absent or malformed. */
function parseSkillFrontmatter(raw) {
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      let data
      try {
        data = parseYaml(raw.slice(start, lineStart))
      } catch {
        return undefined
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
      return { data, body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1) }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function yamlStringField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Invocation flags from frontmatter (same semantics as dsh-skill-filesystem). */
function skillInvocationFlags(data) {
  return {
    modelInvocable: data['disable-model-invocation'] !== true,
    userInvocable: data['user-invocable'] !== false,
  }
}

/** Resolve the SKILL.md or flat .md file of one user skill, or undefined. */
async function resolveSkillFile(root, name) {
  if (!isSkillName(name)) return undefined
  const bundle = join(root, name, 'SKILL.md')
  const flat = join(root, `${name}.md`)
  if (!isContained(root, bundle) || !isContained(root, flat)) return undefined
  try {
    await access(bundle)
    return bundle
  } catch {
    // fall through to the flat file
  }
  try {
    await access(flat)
    return flat
  } catch {
    return undefined
  }
}

/** Enumerate the user-owned skill catalog. */
async function listUserSkills() {
  const root = skillsRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
  const skills = []
  for (const entry of entries) {
    if (entry.name === '.system') continue
    const path = entry.isDirectory()
      ? join(root, entry.name, 'SKILL.md')
      : entry.isFile() && entry.name.endsWith('.md')
        ? join(root, entry.name)
        : undefined
    if (path === undefined) continue
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
      throw error
    }
    const parsed = parseSkillFrontmatter(raw)
    if (parsed === undefined) continue
    const name = yamlStringField(parsed.data, 'name')
    const description = yamlStringField(parsed.data, 'description')
    if (name === undefined || description === undefined || !isSkillName(name)) continue
    const flags = skillInvocationFlags(parsed.data)
    const whenToUse = yamlStringField(parsed.data, 'whenToUse')
    skills.push({
      name,
      description,
      ...(whenToUse !== undefined ? { whenToUse } : {}),
      modelInvocable: flags.modelInvocable,
      userInvocable: flags.userInvocable,
      source: 'user-dsh',
      path,
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** Normalize a zip entry path and reject traversal / absolute / junk entries. */
function safeZipEntryPath(entryPath) {
  const normalized = String(entryPath).replace(/\\/g, '/')
  if (normalized.startsWith('/')) return undefined
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.some((segment) => segment === '..')) return undefined
  return segments.join('/')
}

/**
 * Import a skill from a zip archive. The archive may be a directory bundle
 * (`<name>/SKILL.md` plus support files) or a flat `SKILL.md` at the root.
 * The name comes from SKILL.md frontmatter (falling back to the directory
 * name); files are installed under `$DSH_HOME/skills/<name>/`.
 */
async function importUserSkill(input) {
  const data = input.data
  const filename = typeof input.filename === 'string' && input.filename !== '' ? input.filename : 'skill.zip'
  if (typeof data !== 'string' || data === '') throw new ManageError('invalid-skill-archive', 'zip archive data is required')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) throw new ManageError('invalid-skill-archive', 'archive is empty')

  let entries
  try {
    entries = unzipSync(new Uint8Array(bytes))
  } catch {
    throw new ManageError('invalid-skill-archive', `"${filename}" is not a valid zip archive`)
  }

  const files = []
  let totalBytes = 0
  for (const [rawPath, content] of Object.entries(entries)) {
    const relPath = safeZipEntryPath(rawPath)
    if (relPath === undefined || relPath === '' || relPath.endsWith('/')) continue
    totalBytes += content.length
    if (totalBytes > 64 * 1024 * 1024) throw new ManageError('skill-archive-too-large', 'archive expands to more than 64 MiB')
    files.push({ relPath, content })
  }
  if (files.length === 0) throw new ManageError('invalid-skill-archive', 'archive contains no files')
  if (files.length > 2000) throw new ManageError('skill-archive-too-large', 'archive contains too many files')

  const skillMd = files
    .filter((file) => file.relPath === 'SKILL.md' || file.relPath.endsWith('/SKILL.md'))
    .sort((a, b) => a.relPath.split('/').length - b.relPath.split('/').length)[0]
  if (skillMd === undefined) throw new ManageError('invalid-skill-archive', 'archive has no SKILL.md')
  const prefix = skillMd.relPath === 'SKILL.md' ? '' : skillMd.relPath.slice(0, -'SKILL.md'.length)

  const raw = Buffer.from(skillMd.content).toString('utf8')
  const parsed = parseSkillFrontmatter(raw)
  const frontmatterName = parsed === undefined ? undefined : yamlStringField(parsed.data, 'name')
  const dirName = prefix === '' ? '' : prefix.split('/')[0]
  const name = isSkillName(frontmatterName) ? frontmatterName : dirName
  if (!isSkillName(name)) throw new ManageError('invalid-skill-archive', 'cannot determine a valid skill name (kebab-case) from the archive')

  const root = skillsRoot()
  const dir = join(root, name)
  if (!isContained(root, dir)) throw new ManageError('invalid-skill-name', `skill name "${name}" resolves outside the skills root`)
  try {
    await access(dir)
    throw new ManageError('skill-exists', `skill "${name}" already exists`)
  } catch (error) {
    if (error instanceof ManageError) throw error
  }
  try {
    await access(join(root, `${name}.md`))
    throw new ManageError('skill-exists', `skill "${name}" already exists`)
  } catch (error) {
    if (error instanceof ManageError) throw error
  }

  await mkdir(dir, { recursive: true })
  for (const file of files) {
    if (prefix !== '' && !file.relPath.startsWith(prefix)) continue
    const rel = prefix === '' ? file.relPath : file.relPath.slice(prefix.length)
    if (rel === '' || rel.endsWith('/')) continue
    const target = join(dir, rel)
    if (!isContained(dir, target)) throw new ManageError('invalid-skill-archive', `archive entry "${file.relPath}" escapes the skill directory`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content)
  }
  return name
}

/** Update an existing user skill's frontmatter and body. */
async function updateUserSkill(input) {
  const name = input.name
  const root = skillsRoot()
  const target = await resolveSkillFile(root, name)
  if (target === undefined) throw new ManageError('skill-not-found', `skill "${name}" not found`)
  const raw = await readFile(target, 'utf8')
  const parsed = parseSkillFrontmatter(raw)
  if (parsed === undefined) throw new ManageError('skill-invalid', `skill "${name}" has no parseable frontmatter`)
  const data = { ...parsed.data }
  if (input.description !== undefined) data.description = input.description
  if (input.whenToUse !== undefined) {
    if (input.whenToUse !== '') data.whenToUse = input.whenToUse
    else delete data.whenToUse
  }
  delete data['disable-model-invocation']
  delete data['user-invocable']
  if (input.modelInvocable === false) data['disable-model-invocation'] = true
  if (input.userInvocable === false) data['user-invocable'] = false
  const body = input.content !== undefined ? input.content : parsed.body
  const rendered = `---\n${stringifyYaml(data).trimEnd()}\n---\n\n${body.trim()}\n`
  await writeFile(target, rendered, 'utf8')
  return name
}

/** Remove one user skill (directory bundle or flat file). */
async function removeUserSkill(name) {
  if (!isSkillName(name)) throw new ManageError('invalid-skill-name', `invalid skill name "${name}"`)
  const root = skillsRoot()
  const dir = join(root, name)
  const flat = join(root, `${name}.md`)
  if (!isContained(root, dir) || !isContained(root, flat)) throw new ManageError('invalid-skill-name', `skill name "${name}" resolves outside the skills root`)
  let removed = false
  try {
    await rm(dir, { recursive: true, force: true })
    removed = true
  } catch {}
  try {
    await rm(flat, { force: true })
    removed = true
  } catch {}
  if (!removed) throw new ManageError('skill-not-found', `skill "${name}" not found`)
  return name
}

/** Read the managed MCP server document; a missing file is an empty catalog. */
async function readMcpServers() {
  const path = join(dshHome(), MCP_CONFIG_FILENAME)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = parseYaml(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const servers = parsed.servers
    return Array.isArray(servers) ? servers.filter((s) => s !== null && typeof s === 'object' && !Array.isArray(s)) : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** Resolve one managed server by name. */
async function findMcpServer(name) {
  const servers = await readMcpServers()
  return servers.find((s) => s.name === name)
}

/** Persist the managed document and regenerate the profile patch rows. */
async function writeMcpServers(ctx, servers) {
  const path = join(dshHome(), MCP_CONFIG_FILENAME)
  await writeFile(path, stringifyYaml({ servers }, { lineWidth: 0 }), 'utf8')
  await syncMcpProfilePatch(ctx, servers)
}

/** The cordis row that mounts one server as an mcp-client instance. */
function mcpPatchRow(server) {
  const row = {
    id: `${MCP_PROFILE_ROW_PREFIX}${server.name}`,
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      transport: server.transport,
      serverName: server.name,
      toolCallTimeoutMs: server.toolCallTimeoutMs ?? 30000,
      failOnStartupError: server.failOnStartupError === true,
    },
  }
  if (server.transport === 'stdio') {
    row.config.command = server.command
    row.config.args = server.args ?? []
    row.config.env = server.env ?? {}
    row.config.cwd = server.cwd && server.cwd !== '' ? server.cwd : process.cwd()
  } else {
    row.config.url = server.url
    row.config.headers = server.headers ?? {}
  }
  return row
}

/** Rewrite the profile's `cordis.patch.yml`, replacing every `mcp-*` row. */
async function syncMcpProfilePatch(ctx, servers) {
  const baseUrl = ctx.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl === '') return
  let profileDir
  try {
    profileDir = fileURLToPath(baseUrl)
  } catch {
    profileDir = baseUrl
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let raw = ''
  let entries = []
  try {
    raw = await readFile(patchPath, 'utf8')
    const parsed = parseYaml(raw)
    entries = Array.isArray(parsed) ? parsed : []
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const isMcpRow = (row) => row !== null && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string' && row.id.startsWith(MCP_PROFILE_ROW_PREFIX)
  const kept = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      kept.push(entry)
      continue
    }
    if (isMcpRow(entry)) continue
    if (Array.isArray(entry.insert)) {
      const insert = entry.insert.filter((row) => !isMcpRow(row))
      if (insert.length > 0) kept.push({ ...entry, insert })
    } else {
      kept.push(entry)
    }
  }
  const enabled = servers.filter((s) => s.enabled !== false)
  if (enabled.length > 0) kept.push({ insert: enabled.map(mcpPatchRow) })
  const header = raw.split(/\r?\n/).filter((line) => line.trimStart().startsWith('#') || line.trim() === '').join('\n')
  const rendered = `${header}${header.length > 0 ? '\n' : ''}${stringifyYaml(kept, { lineWidth: 0 })}`
  await writeFile(patchPath, rendered, 'utf8')
}

/** Connect to a server and list its tools (connection smoke test). */
async function testMcpConnection(server) {
  const client = new McpClient({ name: 'dsh-manage-test', version: '0.1.0' }, { capabilities: {} })
  const transport =
    server.transport === 'stdio'
      ? new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          env: { ...process.env, ...(server.env ?? {}) },
          cwd: server.cwd && server.cwd !== '' ? server.cwd : process.cwd(),
        })
      : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } })
  try {
    await client.connect(transport)
    const tools = []
    let cursor
    do {
      const page = await client.listTools({ cursor })
      for (const tool of page.tools) tools.push(tool.name)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return tools
  } finally {
    await client.close().catch(() => undefined)
  }
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

/** Read and parse a JSON request body (bounded). */
function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (data === '') return resolvePromise({})
      try {
        resolvePromise(JSON.parse(data))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(payload)
}

/** Wire error shape from a thrown value. */
function wireError(error) {
  if (error instanceof ManageError) return { code: error.code, message: error.message, details: {} }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} }
}

/** Build the route table (closure over ctx for profile-patch writes). */
function routes(ctx) {
  return {
    [`${ROUTE_BASE}/skill.list`]: async () => ({ value: { skills: await listUserSkills() } }),
    [`${ROUTE_BASE}/skill.read`]: async (payload) => {
      const root = skillsRoot()
      const target = await resolveSkillFile(root, payload.name)
      if (target === undefined) throw new ManageError('skill-not-found', `skill "${payload.name}" not found`)
      const raw = await readFile(target, 'utf8')
      const parsed = parseSkillFrontmatter(raw)
      if (parsed === undefined) throw new ManageError('skill-invalid', `skill "${payload.name}" has no parseable frontmatter`)
      const data = parsed.data
      const name = yamlStringField(data, 'name') ?? payload.name
      const description = yamlStringField(data, 'description') ?? ''
      const flags = skillInvocationFlags(data)
      const whenToUse = yamlStringField(data, 'whenToUse')
      return {
        value: {
          name,
          description,
          ...(whenToUse !== undefined ? { whenToUse } : {}),
          modelInvocable: flags.modelInvocable,
          userInvocable: flags.userInvocable,
          content: parsed.body.trim(),
          path: target,
        },
      }
    },
    [`${ROUTE_BASE}/skill.install`]: async (payload) => ({ value: { name: await importUserSkill(payload) } }),
    [`${ROUTE_BASE}/skill.update`]: async (payload) => ({ value: { name: await updateUserSkill(payload) } }),
    [`${ROUTE_BASE}/skill.remove`]: async (payload) => ({ value: { removed: true, name: await removeUserSkill(payload.name) } }),
    [`${ROUTE_BASE}/mcp.list`]: async () => ({ value: { servers: await readMcpServers(), file: join(dshHome(), MCP_CONFIG_FILENAME) } }),
    [`${ROUTE_BASE}/mcp.upsert`]: async (payload) => {
      const server = payload.server
      if (server === null || typeof server !== 'object' || typeof server.name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(server.name)) {
        throw new ManageError('invalid-mcp-server', 'server requires a name matching [A-Za-z0-9_-]{1,32}')
      }
      if (server.transport !== 'stdio' && server.transport !== 'streamable-http') {
        throw new ManageError('invalid-mcp-server', 'transport must be "stdio" or "streamable-http"')
      }
      if (server.transport === 'stdio' && (typeof server.command !== 'string' || server.command === '')) {
        throw new ManageError('invalid-mcp-server', 'stdio servers require a command')
      }
      if (server.transport === 'streamable-http' && (typeof server.url !== 'string' || server.url === '')) {
        throw new ManageError('invalid-mcp-server', 'streamable-http servers require a url')
      }
      const existing = await readMcpServers()
      const index = existing.findIndex((s) => s.name === server.name)
      const normalized = {
        name: server.name,
        enabled: server.enabled !== false,
        transport: server.transport,
        toolCallTimeoutMs: server.toolCallTimeoutMs ?? 30000,
        failOnStartupError: server.failOnStartupError === true,
        ...(server.transport === 'stdio'
          ? { command: server.command, args: server.args ?? [], env: server.env ?? {}, cwd: server.cwd ?? '' }
          : { url: server.url, headers: server.headers ?? {} }),
      }
      const next = index === -1 ? [...existing, normalized] : existing.map((s, i) => (i === index ? normalized : s))
      await writeMcpServers(ctx, next)
      return { value: { name: server.name } }
    },
    [`${ROUTE_BASE}/mcp.remove`]: async (payload) => {
      const servers = await readMcpServers()
      const next = servers.filter((s) => s.name !== payload.name)
      if (next.length === servers.length) throw new ManageError('mcp-not-found', `MCP server "${payload.name}" not found`)
      await writeMcpServers(ctx, next)
      return { value: { removed: true } }
    },
    [`${ROUTE_BASE}/mcp.test`]: async (payload) => {
      const server = await findMcpServer(payload.name)
      if (server === undefined) throw new ManageError('mcp-not-found', `MCP server "${payload.name}" not found`)
      const tools = await testMcpConnection(server)
      return { value: { ok: true, tools } }
    },
  }
}

/** One prefix handler dispatching on the exact pathname. */
function dispatch(ctx) {
  const table = routes(ctx)
  return async (req, res) => {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.local').pathname)
    } catch {
      return sendJson(res, 400, { ok: false, error: wireError(new ManageError('bad-request', 'malformed request path')) })
    }
    const handler = table[pathname]
    if (handler === undefined) return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no route ${pathname}`, details: {} } })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required', details: {} } })
    try {
      const body = await readJsonBody(req)
      // The browser half sends `{ payload: {...} }`; accept both the wrapped
      // and the bare form so curl/scripting callers stay simple too.
      const payload = body !== null && typeof body === 'object' && !Array.isArray(body) && body.payload !== undefined ? body.payload : body
      const result = await handler(payload ?? {})
      return sendJson(res, 200, { ok: true, value: result.value })
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: wireError(error) })
    }
  }
}

/**
 * Cordis plugin body: register the /dsh-manage route tree once the webServer
 * service appears (web profile only; headless/TUI simply never mount it).
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    try {
      scope.webServer.register({ kind: 'prefix', path: ROUTE_BASE, handler: dispatch(ctx) })
    } catch (error) {
      console.error(`[manage-hub] route registration skipped: ${error}`)
    }
  })
}
