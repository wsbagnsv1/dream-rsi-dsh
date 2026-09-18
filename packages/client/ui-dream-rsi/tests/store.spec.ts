/**
 * The panel store's action semantics, run against the local engine stub: the
 * write set is what the face writes through and the component reads through.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createDreamRsiStore } from '../src/client/store.ts'
import type { DashboardData } from '../src/client/store.ts'

function sampleData(rounds = 1): DashboardData {
  return {
    config: undefined,
    policies: [{ version: 'v0001', status: 'active' }],
    activeVersion: 'v0001',
    rounds: Array.from({ length: rounds }, (_, index) => ({ roundId: `r000${index + 1}`, bestScore: 1 })),
    roundsTruncated: false,
    attempts: [],
    attemptsTruncated: false,
    forest: [],
    dreams: [],
    dreamsTruncated: false,
    events: [],
    eventsTruncated: false,
  }
}

describe('createDreamRsiStore', () => {
  let actions: ReturnType<ReturnType<typeof createDreamRsiStore>['create']>['actions']
  let snapshot: () => unknown

  beforeEach(() => {
    const instance = createDreamRsiStore().create('session-1')
    actions = instance.actions
    snapshot = instance.getSnapshot
  })

  it('starts empty; started seeds unknown tabs, later writes throw loud', () => {
    expect(snapshot()).toEqual({ byTab: {} })
    actions.started('nope') // the face's first call seeds the tab's bucket
    expect(snapshot()).toMatchObject({ byTab: { nope: { status: 'loading' } } })
    expect(() => actions.loaded('nope', sampleData(), 1)).not.toThrow()
    expect(() => actions.loaded('ghost', sampleData(), 1)).toThrow(/no state for tab/)
    expect(() => actions.missing('ghost')).toThrow(/no state for tab/)
    expect(() => actions.failed('ghost', 'x')).toThrow(/no state for tab/)
  })

  it('started seeds a loading bucket and loaded settles it', () => {
    actions.started('t1')
    expect(snapshot()).toMatchObject({ byTab: { t1: { status: 'loading', data: undefined } } })
    actions.loaded('t1', sampleData(), 1234)
    expect(snapshot()).toMatchObject({
      byTab: { t1: { status: 'ready', loadedAt: 1234, failure: undefined } },
    })
  })

  it('started on a ready tab keeps prior data (no blanking mid-refresh)', () => {
    actions.started('t1')
    actions.loaded('t1', sampleData(), 1234)
    actions.started('t1')
    const state = snapshot() as { byTab: Record<string, { status: string; data: DashboardData | undefined }> }
    expect(state.byTab['t1']?.status).toBe('loading')
    expect(state.byTab['t1']?.data).toBeDefined()
  })

  it('missing clears data; failed records the failure but keeps prior data', () => {
    actions.started('t1')
    actions.loaded('t1', sampleData(), 1234)
    actions.failed('t1', 'boom')
    const failedState = snapshot() as { byTab: Record<string, { status: string; failure: string; data: unknown }> }
    expect(failedState.byTab['t1']).toMatchObject({ status: 'failed', failure: 'boom' })
    expect(failedState.byTab['t1']?.data).toBeDefined()
    actions.missing('t1')
    expect(snapshot()).toMatchObject({ byTab: { t1: { status: 'missing', data: undefined } } })
  })

  it('forget drops exactly one tab', () => {
    actions.started('t1')
    actions.started('t2')
    actions.forget('t1')
    expect(snapshot()).toEqual({ byTab: { t2: expect.anything() } })
    actions.forget('t2')
    expect(snapshot()).toEqual({ byTab: {} })
  })
})
