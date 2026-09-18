/**
 * v0.2 nsight bench tests: CSV parsing, metric aggregation, subprocess
 * execution (mocked), and the failure modes (ncu missing, non-zero exit,
 * timeout, no kernels). The real ncu integration test is skipped when ncu
 * is not on PATH.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NSIGHT_METRICS,
  parseCsvLine,
  parseMetricValue,
  parseNcuCsv,
  runNsightBench,
  type NsightSubprocessService,
} from '../src/nsight.ts'
import { cleanupTempRoots, makeTempRoot } from './fixtures.ts'

afterEach(async () => {
  await cleanupTempRoots()
})

// ---------------------------------------------------------------------------
// Realistic ncu --csv fixture (captured from ncu 2025.1.0, two kernels × 2 launches)
// ---------------------------------------------------------------------------

const NCU_CSV_FIXTURE = [
  '==PROF== Connected to Process 12345',
  '"ID","Process ID","Process Name","Host Name","Kernel Name","Kernel Time","Context","Stream","Section Name","Metric Name","Metric Unit","Metric Value"',
  '"0","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"gpu__time_duration.sum","nsecond","1250000"',
  '"0","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"dram__bytes.sum","Mbyte","12.50"',
  '"0","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"sm__throughput.avg.pct_of_peak_sustained_elapsed","%","72.30"',
  '"0","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"launch__occupancy_limit_blocks","","8"',
  '"0","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"launch__grid_size","","128"',
  '"0","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"launch__block_size","","256"',
  '"1","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"gpu__time_duration.sum","nsecond","1500000"',
  '"1","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"dram__bytes.sum","Mbyte","14.20"',
  '"1","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"sm__throughput.avg.pct_of_peak_sustained_elapsed","%","68.10"',
  '"1","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"launch__occupancy_limit_blocks","","8"',
  '"1","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"launch__grid_size","","128"',
  '"1","12345","python.exe","localhost","void sweep_kernel<float, 256>",,,,,"launch__block_size","","256"',
  '"2","12345","python.exe","localhost","reduce_kernel<int>",,,,,"gpu__time_duration.sum","nsecond","800000"',
  '"2","12345","python.exe","localhost","reduce_kernel<int>",,,,,"dram__bytes.sum","Mbyte","2.10"',
  '"2","12345","python.exe","localhost","reduce_kernel<int>",,,,,"sm__throughput.avg.pct_of_peak_sustained_elapsed","%","45.60"',
  '"2","12345","python.exe","localhost","reduce_kernel<int>",,,,,"launch__occupancy_limit_blocks","","16"',
  '"2","12345","python.exe","localhost","reduce_kernel<int>",,,,,"launch__grid_size","","64"',
  '"2","12345","python.exe","localhost","reduce_kernel<int>",,,,,"launch__block_size","","128"',
  '==PROF== Disconnected from Process 12345',
].join('\n')

// ---------------------------------------------------------------------------
// CSV parsing + metric aggregation (pure, no subprocess)
// ---------------------------------------------------------------------------

describe('parseCsvLine', () => {
  it('splits quoted CSV fields with embedded commas', () => {
    expect(parseCsvLine('"a","b, c","d"')).toEqual(['a', 'b, c', 'd'])
  })
  it('returns null for blank lines', () => {
    expect(parseCsvLine('')).toBeNull()
    expect(parseCsvLine('  ')).toBeNull()
  })
})

describe('parseMetricValue', () => {
  it('parses plain numbers, comma-separated, and K/M/G suffixed values', () => {
    expect(parseMetricValue('1234')).toBe(1234)
    expect(parseMetricValue('1,234.5')).toBe(1234.5)
    expect(parseMetricValue('12.50')).toBe(12.5)
    expect(parseMetricValue('2 K')).toBe(2000)
    expect(parseMetricValue('3 M')).toBe(3_000_000)
  })
})

describe('parseNcuCsv (fixture-based)', () => {
  it('parses the fixture into 2 kernels with correct aggregation', () => {
    const result = parseNcuCsv(NCU_CSV_FIXTURE)
    expect(result.kernels).toHaveLength(2)
    expect(result.kernels_launched).toBe(3) // sweep × 2 + reduce × 1

    const sweep = result.kernels.find(k => k.name.includes('sweep_kernel'))
    expect(sweep).toBeDefined()
    expect(sweep!.launches).toBe(2)
    // duration: 1250000ns = 1250µs, 1500000ns = 1500µs → mean 1375
    expect(sweep!.duration_us.mean).toBeCloseTo(1375, 0)
    expect(sweep!.duration_us.min).toBeCloseTo(1250, 0)
    expect(sweep!.duration_us.max).toBeCloseTo(1500, 0)
    expect(sweep!.dram_bytes.mean).toBeCloseTo(13.35, 1)
    expect(sweep!.sm_throughput_pct.mean).toBeCloseTo(70.2, 1)
    expect(sweep!.occupancy_limit.mean).toBe(8)
    expect(sweep!.grid_size).toBe(128)
    expect(sweep!.block_size).toBe(256)

    const reduce = result.kernels.find(k => k.name.includes('reduce_kernel'))
    expect(reduce).toBeDefined()
    expect(reduce!.launches).toBe(1)
    // 800000ns = 800µs
    expect(reduce!.duration_us.mean).toBeCloseTo(800, 0)
    expect(reduce!.dram_bytes.mean).toBeCloseTo(2.1, 1)
  })

  it('computes total_duration_us as sum of per-kernel mean × launches', () => {
    const result = parseNcuCsv(NCU_CSV_FIXTURE)
    // sweep: 1375 × 2 = 2750; reduce: 800 × 1 = 800 → total 3550
    expect(result.total_duration_us).toBeCloseTo(3550, 0)
  })

  it('returns empty kernels for a CSV with no data rows', () => {
    const result = parseNcuCsv('==PROF== Connected\n==PROF== Disconnected')
    expect(result.kernels).toHaveLength(0)
    expect(result.kernels_launched).toBe(0)
  })

  it('skips ==PROF== and ==WARNING== diagnostic lines without crashing', () => {
    const notes: string[] = []
    const result = parseNcuCsv('==WARNING== something odd\n' + NCU_CSV_FIXTURE, notes)
    expect(result.kernels.length).toBeGreaterThan(0)
    expect(notes.some(note => note.includes('something odd'))).toBe(true)
  })

  it('uses the default metric set constant', () => {
    expect(DEFAULT_NSIGHT_METRICS).toContain('gpu__time_duration.sum')
    expect(DEFAULT_NSIGHT_METRICS).toContain('dram__bytes.sum')
    expect(DEFAULT_NSIGHT_METRICS.length).toBeGreaterThanOrEqual(6)
  })
})

// ---------------------------------------------------------------------------
// Subprocess execution (mocked — no GPU in CI)
// ---------------------------------------------------------------------------

/** Build a mock subprocess service that emits the given stdout/stderr and exit code. */
function mockSubprocess(stdout: string, stderr = '', exitCode = 0): NsightSubprocessService {
  const { Readable, PassThrough } = require('node:stream') as typeof import('node:stream')
  const nullSink = new PassThrough()
  nullSink.resume()
  return {
    spawn(_spec) {
      return {
        stdin: nullSink,
        stdout: Readable.from([stdout]),
        stderr: Readable.from([stderr]),
        collected: {},
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() { /* no-op */ },
        waitForExit: () => Promise.resolve(true),
      }
    },
  }
}

