import { Router } from 'express'
import { optionsFor, priceLine } from '../menu-options.ts'
import { db } from '../db.ts'
import { pushConfigured, pushPublicKey, pushReason, saveCustomerSubscription } from '../push.ts'
import crypto from 'node:crypto'
import { createSession, hashPassword, requireAuth, userFromToken } from '../auth.ts'
import { checkAccessCode, createOrder, customerAgrees, getOrder, payOrderByUpi, shapeOrder } from '../orders-service.ts'
import { cardToSpend, customerKey, discountFor, scratch as scratchCard } from '../scratch.ts'
import { normalizeCode } from '../ids.ts'
import { claimedCents, outstandingCents, upiLink } from '../payments.ts'
import { sessionByToken } from '../dining.ts'
import { money } from '../../shared/orders.ts'
import { pushOrder } from '../petpooja.ts'
import { limitedState } from '../limited.ts'
import { pushToRestaurant } from '../push.ts'
import { publish } from '../events.ts'
import { checkCode, discountOn, newCode, offerFor, passEmail, qualifyingEmail } from '../offers.ts'
import { mailConfigured, sendMail } from '../mail.ts'
import { mailboxExists } from '../mailbox.ts'
import { bounced } from '../bounce.ts'

export const ordersRouter = Router()

/** Pre-flight check so the customer learns a code is bad before building an order. */
ordersRouter.post('/verify-code', (req, res) => {
  const restaurantId = Number(req.body?.restaurantId)
  const code = normalizeCode(req.body?.code)
  if (!restaurantId) return res.status(400).json({ error: 'Pick a restaurant first.' })
  if (code.length !== 6) return res.status(400).json({ error: 'Access codes are 6 characters, like K7X92P.' })

  const check = checkAccessCode(code, restaurantId)
  if (!check.ok) return res.status(400).json({ error: check.message, reason: check.reason })

  const expiresAt = db
    .prepare(`SELECT strftime('%s', expires_at) - strftime('%s','now') AS seconds FROM access_codes WHERE id = ?`)
    .get(check.row.id) as any
  res.json({ ok: true, code, secondsLeft: Math.max(0, Number(expiresAt?.seconds ?? 0)) })
})

ordersRouter.get('/tables/:restaurantId', (req, res) => {
  const restaurantId = Number(req.params.restaurantId)
  const rows = db
    .prepare('SELECT id, label, seats FROM restaurant_tables WHERE restaurant_id = ? ORDER BY id')
    .all(restaurantId) as any[]
  res.json({ tables: rows })
})

/** Everything the checkout needs to know about paying this restaurant. */
ordersRouter.get('/payment-options/:restaurantId', (req, res) => {
  const r = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(Number(req.params.restaurantId)) as any
  if (!r) return res.status(404).json({ error: 'That restaurant no longer exists.' })
  res.json({
    acceptsUpi: !!String(r.upi_vpa ?? '').trim(),
    payeeName: r.upi_name || r.name,
    acceptsPickup: !!r.accepts_pickup,
    acceptsTakeaway: !!r.accepts_takeaway,
    acceptsGroups: !!r.accepts_groups,
    /*
     * Half open. The checkout needs this before it draws the payment choice,
     * or it offers "pay at the restaurant" on an order the server is about to
     * refuse for exactly that reason. See server/limited.ts.
     */
    prepaidOnly: limitedState(Number(req.params.restaurantId)).on,
    /** Whether a typed code is offered beside the scanner. */
    codesEnabled: r.codes_enabled === undefined ? true : !!r.codes_enabled,
    /** This restaurant takes no cash at all, in any mode. */
    cashDisabled: !!r.cash_disabled && !!String(r.upi_vpa ?? '').trim(),
    /** Whether an order carried out to a car has to be paid for first. */
    carPrepaidOnly: !!r.car_prepaid_only,
    /** And the same for one collected from the counter. */
    takeawayPrepaidOnly: !!r.takeaway_prepaid_only,
    /*
     * Ordered ahead and collected, and nothing else: no tables, no car, no
     * carrying out from a seat. The checkout then stops offering a way to
     * change how it is ordered, or a table to choose on arrival.
     */
    collectOnly:
      !!r.accepts_pickup &&
      !r.accepts_car &&
      // No eating in: switched off outright, or no tables and no carry-out.
      (r.accepts_dine_in === 0 ||
        (!r.accepts_takeaway && !db.prepare('SELECT 1 FROM restaurant_tables WHERE restaurant_id = ? LIMIT 1').get(r.id))),
  })
})

