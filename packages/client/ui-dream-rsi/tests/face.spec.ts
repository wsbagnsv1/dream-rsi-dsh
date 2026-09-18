/**
 * W6 no-cap fence: a scripted in-memory workspace drives the face's full
 * `load()` with MANY rounds, proving every round reaches the panel — the
 * rounds table (data.rounds), the forest (data.forest), and the iteration
 * subpoints (data.attempts) all cover r0001…r00NN with nothing cut at 12.
 */
import { describe, expect, it } from 'vitest'
import { load } from '../src/client/face.ts'
import type { WorkspaceFilesRemote } from '../src/client/face.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceDirectoryListing, WorkspaceFileText } from '@deepseek-ai/dsh-api-workspace-files/types'

/** Round count past the old cap of 12 — the fence's whole point. */
const ROUND_COUNT = 30

/** Build one round's round.json + a two-node nodes.jsonl (root + one valid attempt). */
function roundFiles(roundId: string, bestScore: number): Record<string, string> {
  const nodes = [
    { id: `${roundId}-n000`, roundId, parentId: null, kind: 'root', state: { depth: 0 }, action: { summary: 'root', mechanism: 'root' }, outcome: { score: 0, evaluated: false, valid: false, failClass: 'ok' }, lineage: { policyVersion: 'v0001' } },
    { id: `${roundId}-n001`, roundId, parentId: `${roundId}-n000`, kind: 'attempt', state: { depth: 1 }, action: { summary: `attempt ${roundId}`, mechanism: `mech-${roundId}` }, outcome: { score: bestScore, evaluated: true, valid: true, failClass: 'ok' }, lineage: { policyVersion: 'v0001' } },
  ]
  return {
    [`.dreamrsi/trees/${roundId}/round.json`]: JSON.stringify({
      roundId, status: 'closed', policyVersion: 'v0001', stats: { nodes: 2, attempts: 1, bestScore },
    }),
    [`.dreamrsi/trees/${roundId}/nodes.jsonl`]: nodes.map(entry => JSON.stringify(entry)).join('\n'),
  }
}

/** An in-memory workspaceFiles remote over a flat path→text map. */
function scriptedRemote(files: Map<string, string>): WorkspaceFilesRemote {
  const list = (path: string): RemoteResult<WorkspaceDirectoryListing> => {
    const prefix = path === '.dreamrsi' ? '.dreamrsi/' : `${path}/`
    const names = new Set<string>()
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      names.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest)
    }
    return {
      ok: true,
      value: {
        path: '',
        entries: [...names].map(name => ({ name, type: files.has(`${prefix}${name}`) ? 'file' : 'directory' })),
        truncated: false,
      },
    }
  }
  const read = (path: string, range: { offset?: number | undefined; limit?: number | undefined }): RemoteResult<WorkspaceFileText> => {
    const text = files.get(path)
    if (text === undefined) {
      return { ok: false, error: { code: 'workspace-file/not-found', message: `no ${path}` } }
    }
    const lines = text.split('\n')
    const offset = range.offset ?? 1
    const limit = range.limit ?? lines.length
    const page = lines.slice(offset - 1, offset - 1 + limit)
    return {
      ok: true,
      value: {
        absolutePath: path, version: 'v', offset, text: page.join('\n'),
        lines: page.length, eof: offset - 1 + limit >= lines.length,
      },
    }
  }
  return {
    workspaceFiles: {
      read: async (_sessionId, path, range) => read(path, range),
      list: async (_sessionId, path) => list(path),
    },
  }
}

/** A store with ROUND_COUNT rounds (r0001…r00NN) and a policy index. */
function bigStore(): Map<string, string> {
  const files = new Map<string, string>([
    ['.dreamrsi/config.json', JSON.stringify({ config: { policyEngine: 'code' } })],
    ['.dreamrsi/policies/policy-index.json', JSON.stringify({ activeVersion: 'v0001', versions: [{ version: 'v0001', status: 'active' }] })],
    ['.dreamrsi/events.jsonl', '{"ts":"2026-09-18T00:00:00.000Z","call":"dreamrsi_begin_round"}'],
  ])
  for (let index = 1; index <= ROUND_COUNT; index += 1) {
    const roundId = `r${String(index).padStart(4, '0')}`
    for (const [path, text] of Object.entries(roundFiles(roundId, index * 0.1))) {
      files.set(path, text)
    }
  }
  return files
}

