/**
 * Petpooja sandbox certification: places their five test orders and prints the
 * order IDs to send back to them.
 *
 *   PETPOOJA_APP_KEY=… PETPOOJA_APP_SECRET=… PETPOOJA_ACCESS_TOKEN=… \
 *     npx tsx scripts/petpooja-certify.ts
 *
 * The three keys are on the sandbox dashboard under Configuration (App Key,
 * App Secret, Access Token). The restID defaults to the mapping code Petpooja
 * issued (31zqndu7ar); set PETPOOJA_REST_ID to use another.
 *
 *   --dry-run          build and print the five payloads, send nothing
 *   --menu file.json   use a saved menu instead of fetching it
 *   --callback URL     where Petpooja should send accept / ready / cancel
 *                      (defaults to a URL that answers nothing)
 *   --curl             print the request instead of making it
 *   --with-keys        put the real credentials in that printed request
 *   --stamp XXXX       reuse the suffix of order IDs already sent, so the
 *                      printed request is the one they are asking about
 *
 * Their five scenarios, in their numbering:
 *   1) Items + Tax                       4) Item with Discount + Tax
 *   2) Item with the Addons + Tax        5) Item with Addon and Variation + Tax
 *   3) Item with the Variation + Tax
 *
 * Every payload is built by the same code that relays real Khapee orders
 * (buildRound and orderPayload in server/petpooja.ts), so what is certified is
 * what runs — not a hand-written imitation of it.
 */
import fs from 'node:fs'
import { buildRound, indiaTime, orderPayload } from '../server/petpooja.ts'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dryRun = args.includes('--dry-run')
/*
 * --curl prints the request rather than making it, because the first thing
 * Petpooja asks when they cannot find an order is to see the cURL. Pair it
 * with --stamp to reproduce orders already sent: the order IDs end in a
 * timestamp, so without it the printed request is for an order that does not
 * exist yet, which answers a different question than the one being asked.
 * Keys are left out unless --with-keys, so the output can be pasted anywhere.
 */
const asCurl = args.includes('--curl')
const withKeys = args.includes('--with-keys')

const restId = (process.env.PETPOOJA_REST_ID || '31zqndu7ar').trim()
const appKey = (process.env.PETPOOJA_APP_KEY || '').trim()
const appSecret = (process.env.PETPOOJA_APP_SECRET || '').trim()
const accessToken = (process.env.PETPOOJA_ACCESS_TOKEN || '').trim()
const base = (process.env.PETPOOJA_BASE_URL || 'https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1').replace(/\/+$/, '')
const callbackUrl = flag('--callback') || 'https://khapee.com/api/petpooja/sandbox-certification/callback'

if (!dryRun && !asCurl && (!appKey || !appSecret || !accessToken)) {
  console.error(
    '\n  Set PETPOOJA_APP_KEY, PETPOOJA_APP_SECRET and PETPOOJA_ACCESS_TOKEN first.' +
      '\n  They are on the sandbox dashboard, under Configuration.\n',
  )
  process.exit(1)
}

/* --- The menu ---------------------------------------------------------------- */

async function loadMenu(): Promise<any> {
  const file = flag('--menu')
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'))
  /*
   * The menu Petpooja last pushed to us, if they have.
   *
   * Preferred over asking for it, because their Fetch Menu API answers
   * "unable to fetch Object from s3 bucket" until a menu has been generated
   * at their end — and the push is what generates it. The copy that arrived
   * here is the one that definitely exists.
   */
  if (!args.includes('--fetch-menu')) {
    const { db } = await import('../server/db.ts')
    const row = db
      .prepare('SELECT last_menu_json FROM petpooja_links WHERE rest_id = ?')
      .get(restId) as any
    if (row?.last_menu_json) {
      console.log('  Using the menu Petpooja last pushed to Khapee.\n')
      return JSON.parse(row.last_menu_json)
    }
  }
  const res = await fetch(`${base}/mapped_restaurant_menus`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'app-key': appKey, 'app-secret': appSecret, 'access-token': accessToken },
    body: JSON.stringify({ restID: restId }),
  })
  const body: any = await res.json().catch(() => null)
  if (!res.ok || !body || String(body.success ?? '1') === '0') {
    console.error(`\n  Could not fetch the sandbox menu: ${body?.message ?? `HTTP ${res.status}`}`)
    console.error('  That message means no menu has been generated for this restID yet.')
    console.error('  Trigger Push Menu on the sandbox dashboard (Menu Management) and run this')
    console.error('  again — the pushed menu is kept and used automatically. Or pass one with')
    console.error('  --menu file.json.\n')
    process.exit(1)
  }
  return body
}

