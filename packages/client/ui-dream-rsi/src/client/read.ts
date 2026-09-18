/**
 * Pure .dreamrsi/ store-file parsing and dashboard derivation.
 *
 * Everything here takes already-read file TEXT and returns plain data — no
 * React, no Remote, no clock — so the parsing layer is unit-testable and
 * deterministic. Malformed files degrade to `undefined` members rather than
 * throwing: a half-written store (the plugin writes these files while a
 * campaign runs) must render as something, never crash the panel.
 *
 * @module
 */

/** The store directory, relative to the session workspace root. */
export const STORE_DIR = '.dreamrsi'

// -- policy index (policies/policy-index.json) -------------------------------

/** One policy version's lineage row. */
export interface PolicyRow {
  version: string
  status: 'active' | 'retired' | string
  createdAt?: string | undefined
  parentId?: string | null | undefined
  name?: string | undefined
  kind?: 'dsl' | 'code' | string
}

/** The parsed policy index. */
export interface PolicyIndex {
  activeVersion?: string | undefined
  versions: PolicyRow[]
}

/**
 * Parse `policies/policy-index.json`.
 * @param text - the file's text, as read.
 * @returns the index, or undefined when the file is missing or malformed.
 */
export function parsePolicyIndex(text: string): PolicyIndex | undefined {
  const value = tryJson(text)
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const versions = Array.isArray(raw.versions)
    ? raw.versions.filter(isPolicyRow).sort(byVersionAsc)
    : []
  return {
    activeVersion: typeof raw.activeVersion === 'string' ? raw.activeVersion : undefined,
    versions,
  }
}

function isPolicyRow(value: unknown): value is PolicyRow & Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.version === 'string'
}

/** Zero-padded lexical order: v0002 before v0010. */
function byVersionAsc(left: PolicyRow, right: PolicyRow): number {
  return left.version < right.version ? -1 : left.version > right.version ? 1 : 0
}

// -- round records (trees/<roundId>/round.json) ------------------------------

/** One round's summary row for the table. */
export interface RoundRow {
  roundId: string
  status?: string | undefined
  policyVersion?: string | undefined
  startedAt?: string | undefined
  endedAt?: string | undefined
  nodes?: number | undefined
  attempts?: number | undefined
  bestScore?: number | undefined
  decisionRounds?: number | undefined
  summary?: string | undefined
}

/**
 * Parse one `trees/<roundId>/round.json`.
 * @param text - the file's text, as read.
 * @param roundId - the directory name the file lives under (authoritative id).
 * @returns the row, or undefined when the file is malformed.
 */
export function parseRoundRecord(text: string, roundId: string): RoundRow | undefined {
  const value = tryJson(text)
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const stats = typeof raw.stats === 'object' && raw.stats !== null
    ? raw.stats as Record<string, unknown>
    : {}
  return {
    roundId: typeof raw.roundId === 'string' ? raw.roundId : roundId,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    policyVersion: typeof raw.policyVersion === 'string' ? raw.policyVersion : undefined,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
    endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : undefined,
    nodes: typeof stats.nodes === 'number' ? stats.nodes : undefined,
    attempts: typeof stats.attempts === 'number' ? stats.attempts : undefined,
    bestScore: typeof stats.bestScore === 'number' ? stats.bestScore : undefined,
    decisionRounds: typeof stats.decisionRounds === 'number' ? stats.decisionRounds : undefined,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
  }
}

// -- dream reports (dreams/dNNNN.json) ---------------------------------------

/** One dream report's summary row. */
export interface DreamRow {
  runId: string
  createdAt?: string | undefined
  selectedCandidate?: number | undefined
  selectedName?: string | undefined
  selectedKind?: string | undefined
  selectedVersion?: string | undefined
  /** The selected candidate's mean replay score (Eq. 1), undefined when absent. */
  meanScore?: number | undefined
  /** How many worlds scored the selected candidate validly. */
  validWorlds?: number | undefined
  /** How many worlds were replayed at all. */
  worldCount?: number | undefined
  /** Whether the no-regression guard held. */
  noRegression?: boolean | undefined
  /** Whether the selected candidate was floored at the −∞ floor. */
  floored?: boolean | undefined
  /** First invalid reason on the selected candidate, when any. */
  invalid?: string | undefined
}

/** The −∞ floor the dreamer assigns illegal candidates. */
export const FLOORED_SCORE = -1e12

/**
 * Parse one `dreams/dNNNN.json` into a summary row.
 * @param text - the file's text, as read.
 * @param runId - the file's stem (authoritative id).
 * @returns the row, or undefined when the file is malformed.
 */