/** Builds a UPI request for a cart before the order exists. */
/**
 * Proving an address for the offer: a code sent to it, then typed back.
 * Says plainly when email is not switched on, rather than pretending to send.
 */
ordersRouter.post('/offer/:restaurantId/send-code', async (req, res) => {
  const offer = offerFor(Number(req.params.restaurantId))
  const email = qualifyingEmail(offer, req.body?.email)
  if (!offer) return res.status(404).json({ error: 'There is no offer here.' })
  if (!email) return res.status(400).json({ error: `Enter your @${offer.domain} email.` })
  // A made-up address is told so, before a code is sent into nothing.
  if ((await mailboxExists(email)) === 'no') {
    return res.status(404).json({ error: `That email isn't available — there's no ${email} account. Check for typos.` })
  }
  if (!mailConfigured()) return res.status(503).json({ error: 'Email codes are not switched on yet.' })
  const made = newCode(email)
  if (!made.ok) return res.status(429).json({ error: made.error })
  const restaurant = db.prepare('SELECT name FROM restaurants WHERE id = ?').get(Number(req.params.restaurantId)) as any
  const sent = await sendMail({
    to: email,
    subject: `${made.code} is your ${restaurant?.name ?? 'Khapee'} code`,
    text:
      `Your code is ${made.code}\n\n` +
      `Type it on Khapee to unlock ${offer.percent}% off${offer.label ? ` (${offer.label})` : ''} at ${restaurant?.name ?? 'the café'}.\n` +
      `It works for 15 minutes. If you didn't ask for it, ignore this email.\n\n— Khapee`,
  })
  if (sent !== 'sent') return res.status(502).json({ error: 'The email could not be sent. Try again in a minute.' })
  // Google sends back "address not found" within seconds when the mailbox
  // does not exist. The code box opens straight away; this watches for the
  // bounce in the background, and the checkout asks how it went (code-status).
  bounceWatch.set(email, 'checking')
  void bounced(email).then((b) => bounceWatch.set(email, b ? 'bounced' : 'fine'))
  res.json({ ok: true })
})

/** What became of the last code sent to an address: still checking, fine, or bounced. */
const bounceWatch = new Map<string, 'checking' | 'fine' | 'bounced'>()
ordersRouter.get('/offer/:restaurantId/code-status', (req, res) => {
  const offer = offerFor(Number(req.params.restaurantId))
  const email = qualifyingEmail(offer, req.query.email)
  const status = email ? (bounceWatch.get(email) ?? 'fine') : 'fine'
  res.json(
    status === 'bounced'
      ? { status, error: `That email isn't available — there's no ${email} account. Check for typos.` }
      : { status },
  )
})

ordersRouter.post('/offer/:restaurantId/check-code', (req, res) => {
  const offer = offerFor(Number(req.params.restaurantId))
  const email = qualifyingEmail(offer, req.body?.email)
  if (!offer || !email) return res.status(400).json({ error: 'Enter your email again.' })
  const checked = checkCode(email, String(req.body?.code ?? ''))
  if (!checked.ok) return res.status(400).json({ error: checked.error })
  res.json({ pass: checked.pass, email })
})

/** The offer at a restaurant, for the menu and the checkout to show. */
ordersRouter.get('/offer/:restaurantId', (req, res) => {
  const offer = offerFor(Number(req.params.restaurantId))
  res.json({
    offer: offer ? { domain: offer.domain, percent: offer.percent, label: offer.label, codesOn: mailConfigured() } : null,
  })
})