const menu = await loadMenu()
const items: any[] = Array.isArray(menu.items) ? menu.items : []
const groups = new Map<string, any>(
  (Array.isArray(menu.addongroups) ? menu.addongroups : []).map((g: any) => [String(g.addongroupid), g]),
)
const taxes = new Map<string, { name: string; rateBp: number }>(
  (Array.isArray(menu.taxes) ? menu.taxes : [])
    .filter((t: any) => String(t.taxtype ?? '1') === '1')
    .map((t: any) => [String(t.taxid), { name: String(t.taxname), rateBp: Math.round(Number(t.tax) * 100) }]),
)
const on = (v: unknown) => String(v ?? '1') !== '0'
const paise = (v: unknown) => Math.round(Number(v ?? 0) * 100)
const taxed = (i: any) => String(i.item_tax ?? '').split(',').some((id) => taxes.has(id.trim()))
const variations = (i: any) => (Array.isArray(i.variation) ? i.variation.filter((v: any) => on(v.active)) : [])
/*
 * A dish that can actually be charged for.
 *
 * Petpooja's sandbox menu has eighty-one items priced at zero that declare
 * variations and carry none, which is what a half-exported menu looks like
 * from this side. An order for one of them would be an order for nothing, and
 * it would be certified as correct.
 */
const sellable = (i: any) => paise(i.price) > 0 || variations(i).some((v: any) => paise(v.price) > 0)
const live = items.filter((i) => on(i.active) && String(i.in_stock ?? '2') !== '0' && sellable(i))
const addonLinks = (list: any) => (Array.isArray(list) ? list : []).filter((a: any) => groups.has(String(a.addon_group_id)))

/** The cheapest valid add-ons for a set of add-on links, honouring each minimum (at least one). */
function pickAddons(links: any[]): any[] {
  const out: any[] = []
  for (const l of links) {
    const g = groups.get(String(l.addon_group_id))
    const choices = (g.addongroupitems ?? []).filter((a: any) => on(a.active))
    const want = Math.max(1, Number(l.addon_item_selection_min ?? 0) || 0)
    const max = Number(l.addon_item_selection_max ?? 0) || 0
    for (const a of choices.slice(0, max ? Math.min(want, max) : want)) {
      out.push({
        posId: String(a.addonitemid),
        name: String(a.addonitem_name),
        priceCents: paise(a.addonitem_price),
        groupName: String(g.addongroup_name),
        posGroupId: String(g.addongroupid),
      })
    }
    if (out.length) break
  }
  return out
}

/** A line in the shape buildRound reads off an order_items row. */
function line(item: any, opts: { variation?: any; addons?: any[]; quantity?: number } = {}) {
  const addons = opts.addons ?? []
  const base = opts.variation ? paise(opts.variation.price) : paise(item.price)
  return {
    id: 0,
    name: String(item.itemname),
    quantity: opts.quantity ?? 1,
    unit_price_cents: base + addons.reduce((n, a) => n + a.priceCents, 0),
    pos_item_id: String(item.itemid),
    pos_tax_ids: String(item.item_tax ?? ''),
    variation_id: opts.variation ? 1 : null,
    variation_name: opts.variation ? String(opts.variation.name) : '',
    pos_variation_id: opts.variation ? String(opts.variation.id ?? opts.variation.variationid) : null,
    pos_global_id: opts.variation ? String(opts.variation.variationid ?? '') : '',
    addons: addons.length ? JSON.stringify(addons) : '',
  }
}

/* --- The five scenarios ------------------------------------------------------- */

/*
 * Case 1 wants a dish and its tax, nothing else. A menu where every priced
 * item also offers add-ons — which is every priced item in their sandbox — is
 * still fine for it: the add-ons are simply not ordered. Preferring one with
 * none keeps the case clean where the menu allows.
 */
const plain =
  live.find((i) => taxed(i) && !variations(i).length && !addonLinks(i.addon).length) ??
  live.find((i) => taxed(i) && !variations(i).length) ??
  live.find((i) => !variations(i).length)
// A different dish from case 1 where there is one, so the two cases do not read as the same order twice.
const withAddon =
  live.find((i) => i !== plain && !variations(i).length && on(i.itemallowaddon) && addonLinks(i.addon).length) ??
  live.find((i) => !variations(i).length && on(i.itemallowaddon) && addonLinks(i.addon).length)
const withVariation = live.find((i) => variations(i).some((v: any) => !addonLinks(v.addon).some((a: any) => Number(a.addon_item_selection_min) > 0)))
const withBoth =
  live.find((i) => variations(i).some((v: any) => addonLinks(v.addon).length)) ??
  live.find((i) => variations(i).length && on(i.itemallowaddon) && addonLinks(i.addon).length)

