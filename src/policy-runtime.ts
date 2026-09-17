/**
 * Code-policy execution over `ctx.subprocess` (v0.2 F1).
 *
 * One subprocess per POLICY per dream run: `python -I <runner> <policy>`,
 * fully-explicit spawn spec (argv never shell-interpreted, scrubbed parent
 * environment, piped stdin/stdout, collected stderr diagnostics). The replay
 * engine drives a JSON-lines decision protocol — one JSON view per stdin
 * line per decision round, one JSON decision per stdout line — with every
 * world of a candidate running inside the same process. Each episode
 * (policy × world) runs under a wall-clock budget: a timeout fires
 * `terminate()` (abort escalation + provider termination) and marks the
 * episode invalid. Any response the engine cannot parse (malformed JSON,
 * `__error` line, missing batch/stop, premature exit) poisons the process
 * and invalidates the episode — output framing cannot be trusted after one
 * bad line.
 *
 * @module
 */

import type { PolicyDecision, PolicyView } from './types.ts'

/** The slice of the `ctx.subprocess` seam the policy runtime needs. */
export interface SubprocessService {
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
    readonly stdin: import('node:stream').Writable | undefined
    readonly stdout: import('node:stream').Readable | undefined
    readonly stderr: import('node:stream').Readable | undefined
    readonly collected: {
      readonly stdout?: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
      readonly stderr?: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
    }
    readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
    terminate(): void
    waitForExit(signal?: AbortSignal): Promise<boolean>
  }
}

/** Options for {@link startPolicyProcess}. */
export interface PolicyProcessOptions {
  /** The subprocess seam (ctx.subprocess). */
  subprocess: SubprocessService
  /** Python executable (bare names resolve through the provider's scrubbed PATH). */
  pythonPath?: string
  /** Absolute path of the shipped runner (`policies/.runner.py`). */
  runnerPath: string
  /** Absolute path of the policy module (`policies/vNNNN.py`). */
  policyPath: string
  /** Working directory for the child (the store's policies dir). */
  cwd: string
  /** Wall-clock budget per episode (policy × world), milliseconds. */
  episodeTimeoutMs: number
  /** Abort signal wired into the spawn spec (episode teardown ladder). */
  signal?: AbortSignal
}

/** One answered decision round. */
export type PolicyAnswer =
  | { kind: 'decision'; decision: PolicyDecision }
  | { kind: 'invalid'; reason: string }

/** One live code-policy subprocess driving JSON-lines decisions. */
export interface PolicyProcess {
  /** Send one view and await the policy's decision (or an invalid verdict). */
  ask(view: PolicyView): Promise<PolicyAnswer>
  /** Terminate the child and await its exit (idempotent). */
  dispose(): Promise<void>
}

/** Incremental newline framing over one piped stdout. */
class LineReader {
  private buffer = ''
  private closed = false
  private readonly queued: string[] = []
  private wake: (() => void) | null = null
  private readonly stream: import('node:stream').Readable | undefined

  constructor(stream: import('node:stream').Readable | undefined) {
    this.stream = stream
    if (!this.stream) return
    this.stream.setEncoding('utf8')
    this.stream.on('data', (chunk: string) => {
      this.buffer += chunk
      let index = this.buffer.indexOf('\n')
      while (index !== -1) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        this.queued.push(line)
        index = this.buffer.indexOf('\n')
      }
      const wake = this.wake
      this.wake = null
      wake?.()
    })
    this.stream.on('end', () => {
      this.closed = true
      const wake = this.wake
      this.wake = null
      wake?.()
    })
    this.stream.on('error', () => {
      this.closed = true
      const wake = this.wake
      this.wake = null
      wake?.()
    })
  }

  get closedStream(): boolean {
    return this.closed
  }

  /**
   * Await the next complete line, or `null` on close/timeout.
   * @param timeoutMs - wall-clock budget; elapsed resolves null.
   */
  async nextLine(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const line = this.queued.shift()
      if (line !== undefined) return line
      if (this.closed) return null
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      await new Promise<void>((resolve) => {
        this.wake = resolve
        setTimeout(resolve, Math.min(remaining, 50)).unref?.()
      })
    }
  }
}