export function parseDreamReport(text: string, runId: string): DreamRow | undefined {
  const value = tryJson(text)
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const ranking = Array.isArray(raw.ranking) ? raw.ranking : []
  const selectedCandidate = typeof raw.selectedCandidate === 'number' ? raw.selectedCandidate : undefined
  const selected = ranking.find((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null
    && typeof (entry as Record<string, unknown>).candidate === 'number'
    && (selectedCandidate === undefined
      || (entry as Record<string, unknown>).candidate === selectedCandidate))
    ?? (typeof ranking[0] === 'object' && ranking[0] !== null ? ranking[0] as Record<string, unknown> : undefined)
  const perWorld = Array.isArray(selected?.perWorld) ? selected?.perWorld as unknown[] : []
  const validWorlds = typeof raw.validWorlds === 'number' ? raw.validWorlds : undefined
  const meanScore = typeof selected?.meanScore === 'number' ? selected.meanScore : undefined
  const invalid = typeof selected?.invalid === 'string' ? selected.invalid : undefined
  return {
    runId: typeof raw.runId === 'string' ? raw.runId : runId,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    selectedCandidate,
    selectedName: typeof raw.selectedName === 'string'
      ? raw.selectedName
      : typeof selected?.name === 'string' ? selected.name : undefined,
    selectedKind: typeof raw.selectedKind === 'string' ? raw.selectedKind : undefined,
    selectedVersion: typeof raw.selectedVersion === 'string' ? raw.selectedVersion : undefined,
    meanScore,
    validWorlds,
    worldCount: perWorld.length > 0 ? perWorld.length : undefined,
    noRegression: typeof raw.guards === 'object' && raw.guards !== null
      && typeof (raw.guards as Record<string, unknown>).noRegression === 'boolean'
      ? (raw.guards as Record<string, unknown>).noRegression as boolean
      : undefined,
    floored: meanScore !== undefined && meanScore <= FLOORED_SCORE / 2,
    invalid,
  }
}

// -- events (events.jsonl) ---------------------------------------------------

/** One event-log row for the activity tail. */
export interface EventRow {
  ts?: string | undefined
  call?: string | undefined
  policyVersion?: string | undefined
}

/**
 * Parse the first page of `events.jsonl` (JSON Lines).
 * @param text - the page's text, lines joined by \n.
 * @returns the parsed rows; malformed lines are skipped.
 */
export function parseEventsPage(text: string): EventRow[] {
  const rows: EventRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const value = tryJson(line)
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    rows.push({
      ts: typeof raw.ts === 'string' ? raw.ts : undefined,
      call: typeof raw.call === 'string' ? raw.call : undefined,
      policyVersion: typeof raw.policyVersion === 'string' ? raw.policyVersion : undefined,
    })
  }
  return rows
}

// -- config (config.json) ----------------------------------------------------

/** The store's recorded config, narrowed to what the panel shows. */
export interface StoreConfig {
  policyEngine?: string | undefined
  autoDream?: string | undefined
  devLoop?: string | undefined
  dataDir?: string | undefined
}

/**
 * Parse `config.json`.
 * @param text - the file's text, as read.
 * @returns the narrowed config, or undefined when absent or malformed.
 */
export function parseStoreConfig(text: string): StoreConfig | undefined {
  const value = tryJson(text)
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const config = typeof raw.config === 'object' && raw.config !== null
    ? raw.config as Record<string, unknown>
    : raw
  return {
    policyEngine: typeof config.policyEngine === 'string' ? config.policyEngine : undefined,
    autoDream: typeof config.autoDream === 'string' ? config.autoDream : undefined,
    devLoop: typeof config.devLoop === 'string' ? config.devLoop : undefined,
    dataDir: typeof config.dataDir === 'string' ? config.dataDir : undefined,
  }
}

// -- discovery-tree nodes (trees/<roundId>/nodes.jsonl) ----------------------

/** One discovery-tree node's graph row (a narrowed NodeRecord). */
export interface NodeRow {
  id: string
  roundId?: string | undefined
  parentId?: string | null | undefined
  kind?: string | undefined
  mechanism?: string | undefined
  summary?: string | undefined
  score?: number | undefined
  valid?: boolean | undefined
  evaluated?: boolean | undefined
  failClass?: string | undefined
  notes?: string | undefined
  depth?: number | undefined
  policyVersion?: string | undefined
  createdAt?: string | undefined
}

/**
 * Parse a page of `trees/<roundId>/nodes.jsonl` (JSON Lines).
 * @param text - the page's text, lines joined by \n.
 * @returns the parsed rows; malformed lines are skipped.
 */
