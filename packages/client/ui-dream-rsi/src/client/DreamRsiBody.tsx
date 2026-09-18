/**
 * The Dream-RSI dashboard's body: champion, policy lineage, rounds, dreams.
 *
 * Everything the panel keeps lives in its store, keyed by tab; everything it
 * asks for goes through its injected face. The component only decides what to
 * draw and what a click means — the one control is refresh, which re-reads
 * every store file the sections come from. Styles are inline objects: this
 * bundle is built standalone (outside the harness's CSS pipeline), and the
 * panel is small enough to style without a compiler.
 */
import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { deriveChampion, FLOORED_SCORE, totalNodes } from './read.ts'
import type { DreamRow, PolicyRow, RoundRow } from './read.ts'
import type { DashboardData, DreamRsiTabState, createDreamRsiStore } from './store.ts'
import type { DreamRsiInjected } from './face.ts'
import type {} from './locales.ts'

/** The body's composed props: the tab it draws, its store, its face, its copy. */
export type DreamRsiBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createDreamRsiStore>>
  & DreamRsiInjected
  & PropsLocale<'dreamRsi'>

/** Score formatter: four fraction digits cover every score scale seen (2.63 packing, 100x speedups). */
const scoreFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 })
/** Compact time formatter for stamps (rounds, dreams, refreshes). */
const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
})

/** Format one score; floored candidates (−∞) read as the floor, not a number. */
function scoreText(score: number): string {
  if (score <= FLOORED_SCORE / 2) return '−∞'
  return scoreFormat.format(score)
}

/** Format one ISO stamp compactly; unparseable stamps show raw. */
function timeText(iso: string | undefined): string {
  if (iso === undefined) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return timeFormat.format(new Date(at))
}

/** Shared inline styles. */
const css = {
  root: {
    height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    padding: '12px 14px 20px', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5,
    color: 'var(--dsh-fg, inherit)', background: 'transparent',
  } satisfies React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
  } satisfies React.CSSProperties,
  headerTitle: { fontWeight: 600, fontSize: 13 } satisfies React.CSSProperties,
  headerMeta: { color: 'var(--dsh-fg-muted, #888)', marginLeft: 'auto' } satisfies React.CSSProperties,
  refreshButton: {
    display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
    border: '1px solid var(--dsh-border, #ccc)', borderRadius: 6, padding: '3px 8px',
    background: 'transparent', color: 'inherit', fontSize: 12,
  } satisfies React.CSSProperties,
  status: { padding: '24px 8px', textAlign: 'center', color: 'var(--dsh-fg-muted, #888)' } satisfies React.CSSProperties,
  statusTitle: { fontWeight: 600, marginBottom: 6, color: 'inherit' } satisfies React.CSSProperties,
  failureBox: {
    border: '1px solid var(--dsh-danger-border, #c66)', borderRadius: 8, padding: '10px 12px',
    marginBottom: 12, color: 'var(--dsh-danger-fg, #c33)',
  } satisfies React.CSSProperties,
  card: {
    border: '1px solid var(--dsh-border, #ddd)', borderRadius: 10, padding: '10px 12px', marginBottom: 12,
  } satisfies React.CSSProperties,
  cardTitle: {
    fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4,
    color: 'var(--dsh-fg-muted, #888)', marginBottom: 8,
  } satisfies React.CSSProperties,
  heroRow: { display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' } satisfies React.CSSProperties,
  heroMain: { fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums' } satisfies React.CSSProperties,
  heroLabel: { fontSize: 11, color: 'var(--dsh-fg-muted, #888)' } satisfies React.CSSProperties,
  heroCell: {} satisfies React.CSSProperties,
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } satisfies React.CSSProperties,
  chip: {
    border: '1px solid var(--dsh-border, #ddd)', borderRadius: 999, padding: '1px 8px', fontSize: 11,
    color: 'var(--dsh-fg-muted, #666)', whiteSpace: 'nowrap',
  } satisfies React.CSSProperties,
  chipActive: {
    borderColor: 'var(--dsh-accent-border, #2a7)', color: 'var(--dsh-accent-fg, #2a7)', fontWeight: 600,
  } satisfies React.CSSProperties,
  lineage: { listStyle: 'none', margin: 0, padding: 0 } satisfies React.CSSProperties,
  lineageItem: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' } satisfies React.CSSProperties,
  lineageVersion: {
    fontVariantNumeric: 'tabular-nums', fontWeight: 600, minWidth: 44,
  } satisfies React.CSSProperties,
  lineageName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } satisfies React.CSSProperties,
  lineageStatus: { fontSize: 11, color: 'var(--dsh-fg-muted, #888)', marginLeft: 'auto', flexShrink: 0 } satisfies React.CSSProperties,
  table: {
    width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums',
  } satisfies React.CSSProperties,
  th: {
    textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--dsh-fg-muted, #888)',
    borderBottom: '1px solid var(--dsh-border, #ddd)', padding: '2px 8px 2px 0', whiteSpace: 'nowrap',
  } satisfies React.CSSProperties,
  td: {
    borderBottom: '1px solid var(--dsh-border, #eee)', padding: '3px 8px 3px 0', verticalAlign: 'top',
  } satisfies React.CSSProperties,
  tdNum: { textAlign: 'right', whiteSpace: 'nowrap' } satisfies React.CSSProperties,
  summary: { color: 'var(--dsh-fg-muted, #777)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } satisfies React.CSSProperties,
  note: { color: 'var(--dsh-fg-muted, #888)', padding: '4px 0' } satisfies React.CSSProperties,
  sectionGap: { height: 14 } satisfies React.CSSProperties,
  eventLine: { display: 'flex', gap: 8, padding: '1px 0' } satisfies React.CSSProperties,
  eventCall: { fontFamily: 'ui-monospace, monospace', fontSize: 11 } satisfies React.CSSProperties,
  eventTime: { color: 'var(--dsh-fg-muted, #888)', marginLeft: 'auto', flexShrink: 0 } satisfies React.CSSProperties,
}

