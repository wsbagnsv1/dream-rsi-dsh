/**
 * Nsight Compute (ncu) kernel-benchmarking support for the Dream-RSI
 * discovery agent (paper domain 3: GPU kernel engineering).
 *
 * The tool wraps one `ncu --csv --metrics … --target-processes all <command>`
 * invocation through the `ctx.subprocess` seam (F1: already injected in the
 * preset). ncu spawns the target and profiles every CUDA kernel it launches;
 * the CSV report is parsed into per-kernel metric aggregations (launch count,
 * duration mean/min/max, DRAM bytes, SM throughput, occupancy limit) that the
 * discovery agent uses as REAL profiling signals — not just wall-clock.
 *
 * CSV format notes (ncu 2025.x): diagnostic lines start with `==PROF==` or
 * `==WARNING==`; the header row is a quoted CSV line whose columns include
 * "Kernel Name", "ID", "Metric Name", "Metric Unit", and "Metric Value"; the
 * report is LONG format — one row per (kernel launch, metric). Units attach
 * to the metric, not the value; duration arrives in the unit ncu chose
 * (ns/µs/ms — parsed to µs via the unit column).
 *
 * @module
 */

/** The default profiling metric set (paper domain 3 signals). */
export const DEFAULT_NSIGHT_METRICS: readonly string[] = [
  'gpu__time_duration.sum',
  'dram__bytes.sum',
  'sm__throughput.avg.pct_of_peak_sustained_elapsed',
  'launch__occupancy_limit_blocks',
  'launch__grid_size',
  'launch__block_size',
]

/** Aggregated metric statistics for one kernel. */
export interface MetricStats {
  mean: number
  min: number
  max: number
}

/** One profiled kernel's aggregated metrics. */
export interface NsightKernel {
  /** Demangled kernel name as ncu reports it. */
  name: string
  /** How many times this kernel was launched in the target run. */
  launches: number
  /** GPU time duration aggregated across launches, microseconds. */
  duration_us: MetricStats
  /** DRAM bytes moved, mean across launches. */
  dram_bytes: MetricStats
  /** SM throughput as % of peak sustained elapsed, mean across launches. */
  sm_throughput_pct: MetricStats
  /** Occupancy limiter (blocks), mean across launches. */
  occupancy_limit: MetricStats
  /** Grid/block launch configuration from the first launch (stable per kernel). */
  grid_size: number | null
  block_size: number | null
}

/** The parsed result of one ncu run. */
export interface NsightBenchResult {
  kernels: NsightKernel[]
  /** Sum of per-kernel mean durations, microseconds. */
  total_duration_us: number
  /** Total kernel launches across all kernels. */
  kernels_launched: number
  /** Non-fatal stderr diagnostics (==WARNING== lines, non-empty stderr). */
  notes: string[]
}

/**
 * Parse one CSV line honoring double-quoted fields with embedded commas.
 * Returns the unquoted fields, or null for empty lines.
 */
export function parseCsvLine(line: string): string[] | null {
  if (line.trim().length === 0) return null
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields
}

/** Strip ncu diagnostic prefixes; returns null for non-CSV lines. */
function csvLine(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('==PROF==') || trimmed.startsWith('==WARNING==') || trimmed.startsWith('==ERROR==')) return null
  if (!trimmed.startsWith('"')) return null
  return trimmed
}

/** Normalize a duration metric value to microseconds from its unit column. */
function durationToUs(value: number, unit: string): number {
  const u = unit.trim().toLowerCase()
  if (u === 'nsecond' || u === 'ns' || u === 'nsecondcycle') return value / 1000
  if (u === 'usecond' || u === 'us' || u === 'usecondcycle') return value
  if (u === 'msecond' || u === 'ms') return value * 1000
  if (u === 'second' || u === 's') return value * 1_000_000
  return value
}

