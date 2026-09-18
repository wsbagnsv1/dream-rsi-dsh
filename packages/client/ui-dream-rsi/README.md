# @dreamrsi/dsh-client-ui-dream-rsi

Dream-RSI campaign dashboard tab type for the DSH right Sidebar — the
client-side companion to the preset-gated `dreamrsi_*` tools. It renders the
live state of a workspace's `.dreamrsi/` discovery store **read-only**, exactly
the way the workspace file tree and the document preview do: a Sidebar page
type reading workspace files through the `workspaceFiles` Remote namespace.

## What it shows

- **Champion card** — the best score across all rounds (which round, which
  policy), the active policy version + name + kind (`dsl`/`code`), plus
  round/node/dream totals.
- **Policy lineage** — the full `v0001 → vNNNN` timeline from
  `policies/policy-index.json` with status (active/retired), kind, name, and
  derivation.
- **Rounds table** — per-round status, policy, nodes, attempts, and best score
  from `trees/<roundId>/round.json` — **every** round with a tree, newest
  first, scrollable (sticky header).
- **Dream reports** — recent `dreams/dNNNN.json` runs: the selected candidate,
  its mean replay score, valid-world counts, and floored/invalid diagnostics
  (latest 8).
- **Events tail** — the last lines of `events.jsonl`.
- **Refresh** — re-reads every store file on demand; the store updates as
  campaigns run. The panel also re-reads when the tab is re-opened.
- **Empty state** — a workspace without `.dreamrsi/` shows an explicit "no
  discovery store yet" panel with the hint that the store appears once a
  session on the Dream-RSI preset runs `dreamrsi_begin_round`.

## Architecture (mirrors `ui-sidebar-files`)

- `src/index.ts` — the host half (a no-op `apply()`; the whole surface is the
  browser export).
- `src/client/index.ts` — the browser half: `inject =
  ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']`
  and the two-stage registration (type into `ctx.sidebarRightTabs`, body into
  the keyed `sidebar.right.pane.tab` seat).
- `src/client/definition.ts` — the page type (no patterns; guide entry).
- `src/client/read.ts` — pure store-file parsers and derivation (champion,
  totals); unit-tested, tolerant of half-written files.
- `src/client/store.ts` — Slot-standard exclusive store, bucketed by tab id.
- `src/client/face.ts` — the Remote face: generation-guarded refresh, workspace-
  relative reads only (the panel never writes).
- `src/client/dsh-ambient.d.ts` — ambient mirrors of the consumed DSH client
  runtime surfaces, so the package typechecks standalone. Inside DSH the real
  packages supply the runtime; every value import stays external in the bundle
  and resolves through the browser module table.
- `locales.ts` — `dreamRsi` namespace, zh (key-set source of truth) + en.

## Build

```sh
pnpm build    # lib/index.js (host half, ESM) + lib/client.js (browser bundle)
```

`build.mjs` produces the browser bundle in the DSH client-module
closure-factory format (`window.__ModuleLoader__.load({id, factory})` banner,
`var module = { exports: {} }` intro, `return module.exports; } });` footer),
with `react` and every `@deepseek-ai/*` import kept external for the module
table. Styles are inline objects (no CSS-modules pipeline in this standalone
build).

```sh
pnpm typecheck   # standalone strict tsc (ambient mirrors)
pnpm test        # vitest: read.ts parsers + store action semantics
```

## Mounting

Two halves, two planes:

1. **Agent plane (preset row)** — `preset/dream-rsi/agent.cordis.yml` carries
   the row mounting this package's host half alongside the `dream-rsi` server
   row. It keeps the preset self-describing.
2. **Host plane (browser delivery)** — the browser boot graph is composed by
   the harness's client-modules node half scanning the HOST composition's
   loader entries; preset subtrees are deliberately invisible to that scan, so
   the browser half is served when the package is mounted in the host
   composition. This deployment mounts it the same way `ui-agent-team` is
   mounted: the package linked into the web profile's `node_modules` plus an
   insert row in the profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: ui-dream-rsi
         name: '@dreamrsi/dsh-client-ui-dream-rsi'
   ```

   The repo's `install.ps1 -WithWebUI` performs both steps against
   `$DSH_HOME/profiles/web` (link + idempotent insert). Restart `dsh web` (or
   rely on live patch reload + HMR) and the "Dream-RSI campaign dashboard"
   capsule appears in the right Sidebar's guide page.
