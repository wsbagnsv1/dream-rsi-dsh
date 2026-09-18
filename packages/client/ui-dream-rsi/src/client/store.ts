/**
 * The dashboard's view state: what the panel has read from the store, per tab.
 *
 * The panel is not one resource — it aggregates many files of a directory the
 * campaign rewrites while it runs, so it is state this type owns. It lives in
 * a Slot-standard exclusive store (one instance per session), bucketed by tab
 * id because two tabs of this kind in one session refresh independently.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { DreamRow, EventRow, NodeRow, PolicyRow, RoundRow, StoreConfig } from './read.ts'

/** Everything the panel draws, derived from the store files at refresh time. */
export interface DashboardData {
  /** The store's recorded config (may be absent on older stores). */
  config: StoreConfig | undefined
  /** The policy lineage, oldest first. */
  policies: PolicyRow[]
  /** The active policy version, when the index names one. */
  activeVersion: string | undefined
  /** Per-round rows, newest first. */
  rounds: RoundRow[]
  /** Whether the rounds list was cut by the read cap. */
  roundsTruncated: boolean
  /** Dream report rows, newest first. */
  dreams: DreamRow[]
  /** Whether the dreams list was cut by the read cap. */
  dreamsTruncated: boolean
  /** The last events on the log, oldest first. */
  events: EventRow[]
  /** Whether the events page hit the read cap before the file's end. */
  eventsTruncated: boolean
}

/** What one tab's panel is doing right now. */
export type LoadStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | /** the workspace has no `.dreamrsi/` directory */ 'missing'
  | /** a read failed and no previous data is shown */ 'failed'

/** What one tab's graph view is doing right now. */
export type TreeStatus = 'idle' | 'loading' | 'ready' | 'failed'

/** One round's loaded discovery tree (the graph view's data). */
export interface TreeSlice {
  /** The round whose nodes are loaded (undefined before the first load). */
  roundId: string | undefined
  status: TreeStatus
  /** The parsed node rows, in file order (truncated to the read cap). */
  nodes: NodeRow[]
  /** The nodes read hit the page cap before the file's end. */
  truncated: boolean
  /** Why the last tree read failed (when `status` is `failed`). */
  failure: string | undefined
}

/** The idle tree slice a fresh bucket starts with. */
function idleTree(): TreeSlice {
  return { roundId: undefined, status: 'idle', nodes: [], truncated: false, failure: undefined }
}

/** One tab's panel state. */
export interface DreamRsiTabState {
  status: LoadStatus
  /** The dashboard as of `loadedAt`; retained across reloads so the panel never blanks. */
  data: DashboardData | undefined
  /** Wall-clock read at the last successful refresh. */
  loadedAt: number | undefined
  /** Why the last refresh failed (when `status` is `failed` or stale). */
  failure: string | undefined
  /** The graph view's slice: one selected round's discovery tree. */
  tree: TreeSlice
}

/** Every tab's panel, keyed by tab id. */
export interface DreamRsiState {
  byTab: Record<string, DreamRsiTabState>
}

/**
 * One tab's bucket, which every writer relies on.
 * @param state - the draft.
 * @param tabId - the tab being written.
 * @returns the tab's state.
 */
function bucket(state: DreamRsiState, tabId: string): DreamRsiTabState {
  const tab = state.byTab[tabId]
  if (tab === undefined) throw new Error(`ui-dream-rsi: no state for tab "${tabId}"`)
  return tab
}

/** The panel store's write set; every action names the tab it writes. */
type DreamRsiActions = {
  started: (draft: DreamRsiState, tabId: string) => void
  loaded: (draft: DreamRsiState, tabId: string, data: DashboardData, loadedAt: number) => void
  missing: (draft: DreamRsiState, tabId: string) => void
  failed: (draft: DreamRsiState, tabId: string, failure: string) => void
  treeLoading: (draft: DreamRsiState, tabId: string, roundId: string) => void
  treeLoaded: (draft: DreamRsiState, tabId: string, roundId: string, nodes: NodeRow[], truncated: boolean) => void
  treeFailed: (draft: DreamRsiState, tabId: string, failure: string) => void
  forget: (draft: DreamRsiState, tabId: string) => void
}