/**
 * Parse a metric value from ncu's CSV output, handling the locale-dependent
 * number formatting ncu inherits from the host system.
 *
 * On European-locale Windows (this deployment), ncu emits numbers with:
 * - PERIODS as thousands separators: `"117.344"` = 117344
 * - COMMAS as decimal separators: `"65,77"` = 65.77
 * - Both in one value: `"1.234,567"` = 1234.567
 *
 * The rightmost separator is always the decimal one; all others are
 * thousands separators. This is verified against CUDA event timing
 * (ampere_sgemm_128x64_nn: ncu 117.344 "ns" = 117344 ns = 117.344 µs ≈
 * CUDA events 114–124 µs).
 */
export function parseMetricValue(raw: string): number {
  const cleaned = raw.trim()
  if (cleaned.length === 0) return Number.NaN
  const hasPeriods = cleaned.includes('.')
  const hasCommas = cleaned.includes(',')

  let normalized: string
  if (hasPeriods && hasCommas) {
    // Both present: the RIGHTMOST separator is the decimal one.
    const lastPeriod = cleaned.lastIndexOf('.')
    const lastComma = cleaned.lastIndexOf(',')
    if (lastComma > lastPeriod) {
      // European: comma = decimal, periods = thousands.
      normalized = cleaned.replace(/\./g, '').replace(',', '.')
    } else {
      // US: period = decimal, commas = thousands.
      normalized = cleaned.replace(/,/g, '')
    }
  } else if (hasCommas) {
    // Commas only: in ncu's locale-formatted output this is a DECIMAL
    // separator (e.g. "65,77" = 65.77% SM throughput).
    normalized = cleaned.replace(/,/g, '.')
  } else if (hasPeriods) {
    // Periods only: in ncu's locale-formatted output these are THOUSANDS
    // separators (e.g. "117.344" = 117344 ns, "27.595.520" = 27595520 bytes).
    // A single period followed by exactly 3 digits could be either — but ncu
    // on this locale always uses periods as thousands, so strip them.
    normalized = cleaned.replace(/\./g, '')
  } else {
    normalized = cleaned
  }

  // K/M/G suffix handling (ncu sometimes appends these in non-CSV output).
  const multiplier = normalized.endsWith(' K') ? 1e3
    : normalized.endsWith(' M') ? 1e6
      : normalized.endsWith(' G') ? 1e9
        : 1
  const numeric = multiplier === 1 ? normalized : normalized.slice(0, -2).trim()
  const parsed = Number(numeric)
  return Number.isFinite(parsed) ? parsed * multiplier : Number.NaN
}

/**
 * Parse raw ncu `--csv` output into per-kernel metric aggregations.
 * Pure and deterministic — identical input produces identical output.
 *
 * @param csv - the raw stdout text (may include ==PROF== diagnostics).
 * @param notes - collector for non-fatal diagnostic lines (mutated).
 */
