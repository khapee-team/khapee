import { db } from './db.ts'
import { addonsOf, optionsFor, priceLine, type ChosenAddon } from './menu-options.ts'
import { generateOrderNumber, randomToken } from './ids.ts'
import { publish } from './events.ts'
import { isTerminal, money, type OrderStatus, type OrderType, type ServiceType } from '../shared/orders.ts'
import { sessionByToken, sessionIsValid, startPaidSession } from './dining.ts'
import { openRoomForOrder } from './rooms.ts'
import { sendOrderConfirmation } from './whatsapp.ts'
import { alertRestaurant } from './alerts.ts'
import { askCustomer, askToPrepay } from './customer-notify.ts'
import { claimedCents, outstandingCents, upiOnly } from './payments.ts'
import { limitedRefusal, limitedState, orderableNow } from './limited.ts'
import { tellBilling } from './order-feed.ts'
import { cardForOrder, cardToSpend, customerKey, discountFor, maybeAward, spend } from './scratch.ts'
import { discountOn, offerFor, passEmail, qualifyingEmail } from './offers.ts'

export type CodeCheck =
  | { ok: true; row: any }
  | { ok: false; reason: 'not_found' | 'wrong_restaurant' | 'expired' | 'used' | 'revoked'; message: string }

export function checkAccessCode(code: string, restaurantId: number): CodeCheck {
  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code) as any
  if (!row) {
    return { ok: false, reason: 'not_found', message: "That code isn't valid. Ask a staff member for a new one." }
  }
  if (row.restaurant_id !== restaurantId) {
    return {
      ok: false,
      reason: 'wrong_restaurant',
      message: 'That code belongs to a different restaurant.',
    }
  }
  if (row.revoked_at) {
    return { ok: false, reason: 'revoked', message: 'That code was cancelled by staff.' }
  }
  const expired = db
    .prepare(`SELECT (expires_at <= datetime('now')) AS expired FROM access_codes WHERE id = ?`)
    .get(row.id) as any
  if (expired?.expired) {
    return { ok: false, reason: 'expired', message: 'That code has expired. Ask staff to generate a new one.' }
  }
  if (row.single_use && row.used_at) {
    return { ok: false, reason: 'used', message: 'That code has already been used. Ask staff for a fresh code.' }
  }
  return { ok: true, row }
}

export type CartLine = { menuItemId: number; quantity: number; variationId?: number | null; addonIds?: number[] }

export type CreateOrderInput = {
  restaurantId: number
  type: OrderType
  items: CartLine[]
  customerName: string
  /** Where the order updates go. Required on the customer's own path. */
  contactPhone?: string
  /**
   * Whether the order is refused without a reachable number. True for orders
   * a customer places themselves; false at the counter, where the person is
   * standing in front of the till and the till is the way to reach them.
   */
  requirePhone?: boolean
  userId: number | null
  note?: string
  paymentMethod?: 'counter' | 'app'
  accessCode?: string | null
  tableToken?: string | null
  tableId?: number | null
  /** Ordered at the restaurant but carried out — no table needed. */
  takeaway?: boolean
  /** An open dining session stands in for the code or table QR. */
  sessionToken?: string | null
  /** What the customer says they have already sent over UPI. */
  paymentClaim?: { amountCents?: number; upiRef?: string; method?: string } | null
  /**
   * Placed by a customer for themselves, as opposed to rung up by the
   * restaurant's own till.
   *
   * Every payment rule turns on this. It used to be read off `requirePhone`,
   * which happened to be true on the one route that mattered and false on a
   * resend — so a customer resending an unanswered order walked straight past
   * a restaurant's "UPI only". A flag that means what it says cannot drift
   * like that.
   */
  fromCustomer?: boolean
  /**
   * How many minutes from now the customer wants it ready. Absent or 0 means
   * as soon as possible, which is what every order was before this existed.
   *
   * Minutes rather than a timestamp on purpose: the customer is answering
   * "when will you be there", and a phone with a wrong clock — or one in
   * another timezone, which is most of the ones that scan a QR on holiday —
   * would otherwise order food for the middle of the night. The server owns
   * the clock and does the arithmetic.
   */
  wantInMinutes?: number | null
  /**
   * The customer pressed Apply on the restaurant's coupon. It counts only for a
   * signed-in account whose email qualifies (see server/offers.ts).
   */
  applyOffer?: boolean
  /** The pass from an emailed code (server/offers.ts). */
  offerPass?: string | null
}

/**
 * The furthest ahead an order can be placed.
 *
 * Not a policy about how restaurants should work; a guard against a typo or a
 * fiddled request booking the kitchen for next Tuesday. Six hours covers
 * ordering breakfast on the way out for lunch, which is the real limit of
 * what anybody does.
 */
const MAX_AHEAD_MINUTES = 6 * 60

export type CreateOrderResult = { ok: true; order: any } | { ok: false; status: number; error: string }

/**
 * The number the order can be reached on.
 *
 * Three places it can come from, in the order they are worth trusting: what
 * the customer just typed, what the session already collected (delivery and
 * the precinct both ask outright, because somebody has to be able to ring),
 * and the number on the account. A phone is how a kitchen says "we are out of
 * that" or "we cannot find you" — every other channel in the app assumes the
 * customer is still looking at their screen, and mostly they are not.
 */
function customerPhone(given: string | undefined, userId: number | null, sessionPhone: string): string {
  if (given && given.trim()) return given.trim()
  if (sessionPhone) return String(sessionPhone)
  if (!userId) return ''
  const row = db.prepare('SELECT phone FROM users WHERE id = ?').get(userId) as any
  return String(row?.phone ?? '')
}

/** Ten digits is a mobile number in India; anything shorter is a typo. */
function looksLikePhone(value: string): boolean {
  return value.replace(/\D/g, '').length >= 10
}

/**
 * Whether this order has to be paid for in the app before the kitchen sees it.
 *
 * Returns the reason when it does, so the customer is told which rule applied
 * rather than a generic refusal — "Revery takes UPI only" and "takeaway is
 * paid in the app" are different facts and a customer can act on each.
 *
 * Null whenever the restaurant has no UPI ID, whatever the switches say:
 * there is nothing to pay into, so insisting on it would just close the
 * restaurant. Null too for an order the restaurant's own till rang up, which
 * is where cash is actually handed over.
 */
