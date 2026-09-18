/**
 * Stage one of this package's registration: what the `dream-rsi` tab type IS.
 *
 * The type is a page, not a viewer: it claims no resource address. The guide
 * page offers it as an entry box; picking it opens the dashboard, which reads
 * the session workspace's `.dreamrsi/` store through the workspaceFiles pipe.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const DREAM_RSI_KIND = 'dream-rsi'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const DREAM_RSI_ID = '@dreamrsi/dsh-client-ui-dream-rsi'

/** The guide entry's position, after the shipped pages (files at 10). */
export const GUIDE_ORDER = 40

/**
 * The dream-rsi type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function dreamRsiDefinition(t: TranslateNS<'dreamRsi'>): SidebarRightTabDefinition {
  return {
    id: DREAM_RSI_ID,
    kind: DREAM_RSI_KIND,
    // A plugin type from outside the product: the extension band is the
    // default and the correct one.
    priority: 'extension',
    title: () => t('type.label'),
    guide: [{
      order: GUIDE_ORDER,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
    }],
  }
}
