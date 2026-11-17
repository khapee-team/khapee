import express from 'express'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { attachUser, purgeExpiredSessions } from './auth.ts'
import { canSeeInsights, exportCsv, hiddenCount, insights, liveCount, orderList, setHidden } from './insights.ts'
import { recordVisit, visitStats } from './visits.ts'
import { demoInsights, demoLive, demoOrders, demoVisits } from './insights-demo.ts'
import { db, UPLOAD_DIR, WRITES_ARE_TEMPORARY } from './db.ts'
import { addClient, heartbeat, removeClient } from './events.ts'
import { keepAwake } from './keep-awake.ts'
import { authRouter } from './routes/auth.ts'
import { publicRouter } from './routes/public.ts'
import { ordersRouter } from './routes/orders.ts'
import { staffRouter } from './routes/staff.ts'
import { orderFeedRouter } from './routes/order-feed.ts'
import { groupsRouter } from './routes/groups.ts'
import { sessionsRouter } from './routes/sessions.ts'
import { petpoojaRouter } from './routes/petpooja.ts'
import { ensureSeed } from './seed.ts'
import { importNewArrivals } from './new-arrivals.ts'
import { injectMeta, metaFor, robotsTxt, sitemapXml, structuredData } from './seo.ts'
import { thankPage } from './thank-page.ts'
import { contactCard } from './vcard.ts'
import { recordFault } from './faults.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// In development this is deliberately not `PORT` — dev harnesses set that for
// the web server, and the API would steal Vite's port. In production the app is
// served from this one process, so we honour the host's PORT.
const IS_PROD = process.env.NODE_ENV === 'production'
const PORT = Number((process.env.KHAPEE_PORT ?? process.env.TABLO_PORT) ?? (IS_PROD ? process.env.PORT ?? 4273 : 4273))
// Where customers reach the app (Vite in dev, this server once built).
const WEB_PORT = Number(process.env.TABLO_WEB_PORT ?? 5273)

// A database that was just filled with demo restaurants is not the live shop
// list, and the test suite counts what the seed put there — so real arrivals
// are only imported into a database that already existed.
const seededNow = ensureSeed()
if (!seededNow) importNewArrivals()
purgeExpiredSessions()

const app = express()
// A host like Render terminates TLS at its edge and forwards to us over plain
// HTTP, so req.protocol reads "http" for a request the customer made over
// https. Everything we build from it then carries the wrong scheme: canonical
// links telling Google to prefer a URL that only redirects, share previews, and
// the URLs printed inside zone QR codes. Trusting the proxy's
// X-Forwarded-Proto makes req.protocol the scheme the customer actually used.
//
// Only in production: in development nothing sits in front of us, and trusting
// a header anyone can set would let a caller claim any scheme or address.
if (IS_PROD) app.set('trust proxy', true)

// Generous enough for a downsized dish photo posted as a data URL.
app.use(express.json({ limit: '8mb' }))
app.use(attachUser)

// Restaurant and dish photos, stored on this machine only.
app.use('/api/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: true }))

/**
 * Nothing the API answers is ever worth re-reading from a cache.
 *
 * None of these responses carried a Cache-Control header, which does not mean
 * "do not cache" — with an ETag and no explicit freshness, a browser is free to
 * guess a lifetime and serve a menu it fetched earlier without asking. That is
 * how a price changed in the dashboard keeps showing the old figure on the
 * restaurant's own page: nothing is broken, the phone simply never asked
 * again. Menus, orders, codes and session state are all live by definition, so
 * say so once, here, rather than per route.
 */
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate')
  next()
})

app.get('/api/health', (_req, res) => {
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM restaurants) AS restaurants,
              (SELECT COUNT(*) FROM menu_items) AS items,
              (SELECT COUNT(*) FROM orders) AS orders`,
    )
    .get()
  res.json({ ok: true, ...(counts as object) })
})

/**
 * Addresses this machine is reachable on, so printed table QRs point somewhere
 * a phone can actually open (localhost only works on this computer).
 */
app.get('/api/network', (req, res) => {
  const nets = os.networkInterfaces()
  const urls: string[] = []
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${WEB_PORT}`)
    }
  }
  res.json({ localUrl: `http://localhost:${WEB_PORT}`, networkUrls: urls })
})