export function parseNodesPage(text: string): NodeRow[] {
  const rows: NodeRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const value = tryJson(line)
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    const action = typeof raw.action === 'object' && raw.action !== null
      ? raw.action as Record<string, unknown>
      : {}
    const outcome = typeof raw.outcome === 'object' && raw.outcome !== null
      ? raw.outcome as Record<string, unknown>
      : {}
    const state = typeof raw.state === 'object' && raw.state !== null
      ? raw.state as Record<string, unknown>
      : {}
    const lineage = typeof raw.lineage === 'object' && raw.lineage !== null
      ? raw.lineage as Record<string, unknown>
      : {}
    const id = typeof raw.id === 'string' ? raw.id : undefined
    if (id === undefined) continue
    rows.push({
      id,
      roundId: typeof raw.roundId === 'string' ? raw.roundId : undefined,
      parentId: typeof raw.parentId === 'string'
        ? raw.parentId
        : raw.parentId === null ? null : undefined,
      kind: typeof raw.kind === 'string' ? raw.kind : undefined,
      mechanism: typeof action.mechanism === 'string' ? action.mechanism : undefined,
      summary: typeof action.summary === 'string' ? action.summary : undefined,
      score: typeof outcome.score === 'number' ? outcome.score : undefined,
      valid: typeof outcome.valid === 'boolean' ? outcome.valid : undefined,
      evaluated: typeof outcome.evaluated === 'boolean' ? outcome.evaluated : undefined,
      failClass: typeof outcome.failClass === 'string' ? outcome.failClass : undefined,
      notes: typeof raw.notes === 'string' ? raw.notes : undefined,
      depth: typeof state.depth === 'number' ? state.depth : undefined,
      policyVersion: typeof lineage.policyVersion === 'string' ? lineage.policyVersion : undefined,
      createdAt: typeof lineage.createdAt === 'string' ? lineage.createdAt : undefined,
    })
  }
  return rows
}

/** Children index of one round's node set: parent id → child ids in file order. */
export interface TreeIndex {
  children: Map<string, string[]>
  /** Node ids with no parent (the roots of the visible forest). */
  roots: string[]
}

/**
 * Index one round's nodes for traversal and layout.
 * @param nodes - the parsed node rows.
 * @returns the children index and the root ids (file order preserved).
 */
export function buildTreeIndex(nodes: readonly NodeRow[]): TreeIndex {
  const children = new Map<string, string[]>()
  const ids = new Set(nodes.map(node => node.id))
  const roots: string[] = []
  for (const node of nodes) {
    // A parent that is itself absent from the file (a truncated page) cannot
    // be drawn as a parent; such a node counts as a root of the visible forest.
    if (node.parentId == null || !ids.has(node.parentId)) {
      roots.push(node.id)
      continue
    }
    const list = children.get(node.parentId)
    if (list === undefined) children.set(node.parentId, [node.id])
    else list.push(node.id)
  }
  return { children, roots }
}

/**
 * The best path: the root→leaf path with the highest SUM of node scores (a
 * chain's compound result), ties broken by the first leaf in file order.
 * Unevaluated nodes contribute 0.
 * @param nodes - the parsed node rows of one round.
 * @returns the path as node ids from root to leaf, or undefined when no node
 *   carries a score at all (nothing to be best at).
 */
export function bestPath(nodes: readonly NodeRow[]): string[] | undefined {
  if (!nodes.some(node => typeof node.score === 'number' && !Number.isNaN(node.score))) {
    return undefined
  }
  const { children, roots } = buildTreeIndex(nodes)
  const scores = new Map(nodes.map(node => [node.id, typeof node.score === 'number' && !Number.isNaN(node.score) ? node.score : 0]))
  let best: { path: string[]; total: number } | undefined
  /** Depth-first over the indexed forest; file order = tie order. */
  const walk = (id: string, path: string[], total: number): void => {
    const kids = children.get(id)
    const nextPath = [...path, id]
    const nextTotal = total + (scores.get(id) ?? 0)
    if (kids === undefined) {
      if (best === undefined || nextTotal > best.total) best = { path: nextPath, total: nextTotal }
      return
    }
    for (const kid of kids) walk(kid, nextPath, nextTotal)
  }
  for (const root of roots) walk(root, [], 0)
  if (best === undefined) return undefined
  return best.path
}

// -- derivation --------------------------------------------------------------

/** The champion the hero card shows. */
export interface Champion {
  score: number
  roundId: string
  policyVersion?: string | undefined
}

/**
 * Derive the champion: the highest bestScore across rounds (ties keep the
 * earliest round — the first to reach the score, independent of the input
 * order). Only scored rounds count.
 * @param rounds - the parsed round rows.
 * @returns the champion, or undefined when no round carries a score.
 */
export function deriveChampion(rounds: readonly RoundRow[]): Champion | undefined {
  // Chronological walk, whatever order the caller carries (the dashboard is
  // newest-first): strict > then keeps the first round to reach the max.
  const chronological = [...rounds].sort((left, right) => left.roundId < right.roundId ? -1 : left.roundId > right.roundId ? 1 : 0)
  let best: Champion | undefined
  for (const round of chronological) {
    if (typeof round.bestScore !== 'number' || Number.isNaN(round.bestScore)) continue
    if (best === undefined || round.bestScore > best.score) {
      best = { score: round.bestScore, roundId: round.roundId, policyVersion: round.policyVersion }
    }
  }
  return best
}

/**
 * Total discovered nodes across rounds.
 * @param rounds - the parsed round rows.
 * @returns the sum of per-round node counts (unscored rounds count 0).
 */
export function totalNodes(rounds: readonly RoundRow[]): number {
  return rounds.reduce((sum, round) => sum + (typeof round.nodes === 'number' ? round.nodes : 0), 0)
}

// -- plumbing ----------------------------------------------------------------

/** Parse JSON, returning undefined instead of throwing. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
