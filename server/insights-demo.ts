/**
 * Sample insights: four months of made-up orders at five cafés, shaped to
 * show how a new way of ordering is taken up — the S-curve of adoption, the
 * hesitation at checkout, cash slowly giving way to UPI, staff getting quick,
 * and habit bringing people back. Illustrative only; none of it is real.
 *
 * Nothing here touches the real numbers. The sample is a separate database
 * held in memory, filled with made-up orders built from the real menus, and
 * the very same functions that read the real record read this one — so the
 * demo looks exactly like the real page and cannot drift from it. The page
 * that shows it says "Sample data" across the top.
 *
 * The orders are drawn from a fixed seed, so the sample is the same on every
 * reload; it is laid out over the last four months counted back from today.
 */
import Database from 'better-sqlite3'
import { db } from './db.ts'
import { insights, liveCount, orderList } from './insights.ts'
import { visitStats } from './visits.ts'

/** A small, fixed-seed random number generator (mulberry32). */
function seeded(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The cafés in the sample, each with the story it tells.
 *
 *   launch  days ago it started taking Khapee orders
 *   size    how busy it gets once people are used to it
 *   resist  how much its regulars hold back — cash, staff, habit (0..1)
 */
const PLACES: { slug: string; launch: number; size: number; resist: number }[] = [
  { slug: 'revery', launch: 120, size: 9, resist: 0.15 }, // young crowd, early adopters
  { slug: 'mr-beans-saket', launch: 75, size: 7, resist: 0.3 },
  { slug: 'shyam-sandwich', launch: 95, size: 6, resist: 0.55 }, // street-side, cash-first
  { slug: '28-paarroo', launch: 60, size: 4, resist: 0.35 },
  { slug: 'jain-shree', launch: 45, size: 3, resist: 0.75 }, // older, traditional regulars
]
const DAYS = 120

/** First names for the order list — sample names, not anybody's order. */
const NAMES = [
  'Aarav', 'Ananya', 'Rohan', 'Ishita', 'Kabir', 'Meera', 'Vihaan', 'Saanvi', 'Arjun', 'Diya', 'Aditya',
  'Kavya', 'Reyansh', 'Myra', 'Vivaan', 'Anika', 'Krish', 'Pari', 'Dhruv', 'Riya', 'Yash', 'Navya', 'Aryan',
  'Tara', 'Shaurya', 'Siya', 'Atharv', 'Kiara', 'Advait', 'Avni', 'Ayaan', 'Ira', 'Rudra', 'Aadhya', 'Parth',
  'Mahi', 'Laksh', 'Sara', 'Om', 'Prisha', 'Neel', 'Zara', 'Dev', 'Anvi', 'Kian', 'Mishka', 'Shiv', 'Inaya',
  'Ved', 'Jiya', 'Rishi', 'Aarohi', 'Ramesh', 'Sunita', 'Prakash', 'Kamla', 'Suresh', 'Geeta',
]
const INITIALS = 'ABCDGJKMPRSTV'

/** Hours people order at, weighted the way a café's day actually goes. */
const HOURS: [hour: number, weight: number][] = [
  [11, 3], [12, 5], [13, 6], [14, 4], [15, 3], [16, 4], [17, 6], [18, 8], [19, 10], [20, 11], [21, 9], [22, 5],
]

let cached: { built: string; d: Database.Database } | null = null

/** The sample database, built once a day. */
function sample(): Database.Database {
  const today = new Date().toISOString().slice(0, 10)
  if (cached?.built === today) return cached.d

  const d = new Database(':memory:')
  // The two record tables exactly as the real database has them.
  for (const name of ['order_facts', 'order_item_facts']) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as any
    d.exec(row.sql)
  }
  // Only what the read functions look at, from the rest.
  d.exec(`
    CREATE TABLE restaurants (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY);
    CREATE TABLE payments (order_id INTEGER, method TEXT);
  `)
  const visitsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_visits'").get() as any
  if (visitsSql) d.exec(visitsSql.sql)

  const rand = seeded(187)
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  const weighted = <T>(xs: [T, number][]) => {
    let r = rand() * xs.reduce((n, [, w]) => n + w, 0)
    for (const [x, w] of xs) if ((r -= w) <= 0) return x
    return xs[xs.length - 1][0]
  }
  const sqlTime = (t: Date) => t.toISOString().replace('T', ' ').slice(0, 19)
  const logistic = (x: number) => 1 / (1 + Math.exp(-x))
  /** A moment on a given day, at an India-time hour, stored as UTC. */
  const momentOn = (daysAgo: number, hour: number) => {
    const at = new Date(now - daysAgo * 86400000)
    at.setUTCHours(hour, Math.floor(rand() * 60), Math.floor(rand() * 60), 0)
    at.setTime(at.getTime() - 330 * 60000)
    if (at.getTime() > now) at.setTime(at.getTime() - 86400000)
    return at
  }

  const addFact = d.prepare(
    `INSERT INTO order_facts
       (order_id, restaurant_id, created_at, status, total_cents, payment_status, payment_method, service_mode,
        order_type, customer_key, accepted_at, order_number, customer_name, customer_phone, takeaway)
     VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
  )
  const addItem = d.prepare(
    `INSERT INTO order_item_facts (item_id, order_id, restaurant_id, name, quantity, unit_price_cents, accepted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  )
  const addPayment = d.prepare('INSERT INTO payments (order_id, method) VALUES (?, ?)')
  const addVisit = visitsSql
    ? d.prepare(
        `INSERT INTO page_visits (at, visitor, path, page, restaurant_id, source, referrer, landing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
    : null

  let orderId = 0
  let itemId = 0
  let visitorN = 0
  const now = Date.now()

  /*
   * The story, café by café and day by day:
   *  - Adoption follows an S-curve from the day a café starts: a slow start
   *    while people are unsure, a steep middle once it is normal, a plateau.
   *  - Most people who open the menu do not order the first time. They
   *    hesitate at checkout (resistance), more so at a traditional café, and
   *    less as the weeks go by and the thing becomes familiar.
   *  - Cash gives way to UPI in the app, slowly, and faster for regulars:
   *    trust is earned order by order.
   *  - Staff are slow to accept orders in the first weeks and quick later.
   *  - Habit: somebody who has ordered twice is far likelier to order again.
   */
  type Person = { key: string; name: string; orders: number }
  for (const place of PLACES) {
    const r = db.prepare('SELECT id, name, featured_items FROM restaurants WHERE slug = ?').get(place.slug) as any
    if (!r) continue
    const menu = db
      .prepare('SELECT id, name, price_cents FROM menu_items WHERE restaurant_id = ? AND is_available = 1 ORDER BY sort_order LIMIT 60')
      .all(r.id) as any[]
    if (!menu.length) continue
    d.prepare('INSERT INTO restaurants (id, name) VALUES (?, ?)').run(r.id, r.name)
    // A café's favourites are ordered far more than the rest of the menu.
    const favs = String(r.featured_items ?? '')
      .split(',')
      .map((x) => menu.find((m) => String(m.id) === x.trim()))
      .filter(Boolean)
    const pool: [any, number][] = menu.map((m, i) => [m, favs.includes(m) ? 9 : i < 8 ? 3 : 1])
    const regulars: Person[] = []

    for (let daysAgo = Math.min(place.launch, DAYS); daysAgo >= 0; daysAgo--) {
      const age = place.launch - daysAgo // days since this café started
      const familiar = logistic((age - 28) / 9) // 0 → 1 over the first two months
      const weekday = new Date(now - daysAgo * 86400000).getUTCDay()
      const weekend = weekday === 0 || weekday === 6 ? 1.4 : 1
      const expected = place.size * (0.12 + 0.88 * familiar) * (1 - 0.35 * place.resist) * weekend
      const orders = Math.max(0, Math.round(expected + (rand() - 0.5) * 2.2))

      // How many look, and how many get as far as checkout, for that many orders.
      const conversion = 0.1 + 0.3 * familiar * (1 - 0.5 * place.resist)
      const reachCheckout = 0.45 + 0.35 * familiar - 0.15 * place.resist
      const lookers = Math.round(orders / conversion + rand() * 3)

      for (let n = 0; n < orders; n++) {
        // Habit: the more someone has ordered, the likelier they are back.
        const back = regulars.filter((p) => rand() < Math.min(0.55, 0.05 + 0.14 * p.orders))
        const who: Person =
          back.length && rand() < 0.25 + 0.4 * familiar
            ? pick(back)
            : (() => {
                const p = {
                  key: `sample-${place.slug}-${regulars.length + 1}`,
                  name: `${pick(NAMES)} ${pick(INITIALS.split(''))}.`,
                  orders: 0,
                }
                regulars.push(p)
                return p
              })()
        who.orders += 1

        const at = momentOn(daysAgo, weighted(HOURS))
        orderId += 1
        // Regulars order a little more each time.
        const lines = 1 + Math.floor(rand() * rand() * (3 + Math.min(2, who.orders / 3)))
        let total = 0
        const chosen = new Set<number>()
        for (let l = 0; l < lines; l++) {
          const m = weighted(pool)
          if (chosen.has(m.id)) continue
          chosen.add(m.id)
          const qty = rand() < 0.8 ? 1 : 2
          total += m.price_cents * qty
          itemId += 1
          addItem.run(itemId, orderId, r.id, m.name, qty, m.price_cents, sqlTime(at))
        }
        const mode = weighted<string>([['', 7], ['takeaway', 2 + 2 * place.resist], ['car', 1]])
        // Paying in the app: low at first, rising with familiarity and with each order.
        const trust = 0.25 + 0.55 * familiar + 0.06 * Math.min(4, who.orders - 1) - 0.35 * place.resist
        const app = rand() < Math.max(0.08, Math.min(0.95, trust))
        // Staff learning: minutes at first, under a minute once it is routine.
        const acceptSecs = 25 + 260 * Math.exp(-age / 16) * (1 + place.resist) * (0.6 + rand() * 0.8)
        addFact.run(
          orderId,
          r.id,
          sqlTime(at),
          total,
          'PAID',
          app ? 'app' : 'cash',
          mode === 'car' ? 'car' : 'dine_in',
          'dine_in',
          who.key,
          sqlTime(new Date(at.getTime() + acceptSecs * 1000)),
          `K${String(1000 + orderId)}`,
          who.name,
          mode === 'takeaway' ? 1 : 0,
        )
        if (app) addPayment.run(orderId, 'upi')
        d.prepare('INSERT INTO orders (id) VALUES (?)').run(orderId)
      }

      // The funnel: everyone who looked, how far they got.
      if (addVisit) {
        const sources: [string, number][] = [
          ['qr', 40 + 25 * familiar],
          ['instagram', 16],
          ['direct', 8 + 8 * familiar],
          ['search', 9],
          ['whatsapp', 6 + 6 * familiar],
          ['app', 1 + 5 * familiar],
        ]
        for (let v = 0; v < lookers; v++) {
          const visitor = `sample-visitor-${++visitorN}`
          const source = weighted(sources)
          const at = momentOn(daysAgo, weighted(HOURS))
          const path = source === 'qr' ? '/t/sample' : source === 'search' ? '/' : `/r/${r.id}`
          const page = source === 'qr' ? 'table-qr' : path === '/' ? 'home' : 'menu'
          const referrer = source === 'instagram' ? 'instagram.com' : source === 'search' ? 'google.com' : ''
          addVisit.run(sqlTime(at), visitor, path, page, page === 'home' ? null : r.id, source, referrer, 1)
          let t = at.getTime()
          const step = (p: string, kind: string, rid: number | null) => {
            t += 20000 + rand() * 60000
            addVisit.run(sqlTime(new Date(Math.min(now, t))), visitor, p, kind, rid, source, '', 0)
          }
          if (page !== 'menu') step(`/r/${r.id}`, 'menu', r.id)
          const ordered = v < orders
          if (ordered || rand() < Math.max(0, (reachCheckout * lookers - orders) / Math.max(1, lookers - orders))) {
            step('/checkout', 'checkout', null)
          }
          if (ordered) step('/order/sample', 'order', null)
        }
      }
    }
  }

  cached = { built: today, d }
  return d
}

export const demoInsights = (opts: { days: number; restaurantId?: number | null }) => insights(opts, sample())
export const demoLive = () => liveCount(sample())
export const demoOrders = (opts: Parameters<typeof orderList>[0]) => orderList(opts, sample())
export const demoVisits = (opts: { days: number; restaurantId?: number | null }) => visitStats(opts, sample())