/**
 * Start one code-policy subprocess. Spawn failures (missing interpreter)
 * surface on the first {@link PolicyProcess.ask} as an invalid verdict
 * rather than throwing, so a dream run degrades to invalid candidates.
 */
export function startPolicyProcess(options: PolicyProcessOptions): PolicyProcess {
  const pythonPath = options.pythonPath ?? 'python'
  let poisoned: string | null = null
  let handle: ReturnType<SubprocessService['spawn']> | null = null
  let reader: LineReader | null = null
  let exitFact: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null
  const disposer = createDisposer()

  function poison(reason: string): void {
    if (poisoned === null) poisoned = reason
  }

  function createDisposer(): () => Promise<void> {
    let disposePromise: Promise<void> | null = null
    return () => {
      disposePromise ??= (async () => {
        handle?.terminate()
        if (handle) {
          try {
            await handle.waitForExit()
          } catch {
            // The provider may already be gone; termination is best-effort.
          }
        }
      })()
      return disposePromise
    }
  }

  try {
    handle = options.subprocess.spawn({
      argv: [pythonPath, '-I', options.runnerPath, options.policyPath],
      cwd: options.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
      graceMs: 1000,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    reader = new LineReader(handle.stdout)
    void handle.done.then((outcome) => {
      // The process stays alive across episodes; a settlement here is always
      // a crash or a teardown — poison either way.
      exitFact = outcome
      poison(`policy process exited prematurely (exitCode ${outcome.exitCode}, signal ${outcome.signal ?? 'null'})`)
    }).catch((error: unknown) => {
      poison(`policy process failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  } catch (error) {
    poisoned = `failed to spawn the python policy runner: ${error instanceof Error ? error.message : String(error)}`
  }

  return {
    async ask(view: PolicyView): Promise<PolicyAnswer> {
      if (poisoned !== null) return { kind: 'invalid', reason: poisoned }
      if (handle === null || reader === null || handle.stdin === undefined) {
        poison('policy process has no writable stdin')
        return { kind: 'invalid', reason: poisoned ?? 'policy process unusable' }
      }
      const writeSucceeded = await new Promise<boolean>((resolve) => {
        try {
          handle!.stdin!.write(`${JSON.stringify(view)}\n`, (error) => resolve(error === null || error === undefined))
        } catch {
          resolve(false)
        }
      })
      if (!writeSucceeded) {
        poison('policy stdin write failed')
        return { kind: 'invalid', reason: poisoned ?? 'policy stdin write failed' }
      }
      const line = await reader.nextLine(options.episodeTimeoutMs)
      if (line === null) {
        const reason = exitFact !== null
          ? `policy process exited prematurely (exitCode ${exitFact.exitCode}, signal ${exitFact.signal ?? 'null'})`
          : `policy episode timed out after ${options.episodeTimeoutMs}ms`
        poison(reason)
        void disposer()
        return { kind: 'invalid', reason }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        const reason = `malformed policy output (not JSON): ${line.slice(0, 200)}`
        poison(reason)
        void disposer()
        return { kind: 'invalid', reason }
      }
      if (typeof parsed !== 'object' || parsed === null) {
        const reason = 'malformed policy output (not an object)'
        poison(reason)
        void disposer()
        return { kind: 'invalid', reason }
      }
      const decision = parsed as Record<string, unknown>
      if (typeof decision['__error'] === 'string') {
        const reason = `policy solve() failed: ${decision['__error']}`
        poison(reason)
        void disposer()
        return { kind: 'invalid', reason }
      }
      if (!Array.isArray(decision['batch']) || decision['batch'].some((id) => typeof id !== 'string')) {
        const reason = 'malformed policy output (batch must be a list of node ids)'
        poison(reason)
        void disposer()
        return { kind: 'invalid', reason }
      }
      if (typeof decision['stop'] !== 'boolean') {
        const reason = 'malformed policy output (stop must be a boolean)'
        poison(reason)
        void disposer()
        return { kind: 'invalid', reason }
      }
      const notes = typeof decision['notes'] === 'string' ? decision['notes'] : undefined
      return {
        kind: 'decision',
        decision: {
          batch: decision['batch'] as string[],
          stop: decision['stop'] as boolean,
          ...(notes !== undefined ? { notes } : {}),
        },
      }
    },
    dispose: disposer,
  }
}
