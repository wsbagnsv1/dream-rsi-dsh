/**
 * The panel's asynchronous half: reading the .dreamrsi/ store into the dashboard.
 *
 * The component never awaits anything. It calls `refresh`, and this face
 * performs the reads and writes the outcome through the store's own actions —
 * the Slot-standard `inject` shape, so the session id is resolved by the
 * framework and the write set stays the store's.
 *
 * Every path is a workspace-RELATIVE path: the endpoint resolves it against
 * the addressed session's workspace root, so the panel reads the same
 * `.dreamrsi/` the preset-gated tools write. The read is strictly one-way:
 * nothing here ever writes to the store.
 *
 * Per tab, one refresh is in force: asking again retires the refresh still in
 * flight, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: no request is made for a record that already ended, and when the
 * record goes away the bucket is forgotten.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileText } from '@deepseek-ai/dsh-api-workspace-files/types'
import {
  parseDreamReport, parseEventsPage, parseNodesPage, parsePolicyIndex, parseRoundRecord,
  parseStoreConfig, STORE_DIR,
} from './read.ts'
import type { DreamRow, EventRow, NodeRow, PolicyRow, RoundRow } from './read.ts'
import { toIterationNodes } from './progression.ts'
import type { RoundNodes } from './progression.ts'
import type { DashboardData, createDreamRsiStore } from './store.ts'

/** How many recent rounds the panel reads (older ones are cut). */
export const ROUND_CAP = 12
/** How many recent dream reports the panel reads. */
export const DREAM_CAP = 8
/** How many leading event lines the panel reads. */
export const EVENT_PAGE_LINES = 120
/** Lines per nodes.jsonl page. */
export const NODES_PAGE_LINES = 2000
/** Page cap for one round's nodes read (≈10k nodes). */
export const NODES_PAGE_CAP = 5

/** The slice of the Client Remote this package calls. */
export type WorkspaceFilesRemote = Pick<ClientRemote, 'workspaceFiles'>

/** The actions the face writes through. */
type FaceActions = BoundActions<ReturnType<typeof createDreamRsiStore>>

/** One directory listing, cut to a name list plus its truncation flag. */
interface DirNames {
  names: readonly string[]
  truncated: boolean
}

/**
 * List a directory's child names.
 * @returns the names, or undefined when the listing failed.
 */
async function listDir(
  remote: WorkspaceFilesRemote,
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
): Promise<DirNames | undefined> {
  const result = await remote.workspaceFiles.list(sessionId, path, signal)
  if (!result.ok) return undefined
  return { names: result.value.entries.map(entry => entry.name), truncated: result.value.truncated }
}

/**
 * Read one store file's first page.
 *
 * JSON store files are small (KBs); a 2000-line page covers any sane record.
 * A file past the cap parses from what arrived and fails gracefully — the
 * parsers tolerate truncated JSON.
 * @returns the page text, or undefined when the read failed.
 */
async function readJsonFile(
  remote: WorkspaceFilesRemote,
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await remote.workspaceFiles.read(sessionId, path, { offset: 1, limit: 2000 }, signal)
  if (!result.ok) return undefined
  return result.value.text
}

/** Read the first page of a text file; undefined on any failure. */
async function readPage(
  remote: WorkspaceFilesRemote,
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
): Promise<WorkspaceFileText | undefined> {
  const result = await remote.workspaceFiles.read(sessionId, path, { offset: 1, limit: EVENT_PAGE_LINES }, signal)
  if (!result.ok) return undefined
  return result.value
}