export function mustPayInApp(
  input: CreateOrderInput,
  liveSession: any,
  restaurant: any,
): { reason: string } | null {
  if (input.paymentClaim) return null
  if (!input.fromCustomer) return null

  const r = db
    .prepare('SELECT cash_disabled, car_prepaid_only, upi_vpa FROM restaurants WHERE id = ?')
    .get(input.restaurantId) as any
  if (!String(r?.upi_vpa ?? '').trim()) return null

  if (r.cash_disabled) return { reason: `${restaurant.name} takes UPI only. Pay by UPI to place the order.` }

  if (liveSession?.service_mode === 'car' && r.car_prepaid_only) {
    return {
      reason: `${restaurant.name} takes payment in the app for orders brought out to your car. Pay by UPI to place the order.`,
    }
  }

  // Takeaway, both kinds: carried out from here, or collected later. Nobody is
  // sitting at a table the restaurant can walk up to, and a bag on a counter
  // that nobody comes for is thrown away.
  if (input.type === 'pickup' || input.takeaway) {
    return { reason: 'Takeaway is paid by UPI in the app. Pay by UPI to place the order.' }
  }

  return null
}

export function createOrder(input: CreateOrderInput): CreateOrderResult {
  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(input.restaurantId) as any
  if (!restaurant) return { ok: false, status: 404, error: 'That restaurant no longer exists.' }
  if (!restaurant.is_open) {
    return { ok: false, status: 409, error: `${restaurant.name} is closed right now and isn't taking orders.` }
  }

  const lines = (input.items ?? []).filter((l) => Number(l?.quantity) > 0)
  if (!lines.length) return { ok: false, status: 400, error: 'Your cart is empty.' }

  const customerName = String(input.customerName ?? '').trim()
  if (customerName.length < 2) return { ok: false, status: 400, error: 'Please enter a name for the order.' }

  if (input.type === 'pickup' && !restaurant.accepts_pickup) {
    return { ok: false, status: 409, error: `${restaurant.name} is not taking pickup orders right now.` }
  }
  const takeaway = input.type === 'dine_in' && !!input.takeaway
  // A place that does not serve Khapee orders at its tables.
  if (input.type === 'dine_in' && !takeaway && restaurant.accepts_dine_in === 0 && input.fromCustomer) {
    return { ok: false, status: 409, error: `${restaurant.name} takes Khapee orders for takeaway only.` }
  }
  if (takeaway && !restaurant.accepts_takeaway) {
    return { ok: false, status: 409, error: `${restaurant.name} is not doing takeaway right now.` }
  }

  // --- Resolve where the food is going -------------------------------------
  let tableId: number | null = null
  let tableLabel: string | null = null
  let accessCodeId: number | null = null
  /** The open session this order belongs to, once one has been proven valid. */
  let liveSession: any = null

  if (input.type === 'dine_in') {
    const code = (input.accessCode ?? '').trim().toUpperCase()
    const tableToken = (input.tableToken ?? '').trim().toLowerCase()

    // An open dining session already carries the proof, and so does paying
    // through the app — either way no code is needed at this point.
    const session = input.sessionToken ? sessionByToken(input.sessionToken) : null
    const hasSession = !!session && sessionIsValid(session, input.restaurantId)
    if (input.sessionToken && !hasSession) {
      return { ok: false, status: 400, error: 'That session has ended. Scan or enter the code again.' }
    }
    const paidUpFront = !!input.paymentClaim

    if (hasSession && session.table_id) {
      tableId = session.table_id
      tableLabel = session.table_label
    }
    if (session?.access_code_id) accessCodeId = session.access_code_id
    if (hasSession) liveSession = session

    /**
     * Takeaway has to be proved. Eating in proves itself.
     *
     * Both used to demand a scanned QR, a staff code or payment up front, and
     * for a table that was asking somebody sitting in the room to establish
     * that they were in the room. Naming the table is the answer: it is
     * chosen from this restaurant's own list, it is checked against it below,
     * and the food is carried to it — an order to table 4 from somebody who
     * is not at table 4 arrives at table 4, where nobody wants it. The
     * constraint enforces itself.
     *
     * Takeaway keeps the gate, because nothing about a takeaway order says
     * where the person is, and the kitchen starts cooking either way.
     */
    if (takeaway && !code && !tableToken && !hasSession && !paidUpFront) {
      return {
        ok: false,
        status: 400,
        error: 'Enter the restaurant access code, or pay through the app, to order for takeaway.',
      }
    }

    if (code) {
      const check = checkAccessCode(code, input.restaurantId)
      if (!check.ok) return { ok: false, status: 400, error: check.message }
      accessCodeId = check.row.id
    }

    if (tableToken) {
      const table = db
        .prepare('SELECT * FROM restaurant_tables WHERE token = ?')
        .get(tableToken) as any
      if (!table) return { ok: false, status: 400, error: "That table QR isn't recognised." }
      if (table.restaurant_id !== input.restaurantId) {
        return { ok: false, status: 400, error: 'That table belongs to a different restaurant.' }
      }
      tableId = table.id
      tableLabel = table.label
    }

    if (input.tableId) {
      const table = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(input.tableId) as any
      if (!table || table.restaurant_id !== input.restaurantId) {
        return { ok: false, status: 400, error: 'Pick a table from the list to continue.' }
      }
      tableId = table.id
      tableLabel = table.label
    }

    if (
      takeaway ||
      liveSession?.service_mode === 'car' ||
      liveSession?.service_mode === 'delivery' ||
      liveSession?.service_mode === 'precinct'
    ) {
      // A car has no table number and a delivery has an address instead, and
      // asking for one is exactly the friction these modes exist to remove.
      tableId = null
      tableLabel = null
    } else {
      /*
       * Eating in starts with the QR on the table — nothing else.
       *
       * Picking a table from a list let anybody anywhere send food to "table
       * 4", and it made the phone ask a question the table itself answers.
       * A customer's order to a table now needs the scan: the table's own QR
       * token, or a session that scanning (or staff) opened. Once scanned,
       * they may move to another table — the scan is the proof they are in
       * the room — but never start without one. The restaurant's own till
       * (requirePhone false) is not a customer and is not asked.
       */
      // A staff code counts too — a member of staff handed it over at the
      // table — for restaurants that use codes. Revery does not (its codes
      // are switched off), so there the QR is the only way in.
      const scanned =
        !!tableToken ||
        !!accessCodeId ||
        (!!liveSession && (liveSession.source === 'table_qr' || liveSession.source === 'code' || !!liveSession.table_id))
      if (input.requirePhone && !scanned) {
        return { ok: false, status: 400, error: 'Scan the QR code on your table to order at the restaurant.' }
      }
      if (!tableId) return { ok: false, status: 400, error: 'Please choose your table number.' }
    }
  }

  // --- Price the cart from the database, never from the client -------------
  /*
   * Half open, which is a rule about what the kitchen can still make and a
   * rule about paying, and both are checked here rather than in the screens.
   * A cart is filled at nine and submitted at ten past ten, so this is not an
   * edge case — it is the normal way somebody meets the closing kitchen.
   */
  const limited = limitedState(input.restaurantId)
  const priced: { item: any; quantity: number; unitPriceCents: number; variation: any; addons: ChosenAddon[]; label: string }[] = []
  // Variations and add-ons for every dish in the cart, read once.
  const dishOptions = optionsFor(lines.map((l) => Number(l?.menuItemId)).filter(Number.isFinite))
  const closedOut: string[] = []
  for (const line of lines) {
    const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(Number(line.menuItemId)) as any
    if (!item || item.restaurant_id !== input.restaurantId) {
      return { ok: false, status: 400, error: 'One of the items is no longer on this menu.' }
    }
    if (!item.is_available) {
      return { ok: false, status: 409, error: `${item.name} just sold out. Remove it to continue.` }
    }
    if (!orderableNow(item, limited)) {
      closedOut.push(item.name)
      continue
    }
    const quantity = Math.min(50, Math.max(1, Math.floor(Number(line.quantity))))
    // The variation and add-ons chosen, checked and priced from the menu.
    // The restaurant's own till may ring up a dish with options without
    // picking one: it gets the first option, as a waiter's quick add does.
    const opts = dishOptions.get(item.id)
    const chosen = priceLine(
      item,
      input.fromCustomer || line.variationId != null
        ? line
        : { ...line, variationId: opts?.variations.find((v) => v.isAvailable)?.id ?? null },
      opts,
    )
    if (!chosen.ok) return { ok: false, status: 409, error: chosen.error }
    priced.push({
      item,
      quantity,
      unitPriceCents: chosen.unitPriceCents,
      variation: chosen.variation,
      addons: chosen.addons,
      label: chosen.label,
    })
  }
  if (closedOut.length) {
    return { ok: false, status: 409, error: limitedRefusal(limited, closedOut) }
  }
  /*
   * And paid for. A place running on one person and a fridge cannot carry
   * somebody who orders and never comes; the margin that makes staying half
   * open worth doing is exactly the margin a no-show destroys. Refused with
   * the reason, so the checkout can move them to the UPI button rather than
   * leaving them staring at a button that will not work.
   */
  /*
   * A car order that has to be paid for first.
   *
   * Checked here rather than only in the screens: the interface can be told
   * not to offer paying at the car, and a request can still be made without
   * it. The person who pays for that is the kitchen that cooked the food.
   */

  if (limited.on && !input.paymentClaim) {
    return {
      ok: false,
      status: 402,
      error: 'The kitchen has closed for the night, so these have to be paid for in the app. Pay by UPI to place the order.',
    }
  }
  const subtotalCents = priced.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0)

  // --- What it costs to carry it ------------------------------------------
  // The area screen promises a fee and a minimum before anyone picks a dish.
  // Both were being shown and neither applied: an order under the minimum went
  // through, and the fee was quoted to the customer and then never charged, so
  // the restaurant paid for its own delivery. The area's terms are read once,
  // here, and the fee is copied onto the order.
  let deliveryFeeCents = 0
  if (liveSession?.service_mode === 'delivery' && liveSession.area_id) {
    const area = db
      .prepare('SELECT * FROM delivery_areas WHERE id = ? AND restaurant_id = ?')
      .get(liveSession.area_id, input.restaurantId) as any
    if (!area || !area.is_active) {
      return { ok: false, status: 409, error: 'They have stopped delivering to that area.' }
    }
    // The minimum is on the food. Counting the delivery fee towards it would
    // mean a cheaper order qualifies the further away you live.
    if (subtotalCents < area.min_order_cents) {
      const short = area.min_order_cents - subtotalCents
      return {
        ok: false,
        status: 400,
        error: `${area.name} has a ${money(area.min_order_cents)} minimum — add ${money(short)} more to have this delivered.`,
      }
    }
    deliveryFeeCents = area.fee_cents
  }
  // The restaurant's offer, for a customer whose email qualifies: a share of
  // the dishes, never of the delivery fee.
  const offer = input.applyOffer ? offerFor(input.restaurantId) : null
  // A proved address: the pass from an emailed code, or an account email
  // Google confirmed. Never just an address somebody typed.
  const accountEmail =
    offer && input.userId
      ? ((db.prepare('SELECT verified_email FROM users WHERE id = ?').get(input.userId) as any)?.verified_email ?? '')
      : ''
  const offerEmail = passEmail(offer, input.offerPass) ?? qualifyingEmail(offer, accountEmail)
  const offerPercent = offerEmail && offer ? offer.percent : 0
  const offerCents = discountOn(subtotalCents, offerPercent)

  const phone = customerPhone(input.contactPhone, input.userId, liveSession?.phone ?? '')
  if (input.requirePhone && !looksLikePhone(phone)) {
    return { ok: false, status: 400, error: 'Add a 10-digit mobile number so the restaurant can reach you.' }
  }

  /*
   * And a scratch card they rubbed on an earlier order.
   *
   * One or the other, never both. Two discounts stacked on one café order is
   * how a bill ends up under what the food cost, and neither of these was
   * offered on the understanding that it would be combined with the other.
   * The bigger saving wins, which is the one the customer would have picked.
   *
   * A card that loses is left unspent — it is still theirs, and burning it on
   * an order where it took nothing off would be the worst of both.
   */
  const spender = customerKey(input.userId, phone)
  const card = input.requirePhone ? cardToSpend(input.restaurantId, spender, subtotalCents) : null
  const cardCents = card ? discountFor(card, subtotalCents) : 0
  const useCard = cardCents > offerCents
  const discountCents = Math.max(offerCents, cardCents)
  const totalCents = subtotalCents - discountCents + deliveryFeeCents

  /*
   * Must this order be paid for in the app, and can it be?
   *
   * Four rules used to sit here as four separate refusals, each reading the
   * restaurant row again. They are one question: is cash allowed for this
   * order. Asked once, so the answer cannot differ between them and the
   * reason given to the customer is the one that actually applied.
   *
   * Every rule is conditioned on there being a UPI ID to pay into. A
   * restaurant with no way to be paid in the app and no cash accepted could
   * take no orders at all, and a setting that silently closes a business is
   * not a setting — it is an outage with a checkbox.
   *
   * None of it binds the restaurant's own till (`requirePhone` marks an order
   * a customer placed for themselves). The counter is the one place cash can
   * actually change hands.
   */
  const payFirst = mustPayInApp(input, liveSession, restaurant)
  /*
   * UPI only, and paid: the customer says they've sent the money, but only the
   * restaurant's own UPI app can say whether it arrived. So the order waits for
   * staff to accept it — which is them confirming the payment — and only then
   * goes to the kitchen and the till (routes/staff.ts, sendToKitchen).
   */
  const checkPaymentFirst = !!input.paymentClaim && !!input.fromCustomer && upiOnly(input.restaurantId)
  const startsAs = input.paymentClaim && !checkPaymentFirst ? 'NEW' : 'REQUESTED'
  /*
   * Held, and invisible to the restaurant until it is paid for.
   *
   * An unpaid order used to go over anyway — board, bell, push, and the till —
   * with "waiting for online payment" written on it. That is a kitchen being
   * interrupted by something it must not act on, and on a busy evening it is
   * worse than useless: the orders that matter get harder to find.
   *
   * So nothing is sent. The order exists, so the customer has a number to come
   * back and pay and so money is never sent against an order that does not
   * exist — but the restaurant hears about it when it is paid for and not a
   * moment before. payOrderByUpi does the telling.
   */
  if (payFirst) {
    return { ok: false, status: 402, error: payFirst.reason }
  }

  const orderNumber = generateOrderNumber()
  const verifyToken = randomToken(10)
  const paymentMethod = input.paymentMethod === 'app' ? 'app' : 'counter'

  /*
   * The UPI reference is optional.
   *
   * Asking everybody to copy a 12-digit number out of their UPI app was the
   * single slowest thing about paying, and it is not how the restaurant
   * checks anyway: the payment arrives in their own UPI app with the
   * customer's name on it (the note on the UPI request — see
   * /orders/payment-request), and they tick it off under "To confirm" before
   * the food goes out. A reference that IS given still has to be a whole one,
   * so a half-typed number is caught rather than saved.
   */
  if (input.paymentClaim) {
    const ref = String(input.paymentClaim.upiRef ?? '').replace(/\D/g, '')
    if (ref.length > 0 && ref.length < 12) {
      return {
        ok: false,
        status: 400,
        error: 'Enter the 12-digit UPI reference so the restaurant can find your payment.',
      }
    }
  }

  /**
   * When they want it, worked out here rather than taken on trust.
   *
   * Anything at or below zero is "as soon as possible" and stored as NULL, so
   * the ordinary order carries no scheduling at all and every board that has
   * never heard of this keeps working. Anything beyond the ceiling is refused
   * rather than clamped: silently moving somebody's 8pm order to 3pm is worse
   * than telling them no.
   */
  const wantIn = Math.round(Number(input.wantInMinutes ?? 0))
  if (Number.isFinite(wantIn) && wantIn > MAX_AHEAD_MINUTES) {
    return {
      ok: false,
      status: 400,
      error: 'Orders can be placed up to six hours ahead.',
    }
  }
  const wantedAt =
    Number.isFinite(wantIn) && wantIn > 0
      ? (db.prepare(`SELECT datetime('now', '+${wantIn} minutes') AS t`).get() as any).t
      : null

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO orders
          (order_number, restaurant_id, user_id, customer_name, order_type, table_id, table_label,
           status, payment_status, payment_method, total_cents, discount_cents, scratch_card_id,
           note, verify_token, access_code_id, takeaway,
           service_mode, zone_id, dining_session_id, delivery_area_id, delivery_address, delivery_phone,
           delivery_fee_cents, precinct_id, spot_id, look_for, contact_phone, wanted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNPAID', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        orderNumber,
        input.restaurantId,
        input.userId,
        customerName,
        input.type,
        tableId,
        tableLabel,
        // Whether the kitchen has to agree before it starts, and the answer is
        // about money. Paid through the app, it is already happening: the
        // restaurant has the cash and the customer has committed. Not paid, it
        // is a request to cook on the promise that somebody turns up — which a
        // kitchen has to be able to refuse, whatever way the order came in.
        startsAs,
        paymentMethod,
        totalCents,
        discountCents,
        card && useCard ? card.id : null,
        String(input.note ?? '').slice(0, 300),
        verifyToken,
        accessCodeId,
        takeaway ? 1 : 0,
        // Where the customer is decides how the order ends: a car has to be
        // walked out to, a table does not. Recorded on the order so the board
        // never has to work it out from a join.
        liveSession?.service_mode === 'car'
          ? 'car'
          : liveSession?.service_mode === 'delivery'
            ? 'delivery'
            : liveSession?.service_mode === 'precinct'
              ? 'precinct'
            : takeaway
            ? 'takeaway'
            : input.type === 'dine_in'
              ? 'dine_in'
              : 'pickup',
        liveSession?.zone_id ?? null,
        liveSession?.id ?? null,
        liveSession?.service_mode === 'delivery' ? (liveSession.area_id ?? null) : null,
        liveSession?.service_mode === 'delivery' || liveSession?.service_mode === 'precinct'
          ? (liveSession.address ?? '')
          : '',
        liveSession?.service_mode === 'delivery' || liveSession?.service_mode === 'precinct'
          ? (liveSession.phone ?? '')
          : '',
        deliveryFeeCents,
        liveSession?.service_mode === 'precinct' ? (liveSession.precinct_id ?? null) : null,
        liveSession?.service_mode === 'precinct' ? (liveSession.spot_id ?? null) : null,
        liveSession?.service_mode === 'precinct' ? (liveSession.look_for ?? '') : '',
        phone,
        wantedAt,
      )
    const orderId = Number(info.lastInsertRowid)
    if (discountCents > 0) {
      // Whichever one won gets its name on the order. A customer who had both
      // an offer and a card still has only one discount, and an order that
      // claimed both would reconcile against neither.
      db.prepare('UPDATE orders SET discount_cents = ?, offer_percent = ?, offer_email = ? WHERE id = ?').run(
        discountCents,
        useCard ? 0 : offerPercent,
        useCard ? '' : offerEmail,
        orderId,
      )
    }

    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, menu_item_id, name, emoji, unit_price_cents, quantity, variation_id, variation_name, addons)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const l of priced) {
      insertItem.run(
        orderId,
        l.item.id,
        l.item.name,
        l.item.emoji,
        l.unitPriceCents,
        l.quantity,
        l.variation?.id ?? null,
        l.variation?.name ?? '',
        l.addons.length ? JSON.stringify(l.addons) : '',
      )
    }

    // The first event is whatever the order actually started as. It was always
    // written as NEW, so an order waiting on the kitchen's yes had a history
    // saying it had already been accepted into one.
    db.prepare(`INSERT INTO order_events (order_id, status, actor) VALUES (?, ?, 'customer')`).run(
      orderId,
      startsAs,
    )

    if (input.paymentClaim) {
      const claimed = Math.max(0, Math.round(Number(input.paymentClaim.amountCents) || totalCents))
      db.prepare(
        `INSERT INTO payments (order_id, payer_name, amount_cents, method, status, upi_ref, covers)
         VALUES (?, ?, ?, ?, 'CLAIMED', ?, 'all')`,
      ).run(
        orderId,
        customerName,
        Math.min(claimed, totalCents),
        String(input.paymentClaim.method ?? 'upi'),
        String(input.paymentClaim.upiRef ?? '').trim().slice(0, 40),
      )
    }

    if (accessCodeId) {
      db.prepare(
        `UPDATE access_codes SET used_at = datetime('now'), used_by_order = ?
         WHERE id = ? AND used_at IS NULL`,
      ).run(orderId, accessCodeId)
    }

    const where =
      input.type === 'pickup' ? 'Pickup order' : `Table ${String(tableLabel).replace(/^Table\s*/i, '')}`
    // Held orders write no bell row: see `held` below.
    db.prepare(
      `INSERT INTO notifications (restaurant_id, order_id, title, body)
       VALUES (?, ?, ?, ?)`,
    ).run(
      input.restaurantId,
      orderId,
      // The title is the thing a glance has to answer: does this need me?
      checkPaymentFirst
        ? `Check payment for #${orderNumber}`
        : input.paymentClaim
          ? `Paid order #${orderNumber}`
          : `#${orderNumber} needs your yes`,
      `${where} · ${customerName} · ${money(totalCents)}` +
        (input.paymentClaim ? ' · paid in the app' : ' · unpaid until you accept'),
    )

    return orderId
  })

  const orderId = run()

  /*
   * Spend the card that came off this bill, and hand over a new one.
   *
   * Spending is guarded on the card still being unspent, so two orders racing
   * cannot both take it. If the guard loses — the same customer checking out
   * twice in the same second — the discount is given back, because a bill that
   * says ₹20 off has to have a card behind it.
   */
  // Only the card that actually won is spent — an offer beating it leaves the
  // card where it was, still theirs.
  if (card && useCard && discountCents > 0 && !spend(card.id, orderId)) {
    db.prepare(
      "UPDATE orders SET total_cents = total_cents + ?, discount_cents = 0, scratch_card_id = NULL WHERE id = ?",
    ).run(discountCents, orderId)
  }
  /*
   * And the prize for this one, if they are due it. Minted now so it is on the
   * order the customer is about to be shown — the tracker is where they find
   * it, and that page is already open by the time they wonder what they got.
   */
  const won = input.requirePhone ? maybeAward({ restaurantId: input.restaurantId, orderId, userId: input.userId, phone }) : null

  const order: any = getOrder(orderId)
  order.scratchCard = won

  // Every dine-in order is a room the rest of the table can join — no separate
  // "start a group" step, it is simply how ordering works.
  if (input.type === 'dine_in' && !takeaway && tableId) {
    const room = openRoomForOrder({
      orderId,
      restaurantId: input.restaurantId,
      tableId,
      tableLabel,
      hostName: customerName,
      userId: input.userId,
    })
    order.roomCode = room.code
    order.groupToken = room.hostToken
  }

  // Paying up front opens the session, so the next round needs no code.
  if (input.type === 'dine_in' && input.paymentClaim && !input.sessionToken) {
    const opened = startPaidSession({
      restaurantId: input.restaurantId,
      tableId,
      tableLabel,
      userId: input.userId,
    })
    order.sessionToken = opened.token
  }
  // The thank-you, from Khapee. Not awaited and unable to throw: whether Meta
  // answers has nothing to do with whether the kitchen has an order.
  void sendOrderConfirmation(orderId, {
    phone,
    customerName: customerName,
    restaurantName: order.restaurantName ?? '',
    orderNumber,
    total: money(totalCents),
    trackUrl: `${(process.env.KHAPEE_ORIGIN || 'https://khapee.com').replace(/\/$/, '')}/order/${orderNumber}`,
  })

  // And the restaurant, on whatever it has — a phone with the dashboard shut,
  // an inbox, or nothing at all, in which case the board is still the board.
  alertRestaurant({
    restaurantId: input.restaurantId,
    restaurantName: order.restaurantName ?? restaurant.name,
    orderNumber,
    where: order.whereLabel || (input.type === 'pickup' ? 'Pickup order' : (tableLabel ?? 'Takeaway')),
    customerName,
    customerPhone: phone,
    total: money(totalCents),
    items: priced.map((l) => `${l.quantity} × ${l.item.name}${l.label ? ` (${l.label})` : ''}`).join('\n'),
    needsAccepting: !input.paymentClaim || checkPaymentFirst,
    paid: !!input.paymentClaim,
  })

  // And whatever the restaurant bills on, if they have pointed Khapee at it.
  // Not awaited: whether somebody else's till answered has nothing to do with
  // whether this order exists. See server/billing.ts.
  // Held back while staff check the payment; accepting sends it.
  if (!checkPaymentFirst) tellBilling(input.restaurantId, orderId, 'order.placed')

  publish('order:new', { restaurantId: input.restaurantId, userId: input.userId, orderId, order })
  return { ok: true, order }
}