ordersRouter.post('/payment-request', (req, res) => {
  const restaurantId = Number(req.body?.restaurantId)
  const r = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(restaurantId) as any
  if (!r) return res.status(404).json({ error: 'That restaurant no longer exists.' })
  if (!String(r.upi_vpa ?? '').trim()) {
    return res.status(409).json({ error: `${r.name} has not set up UPI. Please pay at the counter.`, payAtCounter: true })
  }
  const lines = Array.isArray(req.body?.items) ? req.body.items : []
  let amountCents = 0
  const dishOptions = optionsFor(lines.map((l: any) => Number(l?.menuItemId)).filter(Number.isFinite))
  for (const line of lines) {
    const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(Number(line?.menuItemId)) as any
    if (!item || item.restaurant_id !== restaurantId) {
      return res.status(400).json({ error: 'One of the items is no longer on this menu.' })
    }
    // Priced with its variation and add-ons, exactly as the order will be.
    const chosen = priceLine(item, line, dishOptions.get(item.id))
    if (!chosen.ok) return res.status(409).json({ error: chosen.error })
    amountCents += chosen.unitPriceCents * Math.max(1, Math.floor(Number(line.quantity) || 1))
  }
  if (amountCents <= 0) return res.status(400).json({ error: 'Your cart is empty.' })
  // The offer comes off the dishes before anything is asked for, so the UPI
  // request is for what the order will actually come to.
  const dishesCents = amountCents
  const offer = req.body?.applyOffer ? offerFor(restaurantId) : null
  const offerOk = !!(passEmail(offer, req.body?.offerPass) ?? qualifyingEmail(offer, (req as any).user?.verifiedEmail))
  const offerCents = offerOk && offer ? discountOn(dishesCents, offer.percent) : 0

  // What the customer is actually charged, not just what the dishes cost.
  // This summed the menu lines alone, so a delivery quoted at ₹480 in the
  // checkout asked their UPI app for ₹450 and left the restaurant carrying the
  // fee it had just told them about.
  /*
   * A scratch card comes off before the amount is asked for.
   *
   * Worked out from the same function createOrder uses, so the figure in the
   * UPI request is the figure the order will record. Without this the customer
   * is shown a discounted total on the checkout, asked for the full amount by
   * their bank, and the order goes in saying ₹10 came off — three numbers,
   * one of them money that was actually taken.
   *
   * On the food, before the delivery fee, exactly as the order does it.
   */
  const payerKey = customerKey(req.user?.id ?? null, String(req.body?.customerPhone ?? req.body?.phone ?? ''))
  const held = payerKey ? cardToSpend(restaurantId, payerKey, dishesCents) : null
  // One discount, never both — the bigger — exactly as createOrder decides it.
  amountCents = Math.max(0, dishesCents - Math.max(offerCents, held ? discountFor(held, dishesCents) : 0))

  const session = req.body?.sessionToken ? sessionByToken(String(req.body.sessionToken)) : null
  if (session && session.restaurant_id === restaurantId && session.service_mode === 'delivery' && session.area_id) {
    const area = db
      .prepare('SELECT * FROM delivery_areas WHERE id = ? AND restaurant_id = ?')
      .get(session.area_id, restaurantId) as any
    if (area) {
      // No point taking money for an order the kitchen will turn away.
      if (amountCents < area.min_order_cents) {
        return res.status(400).json({
          error: `${area.name} has a ${money(area.min_order_cents)} minimum — add ${money(area.min_order_cents - amountCents)} more.`,
        })
      }
      amountCents += area.fee_cents
    }
  }

  /*
   * The reference the customer sees in their bank app, and the restaurant in
   * their UPI statement. It carried TABLO — the name this app had two names
   * ago — into every payment made on it. The TABLO and ORDRO spellings
   * elsewhere are deliberate: they read QR codes printed under the old names,
   * and those stickers are still on real tables. This one is generated fresh
   * every time and parsed by nobody, so there is nothing to be compatible with.
   */
  const ref = `KHAPEE${Date.now().toString(36).toUpperCase()}`
  res.json({
    amountCents,
    vpa: r.upi_vpa,
    payeeName: r.upi_name || r.name,
    reference: ref,
    upiLink: upiLink({
      vpa: r.upi_vpa,
      name: r.upi_name || r.name,
      amountCents,
      // The customer's name on the payment, so the restaurant can match it in
      // its own UPI app without a reference number.
      note: String(req.body?.customerName ?? '').trim()
        ? `${r.name} · ${String(req.body.customerName).trim().slice(0, 30)}`
        : `${r.name} order`,
    }),
  })
})

/**
 * The first order is the sign-up. Somebody not signed in has just typed their
 * name and number to order; that becomes an account and this phone stays
 * signed in to it, so there is never a login screen to get through. The
 * number is not checked — it is what the order already trusted — so the
 * account is new for this phone, never somebody else's found by number.
 */