describe('load() with a many-round store (no cap)', () => {
  const sessionId = 'session-1' as import('@deepseek-ai/dsh-session/types').SessionId

  it('surfaces EVERY round in the rounds data — nothing cut at the old cap of 12', async () => {
    const outcome = await load(scriptedRemote(bigStore()), sessionId, new AbortController().signal)
    expect(outcome.kind).toBe('loaded')
    if (outcome.kind !== 'loaded') return
    expect(outcome.data.rounds).toHaveLength(ROUND_COUNT)
    // Newest first: the latest round leads, the oldest is still reachable at the end.
    expect(outcome.data.rounds[0]?.roundId).toBe(`r${String(ROUND_COUNT).padStart(4, '0')}`)
    expect(outcome.data.rounds[ROUND_COUNT - 1]?.roundId).toBe('r0001')
    // Every round id is present exactly once.
    const ids = outcome.data.rounds.map(round => round.roundId)
    expect(new Set(ids).size).toBe(ROUND_COUNT)
  })

  it('carries every round into the forest and the iteration subpoints', async () => {
    const outcome = await load(scriptedRemote(bigStore()), sessionId, new AbortController().signal)
    if (outcome.kind !== 'loaded') throw new Error(`load failed: ${outcome.kind === 'failed' ? outcome.message : outcome.kind}`)
    expect(outcome.data.forest).toHaveLength(ROUND_COUNT)
    // The forest carries every round (its internal layout sorts by round id —
    // fenced in forest.spec); here we assert coverage, not order.
    expect([...outcome.data.forest.map(round => round.roundId)].sort())
      .toEqual(Array.from({ length: ROUND_COUNT }, (_, index) => `r${String(index + 1).padStart(4, '0')}`))
    // Two nodes per round → 2 × ROUND_COUNT iteration subpoints.
    expect(outcome.data.attempts).toHaveLength(ROUND_COUNT * 2)
    expect(outcome.data.attempts[0]?.roundId).toBe('r0001')
    expect(outcome.data.attempts[outcome.data.attempts.length - 1]?.roundId).toBe(`r${String(ROUND_COUNT).padStart(4, '0')}`)
  })

  it('keeps deriving the champion and totals across all rounds', async () => {
    const outcome = await load(scriptedRemote(bigStore()), sessionId, new AbortController().signal)
    if (outcome.kind !== 'loaded') throw new Error('expected a loaded dashboard')
    // The highest bestScore is the LAST round's (index * 0.1).
    expect(outcome.data.rounds[0]?.bestScore).toBeCloseTo(ROUND_COUNT * 0.1, 5)
  })
})