/**
 * Bind the panel's face to one Remote face.
 * @param remote - the Client Remote carrying the `workspaceFiles` namespace.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function dreamRsiFace(
  remote: WorkspaceFilesRemote,
): (sessionId: SessionId, actions: FaceActions) => DreamRsiInjected {
  return (sessionId: SessionId, actions: FaceActions): DreamRsiInjected => {
    /** Per tab: the refresh generation; the latest request wins. */
    const generations = new Map<string, number>()
    /** Per tab: the tree-read generation, independent of the dashboard's. */
    const treeGenerations = new Map<string, number>()
    const nextGeneration = (map: Map<string, number>, tabId: string): number => {
      const generation = (map.get(tabId) ?? 0) + 1
      map.set(tabId, generation)
      return generation
    }
    const refresh = (tabId: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = nextGeneration(generations, tabId)
      actions.started(tabId)
      void load(remote, sessionId, signal).then((outcome) => {
        if (generations.get(tabId) !== generation) return
        if (outcome.kind === 'loaded') actions.loaded(tabId, outcome.data, Date.now())
        else if (outcome.kind === 'missing') actions.missing(tabId)
        else actions.failed(tabId, outcome.message)
      })
    }
    const selectRound = (tabId: string, roundId: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = nextGeneration(treeGenerations, tabId)
      actions.treeLoading(tabId, roundId)
      void loadNodes(remote, sessionId, roundId, signal).then((outcome) => {
        if (treeGenerations.get(tabId) !== generation) return
        if (outcome.kind === 'loaded') actions.treeLoaded(tabId, roundId, outcome.nodes, outcome.truncated)
        else actions.treeFailed(tabId, outcome.message)
      })
    }
    return {
      refresh,
      selectRound,
      forget: (tabId: string) => {
        generations.delete(tabId)
        treeGenerations.delete(tabId)
        actions.forget(tabId)
      },
    }
  }
}

/** The panel's injected business face, as the body receives it. */
export interface DreamRsiInjected {
  /**
   * Read the store into the dashboard.
   * @param tabId - the tab being drawn.
   * @param signal - the tab record's lifetime.
   */
  readonly refresh: (tabId: string, signal: AbortSignal) => void
  /**
   * Read one round's discovery tree into the graph view.
   * @param tabId - the tab being drawn.
   * @param roundId - the round whose nodes to read.
   * @param signal - the tab record's lifetime.
   */
  readonly selectRound: (tabId: string, roundId: string, signal: AbortSignal) => void
  /**
   * Drop one tab's state, for a tab record that is gone.
   * @param tabId - the tab that went away.
   */
  readonly forget: (tabId: string) => void
}

/** The outcome of one full store read. */
export type LoadOutcome =
  | { kind: 'loaded'; data: DashboardData }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string }

/** The outcome of one round's nodes read. */
export type NodesOutcome =
  | { kind: 'loaded'; nodes: NodeRow[]; truncated: boolean }
  | { kind: 'failed'; message: string }

/**
 * Read every file the dashboard draws, then derive.
 *
 * Reads fan out; each individual failure degrades to an empty section — the
 * store is being written while we read, and a half-written file must not blank
 * the panel. Only a workspace with no readable `.dreamrsi/` at all is the
 * documented empty state, and only an unexpected root failure is an error.
 */