function quickAccount(order: any, body: any): { token: string; user: any } | null {
  const name = String(body.customerName ?? '').trim().slice(0, 60)
  const phone = String(body.contactPhone ?? '').replace(/\D/g, '').slice(-10)
  if (name.length < 2 || phone.length < 10 || !order?.id) return null
  try {
    const email = `phone-${crypto.randomBytes(8).toString('hex')}@guest.khapee.com`
    const info = db
      .prepare(`INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'customer')`)
      .run(name, email, phone, hashPassword(crypto.randomBytes(24).toString('hex')))
    const userId = Number(info.lastInsertRowid)
    db.prepare('UPDATE orders SET user_id = ? WHERE id = ? AND user_id IS NULL').run(userId, order.id)
    const token = createSession(userId)
    return { token, user: userFromToken(token) }
  } catch (err) {
    console.error('[quick account]', err)
    return null
  }
}

ordersRouter.post('/', (req, res) => {
  const body = req.body ?? {}
  const result = createOrder({
    restaurantId: Number(body.restaurantId),
    type: body.type === 'pickup' ? 'pickup' : 'dine_in',
    items: Array.isArray(body.items) ? body.items : [],
    customerName: String(body.customerName ?? req.user?.name ?? '').trim(),
    contactPhone: String(body.contactPhone ?? '').trim(),
    // A customer ordering for themselves has to be reachable; a counter sale
    // does not, which is why this is set here and not inside createOrder.
    requirePhone: true,
    fromCustomer: true,
    userId: req.user?.id ?? null,
    note: body.note,
    paymentMethod: body.paymentMethod,
    accessCode: body.accessCode ? normalizeCode(body.accessCode) : null,
    tableToken: body.tableToken ?? null,
    tableId: body.tableId ? Number(body.tableId) : null,
    takeaway: !!body.takeaway,
    sessionToken: body.sessionToken ?? null,
    paymentClaim: body.paymentClaim ?? null,
    // The pre-order. Minutes from now, because the server owns the clock.
    wantInMinutes: body.wantInMinutes === undefined ? null : Number(body.wantInMinutes),
    applyOffer: !!body.applyOffer,
    offerPass: body.offerPass ?? null,
  })
  if (!result.ok) return res.status(result.status).json({ error: result.error })
  res.status(201).json({ order: result.order, session: req.user ? null : quickAccount(result.order, body) })

  /*
   * And, for a kitchen that runs Petpooja, onto their till.
   *
   * After the response, deliberately. The customer's order is already safe in
   * Khapee at this point, and nothing about whether a Windows machine in the
   * back answers in the next twelve seconds should be allowed to change what
   * they are told. A push that fails records why against the order and the
   * order carries on existing exactly as it did before any of this.
   */
  //
  // Not at a UPI-only restaurant: there the order goes to the till when staff
  // accept it, which is when they have seen the money (routes/staff.ts).
  if (!result.order.upiOnly) void pushOrder(result.order.id, originOf(req)).catch(() => {})
})

/** The host this request actually came in on, so webhooks point back here. */
function originOf(req: any): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0]
  return `${proto}://${req.get('host')}`
}