/**
 * What the order comes to once the kitchen has said what it can make.
 *
 * Anything declined stops counting. The delivery fee does not: it is charged
 * for carrying the bag, and the bag is still being carried.
 *
 * Called after every decision rather than at the end, so the total on the
 * board is the total at every moment — a figure that is only correct once
 * somebody presses Accept is a figure that is wrong while it is being read.
 */
export function retotalOrder(orderId: number): number {
  const row = db.prepare('SELECT delivery_fee_cents, offer_percent FROM orders WHERE id = ?').get(orderId) as any
  if (!row) return 0
  const sum = db
    .prepare(
      `SELECT COALESCE(SUM(unit_price_cents * quantity), 0) AS n
         FROM order_items WHERE order_id = ? AND (accepted IS NULL OR accepted = 1)`,
    )
    .get(orderId) as any
  // An offer is a percentage of the dishes, so it follows what is left of them.
  const discount = discountOn(Number(sum.n), Number(row.offer_percent ?? 0))
  const total = Number(sum.n) - discount + Number(row.delivery_fee_cents ?? 0)
  db.prepare("UPDATE orders SET total_cents = ?, discount_cents = ?, updated_at = datetime('now') WHERE id = ?").run(
    total,
    discount,
    orderId,
  )
  return total
}

export type ItemDecision =
  | { ok: true; order: any; allDeclined: boolean }
  | { ok: false; status: number; error: string }

