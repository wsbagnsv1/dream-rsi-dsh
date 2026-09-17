/**
 * Standalone type declarations for the DSH (Cordis) plugin surface.
 *
 * This package is developed OUTSIDE the deepseek-harness monorepo, where the
 * real `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, and
 * `@deepseek-ai/schemastery` modules are not installed (they are workspace /
 * vendored packages of the harness checkout). The ambient declarations below
 * mirror the shapes documented in the DSH plugin docs and used by its
 * reference plugins (e.g. `packages/schedule/schedule`) closely enough for
 * this package to typecheck and build in isolation:
 *
 * - `@deepseek-ai/cordis`: the `Context` passed to `apply()` — `ctx.effect()`,
 *   `ctx.on()`, `ctx.emit()`, `ctx.get()`, `ctx.logger()` — plus the `tools`
 *   service that `inject: ['tools']` guarantees.
 * - `@deepseek-ai/dsh-tools`: the `defineTool()` registration DSL
 *   (`name` / `description` / `parameters` / `output.schema` + `output.render`
 *   / `execute`), with argument and canonical-value types inferred from the
 *   schema literals, as documented in `docs/user/develop/basic/tool.md` and
 *   `docs/cookbook/adding-a-tool.md`.
 * - `@deepseek-ai/schemastery`: the config-schema class used to export
 *   `Config` next to `apply()` (see `docs/user/develop/basic/config.md`).
 *
 * These declarations are TYPES ONLY and carry no runtime behavior. When the
 * plugin is loaded inside DSH, the harness resolves those bare specifiers to
 * its own real modules, which supply the actual runtime behavior; the real
 * type declarations then take precedence over this file. Nothing in this
 * package imports anything else at runtime.
 *
 * @module
 */

declare module '@deepseek-ai/cordis' {
  /**
   * Minimal structural mirror of a Cordis named logger.
   * Harness loggers accept arbitrary serializable arguments.
   */
  export interface Logger {
    debug(...args: readonly unknown[]): void
    info(...args: readonly unknown[]): void
    warn(...args: readonly unknown[]): void
    error(...args: readonly unknown[]): void
  }

  /**
   * Minimal structural mirror of the public Cordis context surface used by
   * plugins in this package.
   *
   * The real context is a proxy: service reads (`ctx.tools`, ...) resolve
   * through the service registry and are typed via declaration merging (see
   * the `tools` augmentation contributed below by the dsh-tools mirror).
   */
  export interface Context {
    /** The root context of the application (every child context shares it). */
    root: this
    /** Base URL used to resolve relative plugin/module specifiers, if the runtime sets one. */
    baseUrl?: string
    /**
     * Register an effect whose optional disposer runs when the owning plugin
     * unloads (see docs/user/develop/basic/index.md "Automatic cleanup").
     *
     * @param dispose — body run at registration; may return a disposer.
     * @param name — optional diagnostic name for the effect.
     * @returns a function that disposes the effect early.
     */
    effect(dispose: () => void | (() => void | Promise<void>), name?: string): () => void
    /**
     * Register an event listener. Listeners are effects: they are removed
     * automatically when the owning plugin unloads (see docs framework/events.md).
     *
     * @returns a function that removes the listener early.
     */
    on(event: string, listener: (...args: readonly any[]) => unknown): () => void
    /** Broadcast an event; every listener runs synchronously and return values are ignored. */
    emit(event: string, ...args: readonly unknown[]): void
    /** Resolve a service by name at the use site (optional-dependency access). */
    get<T = unknown>(name: string): T | undefined
    /** Create a named child logger. */
    logger(name?: string): Logger
  }
}

declare module '@deepseek-ai/dsh-tools' {
  /** JSON scalar allowed in schema literals. */
  export type Scalar = string | number | boolean | null