/** Customer order history for a signed-in account. */
ordersRouter.get('/mine', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT o.*, r.name AS restaurant_name, r.emoji AS restaurant_emoji, r.hue AS restaurant_hue,
              r.slug AS restaurant_slug, r.prep_minutes
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 50`,
    )
    .all(req.user!.id) as any[]
  res.json({ orders: rows.map(shapeOrder) })
})

/** The half of the keypair a customer's browser needs in order to subscribe. */
ordersRouter.get('/notify-key', (_req, res) => {
  res.json({ available: pushConfigured(), publicKey: pushPublicKey() })
})

/**
 * Order lookup for the receipt / tracking screen.
 * Guests pass the verify token they were handed at checkout; owners are matched by session.
 */
ordersRouter.get('/:orderNumber', (req, res) => {
  const orderNumber = String(req.params.orderNumber).replace('#', '').toUpperCase()
  const row = db
    .prepare('SELECT id, user_id, verify_token, restaurant_id FROM orders WHERE order_number = ?')
    .get(orderNumber) as any
  if (!row) return res.status(404).json({ error: 'We could not find that order.' })

  const token = String(req.query.token ?? '')
  const isOwner = req.user && row.user_id === req.user.id
  /**
   * Working here is a membership, not a job title on the account.
   *
   * `role` is set once when an address registers and is never revised, so
   * somebody who ordered a coffee before they took over a café reads as
   * 'customer' forever — and this refused them their own restaurant's orders.
   * It also said yes to staff at any other restaurant on Khapee, which is the
   * same mistake pointing the other way. The question is whether this person
   * works at the place that took this order.
   */
  const isStaffHere =
    !!req.user &&
    !!db
      .prepare('SELECT 1 FROM restaurant_staff WHERE user_id = ? AND restaurant_id = ?')
      .get(req.user.id, row.restaurant_id)
  if (!isOwner && !isStaffHere && token !== row.verify_token) {
    return res.status(403).json({ error: 'That order belongs to someone else.' })
  }
  res.json({ order: getOrder(row.id) })
})

/**
 * The customer's phone asking to be told about their own order.
 *
 * Proved the same way the order page itself is: the receipt token they were
 * handed at checkout, or being signed in as whoever placed it. No account
 * needed, because almost nobody ordering a coffee makes one.
 *
 * This is the free channel. A WhatsApp message to somebody who has not
 * messaged you first is billed per order by Meta; a push notification costs
 * nothing, now or ever, and goes through the browser the customer already has.
 */
/** Proves the person asking is the one who placed it. */
function ownsOrder(req: any, row: any): boolean {
  const token = String(req.body?.token ?? req.query.token ?? '')
  return (req.user && row.user_id === req.user.id) || token === row.verify_token
}

/**
 * "They can't make one thing — go ahead with the rest."
 *
 * The other half of a kitchen turning down a single dish. Until the customer
 * answers this, the order sits saying so on both screens; answering it puts
 * the order back where it was, waiting on the kitchen, with fewer dishes and
 * a total that already matches.
 */
ordersRouter.post('/:orderNumber/agree', (req, res) => {
  const orderNumber = String(req.params.orderNumber).replace('#', '').toUpperCase()
  const row = db
    .prepare('SELECT id, user_id, verify_token FROM orders WHERE order_number = ?')
    .get(orderNumber) as any
  if (!row) return res.status(404).json({ error: 'We could not find that order.' })
  if (!ownsOrder(req, row)) return res.status(403).json({ error: 'That order belongs to someone else.' })
  const r = customerAgrees(row.id)
  if (!r.ok) return res.status(400).json({ error: r.error })
  res.json({ order: r.order })
})

/**
 * The UPI request for an order that already exists — for whatever is still
 * owed on it. Used when the kitchen asks for payment before a car order goes
 * ahead.
 */
ordersRouter.post('/:orderNumber/payment-request', (req, res) => {
  const orderNumber = String(req.params.orderNumber).replace('#', '').toUpperCase()
  const row = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber) as any
  if (!row) return res.status(404).json({ error: 'We could not find that order.' })
  if (!ownsOrder(req, row)) return res.status(403).json({ error: 'That order belongs to someone else.' })
  const r = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(row.restaurant_id) as any
  if (!String(r?.upi_vpa ?? '').trim()) {
    return res.status(409).json({ error: `${r?.name ?? 'The restaurant'} has not set up UPI.` })
  }
  const amountCents = outstandingCents(row.id)
  if (amountCents <= 0) return res.status(409).json({ error: 'This order is already paid for.' })
  const ref = `KHAPEE${row.order_number}`
  res.json({
    amountCents,
    vpa: r.upi_vpa,
    payeeName: r.upi_name || r.name,
    reference: ref,
    upiLink: upiLink({ vpa: r.upi_vpa, name: r.upi_name || r.name, amountCents, note: `${r.name} #${row.order_number}` }),
  })
})

/** "I've paid" — the UPI reference for an order that already exists. */
/**
 * Rub off the card won on an order.
 *
 * The prize was drawn and written down when the order was placed, so there is
 * nothing to decide here and nothing a caller can lean on — this only records
 * that the customer has seen it. Asking twice gives the same answer, because a
 * phone that lost the first reply still has a card and should not be told it
 * has lost it.
 */