type Case = { n: number; title: string; lines: any[]; discountCents?: number }
const cases: Case[] = []
if (plain) cases.push({ n: 1, title: 'Items + Tax', lines: [line(plain, { quantity: 2 })] })
if (withAddon) cases.push({ n: 2, title: 'Item with the Addons + Tax', lines: [line(withAddon, { addons: pickAddons(withAddon.addon) })] })
if (withVariation) {
  const v = variations(withVariation).find((x: any) => !addonLinks(x.addon).some((a: any) => Number(a.addon_item_selection_min) > 0))
  cases.push({ n: 3, title: 'Item with the Variation + Tax', lines: [line(withVariation, { variation: v })] })
}
if (plain) {
  const l = line(plain, { quantity: 2 })
  // Ten per cent off the order, sent as the fixed amount it comes to.
  cases.push({ n: 4, title: 'Item with Discount + Tax', lines: [l], discountCents: Math.round(l.unit_price_cents * l.quantity * 0.1) })
}
if (withBoth) {
  const v = variations(withBoth).find((x: any) => addonLinks(x.addon).length) ?? variations(withBoth)[0]
  const links = addonLinks(v.addon).length ? v.addon : withBoth.addon
  cases.push({ n: 5, title: 'Item with Addon and Variation + Tax', lines: [line(withBoth, { variation: v, addons: pickAddons(links) })] })
}
cases.sort((a, b) => a.n - b.n)

const missing = [1, 2, 3, 4, 5].filter((n) => !cases.some((c) => c.n === n))
if (missing.length) {
  console.warn(`\n  The sandbox menu has nothing that fits case ${missing.join(', ')}; ` +
    'add a dish with add-ons / variations in the sandbox Menu Management and run again.')
}

/* --- Send them ------------------------------------------------------------------ */

const link = { restId, appKey, appSecret, accessToken } as any
const stamp = (flag('--stamp') || Date.now().toString(36)).toUpperCase()
const restaurant = { name: menu.restaurants?.[0]?.details?.restaurantname ?? 'Khapee sandbox', address: '', phone: '' }
const results: { n: number; title: string; orderId: string; petpoojaOrderId: string; ok: boolean; message: string }[] = []

for (const c of cases) {
  const orderId = `KHP${c.n}${stamp}`
  const round = buildRound(c.lines, taxes, { discountCents: c.discountCents ?? 0, deliveryCents: 0 })
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const payload = orderPayload(
    link,
    {
      order_number: orderId,
      customer_name: 'Khapee Test',
      contact_phone: '9999999999',
      service_mode: 'pickup',
      order_type: 'pickup',
      created_at: now,
      payment_status: 'PAID',
      note: `Certification case ${c.n}: ${c.title}`,
    },
    round,
    restaurant,
    callbackUrl,
  )

  if (asCurl) {
    const shown = withKeys
      ? payload
      : { ...payload, app_key: '<app_key>', app_secret: '<app_secret>', access_token: '<access_token>' }
    console.log(`# Case ${c.n}: ${c.title} — order ${orderId}`)
    console.log(
      `curl --location '${base}/save_order' \\\n` +
        `  --header 'Content-Type: application/json' \\\n` +
        `  --data '${JSON.stringify(shown).replace(/'/g, `'\\''`)}'\n`,
    )
    continue
  }

  if (dryRun) {
    console.log(`\n── Case ${c.n}: ${c.title} ──`)
    console.log(JSON.stringify({ ...payload, app_key: '…', app_secret: '…', access_token: '…' }, null, 2))
    continue
  }

  const res = await fetch(`${base}/save_order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body: any = await res.json().catch(() => ({}))
  const okay = res.ok && String(body?.success ?? '1') === '1'
  results.push({
    n: c.n,
    title: c.title,
    orderId,
    petpoojaOrderId: String(body?.orderID ?? ''),
    ok: okay,
    message: String(body?.message ?? `HTTP ${res.status}`),
  })
}

if (!dryRun && !asCurl) {
  console.log(`\n  Sent at ${indiaTime(new Date().toISOString())} IST to restID ${restId}\n`)
  for (const r of results) {
    console.log(
      `  ${r.ok ? '✓' : '✗'} ${r.n}) ${r.title.padEnd(36)} ${r.orderId}` +
        `${r.petpoojaOrderId ? `  (Petpooja #${r.petpoojaOrderId})` : ''}${r.ok ? '' : `  — ${r.message}`}`,
    )
  }
  fs.writeFileSync('petpooja-certification.json', JSON.stringify(results, null, 2))
  console.log('\n  Saved to petpooja-certification.json. These are the order IDs to send Petpooja.\n')
}