export async function load(
  remote: WorkspaceFilesRemote,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<LoadOutcome> {
  const [root, configText, indexText, trees, dreams, eventsPage] = await Promise.all([
    listDir(remote, sessionId, STORE_DIR, signal),
    readJsonFile(remote, sessionId, `${STORE_DIR}/config.json`, signal),
    readJsonFile(remote, sessionId, `${STORE_DIR}/policies/policy-index.json`, signal),
    listRoundRows(remote, sessionId, signal),
    listDreamRows(remote, sessionId, signal),
    readPage(remote, sessionId, `${STORE_DIR}/events.jsonl`, signal),
  ])

  if (root === undefined) {
    // The root listing failed. Distinguish "no store" (the empty state) from
    // "store unreadable" (an error) by probing a file every real store has.
    const probe = await remote.workspaceFiles.read(
      sessionId, `${STORE_DIR}/policies/policy-index.json`, { offset: 1, limit: 1 }, signal)
    if (!probe.ok && probe.error.code === 'workspace-file/not-found') return { kind: 'missing' }
    if (!probe.ok) return { kind: 'failed', message: probe.error.message }
  }

  const index = indexText === undefined ? undefined : parsePolicyIndex(indexText)
  const policies: PolicyRow[] = index?.versions ?? []
  const rounds: RoundRow[] = trees?.rounds ?? []
  const dreamRows: DreamRow[] = dreams?.dreams ?? []
  const events: EventRow[] = eventsPage === undefined ? [] : parseEventsPage(eventsPage.text)

  // Phase 2: every round's nodes, for the iteration progression. Rounds are
  // few (the listing cap); each read pages internally. A round whose nodes
  // fail to read contributes nothing — the same degrade-softly discipline.
  const nodeLists = await Promise.all(rounds.map(async (round): Promise<RoundNodes> => {
    const outcome = await loadNodes(remote, sessionId, round.roundId, signal)
    return outcome.kind === 'loaded'
      ? { roundId: round.roundId, nodes: outcome.nodes, truncated: outcome.truncated }
      : { roundId: round.roundId, nodes: [], truncated: false }
  }))
  const { iterations, truncated: nodesTruncated } = toIterationNodes(nodeLists)

  const data: DashboardData = {
    config: configText === undefined ? undefined : parseStoreConfig(configText),
    policies,
    activeVersion: index?.activeVersion,
    rounds,
    roundsTruncated: trees?.truncated ?? false,
    attempts: iterations,
    attemptsTruncated: nodesTruncated,
    dreams: dreamRows,
    dreamsTruncated: dreams?.truncated ?? false,
    events,
    eventsTruncated: eventsPage !== undefined && !eventsPage.eof,
  }
  return { kind: 'loaded', data }
}

/** The trees/ directory: round rows newest first, cut to the cap. */
async function listRoundRows(
  remote: WorkspaceFilesRemote,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<{ rounds: RoundRow[]; truncated: boolean } | undefined> {
  const listing = await listDir(remote, sessionId, `${STORE_DIR}/trees`, signal)
  if (listing === undefined) return undefined
  const ids = listing.names.filter(name => name.startsWith('r')).sort(descending).slice(0, ROUND_CAP)
  const rounds: RoundRow[] = []
  for (const roundId of ids) {
    const text = await readJsonFile(remote, sessionId, `${STORE_DIR}/trees/${roundId}/round.json`, signal)
    if (text === undefined) continue
    const row = parseRoundRecord(text, roundId)
    if (row !== undefined) rounds.push(row)
  }
  return { rounds, truncated: listing.truncated }
}

/** The dreams/ directory: report rows newest first, cut to the cap. */
async function listDreamRows(
  remote: WorkspaceFilesRemote,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<{ dreams: DreamRow[]; truncated: boolean } | undefined> {
  const listing = await listDir(remote, sessionId, `${STORE_DIR}/dreams`, signal)
  if (listing === undefined) return undefined
  const ids = listing.names
    .filter(name => name.startsWith('d') && name.endsWith('.json'))
    .sort(descending)
    .slice(0, DREAM_CAP)
  const dreams: DreamRow[] = []
  for (const name of ids) {
    const text = await readJsonFile(remote, sessionId, `${STORE_DIR}/dreams/${name}`, signal)
    if (text === undefined) continue
    const row = parseDreamReport(text, name.replace(/\.json$/, ''))
    if (row !== undefined) dreams.push(row)
  }
  return { dreams, truncated: listing.truncated }
}

/** Newest-first order for zero-padded ids (r0010 sorts before r0009). */
function descending(left: string, right: string): number {
  return left < right ? 1 : left > right ? -1 : 0
}

/**
 * Read one round's `nodes.jsonl`, page by page, up to the page cap.
 *
 * The first page covers every sane round (the live store's biggest tree is
 * well under one page); a larger tree keeps paging until eof or the cap, and
 * the truncation flag travels with the rows so the graph can say so.
 */
export async function loadNodes(
  remote: WorkspaceFilesRemote,
  sessionId: SessionId,
  roundId: string,
  signal: AbortSignal,
): Promise<NodesOutcome> {
  const path = `${STORE_DIR}/trees/${roundId}/nodes.jsonl`
  const lines: string[] = []
  let truncated = false
  for (let page = 0; page < NODES_PAGE_CAP; page += 1) {
    const offset = page * NODES_PAGE_LINES + 1
    const result = await remote.workspaceFiles.read(sessionId, path, { offset, limit: NODES_PAGE_LINES }, signal)
    if (!result.ok) {
      if (page === 0 && result.error.code === 'workspace-file/not-found') {
        // A directory without nodes.jsonl is an empty tree, not an error.
        return { kind: 'loaded', nodes: [], truncated: false }
      }
      return { kind: 'failed', message: result.error.message }
    }
    const { text, eof } = result.value
    lines.push(text)
    if (eof) return { kind: 'loaded', nodes: parseNodesPage(lines.join('\n')), truncated: false }
  }
  truncated = true
  return { kind: 'loaded', nodes: parseNodesPage(lines.join('\n')), truncated }
}