ordersRouter.post('/:orderNumber/scratch', (req, res) => {
  const orderNumber = String(req.params.orderNumber).replace('#', '').toUpperCase()
  const row = db.prepare('SELECT id, user_id, verify_token FROM orders WHERE order_number = ?').get(orderNumber) as any
  if (!row) return res.status(404).json({ error: 'We could not find that order.' })
  if (!ownsOrder(req, row)) return res.status(403).json({ error: 'That order belongs to someone else.' })
  const card = scratchCard(Number(req.body?.cardId), row.id)
  if (!card) return res.status(404).json({ error: 'There is no card on that order.' })
  res.json({ card })
})

/**
 * What a scratch card would take off a basket, before it is ordered.
 *
 * So the checkout can show the saving while the customer is still deciding,
 * rather than springing it on them at the end. Priced from the menu here, the
 * same way the order will be, because a quote worked out from numbers the
 * client sent is a quote the client wrote.
 */
ordersRouter.post('/scratch-quote', (req, res) => {
  const restaurantId = Number(req.body?.restaurantId)
  const key = customerKey(req.user?.id ?? null, String(req.body?.phone ?? ''))
  if (!key) return res.json({ card: null, discountCents: 0 })

  let subtotalCents = 0
  for (const line of Array.isArray(req.body?.items) ? req.body.items : []) {
    const item = db.prepare('SELECT price_cents, restaurant_id FROM menu_items WHERE id = ?').get(Number(line?.menuItemId)) as any
    if (!item || item.restaurant_id !== restaurantId) continue
    subtotalCents += item.price_cents * Math.max(1, Math.floor(Number(line?.quantity) || 1))
  }
  const card = cardToSpend(restaurantId, key, subtotalCents)
  res.json({ card, discountCents: card ? discountFor(card, subtotalCents) : 0 })
})

ordersRouter.post('/:orderNumber/pay', (req, res) => {
  const orderNumber = String(req.params.orderNumber).replace('#', '').toUpperCase()
  const row = db.prepare('SELECT id, user_id, verify_token, restaurant_id FROM orders WHERE order_number = ?').get(orderNumber) as any
  if (!row) return res.status(404).json({ error: 'We could not find that order.' })
  if (!ownsOrder(req, row)) return res.status(403).json({ error: 'That order belongs to someone else.' })
  const r = payOrderByUpi(row.id, String(req.body?.upiRef ?? ''))
  if (!r.ok) return res.status(r.status ?? 400).json({ error: r.error })
  publish('order:update', { restaurantId: row.restaurant_id, orderId: row.id, order: r.order })
  publish('orders', { restaurantId: row.restaurant_id })
  res.json({ order: r.order })
})

/**
 * "Then don't bother."
 *
 * The other answer to a refused dish, and the only route a customer has to
 * call off their own order. Deliberately narrow: only while the kitchen has
 * not started, and never once money has been claimed against it, because a
 * cancellation that leaves a payment behind is a refund nobody has recorded.
 */
ordersRouter.post('/:orderNumber/cancel', (req, res) => {
  const orderNumber = String(req.params.orderNumber).replace('#', '').toUpperCase()
  const row = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber) as any
  if (!row) return res.status(404).json({ error: 'We could not find that order.' })
  if (!ownsOrder(req, row)) return res.status(403).json({ error: 'That order belongs to someone else.' })

  // Any order — table, pickup, car or delivery — until the restaurant says
  // yes. Once it has, food may already be on its way to the pan, and calling
  // it off is a conversation, not a tap.
  if (!['REQUESTED', 'NEW'].includes(row.status)) {
    return res.status(409).json({
      error: 'The restaurant has already accepted this order, so it can’t be cancelled here — please ring them.',
    })
  }
  // Sent by UPI counts: the money has left their bank either way.
  if (row.payment_status === 'PAID' || claimedCents(row.id) > 0) {
    return res.status(409).json({
      error: 'This order is paid for, so it has to be cancelled by the restaurant — they will refund you.',
    })
  }

  db.prepare(
    `UPDATE orders SET status = 'CANCELLED', needs_customer_ok = NULL, needs_prepay = NULL,
            declined_reason = 'Cancelled by the customer', updated_at = datetime('now')
      WHERE id = ?`,
  ).run(row.id)
  db.prepare("INSERT INTO order_events (order_id, status, actor) VALUES (?, 'CANCELLED', 'customer')").run(row.id)
  // Told, not left to notice: a kitchen that has not looked at the board yet
  // should not start on something nobody is coming for.
  db.prepare('INSERT INTO notifications (restaurant_id, order_id, title, body) VALUES (?, ?, ?, ?)').run(
    row.restaurant_id,
    row.id,
    `#${row.order_number} cancelled by the customer`,
    `${row.customer_name || 'The customer'} called it off before it was accepted.`,
  )
  void pushToRestaurant(row.restaurant_id, {
    title: `#${row.order_number} was cancelled`,
    body: `${row.customer_name || 'The customer'} cancelled before you accepted it — nothing to make.`,
    url: '/staff/orders',
    tag: `order-${row.order_number}`,
  }).catch(() => {})
  publish('order:update', { restaurantId: row.restaurant_id, orderId: row.id, order: getOrder(row.id) })
  publish('orders', { restaurantId: row.restaurant_id })
  res.json({ order: getOrder(row.id) })
})

