import { Router } from 'express'
import { db } from '../db.ts'
import { applyCallback, applyMenuPush, applyStock, linkBySecret, type Link } from '../petpooja.ts'
import { applyStatus } from '../order-status.ts'

/**
 * The five endpoints Petpooja calls on us.
 *
 * Their documentation gives these no authentication of any kind — a POST with
 * a restID in the body, and whoever knows the restID can push a menu or
 * cancel an order. A restID is six digits printed on the restaurant's own
 * paperwork, so that is not a secret and cannot be treated as one.
 *
 * The secret is therefore the URL. Each restaurant gets its own random
 * webhook path, generated when the link is made and handed to Petpooja during
 * setup, and the path is what identifies the restaurant — the restID in the
 * body is checked against it and a mismatch is refused. Nothing here trusts a
 * payload to say who it is about.
 *
 * Mounted before the API's no-store header and outside every auth middleware,
 * because the caller is a machine in Ahmedabad with no session.
 */
export const petpoojaRouter = Router()

/** Resolves the restaurant from the URL, or answers the way their docs do. */
function linkFrom(req: any, res: any): Link | null {
  const link = linkBySecret(String(req.params.secret ?? ''))
  if (!link || !link.enabled) {
    res.status(404).json({ success: '0', message: 'Unknown endpoint.' })
    return null
  }
  /* A payload naming a different restaurant than the URL is either a
     misconfiguration at their end or somebody poking at ours. Neither should
     be allowed to write to a menu. */
  const claimed = String(req.body?.restID ?? req.body?.restaurantid ?? '').trim()
  if (claimed && claimed !== link.restId) {
    res.status(403).json({ success: '0', message: 'restID does not match this endpoint.' })
    return null
  }
  return link
}

/**
 * Push Menu.
 *
 * The restaurant edits a dish on their till and it is on Khapee seconds
 * later. This is the endpoint that makes menus stop being something anybody
 * types twice — and, for a Petpooja restaurant, makes the menu editor in our
 * dashboard read-only by nature rather than by rule, because the till is the
 * source of truth and the till is where they already work.
 */
petpoojaRouter.post('/:secret/menu', (req: any, res) => {
  const link = linkFrom(req, res)
  if (!link) return
  try {
    // Kept whole, for certification — see the column's note in server/db.ts.
    db.prepare('UPDATE petpooja_links SET last_menu_json = ? WHERE id = ?').run(
      JSON.stringify(req.body ?? {}),
      link.id,
    )
    /*
     * A sandbox push is recorded and not applied. Petpooja's test restaurant
     * sells rice bowls and momos; the cafe this link hangs off sells neither,
     * and its menu is on the internet being read. Answering success is honest
     * — the push arrived and was understood — and the payload is kept, which
     * is the only thing certification actually needs from it.
     */
    if (link.sandbox) {
      const n = Array.isArray((req.body ?? {}).items) ? (req.body as any).items.length : 0
      db.prepare("UPDATE petpooja_links SET last_menu_at = datetime('now'), last_error = '' WHERE id = ?").run(link.id)
      return res.json({ success: '1', message: `Menu received: ${n} items recorded for certification.` })
    }
    const result = applyMenuPush(link, req.body ?? {})
    res.json({
      success: '1',
      message: `Menu updated: ${result.items} items, ${result.categories} new sections, ${result.retired} taken off.`,
    })
  } catch (e: any) {
    db.prepare('UPDATE petpooja_links SET last_error = ? WHERE id = ?').run(String(e?.message ?? e).slice(0, 400), link.id)
    res.status(400).json({ success: '0', message: 'Menu could not be applied.' })
  }
})

/**
 * The last sandbox push, read back.
 *
 * Certification has to quote Petpooja's own item, add-on and variation ids,
 * and the only copy of them is whatever their Menu Trigger delivered to the
 * endpoint above. The dashboard would be the obvious place to read it, except
 * that nobody can sign in to this cafe yet, which is the circumstance this
 * whole sandbox link was pinned for in the first place.
 *
 * Only ever a sandbox link: a real cafe's menu, with the POS ids that address
 * its till, is not something a URL in a git repository should hand out.
 */