/**
 * The kitchen saying yes or no to one dish.
 *
 * Refused outright once the order has been paid for. Quietly lowering the
 * total of an order somebody has already settled leaves the books saying one
 * thing and the money saying another, and the customer is owed a refund that
 * nothing in the app would ever raise. A refund is a decision with a paper
 * trail; this would be the same decision with none.
 */
export function decideItem(orderId: number, itemId: number, accepted: boolean): ItemDecision {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any
  if (!order) return { ok: false, status: 404, error: 'That order no longer exists.' }
  if (isTerminal((order.service_mode ?? 'pickup') as ServiceType, order.status as OrderStatus)) {
    return { ok: false, status: 409, error: 'That order is finished — nothing left to change on it.' }
  }
  if (order.payment_status === 'PAID') {
    return {
      ok: false,
      status: 409,
      error: 'This order is already paid for. Refund the item from the bill instead, so the money and the books agree.',
    }
  }

  const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId) as any
  if (!item) return { ok: false, status: 404, error: 'That item is not on this order.' }

  db.prepare('UPDATE order_items SET accepted = ? WHERE id = ?').run(accepted ? 1 : 0, itemId)
  retotalOrder(orderId)

  const left = db
    .prepare('SELECT COUNT(*) n FROM order_items WHERE order_id = ? AND (accepted IS NULL OR accepted = 1)')
    .get(orderId) as any
  const allDeclined = Number(left.n) === 0

  /*
   * And now the customer has to agree to it.
   *
   * They placed one order and are about to be handed a smaller one with a
   * different total, having never been asked — which is somebody else editing
   * your order after you placed it. So a refused dish turns the order round:
   * it stops waiting on the kitchen and starts waiting on the person who
   * ordered it.
   *
   * Not asked when everything has gone, because "do you accept nothing" is
   * not a question; the kitchen declines the order outright and says why.
   */
  const refused = db
    .prepare('SELECT name, quantity FROM order_items WHERE order_id = ? AND accepted = 0 ORDER BY id')
    .all(orderId) as any[]

  if (!allDeclined && refused.length) {
    db.prepare(
      "UPDATE orders SET needs_customer_ok = datetime('now'), customer_ok_at = NULL, declined_items = ? WHERE id = ?",
    ).run(refused.map((r) => `${r.quantity}× ${r.name}`).join(', ').slice(0, 300), orderId)
    askCustomer(orderId, refused.map((r) => r.name))
  } else if (!refused.length) {
    // The kitchen changed its mind and put the dish back on. Nothing to ask.
    db.prepare("UPDATE orders SET needs_customer_ok = NULL, declined_items = '' WHERE id = ?").run(orderId)
  }

  return { ok: true, order: getOrder(orderId), allDeclined }
}

