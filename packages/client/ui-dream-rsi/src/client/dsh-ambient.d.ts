/**
 * Ambient type mirrors of the DSH client runtime surfaces this package
 * consumes, so the package typechecks STANDALONE (the same approach as the
 * server plugin's `src/dsh-ambient.d.ts`). Inside a running DSH web UI the
 * real packages supply the actual runtime: every value import here
 * (`@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-primitives`)
 * stays external in the built bundle and resolves through the browser module
 * table, and every service (`ctx.slots`, `ctx.locale`, `ctx.sidebarRightTabs`,
 * `ctx.remote`) is provided by the composed client plugins.
 *
 * The mirrors cover exactly the slice this package calls, with signatures
 * copied from the harness reference (packages/client/...). Nothing here is
 * emitted or shipped: ambient declarations typecheck only.
 */

// ── react-typed shared vocabulary ───────────────────────────────────────────

/** Shared page-global module table word. */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'

  /** Props the shared glyph components accept. */
  export interface IconProps {
    size?: number | undefined
    className?: string | undefined
  }

  /** The refresh glyph the panel's header button draws. */
  export const IconRefreshOutline16: ComponentType<IconProps>
}

// ── the client store engine (value import) ──────────────────────────────────

declare module '@deepseek-ai/dsh-client-store' {
  /** The write set of one store: pure draft mutators, draft first. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parity with the real contract: any[] keeps per-action param lists assignable.
  export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>

  /** One live store instance: snapshot reads plus the baked write set. */
  export interface StoreInstance<T, A extends ActionsDecl<T>> {
    readonly actions: BakedActions<T, A>
    getSnapshot(): T
    subscribe(fn: () => void): () => void
    clearPersisted(): void
  }

  /** A live store instance narrowed to the engine implementation. */
  export interface EngineStoreInstance<T, A extends ActionsDecl<T>> extends StoreInstance<T, A> {}

  /** The registration currency of a store seat. */
  export interface StoreHandle<T, A extends ActionsDecl<T>> {
    readonly spec: { init: () => T; persist?: string | undefined; actions: A }
    create(scopeKey?: string): EngineStoreInstance<T, A>
  }

  /** The engine-backed handle defineStore returns. */
  export interface EngineStoreHandle<T, A extends ActionsDecl<T>> extends StoreHandle<T, A> {}

  /** The baked write set a component receives: draft elided, params only. */
  export type BakedActions<T, A extends ActionsDecl<T>> = {
    [K in keyof A & string]: A[K] extends (draft: T, ...params: infer P) => void
      ? (...params: P) => void
      : never
  }

  /** The actions parameter of an inject factory whose registration declared a store. */
  export type BoundActions<H> = H extends StoreHandle<infer T, infer A> ? BakedActions<T, A> : never

  /**
   * Declare a store: initial state plus the full write set as pure draft
   * mutators. The handle is the registration currency; the framework mints
   * one instance per handle x scope.
   */
  export function defineStore<T, A extends ActionsDecl<T>>(decl: {
    init: () => T
    persist?: string | undefined
    actions: A & ActionsDecl<T>
  }): EngineStoreHandle<T, A>
}

