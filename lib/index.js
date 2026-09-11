// DeepSeek Harness plugin "mcp-skills": settings pages for managing user
// skills and MCP servers.
//
// Host half: plain HTTP JSON routes under /dsh-mcp-skills, served through the
// webServer service. The browser half (./client.js) renders the two settings
// sections and calls these routes with fetch. The host imports nothing from
// @deepseek-ai packages so out-of-tree resolution stays reliable (the modlens
// precedent); `yaml`, `fflate`, and the MCP SDK are runtime dependencies, all
// already present in every dsh install.
import { access, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMap, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { unzipSync } from 'fflate/node'

export const name = 'mcp-skills'
export const inject = []

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Kept in step with package.json (the smoke test reports it to the server). */
const PLUGIN_VERSION = '0.2.0'
const MCP_CONFIG_FILENAME = 'mcp-servers.yaml'
const MCP_PROFILE_ROW_PREFIX = 'mcp-'
const ROUTE_BASE = '/dsh-mcp-skills'
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_FILES = 2000
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
const MCP_TEST_TIMEOUT_MS = 15000
/** Backstop kept for parity with the harness subprocess seam. */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

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

/**
 * Write a file without ever leaving a truncated remnant behind: the content
 * lands in a sibling temp file first and only then replaces the target. These
 * files drive harness startup, so a crash mid-write must not corrupt them.
 */
async function writeFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data, 'utf8')
  try {
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Keep the single previous revision of a file the plugin rewrites in place. */
async function backUpFile(path) {
  try {
    await copyFile(path, `${path}.bak`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
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

/** Whether a value is a plain record (non-array object). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
 * Import skills from a zip archive. The archive may hold a single skill
 * (flat `SKILL.md` at the root or a `<name>/SKILL.md` bundle) or many skills
 * (a directory of `<name>/SKILL.md` bundles, e.g. a skills-repo export). Each
 * skill's name comes from its SKILL.md frontmatter (falling back to the
 * directory name); a `template/` directory is skipped. Returns the names of
 * the skills that were installed.
 */
async function importUserSkills(input) {
  const data = input.data
  const filename = typeof input.filename === 'string' && input.filename !== '' ? input.filename : 'skill.zip'
  if (typeof data !== 'string' || data === '') throw new ManageError('invalid-skill-archive', 'zip archive data is required')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) throw new ManageError('invalid-skill-archive', 'archive is empty')

  let entries
  try {
    // The filter runs before each entry is inflated, so a zip bomb is refused
    // on its declared sizes instead of after it has already been decoded.
    let count = 0
    let declaredBytes = 0
    entries = unzipSync(new Uint8Array(bytes), {
      filter(file) {
        if (file.name.endsWith('/') || file.name.endsWith('\\')) return true
        count += 1
        if (count > MAX_ARCHIVE_FILES) throw new ManageError('skill-archive-too-large', `archive contains more than ${MAX_ARCHIVE_FILES} files`)
        declaredBytes += file.originalSize ?? 0
        if (declaredBytes > MAX_ARCHIVE_BYTES) throw new ManageError('skill-archive-too-large', 'archive expands to more than 64 MiB')
        return true
      },
    })
  } catch (error) {
    if (error instanceof ManageError) throw error
    throw new ManageError('invalid-skill-archive', `"${filename}" is not a valid zip archive`)
  }

  const files = []
  let totalBytes = 0
  for (const [rawPath, content] of Object.entries(entries)) {
    if (rawPath.endsWith('/') || rawPath.endsWith('\\')) continue // directory entry
    const relPath = safeZipEntryPath(rawPath)
    if (relPath === undefined || relPath === '') continue
    totalBytes += content.length
    if (totalBytes > MAX_ARCHIVE_BYTES) throw new ManageError('skill-archive-too-large', 'archive expands to more than 64 MiB')
    files.push({ relPath, content })
  }
  if (files.length === 0) throw new ManageError('invalid-skill-archive', 'archive contains no files')
  if (files.length > MAX_ARCHIVE_FILES) throw new ManageError('skill-archive-too-large', 'archive contains too many files')

  const skillMds = files.filter((file) => file.relPath === 'SKILL.md' || file.relPath.endsWith('/SKILL.md'))
  if (skillMds.length === 0) throw new ManageError('invalid-skill-archive', 'archive has no SKILL.md')

  const root = skillsRoot()
  const plan = []
  const skipped = []
  for (const skillMd of skillMds) {
    const prefix = skillMd.relPath === 'SKILL.md' ? '' : skillMd.relPath.slice(0, -'SKILL.md'.length)
    const dirBase = prefix === '' ? '' : prefix.split('/').filter((segment) => segment !== '').pop()
    if (dirBase === 'template') continue

    const raw = Buffer.from(skillMd.content).toString('utf8')
    const parsed = parseSkillFrontmatter(raw)
    const frontmatterName = parsed === undefined ? undefined : yamlStringField(parsed.data, 'name')
    const name = isSkillName(frontmatterName) ? frontmatterName : dirBase
    if (!isSkillName(name)) {
      skipped.push({ name: dirBase === '' ? skillMd.relPath : dirBase, reason: 'unsupported' })
      continue
    }

    const dir = join(root, name)
    if (!isContained(root, dir)) throw new ManageError('invalid-skill-name', `skill name "${name}" resolves outside the skills root`)
    let exists = false
    try {
      await access(dir)
      exists = true
    } catch {}
    try {
      await access(join(root, `${name}.md`))
      exists = true
    } catch {}
    if (exists) {
      skipped.push({ name, reason: 'exists' })
      continue
    }

    const rels = []
    for (const file of files) {
      if (prefix !== '' && !file.relPath.startsWith(prefix)) continue
      const rel = prefix === '' ? file.relPath : file.relPath.slice(prefix.length)
      if (rel === '' || rel.endsWith('/')) continue
      const target = join(dir, rel)
      if (!isContained(dir, target)) throw new ManageError('invalid-skill-archive', `archive entry "${file.relPath}" escapes the skill directory`)
      rels.push({ rel, content: file.content })
    }
    plan.push({ name, dir, rels })
  }

  if (plan.length === 0) {
    // Everything was recognized but nothing was installable: report why rather
    // than claiming the archive is unreadable.
    if (skipped.length > 0) return { names: [], skipped }
    throw new ManageError('invalid-skill-archive', 'no importable skill found in the archive')
  }

  const imported = []
  for (const skill of plan) {
    await mkdir(skill.dir, { recursive: true })
    for (const item of skill.rels) {
      await mkdir(dirname(join(skill.dir, item.rel)), { recursive: true })
      await writeFile(join(skill.dir, item.rel), item.content)
    }
    imported.push(skill.name)
  }
  return { names: imported, skipped }
}

/** Remove one user skill (directory bundle or flat file). */
async function removeUserSkill(name) {
  if (!isSkillName(name)) throw new ManageError('invalid-skill-name', `invalid skill name "${name}"`)
  const root = skillsRoot()
  const dir = join(root, name)
  const flat = join(root, `${name}.md`)
  if (!isContained(root, dir) || !isContained(root, flat)) throw new ManageError('invalid-skill-name', `skill name "${name}" resolves outside the skills root`)
  // `rm` with `force` never reports a missing target, so existence is decided
  // here instead of being inferred from the removal.
  let exists = false
  for (const target of [dir, flat]) {
    try {
      await access(target)
      exists = true
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  if (!exists) throw new ManageError('skill-not-found', `skill "${name}" not found`)
  await rm(dir, { recursive: true, force: true })
  await rm(flat, { force: true })
  return name
}

/** Resolve one user skill's SKILL.md (or flat .md) path, or undefined. */
async function resolveUserSkillFile(name) {
  if (!isSkillName(name)) return undefined
  const root = skillsRoot()
  const bundle = join(root, name, 'SKILL.md')
  const flat = join(root, `${name}.md`)
  try {
    await access(bundle)
    return bundle
  } catch {}
  try {
    await access(flat)
    return flat
  } catch {}
  return undefined
}

/** Toggle a user skill's model invocation (enable/disable) in frontmatter. */
async function setSkillEnabled(name, enabled) {
  const target = await resolveUserSkillFile(name)
  if (target === undefined) throw new ManageError('skill-not-found', `skill "${name}" not found`)
  const raw = await readFile(target, 'utf8')
  if (parseSkillFrontmatter(raw) === undefined) throw new ManageError('skill-invalid', `skill "${name}" has no parseable frontmatter`)

  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const lines = content.split(/\r?\n/)
  let closing = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') { closing = i; break }
  }
  if (closing === -1) throw new ManageError('skill-invalid', `skill "${name}" has no parseable frontmatter`)

  const key = 'disable-model-invocation'
  const frontmatter = lines.slice(1, closing).filter((line) => {
    const match = /^([\w-]+)\s*:/.exec(line)
    return !(match !== null && match[1] === key)
  })
  if (!enabled) frontmatter.push(`${key}: true`)

  const rendered = ['---', ...frontmatter, ...lines.slice(closing)].join(eol)
  await writeFile(target, rendered, 'utf8')
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
  await writeFileAtomic(path, stringifyYaml({ servers }, { lineWidth: 0 }))
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
      toolCallTimeoutMs: server.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
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

/** The active profile directory, or a domain error when the host cannot tell. */
function profileDirectory(ctx) {
  const baseUrl = ctx.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new ManageError('profile-unavailable', 'cannot locate the active profile directory (ctx.baseUrl is unset)')
  }
  try {
    return fileURLToPath(baseUrl)
  } catch {
    return baseUrl
  }
}

/** Whether one parsed YAML node is a row this plugin owns. */
function isMcpRowNode(node) {
  if (!isMap(node)) return false
  const id = node.get('id')
  return typeof id === 'string' && id.startsWith(MCP_PROFILE_ROW_PREFIX)
}

/**
 * Rewrite the profile's `cordis.patch.yml`, replacing every `mcp-*` row.
 *
 * The profile patch is user-owned and boot-critical, so this edits the parsed
 * document node by node instead of re-serializing a plain object: comments,
 * anchors, and `!!js` expression tags survive the round trip, and the write is
 * atomic and backed up.
 */
async function syncMcpProfilePatch(ctx, servers) {
  const patchPath = join(profileDirectory(ctx), 'cordis.patch.yml')
  let raw = ''
  try {
    raw = await readFile(patchPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  // `logLevel: silent` only mutes the expected "unresolved tag" warnings for
  // dialect tags such as `!!js`; real syntax errors still land in `doc.errors`.
  const doc = parseDocument(raw, { logLevel: 'silent' })
  if (doc.errors.length > 0) {
    throw new ManageError('profile-patch-invalid', `refusing to rewrite an unparseable profile patch: ${doc.errors[0].message}`)
  }
  if (doc.contents === null) doc.contents = doc.createNode([])
  if (!isSeq(doc.contents)) throw new ManageError('profile-patch-invalid', 'the profile patch is expected to be a top-level YAML array')

  // Drop every row this plugin owns, both as a bare entry and inside an
  // `insert` list. Walking backwards keeps the indices valid.
  const items = doc.contents.items
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const entry = items[index]
    if (!isMap(entry)) continue
    const insert = entry.get('insert')
    if (!isSeq(insert)) {
      if (isMcpRowNode(entry)) doc.delete(index)
      continue
    }
    const kept = insert.items.filter((row) => !isMcpRowNode(row))
    if (kept.length === 0) doc.delete(index)
    else if (kept.length !== insert.items.length) insert.items = kept
  }

  const enabled = servers.filter((s) => s.enabled !== false)
  if (enabled.length > 0) doc.add({ insert: enabled.map(mcpPatchRow) })

  const rendered = doc.toString({ lineWidth: 0 })
  if (rendered === raw) return
  await backUpFile(patchPath)
  await writeFileAtomic(patchPath, rendered)
}

/**
 * The ambient parent environment minus credential-shaped names and minus every
 * `DSH_*` name. Mirrors the harness subprocess seam so the smoke test spawns a
 * child with exactly the environment a real mcp-client instance would give it
 * (the package deliberately does not import `@deepseek-ai/dsh-subprocess`).
 */
function scrubbedParentEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    env[key] = value
  }
  return env
}

/** Connect to a server and list its tools (connection smoke test). */
async function testMcpConnection(server) {
  const client = new McpClient({ name: 'dsh-mcp-skills-test', version: PLUGIN_VERSION }, { capabilities: {} })
  const transport =
    server.transport === 'stdio'
      ? new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          env: { ...scrubbedParentEnv(), ...(server.env ?? {}) },
          cwd: server.cwd && server.cwd !== '' ? server.cwd : process.cwd(),
        })
      : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } })
  /** The connect + tools/list round trip, raced against a deadline below. */
  const listTools = async () => {
    await client.connect(transport)
    const tools = []
    let cursor
    do {
      const page = await client.listTools({ cursor })
      for (const tool of page.tools) tools.push(tool.name)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return tools
  }
  let timer
  try {
    return await Promise.race([
      listTools(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ManageError('mcp-test-timeout', `"${server.name}" did not answer within ${MCP_TEST_TIMEOUT_MS} ms`)),
          MCP_TEST_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    // Closing the client also tears down the spawned stdio child, so a hung
    // server cannot leave a process behind.
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
    [`${ROUTE_BASE}/skill.install`]: async (payload) => ({ value: await importUserSkills(payload) }),
    [`${ROUTE_BASE}/skill.remove`]: async (payload) => ({ value: { removed: true, name: await removeUserSkill(payload.name) } }),
    [`${ROUTE_BASE}/skill.enable`]: async (payload) => ({ value: { name: await setSkillEnabled(payload.name, payload.enabled === true) } }),
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
      if (server.transport === 'streamable-http') {
        try {
          new URL(server.url)
        } catch {
          throw new ManageError('invalid-mcp-server', `invalid url "${server.url}"`)
        }
      }
      const existing = await readMcpServers()
      const index = existing.findIndex((s) => s.name === server.name)
      const timeout = Number(server.toolCallTimeoutMs)
      const normalized = {
        name: server.name,
        enabled: server.enabled !== false,
        transport: server.transport,
        toolCallTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TOOL_CALL_TIMEOUT_MS,
        failOnStartupError: server.failOnStartupError === true,
        ...(server.transport === 'stdio'
          ? { command: server.command, args: Array.isArray(server.args) ? server.args : [], env: isRecord(server.env) ? server.env : {}, cwd: typeof server.cwd === 'string' ? server.cwd : '' }
          : { url: server.url, headers: isRecord(server.headers) ? server.headers : {} }),
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

/**
 * Whether a request may reach the management routes.
 *
 * These routes can write a persistent stdio server definition and then spawn
 * it, so a page from another origin must not be able to drive them through the
 * user's browser. Requests carrying no browser provenance headers at all
 * (curl, scripts) pass: they already own the machine's `$DSH_HOME`.
 */
function isSameOriginRequest(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  return originHost === req.headers.host
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
    if (!isSameOriginRequest(req)) {
      return sendJson(res, 403, { ok: false, error: wireError(new ManageError('cross-origin-forbidden', 'cross-origin requests are not accepted')) })
    }
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
 * Cordis plugin body: register the /dsh-mcp-skills route tree once the webServer
 * service appears (web profile only; headless/TUI simply never mount it).
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    try {
      scope.webServer.register({ kind: 'prefix', path: ROUTE_BASE, handler: dispatch(ctx) })
    } catch (error) {
      console.error(`[mcp-skills] route registration skipped: ${error}`)
    }
  })
}