/* Petpooja's servers, which have no session and no account here. The random
   secret in the path is the whole credential — see server/routes/petpooja.ts. */
app.use('/api/petpooja', petpoojaRouter)

app.use('/api/auth', authRouter)
app.use('/api', publicRouter)
app.use('/api/orders', ordersRouter)
app.use('/api/sessions', sessionsRouter)
app.use('/api/groups', groupsRouter)
app.use('/api/staff', staffRouter)
// Authenticated by a billing key rather than a session — see routes/billing.ts.
app.use('/api/billing', orderFeedRouter)

/*
 * Khapee's own numbers, for whoever runs Khapee (KHAPEE_INSIGHTS_EMAILS).
 * Signed out gets 401 so the page can ask them to sign in; signed in as
 * anybody else gets 403 and nothing about any restaurant.
 */
function insightsGate(req: any, res: any): boolean {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to see Khapee insights.' })
    return false
  }
  if (!canSeeInsights(req.user)) {
    res.status(403).json({ error: 'This account cannot see Khapee insights.' })
    return false
  }
  return true
}
/*
 * The same page with sample orders in it — /insights/demo — for showing what
 * insights looks like with a month of business. Read from a separate database
 * in memory (see insights-demo.ts); the real numbers are never touched.
 * Open to anyone, no sign-in: it is all made up. /insights/real stays gated.
 */
const demoQuery = (req: any) => ({
  days: Number(req.query.days ?? 30),
  restaurantId: req.query.restaurant ? Number(req.query.restaurant) : null,
})
app.get('/api/insights/export', (req: any, res) => {
  if (!insightsGate(req, res)) return
  res.set('Cache-Control', 'no-store')
  res.type('text/csv').send(exportCsv())
})
app.get('/api/insights/demo', (req: any, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({ ...demoInsights(demoQuery(req)), hiddenOrders: 0, sample: true })
})
app.get('/api/insights/demo/live', (req: any, res) => {
  res.json(demoLive())
})
app.get('/api/insights/demo/orders', (req: any, res) => {
  res.json(demoOrders({ ...demoQuery(req), which: 'ahead', limit: req.query.limit ? Number(req.query.limit) : 50, offset: req.query.offset ? Number(req.query.offset) : 0 }))
})
app.get('/api/insights/demo/visits', (req: any, res) => {
  res.json(demoVisits(demoQuery(req)))
})
app.get('/api/insights/live', (req: any, res) => {
  if (!insightsGate(req, res)) return
  res.set('Cache-Control', 'no-store')
  res.json(liveCount())
})
app.get('/api/insights/orders', (req: any, res) => {
  if (!insightsGate(req, res)) return
  res.set('Cache-Control', 'no-store')
  const which = String(req.query.which ?? 'all')
  res.json(
    orderList({
      days: Number(req.query.days ?? 30),
      restaurantId: req.query.restaurant ? Number(req.query.restaurant) : null,
      which: which === 'ahead' || which === 'off' || which === 'hidden' ? which : 'all',
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    }),
  )
})
app.post('/api/insights/orders/:id/hide', (req: any, res) => {
  if (!insightsGate(req, res)) return
  const ok = setHidden(Number(req.params.id), req.body?.hidden !== false)
  if (!ok) return res.status(404).json({ error: 'That order is not in insights.' })
  res.json({ ok: true, hidden: hiddenCount() })
})
/*
 * One page view, sent by the browser as the customer moves around. Answers
 * 204 whatever happens: a visit that cannot be recorded is not the
 * customer's problem, and nothing about it should ever show on their screen.
 */
app.post('/api/visit', (req: any, res) => {
  try {
    recordVisit(req.body, String(req.headers['user-agent'] ?? ''))
  } catch {
    /* counting visits never gets in the way of the page */
  }
  res.status(204).end()
})
app.get('/api/insights/visits', (req: any, res) => {
  if (!insightsGate(req, res)) return
  res.set('Cache-Control', 'no-store')
  res.json(
    visitStats({
      days: Number(req.query.days ?? 30),
      restaurantId: req.query.restaurant ? Number(req.query.restaurant) : null,
    }),
  )
})
app.get('/api/insights', (req: any, res) => {
  if (!insightsGate(req, res)) return
  res.set('Cache-Control', 'no-store')
  res.json({
    ...insights({
      days: Number(req.query.days ?? 30),
      restaurantId: req.query.restaurant ? Number(req.query.restaurant) : null,
    }),
    hiddenOrders: hiddenCount(),
  })
})