// ── slots: the declarative component registry ───────────────────────────────

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Live information a tab body shares with its chip (ui-sidebar-right's merge). */
  export interface UseSidebarRightTabInfoResult {
    readonly sidebar: { readonly expanded: boolean; readonly fullscreen: boolean }
    readonly panel: { readonly id: string }
    readonly tab: {
      readonly id: string
      readonly kind: string
      readonly title: string
      readonly visible: boolean
      readonly signal: AbortSignal
      readonly navigation: { readonly address: string; readonly revision: number }
      readonly actions: {
        openResource(address: string, options?: Record<string, unknown>): void
        openTab(kind: string, options?: Record<string, unknown>): void
        close(): void
      }
    }
  }

  /** The slot-level tab-information hook factory (ui-sidebar-right's inject face). */
  export type TabInfoHookFactory = (
    standard: Record<string, unknown>,
    hookContext: unknown,
  ) => () => UseSidebarRightTabInfoResult

  /** The two pane seats this package registers into (declared by ui-sidebar-right). */
  export interface SlotMap {
    'sidebar.right.pane.tab': {
      kind: 'keyed'
      scope: 'session'
      hookContext: unknown
      inject: { hooks: { tabInfo: TabInfoHookFactory } }
    }
    'sidebar.right.pane.tab.title': {
      kind: 'keyed'
      scope: 'session'
      hookContext: unknown
      inject: { hooks: { tabInfo: TabInfoHookFactory } }
    }
  }

  /** Locale namespace table; dictionary owners extend via declaration merging. */
  export interface LocaleNamespaceMap {}

  /** Translate a dictionary key with optional `{name}` template params. */
  export type Translate<K extends string = string> = (key: K, params?: Record<string, unknown>) => string

  /** The shared `common` vocabulary keys as merged by the locale plugin. */
  export type CommonKeyOf = LocaleNamespaceMap extends { common: infer C } ? C & string : never

  /** Key domain of a namespace-bound translate. */
  export type LocaleKeysOf<N extends keyof LocaleNamespaceMap & string> = (LocaleNamespaceMap[N] & string) | CommonKeyOf

  /** Namespace-addressed translate — the type of the framework-injected `t` seat. */
  export type TranslateNS<N extends keyof LocaleNamespaceMap & string> = Translate<LocaleKeysOf<N>>

  /** Dictionary shape for a declared namespace. */
  export type LocaleDictOf<N extends keyof LocaleNamespaceMap & string> = Record<LocaleNamespaceMap[N] & string, string>

  /** Locale share of composed component props. */
  export type PropsLocale<N> = N extends keyof LocaleNamespaceMap & string ? { t: TranslateNS<N> } : object

  /** One observable source: snapshot + subscribe. */
  export interface HostObservable<Snapshot> {
    getSnapshot(): Snapshot
    subscribe(fn: () => void): () => void
  }

  /** Selector hook over one observable. */
  export type SnapshotSelectorHook<Snapshot> = <Selected>(
    selector: (value: Snapshot) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ) => Selected

  /** Framework standard kit for session-scope slots (ui-session's merge). */
  export interface SessionStandardProps {
    /** The session whose scope renders this occurrence. */
    sessionId: import('@deepseek-ai/dsh-session/types').SessionId
    /** Observe the session index (e.g. per-session cwd). */
    useSessions: SnapshotSelectorHook<SessionIndexShape>
  }

  /** The session index slice this package's components may read. */
  export interface SessionIndexShape {
    byId: Record<string, { cwd?: string | undefined } & object>
  }

  /** Framework standard kit for every slot (the global seat). */
  export interface GlobalStandardProps {}

  /** Registrant hooks compartment: bare observable sources under `hooks`. */
  export type HooksSources = Record<string, HostObservable<unknown>>

  /** Component-side selector-hook share synthesized from an inject face's hooks. */
  export type PropsSlotHooks<HS extends object> = {
    [N in keyof HS & string as `use${Capitalize<N>}`]: HS[N] extends (
      ...args: never[]
    ) => infer Hook
      ? Hook extends (...args: never[]) => unknown ? Hook : never
      : never
  }

  /** Component-side view of an inject face (hooks compartment bound). */
  export type InjectFace<I extends object> = I extends { hooks: infer HS extends object }
    ? Omit<I, 'hooks'> & PropsSlotHooks<HS>
    : I

  /** Owner + key props shares for one slot key (this package declares none). */
  export type PropsRuntime<K extends keyof SlotMap & string> = SlotMap[K] extends {
    scope: infer S
  }
    ? (S extends 'session' ? SessionStandardProps : S extends 'session-maybe' ? { sessionId?: import('@deepseek-ai/dsh-session/types').SessionId | undefined } : object) &
        GlobalStandardProps &
        InjectFace<SlotMap[K] extends { inject: infer I extends object } ? I : object>
    : object

  /** The store props share derived from a declared store handle type. */
  export type PropsStore<H> = H extends { create(scopeKey?: string): infer I }
    ? I extends { getSnapshot(): infer T; readonly actions: infer A }
      ? { useStore: SnapshotSelectorHook<T>; actions: A }
      : object
    : object
}