/**
 * Declare the panel store.
 *
 * A factory rather than a shared handle: the registration declares it as an
 * exclusive store, so the framework mints one instance per session.
 * @returns the store handle to declare on the registration.
 */
export function createDreamRsiStore(): EngineStoreHandle<DreamRsiState, DreamRsiActions> {
  return defineStore({
    init: (): DreamRsiState => ({ byTab: {} }),
    actions: {
      /**
       * Mark one tab's refresh as running, keeping prior data on show.
       * @param d - draft state.
       * @param tabId - the tab being refreshed.
       */
      started: (d, tabId: string) => {
        const tab = d.byTab[tabId]
        if (tab === undefined) {
          d.byTab[tabId] = { status: 'loading', data: undefined, loadedAt: undefined, failure: undefined, tree: idleTree() }
          return
        }
        tab.status = 'loading'
        tab.failure = undefined
      },
      /**
       * Record one successful refresh.
       * @param d - draft state.
       * @param tabId - the tab being written.
       * @param data - the derived dashboard.
       * @param loadedAt - wall-clock read of the refresh.
       */
      loaded: (d, tabId: string, data: DashboardData, loadedAt: number) => {
        const tab = bucket(d, tabId)
        tab.status = 'ready'
        tab.data = data
        tab.loadedAt = loadedAt
        tab.failure = undefined
      },
      /**
       * Record that this workspace has no `.dreamrsi/` directory.
       * @param d - draft state.
       * @param tabId - the tab being written.
       */
      missing: (d, tabId: string) => {
        const tab = bucket(d, tabId)
        tab.status = 'missing'
        tab.data = undefined
        tab.loadedAt = undefined
        tab.failure = undefined
        tab.tree = idleTree()
      },
      /**
       * Record why one refresh failed.
       * @param d - draft state.
       * @param tabId - the tab being written.
       * @param failure - the failure line to show.
       */
      failed: (d, tabId: string, failure: string) => {
        const tab = bucket(d, tabId)
        tab.status = 'failed'
        tab.failure = failure
      },
      /**
       * Mark one round's tree read as running, keeping prior nodes on show.
       * @param d - draft state.
       * @param tabId - the tab being written.
       * @param roundId - the round being read.
       */
      treeLoading: (d, tabId: string, roundId: string) => {
        const tree = bucket(d, tabId).tree
        tree.roundId = roundId
        tree.status = 'loading'
        tree.failure = undefined
      },
      /**
       * Record one successful tree read.
       * @param d - draft state.
       * @param tabId - the tab being written.
       * @param roundId - the round that was read.
       * @param nodes - the parsed rows, in file order.
       * @param truncated - whether the read cap cut the file.
       */
      treeLoaded: (d, tabId: string, roundId: string, nodes: NodeRow[], truncated: boolean) => {
        const tree = bucket(d, tabId).tree
        tree.roundId = roundId
        tree.status = 'ready'
        tree.nodes = nodes
        tree.truncated = truncated
        tree.failure = undefined
      },
      /**
       * Record why one tree read failed.
       * @param d - draft state.
       * @param tabId - the tab being written.
       * @param failure - the failure line to show.
       */
      treeFailed: (d, tabId: string, failure: string) => {
        const tree = bucket(d, tabId).tree
        tree.status = 'failed'
        tree.failure = failure
      },
      /**
       * Forget one tab's state, for a tab record that is gone.
       * @param d - draft state.
       * @param tabId - the tab that went away.
       */
      forget: (d, tabId: string) => {
        d.byTab = Object.fromEntries(Object.entries(d.byTab).filter(([id]) => id !== tabId))
      },
    },
  })
}

/** The store handle type the registration and the component share. */
export type DreamRsiStoreHandle = EngineStoreHandle<DreamRsiState, DreamRsiActions>