/** Server-sent events keep the staff board live without any polling loop. */
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  res.write('retry: 3000\n\n')

  // Membership, not the account's original role — the same rule requireStaff
  // follows. An address that signed up as a customer and later took over a
  // restaurant has role 'customer' forever, and this line was reading that as
  // "not staff" and subscribing them to nothing: their board only ever changed
  // when they reloaded it by hand.
  /*
   * A customer with no account, following their own order.
   *
   * The receipt token is the same proof the tracking page already uses to
   * read the order, and it buys exactly one thing here: news about that
   * order. Anything else on this connection is still decided by the account.
   */
  let orderId: number | null = null
  const wantOrder = String(req.query.order ?? '').toUpperCase()
  const receipt = String(req.query.receipt ?? '')
  if (wantOrder && receipt) {
    const row = db
      .prepare('SELECT id FROM orders WHERE order_number = ? AND verify_token = ?')
      .get(wantOrder, receipt) as any
    orderId = row?.id ?? null
  }

  const client = addClient(res, {
    restaurantId: req.user?.restaurantId ?? null,
    userId: req.user?.id ?? null,
    orderId,
  })
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)

  req.on('close', () => removeClient(client))
})

setInterval(heartbeat, 25_000).unref?.()

/**
 * The restaurant's number as a contact card the phone can save in one tap.
 *
 * Served outside the API and outside the app for the same reason /thank is:
 * it has to be an ordinary link that a phone recognises by its content type,
 * not something a bundle has to boot before it can respond. See server/vcard.ts
 * for why this exists at all.
 */
app.get('/r/:id/khapee.vcf', (req, res) => {
  const row = db
    .prepare('SELECT name, phone FROM restaurants WHERE id = ?')
    .get(Number(req.params.id)) as any
  if (!row) return res.status(404).type('text/plain').send('No such restaurant.')
  const digits = String(row.phone ?? '').replace(/\D/g, '')
  // Offering a card with no number in it would save an entry that can do
  // nothing, which is worse than not offering one.
  if (digits.length < 10) return res.status(404).type('text/plain').send('No number to save.')

  res.set('Cache-Control', 'no-store')
  res.set('Content-Disposition', 'attachment; filename="khapee.vcf"')
  res.type('text/vcard; charset=utf-8').send(
    contactCard({ restaurant: row.name, phone: row.phone, website: `${req.protocol}://${req.get('host')}` }),
  )
})

/**
 * The one page that is not the app.
 *
 * Tapping "thank them" used to open a route inside the SPA, so the phone had to
 * fetch and start the whole application before it could read the address bar
 * and hand over to WhatsApp — seconds, on a host waking from sleep, staring at
 * nothing. This answers in one round trip with a document that redirects while
 * it is still being parsed. Deliberately above the static and shell handlers so
 * it wins, and outside the built-app check so it behaves the same in dev.
 */
app.get('/thank', (req, res) => {
  const q = req.query as Record<string, string | undefined>
  res.set('Cache-Control', 'no-store')
  res.type('html').send(thankPage(q.to ?? '', q.who ?? 'them', q.text ?? ''))
})

// Serve the built SPA when it exists (npm run build), otherwise Vite serves it in dev.
const dist = process.env.VERCEL
  ? path.resolve(process.cwd(), 'dist')
  : path.resolve(__dirname, '..', 'dist')