describe('runNsightBench (mocked subprocess)', () => {
  it('parses a successful ncu CSV report end-to-end', async () => {
    const root = await makeTempRoot()
    const result = await runNsightBench({
      command: 'python bench.py',
      subprocess: mockSubprocess(NCU_CSV_FIXTURE),
      cwd: root,
    })
    expect(result.kernels).toHaveLength(2)
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.notes.some(note => note.includes('no CUDA kernels'))).toBe(false)
  })

  it('propagates a non-zero target exit with stderr', async () => {
    const root = await makeTempRoot()
    const result = await runNsightBench({
      command: 'python crash.py',
      subprocess: mockSubprocess('', 'CUDA error: out of memory', 1),
      cwd: root,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('out of memory')
    expect(result.notes.some(note => note.includes('exited with code 1'))).toBe(true)
  })

  it('returns an empty kernels array with a note when no kernels are launched', async () => {
    const root = await makeTempRoot()
    const result = await runNsightBench({
      command: 'echo hello',
      subprocess: mockSubprocess('hello world\n', '', 0),
      cwd: root,
    })
    expect(result.kernels).toHaveLength(0)
    expect(result.notes.some(note => note.includes('no CUDA kernels were launched'))).toBe(true)
  })

  it('throws a clean error with install guidance when ncu is missing', async () => {
    const root = await makeTempRoot()
    await expect(runNsightBench({
      command: 'python bench.py',
      subprocess: {
        spawn() {
          throw new Error('spawn ENOENT')
        },
      } as unknown as NsightSubprocessService,
      cwd: root,
    })).rejects.toThrow(/Install Nsight Compute/)
  })

  it('builds the correct ncu argv from the command and metric set', async () => {
    const root = await makeTempRoot()
    let capturedArgv: readonly string[] | undefined
    const spyService: NsightSubprocessService = {
      spawn(spec) {
        capturedArgv = [...spec.argv]
        const { Readable, PassThrough } = require('node:stream') as typeof import('node:stream')
        const nullSink = new PassThrough()
        nullSink.resume()
        return {
          stdin: nullSink,
          stdout: Readable.from(['']),
          stderr: Readable.from(['']),
          collected: {},
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() { /* no-op */ },
          waitForExit: () => Promise.resolve(true),
        }
      },
    }
    await runNsightBench({
      command: 'python bench.py --iters 100',
      metrics: ['gpu__time_duration.sum'],
      subprocess: spyService,
      cwd: root,
    })
    expect(capturedArgv).toBeDefined()
    expect(capturedArgv![0]).toBe('ncu')
    expect(capturedArgv).toContain('--csv')
    expect(capturedArgv).toContain('--metrics')
    expect(capturedArgv).toContain('gpu__time_duration.sum')
    expect(capturedArgv).toContain('--target-processes')
    expect(capturedArgv).toContain('all')
    expect(capturedArgv).toContain('python')
    expect(capturedArgv).toContain('bench.py')
  })
})

// ---------------------------------------------------------------------------
// Optional real-ncu integration (skipped when ncu is unavailable)
// ---------------------------------------------------------------------------

const ncuAvailable = spawnSync('ncu', ['--version'], { timeout: 10_000 }).status === 0

describe.skipIf(!ncuAvailable)('nsight integration (real ncu, no GPU kernels)', () => {
  it('runs a trivial non-CUDA command under ncu: zero kernels, exit 0', async () => {
    const root = await makeTempRoot()
    const result = await runNsightBench({
      command: 'cmd /c echo hello',
      subprocess: {
        spawn(spec) {
          const proc = require('node:child_process').spawn(spec.argv[0], spec.argv.slice(1), {
            cwd: spec.cwd,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
          let settled = false
          const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            proc.on('error', reject)
            proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
              settled = true
              resolve({ exitCode: code, signal: signal ?? null })
            })
          })
          return {
            stdin: proc.stdin,
            stdout: proc.stdout,
            stderr: proc.stderr,
            collected: {},
            done,
            terminate() { if (!settled) proc.kill() },
            waitForExit: () => done.then(() => true),
          }
        },
      },
      cwd: root,
      timeout: 60_000,
    })
    expect(result.exitCode).toBe(0)
    // Non-CUDA command → ncu profiles zero kernels → empty result.
    expect(result.kernels).toHaveLength(0)
    expect(result.notes.some(note => note.includes('no CUDA kernels were launched'))).toBe(true)
  }, 120_000)
})