export function parseNcuCsv(csv: string, notes: string[] = []): NsightBenchResult {
  const lines = csv.split(/\r?\n/)
  let header: string[] | null = null
  let kernelNameCol = -1
  let launchIdCol = -1
  let metricNameCol = -1
  let metricUnitCol = -1
  let metricValueCol = -1

  interface LaunchEntry {
    kernelName: string
    durationsUs: number[]
    dramBytes: number[]
    smThroughput: number[]
    occupancy: number[]
    gridSize: number | null
    blockSize: number | null
  }
  const launches = new Map<string, LaunchEntry>()
  const launchOrder: string[] = []

  for (const raw of lines) {
    const line = csvLine(raw)
    if (line === null) {
      const trimmed = raw.trim()
      if (trimmed.startsWith('==WARNING==')) notes.push(trimmed)
      continue
    }
    const fields = parseCsvLine(line)
    if (fields === null) continue
    if (header === null) {
      const lower = fields.map(field => field.trim().toLowerCase())
      kernelNameCol = lower.indexOf('kernel name')
      launchIdCol = lower.indexOf('id')
      metricNameCol = lower.indexOf('metric name')
      metricUnitCol = lower.indexOf('metric unit')
      metricValueCol = lower.indexOf('metric value')
      if (kernelNameCol !== -1 && metricNameCol !== -1 && metricValueCol !== -1) {
        header = fields
        continue
      }
      header = null
      continue
    }
    const kernelName = fields[kernelNameCol]?.trim() ?? ''
    const launchId = fields[launchIdCol]?.trim() ?? ''
    const metricName = fields[metricNameCol]?.trim().toLowerCase() ?? ''
    const metricUnit = fields[metricUnitCol]?.trim() ?? ''
    const metricValueRaw = fields[metricValueCol]?.trim() ?? ''
    if (kernelName.length === 0 || metricName.length === 0) continue
    const value = parseMetricValue(metricValueRaw)
    if (!Number.isFinite(value)) continue

    const key = `${launchId}::${kernelName}`
    let entry = launches.get(key)
    if (entry === undefined) {
      entry = { kernelName, durationsUs: [], dramBytes: [], smThroughput: [], occupancy: [], gridSize: null, blockSize: null }
      launches.set(key, entry)
      launchOrder.push(key)
    }
    if (metricName === 'gpu__time_duration.sum') {
      entry.durationsUs.push(durationToUs(value, metricUnit))
    } else if (metricName === 'dram__bytes.sum') {
      entry.dramBytes.push(value)
    } else if (metricName === 'sm__throughput.avg.pct_of_peak_sustained_elapsed') {
      entry.smThroughput.push(value)
    } else if (metricName === 'launch__occupancy_limit_blocks') {
      entry.occupancy.push(value)
    } else if (metricName === 'launch__grid_size') {
      entry.gridSize = entry.gridSize ?? value
    } else if (metricName === 'launch__block_size') {
      entry.blockSize = entry.blockSize ?? value
    }
  }

  const stats = (values: number[]): MetricStats => {
    if (values.length === 0) return { mean: 0, min: 0, max: 0 }
    const sum = values.reduce((acc, v) => acc + v, 0)
    return { mean: sum / values.length, min: Math.min(...values), max: Math.max(...values) }
  }

  const kernels: NsightKernel[] = []
  // Group launches by kernel name (multiple launches of the same kernel aggregate).
  const byKernel = new Map<string, { launches: number; durationsUs: number[]; dramBytes: number[]; smThroughput: number[]; occupancy: number[]; gridSize: number | null; blockSize: number | null }>()
  for (const key of launchOrder) {
    const entry = launches.get(key)
    if (entry === undefined) continue
    const existing = byKernel.get(entry.kernelName)
    if (existing) {
      existing.launches += 1
      existing.durationsUs.push(...entry.durationsUs)
      existing.dramBytes.push(...entry.dramBytes)
      existing.smThroughput.push(...entry.smThroughput)
      existing.occupancy.push(...entry.occupancy)
    } else {
      byKernel.set(entry.kernelName, {
        launches: 1,
        durationsUs: [...entry.durationsUs],
        dramBytes: [...entry.dramBytes],
        smThroughput: [...entry.smThroughput],
        occupancy: [...entry.occupancy],
        gridSize: entry.gridSize,
        blockSize: entry.blockSize,
      })
    }
  }

  let totalDurationUs = 0
  let kernelsLaunched = 0
  for (const [name, agg] of byKernel) {
    const durationUs = stats(agg.durationsUs)
    kernels.push({
      name,
      launches: agg.launches,
      duration_us: durationUs,
      dram_bytes: stats(agg.dramBytes),
      sm_throughput_pct: stats(agg.smThroughput),
      occupancy_limit: stats(agg.occupancy),
      grid_size: agg.gridSize,
      block_size: agg.blockSize,
    })
    totalDurationUs += durationUs.mean * agg.launches
    kernelsLaunched += agg.launches
  }
  kernels.sort((a, b) => a.name.localeCompare(b.name))

  return { kernels, total_duration_us: totalDurationUs, kernels_launched: kernelsLaunched, notes }
}

// ---------------------------------------------------------------------------
// Subprocess execution (v0.2: through the ctx.subprocess seam)
// ---------------------------------------------------------------------------