describe('load() dream reports — paged reads past the line window (W11)', () => {
  const sessionId = 'session-1' as import('@deepseek-ai/dsh-session/types').SessionId

  /** A dream report PRETTY-PRINTED past one 2000-line page (~4-5k lines, like the live store's). */
  function bigDreamFile(runId: string, rankingEntries: number): string {
    const report = {
      runId,
      createdAt: '2026-09-18T00:47:53.512Z',
      selectedCandidate: 0,
      selectedName: `deep-marker-${runId}`,
      selectedKind: 'code',
      selectedVersion: 'v0015',
      ranking: [
        {
          candidate: 0,
          name: `deep-marker-${runId}`,
          kind: 'code',
          version: 'v0015',
          meanScore: 41.2,
          perWorld: Array.from({ length: rankingEntries }, (_, index) => ({
            worldId: `r${String(index + 1).padStart(4, '0')}`,
            score: 40 + index * 0.01,
            rounds: 6,
            reveals: 12,
            stopReason: 'exhausted',
            terms: { quality: 40, cost: 0.1, parallelism: 1 },
            estOutcomeFraction: 0,
            batchSizes: [1, 2, 3],
            trajectory: { worldId: `r${String(index + 1).padStart(4, '0')}`, steps: [{ decisionRound: 1, batch: ['n000'], reveal: 4 }], truncated: false, totalSteps: 1 },
          })),
        },
      ],
      guards: { noRegression: true, incumbentScore: 3.5 },
      historySize: 6,
      validWorlds: rankingEntries,
      normalization: { min: 0, max: 41.2, enabled: true },
    }
    return JSON.stringify(report, null, 1)
  }

  it('a multi-page dream report parses FULLY (the silent-truncation regression fence)', async () => {
    // ~600 ranking entries ≈ ~17k pretty-printed lines: past one 2000-line
    // page (multi-page), inside the 10-page cap. The OLD single-window read
    // truncated → tryJson failed → skipped.
    const files = new Map<string, string>([
      ['.dreamrsi/config.json', JSON.stringify({ config: {} })],
      ['.dreamrsi/policies/policy-index.json', JSON.stringify({ activeVersion: 'v0015', versions: [] })],
      ['.dreamrsi/events.jsonl', ''],
      ['.dreamrsi/trees', ''],
      ['.dreamrsi/dreams/d0001.json', bigDreamFile('d0001', 600)],
    ])
    const outcome = await load(scriptedRemote(files), sessionId, new AbortController().signal)
    expect(outcome.kind).toBe('loaded')
    if (outcome.kind !== 'loaded') return
    // The report PARSED (the old code yielded zero dreams here).
    expect(outcome.data.dreams).toHaveLength(1)
    expect(outcome.data.dreams[0]).toMatchObject({
      runId: 'd0001',
      selectedName: 'deep-marker-d0001',
      validWorlds: 600,
      worldCount: 600, // the FULL ranking arrived — proof of the paged join
      meanScore: 41.2,
    })
    expect(outcome.data.dreamFailures).toEqual([])
  })

  it('a dream that still fails surfaces as a per-file failure, never silent', async () => {
    const files = new Map<string, string>([
      ['.dreamrsi/config.json', JSON.stringify({ config: {} })],
      ['.dreamrsi/policies/policy-index.json', JSON.stringify({ activeVersion: 'v0015', versions: [] })],
      ['.dreamrsi/events.jsonl', ''],
      ['.dreamrsi/dreams/d0001.json', bigDreamFile('d0001', 20)],
      // d0002 exists in the listing but its READ fails (non-not-found error).
      ['.dreamrsi/dreams/d0002.json', 'SENTINEL-ERROR'],
    ])
    const remote = scriptedRemote(files)
    const failing = remote.workspaceFiles.read
    remote.workspaceFiles.read = async (id, path, range, signal) =>
      path.endsWith('d0002.json')
        ? { ok: false, error: { code: 'workspace-file/too-large', message: 'lines exceed the byte cap' } }
        : failing(id, path, range, signal)
    const outcome = await load(remote, sessionId, new AbortController().signal)
    if (outcome.kind !== 'loaded') throw new Error('expected a loaded dashboard')
    // The readable report parses; the broken one is SURFACED, not dropped silently.
    expect(outcome.data.dreams).toHaveLength(1)
    expect(outcome.data.dreamFailures).toEqual([
      { file: 'd0002.json', reason: 'lines exceed the byte cap' },
    ])
  })

  it('a truncated-at-page-cap report is surfaced as malformed, not parsed from half a file', async () => {
    // 25k-line report: past the 10-page cap (10 × 2000). The joined text is
    // incomplete → the parse verdict is surfaced with the truncation reason.
    const files = new Map<string, string>([
      ['.dreamrsi/config.json', JSON.stringify({ config: {} })],
      ['.dreamrsi/policies/policy-index.json', JSON.stringify({ activeVersion: 'v0015', versions: [] })],
      ['.dreamrsi/events.jsonl', ''],
      ['.dreamrsi/dreams/d0009.json', bigDreamFile('d0009', 12000)],
    ])
    const outcome = await load(scriptedRemote(files), sessionId, new AbortController().signal)
    if (outcome.kind !== 'loaded') throw new Error('expected a loaded dashboard')
    expect(outcome.data.dreams).toEqual([])
    expect(outcome.data.dreamFailures).toHaveLength(1)
    expect(outcome.data.dreamFailures[0]?.file).toBe('d0009.json')
    expect(outcome.data.dreamFailures[0]?.reason).toContain('truncated')
  })
})
