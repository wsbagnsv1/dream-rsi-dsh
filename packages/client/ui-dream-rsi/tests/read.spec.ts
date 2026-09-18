/**
 * Pure store-file parsing and derivation, against shapes transcribed from the
 * live store (A:\benchmark\dreamrsi\.dreamrsi) and the repo README's data
 * model: policies/policy-index.json, trees/<id>/round.json, dreams/dNNNN.json,
 * events.jsonl, config.json.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveChampion, parseDreamReport, parseEventsPage, parsePolicyIndex, parseRoundRecord,
  parseStoreConfig, totalNodes,
} from '../src/client/read.ts'

describe('parsePolicyIndex', () => {
  it('parses the live store shape, sorting versions ascending', () => {
    const text = JSON.stringify({
      activeVersion: 'v0003',
      versions: [
        { version: 'v0003', status: 'active', createdAt: '2026-09-18T00:42:52.636Z', parentId: 'v0002', name: 'third', kind: 'code' },
        { version: 'v0001', status: 'retired', createdAt: '2026-09-17T11:21:23.525Z', parentId: null, name: 'bootstrap-balanced' },
        { version: 'v0002', status: 'retired', createdAt: '2026-09-17T11:54:07.713Z', parentId: 'v0001', name: 'steady-deep' },
      ],
    })
    const index = parsePolicyIndex(text)
    expect(index).toBeDefined()
    expect(index?.activeVersion).toBe('v0003')
    expect(index?.versions.map(row => row.version)).toEqual(['v0001', 'v0002', 'v0003'])
    expect(index?.versions[2]?.kind).toBe('code')
  })

  it('drops malformed rows and tolerates missing fields', () => {
    const index = parsePolicyIndex(JSON.stringify({
      versions: [{ version: 'v0001' }, { nope: true }, 'junk', null],
    }))
    expect(index?.versions).toHaveLength(1)
    expect(index?.activeVersion).toBeUndefined()
  })

  it('returns undefined for malformed JSON', () => {
    expect(parsePolicyIndex('{not json')).toBeUndefined()
  })
})

describe('parseRoundRecord', () => {
  it('parses the live round shape, narrowing stats', () => {
    const text = JSON.stringify({
      roundId: 'ignored-file-wins',
      status: 'closed',
      policyVersion: 'v0014',
      startedAt: '2026-09-17T21:53:14.855Z',
      endedAt: '2026-09-17T23:01:18.021Z',
      limits: { maxRounds: 16, maxParallelism: 4 },
      stats: { nodes: 7, attempts: 6, bestScore: 102.9, decisionRounds: 6, batchSizes: [1, 1] },
      summary: 'done',
    })
    const row = parseRoundRecord(text, 'r0004')
    expect(row).toEqual({
      roundId: 'ignored-file-wins', // the directory name is authoritative
      status: 'closed',
      policyVersion: 'v0014',
      startedAt: '2026-09-17T21:53:14.855Z',
      endedAt: '2026-09-17T23:01:18.021Z',
      nodes: 7,
      attempts: 6,
      bestScore: 102.9,
      decisionRounds: 6,
      summary: 'done',
    })
  })

  it('falls back to the given round id when the record lacks one', () => {
    const row = parseRoundRecord('{"status":"open"}', 'r0009')
    expect(row?.roundId).toBe('r0009')
  })

  it('returns undefined for malformed JSON', () => {
    expect(parseRoundRecord('nope', 'r0001')).toBeUndefined()
  })
})

describe('parseDreamReport', () => {
  const report = {
    runId: 'd0006',
    createdAt: '2026-09-18T00:47:53.512Z',
    selectedCandidate: 1,
    selectedName: 'winner',
    selectedKind: 'code',
    selectedVersion: 'v0015',
    ranking: [
      {
        candidate: 0, name: 'incumbent', kind: 'code', version: 'v0014', meanScore: -1e12,
        perWorld: [{ worldId: 'r0001' }, { worldId: 'r0002' }],
        invalid: 'malformed policy output',
      },
      {
        candidate: 1, name: 'winner', kind: 'code', version: 'v0015', meanScore: 41.2,
        perWorld: [{ worldId: 'r0001', score: 40 }, { worldId: 'r0002', score: 42.4 }],
      },
    ],
    guards: { noRegression: true, incumbentScore: 3.5 },
    historySize: 6,
    validWorlds: 2,
    normalization: { min: 0, max: 102.9, enabled: true },
  }

  it('summarizes the selected candidate, not candidate 0', () => {
    const row = parseDreamReport(JSON.stringify(report), 'd0006')
    expect(row).toMatchObject({
      runId: 'd0006',
      selectedCandidate: 1,
      selectedName: 'winner',
      selectedVersion: 'v0015',
      meanScore: 41.2,
      validWorlds: 2,
      worldCount: 2,
      noRegression: true,
      floored: false,
      invalid: undefined,
    })
  })

  it('flags floored candidates at the −∞ floor and surfaces the invalid reason', () => {
    const floored = { ...report, selectedCandidate: 0 }
    const row = parseDreamReport(JSON.stringify(floored), 'd0006')
    expect(row?.floored).toBe(true)
    expect(row?.invalid).toBe('malformed policy output')
  })

  it('falls back to the first ranking entry when selection is absent', () => {
    const {
      selectedCandidate: _c, selectedName: _n, selectedKind: _k, selectedVersion: _v, ...withoutSelection
    } = report
    void _c; void _n; void _k; void _v
    const row = parseDreamReport(JSON.stringify(withoutSelection), 'd0006')
    expect(row?.selectedName).toBe('incumbent')
    expect(row?.selectedKind).toBeUndefined()
  })

  it('returns undefined for malformed JSON', () => {
    expect(parseDreamReport('[', 'd0001')).toBeUndefined()
  })
})

describe('parseEventsPage', () => {
  it('parses JSON lines and skips malformed ones', () => {
    const rows = parseEventsPage([
      '{"ts":"2026-09-18T00:47:53.502Z","call":"dreamrsi_end_round","policyVersion":"v0015"}',
      'garbage',
      '{"call":"dreamrsi_dream"}',
      '',
    ].join('\n'))
    expect(rows).toEqual([
      { ts: '2026-09-18T00:47:53.502Z', call: 'dreamrsi_end_round', policyVersion: 'v0015' },
      { ts: undefined, call: 'dreamrsi_dream', policyVersion: undefined },
    ])
  })
})

describe('parseStoreConfig', () => {
  it('narrows the recorded config', () => {
    const config = parseStoreConfig(JSON.stringify({
      writtenAt: '2026-09-18T00:21:17.000Z',
      config: { dataDir: '.dreamrsi', policyEngine: 'code', autoDream: 'every-cycle', candidateCount: 3 },
    }))
    expect(config).toEqual({
      dataDir: '.dreamrsi', policyEngine: 'code', autoDream: 'every-cycle', devLoop: undefined,
    })
  })

  it('reads a flat config object too', () => {
    expect(parseStoreConfig('{"policyEngine":"legacy"}')).toEqual({
      policyEngine: 'legacy', autoDream: undefined, devLoop: undefined, dataDir: undefined,
    })
  })
})

describe('deriveChampion and totalNodes', () => {
  it('picks the highest bestScore, ties keeping the earliest round', () => {
    const champion = deriveChampion([
      { roundId: 'r0001', bestScore: 2.6, nodes: 4 },
      { roundId: 'r0002', bestScore: 102.9, policyVersion: 'v0014', nodes: 7 },
      { roundId: 'r0003', bestScore: 102.9, policyVersion: 'v0015', nodes: 3 },
      { roundId: 'r0004' },
    ])
    expect(champion).toEqual({ score: 102.9, roundId: 'r0002', policyVersion: 'v0014' })
    expect(totalNodes([
      { roundId: 'r0001', nodes: 4 },
      { roundId: 'r0002', nodes: 7 },
      { roundId: 'r0003' },
    ])).toBe(11)
  })

  it('returns undefined with no scored rounds', () => {
    expect(deriveChampion([{ roundId: 'r0001' }, { roundId: 'r0002', bestScore: Number.NaN }])).toBeUndefined()
  })
})
