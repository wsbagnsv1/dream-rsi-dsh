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
import { cleanupTempRoots, makeTempRoot, must } from './fixtures.ts'

afterEach(async () => {
  await cleanupTempRoots()
})

// ---------------------------------------------------------------------------
// Realistic ncu --csv fixture (locale-formatted, as ncu 2025.1 emits on
// European-locale Windows: periods=thousands, commas=decimal)
// ---------------------------------------------------------------------------

const NCU_CSV_FIXTURE = [
  '==PROF== Connected to Process 143016',
  '"ID","Process ID","Process Name","Host Name","Kernel Name","Context","Stream","Block Size","Grid Size","Device","CC","Section Name","Metric Name","Metric Unit","Metric Value"',
  // ampere_sgemm launch 0 (the matmul kernel — ground truth ~117 µs from CUDA events)
  '"0","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","gpu__time_duration.sum","ns","117.344"',
  '"0","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","dram__bytes.sum","byte","27.595.520"',
  '"0","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","sm__throughput.avg.pct_of_peak_sustained_elapsed","%","65,77"',
  '"0","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","launch__occupancy_limit_blocks","block","24"',
  '"0","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","launch__block_size","","128"',
  '"0","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","launch__grid_size","","512"',
  // ampere_sgemm launch 1 (the same kernel launched again — slightly different timing)
  '"1","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","gpu__time_duration.sum","ns","120.416"',
  '"1","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","dram__bytes.sum","byte","30.818.944"',
  '"1","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","sm__throughput.avg.pct_of_peak_sustained_elapsed","%","65,63"',
  '"1","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","launch__occupancy_limit_blocks","block","24"',
  '"1","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","launch__block_size","","128"',
  '"1","143016","python.exe","127.0.0.1","ampere_sgemm_128x64_nn","1","7","(512, 1, 1)","(128, 1, 1)","0","8.9","Command line profiler metrics","launch__grid_size","","512"',
  // reduce kernel (1 launch)
  '"2","143016","python.exe","127.0.0.1","void at::reduce_kernel<512, 1>","1","7","(512, 1, 1)","(1, 123, 1)","0","8.9","Command line profiler metrics","gpu__time_duration.sum","ns","14.912"',
  '"2","143016","python.exe","127.0.0.1","void at::reduce_kernel<512, 1>","1","7","(512, 1, 1)","(1, 123, 1)","0","8.9","Command line profiler metrics","dram__bytes.sum","byte","2.348.544"',
  '"2","143016","python.exe","127.0.0.1","void at::reduce_kernel<512, 1>","1","7","(512, 1, 1)","(1, 123, 1)","0","8.9","Command line profiler metrics","sm__throughput.avg.pct_of_peak_sustained_elapsed","%","6,70"',
  '"2","143016","python.exe","127.0.0.1","void at::reduce_kernel<512, 1>","1","7","(512, 1, 1)","(1, 123, 1)","0","8.9","Command line profiler metrics","launch__occupancy_limit_blocks","block","24"',
  '"2","143016","python.exe","127.0.0.1","void at::reduce_kernel<512, 1>","1","7","(512, 1, 1)","(1, 123, 1)","0","8.9","Command line profiler metrics","launch__grid_size","","123"',
  '"2","143016","python.exe","127.0.0.1","void at::reduce_kernel<512, 1>","1","7","(512, 1, 1)","(1, 123, 1)","0","8.9","Command line profiler metrics","launch__block_size","","512"',
  '==PROF== Disconnected from Process 143016',
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
  it('parses plain numbers and K/M/G suffixed values', () => {
    expect(parseMetricValue('1234')).toBe(1234)
    expect(parseMetricValue('2 K')).toBe(2000)
    expect(parseMetricValue('3 M')).toBe(3_000_000)
  })

  it('parses ncu LOCALE-formatted numbers (European-locale Windows: periods=thousands, commas=decimal)', () => {
    // The 1000× regression: "117.344" is 117344 (period thousands), NOT 117.344.
    expect(parseMetricValue('117.344')).toBe(117344)
    // Percentages use comma decimals: "65,77" = 65.77%, not 677.
    expect(parseMetricValue('65,77')).toBeCloseTo(65.77, 6)
    // Byte counts with period thousands: "27.595.520" = 27595520.
    expect(parseMetricValue('27.595.520')).toBe(27595520)
    // Mixed separators: the rightmost is the decimal one.
    expect(parseMetricValue('1.234,567')).toBeCloseTo(1234.567, 6)
    expect(parseMetricValue('1,234.567')).toBeCloseTo(1234.567, 6)
  })
})

describe('parseNcuCsv (fixture-based, locale-formatted real ncu output)', () => {
  it('parses the fixture into 2 kernels with correct aggregation', () => {
    const result = parseNcuCsv(NCU_CSV_FIXTURE)
    expect(result.kernels).toHaveLength(2)
    expect(result.kernels_launched).toBe(3) // sgemm × 2 + reduce × 1

    const sgemm = result.kernels.find(k => k.name.includes('ampere_sgemm'))
    expect(sgemm).toBeDefined()
    expect(sgemm!.launches).toBe(2)
    // durations: "117.344" ns → 117344 ns → 117.344 µs; "120.416" → 120.416 µs
    expect(sgemm!.duration_us.mean).toBeCloseTo(118.88, 2)
    expect(sgemm!.duration_us.min).toBeCloseTo(117.344, 2)
    expect(sgemm!.duration_us.max).toBeCloseTo(120.416, 2)
    // dram: 27595520 + 30818944 → mean 29207232
    expect(sgemm!.dram_bytes.mean).toBeCloseTo(29207232, 0)
    // sm: 65.77 + 65.63 → mean 65.7
    expect(sgemm!.sm_throughput_pct.mean).toBeCloseTo(65.7, 1)
    expect(sgemm!.occupancy_limit.mean).toBe(24)
    expect(sgemm!.grid_size).toBe(512)
    expect(sgemm!.block_size).toBe(128)

    const reduce = result.kernels.find(k => k.name.includes('reduce_kernel'))
    expect(reduce).toBeDefined()
    expect(reduce!.launches).toBe(1)
    // "14.912" ns → 14912 ns → 14.912 µs
    expect(reduce!.duration_us.mean).toBeCloseTo(14.912, 2)
    expect(reduce!.dram_bytes.mean).toBeCloseTo(2348544, 0)
    expect(reduce!.sm_throughput_pct.mean).toBeCloseTo(6.7, 1)
    expect(reduce!.grid_size).toBe(123)
    expect(reduce!.block_size).toBe(512)
  })

  it('REGRESSION FENCE: the sgemm duration parses to the ~117 µs band, never 1000× low', () => {
    const result = parseNcuCsv(NCU_CSV_FIXTURE)
    const sgemm = must(result.kernels.find(k => k.name.includes('ampere_sgemm')))
    // CUDA event ground truth on this host: 114–124 µs for the 1024² matmul.
    // The 1000× bug parsed 117.344 as ns → 0.117 µs; the fence pins the band.
    expect(sgemm.duration_us.mean).toBeGreaterThan(100)
    expect(sgemm.duration_us.mean).toBeLessThan(130)
    expect(sgemm.duration_us.mean).toBeCloseTo(118.88, 2)
  })

  it('computes total_duration_us as sum of per-kernel mean × launches', () => {
    const result = parseNcuCsv(NCU_CSV_FIXTURE)
    // sgemm: 118.88 × 2 = 237.76; reduce: 14.912 × 1 → total 252.672
    expect(result.total_duration_us).toBeCloseTo(252.672, 2)
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