/** The champion card: the campaign's best result and where the program stands. */
function ChampionCard({ data, t }: { data: DashboardData; t: PropsLocale<'dreamRsi'>['t'] }): ReactNode {
  const champion = deriveChampion(data.rounds)
  const active = data.policies.find(policy => policy.version === data.activeVersion)
  return (
    <div className='dream-rsi-champion' style={css.card} data-dream-rsi='champion'>
      <div style={css.cardTitle}>{t('champion.title')}</div>
      {champion === undefined
        ? <div style={css.note}>{t('champion.none')}</div>
        : (
            <div style={css.heroRow}>
              <div style={css.heroCell}>
                <div style={css.heroMain} data-dream-rsi='champion-score'>{scoreText(champion.score)}</div>
                <div style={css.heroLabel}>{t('champion.bestScore')}</div>
              </div>
              <div style={css.heroCell}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{champion.roundId}</div>
                <div style={css.heroLabel}>{t('champion.round')}</div>
              </div>
            </div>
          )}
      <div style={css.chips}>
        {active !== undefined && (
          <span style={{ ...css.chip, ...css.chipActive }} data-dream-rsi='active-policy'>
            {t('champion.activePolicy')}: {active.version}{active.name === undefined ? '' : ` · ${active.name}`}
          </span>
        )}
        {active?.kind !== undefined && <span style={css.chip}>{t('champion.kind')}: {active.kind}</span>}
        <span style={css.chip}>{t('champion.rounds')}: {String(data.rounds.length)}</span>
        <span style={css.chip}>{t('champion.nodes')}: {String(totalNodes(data.rounds))}</span>
        <span style={css.chip}>{t('champion.dreams')}: {String(data.dreams.length)}</span>
      </div>
    </div>
  )
}

/** One lineage row: version, name, derivation, status. */
function LineageItem({ policy, t }: { policy: PolicyRow; t: PropsLocale<'dreamRsi'>['t'] }): ReactNode {
  const active = policy.status === 'active'
  return (
    <li style={css.lineageItem} data-dream-rsi-version={policy.version} data-dream-rsi-status={policy.status}>
      <span style={css.lineageVersion}>{policy.version}</span>
      <span style={css.lineageName} title={policy.name}>
        {policy.name ?? ''}
        {policy.kind === undefined ? '' : ` (${String(policy.kind)})`}
      </span>
      <span style={css.lineageStatus}>
        {active ? t('lineage.active') : t('lineage.retired')}
        {' · '}
        {policy.parentId == null ? t('lineage.root') : t('lineage.parent', { parent: policy.parentId })}
      </span>
    </li>
  )
}

