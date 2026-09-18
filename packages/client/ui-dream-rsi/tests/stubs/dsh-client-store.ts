/**
 * Minimal faithful stub of `@deepseek-ai/dsh-client-store` for the package's
 * unit tests: the real engine (immer drafts, persistence, subscription
 * batching) lives in the browser runtime; the tests exercise the store's
 * ACTION SEMANTICS, which only need a mutable draft and baked callbacks.
 */
import type { ActionsDecl, EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

export type { ActionsDecl, BakedActions, BoundActions, EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** What the tests read back: snapshots plus the baked write set. */
export interface TestInstance<T, A extends ActionsDecl<T>> {
  readonly actions: {
    [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
  }
  getSnapshot(): T
  subscribe(fn: () => void): () => void
  clearPersisted(): void
}

/**
 * Stub of the engine store factory: `create()` mints a fresh mutable state and
 * bakes the actions over it, which is the whole contract the panel's actions
 * rely on.
 */
export function defineStore<T, A extends ActionsDecl<T>>(decl: {
  init: () => T
  persist?: string | undefined
  actions: A & ActionsDecl<T>
}): EngineStoreHandle<T, A> {
  const handle = {
    spec: decl,
    create(): TestInstance<T, A> {
      let state = decl.init()
      const listeners = new Set<() => void>()
      const actions = {} as Record<string, (...params: unknown[]) => void>
      for (const key of Object.keys(decl.actions)) {
        const mutate = decl.actions[key] as (draft: T, ...params: unknown[]) => void
        actions[key] = (...params: unknown[]) => {
          mutate(state, ...params)
          for (const listener of [...listeners]) listener()
        }
      }
      return {
        actions: actions as TestInstance<T, A>['actions'],
        getSnapshot: () => state,
        subscribe: (fn: () => void) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        clearPersisted: () => {},
      }
    },
  }
  // The stub is not structurally the engine handle (its create returns the
  // test instance); tests narrow through this honest single cast.
  return handle as unknown as EngineStoreHandle<T, A>
}