/**
 * "I'm here."
 *
 * The last step of ordering before you set off, and the one the counter most
 * wants to hear. Two things happen at once, because for the customer they are
 * one thing: the restaurant is told the person is in the building, and the
 * person says whether they are taking it with them or sitting down.
 *
 * That choice is deliberately made here rather than at checkout. Nobody
 * standing in their own kitchen twenty minutes away knows whether there will
 * be a free table when they arrive, and forcing a guess gets it wrong often
 * enough to matter: a cup in a paper bag for somebody who wanted to sit down,
 * or a tray for somebody already late.
 *
 * Only after the kitchen has agreed to make it. Announcing yourself for an
 * order nobody has accepted tells a counter about somebody they cannot serve.
 */
ordersRouter.post('/:orderNumber/arrived', (req, res) => {
  const orderNumber = String(req.params.orderNumber).replace('#', '').toUpperCase()
  const row = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber) as any
  if (!row) return res.status(404).json({ error: 'We could not find that order.' })
  if (!ownsOrder(req, row)) return res.status(403).json({ error: 'That order belongs to someone else.' })

  if (['CANCELLED', 'DECLINED'].includes(row.status)) {
    return res.status(409).json({ error: 'This order is not going ahead.' })
  }
  if (row.status === 'REQUESTED' || row.status === 'NEW') {
    return res.status(409).json({
      error: 'They have not accepted this order yet. You will see a tick here the moment they do.',
    })
  }

  const choice = String(req.body?.choice ?? '') === 'dine_in' ? 'dine_in' : 'takeaway'

  /*
   * Sitting down turns a collection into a table order, so the kitchen sends
   * the food to a table rather than leaving it on the pass with a name on it.
   * A table is optional: plenty of cafes seat people themselves, and refusing
   * the arrival for want of a table number would be refusing the one message
   * that matters.
   */
  let tableId: number | null = null
  let tableLabel: string | null = null
  if (choice === 'dine_in' && req.body?.tableId) {
    const table = db
      .prepare('SELECT id, label FROM restaurant_tables WHERE id = ? AND restaurant_id = ?')
      .get(Number(req.body.tableId), row.restaurant_id) as any
    if (!table) return res.status(400).json({ error: 'That table is not at this restaurant.' })
    tableId = table.id
    tableLabel = table.label
  }

  db.prepare(
    `UPDATE orders
        SET arrived_at = datetime('now'), arrival_choice = ?,
            table_id = COALESCE(?, table_id), table_label = COALESCE(?, table_label),
            service_mode = ?, takeaway = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(choice, tableId, tableLabel, choice === 'dine_in' ? 'dine_in' : 'takeaway', choice === 'dine_in' ? 0 : 1, row.id)

  const order = getOrder(row.id)
  publish('order:update', { restaurantId: row.restaurant_id, userId: row.user_id, orderId: row.id, order })
  publish('orders', { restaurantId: row.restaurant_id })

  // And on the counter's phone, because this is news whether or not anybody
  // is looking at the board.
  void pushToRestaurant(row.restaurant_id, {
    title: `${row.customer_name || 'A customer'} has arrived`,
    body: `#${row.order_number} · ${choice === 'dine_in' ? (tableLabel ? `eating in · ${tableLabel}` : 'eating in') : 'taking it away'}`,
    url: '/staff/orders',
    tag: `arrived-${row.id}`,
  }).catch(() => {})

  res.json({ order })
})