/** The rounds table: one row per closed or open round, newest first. */
function RoundsTable({ rounds, t }: { rounds: readonly RoundRow[]; t: PropsLocale<'dreamRsi'>['t'] }): ReactNode {
  if (rounds.length === 0) return <div style={css.note}>{t('rounds.empty')}</div>
  return (
    <table style={css.table} data-dream-rsi='rounds'>
      <thead>
        <tr>
          <th style={css.th}>{t('rounds.round')}</th>
          <th style={css.th}>{t('rounds.status')}</th>
          <th style={css.th}>{t('rounds.policy')}</th>
          <th style={{ ...css.th, ...css.tdNum }}>{t('rounds.nodes')}</th>
          <th style={{ ...css.th, ...css.tdNum }}>{t('rounds.attempts')}</th>
          <th style={{ ...css.th, ...css.tdNum }}>{t('rounds.best')}</th>
        </tr>
      </thead>
      <tbody>
        {rounds.map(round => (
          <tr key={round.roundId} data-dream-rsi-round={round.roundId}>
            <td style={css.td}>{round.roundId}</td>
            <td style={css.td}>{round.status === 'open' ? t('rounds.open') : t('rounds.closed')}</td>
            <td style={css.td}>{round.policyVersion ?? ''}</td>
            <td style={{ ...css.td, ...css.tdNum }}>{round.nodes === undefined ? '' : String(round.nodes)}</td>
            <td style={{ ...css.td, ...css.tdNum }}>{round.attempts === undefined ? '' : String(round.attempts)}</td>
            <td style={{ ...css.td, ...css.tdNum }} data-dream-rsi-best={round.bestScore === undefined ? '' : String(round.bestScore)}>
              {round.bestScore === undefined ? '' : scoreText(round.bestScore)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** One dream report row. */
function DreamItem({ dream, t }: { dream: DreamRow; t: PropsLocale<'dreamRsi'>['t'] }): ReactNode {
  return (
    <li style={css.lineageItem} data-dream-rsi-run={dream.runId}>
      <span style={css.lineageVersion}>{dream.runId}</span>
      <span style={css.lineageName} title={dream.invalid ?? dream.selectedName}>
        {dream.selectedName ?? '—'}
        {dream.selectedVersion === undefined ? '' : ` → ${dream.selectedVersion}`}
        {dream.selectedKind === undefined ? '' : ` (${String(dream.selectedKind)})`}
        {dream.floored === true && <span style={{ color: 'var(--dsh-danger-fg, #c33)' }}> · {t('dreams.floored')}</span>}
        {dream.invalid !== undefined && dream.floored !== true && <span style={{ color: 'var(--dsh-danger-fg, #c33)' }}> · {dream.invalid}</span>}
      </span>
      <span style={css.lineageStatus}>
        {dream.meanScore === undefined ? '' : `${t('dreams.score')} ${scoreText(dream.meanScore)} · `}
        {dream.validWorlds === undefined
          ? ''
          : `${t('dreams.validWorlds')} ${t('worlds', {
              count: dream.validWorlds,
              total: dream.worldCount ?? dream.validWorlds,
            })}`}
      </span>
    </li>
  )
}

/** The dream reports list. */
function DreamsList({ dreams, t }: { dreams: readonly DreamRow[]; t: PropsLocale<'dreamRsi'>['t'] }): ReactNode {
  if (dreams.length === 0) return <div style={css.note}>{t('dreams.empty')}</div>
  return <ul style={css.lineage}>{dreams.map(dream => <DreamItem key={dream.runId} dream={dream} t={t} />)}</ul>
}

/** The events tail. */
function EventsTail({ data, t }: { data: DashboardData; t: PropsLocale<'dreamRsi'>['t'] }): ReactNode {
  if (data.events.length === 0) return <div style={css.note}>{t('events.empty')}</div>
  return (
    <div data-dream-rsi='events'>
      {data.events.slice(-8).map((event, index) => (
        <div key={`${event.ts ?? ''}-${String(index)}`} style={css.eventLine}>
          <span style={css.eventCall}>{event.call ?? '·'}</span>
          <span style={css.eventTime}>{timeText(event.ts)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * The panel body: the dashboard for one tab.
 * @param props - the tab, store, face, and copy.
 * @returns the rendered dashboard.
 */
export function DreamRsiBody({
  useTabInfo, useStore, refresh, forget, t,
}: DreamRsiBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { signal } = tab
  const state: DreamRsiTabState | undefined = useStore(store => store.byTab[tab.id])

  // Forget on abort (mirrors the files tree's bucket lifetime), then refresh
  // on mount and on every re-navigation of this tab.
  useEffect(() => {
    const onAbort = (): void => { forget(tab.id) }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => { signal.removeEventListener('abort', onAbort) }
  }, [signal, tab.id, forget])
  useEffect(() => {
    if (signal.aborted) return
    refresh(tab.id, signal)
  }, [signal, tab.id, tab.navigation.revision, refresh])

  const failureShown = state !== undefined && (state.status === 'failed' || state.failure !== undefined)
  const data = state?.data
  const updated = useMemo(
    () => state?.loadedAt === undefined ? undefined : timeFormat.format(new Date(state.loadedAt)),
    [state?.loadedAt],
  )

  return (
    <div style={css.root} data-dream-rsi-state={state?.status ?? 'idle'}>
      <div style={css.header}>
        <span style={css.headerTitle}>{t('type.label')}</span>
        <span style={css.headerMeta}>
          {updated === undefined ? '' : t('refreshedAt', { time: updated })}
        </span>
        <button
          type='button'
          style={css.refreshButton}
          onClick={() => { refresh(tab.id, signal) }}
          disabled={state?.status === 'loading'}
          aria-label={t('refresh')}
          title={t('refresh')}
          data-dream-rsi='refresh'
        >
          <IconRefreshOutline16 size={13} />
          {t('refresh')}
        </button>
      </div>

      {failureShown && (
        <div style={css.failureBox} data-dream-rsi='failure'>
          <div style={{ fontWeight: 600 }}>{t('error.title')}</div>
          <div>{state?.failure ?? ''}</div>
        </div>
      )}

      {(state === undefined || state.status === 'idle' || (state.status === 'loading' && data === undefined)) && (
        <div style={css.status}>{t('loading')}</div>
      )}

      {state?.status === 'missing' && (
        <div style={css.status} data-dream-rsi='empty'>
          <div style={css.statusTitle}>{t('empty.title')}</div>
          <div>{t('empty.hint')}</div>
        </div>
      )}

      {data !== undefined && (
        <>
          <ChampionCard data={data} t={t} />

          <div style={css.card} data-dream-rsi='lineage'>
            <div style={css.cardTitle}>{t('lineage.title')}</div>
            {data.policies.length === 0
              ? <div style={css.note}>{t('lineage.empty')}</div>
              : <ul style={css.lineage}>{data.policies.map(policy => <LineageItem key={policy.version} policy={policy} t={t} />)}</ul>}
          </div>

          <div style={css.sectionGap} />
          <div style={{ ...css.cardTitle, marginBottom: 4 }}>{t('rounds.title')}</div>
          <RoundsTable rounds={data.rounds} t={t} />
          {data.roundsTruncated && <div style={css.note}>{t('truncatedRounds', { count: data.rounds.length })}</div>}

          <div style={css.sectionGap} />
          <div style={{ ...css.cardTitle, marginBottom: 4 }}>{t('dreams.title')}</div>
          <DreamsList dreams={data.dreams} t={t} />
          {data.dreamsTruncated && <div style={css.note}>{t('truncatedDreams', { count: data.dreams.length })}</div>}

          <div style={css.sectionGap} />
          <div style={{ ...css.cardTitle, marginBottom: 4 }}>{t('events.title')}</div>
          <EventsTail data={data} t={t} />
        </>
      )}
    </div>
  )
}