/**
 * The customer agreeing to the smaller order.
 *
 * Clears the question and leaves the order exactly where it was — waiting on
 * the kitchen, with fewer dishes on it and a total that already matches.
 */
export function customerAgrees(orderId: number): { ok: boolean; order?: any; error?: string } {
  const row = db.prepare('SELECT needs_customer_ok FROM orders WHERE id = ?').get(orderId) as any
  if (!row) return { ok: false, error: 'That order no longer exists.' }
  if (!row.needs_customer_ok) return { ok: true, order: getOrder(orderId) }
  db.prepare(
    "UPDATE orders SET needs_customer_ok = NULL, customer_ok_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).run(orderId)
  publish('order:update', { restaurantId: (db.prepare('SELECT restaurant_id FROM orders WHERE id = ?').get(orderId) as any)?.restaurant_id, orderId, order: getOrder(orderId) })
  return { ok: true, order: getOrder(orderId) }
}

/**
 * "Only if you pay first."
 *
 * The same shape as a refused dish, for money instead of food. A car order
 * can be placed as pay-at-the-car; a kitchen that would rather not carry the
 * risk on this one presses a single button, and the order turns round to wait
 * on the customer, whose screen offers two things: pay online now, or cancel.
 * Nothing is cooked or accepted until one of those happens.
 */
export function askForPrepay(orderId: number): { ok: boolean; status?: number; error?: string; order?: any } {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any
  if (!order) return { ok: false, status: 404, error: 'That order no longer exists.' }
  if (order.service_mode !== 'car') {
    return { ok: false, status: 409, error: 'Prepaid only is for orders brought out to a car.' }
  }
  if (isTerminal('car', order.status as OrderStatus) || !['REQUESTED', 'NEW'].includes(order.status)) {
    return { ok: false, status: 409, error: 'This order is already under way — ask for payment when you hand it over.' }
  }
  if (order.payment_status === 'PAID' || claimedCents(orderId) > 0) {
    return { ok: false, status: 409, error: 'This order has already been paid online.' }
  }
  const restaurant = db.prepare('SELECT upi_vpa FROM restaurants WHERE id = ?').get(order.restaurant_id) as any
  if (!String(restaurant?.upi_vpa ?? '').trim()) {
    return { ok: false, status: 409, error: 'Set up UPI in Settings first — the customer needs somewhere to pay.' }
  }
  db.prepare("UPDATE orders SET needs_prepay = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(orderId)
  db.prepare("INSERT INTO order_events (order_id, status, actor) VALUES (?, 'PREPAY_ASKED', 'staff')").run(orderId)
  askToPrepay(orderId)
  return { ok: true, order: getOrder(orderId) }
}

/**
 * Paying for an order that already exists, by UPI.
 *
 * The same claim checkout makes — the 12-digit reference from the customer's
 * UPI app, for the restaurant to match against their own — for whatever is
 * still owed. Answers a kitchen's request for prepayment, and clears it.
 */
export function payOrderByUpi(orderId: number, upiRef: string): { ok: boolean; status?: number; error?: string; order?: any } {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any
  if (!order) return { ok: false, status: 404, error: 'That order no longer exists.' }
  if (['CANCELLED', 'DECLINED'].includes(order.status)) {
    return { ok: false, status: 409, error: 'This order was cancelled, so there is nothing to pay.' }
  }
  // Optional, as at checkout; a partial one is still refused.
  const ref = String(upiRef ?? '').replace(/\D/g, '')
  if (ref.length > 0 && ref.length < 12) {
    return { ok: false, status: 400, error: 'Enter the 12-digit UPI reference so the restaurant can find your payment.' }
  }
  const owed = outstandingCents(orderId)
  if (owed <= 0) return { ok: false, status: 409, error: 'This order is already paid for.' }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO payments (order_id, payer_name, amount_cents, method, status, upi_ref, covers)
       VALUES (?, ?, ?, 'upi', 'CLAIMED', ?, 'all')`,
    ).run(orderId, order.customer_name ?? '', owed, String(upiRef).trim().slice(0, 40))
    db.prepare("UPDATE orders SET needs_prepay = NULL, updated_at = datetime('now') WHERE id = ?").run(orderId)
    db.prepare(
      `INSERT INTO notifications (restaurant_id, order_id, title, body) VALUES (?, ?, ?, ?)`,
    ).run(
      order.restaurant_id,
      orderId,
      `#${order.order_number} paid online`,
      `${order.customer_name ?? ''} · ${money(owed)} by UPI${ref ? ` · ref ${ref}` : ' · check your UPI app'}`,
    )
  })()

  const r = db.prepare('SELECT name FROM restaurants WHERE id = ?').get(order.restaurant_id) as any
  alertRestaurant({
    restaurantId: order.restaurant_id,
    restaurantName: r?.name ?? '',
    orderNumber: order.order_number,
    where: order.table_label || 'Car',
    customerName: order.customer_name ?? '',
    customerPhone: order.contact_phone ?? '',
    total: money(owed),
    items: db
      .prepare('SELECT name, quantity FROM order_items WHERE order_id = ?')
      .all(orderId)
      .map((i: any) => `${i.quantity} × ${i.name}`)
      .join('\n'),
    needsAccepting: order.status === 'REQUESTED',
    paid: true,
  })

  /*
   * And now it is a real order, so it arrives like one.
   *
   * An order held for payment was never sent to the board or the till — the
   * restaurant has not heard of it. This is its first appearance, so it is
   * announced as new rather than as a change to something they were watching.
   */
  const fresh = getOrder(orderId)
  if (order.needs_prepay) {
    tellBilling(order.restaurant_id, orderId, 'order.placed')
    publish('order:new', { restaurantId: order.restaurant_id, userId: order.user_id, orderId, order: fresh })
  }
  return { ok: true, order: fresh }
}