/** The minimal slice of the subprocess seam the ncu runner needs. */
export interface NsightSubprocessService {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore' | 'pipe' | { readonly data: string }
      stdout: 'pipe' | 'inherit' | { readonly maxBytes: number; readonly spill?: { readonly maxBytes: number } }
      stderr: 'pipe' | 'inherit' | { readonly maxBytes: number; readonly spill?: { readonly maxBytes: number } }
    }
    graceMs: number
    signal?: AbortSignal | undefined
    env?: NodeJS.ProcessEnv | undefined
  }): {
    readonly stdout: import('node:stream').Readable | undefined
    readonly stderr: import('node:stream').Readable | undefined
    readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
    terminate(): void
  }
}

/** Options for {@link runNsightBench}. */
export interface NsightBenchOptions {
  /** The kernel-runner command (e.g. "python bench_kernel.py"). Split on whitespace. */
  command: string
  /** Metric names (default: {@link DEFAULT_NSIGHT_METRICS}). */
  metrics?: readonly string[]
  /** Working directory for the ncu child (default: process.cwd()). */
  cwd?: string
  /** Wall-clock budget in milliseconds (default 120000). */
  timeout?: number
  /**
   * Explicit ncu path override (plugin config `nsightNcuPath` or the tool
   * argument). When unset, the executable is resolved at execute time.
   */
  ncuPath?: string
  /** The subprocess seam. */
  subprocess: NsightSubprocessService
  signal?: AbortSignal
}

/** Result of one ncu benchmark run, including execution diagnostics. */
export interface NsightBenchRun extends NsightBenchResult {
  /** ncu's exit code (0 = clean; non-zero = the target may have failed). */
  exitCode: number | null
  /** stderr text from ncu or the target (diagnostics). */
  stderr: string
  /** True when the run hit the wall-clock budget and was terminated. */
  timedOut: boolean
}

/** Collect one Readable stream into a string. */
function collectStream(stream: import('node:stream').Readable | undefined): Promise<string> {
  return new Promise((resolve) => {
    if (!stream) return resolve('')
    let text = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => { text += chunk })
    stream.on('end', () => resolve(text))
    stream.on('error', () => resolve(text))
  })
}

// ---------------------------------------------------------------------------
// ncu executable resolution (the subprocess seam's scrubbed PATH does not
// include the Nsight Compute directory; bare `ncu` does not resolve — and on
// Windows the PATH hit is ncu.bat, which the argv-based seam cannot execute)
// ---------------------------------------------------------------------------

/** How the ncu executable was resolved. */
export type NcuResolutionSource = 'explicit' | 'where' | 'glob'

/** The resolved absolute ncu executable path plus its provenance. */
export interface NcuResolution {
  path: string
  source: NcuResolutionSource
}

/** One run of a helper executable (where.exe) via the subprocess seam. */
async function runHelper(argv: readonly string[], subprocess: NsightSubprocessService, signal?: AbortSignal): Promise<{ stdout: string; exitCode: number | null }> {
  const handle = subprocess.spawn({
    argv,
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 1000,
    ...(signal !== undefined ? { signal } : {}),
  })
  const stdoutPromise = collectStream(handle.stdout)
  const done = await handle.done
  const stdout = await stdoutPromise
  return { stdout, exitCode: done.exitCode }
}

/** The common Nsight Compute install locations searched when `where` fails. */
export const NSIGHT_SEARCH_LOCATIONS: readonly string[] = [
  'C:\\Program Files\\NVIDIA Corporation\\Nsight Compute *\\ncu.exe',
  'C:\\Program Files\\NVIDIA Corporation\\Nsight Compute *\\target\\windows-desktop-win7-x64\\ncu.exe',
]

/** The parent directory globbed for Nsight Compute version folders (test seam). */
const NSIGHT_GLOB_PARENT = 'C:\\Program Files\\NVIDIA Corporation'

