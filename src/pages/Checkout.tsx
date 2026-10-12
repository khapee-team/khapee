import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import PayPanel from '../components/PayPanel'
import VerifyModal from '../components/VerifyModal'
import { api, ApiError } from '../lib/api'
import { cartItems, useCart } from '../lib/cart'
import { useSession } from '../lib/session'
import { clearDining, readDining, saveDining, type DiningSession } from '../lib/dining'
import { clearTableContext, readTableContext, rememberReceipt } from '../lib/table-context'
import { clearIntent, readIntent } from '../lib/intent'
import { readMe, saveLastOrder, saveMe } from '../lib/me'
import { EmptyState, LoadingBlock, Modal, money, Spinner, useToast } from '../components/ui'

type Where = 'here' | 'takeaway' | 'later'
type Table = { id: number; label: string; seats: number }

/**
 * One screen, no stages. Everything the restaurant needs is on it at once and
 * can be filled in any order — the only hard requirement is knowing where the
 * food is going, and paying in the app removes even the code step.
 */
export default function Checkout() {
  const { cart, count, totalCents, clear } = useCart()
  const { user, adopt } = useSession()
  const navigate = useNavigate()
  const toast = useToast()

  const restaurantId = cart.restaurantId
  const [dining, setDining] = useState<DiningSession | null>(() =>
    restaurantId ? readDining(restaurantId) : null,
  )

  /**
   * Opens on something the customer can actually finish.
   *
   * Eating in is what most people are doing, so it is what opens.
   *
   * This used to guess — "at a table" only if a QR had been scanned or a
   * session was already open, and "collect later" otherwise — because eating
   * in demanded a code or a scan, and sending somebody ordering from home into
   * a path that could not complete was worse than opening on the wrong tab.
   * That demand is gone: choosing the table is now the whole of it. So the
   * guess is gone too, and the common case opens first.
   */
  /*
   * Where the food is going, decided on the restaurant's page rather than
   * here.
   *
   * This used to be three buttons at the top of the checkout — at a table,
   * takeaway, collect later — which asked the question on the last screen,
   * after the basket was full, and asked it again of people who had already
   * answered it by scanning the QR on their table or tapping "sitting in your
   * car". Now the ways in are the choice, and this screen states what was
   * chosen with a way back to change it.
   */
  const chosenIntent = restaurantId ? readIntent(restaurantId) : null
  const [where, setWhere] = useState<Where>(() => {
    if (restaurantId && readTableContext(restaurantId)) return 'here'
    if (readIntent(restaurantId ?? undefined)) return 'later'
    return 'here'
  })
  const [tables, setTables] = useState<Table[] | null>(null)
  // Compact by default, Zomato-style: what is already known is one line.
  const [editDetails, setEditDetails] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [couponOpen, setCouponOpen] = useState(false)
  // A scanned table QR already answered "which table", so start on its answer
  // rather than an empty grid.
  const scannedTable = restaurantId ? readTableContext(restaurantId) : null
  /** Somebody at a known table asking to sit somewhere else after all. */
  const [changingTable, setChangingTable] = useState(false)
  const [tableId, setTableId] = useState<number | null>(dining?.tableId ?? scannedTable?.tableId ?? null)
  const [tableLabel, setTableLabel] = useState<string | null>(
    dining?.tableLabel ?? scannedTable?.tableLabel ?? null,
  )
  /**
   * Whoever runs this restaurant is not the customer ordering from it.
   *
   * The name is prefilled from the account as a convenience, and the account
   * that runs Revery is called Revery — so every order placed while signed in
   * to it arrived for a customer named after the restaurant. A restaurant's
   * own account gets an empty box, like anybody else standing at the counter.
   */
  const ownsThis = !!user?.restaurants?.some((r) => r.id === restaurantId)
  /* Asked once, then remembered on this phone (lib/me.ts) — typing a name and
     ten digits on every order was most of the work of ordering. */
  const me = readMe()
  const [name, setName] = useState(ownsThis ? '' : (user?.name || me?.name || ''))
  /** How the restaurant reaches this order. Not optional — see needsPhone. */
  const [phone, setPhone] = useState(user?.phone || me?.phone || '')
  /**
   * Opened from the menu's one-tap "Place order". If nothing is missing the
   * order goes straight through; if something is (a first order, with no
   * name or number yet), this screen shows just that and one button.
   */
  const [params] = useSearchParams()
  const go = params.get('go') === '1'
  const [note, setNote] = useState('')
  /**
   * How long until they get to the restaurant, for an order placed before
   * setting off. Zero means as soon as it is ready.
   *
   * Asked only on the collect-later path. It used to be asked of everybody,
   * including people already sitting at a table, where the question is
   * meaningless — which is why it came off the checkout. Here it is the whole
   * point: the kitchen cannot time an order for somebody who is twenty
   * minutes away without being told that they are.
   */
  const [arriveIn, setArriveIn] = useState(0)
  const [payNow, setPayNow] = useState(false)
  const [options, setOptions] = useState<any>(null)

  /**
   * An order going to an address costs more than the dishes on it, and will not
   * go out at all under the area's minimum. Both were being promised on the way
   * in and neither shown here, so the button quoted a total the customer was
   * not going to be charged.
   */
  const isDelivery = dining?.serviceMode === 'delivery'
  const deliveryFeeCents = isDelivery ? (dining?.deliveryFeeCents ?? 0) : 0
  /*
   * A scratch card they already won, coming off this bill.
   *
   * Quoted from the server while they are still deciding, because at a
   * UPI-only restaurant this number is the amount they are about to be asked
   * for — springing a discount after the payment request is built would mean
   * asking for one figure and charging another.
   *
   * On the food only, like the server works it: the delivery fee is somebody's
   * courier, not the restaurant's margin to give away.
   */
  const [saving, setSaving] = useState<{ label: string; discountCents: number } | null>(null)

  /*
   * Asked for when the basket or the number changes, and debounced, because
   * this runs while somebody is still typing their phone number.
   */
  useEffect(() => {
    const digits = phone.replace(/\D/g, '')
    if (!restaurantId || digits.length < 10 || !count) {
      setSaving(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      api<{ card: { label: string } | null; discountCents: number }>('/orders/scratch-quote', {
        body: {
          restaurantId,
          phone: digits,
          items: cart.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
        },
      })
        .then((r) => {
          if (!live) return
          setSaving(r.card && r.discountCents > 0 ? { label: r.card.label, discountCents: r.discountCents } : null)
        })
        .catch(() => live && setSaving(null))
    }, 350)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [restaurantId, phone, count, totalCents]) // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * The restaurant's coupon for people from one place — 20% off at Mr. Beans
   * Saket for a @dalycollege.org address. The address is proved with a 6-digit
   * code emailed to it — typed back, it leaves a pass on this phone — and the
   * coupon then waits for the customer to press Apply; it is never applied on
   * its own. The server checks the pass and works the discount out itself, so
   * this is only what is shown.
   */
  const [offer, setOffer] = useState<{ domain: string; percent: number; label: string; codesOn?: boolean } | null>(null)
  const passKey = `khapee.offerPass.${restaurantId}`
  const [offerPass, setOfferPass] = useState<{ pass: string; email: string } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(`khapee.offerPass.${restaurantId}`) || 'null')
    } catch {
      return null
    }
  })
  const [offerEmail, setOfferEmail] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [offerCode, setOfferCode] = useState('')
  const [offerBusy, setOfferBusy] = useState(false)
  const [offerNote, setOfferNote] = useState('')
  const sendOfferCode = async () => {
    setOfferBusy(true)
    setOfferNote('')
    try {
      const sentTo = offerEmail.trim()
      await api(`/orders/offer/${restaurantId}/send-code`, { body: { email: sentTo } })
      setCodeSent(true)
      setOfferCode('')
      // The code box is open; meanwhile, find out whether the address bounced,
      // and if it did, say so instead of leaving them waiting for a code.
      void (async () => {
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 2500))
          const r = await api<{ status: string; error?: string }>(
            `/orders/offer/${restaurantId}/code-status?email=${encodeURIComponent(sentTo)}`,
          ).catch(() => null)
          if (!r || r.status === 'fine') return
          if (r.status === 'bounced') {
            setCodeSent(false)
            setOfferNote(r.error ?? "That email isn't available.")
            return
          }
        }
      })()
    } catch (e) {
      setOfferNote((e as ApiError).message)
    } finally {
      setOfferBusy(false)
    }
  }
  // Checked the moment the sixth digit is in — no button to press.
  const checkOfferCode = async (code: string) => {
    setOfferBusy(true)
    setOfferNote('')
    try {
      const r = await api<{ pass: string; email: string }>(`/orders/offer/${restaurantId}/check-code`, {
        body: { email: offerEmail.trim(), code },
      })
      const kept = { pass: r.pass, email: r.email }
      setOfferPass(kept)
      try {
        localStorage.setItem(passKey, JSON.stringify(kept))
      } catch {
        /* a private window forgets it */
      }
    } catch (e) {
      setOfferNote((e as ApiError).message)
      setOfferCode('')
    } finally {
      setOfferBusy(false)
    }
  }
  const [offerApplied, setOfferApplied] = useState(false)
  useEffect(() => {
    if (!restaurantId) return
    api<{ offer: any }>(`/orders/offer/${restaurantId}`)
      .then((r) => setOffer(r.offer))
      .catch(() => setOffer(null))
  }, [restaurantId])
  // Only a proved address counts — anybody can type one.
  const offerEligible =
    !!offer &&
    (!!offerPass?.email.endsWith(`@${offer.domain}`) ||
      (!!user && String(user.verifiedEmail ?? '').toLowerCase().endsWith(`@${offer.domain}`)))
  const offerCents =
    offerEligible && offerApplied && offer ? Math.min(totalCents, Math.round((totalCents * offer.percent) / 100 / 100) * 100) : 0

  /*
   * One discount, not two.
   *
   * A customer can have both an offer their account qualifies for and a
   * scratch card they rubbed. Stacking them is how a café bill ends up under
   * what the food cost, and neither was offered on the understanding it would
   * be combined — so the bigger saving wins, which is the one they would have
   * chosen. The server decides this again the same way; this is only what is
   * shown while they decide.
   */
  const savingCents = saving?.discountCents ?? 0
  const useCard = savingCents > offerCents
  const discountCents = Math.max(offerCents, savingCents)
  const payableCents = Math.max(0, totalCents - discountCents) + deliveryFeeCents
  const shortOfMinimum = isDelivery ? Math.max(0, (dining?.minOrderCents ?? 0) - totalCents) : 0

  /**
   * Someone who came in through the car or delivery door has already said where
   * the food is going, and there is no table involved either way. They were
   * still being shown the table picker and stopped with "choose your table
   * number" — a question with no answer, on the two routes that exist
   * specifically to avoid sitting down.
   */
  const isCar = dining?.serviceMode === 'car'
  // Standing somewhere in a precinct: no table, no address, a landmark.
  const isNearby = dining?.serviceMode === 'precinct'
  const placeDecided = isDelivery || isCar || isNearby

  /**
   * Named for the situation, so "pay later" means something concrete — and it
   * says how, because "pay at the restaurant" reads to a lot of people as
   * cash only, and they choose it or avoid it on that assumption. Every one of
   * these counters takes a phone as readily as a note.
   */
  const payLaterLabel = isDelivery
    ? 'UPI or cash on delivery'
    : isCar
      ? 'UPI or cash at the car'
      : isNearby
        ? 'UPI or cash when it arrives'
        : where === 'later'
          ? 'UPI or cash when you collect'
          : 'UPI or cash at the restaurant'

  /** Eating in and takeaway are ordered at the restaurant; collecting is not. */
  /** Takeaway alone, now that picking a table is proof enough of being at one. */
  const needsPresence = where === 'takeaway'
  const hasPresence = !!dining || !!(restaurantId && readTableContext(restaurantId))

  const [verifyOpen, setVerifyOpen] = useState(false)
  // Set when the customer tapped the main button and only the code was missing:
  // once they verify, the order goes through without a second tap.
  const [placeAfterVerify, setPlaceAfterVerify] = useState(false)
  const [payRequest, setPayRequest] = useState<any>(null)
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!restaurantId) return
    api<any>(`/orders/payment-options/${restaurantId}`).then(setOptions).catch(() => setOptions(null))
    api<{ tables: Table[] }>(`/orders/tables/${restaurantId}`)
      .then((r) => {
        setTables(r.tables)
        /**
         * A counter with no tables cannot be ordered to a table.
         *
         * Opening on "At a table" is right for a restaurant that has some,
         * and a dead end for one that has none: the grid is empty, there is
         * nothing to pick, and the order cannot be placed from the tab it
         * opened on. Every place on Khapee has tables today, so this never
         * fires — but the next one added might not, and the failure would be
         * a checkout that simply refuses to continue with nothing on screen
         * explaining why.
         */
        if (!r.tables.length) setWhere((w) => (w === 'here' ? 'later' : w))
      })
      .catch(() => setTables([]))
  }, [restaurantId])

  useEffect(() => {
    if (user?.name && !name && !ownsThis) setName(user.name)
    if (user?.phone && !phone) setPhone(user.phone)
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!restaurantId || count === 0) {
    return (
      <div className="app">
        <Header />
        <main className="page page-narrow">
          <EmptyState
            emoji="🛒"
            title="Nothing to order yet"
            body="Add a few things first."
            action={
              <Link className="btn btn-accent" to="/">
                Browse restaurants
              </Link>
            }
          />
        </main>
      </div>
    )
  }

  const seated = tableId ?? dining?.tableId ?? null
  const seatedLabel = tableLabel ?? dining?.tableLabel ?? null
  // Scanning the QR screwed to a table is the proof. The session it opens can
  // lapse over a long meal, and then the customer — still sitting at the table,
  // still holding the QR — was told to scan it again or go and ask staff for a
  // code. Holding its token is the same evidence scanning it again would give.
  const verified = !!dining?.active || !!scannedTable
  const canPayInApp = !!options?.acceptsUpi
  /*
   * Half open: the kitchen has gone home, so the order has to be paid for.
   *
   * Read before the payment choice is drawn rather than discovered when the
   * order is refused — offering "pay at the restaurant" on an order the
   * server will turn down for exactly that reason is the worst version of
   * this feature.
   */
  /*
   * Paying afterwards is not on offer here.
   *
   * Two reasons it can be true: the kitchen has gone home and is serving a
   * short menu it will not carry a no-show on, or this is an order to a car
   * — the one place the food is taken out to somebody already sitting in the
   * thing they will leave in.
   */
  /** A bakery that only hands orders over the counter: nothing to change, nothing to pay later. */
  const collectOnly = !!options?.collectOnly
  // A place with no eating in: the order is collected, whatever was picked before.
  useEffect(() => {
    if (collectOnly) setWhere('later')
  }, [collectOnly])
  const prepaidOnly =
    !!options?.prepaidOnly ||
    (isCar && !!options?.carPrepaidOnly) ||
    // Takeaway — ordered here to carry out, or ordered ahead to collect — is
    // paid in the app at every restaurant; the server refuses it otherwise.
    where === 'later' ||
    where === 'takeaway'
  useEffect(() => {
    // Nothing to choose when there is only one way to pay.
    if (prepaidOnly && !payNow) setPayNow(true)
  }, [prepaidOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Takes UPI only and has a UPI ID: paying by UPI is the only option, in every mode. */
  const upiOnly = !!options?.cashDisabled && canPayInApp

  /** The line under the choice — what it actually means for this order. */
  const paySub = upiOnly
    ? `${cart.restaurantName} takes UPI only. Pay, and they accept your order once the money arrives.`
    : !canPayInApp
    ? 'Cash or UPI at the counter — this place has no UPI ID on Khapee yet'
    : payNow
      ? isDelivery
        ? `${cart.restaurantName} accepts the order first — if they can’t take it, they refund you`
        : where === 'here' && !placeDecided
          ? 'Paying is proof you are here — no code needed'
          : 'Pay from your own UPI app before it is made'
      : 'Cash or UPI, when you get it'

  /**
   * Eating in starts with the table's QR — see the rule in createOrder. A
   * scan leaves a table context, or a table session; either is "scanned in".
   * Without one there is no table list to pick from, only the scanner.
   */
  const scannedIn = !!scannedTable || (!!dining?.token && !!dining?.tableId)
  // What still stands between the customer and their food.
  const needsTable = where === 'here' && !placeDecided && (!scannedIn || !seated)
  /**
   * Takeaway still has to be proved; eating in no longer does.
   *
   * Ordering to a table used to demand a scanned QR, a staff code, or paying
   * up front, and it was asked of somebody already sitting in the room being
   * asked about. Saying which table you are at is the answer to the question
   * that gate was asking — the table is picked from this restaurant's own
   * list, and the food is carried to it — so the gate was two hoops to reach
   * an answer already given.
   *
   * Takeaway keeps it. There is no table to carry anything to, so nothing
   * about that order says the person is on the premises.
   */
  const needsProof = where === 'takeaway' && !verified && !payNow
  const needsName = name.trim().length < 2
  /**
   * A kitchen that cannot ring you has no way to say "we are out of that" or
   * "we cannot find you" — and those are the two calls that actually happen.
   * Delivery and the precinct already collected a number on the way in, so
   * they are not asked twice.
   */
  const needsPhone = !isNearby && !isDelivery && phone.replace(/\D/g, '').length < 10
  const ready = !needsTable && !needsProof && !needsName && !needsPhone
  /**
   * The one-tap order, when all that is missing is the name and number: show
   * only those two boxes and the button. Where it is going, the table, the
   * note and how to pay are all already settled, and restating them on a
   * first order made it look like a form to fill in.
   */
  const lean = go && !needsTable && !needsProof && !isDelivery

  /*
   * One tap from the menu. Once the payment options are known (they decide
   * whether this is pay-later or UPI-first), an order with nothing missing is
   * placed — or, when it has to be paid first, the UPI screen opens — without
   * the customer touching this page. Only once per visit to the page.
   */
  const [autoTried, setAutoTried] = useState(false)
  useEffect(() => {
    if (!go || autoTried || !options || placing || payRequest || !count) return
    // Decided once, on arrival. If something was missing then, the customer
    // finishes it and presses the button — the order must never go off by
    // itself halfway through typing a name.
    setAutoTried(true)
    if (!ready || shortOfMinimum > 0) return
    if (payNow) void startPayment()
    else void place()
  }, [go, autoTried, options, ready, payNow, placing, payRequest, count]) // eslint-disable-line react-hooks/exhaustive-deps

  const startPayment = async () => {
    setPlacing(true)
    setError('')
    try {
      const r = await api<any>('/orders/payment-request', {
        body: {
          restaurantId,
          items: cartItems(cart.lines),
          // So the amount asked for is the amount owed: a delivery adds a fee
          // that the dishes alone do not account for.
          sessionToken: dining?.token ?? null,
          // Written on the UPI payment, so the restaurant can match it by name.
          customerName: name.trim(),
          // Who they are, so a scratch card they have won comes off the
          // amount their bank is about to ask for and not just off the screen.
          customerPhone: phone.trim(),
          // And the offer, when that is the one winning.
          applyOffer: offerCents > 0 && !useCard,
          offerPass: offerPass?.pass ?? null,
        },
      })
      setPayRequest(r)
    } catch (e) {
      const err = e as ApiError
      if ((err as any).status === 409) await place()
      else setError(err.message)
    } finally {
      setPlacing(false)
    }
  }

  const place = async (paymentClaim?: { upiRef: string }, withSession?: string) => {
    setPlacing(true)
    setError('')
    try {
      const r = await api<{ order: any; session?: { token: string; user: any } | null }>('/orders', {
        body: {
          restaurantId,
          type: where === 'later' ? 'pickup' : 'dine_in',
          takeaway: where === 'takeaway',
          items: cartItems(cart.lines),
          customerName: name.trim(),
          contactPhone: phone.trim(),
          note,
          paymentMethod: paymentClaim ? 'app' : 'counter',
          tableId: seated,
          // The scanned QR is itself the proof of being at the table. Without
          // it the server had only the customer's word for the table number,
          // and turned the order away asking them to scan the QR they had
          // already scanned.
          tableToken: where === 'here' ? (scannedTable?.tableToken ?? null) : null,
          sessionToken: withSession ?? dining?.token ?? null,
          paymentClaim: paymentClaim ? { upiRef: paymentClaim.upiRef } : null,
          // Only meaningful for an order placed before setting off.
          wantInMinutes: where === 'later' ? arriveIn : 0,
          applyOffer: offerCents > 0 && !useCard,
          offerPass: offerPass?.pass ?? null,
        },
      })
      const order = r.order
      rememberReceipt(order.orderNumber, order.verifyToken)
      saveMe(name, phone)
      // The first order made them an account; this phone stays signed in.
      if (r.session?.token && r.session.user) adopt(r.session.token, r.session.user)
      if (restaurantId) {
        saveLastOrder(
          restaurantId,
          cart.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, name: l.name, priceCents: l.priceCents })),
        )
      }
      /**
       * The room this order opened stays open — and this phone stays out of it.
       *
       * It used to join itself here, on the reasoning that the person who
       * ordered is obviously at the table. The cost of that was invisible and
       * enormous: being in a group changes what the cart does — it stops being
       * an order and becomes a staging area for a shared ticket — so every
       * customer who had ever eaten in was quietly put somewhere that made
       * ordinary ordering impossible on their next visit, having never asked
       * to share anything with anybody. "You are in a group" about a table
       * they were at last week, and no way to place a simple order.
       *
       * Joining a table is now something a person does, by scanning the code
       * or opening the link. The room is still here for them; it just does not
       * reach out and take them.
       */
      if (order.sessionToken) {
        saveDining({
          token: order.sessionToken,
          restaurantId,
          restaurantName: cart.restaurantName,
          restaurantEmoji: '🍽️',
          tableId: seated,
          tableLabel: seatedLabel,
          source: 'payment',
          active: true,
          secondsLeft: 4 * 3600,
        })
      }
      clear()
      // The table is deliberately not forgotten here. A meal is rarely one
      // order — drinks, then food, then coffee — and dropping the scan after
      // the first one sent the customer back to the QR, or to staff for a
      // code, for every round after it. "End" on the dining bar is how you
      // say you have finished.
      // Said on the next screen rather than here, so the confirmation and the
      // thing being confirmed are the same page — a toast on a page that is
      // already disappearing is read by nobody.
      navigate(`/order/${order.orderNumber}`, {
        replace: true,
        state: { justPlaced: true, paid: !!paymentClaim },
      })
    } catch (e) {
      setError((e as ApiError).message)
      setPlacing(false)
      setPayRequest(null)
    }
  }

  return (
    <div className="app">
      <Header />
      <main className="page page-narrow">
        <div className="co-head">
          <h1>Checkout</h1>
          <p className="muted">
            {count} item{count > 1 ? 's' : ''} · {cart.restaurantName}
          </p>
        </div>

        {error && <div className="form-error">{error}</div>}

        {/* The one-tap order from the menu, going through by itself. */}
        {go && placing && !payRequest && <LoadingBlock label="Placing your order…" />}
        {go && !ready && !placing && (needsName || needsPhone) && (
          <p className="quick-once">Just your name and number — only this once, then you’re signed in.</p>
        )}

        {!lean && (
          <>
        {/* Where is this going? Already answered, if they came by car or asked
            for it to be brought to them. */}
        {placeDecided ? (
          <div className="verified-banner" style={{ marginBottom: 4 }}>
            <span aria-hidden>{isNearby ? '🚶' : isDelivery ? '🛵' : '🚗'}</span>
            <div style={{ flex: 1 }}>
              {isNearby ? (
                <>
                  Bringing it to <strong>{dining?.whereLabel || dining?.spotLabel}</strong>
                  {dining?.lookFor ? ` · ${dining.lookFor}` : ''}
                </>
              ) : isDelivery ? (
                <>
                  Delivering to <strong>{dining?.address || dining?.areaName}</strong>
                </>
              ) : (
                <>
                  Brought out to <strong>{dining?.vehicle || 'your car'}</strong>
                  {dining?.seqNo ? ` · Car ${dining.seqNo}` : ''}
                </>
              )}
            </div>
            <Link
              className="btn btn-ghost btn-sm"
              to={
                isNearby
                  ? `/p/${dining?.precinctSlug ?? ''}`
                  : isDelivery
                    ? `/r/${restaurantId}/delivery`
                    : `/r/${restaurantId}/car`
              }
            >
              Change
            </Link>
          </div>
        ) : (
          /*
            Not a question any more — a statement, with a way back.
            
            The three buttons that used to live here asked, on the last screen
            and with a full basket, something the customer had usually already
            answered on the way in. The ways in are the choice now; this says
            which one was taken. The same shape as a car or an address, which
            have always worked this way.
          */
          <div className="verified-banner" style={{ marginBottom: 4 }}>
            <span aria-hidden>{where === 'here' ? '🍽️' : '🥡'}</span>
            <div style={{ flex: 1 }}>
              {where === 'here' ? (
                <>
                  Eating in at <strong>{cart.restaurantName}</strong>
                </>
              ) : (
                <>
                  Taking it away from <strong>{cart.restaurantName}</strong>
                </>
              )}
            </div>
            {!collectOnly && (
              <Link className="btn btn-ghost btn-sm" to={`/r/${restaurantId}`}>
                Change
              </Link>
            )}
          </div>
        )}
          </>
        )}

        {/*
          Ordering before setting off: when will you be here?

          The kitchen's only real problem with an order from somebody who is
          not in the building is timing it, and this is the only screen where
          the customer knows the answer. Shown on this path alone — at a table
          it is a meaningless question, which is why it is no longer asked
          there.
        */}
        {where === 'later' && !placeDecided && !collectOnly && (
          <section className="card card-pad arrive-panel">
            <div className="field" style={{ marginBottom: 0 }}>
              <label>When will you get there?</label>
              <div className="arrive-row" role="group" aria-label="When will you get there?">
                {ARRIVE_CHOICES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`arrive-btn ${arriveIn === m ? 'active' : ''}`}
                    aria-pressed={arriveIn === m}
                    onClick={() => setArriveIn(m)}
                  >
                    <strong>{m === 0 ? 'Straight there' : `In ${m} min`}</strong>
                    <em>{m === 0 ? 'Start it now' : clockIn(m)}</em>
                  </button>
                ))}
              </div>
              <p className="tiny muted" style={{ margin: '9px 0 0' }}>
                {arriveIn === 0
                  ? 'They will start it now and hold it for you.'
                  : `They will have it ready for ${clockIn(arriveIn)}, so it is fresh when you walk in.`}
                {!collectOnly && ' You choose takeaway or a table when you arrive.'}
              </p>
            </div>
          </section>
        )}

        {!placeDecided && needsPresence && !hasPresence && (
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Takeaway needs the table QR or a staff code — you order it at the restaurant. To order from
            here, choose <strong>Collect later</strong>.
          </p>
        )}


        <section className="card card-pad">
          {/* Table — only when eating in */}
          {/*
            Already at a table: say so, do not ask again.

            Scanning the QR on table 3 is the customer saying which table they
            are at — completely, and more reliably than a grid of buttons can.
            Showing the grid anyway asked the question a second time, put the
            answer they had already given at risk of a mis-tap, and filled the
            screen of the one person who had done exactly the right thing.

            Kept changeable, because somebody scans a code, then moves to a
            bigger table, and the only thing worse than asking twice is not
            letting them correct it.
          */}
          {!lean && where === 'here' && !placeDecided && seated && !changingTable && (
            <div className="field">
              <label>Table</label>
              <div className="seated-at">
                <span>
                  <strong>{seatedLabel ?? `Table ${seated}`}</strong>
                  <em className="tiny muted">
                    {scannedTable ? ' · from the code you scanned' : ' · from your open table'}
                  </em>
                </span>
                <button type="button" className="link-btn" onClick={() => setChangingTable(true)}>
                  Change
                </button>
              </div>
            </div>
          )}

          {/* Not scanned: no list to pick from — the QR on the table is the
              way in. Scanning opens the table and the order goes straight on. */}
          {where === 'here' && !placeDecided && !scannedIn && (
            <div className="scan-first">
              <strong>Scan the QR on your table</strong>
              <span className="tiny muted">Ordering at the restaurant starts with your table&rsquo;s QR code.</span>
              <button
                type="button"
                className="btn btn-accent btn-sm"
                onClick={() => {
                  setPlaceAfterVerify(false)
                  setVerifyOpen(true)
                }}
              >
                Scan QR
              </button>
            </div>
          )}

          {/* Scanned, and asked to move: the list, only then. */}
          {where === 'here' && !placeDecided && scannedIn && changingTable && (
            <div className="field">
              <label>Table</label>
              {!tables ? (
                <LoadingBlock />
              ) : (
                <div className="table-grid">
                  {tables.map((t) => (
                    <button
                      key={t.id}
                      className={`table-btn ${seated === t.id ? 'selected' : ''}`}
                      onClick={() => {
                        setTableId(t.id)
                        setTableLabel(t.label)
                        setChangingTable(false)
                        if (dining?.token) {
                          api(`/sessions/${dining.token}/table`, { body: { tableId: t.id } })
                            .then(() => {
                              const next = { ...dining, tableId: t.id, tableLabel: t.label }
                              saveDining(next)
                              setDining(next)
                            })
                            .catch(() => {})
                        }
                      }}
                    >
                      <strong>{t.label}</strong>
                      <span>{t.seats} seats</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Known from last time: one line, editable. Unknown: the two boxes. */}
          {!editDetails && !needsName && !(needsPhone && !isNearby && !isDelivery) ? (
            <div className="co-row">
              <span className="co-row-icon" aria-hidden>
                👤
              </span>
              <span className="co-row-main">
                <strong>{name.trim()}</strong>
                {!isNearby && !isDelivery && <span className="tiny muted">{phone.trim()}</span>}
              </span>
              <button type="button" className="link-btn" onClick={() => setEditDetails(true)}>
                Edit
              </button>
            </div>
          ) : (
            <>
          {!user && (
            <p className="co-first">
              <strong>First time here?</strong> Just your name and number — you’ll stay signed in after this order.
            </p>
          )}
          <div className="field">
            <label htmlFor="co-name">Name for the order</label>
            <input
              id="co-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Siya"
              autoComplete="name"
            />
          </div>

          {/* How the restaurant reaches this order. A delivery or a spot in
              the area gave a number on the way in and is not asked twice. */}
          {!isNearby && !isDelivery && (
            <div className="field">
              <label htmlFor="co-phone">Mobile number</label>
              <input
                id="co-phone"
                className="input"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/[^0-9+ ]/g, '').slice(0, 20))}
                placeholder="98765 43210"
                inputMode="tel"
                autoComplete="tel"
              />
              <span className="hint">
                Your confirmation comes here, and it is how the restaurant reaches you.
              </span>
            </div>
          )}

            </>
          )}

          {!lean && !noteOpen && !note ? (
            <button type="button" className="co-add-note link-btn" onClick={() => setNoteOpen(true)}>
              + Add a note for the kitchen
            </button>
          ) : (
          <div className="field" style={lean ? { display: 'none' } : undefined}>
            <label htmlFor="co-note">Note for the kitchen</label>
            <textarea
              id="co-note"
              className="textarea"
              style={{ minHeight: 62 }}
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 300))}
              placeholder="Less spicy, no onions…"
            />
          </div>
          )}


          {/* The code — only mentioned when it is actually the missing piece.
              A car or a delivery has said where it is going at the top already. */}
          {placeDecided || lean ? null : verified ? (
            <div className="verified-banner">
              <span>✓</span>
              <div style={{ flex: 1 }}>
                You&rsquo;re at {dining?.restaurantName ?? scannedTable?.restaurantName ?? cart.restaurantName}
                {(dining?.tableLabel ?? scannedTable?.tableLabel)
                  ? ` · ${dining?.tableLabel ?? scannedTable?.tableLabel}`
                  : ''}
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  clearDining()
                  clearTableContext()
                  setDining(null)
                  setTableId(null)
                  setTableLabel(null)
                }}
              >
                Change
              </button>
            </div>
          ) : (
            needsProof && (
              <div className="notice">
                <span aria-hidden>🔑</span>
                <div style={{ flex: 1 }}>
                  <strong>One last thing</strong>
                  <p className="tiny">
                    Ask a staff member for the code, or{' '}
                    {canPayInApp ? 'pay in the app and skip it entirely.' : 'scan the QR on your table.'}
                  </p>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setVerifyOpen(true)}>
                  Scan / enter
                </button>
              </div>
            )
          )}

          {offer &&
            (offerEligible ? (
              <div className={`coupon ${offerApplied ? 'is-on' : ''}`}>
                <span className="coupon-mark" aria-hidden>
                  🎓
                </span>
                <span className="coupon-body">
                  <strong>
                    {offer.label ? `${offer.label} · ` : ''}
                    {offer.percent}% off
                  </strong>
                  <span className="tiny muted">For {offerPass?.email ?? `your @${offer.domain} account`} · on the dishes</span>
                </span>
                <button
                  type="button"
                  className={`btn btn-sm ${offerApplied ? 'btn-secondary' : 'btn-accent'}`}
                  onClick={() => setOfferApplied((v) => !v)}
                >
                  {offerApplied ? 'Remove' : 'Apply'}
                </button>
              </div>
            ) : (
              <div className="coupon is-locked">
                <span className="coupon-mark" aria-hidden>
                  🎓
                </span>
                <span className="coupon-body">
                  <button type="button" className="coupon-toggle" onClick={() => setCouponOpen((v) => !v)}>
                    <strong>
                      {offer.label ? `${offer.label}? ` : ''}
                      {offer.percent}% off coupon
                    </strong>
                    <span aria-hidden>{couponOpen ? '▴' : 'Unlock ›'}</span>
                  </button>
                  {!couponOpen ? null : offer.codesOn === false ? (
                    <span className="tiny muted">Unlocking by email is coming soon.</span>
                  ) : !codeSent ? (
                    <>
                      <span className="tiny muted">Enter your @{offer.domain} email — we'll send you a code.</span>
                      <span className="coupon-form">
                        <input
                          className="input"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          placeholder={`yourname@${offer.domain}`}
                          value={offerEmail}
                          onChange={(e) => setOfferEmail(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && void sendOfferCode()}
                        />
                        <button
                          type="button"
                          className="btn btn-sm btn-accent"
                          disabled={offerBusy || !offerEmail.trim().toLowerCase().endsWith(`@${offer.domain}`)}
                          onClick={() => void sendOfferCode()}
                        >
                          {offerBusy ? 'Sending…' : 'Send code'}
                        </button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="tiny muted">
                        Enter the 6-digit code we sent to {offerEmail.trim()}.{' '}
                        <button type="button" className="link-btn" onClick={() => setCodeSent(false)}>
                          Change
                        </button>
                      </span>
                      <input
                        className="input coupon-code"
                        autoFocus
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]*"
                        maxLength={6}
                        placeholder="••••••"
                        value={offerCode}
                        disabled={offerBusy}
                        onChange={(e) => {
                          const digits = e.target.value.replace(/\D/g, '').slice(0, 6)
                          setOfferCode(digits)
                          if (digits.length === 6) void checkOfferCode(digits)
                        }}
                      />
                      <button type="button" className="link-btn tiny" disabled={offerBusy} onClick={() => void sendOfferCode()}>
                        Send it again
                      </button>
                    </>
                  )}
                  {offerNote && <span className="tiny coupon-error">{offerNote}</span>}
                </span>
              </div>
            ))}

          {(isDelivery || discountCents > 0) && (
            <div className="summary-row">
              <span>Dishes</span>
              <span>{money(totalCents)}</span>
            </div>
          )}
          {discountCents > 0 && (
            <div className="summary-row offer-ok">
              <span>{offer!.percent}% off{offer!.label ? ` (${offer!.label})` : ''}</span>
              <span>−{money(discountCents)}</span>
            </div>
          )}
          {isDelivery && (
            <div className="summary-row">
              <span>Delivery{dining?.areaName ? ` to ${dining.areaName}` : ''}</span>
              <span>{deliveryFeeCents > 0 ? money(deliveryFeeCents) : 'Free'}</span>
            </div>
          )}

          {saving && (
            <div className="summary-row saving">
              <span>
                Scratch card <small>{saving.label}</small>
              </span>
              <span>&minus;{money(saving.discountCents)}</span>
            </div>
          )}

          <div className="summary-total" style={{ marginBottom: 14 }}>
            <span>Total</span>
            <span>{money(payableCents)}</span>
          </div>

          {shortOfMinimum > 0 && (
            <div className="notice" style={{ marginBottom: 12 }}>
              <span aria-hidden>🛵</span>
              <div style={{ flex: 1 }}>
                <strong>{money(shortOfMinimum)} more to be delivered</strong>
                <p className="tiny">
                  {dining?.areaName ?? 'This area'} has a {money(dining?.minOrderCents ?? 0)} minimum on
                  the dishes.
                </p>
              </div>
              <Link className="btn btn-secondary btn-sm" to={`/r/${restaurantId}`}>
                Add more
              </Link>
            </div>
          )}

          {/*
            How this is being paid for, immediately above the button that does
            it — the last thing read before committing.

            Both ways are on the page, one under the other, rather than one
            line with a Change button that opened a sheet. A sheet hides the
            choice behind a tap and behind a word: somebody who does not read
            "Change" as a button never learns the other way exists, and
            somebody who does has to open, read, pick and come back to see what
            they picked. Two rows say everything at once.
          */}
          {lean && !payNow ? (
            <p className="tiny muted pay-picks-foot">{payLaterLabel} — nothing to pay now.</p>
          ) : (
          collectOnly || upiOnly || prepaidOnly ? (
            <div className="co-row co-pay">
              <span className="co-row-icon" aria-hidden>
                ⚡
              </span>
              <span className="co-row-main">
                <strong>Pay by UPI</strong>
                <span className="tiny muted">
                  {canPayInApp ? 'GPay, PhonePe, Paytm — any UPI app' : `${cart.restaurantName} has not added a UPI ID yet`}
                </span>
              </span>
            </div>
          ) : (
          <>
          <p className="pay-head-label">Pay using</p>
          <div className="pay-picks">
            <button
              type="button"
              className={`pay-pick ${payNow ? 'on' : ''} ${canPayInApp ? '' : 'off'}`}
              onClick={() => canPayInApp && setPayNow(true)}
              disabled={!canPayInApp}
              aria-pressed={payNow}
            >
              <span className="pay-pick-icon" aria-hidden>
                ⚡
              </span>
              <strong>Any UPI app</strong>
              <span className="pay-pick-sub">
                {canPayInApp
                  ? `GPay, PhonePe, Paytm, FamApp — straight into ${cart.restaurantName}\u2019s account`
                  : `${cart.restaurantName} has not added a UPI ID to Khapee yet`}
              </span>
              <span className="pay-pick-dot" aria-hidden />
            </button>

            {/* UPI only: no cash row at all, not even a greyed-out one. */}
            {!collectOnly && !upiOnly && (
            <button
              type="button"
              className={`pay-pick ${payNow ? '' : 'on'} ${prepaidOnly ? 'off' : ''}`}
              onClick={() => !prepaidOnly && setPayNow(false)}
              disabled={prepaidOnly}
              aria-pressed={!payNow && !prepaidOnly}
            >
              <span className="pay-pick-icon" aria-hidden>
                💵
              </span>
              <strong>{payLaterLabel}</strong>
              <span className="pay-pick-sub">
                {/* Only shown when cash is a real choice; a pay-first order gets the single UPI line instead. */}
                {isDelivery
                  ? 'Cash or UPI when it reaches you'
                  : isCar
                    ? 'Cash or UPI at the car'
                    : isNearby
                      ? 'Cash or UPI when they hand it over'
                      : 'Cash or UPI at the counter'}
              </span>
              <span className="pay-pick-dot" aria-hidden />
            </button>
            )}
          </div>
          <p className="tiny muted pay-picks-foot">{paySub}</p>
          </>
          )
          )}

          <div className="co-bar">
          <div className="co-bar-total">
            <strong>{money(payableCents)}</strong>
            <span>{discountCents > 0 ? `you save ${money(discountCents)}` : 'total'}</span>
          </div>
          <button
            className="btn btn-accent btn-lg co-bar-btn"
            disabled={placing}
            onClick={() => {
              if (needsName) {
                document.getElementById('co-name')?.focus()
                toast('Add a name so the kitchen knows whose order it is.', 'info')
                return
              }
              if (needsPhone) {
                document.getElementById('co-phone')?.focus()
                toast('Add your mobile number so the restaurant can reach you.', 'info')
                return
              }
              if (needsTable) {
                if (!scannedIn) {
                  // The scanner, then straight on with the order.
                  setPlaceAfterVerify(true)
                  setVerifyOpen(true)
                  return
                }
                document.querySelector('.table-grid')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                toast('Tap your table number.', 'info')
                return
              }
              if (shortOfMinimum > 0) {
                toast(`Add ${money(shortOfMinimum)} more — ${dining?.areaName ?? 'this area'} has a minimum.`, 'info')
                return
              }
              if (needsProof) {
                // Only the code is missing — ask for it here and continue straight on.
                setPlaceAfterVerify(true)
                setVerifyOpen(true)
                return
              }
              if (payNow && canPayInApp) startPayment()
              else place()
            }}
          >
            {placing ? (
              <Spinner />
            ) : shortOfMinimum > 0 ? (
              `Add ${money(shortOfMinimum)} more`
            ) : needsTable && !scannedIn ? (
              'Scan table QR to order'
            ) : payNow && canPayInApp ? (
              `Pay ${money(payableCents)}`
            ) : (
              `Place order · ${money(payableCents)}`
            )}
          </button>
          </div>

          {!ready && !placing && (
            <p className="tiny muted center" style={{ marginTop: 10 }}>
              {needsName
                ? 'We just need a name for the order.'
                : needsPhone
                  ? 'Add your mobile number — the restaurant may need to ring.'
                  : needsTable
                  ? scannedIn
                    ? 'Tap your table number above.'
                    : 'Scan the QR on your table to order here.'
                  : "Tap above and we'll ask for the code — or switch to paying in the app."}
            </p>
          )}
        </section>

        <VerifyModal
          codesEnabled={options?.codesEnabled !== false}
          open={verifyOpen}
          onClose={() => setVerifyOpen(false)}
          restaurantId={restaurantId}
          onVerified={(s) => {
            setDining(s)
            if (s.tableId) {
              setTableId(s.tableId)
              setTableLabel(s.tableLabel)
            }
            if (placeAfterVerify) {
              setPlaceAfterVerify(false)
              // The session is proof enough now; send the order with it.
              setTimeout(() => place(undefined, s.token), 0)
            }
          }}
        />

        <Modal open={!!payRequest} onClose={() => setPayRequest(null)} title="Pay for your order">
          {payRequest && (
            <PayPanel
              amountCents={payRequest.amountCents}
              upiLink={payRequest.upiLink}
              payeeName={payRequest.payeeName}
              vpa={payRequest.vpa}
              busy={placing}
              onPaid={(upiRef) => place({ upiRef })}
              onCancel={() => setPayRequest(null)}
            />
          )}
        </Modal>
      </main>
    </div>
  )
}

/**
 * How long until they get there.
 *
 * Four answers, because in practice there are four: leaving now, a short
 * walk, a drive across town, and later than that. A time picker for a
 * question with four real answers is a keyboard nobody needed.
 */
const ARRIVE_CHOICES = [0, 15, 30, 45] as const

/** The clock time that many minutes from now, which is what people plan by. */
function clockIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
}