// ── sidebar-right: the tab registry this package contributes a page type to ──

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  import type { ComponentType } from 'react'

  /** One entry capsule the guide page offers. */
  export interface SidebarRightGuideEntry {
    readonly order: number
    readonly title: () => string
    readonly description?: () => string
    readonly icon?: ComponentType<{ size?: number | undefined; className?: string | undefined }>
  }

  /** One registered tab type: its static face. */
  export interface SidebarRightTabDefinition {
    readonly id: string
    readonly kind: string
    readonly patterns?: readonly string[]
    readonly priority?: 'extension' | 'builtin' | 'fallback'
    readonly canOpen?: (address: string) => boolean
    readonly title: (address: string) => string
    readonly guide?: readonly SidebarRightGuideEntry[]
  }
}

// ── workspace files: the wire types this package reads ──────────────────────

declare module '@deepseek-ai/dsh-session/types' {
  /** Branded session id (string at runtime). */
  export type SessionId = string & { readonly __session: unique symbol }
}

declare module '@deepseek-ai/dsh-api-workspace-files/types' {
  /** The line window one `read` returns. */
  export interface WorkspaceFileRange {
    readonly offset?: number | undefined
    readonly limit?: number | undefined
  }

  /** One page of a workspace text file. */
  export interface WorkspaceFileText {
    readonly absolutePath: string
    readonly version: string
    readonly bytes?: number | undefined
    readonly offset: number
    readonly text: string
    readonly lines: number
    readonly eof: boolean
  }

  /** One direct child of a listed workspace directory. */
  export interface WorkspaceDirectoryEntry {
    readonly name: string
    readonly type: 'file' | 'directory' | 'other'
    readonly size?: number | undefined
  }

  /** Direct children of one workspace directory. */
  export interface WorkspaceDirectoryListing {
    readonly path: string
    readonly entries: readonly WorkspaceDirectoryEntry[]
    readonly truncated: boolean
  }
}

// ── remotes: the transport result and the Remote face ───────────────────────

declare module '@deepseek-ai/dsh-api-remotes/client' {
  /** One settled remote failure. */
  export interface RemoteFailure {
    readonly code: string
    readonly message: string
    readonly details?: Record<string, unknown> | undefined
  }

  /** A remote call never rejects; the result carries the failure. */
  export type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RemoteFailure }

  /** The `workspaceFiles` namespace slice this package calls. */
  export interface WorkspaceFilesRemoteNamespace {
    read(
      sessionId: import('@deepseek-ai/dsh-session/types').SessionId,
      path: string,
      range: import('@deepseek-ai/dsh-api-workspace-files/types').WorkspaceFileRange,
      signal?: AbortSignal,
    ): Promise<RemoteResult<import('@deepseek-ai/dsh-api-workspace-files/types').WorkspaceFileText>>
    list(
      sessionId: import('@deepseek-ai/dsh-session/types').SessionId,
      path: string,
      signal?: AbortSignal,
    ): Promise<RemoteResult<import('@deepseek-ai/dsh-api-workspace-files/types').WorkspaceDirectoryListing>>
  }

  /** The Client Remote face as this package sees it. */
  export interface ClientRemote {
    readonly workspaceFiles: WorkspaceFilesRemoteNamespace
  }
}

// ── cordis: the client root context this plugin's apply receives ────────────

declare module '@deepseek-ai/cordis' {
  import type { ComponentType } from 'react'

  /** One keyed slot registration's options, as this package supplies them. */
  export interface SlotRegistrationOptions {
    name: string
    key: string
    locale?: string | undefined
    store?: unknown
    inject?: ((...args: never[]) => object) | undefined
    children?: Record<string, unknown> | undefined
  }

  /** The slots service: register components into declared slots. */
  export interface SlotsService {
    inject(key: string, callback: () => unknown): () => void
    register(options: SlotRegistrationOptions, component: ComponentType<never>): () => void
  }  /** The locale service: register dictionaries, bind namespace translates. */
  export interface LocaleService {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  }

  /** The right-Sidebar tab registry service. */
  export interface SidebarRightTabsService {
    register(definition: import('@deepseek-ai/dsh-client-ui-sidebar-right/client').SidebarRightTabDefinition): () => void
  }

  /** The client root context as this plugin consumes it. */
  export interface Context {
    effect(fn: () => unknown, label?: string): unknown
    slots: SlotsService
    locale: LocaleService
    sidebarRightTabs: SidebarRightTabsService
    remote: import('@deepseek-ai/dsh-api-remotes/client').ClientRemote
  }
}