if (fs.existsSync(path.join(dist, 'index.html'))) {
  /** Whatever host the visitor actually used, so links and tags match it. */
  const originOf = (req: any) => `${req.protocol}://${req.get('host')}`

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(robotsTxt(originOf(req)))
  })
  app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml').send(sitemapXml(originOf(req)))
  })

  app.use(express.static(dist, { index: false }))

  // The shell is one file with one title. Crawlers and link previews get the
  // page's own title, description and picture written into it before it is
  // sent; the browser then renders the app over the top as usual.
  const shell = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')

  /**
   * Which build this server is serving.
   *
   * An installed app that is never closed never navigates, so it never asks
   * for the shell again and goes on running the JavaScript it started with —
   * for days. Everything shipped in the meantime is invisible to it, and the
   * faults it reports are from code that no longer exists, which is a very
   * expensive way to debug.
   *
   * The build's own asset name is the version: it is a content hash, so it
   * changes exactly when the code does and never otherwise. The running app
   * can read its own from the page it was loaded with and compare.
   */
  const build = (shell.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/) ?? [])[1] ?? 'dev'
  app.get('/api/version', (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({ build })
  })
  app.get(/^(?!\/api).*/, (req, res) => {
    const origin = originOf(req)
    const meta = metaFor(req.path, origin)
    let html = injectMeta(shell, meta, origin)
    const ld = structuredData(req.path, origin)
    if (ld) html = html.replace('</head>', `  <script type="application/ld+json">${ld}</script>\n  </head>`)
    // Ask every time.
    //
    // This page names the build it belongs to — the asset filenames are
    // content-hashed — and it carried an ETag with nothing said about
    // freshness, which does not mean "do not cache": a browser is then free to
    // guess a lifetime and keep serving the copy it already has. The effect is
    // a phone that is still running last week's app and cannot be told
    // otherwise, with no error anywhere to explain it. The ETag still saves
    // the bytes when nothing has changed.
    res.set('Cache-Control', 'no-cache')
    res.type('html').send(html)
  })
}

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }))

/**
 * The last resort, with something to quote.
 *
 * "Something went wrong on our side" is true, sympathetic, and completely
 * undiagnosable: it says the same thing for every fault on every route, so a
 * restaurant reporting it hands over no more than the fact that something
 * broke. The only way to find it afterwards is to guess what they were doing.
 *
 * Each failure now carries a short reference, printed beside the error and
 * the route it came from in the log. Six characters somebody can read down a
 * phone turns "it is not working" into a line in a file.
 *
 * The error itself is never sent back — a stack trace tells an attacker what
 * the server is built from, and tells the person reading it nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: any, res: any, _next: any) => {
  const ref = Math.random().toString(36).slice(2, 8).toUpperCase()
  const route = String(req?.originalUrl ?? '').split('?')[0]
  console.error(`[khapee] ${ref} ${req?.method} ${route}`, err)

  // Kept where the dashboard can show it, because a reference that can only
  // be resolved by reading a log file on a host the restaurant cannot reach
  // is most of a solution and none of an answer. See server/faults.ts.
  recordFault({
    reference: ref,
    at: new Date().toISOString(),
    method: String(req?.method ?? ''),
    route,
    message: String(err?.message ?? err ?? 'unknown'),
    restaurantId: req?.user?.restaurantId ?? null,
  })

  res.status(500).json({
    // The route is named: it is not a secret, it is the first thing anybody
    // debugging this asks for, and it saves a round trip of screenshots.
    error: `Something went wrong on our side (reference ${ref}) doing ${route}. Please try again, and quote that reference.`,
    reference: ref,
    route,
  })
})

// On serverless the platform owns the listener; everywhere else we bind here.
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ▲ Khapee API  →  http://localhost:${PORT}`)
    console.log(`    database   →  ${path.relative(process.cwd(), db.name)}`)
    keepAwake()

    /*
     * The one misconfiguration that looks like a bug in the product.
     *
     * Login tokens are signed so they outlive the database being rebuilt from
     * the snapshot. The signing key is KHAPEE_SECRET; without it the fallback
     * writes a key next to the database, which on a host with no disk is a new
     * key on every boot — and a new key signs every phone and every till out,
     * silently, several times a day. Nothing in the app misbehaves, so it gets
     * reported as "it keeps logging me out" and looked for in the wrong place.
     */
    if (!process.env.KHAPEE_SECRET && WRITES_ARE_TEMPORARY) {
      console.warn(
        [
          '',
          '  ⚠  KHAPEE_SECRET is not set, and this host keeps no disk.',
          '     Every restart makes a new signing key, so everyone signed in is',
          '     signed out again. Set KHAPEE_SECRET on the service — any long',
          '     random string, kept the same — and logins last a year.',
          '',
        ].join('\n'),
      )
    } else {
      console.log('')
    }
  })
}

export default app