/**
 * Nobody answered, so send it again.
 *
 * A restaurant that has not looked at an order for two minutes is, from the
 * customer's side, indistinguishable from one that never received it — and
 * the worst thing the app can do is leave somebody watching a spinner
 * wondering whether to ring. So after two minutes the tracking page offers
 * this: the same dishes, the same table, the same everything, sent again as a
 * new order.
 *
 * Rebuilding the basket by hand would be the obvious way to do it and the
 * wrong one. Nobody who has already chosen five things and paid attention to
 * a spinner for two minutes wants to be told to start over; the order is
 * copied, not retyped.
 *
 * The old one is cancelled in the same breath. Two live copies of the same
 * order is how a table gets two dinners and one bill, and the race is real —
 * a kitchen can press Accept while the customer is pressing this. Whoever
 * gets there first wins, and if the restaurant did, this refuses and says so
 * rather than cancelling an order that is already being cooked.
 */
ordersRouter.post('/:orderNumber/resend', (req, res) => {
  const orderNumber = String(req.params.orderNumber).replace('#', '').toUpperCase()
  const row = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber) as any
  if (!row) return res.status(404).json({ error: 'We could not find that order.' })
  if (!ownsOrder(req, row)) return res.status(403).json({ error: 'That order belongs to someone else.' })

  if (row.status !== 'REQUESTED' && row.status !== 'NEW') {
    return res.status(409).json({
      error:
        row.status === 'DECLINED'
          ? 'They could not take this one. Nothing was sent again.'
          : 'Good news — they answered just now. Your order is going ahead.',
      order: getOrder(row.id),
    })
  }
  if (row.resent_as) {
    return res.status(409).json({ error: 'This one was already sent again.', orderNumber: row.resent_as })
  }

  const items = db
    .prepare('SELECT menu_item_id, quantity FROM order_items WHERE order_id = ? AND (accepted IS NULL OR accepted = 1)')
    .all(row.id) as any[]
  if (!items.length) return res.status(409).json({ error: 'There is nothing on this order to send again.' })

  const again = createOrder({
    restaurantId: row.restaurant_id,
    type: row.order_type,
    items: items.map((i) => ({ menuItemId: i.menu_item_id, quantity: i.quantity })),
    customerName: row.customer_name,
    contactPhone: row.contact_phone,
    requirePhone: false,
    // Still the customer's own order, so every payment rule applies. Only the
    // phone is not asked for again — it is copied from the order being resent.
    fromCustomer: true,
    userId: row.user_id,
    note: row.note,
    // Deliberately not carried over: a claim of payment belongs to the order
    // it was made against, and copying one would tell the kitchen money had
    // arrived twice.
    tableId: row.table_id,
    takeaway: !!row.takeaway,
    // The same customer, so the same offer.
    applyOffer: !!row.offer_email,
  })
  if (!again.ok) return res.status(again.status).json({ error: again.error })

  db.prepare(
    `UPDATE orders SET status = 'CANCELLED', resent_as = ?, declined_reason = 'No answer — sent again',
            updated_at = datetime('now') WHERE id = ?`,
  ).run(again.order.orderNumber, row.id)
  db.prepare("INSERT INTO order_events (order_id, status, actor) VALUES (?, 'CANCELLED', 'customer')").run(row.id)
  publish('order:update', { restaurantId: row.restaurant_id, orderId: row.id, order: getOrder(row.id) })

  res.status(201).json({ order: again.order })
})

ordersRouter.post('/:orderNumber/notify', (req, res) => {
  const orderNumber = String(req.params.orderNumber).replace('#', '').toUpperCase()
  const row = db
    .prepare('SELECT id, user_id, verify_token FROM orders WHERE order_number = ?')
    .get(orderNumber) as any
  if (!row) return res.status(404).json({ error: 'We could not find that order.' })

  const token = String(req.body?.token ?? req.query.token ?? '')
  const isOwner = req.user && row.user_id === req.user.id
  if (!isOwner && token !== row.verify_token) {
    return res.status(403).json({ error: 'That order belongs to someone else.' })
  }
  if (!pushConfigured()) return res.status(503).json({ error: pushReason() })

  const saved = saveCustomerSubscription(row.id, req.body?.subscription ?? req.body)
  if (!saved.ok) return res.status(400).json({ error: saved.error })
  res.json({ ok: true })
})
