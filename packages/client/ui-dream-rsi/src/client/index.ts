/**
 * Browser half: register `dream-rsi` as a right-Sidebar tab type.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`,
 * the body into the keyed `sidebar.right.pane.tab` seat, both under the type's
 * `id`. The store's files are read through the `workspaceFiles` Remote
 * namespace with workspace-relative paths, resolved by the endpoint against
 * the addressed session's workspace — strictly read-only.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { DREAM_RSI_ID, dreamRsiDefinition } from './definition.ts'
import { dreamRsiFace } from './face.ts'
import { DreamRsiBody } from './DreamRsiBody.tsx'
import { en, zh } from './locales.ts'
import { createDreamRsiStore } from './store.ts'

export type { DREAM_RSI_ID, DREAM_RSI_KIND, GUIDE_ORDER } from './definition.ts'
export type { DreamRsiBodyProps } from './DreamRsiBody.tsx'
export type { TreeGraphProps } from './TreeGraph.tsx'
export type { ForestGraphProps } from './ForestGraph.tsx'
export type { DreamRsiInjected, LoadOutcome, NodesOutcome } from './face.ts'
export type { DashboardData, DreamRsiState, DreamRsiTabState, LoadStatus } from './store.ts'
export type { DreamRsiKey } from './locales.ts'
export type { LayoutOptions, LayoutPosition, TreeLayout } from './tree-layout.ts'
export { layoutTree, scoreColor } from './tree-layout.ts'
export type { ForestBand, ForestLayout, ForestOptions, ForestRound } from './forest-layout.ts'
export { layoutForest } from './forest-layout.ts'
export type { Era, EraFilter, IterationPoint, PolicyMarker, Progression, RoundNodes } from './progression.ts'
export {
  computeProgression, eraOf, roundColor, starRound, thinIndices, toIterationNodes,
  SCORE_ERA_THRESHOLD, STAR_GLYPH, X_LABEL_CAP,
} from './progression.ts'
export type { ProgressionChartProps } from './ProgressionChart.tsx'
export type {
  Champion, DreamRow, EventRow, NodeRow, PolicyIndex, PolicyRow, RoundRow, StoreConfig, TreeIndex,
} from './read.ts'
export { bestPath, buildTreeIndex, parseNodesPage } from './read.ts'

/** This package's copy namespace. */
const NS = 'dreamRsi'

/**
 * Required browser services: the tab registry, the keyed seat, copy, and the
 * Remote carrier with its `workspaceFiles` namespace.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

/**
 * Client plugin body: register the type, its dictionaries, and its body.
 * @param ctx - client root context carrying the registry, the slots, copy, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(dreamRsiDefinition(t)), 'ui-dream-rsi: dream-rsi type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-dream-rsi: dictionaries')

  const store = createDreamRsiStore()
  const inject = dreamRsiFace(ctx.remote)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: DREAM_RSI_ID, locale: NS, store, inject },
    DreamRsiBody,
  )), 'ui-dream-rsi: dream-rsi tab body')
}
