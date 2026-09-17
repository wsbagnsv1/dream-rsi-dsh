/**
 * Preset-gating tests: the `dream-rsi` agent preset
 * (`preset/dream-rsi/`) and the reworked package-root `cordis.yml` overlay.
 *
 * Grounded in the harness references (read-only):
 * - `packages/preset/agent-presets/README.md` — a preset directory holds an
 *   `agent.cordis.yml` (a LIST of named plugin rows; the roster's health check
 *   refuses non-lists and unnamed rows) plus optional `preset.yml` display
 *   metadata; each row must name "a package present above the harness base or
 *   a file that exists", so an absolute path to the plugin entry must stat.
 * - `presets/standard/agent.cordis.yml` — the full assembly the dream-rsi
 *   preset duplicates; service rows sit inside `isolate` realm groups,
 *   tool-only rows need no realm.
 * - `packages/preset/persona/README.md` — persona `prefix`/`suffix` templates
 *   with `{{cwd}}`/`{{model}}` variables.
 *
 * The YAML files use `!!js` expression tags (platform gates), parsed here with
 * a permissive pass-through tag — the tests never evaluate them.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(TEST_DIR, '..')
const PRESET_DIR = path.join(PACKAGE_ROOT, 'preset', 'dream-rsi')

/** Read-only harness reference for the standard assembly comparison (P6).
 * Set DREAM_RSI_HARNESS_ROOT to a DeepSeek Harness checkout root to enable
 * the shipped-assembly comparison; the test skips when unset or invalid. */
const HARNESS_STANDARD = process.env.DREAM_RSI_HARNESS_ROOT
  ? path.join(process.env.DREAM_RSI_HARNESS_ROOT, 'packages', 'preset', 'agent-presets', 'presets', 'standard', 'agent.cordis.yml')
  : undefined

/** Parse YAML with a pass-through `!!js` tag (the standard's platform gates). */
function parseYaml(content: string): unknown {
  return parse(content, {
    customTags: [{ tag: '!!js', resolve: (value: string): string => value }],
    // yaml still emits a harmless TAG_RESOLVE_FAILED warning for `!!js` before
    // the custom tag resolves it; keep test output clean (real errors remain).
    logLevel: 'error',
  })
}

async function readYaml(file: string): Promise<unknown> {
  return parseYaml(await readFile(file, 'utf8'))
}

type Row = Record<string, unknown>