  /**
   * Minimal structural mirror of the unified schema spec used for tool
   * parameters (`ParameterSchemaSpec`) and canonical output values
   * (`ValueSchemaSpec`). Pass schema literals inline; `defineTool` preserves
   * their literal types via `const` type parameters so argument and canonical
   * value types are inferred exactly as in the DSH tool DSL.
   */
  export interface SchemaSpec {
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
    /** Mark the (property) key as mandatory. Omitted or `false` means optional. */
    required?: boolean
    /** Model-facing description. */
    description?: string
    /** Restrict the value to a closed set of scalars. */
    enum?: readonly Scalar[]
    /** Restrict the value to one exact scalar. */
    const?: Scalar
    /** Object properties. */
    properties?: { readonly [key: string]: SchemaSpec }
    /** Array element spec. */
    items?: SchemaSpec
    /** Whether an object admits keys beyond `properties` (defaults to open at the implicit root). */
    additionalProperties?: boolean
    /** Exactly-one union branches. */
    oneOf?: readonly SchemaSpec[]
    /** Any-of union branches. */
    anyOf?: readonly SchemaSpec[]
  }

  /** A map of parameter name → schema spec, as accepted by {@link defineTool}. */
  export type SchemaSpecMap = { readonly [key: string]: SchemaSpec }

  /**
   * Infer the value described by an object-shaped spec map: required keys stay
   * required, all other keys become optional.
   */
  export type InferSpecObject<P extends { readonly [key: string]: SchemaSpec }> = {
    [K in keyof P as P[K] extends { readonly required: true } ? K : never]: InferSchemaValue<P[K]>
  } & {
    [K in keyof P as P[K] extends { readonly required: true } ? never : K]?: InferSchemaValue<P[K]>
  }

  /**
   * Infer the canonical value type described by a schema spec literal
   * (`const`/`enum` collapse to literal unions; objects and arrays recurse).
   */
  export type InferSchemaValue<S extends SchemaSpec> = S extends { readonly const: infer C }
    ? C
    : S extends { readonly enum: readonly (infer E)[] }
      ? E
      : S extends { readonly oneOf: infer B } | { readonly anyOf: infer B }
        ? B extends readonly SchemaSpec[]
          ? { [I in keyof B]: InferSchemaValue<B[I]> }[number]
          : unknown
        : S extends { readonly type: 'array'; readonly items: infer I }
          ? I extends SchemaSpec ? InferSchemaValue<I>[] : unknown[]
          : S extends { readonly type: 'object'; readonly properties: infer P }
            ? P extends { readonly [key: string]: SchemaSpec } ? InferSpecObject<P> : Record<string, unknown>
            : S extends { readonly type: 'string' } ? string
              : S extends { readonly type: 'number' | 'integer' } ? number
                : S extends { readonly type: 'boolean' } ? boolean
                  : S extends { readonly type: 'null' } ? null
                    : unknown

  /** Infer the validated `args` object type from a tool's `parameters` map. */
  export type InferArgs<P extends SchemaSpecMap> = InferSpecObject<P>

  /**
   * Model-facing content block. Minimal mirror: this plugin's renderers only
   * produce text blocks; the real DSH union carries more kinds.
   */
  export interface ContentBlock {
    type: 'text'
    text: string
  }

  /**
   * The calling agent, when the call runs on behalf of one (set by the agent
   * loop). `session.header.cwd` is the agent's per-session workspace root —
   * the same lookup `dsh-tool-fs` uses to resolve relative paths per session.
   */
  export interface ToolAgentContext {
    /**
     * Append durable context that the NEXT model request of the calling agent
     * sees. This is not a wake-up: an idle agent stays idle.
     */
    inject(input: { content: string; source: { kind: 'plugin'; plugin: string } }): Promise<void> | void
    /** The agent's session; `header.cwd` is its per-session workspace root. */
    readonly session: { header: { cwd?: string } }
  }

  /**
   * Immutable execution identity handed to `execute` (minimal mirror of the
   * DSH dispatch context; see docs/cookbook/adding-a-tool.md).
   */
  export interface ToolExecuteContext {
    /** Caller-owned abort signal — honor it and cancel in-flight work when it fires. */
    readonly signal: AbortSignal
    /** Opaque unique id for this invocation. */
    readonly callId: string
    /** The registered tool name. */
    readonly name: string
    /** Frozen lossless-JSON copy of the validated arguments. */
    readonly arguments: unknown
    /** Opaque execution token (identity only). */
    readonly token: unknown
    /** Session + notification surface for the calling agent, if the call has one. */
    readonly agent?: ToolAgentContext
  }