petpoojaRouter.get('/:secret/last-menu', (req: any, res) => {
  const link = linkFrom(req, res)
  if (!link) return
  if (!link.sandbox) return res.status(403).json({ success: '0', message: 'Not a sandbox link.' })
  const row = db.prepare('SELECT last_menu_json, last_menu_at FROM petpooja_links WHERE id = ?').get(link.id) as any
  if (!row?.last_menu_json) {
    return res.json({ success: '0', message: 'No menu has been pushed to this endpoint yet.' })
  }
  res.type('application/json').send(row.last_menu_json)
})

/**
 * Item in stock / out of stock.
 *
 * One endpoint for both, which is what their own documentation recommends:
 * the inStock field is the difference, and two endpoints that differ by a
 * boolean is two things to keep in step for no gain.
 */
petpoojaRouter.post('/:secret/item-stock', (req: any, res) => {
  const link = linkFrom(req, res)
  if (!link) return
  const ids = Array.isArray(req.body?.itemID) ? req.body.itemID.map(String) : []
  const inStock = req.body?.inStock === true || String(req.body?.inStock) === 'true'
  const changed = applyStock(link, ids, inStock)
  res.json({
    code: 200,
    status: 'success',
    message: changed ? 'Stock status updated successfully' : 'Nothing matched, but the request was understood',
  })
})

/** Is the store taking orders on Khapee right now. */
petpoojaRouter.post('/:secret/store-status', (req: any, res) => {
  const link = linkFrom(req, res)
  if (!link) return
  const row = db.prepare('SELECT is_open FROM restaurants WHERE id = ?').get(link.restaurantId) as any
  res.json({
    http_code: 200,
    status: 'success',
    store_status: row?.is_open ? '1' : '0',
    message: 'Store Delivery Status fetched successfully',
  })
})

/**
 * Open or close Khapee from the till.
 *
 * The one place the restaurant is already standing when they decide to stop
 * taking orders is their own POS, so this has to work — otherwise Khapee
 * keeps accepting orders for a kitchen that has shut, which is the worst
 * failure this product has.
 */
petpoojaRouter.post('/:secret/store-status/update', (req: any, res) => {
  const link = linkFrom(req, res)
  if (!link) return
  const open = Number(req.body?.store_status) === 1
  db.prepare('UPDATE restaurants SET is_open = ? WHERE id = ?').run(open ? 1 : 0, link.restaurantId)
  res.json({ http_code: 200, status: 'success', message: `Store Status updated successfully for store ${link.restId}` })
})

/**
 * Order callback — the restaurant's answer, coming back.
 *
 * A customer watching the tracking page sees the tick the moment somebody
 * presses Accept on the till. Nothing else in the product does this: every
 * other route to "accepted" goes through Khapee's own dashboard, and a
 * kitchen that lives in Petpooja never opens it.
 */
petpoojaRouter.post('/:secret/callback', (req: any, res) => {
  const link = linkFrom(req, res)
  if (!link) return
  const orderNumber = String(req.body?.orderID ?? '')
  const status = String(req.body?.status ?? '')
  const decided = applyCallback(link, orderNumber, status, String(req.body?.cancel_reason ?? ''))
  /* An order Khapee never placed — the certification orders sent straight to
     their sandbox by scripts/petpooja-certify.ts — is acknowledged rather than
     refused: there is nothing here to move, and answering an error to a
     callback that did its job fails their callback test for no reason. */
  if (!decided.ok && decided.error === 'No such order') {
    return res.json({ success: '1', message: 'Callback received; no matching Khapee order' })
  }
  if (!decided.ok) return res.status(400).json({ success: '0', message: decided.error })

  // Through the ordinary status machinery, so the event log, the live stream
  // and the customer's push notification all behave exactly as they do when a
  // person presses the button in our own dashboard.
  const moved = applyStatus(decided.orderId!, decided.status as any, 'petpooja', decided.reason, { catchUp: true })
  if (!moved.ok) return res.status(400).json({ success: '0', message: moved.error })
  res.json({ success: '1', message: 'Callback received successfully' })
})