/**
 * Everything nobody has ruled on is in.
 *
 * Run when the order is accepted, so that "Accept" means what it looks like
 * it means even after some of the dishes have been turned down individually.
 */
export function acceptRemainingItems(orderId: number): void {
  db.prepare('UPDATE order_items SET accepted = 1 WHERE order_id = ? AND accepted IS NULL').run(orderId)
  retotalOrder(orderId)
}

export function getOrder(orderId: number) {
  const row = db
    .prepare(
      `SELECT o.*, r.name AS restaurant_name, r.slug AS restaurant_slug, r.emoji AS restaurant_emoji,
              r.hue AS restaurant_hue, r.prep_minutes, r.phone AS restaurant_phone
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id WHERE o.id = ?`,
    )
    .get(orderId) as any
  if (!row) return null
  return shapeOrder(row)
}

export function shapeOrder(row: any) {
  const items = db
    .prepare(
      `SELECT i.id, i.name, i.emoji, i.unit_price_cents, i.quantity, i.paid_at, i.member_id, i.variation_name, i.addons,
              i.added_by_staff, i.accepted, m.display_name AS member_name
       FROM order_items i LEFT JOIN group_members m ON m.id = i.member_id
       WHERE i.order_id = ? ORDER BY i.id`,
    )
    .all(row.id) as any[]
  const payments = db
    .prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id')
    .all(row.id) as any[]
  const events = db
    .prepare('SELECT status, actor, created_at FROM order_events WHERE order_id = ? ORDER BY id')
    .all(row.id) as any[]
  return {
    id: row.id,
    orderNumber: row.order_number,
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name,
    restaurantEmoji: row.restaurant_emoji,
    restaurantHue: row.restaurant_hue,
    /**
     * Whether there is a number worth offering to save.
     *
     * Only whether, not what: the receipt page uses it to decide if the
     * "save us as Khapee" card is worth showing, and the number itself is
     * served by the contact card at /r/:id/khapee.vcf. A restaurant's own
     * number is not a secret, but there is no reason to put it in every
     * order payload to answer a yes-or-no question.
     */
    restaurantHasPhone: String(row.restaurant_phone ?? '').replace(/\D/g, '').length >= 10,
    prepMinutes: row.prep_minutes,
    /**
     * When the customer asked for it, or null for as soon as possible.
     *
     * Both halves of the app read this: the customer's tracking screen says
     * "ready at 9:30" instead of counting up from nothing, and the kitchen
     * sorts its queue by it so the 9:30 order is not cooked at 9:05.
     */
    wantedAt: row.wanted_at ?? null,
    /**
     * Waiting on the customer rather than on the kitchen.
     *
     * Set when the restaurant refuses one dish out of several. Both screens
     * read it: the customer's tracking page turns into a question, and the
     * kitchen's board says it is waiting on an answer rather than looking
     * like an order nobody has touched.
     */
    needsCustomerOk: row.needs_customer_ok ?? null,
    /** Set while the kitchen is waiting for this car order to be paid online. */
    needsPrepay: row.needs_prepay ?? null,
    /** The restaurant takes UPI only: accepting means the payment has arrived. */
    upiOnly: upiOnly(row.restaurant_id),
    declinedItems: row.declined_items ?? '',
    /** Set when the customer agreed to go ahead without the refused dishes. */
    customerOkAt: row.customer_ok_at ?? null,
    /**
     * When somebody who ordered ahead actually turned up, and what they
     * decided to do about it. Null until they say so from their own phone.
     */
    arrivedAt: row.arrived_at ?? null,
    arrivalChoice: (row.arrival_choice ?? null) as 'takeaway' | 'dine_in' | null,
    /** If this one went unanswered and was sent again, the new number. */
    resentAs: row.resent_as ?? null,
    customerName: row.customer_name,
    type: row.order_type as OrderType,
    serviceType: (row.service_mode === 'car'
      ? 'car'
      : row.service_mode === 'delivery'
        ? 'delivery'
        : row.service_mode === 'precinct'
          ? 'precinct'
        : row.order_type === 'pickup'
        ? 'pickup'
        : row.takeaway
          ? 'takeaway'
          : 'dine_in') as ServiceType,
    serviceMode: (row.service_mode ?? 'dine_in') as ServiceType,
    deliveryAddress: row.delivery_address ?? '',
    deliveryPhone: row.delivery_phone ?? '',
    /** How to reach whoever placed this, whatever way they ordered. */
    customerPhone: row.contact_phone || row.delivery_phone || '',
    deliveryArea: row.delivery_area_id
      ? ((db.prepare('SELECT name FROM delivery_areas WHERE id = ?').get(row.delivery_area_id) as any)?.name ?? null)
      : null,
    // Where in the precinct they are standing, for whoever walks it out.
    precinctName: row.precinct_id
      ? ((db.prepare('SELECT name FROM precincts WHERE id = ?').get(row.precinct_id) as any)?.name ?? null)
      : null,
    spotLabel: row.spot_id
      ? ((db.prepare('SELECT label FROM precinct_spots WHERE id = ?').get(row.spot_id) as any)?.label ?? null)
      : null,
    /** Where they are, whether they picked it from the list or typed it. */
    whereLabel:
      row.service_mode === 'precinct'
        ? (row.spot_id
            ? ((db.prepare('SELECT label FROM precinct_spots WHERE id = ?').get(row.spot_id) as any)?.label ?? '')
            : (row.delivery_address ?? ''))
        : '',
    lookFor: row.look_for ?? '',
    declinedReason: row.declined_reason ?? '',
    zoneName: row.zone_id
      ? ((db.prepare('SELECT name FROM service_zones WHERE id = ?').get(row.zone_id) as any)?.name ?? null)
      : null,
    takeaway: !!row.takeaway,
    isGroup: !!row.group_session_id,
    groupSessionId: row.group_session_id ?? null,
    tableLabel: row.table_label,
    status: row.status as OrderStatus,
    paymentStatus: row.payment_status as 'UNPAID' | 'PAID',
    paymentMethod: row.payment_method,
    // The dishes, then what was added to carry them, then what is owed. Kept
    // apart so a customer can see why the total is more than the menu prices.
    // The dishes before anything came off, so a saving can be shown against a
    // number the customer recognises from the menu.
    subtotalCents: row.total_cents - (row.delivery_fee_cents ?? 0) + (row.discount_cents ?? 0),
    deliveryFeeCents: row.delivery_fee_cents ?? 0,
    // What came off, and which of the two it was: an offer the account
    // qualified for (server/offers.ts), or a scratch card they rubbed.
    discountCents: row.discount_cents ?? 0,
    offerPercent: row.offer_percent ?? 0,
    offerEmail: row.offer_email ?? '',
    totalCents: row.total_cents,
    note: row.note,
    verifyToken: row.verify_token,
    verifiedAt: row.verified_at,
    scratchCard: cardForOrder(row.id),
    roomCode: row.group_session_id
      ? ((db.prepare('SELECT code FROM group_sessions WHERE id = ?').get(row.group_session_id) as any)?.code ?? null)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      emoji: i.emoji,
      /** The variation and add-ons chosen, "Large · Extra cheese", or ''. */
      options: [i.variation_name, addonsOf(i).map((a) => a.name).join(', ')].filter(Boolean).join(' · '),
      unitPriceCents: i.unit_price_cents,
      quantity: i.quantity,
      memberId: i.member_id ?? null,
      memberName: i.member_name ?? null,
      addedByStaff: !!i.added_by_staff,
      paid: !!i.paid_at,
      /** null until the kitchen says; true yes, false "we have run out". */
      accepted: i.accepted === null || i.accepted === undefined ? null : !!i.accepted,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      payerName: p.payer_name,
      amountCents: p.amount_cents,
      method: p.method,
      status: p.status,
      upiRef: p.upi_ref,
      createdAt: p.created_at,
    })),
    claimedCents: payments.filter((p) => p.status === 'CLAIMED').reduce((n, p) => n + p.amount_cents, 0),
    confirmedCents: payments.filter((p) => p.status === 'CONFIRMED').reduce((n, p) => n + p.amount_cents, 0),
    /**
     * Three states, not two, because there really are three.
     *
     * Money over UPI goes straight from the customer's bank to the
     * restaurant's, and Khapee is not in the middle of it — so between "owes
     * money" and "paid, confirmed" there is a real state: the customer has
     * sent it and the restaurant has not looked yet. Reporting that as UNPAID
     * told a customer who had just paid that they had not, and told the
     * kitchen nothing about an order that was in fact settled.
     */
    paymentState:
      row.payment_status === 'PAID'
        ? 'paid'
        : payments.some((p) => p.status === 'CLAIMED')
          ? 'sent'
          : 'unpaid',
    /** What the customer typed off their UPI app, for matching against a statement. */
    upiRef: payments.find((p) => p.status === 'CLAIMED' || p.status === 'CONFIRMED')?.upi_ref ?? '',
    events: events.map((e) => ({ status: e.status, actor: e.actor, at: e.created_at })),
  }
}