/**
 * Glob the common Nsight Compute install locations and return the newest
 * `ncu.exe`, or undefined. Version directories sort numerically descending
 * ("Nsight Compute 2025.1.0" > "Nsight Compute 2024.3.1").
 *
 * Two layouts are checked per version directory (verified against a real
 * Nsight Compute 2025.1.0 install):
 * - `<dir>\ncu.exe` — some installs expose the exe at the top level;
 * - `<dir>\target\windows-desktop-win7-x64\ncu.exe` — the 2025.x layout,
 *   which is what the shipped `ncu.bat` wrapper (`"%~dp0\target\...ncu.exe"`)
 *   invokes. Spawning this exe directly is equivalent to the wrapper without
 *   requiring a shell (the argv-based seam never shell-interprets, so the
 *   .bat itself cannot be spawned).
 */
export function globNcuInstall(parent: string = NSIGHT_GLOB_PARENT): string | undefined {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  let entries: string[]
  try {
    entries = fs.readdirSync(parent)
  } catch {
    return undefined
  }
  const versionOf = (name: string): number[] => {
    const match = /Nsight Compute (\d+)\.(\d+)(?:\.(\d+))?/u.exec(name)
    if (match === null) return []
    return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
  }
  const candidates = entries
    .filter(name => versionOf(name).length > 0)
    .sort((a, b) => {
      const va = versionOf(a)
      const vb = versionOf(b)
      for (let i = 0; i < 3; i++) {
        if ((vb[i] ?? 0) !== (va[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0)
      }
      return b.localeCompare(a)
    })
  for (const candidate of candidates) {
    const dir = path.join(parent, candidate)
    for (const relative of ['ncu.exe', path.join('target', 'windows-desktop-win7-x64', 'ncu.exe')]) {
      const exe = path.join(dir, relative)
      try {
        if (fs.statSync(exe).isFile()) return exe
      } catch {
        continue
      }
    }
  }
  return undefined
}

/**
 * Resolve the ncu executable to an ABSOLUTE PATH before spawning.
 *
 * Order (the lead's spec):
 * 1. `ncuPath` explicit override (plugin config or tool argument) — used as-is.
 * 2. `where.exe ncu` via ctx.subprocess (System32 is always reachable — it
 *    resolves the FULL system PATH including the Nsight Compute dir). The
 *    first `ncu.exe` hit wins; `.bat` hits are skipped (the argv-based seam
 *    never shell-interprets, so a .bat wrapper cannot be spawned).
 * 3. Glob the common install locations (`C:\Program Files\NVIDIA
 *    Corporation\Nsight Compute *\ncu.exe`, newest version first).
 * 4. Fail with the install-guidance error listing the searched locations.
 *
 * @throws Error with install guidance when every step fails.
 */
export async function resolveNcuExecutable(options: {
  ncuPath?: string
  subprocess: NsightSubprocessService
  signal?: AbortSignal
  /** Test seam: overrides the globbed parent directory. */
  globParent?: string
}): Promise<NcuResolution> {
  if (options.ncuPath !== undefined && options.ncuPath.trim() !== '') {
    return { path: options.ncuPath.trim(), source: 'explicit' }
  }

  // Windows: `where.exe ncu` (System32 is always reachable even though the
  // scrubbed child PATH is not). POSIX: `which ncu`.
  const helper = process.platform === 'win32'
    ? ['C:\\Windows\\System32\\where.exe', 'ncu']
    : ['/usr/bin/which', 'ncu']
  try {
    const { stdout, exitCode } = await runHelper(helper, options.subprocess, options.signal)
    if (exitCode === 0) {
      const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
      const exe = lines.find(line => line.toLowerCase().endsWith('ncu.exe'))
      if (exe !== undefined) return { path: exe, source: 'where' }
    }
  } catch {
    // where.exe unavailable/failed — fall through to the glob.
  }

  const globbed = globNcuInstall(options.globParent)
  if (globbed !== undefined) return { path: globbed, source: 'glob' }

  throw new Error(
    'nsight bench: the `ncu` executable was not found. Install Nsight Compute (standalone) or the CUDA toolkit '
    + 'and ensure ncu is on the system PATH, or pass an explicit ncuPath. Searched: `where ncu` (system PATH) '
    + `and ${NSIGHT_SEARCH_LOCATIONS.join(', ')}. See https://developer.nvidia.com/nsight-compute`,
  )
}

/**
 * Run one `ncu --csv --metrics <joined> --target-processes all <command>`
 * benchmark through the subprocess seam and parse the CSV report.
 *
 * Failure modes (all surfaced as errors or diagnostics, never a crash):
 * - ncu binary missing → Error with install guidance.
 * - Target exits non-zero → stderr propagated with a note.
 * - No CUDA kernels launched → empty kernels array + a note.
 * - Timeout → terminate + partial results if any CSV was collected.
 */
export async function runNsightBench(options: NsightBenchOptions): Promise<NsightBenchRun> {
  const metrics = options.metrics ?? DEFAULT_NSIGHT_METRICS
  const timeoutMs = options.timeout ?? 120_000
  const cwd = options.cwd ?? process.cwd()
  const commandParts = options.command.split(/\s+/).filter(part => part.length > 0)
  if (commandParts.length === 0) {
    throw new Error('nsight bench: the command parameter must name a kernel runner (e.g. "python bench_kernel.py")')
  }
  // Resolve ncu to an ABSOLUTE PATH before spawning: the subprocess seam's
  // scrubbed PATH does not include the Nsight Compute directory (bare `ncu`
  // → spawn ENOENT), and the PATH hit is ncu.bat, which the argv-based seam
  // cannot execute. ncu.exe is preferred over the .bat wrapper.
  const resolution = await resolveNcuExecutable({
    ...(options.ncuPath !== undefined ? { ncuPath: options.ncuPath } : {}),
    subprocess: options.subprocess,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  const argv = [resolution.path, '--csv', '--metrics', metrics.join(','), '--target-processes', 'all', ...commandParts]

  const controller = new AbortController()
  const timeoutTimer = setTimeout(() => { controller.abort() }, timeoutMs)
  const externalSignal = options.signal
  const onExternalAbort = (): void => { controller.abort() }
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })

  let handle: ReturnType<NsightSubprocessService['spawn']> | null = null
  let timedOut = false
  try {
    try {
      handle = options.subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 2000,
        signal: controller.signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('ENOENT') || message.includes('not found') || message.includes('cannot find')) {
        throw new Error(
          `nsight bench: the resolved ncu executable "${resolution.path}" (${resolution.source}) could not be `
          + 'spawned. Install Nsight Compute (standalone) or the CUDA toolkit, ensure ncu is on the system PATH, '
          + 'or pass an explicit ncuPath. See https://developer.nvidia.com/nsight-compute',
        )
      }
      throw new Error(`nsight bench: failed to spawn ncu: ${message}`)
    }

    const stdoutPromise = collectStream(handle.stdout)
    const stderrPromise = collectStream(handle.stderr)

    // Timeout: terminate + collect partial results.
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      controller.signal.addEventListener('abort', () => {
        if (!externalSignal?.aborted) timedOut = true
        handle?.terminate()
        resolve('timeout')
      }, { once: true })
    })

    const doneRace = await Promise.race([handle.done, timeoutPromise.then(() => null)])
    if (doneRace === null) {
      // Timeout fired; wait briefly for the child to die and collect what we have.
      await handle.done.catch(() => undefined)
    }

    const [stdoutText, stderrText] = await Promise.all([stdoutPromise, stderrPromise])
    const notes: string[] = []
    const result = parseNcuCsv(stdoutText, notes)
    const exitCode = doneRace?.exitCode ?? null

    if (exitCode !== null && exitCode !== 0) {
      notes.push(`target exited with code ${exitCode}`)
    }
    if (stderrText.trim().length > 0) {
      notes.push(...stderrText.trim().split('\n').slice(0, 20).map(line => `[stderr] ${line.trim()}`))
    }
    if (result.kernels.length === 0 && exitCode === 0 && !timedOut) {
      notes.push('no CUDA kernels were launched by the target command')
    }

    return { ...result, exitCode, stderr: stderrText, timedOut }
  } finally {
    clearTimeout(timeoutTimer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}