  /**
   * The readonly tool definition produced by {@link defineTool} and accepted
   * by `ctx.tools.register()`. Registration borrows the definition — do not
   * mutate it afterwards.
   */
  export interface ToolDefinition<P extends SchemaSpecMap = SchemaSpecMap, S extends SchemaSpec = SchemaSpec> {
    readonly name: string
    readonly description: string
    readonly parameters: P
    readonly output: {
      readonly schema: S
      readonly render: (args: InferArgs<P>, value: InferSchemaValue<S>) => ContentBlock[]
    }
    execute(args: InferArgs<P>, exec: ToolExecuteContext): InferSchemaValue<S> | Promise<InferSchemaValue<S>>
  }

  /**
   * Erased definition type for heterogeneous collections of tools (render and
   * execute are contravariant in the schema-derived types, so a mixed array
   * cannot use the generic type directly).
   */
  export type AnyToolDefinition = ToolDefinition<any, any>

  /**
   * Mirror of the DSH tool DSL entry point. Schema literals are preserved via
   * `const` type parameters so `args` is typed from `parameters` and the
   * canonical value from `output.schema` — annotate nothing by hand.
   * At runtime inside DSH the real `defineTool` additionally validates
   * model-generated arguments before `execute` runs.
   */
  export function defineTool<const P extends SchemaSpecMap, const S extends SchemaSpec>(definition: {
    readonly name: string
    readonly description: string
    readonly parameters: P
    readonly output: {
      readonly schema: S
      readonly render: (args: InferArgs<P>, value: InferSchemaValue<S>) => ContentBlock[]
    }
    readonly execute: (
      args: InferArgs<P>,
      exec: ToolExecuteContext,
    ) => InferSchemaValue<S> | Promise<InferSchemaValue<S>>
  }): ToolDefinition<P, S>

  /** The `tools` service mounted on the Cordis context. */
  export interface ToolRegistry {
    /**
     * Register a model-facing tool. Registration is effect-based: disposing
     * the owning plugin fiber unregisters the tool.
     */
    register<P extends SchemaSpecMap, S extends SchemaSpec>(definition: ToolDefinition<P, S>): void
  }
}

// `ctx.tools` becomes typed once `inject: ['tools']` is declared and the
// dsh-tools declarations (above) are part of the program.
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Tool registry service; guaranteed ready when `inject` contains `'tools'`. */
    tools: ToolRegistry
  }
}

declare module '@deepseek-ai/schemastery' {
  /**
   * Mirror of the Schemastery schema surface. The default export is a class
   * so the imported name carries both meanings used by the DSH config
   * contract: `Schema.field()` builder statics and `Schema<T>` type
   * annotations. (Instance members are declared on the class directly: a
   * default-imported class binding does not pick up members from a
   * same-named `export interface` merge. The real schema instances are also
   * callable validators, but plugin code never calls the schema itself —
   * Cordis validates config during plugin load.)
   */
  export default class Schema<T = unknown> {
    static object<P extends { readonly [key: string]: Schema<any> }>(properties: P): Schema<{ [K in keyof P]: P[K] extends Schema<infer V> ? V : unknown }>
    static string(): Schema<string>
    static number(): Schema<number>
    static boolean(): Schema<boolean>
    static array<T>(item: Schema<T>): Schema<T[]>
    static dict<T>(item: Schema<T>): Schema<Record<string, T>>
    static union<const T extends readonly unknown[]>(options: T): Schema<T[number]>
    static const<T>(value: T): Schema<T>
    /** Supply a default value (fills the field when the user config omits it). */
    default(value: T): Schema<T>
    /** Mark the field mandatory (load fails when it is absent). */
    required(): Schema<T>
    /** Attach a UI-facing description. */
    description(text: string): Schema<T>
  }
}