/** Flatten a composition list, recursing into `group: true` rows' config lists. */
function flattenRows(list: unknown[]): Row[] {
  const out: Row[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as Row
    out.push(row)
    if (row.group === true && Array.isArray(row.config)) out.push(...flattenRows(row.config))
  }
  return out
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Every inserted row of a patch-overlay document (a list of `{ insert: [...] }` ops). */
function insertedRows(doc: unknown): Row[] {
  const out: Row[] = []
  if (!Array.isArray(doc)) return out
  for (const op of doc) {
    if (op === null || typeof op !== 'object') continue
    const insert = (op as Row).insert
    if (Array.isArray(insert)) {
      for (const row of insert) {
        if (row !== null && typeof row === 'object' && !Array.isArray(row)) out.push(row as Row)
      }
    }
  }
  return out
}

let rows: Row[]

describe('preset/dream-rsi/agent.cordis.yml — composition validation', () => {
  it('exists and parses as a YAML list of rows (roster health: "a list of named plugin rows")', async () => {
    expect(existsSync(PRESET_DIR)).toBe(true)
    expect(existsSync(path.join(PRESET_DIR, 'agent.cordis.yml'))).toBe(true)
    const composition = await readYaml(path.join(PRESET_DIR, 'agent.cordis.yml'))
    expect(Array.isArray(composition)).toBe(true)
    rows = flattenRows(composition as unknown[])
    expect(rows.length).toBeGreaterThan(10)
  })

  it('every row (through group children) carries a non-empty id and name', () => {
    for (const row of rows) {
      expect(typeof row.id, `row id: ${JSON.stringify(row)}`).toBe('string')
      expect(String(row.id).length).toBeGreaterThan(0)
      expect(typeof row.name, `row ${String(row.id)} name`).toBe('string')
      expect(String(row.name).length).toBeGreaterThan(0)
    }
  })

  it('contains the dream-rsi row resolving to this package\'s existing entry file', () => {
    const row = rows.find((r) => r.id === 'dream-rsi')
    expect(row).toBeDefined()
    const name = String(must(row).name)
    // Portable repo ships a RELATIVE row ('../dist/index.js' — resolves against
    // the preset dir, i.e. roots-discovery from this repo). Installers rewrite
    // it to an absolute path for copy-installs. Accept both, but the resolved
    // file must exist and stay inside THIS package.
    const resolved = path.isAbsolute(name) ? name : path.resolve(PRESET_DIR, name)
    expect(existsSync(resolved)).toBe(true)
    const rel = path.relative(PACKAGE_ROOT, resolved)
    expect(rel.startsWith('..')).toBe(false)
    expect(rel.replace(/\\/g, '/')).toMatch(/^(dist|src)\/index\.js$/)
  })

  it('carries the plugin config inline on the dream-rsi row (preset-mounted plugins carry config)', () => {
    const row = must(rows.find((r) => r.id === 'dream-rsi'))
    expect(row.config).toBeTypeOf('object')
    const config = row.config as Row
    expect(typeof config.dataDir).toBe('string')
    expect(String(config.dataDir).length).toBeGreaterThan(0)
  })

  it('keeps the standard persona row and extends its suffix with the Dream-RSI workflow guidance', () => {
    const persona = rows.find((r) => r.id === 'persona')
    expect(persona).toBeDefined()
    expect(String(must(persona).name)).toBe('@deepseek-ai/dsh-persona')
    const config = must(persona).config as Row
    // Standard semantics kept: prefix carries {{model}}, suffix carries {{cwd}}.
    expect(String(config.prefix)).toContain('{{model}}')
    expect(String(config.suffix)).toContain('{{cwd}}')
    // Extended, not replaced: the standard working-directory line is still the
    // suffix head, and the Dream-RSI loop guidance follows.
    expect(String(config.suffix).startsWith('Your working directory is {{cwd}}.')).toBe(true)
    const suffix = String(config.suffix)
    for (const tool of ['dreamrsi_begin_round', 'dreamrsi_log_decision', 'dreamrsi_end_round', 'dreamrsi_history', 'dreamrsi_dream', 'dreamrsi_policy_get', 'dreamrsi_policy_set']) {
      expect(suffix, `persona suffix mentions ${tool}`).toContain(tool)
    }
    expect(suffix).toContain('.dreamrsi')
  })

  it('duplicates the standard assembly: every shipped standard row id is present, plus dream-rsi', async () => {
    // Read-only harness reference; the comparison skips unless
    // DREAM_RSI_HARNESS_ROOT points at a DeepSeek Harness checkout.
    if (HARNESS_STANDARD === undefined || !existsSync(HARNESS_STANDARD)) return
    const standard = await readYaml(HARNESS_STANDARD)
    const standardIds = new Set(flattenRows(standard as unknown[]).map((row) => String(row.id)))
    const presetIds = new Set(rows.map((row) => String(row.id)))
    for (const id of standardIds) {
      expect(presetIds.has(id), `missing standard row id "${id}"`).toBe(true)
    }
    expect(presetIds.has('dream-rsi')).toBe(true)
  })

  it('keeps standard realm discipline: dream-rsi is a plain tool-only row; service groups keep isolate realms', () => {
    const dreamRow = must(rows.find((r) => r.id === 'dream-rsi'))
    expect(dreamRow.isolate).toBeUndefined()
    for (const [groupId, realmKeys] of [
      ['planning', ['planMode']],
      ['compaction', ['compaction', 'toolResultPruner']],
      ['delegation', ['workflowEngine']],
    ] as const) {
      const group = rows.find((r) => r.id === groupId)
      expect(group, `${groupId} group present`).toBeDefined()
      const isolate = must(group).isolate as Row
      expect(isolate).toBeTypeOf('object')
      for (const key of realmKeys) expect(isolate[key], `${groupId} isolate.${key}`).toBe(true)
    }
  })

  it('uses a valid preset directory id ([a-z0-9][a-z0-9-]*)', () => {
    expect(path.basename(PRESET_DIR)).toBe('dream-rsi')
    expect(/^[\da-z][\da-z-]*$/.test(path.basename(PRESET_DIR))).toBe(true)
  })
})

describe('preset/dream-rsi/preset.yml — display metadata', () => {
  it('exists and carries name "Dream-RSI" plus a non-empty description', async () => {
    const file = path.join(PRESET_DIR, 'preset.yml')
    expect(existsSync(file)).toBe(true)
    const meta = await readYaml(file) as Row
    expect(meta.name).toBe('Dream-RSI')
    expect(typeof meta.description).toBe('string')
    expect(String(meta.description).length).toBeGreaterThan(10)
  })
})

describe('preset discovery overlay (examples/) — no host mount in the preset path', () => {
  const OVERLAY = path.join(PACKAGE_ROOT, 'examples', 'cordis.presets-overlay.yml')

  it('no longer inserts the dream-rsi plugin row (baseline stays clean)', async () => {
    const doc = await readYaml(OVERLAY)
    for (const row of insertedRows(doc)) {
      const name = str(row.name)
      expect(name.includes('index'), `inserted row ${String(row.id)} must not reference the plugin entry`).toBe(false)
      expect(String(row.id)).not.toBe('dream-rsi')
    }
  })

  it('inserts an agent-presets row whose roots point at a preset directory with trust: system', async () => {
    const doc = await readYaml(OVERLAY)
    const inserts = insertedRows(doc)
    const roster = inserts.find((row) => row.name === '@deepseek-ai/dsh-agent-presets')
    expect(roster).toBeDefined()
    const config = must(roster).config as Row
    const roots = config.roots
    expect(Array.isArray(roots)).toBe(true)
    // The shipped example carries a <REPO_ABSOLUTE_PATH> placeholder; accept
    // any root that names a `preset` directory (resolved or placeholder).
    const dreamRoot = must((roots as Row[]).find((root) => String(root.path).replace(/\\/g, '/').endsWith('/preset')))
    expect(dreamRoot.trust).toBe('system')
  })

  it('contains no tool-subagent insert row (per-call preset override lives in the harness)', async () => {
    const doc = await readYaml(OVERLAY)
    for (const row of insertedRows(doc)) {
      expect(String(row.name), `unexpected insert: ${String(row.name)}`).not.toContain('tool-subagent')
    }
    const raw = await readFile(OVERLAY, 'utf8')
    expect(raw).not.toContain('subagent_dream')
    expect(raw).not.toContain('childPreset')
  })

  it('keeps the legacy host-mount as an optional example file that still inserts the plugin row', async () => {
    const file = path.join(PACKAGE_ROOT, 'examples', 'cordis.host-mount.yml.example')
    expect(existsSync(file)).toBe(true)
    const doc = await readYaml(file)
    const legacy = must(insertedRows(doc).find((row) => row.id === 'dream-rsi'))
    const name = String(must(legacy).name)
    // Shipped with a <REPO_ABSOLUTE_PATH> placeholder; the installer/user makes
    // it absolute. Assert it names the plugin entry.
    expect(name).toContain('index')
  })
})

describe('v0.2 paper-faithful preset row (task-15 fences)', () => {
  /** The dream-rsi row of the preset composition. */
  async function dreamRow(): Promise<{ row: Row; raw: string }> {
    const text = await readFile(path.join(PRESET_DIR, 'agent.cordis.yml'), 'utf8')
    const doc = await readYaml(path.join(PRESET_DIR, 'agent.cordis.yml'))
    const row = must((doc as Row[]).find((entry) => entry.id === 'dream-rsi'))
    return { row, raw: text }
  }

  it('injects the host subprocess seam alongside tools', async () => {
    const { row } = await dreamRow()
    expect(row.inject).toEqual(['tools', 'subprocess'])
  })

  it('carries the v0.2 paper-faithful config defaults inline', async () => {
    const { row } = await dreamRow()
    const config = row.config as Row
    expect(config.policyEngine).toBe('code')
    expect(config.autoDream).toBe('every-cycle')
    expect(config.trajectoryCap).toBe(20)
    expect(config.policyEpisodeTimeoutMs).toBe(30000)
    expect(config.devLoop).toBe('agent-relay')
    expect(config.poolSize).toBe(32)
    // F3: strictly on-manifold replay by default (paper-faithful).
    expect(config.estimate).toBe('off')
  })

  it('persona suffix carries the v2 code-policy workflow text', async () => {
    const { row } = await dreamRow()
    const persona = must((await readYaml(path.join(PRESET_DIR, 'agent.cordis.yml')) as Row[]).find((entry) => entry.id === 'persona'))
    void row
    const suffix = String((persona.config as Row).suffix)
    expect(suffix).toContain('solve(view)') // code policies, not a JSON DSL
    expect(suffix.toLowerCase()).toContain('mandatory') // dreaming is a mandatory stage
    expect(suffix).toContain('trajectory') // digests surfaced to the agent
    expect(suffix).toContain('policySource')
    expect(suffix).toContain('{ code }') // agent-relay submission shape
  })

  it('keeps the entry reference travel-with-preset (preset-relative, no machine path)', async () => {
    const { row, raw } = await dreamRow()
    const name = String(row.name)
    expect(path.isAbsolute(name)).toBe(false)
    expect(name).toContain('dist/index.js')
    // Sanitized repo: no absolute machine paths anywhere in the preset.
    expect(raw).not.toMatch(/[A-Z]:\\|\/Users\//)
  })
})

function must<T>(value: T | null | undefined, message = 'expected a value'): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}
