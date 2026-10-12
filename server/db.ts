import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(__dirname, '..', 'data')
fs.mkdirSync(dataDir, { recursive: true })

/**
 * Serverless hosts (Vercel) give a read-only filesystem with only /tmp
 * writable, and that /tmp does not survive a cold start. So there we run on a
 * copy of the committed snapshot: the whole catalogue is browsable and the app
 * fully works, but anything written is scoped to that instance's lifetime.
 * A host with a real disk (see DEPLOY.md) keeps everything permanently.
 */
const SERVERLESS = !!process.env.VERCEL
const SNAPSHOT = path.join(dataDir, 'snapshot.db')

/**
 * A host with a real disk starts that disk empty, so its first boot would come
 * up with no restaurants at all. Seeding it from the committed snapshot brings
 * the published app up with the same catalogue as the local one, after which it
 * persists normally. Opt-in (render.yaml sets it) so tests and local dev, which
 * want a clean database, are never seeded behind their back.
 */
/*
 * Every name this app has been deployed under is still read.
 *
 * The variable is set on the live host, not in this repository, so renaming it
 * here and nowhere else would mean the next deploy came up with no
 * restaurants at all — an empty app behind a working domain. The new name is
 * preferred and the old one still answers, so the two can be changed on
 * different days without an outage in between.
 */
const SEED_FLAG = process.env.KHAPEE_SEED ?? process.env.ORDRO_SEED
/** Whoever is running this pointed us at a particular file. */
const DB_CHOSEN = process.env.KHAPEE_DB ?? process.env.TABLO_DB
const SEED_FROM_SNAPSHOT = SERVERLESS || SEED_FLAG === 'snapshot'

function resolveDbPath(): string {
  const set = process.env.KHAPEE_DB ?? process.env.TABLO_DB
  if (set) return path.resolve(set)
  if (SERVERLESS) return '/tmp/khapee.db'
  /*
   * The file was called tablo.db for as long as the app was called Tablo. A
   * machine that already has one keeps using it rather than waking up to an
   * empty database beside its real one — the rename is of the name, not of
   * anybody's data.
   */
  const now = path.join(dataDir, 'khapee.db')
  const before = path.join(dataDir, 'tablo.db')
  if (!fs.existsSync(now) && fs.existsSync(before)) return before
  return now
}

export const DB_PATH = resolveDbPath()
export const IS_EPHEMERAL = SERVERLESS && !(process.env.KHAPEE_DB ?? process.env.TABLO_DB)

/**
 * Whether anything written here outlives the container.
 *
 * It does not on a host that seeds itself from the committed snapshot and has
 * no disk mounted: the filesystem comes back empty on the next deploy, and on
 * a free plan every time the service wakes from sleeping. Menu edits made in
 * the dashboard are then quietly undone hours later, which is the worst way
 * for this to be found out. KHAPEE_DB pointing at a mounted disk is what makes
 * it permanent, so that is exactly the test.
 */
export const WRITES_ARE_TEMPORARY = SEED_FROM_SNAPSHOT && !(process.env.KHAPEE_DB ?? process.env.TABLO_DB)

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

/**
 * A fresh clone comes up with the catalogue, not with nothing.
 *
 * Cloning this repository and running it gave an app with no restaurants at
 * all, because the working database is deliberately not committed — only the
 * snapshot is. That looks exactly like a broken checkout, and the fix is a
 * line in a README that whoever hit it has not read yet.
 *
 * So: no database at all, and a snapshot sitting right there, means copy it.
 * Only when nothing has chosen a database file — tests point at their own and
 * want it empty, and this must never quietly fill one of those with
 * twenty-seven restaurants.
 */
const FIRST_RUN = !DB_CHOSEN && !fs.existsSync(DB_PATH) && fs.existsSync(SNAPSHOT)

if ((SEED_FROM_SNAPSHOT || FIRST_RUN) && !fs.existsSync(DB_PATH) && fs.existsSync(SNAPSHOT)) {
  fs.copyFileSync(SNAPSHOT, DB_PATH)
}

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
/**
 * Whether the database is being backed up continuously (scripts/start.sh).
 *
 * Litestream reads the database while the app writes to it, so a write may
 * briefly wait for it rather than fail with "database is locked".
 */
export const BACKED_UP = !!process.env.BACKUP_BUCKET
if (BACKED_UP) db.pragma('busy_timeout = 5000')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('customer','staff')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS restaurants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  address      TEXT    NOT NULL DEFAULT '',
  categories   TEXT    NOT NULL DEFAULT '',
  emoji        TEXT    NOT NULL DEFAULT '🍽️',
  hue          INTEGER NOT NULL DEFAULT 210,
  is_open      INTEGER NOT NULL DEFAULT 1,
  hours        TEXT    NOT NULL DEFAULT '9:00 AM – 11:00 PM',
  prep_minutes INTEGER NOT NULL DEFAULT 15,
  rating       REAL    NOT NULL DEFAULT 4.5,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS restaurant_staff (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  job_title     TEXT    NOT NULL DEFAULT 'Staff',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, restaurant_id)
);

CREATE TABLE IF NOT EXISTS menu_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id   INTEGER NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  price_cents   INTEGER NOT NULL,
  emoji         TEXT    NOT NULL DEFAULT '🍽️',
  hue           INTEGER NOT NULL DEFAULT 24,
  is_veg        INTEGER NOT NULL DEFAULT 1,
  is_available  INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  label         TEXT    NOT NULL,
  seats         INTEGER NOT NULL DEFAULT 4,
  token         TEXT    NOT NULL UNIQUE,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (restaurant_id, label)
);

CREATE TABLE IF NOT EXISTS access_codes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  code           TEXT    NOT NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT    NOT NULL,
  single_use     INTEGER NOT NULL DEFAULT 1,
  used_at        TEXT,
  used_by_order  INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  revoked_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_codes_code ON access_codes(code);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number    TEXT    NOT NULL UNIQUE,
  restaurant_id   INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name   TEXT    NOT NULL,
  order_type      TEXT    NOT NULL CHECK (order_type IN ('dine_in','pickup')),
  table_id        INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  table_label     TEXT,
  status          TEXT    NOT NULL DEFAULT 'NEW',
  payment_status  TEXT    NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PAID')),
  payment_method  TEXT    NOT NULL DEFAULT 'counter',
  total_cents     INTEGER NOT NULL DEFAULT 0,
  note            TEXT    NOT NULL DEFAULT '',
  verify_token    TEXT    NOT NULL,
  access_code_id  INTEGER REFERENCES access_codes(id) ON DELETE SET NULL,
  verified_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id  INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  emoji         TEXT    NOT NULL DEFAULT '🍽️',
  unit_price_cents INTEGER NOT NULL,
  quantity      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT    NOT NULL,
  actor      TEXT    NOT NULL DEFAULT 'system',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  order_id      INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL DEFAULT '',
  read_at       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

-- Every attempt to send the Khapee thank-you on WhatsApp, including the ones
-- that were never sent because the integration is switched off. Outbound
-- messaging fails quietly and at someone else's end; without a log the only
-- answer to "did my customer get it?" is a shrug.
-- Devices that have asked to be told when an order arrives. One row per
-- browser, not per person: the endpoint IS the device, which is why it is
-- unique and why re-subscribing moves it to whoever is signed in now.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  endpoint      TEXT    NOT NULL UNIQUE,
  p256dh        TEXT    NOT NULL,
  auth          TEXT    NOT NULL,
  failures      INTEGER NOT NULL DEFAULT 0,
  last_ok_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_restaurant ON push_subscriptions(restaurant_id);

-- A one-time link that puts order alerts on one phone without handing over the
-- dashboard password. It grants exactly one thing — the right to be notified —
-- and stops working the moment it is used or the moment it expires.
CREATE TABLE IF NOT EXISTS alert_invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  token         TEXT    NOT NULL UNIQUE,
  expires_at    TEXT    NOT NULL,
  used_at       TEXT,
  revoked_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The customer's own device, signed up from their order page. Kept against the
-- order rather than an account, because most people ordering never make one —
-- the receipt token they already hold is the proof it is theirs.
CREATE TABLE IF NOT EXISTS customer_push (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  endpoint     TEXT    NOT NULL UNIQUE,
  p256dh       TEXT    NOT NULL,
  auth         TEXT    NOT NULL,
  thanked_at   TEXT,
  failures     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_push_order ON customer_push(order_id);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  phone      TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL
);

-- A login token proves itself by its signature, so signing out cannot simply
-- forget the row: it has to say so. Not carried in the snapshot — a token that
-- outlives a rebuild is the point, and by then the browser holding a signed-out
-- one has long since thrown it away.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  token      TEXT    PRIMARY KEY,
  revoked_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
`)

/** Additive migrations so an existing database picks up new columns on boot. */
function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as any[]
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

addColumn('restaurants', 'image_path', 'TEXT')
addColumn('restaurants', 'phone', "TEXT NOT NULL DEFAULT ''")
addColumn('menu_items', 'image_path', 'TEXT')

// Service options each restaurant chooses to offer.
addColumn('restaurants', 'accepts_pickup', 'INTEGER NOT NULL DEFAULT 1')
addColumn('restaurants', 'accepts_takeaway', 'INTEGER NOT NULL DEFAULT 1')
addColumn('restaurants', 'accepts_groups', 'INTEGER NOT NULL DEFAULT 1')

// UPI collection details. Payment is a direct customer → restaurant UPI
// transfer; this app never touches the money, it only shows the request.
addColumn('restaurants', 'upi_vpa', "TEXT NOT NULL DEFAULT ''")
addColumn('restaurants', 'upi_name', "TEXT NOT NULL DEFAULT ''")

// The number the customer gave when ordering. delivery_phone only ever
// existed for the two modes that ask for an address, so a table or a pickup
// order carried no way to reach whoever placed it — and the WhatsApp message
// sent to that number could not be looked up afterwards or sent again.
addColumn('orders', 'contact_phone', "TEXT NOT NULL DEFAULT ''")

// Where order alerts are emailed. Blank means the owner's own address.
addColumn('restaurants', 'order_email', "TEXT NOT NULL DEFAULT ''")

// A device that follows every restaurant on Khapee, not one of them. For
// whoever runs the platform rather than a kitchen: they want the whole board,
// and a subscription per restaurant would have to be redone every time one
// joined.
addColumn('push_subscriptions', 'all_restaurants', 'INTEGER NOT NULL DEFAULT 0')
addColumn('alert_invites', 'all_restaurants', 'INTEGER NOT NULL DEFAULT 0')

// A code that can be used more than once, for the handful of phones a
// restaurant sets up itself. Spending a code on first use is right for one
// handed to somebody else; it is wrong for the owner's own phones, which have
// to be put back every time the server forgets them — and it is what stopped a
// phone repairing itself quietly, because the code it held was already spent.
addColumn('alert_invites', 'reusable', 'INTEGER NOT NULL DEFAULT 0')

// How a device came to be on the alert list — signed in, or handed a one-time
// invite — so an owner reading the list can tell one from the other.
addColumn('push_subscriptions', 'label', "TEXT NOT NULL DEFAULT ''")

/**
 * Whether this device also wants the WhatsApp thank-you nudge.
 *
 * Two different people are holding these phones. The person running the
 * business wants both: the order, and the prompt to thank the customer on
 * WhatsApp afterwards. The kitchen wants the order and nothing else — a
 * second notification per order, about a message they are never going to
 * send, is how a counter learns to ignore the first one.
 *
 * Off by default, so every restaurant added from here on gets order alerts
 * only, and the handful of devices that want the WhatsApp prompt turn it on
 * for themselves.
 */
addColumn('push_subscriptions', 'wants_whatsapp', 'INTEGER NOT NULL DEFAULT 0')

/**
 * Half open.
 *
 * A kitchen closes before the room does. The chef goes home, the espresso
 * machine is cleaned down, and for the last two hours the only thing anybody
 * can still be served is something out of the fridge. Until now Khapee had two
 * states for that — open, and closed — so a restaurant in exactly this
 * position either turned everything off and lost the dessert trade, or left
 * everything on and spent the evening ringing people to say no.
 *
 * Switched on, two things change together, and they belong together: only the
 * sections marked as still available can be ordered, and the order has to be
 * paid for in the app. The second is not an afterthought. A kitchen with no
 * kitchen staff left cannot afford somebody who ordered and never came, and
 * the whole reason a place stays half open is that the margin is thin enough
 * to matter.
 *
 * Which sections survive is the restaurant's choice, not a hardcoded idea of
 * what a dessert is. For Revery it is the dessert menu; for somebody else it
 * is drinks, or the bakery counter.
 */
addColumn('restaurants', 'limited_mode', 'INTEGER NOT NULL DEFAULT 0')
addColumn('menu_categories', 'limited_ok', 'INTEGER NOT NULL DEFAULT 0')

/**
 * The order is now waiting on the customer, not on the kitchen.
 *
 * A restaurant can turn down one dish out of five — the paneer has gone, the
 * rest is fine — and until now that happened silently. The customer had
 * agreed to one order and was going to be handed a different, smaller one,
 * with a different total, having never been asked. That is somebody else
 * editing your order after you placed it.
 *
 * Set when a dish is refused, cleared when the customer says go ahead. While
 * it is set the order says so on every screen it appears on, and the customer
 * gets a notification, because the one person who has to agree to this is the
 * one who is not in the building.
 */
addColumn('orders', 'needs_customer_ok', 'TEXT')
// The kitchen asking for payment up front on a car order — see askForPrepay.
addColumn('orders', 'needs_prepay', 'TEXT')
// The dishes a restaurant wants at the top of its menu as "Most ordered here",
// as comma-separated menu item ids. Empty means work it out from real orders.
addColumn('restaurants', 'featured_items', "TEXT NOT NULL DEFAULT ''")
/** What they are being asked about, so the question survives a page reload. */
addColumn('orders', 'declined_items', "TEXT NOT NULL DEFAULT ''")
/**
 * When the customer said go ahead without it.
 *
 * The kitchen has to be able to see that answer. Without it the board showed
 * a refused dish and then, once the customer replied, went back to looking
 * like an ordinary untouched order — so whoever was deciding whether to cook
 * could not tell "they have agreed to the smaller order" from "nobody has
 * answered yet", which is the one thing they need to know.
 */
addColumn('orders', 'customer_ok_at', 'TEXT')
/** Set when an unanswered order was sent again, pointing at its replacement. */
addColumn('orders', 'resent_as', 'TEXT')

/**
 * Whether this restaurant hands out typed codes at all.
 *
 * Two ways exist to prove somebody is actually in the room: they scanned the
 * QR on their table, or a staff member read them a six-character code. The
 * code was built for a counter with no printed QR on the tables, and it costs
 * something real — a member of staff has to be found, and the code can be
 * passed to somebody who is not there.
 *
 * A restaurant with a QR on every table does not need it, and for them the
 * second option is a worse path offered beside a better one. Off here means
 * the customer is only ever shown the scanner.
 */
addColumn('restaurants', 'codes_enabled', 'INTEGER NOT NULL DEFAULT 1')

/**
 * Whether an order to a car has to be paid for before it is made.
 *
 * Every other way of ordering ends with the customer inside the building: a
 * table has to be settled before anybody leaves, a counter order is handed
 * over in exchange for the money. A car is the one place where the food is
 * carried out to somebody already sitting in the thing they will leave in,
 * and a kitchen that has cooked it has no way to be made whole.
 *
 * Off by default, because most restaurants are happy to take the money at
 * the window and a rule imposed on all of them would be a rule none of them
 * asked for.
 */
addColumn('restaurants', 'car_prepaid_only', 'INTEGER NOT NULL DEFAULT 0')

/**
 * Ordering before you set off, and deciding on arrival.
 * ---------------------------------------------------------------------------
 * Somebody at home orders a coffee and a sandwich from a cafe twenty minutes
 * away. The kitchen's problem is knowing when to start it; the customer's
 * problem is that they have not yet decided whether they are taking it with
 * them or sitting down with it, and will not decide until they are standing
 * in the doorway looking at whether there is a free table.
 *
 * Forcing that choice at checkout got it wrong half the time, and a wrong
 * answer is a cup in a paper bag for somebody who wanted to sit, or a tray
 * for somebody in a hurry. So the order carries no answer until they arrive
 * and give one — which is also the moment the counter most wants to hear
 * from them.
 */
/**
 * The same rule as a car, for an order collected from the counter.
 *
 * Somebody who ordered from home and has not arrived is, to a kitchen, the
 * same risk as somebody sitting in a car: the food is made before anybody has
 * paid, and if they never turn up the restaurant carries it. A cafe that is
 * happy to take the money at the counter leaves this off; one that has been
 * burned turns it on.
 */
addColumn('restaurants', 'takeaway_prepaid_only', 'INTEGER NOT NULL DEFAULT 0')

/*
 * A restaurant that does not take cash at all, in any mode.
 *
 * The flags above it are per-mode, because for most places paying afterwards
 * is fine at a table and risky at a kerb. A few run the other way: everything
 * is paid for in the app, and a counter that is never asked to handle notes
 * never has to count a till, never argues about change, and never carries an
 * order somebody walked away from. One switch rather than one per mode,
 * because "we do not take cash" is a single fact about a business.
 *
 * It applies only where there is a UPI ID to pay into. A restaurant with no
 * way to be paid in the app and no cash accepted could take no orders at all.
 */
addColumn('restaurants', 'cash_disabled', 'INTEGER NOT NULL DEFAULT 0')

/*
 * How often a scratch card is won: 0 never, 1 every order, 2 every second,
 * and so on. Off everywhere until a restaurant turns it on, because it is
 * their margin being given away and nobody else's.
 */
addColumn('restaurants', 'scratch_every', 'INTEGER NOT NULL DEFAULT 0')


/* What a scratch card took off this order, and which card it was. */
addColumn('orders', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0')
addColumn('orders', 'scratch_card_id', 'INTEGER')

addColumn('orders', 'arrived_at', 'TEXT')
/** What they chose on the doorstep: 'takeaway' or 'dine_in'. */
addColumn('orders', 'arrival_choice', 'TEXT')

/**
 * What a sign-in is tied to, instead of the password itself.
 *
 * A session token was signed over the account's password hash, so that
 * changing a password threw every other device off. Good property, wrong
 * ingredient — on this deployment the database is rebuilt from the committed
 * snapshot on every restart, and if the live hash had moved on from the
 * snapshot's, every token for that account stopped verifying. Restaurants
 * were being signed out mid-service by a deploy, with nothing to explain it.
 *
 * A number that only changes when somebody deliberately changes their
 * password keeps the property and survives the rebuild, because it is a
 * column in the snapshot like any other.
 */
addColumn('users', 'session_epoch', 'INTEGER NOT NULL DEFAULT 1')

// Where a restaurant sits in the list, above the usual alphabetical order.
// Zero for almost everywhere; a higher number comes first. It exists because
// "the one you open the app to see" is a decision somebody makes, not
// something the alphabet or a distance happens to get right.
addColumn('restaurants', 'top_rank', 'INTEGER NOT NULL DEFAULT 0')

// Where the restaurant is, for "near me" sorting. Filled in by the restaurant.
addColumn('restaurants', 'city', "TEXT NOT NULL DEFAULT ''")
addColumn('restaurants', 'lat', 'REAL')
addColumn('restaurants', 'lng', 'REAL')

// When the restaurant first went live. Set the first time its owner finishes
// the details form with a dish on the menu, and never cleared after that —
// closing for the night is `is_open`, which is a different thing entirely.
addColumn('restaurants', 'published_at', 'TEXT')
// Reachable by its link, left off the list on the front page — for a place
// that shares its own link rather than wanting to be found by browsing.
addColumn('restaurants', 'unlisted', 'INTEGER NOT NULL DEFAULT 0')
// An email Google has confirmed the person owns, and their Google account id —
// set by "Continue with Google" (routes/auth.ts). What a restaurant offer for
// one email domain is checked against, because anyone can type an address.
addColumn('users', 'verified_email', "TEXT NOT NULL DEFAULT ''")
addColumn('users', 'google_sub', 'TEXT')
// Not open yet and about to be: says "Coming soon" where a shut place says "Closed".
addColumn('restaurants', 'coming_soon', 'INTEGER NOT NULL DEFAULT 0')
// Off for a place that takes no orders at its tables — takeaway and the car only.
addColumn('restaurants', 'accepts_dine_in', 'INTEGER NOT NULL DEFAULT 1')

// A dine-in order the customer is carrying out rather than eating at a table.
addColumn('orders', 'takeaway', 'INTEGER NOT NULL DEFAULT 0')
addColumn('orders', 'group_session_id', 'INTEGER')
addColumn('order_items', 'member_id', 'INTEGER')
addColumn('order_items', 'paid_at', 'TEXT')

// One account can both order as a customer and run restaurants, so the
// dashboard needs to know which of their restaurants is currently in view.
addColumn('users', 'active_restaurant_id', 'INTEGER')

// A restaurant can carry its own look on its page — see src/lib/themes.ts.
// Empty means the standard one, which is what almost every restaurant wants.
addColumn('restaurants', 'theme', "TEXT NOT NULL DEFAULT ''")
// --- Service modes: inside, roadside/car, takeaway ---------------------------
// A restaurant that serves cars parked outside is a common shape in Indore, and
// it is the same restaurant — one menu, one kitchen, one board — so this is a
// mode on a session rather than a second product.
addColumn('restaurants', 'accepts_car', 'INTEGER NOT NULL DEFAULT 0')

// An order carries where it is going, so the board never has to join to find out.
addColumn('orders', 'service_mode', "TEXT NOT NULL DEFAULT 'dine_in'")
addColumn('orders', 'zone_id', 'INTEGER')
addColumn('orders', 'dining_session_id', 'INTEGER')
addColumn('orders', 'runner_id', 'INTEGER')
addColumn('orders', 'delivered_at', 'TEXT')

// --- Billing identity, which not every restaurant has ------------------------
addColumn('restaurants', 'legal_name', "TEXT NOT NULL DEFAULT ''")
addColumn('restaurants', 'gstin', "TEXT NOT NULL DEFAULT ''")
addColumn('restaurants', 'state_code', "TEXT NOT NULL DEFAULT ''")
addColumn('restaurants', 'invoice_prefix', "TEXT NOT NULL DEFAULT 'ORD'")
// Off by default: a small place with no GST registration must still be able to
// bill, and showing a tax line it cannot legally charge would be worse.
addColumn('restaurants', 'tax_enabled', 'INTEGER NOT NULL DEFAULT 0')

// A dish can name its tax treatment; without one it takes the restaurant default.
addColumn('menu_items', 'tax_rate_id', 'INTEGER')

// The financial state of an order, which is not the same as its kitchen state.
addColumn('orders', 'bill_status', "TEXT NOT NULL DEFAULT 'OPEN'")
addColumn('orders', 'invoice_id', 'INTEGER')

// Not every restaurant delivers, and a cafe with no space for it should not be
// asked to answer requests it never wanted.
addColumn('restaurants', 'accepts_delivery', 'INTEGER NOT NULL DEFAULT 0')

// Where the food is going, and who to call when the runner cannot find it.
addColumn('orders', 'delivery_area_id', 'INTEGER')
addColumn('orders', 'delivery_address', "TEXT NOT NULL DEFAULT ''")
addColumn('orders', 'delivery_phone', "TEXT NOT NULL DEFAULT ''")
addColumn('orders', 'accepted_at', 'TEXT')
// Said out loud to the customer when the kitchen cannot take an order.
addColumn('orders', 'declined_reason', "TEXT NOT NULL DEFAULT ''")
// Standing somewhere in a precinct rather than at a table, in a car, or at an
// address: the landmark they chose, and whatever they added so the runner can
// pick them out of the people standing at it.
addColumn('orders', 'precinct_id', 'INTEGER')
addColumn('orders', 'spot_id', 'INTEGER')
// Two different things, and the runner needs both. Where they are — a listed
// landmark, or their own words when none of them fit — is delivery_address.
// What to look for once you are standing there is this.
addColumn('orders', 'look_for', "TEXT NOT NULL DEFAULT ''")
// The matching columns on dining_sessions live further down, after that table
// is created — a migration above its own CREATE TABLE runs against nothing.

// What the area charged to carry it, copied onto the order when it is placed.
// Read from the order and never from the area again: a restaurant that raises
// its fee next month must not change what a customer already agreed to pay.
addColumn('orders', 'delivery_fee_cents', 'INTEGER NOT NULL DEFAULT 0')

// A named group inside a section — a bar list is "Whisky", "Gin", "Beer"
// under one Bar heading, rather than eight tabs of three drinks each.
addColumn('menu_items', 'group_label', "TEXT NOT NULL DEFAULT ''")
// A dish the restaurant is running this month.
addColumn('menu_items', 'is_special', 'INTEGER NOT NULL DEFAULT 0')
// Items a waiter added at the table rather than the customer through the app.
addColumn('order_items', 'added_by_staff', 'INTEGER NOT NULL DEFAULT 0')
/**
 * Whether the kitchen will make this particular dish.
 *
 * NULL until somebody says — which is nearly always, because the ordinary
 * answer to an order is yes to all of it. 1 is yes, 0 is "we have run out".
 *
 * Deliberately per item rather than per order: the thing that actually
 * happens at eight in the evening is that one dish is off and the rest is
 * fine, and until now the only answers the board could give were yes to
 * everything and no to everything. Refusing the whole order because the
 * paneer has gone sends away a table that would happily have eaten the rest.
 */
addColumn('order_items', 'accepted', 'INTEGER')
// Bill printed / settled at the counter.
addColumn('orders', 'bill_closed_at', 'TEXT')

/**
 * When the customer wants it, which is the whole point of Khapee.
 *
 * Every order until now meant "as fast as you can", and that is the one thing
 * the product is not for. Somebody leaving the office at 9:10 does not want
 * their food ready at 9:11 and sitting under a lamp for twenty minutes; they
 * want it ready at 9:30, when they walk in. The kitchen wants the same thing
 * for the opposite reason — knowing an order is for half past lets them cook
 * it at twenty past instead of dropping what they are doing.
 *
 * NULL means as soon as possible, which keeps every order ever placed valid
 * and keeps the common case free of ceremony. UTC, like every other time in
 * this database; the display side converts.
 */
addColumn('orders', 'wanted_at', 'TEXT')

/**
 * Petpooja, the till half the kitchens in Indore already run.
 *
 * The integration is deliberately one row per restaurant rather than a global
 * switch. Petpooja issues one set of application credentials to Khapee and
 * then maps each restaurant to a restID of its own, so the thing that varies
 * between two restaurants is the restID and nothing else — and a restaurant
 * that does not run Petpooja simply has no row here and never touches any of
 * it.
 *
 * The credentials are columns as well as environment variables. They belong
 * in the environment for a single deployment, but a restaurant occasionally
 * gets its own key pair from Petpooja, and having nowhere to put it would
 * mean a redeploy to onboard one kitchen.
 *
 * webhook_secret is what makes the endpoints Petpooja calls safe. Their
 * documentation gives those endpoints no authentication at all — they simply
 * POST a restID — so the secret lives in the URL we hand them, which means a
 * stranger who guesses a restID still cannot push a menu or cancel an order.
 * One per restaurant, so a leak is contained to that one.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS petpooja_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id   INTEGER NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  rest_id         TEXT    NOT NULL,
  menusharing_code TEXT   NOT NULL DEFAULT '',
  app_key         TEXT    NOT NULL DEFAULT '',
  app_secret      TEXT    NOT NULL DEFAULT '',
  access_token    TEXT    NOT NULL DEFAULT '',
  webhook_secret  TEXT    NOT NULL UNIQUE,
  enabled         INTEGER NOT NULL DEFAULT 1,
  push_orders     INTEGER NOT NULL DEFAULT 1,
  last_menu_at    TEXT,
  last_order_at   TEXT,
  last_error      TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_petpooja_rest ON petpooja_links(rest_id);
`)
/*
 * The last menu Petpooja pushed, exactly as they sent it.
 *
 * applyMenuPush reads the payload and throws it away, which is right for the
 * menu itself — the rows it wrote are the menu now. But certification builds
 * its five test orders out of Petpooja's own item, variation and add-on IDs,
 * and their Fetch Menu API answers "unable to fetch Object from s3 bucket"
 * until a menu has been generated at their end. Keeping the push means the
 * one copy that definitely exists is the one that already arrived here.
 */
addColumn('petpooja_links', 'last_menu_json', 'TEXT')

/**
 * The other system's ids, kept beside our own.
 *
 * An order pushed to Petpooja has to name their item ids, not ours, and a
 * menu they push back has to update the dish it is actually about rather than
 * adding a second copy of it every time. So each row that can come from a POS
 * carries the id it has over there, and nothing else about it changes.
 */
addColumn('menu_items', 'pos_item_id', 'TEXT')
addColumn('menu_items', 'pos_tax_ids', "TEXT NOT NULL DEFAULT ''")
addColumn('menu_categories', 'pos_category_id', 'TEXT')
addColumn('orders', 'pos_order_id', 'TEXT')
addColumn('orders', 'pos_pushed_at', 'TEXT')
addColumn('orders', 'pos_error', "TEXT NOT NULL DEFAULT ''")
/*
 * Which Petpooja order carried this line.
 *
 * Their API is one KOT per order, confirmed by Petpooja directly: a table that
 * orders again later becomes a second order over there, against the same
 * table. Ours is the other way round — one order accumulates rounds all
 * evening — so the two only line up if the unit we send is the round rather
 * than the order. Stamped per line because the round is exactly "the lines
 * that have not gone yet", and anything coarser sends somebody's starters to
 * the kitchen twice.
 */
addColumn('order_items', 'pos_order_id', 'TEXT')
addColumn('order_items', 'pos_pushed_at', 'TEXT')

/*
 * Variations and add-ons: "Half / Full", "Small / Large", "Extra cheese".
 *
 * Petpooja menus carry both, and an order relayed to their till has to name
 * the exact variation and add-ons the customer chose, by Petpooja's own ids —
 * so they are kept here as they arrive on the menu push, and a dish line on an
 * order remembers what was picked and what it cost at the time.
 *
 * A dish's price on menu_items stays its base price. A dish with variations is
 * priced by the variation chosen; add-ons are added on top. Every place an
 * order is priced does it through server/menu-options.ts, so the checkout, the
 * UPI request and the till all agree on one number.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS menu_item_variations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_item_id     INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  group_name       TEXT    NOT NULL DEFAULT '',
  price_cents      INTEGER NOT NULL,
  is_available     INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  pos_variation_id TEXT,
  pos_global_id    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_variations_item ON menu_item_variations(menu_item_id);

CREATE TABLE IF NOT EXISTS menu_addon_groups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  pos_group_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_addon_groups_restaurant ON menu_addon_groups(restaurant_id);

CREATE TABLE IF NOT EXISTS menu_addon_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      INTEGER NOT NULL REFERENCES menu_addon_groups(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  price_cents   INTEGER NOT NULL DEFAULT 0,
  is_available  INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  pos_addon_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_addon_items_group ON menu_addon_items(group_id);

-- Which add-on groups a dish offers, and how many may be picked from each.
-- variation_id set: the group belongs to that variation only.
CREATE TABLE IF NOT EXISTS menu_item_addon_groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id      INTEGER NOT NULL REFERENCES menu_addon_groups(id) ON DELETE CASCADE,
  variation_id  INTEGER REFERENCES menu_item_variations(id) ON DELETE CASCADE,
  min_select    INTEGER NOT NULL DEFAULT 0,
  max_select    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_item_addon_groups_item ON menu_item_addon_groups(menu_item_id);

-- Petpooja's own taxes (CGST 2.5%, SGST 2.5%…), by their id, from the menu push.
CREATE TABLE IF NOT EXISTS pos_taxes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  pos_tax_id     TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  rate_bp        INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (restaurant_id, pos_tax_id)
);
`)
// What was picked on this line, kept as it was when ordered.
addColumn('order_items', 'variation_id', 'INTEGER')
addColumn('order_items', 'variation_name', "TEXT NOT NULL DEFAULT ''")
addColumn('order_items', 'addons', "TEXT NOT NULL DEFAULT ''")
// Taken off the order as a whole (a fixed amount in paise), sent to the till as such.
addColumn('orders', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0')
// The restaurant offer this order was given, if any (server/offers.ts).
addColumn('orders', 'offer_percent', 'INTEGER NOT NULL DEFAULT 0')
addColumn('orders', 'offer_email', "TEXT NOT NULL DEFAULT ''")
/* Their name for the table, which is the one their till knows it by. A dine-in
   order names a table in table_no, and a name we invented is a table they do
   not have. */
addColumn('restaurant_tables', 'pos_table_id', 'TEXT')
db.exec('CREATE INDEX IF NOT EXISTS idx_menu_items_pos ON menu_items(restaurant_id, pos_item_id)')
// The kitchen's queue is sorted by it, so it is worth an index the moment a
// restaurant has a day's worth of orders rather than a demo's worth.
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_wanted ON orders(restaurant_id, wanted_at)')

// --- Billing, tax and invoicing ---------------------------------------------
//
// The financial side is deliberately separate from the operational one. An
// order is what the customer asked for and orders already track their own
// fulfilment; an invoice is a finalised legal document that must never change
// afterwards, even when the menu or the tax configuration does.
db.exec(`
CREATE TABLE IF NOT EXISTS tax_rates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  -- Basis points, so 5% is 500 and the rate is never a float.
  rate_bp       INTEGER NOT NULL,
  hsn_sac       TEXT    NOT NULL DEFAULT '',
  -- Whether menu prices under this rate already contain the tax.
  inclusive     INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tax_rates_restaurant ON tax_rates(restaurant_id);

-- One row per restaurant per financial year. Incremented inside the same
-- transaction that writes the invoice, so two terminals cannot take one number.
CREATE TABLE IF NOT EXISTS invoice_sequences (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  fy            TEXT    NOT NULL,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, fy)
);

CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id       INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  session_id     INTEGER REFERENCES dining_sessions(id) ON DELETE SET NULL,
  number         TEXT    NOT NULL,
  fy             TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'FINAL' CHECK (status IN ('FINAL','VOID')),
  service_mode   TEXT    NOT NULL DEFAULT 'dine_in',
  place_label    TEXT    NOT NULL DEFAULT '',
  customer_name  TEXT    NOT NULL DEFAULT '',
  customer_phone TEXT    NOT NULL DEFAULT '',
  -- Every figure below is paise, and every one is a snapshot.
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  charge_cents   INTEGER NOT NULL DEFAULT 0,
  taxable_cents  INTEGER NOT NULL DEFAULT 0,
  cgst_cents     INTEGER NOT NULL DEFAULT 0,
  sgst_cents     INTEGER NOT NULL DEFAULT 0,
  igst_cents     INTEGER NOT NULL DEFAULT 0,
  rounding_cents INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  -- Who the restaurant was, legally, at the moment this was issued.
  seller_snapshot TEXT   NOT NULL DEFAULT '{}',
  discount_reason TEXT   NOT NULL DEFAULT '',
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  voided_at      TEXT,
  voided_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason    TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(restaurant_id, number);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id     INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  hsn_sac        TEXT    NOT NULL DEFAULT '',
  quantity       INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  gross_cents    INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  taxable_cents  INTEGER NOT NULL,
  tax_rate_bp    INTEGER NOT NULL DEFAULT 0,
  cgst_cents     INTEGER NOT NULL DEFAULT 0,
  sgst_cents     INTEGER NOT NULL DEFAULT 0,
  igst_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);

-- Financial actions are never overwritten; they are appended to.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name    TEXT    NOT NULL DEFAULT '',
  action        TEXT    NOT NULL,
  entity        TEXT    NOT NULL,
  entity_id     INTEGER,
  detail        TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_restaurant ON audit_log(restaurant_id, created_at);
`)

// Where a restaurant is willing to deliver. Named areas rather than a radius:
// a small kitchen knows "Saket" and does not know 2.4 km, and a customer picking
// their own locality from a short list beats typing an address we cannot check.
db.exec(`
CREATE TABLE IF NOT EXISTS delivery_areas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  note           TEXT    NOT NULL DEFAULT '',
  fee_cents      INTEGER NOT NULL DEFAULT 0,
  min_order_cents INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_areas_restaurant ON delivery_areas(restaurant_id);
`)

db.exec(`
CREATE TABLE IF NOT EXISTS service_zones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  note          TEXT    NOT NULL DEFAULT '',
  token         TEXT    NOT NULL UNIQUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_service_zones_restaurant ON service_zones(restaurant_id);
`)

db.exec(`
-- A precinct: one stretch of a city where the restaurants are close enough
-- together that a waiter can walk an order out and back.
--
-- 140 in Indore already works this way without an app. You stand outside one
-- café, ring another, and somebody carries your food over — then walks back a
-- second time to be paid, and sometimes a third to ask what you meant. The
-- machinery for it already exists here, because eating in a parked car is the
-- same problem: somebody has to leave the counter and find a person who is not
-- at a table. This gives that a name, a map of places to stand, and a list of
-- restaurants willing to come to them.
CREATE TABLE IF NOT EXISTS precincts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  city       TEXT    NOT NULL DEFAULT 'Indore',
  note       TEXT    NOT NULL DEFAULT '',
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Somewhere inside it a person can be found: a shopfront, a bench, a corner.
-- A landmark rather than an address, because nobody standing in 140 has one.
CREATE TABLE IF NOT EXISTS precinct_spots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  precinct_id INTEGER NOT NULL REFERENCES precincts(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- Which restaurants will carry an order out into it. Opt-in: a kitchen with
-- one person on a Sunday should be able to stop without leaving the precinct.
CREATE TABLE IF NOT EXISTS restaurant_precincts (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  precinct_id   INTEGER NOT NULL REFERENCES precincts(id) ON DELETE CASCADE,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (restaurant_id, precinct_id)
);

CREATE TABLE IF NOT EXISTS photo_library (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  file          TEXT    NOT NULL,
  source        TEXT    NOT NULL DEFAULT 'upload',
  assigned_item INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photo_library_restaurant ON photo_library(restaurant_id);
`)

db.exec(`
CREATE TABLE IF NOT EXISTS dining_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT    NOT NULL UNIQUE,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id       INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  table_label    TEXT,
  access_code_id INTEGER REFERENCES access_codes(id) ON DELETE SET NULL,
  source         TEXT    NOT NULL DEFAULT 'code' CHECK (source IN ('code','table_qr','payment')),
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT    NOT NULL,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_dining_sessions_restaurant ON dining_sessions(restaurant_id);

CREATE TABLE IF NOT EXISTS group_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id      INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  table_label   TEXT,
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  status        TEXT    NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT
);

CREATE TABLE IF NOT EXISTS group_members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  display_name TEXT    NOT NULL,
  token        TEXT    NOT NULL UNIQUE,
  is_host      INTEGER NOT NULL DEFAULT 0,
  joined_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_group_members_session ON group_members(session_id);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  session_id    INTEGER REFERENCES group_sessions(id) ON DELETE SET NULL,
  member_id     INTEGER REFERENCES group_members(id) ON DELETE SET NULL,
  payer_name    TEXT    NOT NULL DEFAULT '',
  amount_cents  INTEGER NOT NULL,
  method        TEXT    NOT NULL DEFAULT 'upi',
  status        TEXT    NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED','CONFIRMED','REJECTED')),
  upi_ref       TEXT    NOT NULL DEFAULT '',
  covers        TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  settled_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id, status);
`)

// Money actually taken, and how much of it was cash handed over.
addColumn('payments', 'tendered_cents', 'INTEGER')
addColumn('payments', 'change_cents', 'INTEGER')
addColumn('payments', 'taken_by', 'INTEGER')
addColumn('payments', 'invoice_id', 'INTEGER')
addColumn('payments', 'refund_of', 'INTEGER')
addColumn('payments', 'reason', "TEXT NOT NULL DEFAULT ''")

/**
 * A payment outlives the order it came from.
 *
 * payments.order_id was NOT NULL, while invoices.order_id is ON DELETE SET
 * NULL — deliberately, because an invoice is a record of something that
 * happened and must survive the order being cleared off a board. The two
 * rules together mean that taking payment on an invoice whose order has gone
 * fails with a constraint error, which reaches the cashier as "something went
 * wrong on our side" while they are standing in front of a customer holding
 * cash. That is precisely what happened once Clear history existed.
 *
 * The invoice is the thing a payment belongs to; the order is where it came
 * from and may legitimately be gone. So the column becomes nullable, which
 * SQLite can only do by rebuilding the table — done once, guarded, and with
 * foreign keys off so the copy does not trip the cascades it is preserving.
 */
const paymentsOrderIdNotNull = (
  db.prepare('PRAGMA table_info(payments)').all() as any[]
).some((c) => c.name === 'order_id' && c.notnull === 1)

if (paymentsOrderIdNotNull) {
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    db.exec(`
      CREATE TABLE payments_rebuilt (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
        session_id    INTEGER REFERENCES group_sessions(id) ON DELETE SET NULL,
        member_id     INTEGER REFERENCES group_members(id) ON DELETE SET NULL,
        payer_name    TEXT    NOT NULL DEFAULT '',
        amount_cents  INTEGER NOT NULL,
        method        TEXT    NOT NULL DEFAULT 'upi',
        status        TEXT    NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED','CONFIRMED','REJECTED')),
        upi_ref       TEXT    NOT NULL DEFAULT '',
        covers        TEXT    NOT NULL DEFAULT '',
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        settled_at    TEXT,
        tendered_cents INTEGER,
        change_cents  INTEGER,
        taken_by      INTEGER,
        invoice_id    INTEGER,
        refund_of     INTEGER,
        reason        TEXT    NOT NULL DEFAULT ''
      );
      INSERT INTO payments_rebuilt
        (id, order_id, session_id, member_id, payer_name, amount_cents, method, status, upi_ref,
         covers, created_at, settled_at, tendered_cents, change_cents, taken_by, invoice_id,
         refund_of, reason)
      SELECT id, order_id, session_id, member_id, payer_name, amount_cents, method, status, upi_ref,
             covers, created_at, settled_at, tendered_cents, change_cents, taken_by, invoice_id,
             refund_of, reason
        FROM payments;
      DROP TABLE payments;
      ALTER TABLE payments_rebuilt RENAME TO payments;
      CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id, status);
    `)
  })()
  db.pragma('foreign_keys = ON')
}


// A dining session already stood for "these people, here, now". It now also
// stands for a car at the roadside: same session, different place.
addColumn('dining_sessions', 'service_mode', "TEXT NOT NULL DEFAULT 'dine_in'")
addColumn('dining_sessions', 'zone_id', 'INTEGER')
// …and for someone standing somewhere in a precinct: the landmark they picked.
addColumn('dining_sessions', 'precinct_id', 'INTEGER')
addColumn('dining_sessions', 'spot_id', 'INTEGER')
addColumn('dining_sessions', 'look_for', "TEXT NOT NULL DEFAULT ''")
addColumn('dining_sessions', 'vehicle', "TEXT NOT NULL DEFAULT ''")
addColumn('dining_sessions', 'vehicle_number', "TEXT NOT NULL DEFAULT ''")
// What staff and customer say to each other out loud: "Car 27".
addColumn('dining_sessions', 'seq_no', 'INTEGER')
addColumn('dining_sessions', 'code', "TEXT NOT NULL DEFAULT ''")
// Set when a staff member opened this for someone with no phone.
addColumn('dining_sessions', 'opened_by', 'INTEGER')
addColumn('dining_sessions', 'party_size', 'INTEGER NOT NULL DEFAULT 1')
// A car that moves keeps its session; the zone is corrected, not recreated.
addColumn('dining_sessions', 'moved_at', 'TEXT')

// A delivery is the same session again — these people, now — standing at their
// own address rather than at a table or on the road outside.
addColumn('dining_sessions', 'area_id', 'INTEGER')
addColumn('dining_sessions', 'address', "TEXT NOT NULL DEFAULT ''")
addColumn('dining_sessions', 'phone', "TEXT NOT NULL DEFAULT ''")

/**
 * Handing an order to whatever the restaurant already bills on.
 *
 * There is no standard for this. A kitchen in Indore might run Petpooja or
 * POSist, a Windows billing program from 2011, a spreadsheet, or a notebook —
 * and Khapee cannot integrate with each of them, nor should it try: an
 * integration per product is a list that is never finished and is wrong the
 * week a restaurant switches.
 *
 * So the order is published in the three shapes that between them reach
 * anything. A webhook pushes each order to a URL as it happens, which is what
 * a modern POS wants. A key lets a system that cannot receive a push pull
 * instead, which is what an on-premises till wants. And a CSV covers the rest,
 * including the notebook. The restaurant chooses; Khapee depends on none of
 * them and nothing here is billed to anybody.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS pos_hooks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Where each order is POSTed. Empty means the push half is switched off,
  -- which is the default and is a perfectly good state: the pull key and the
  -- CSV still work.
  url           TEXT    NOT NULL DEFAULT '',
  -- Signs the body so the receiver can tell a real delivery from anybody who
  -- has guessed the URL. Without this a webhook is an open endpoint that
  -- accepts orders from strangers.
  secret        TEXT    NOT NULL DEFAULT '',
  -- For the other direction: a till that polls rather than listens.
  api_key       TEXT    NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_key ON pos_hooks(api_key) WHERE api_key <> '';

-- What was sent and what came back.
--
-- A webhook that stops arriving is silent at both ends: the kitchen believes
-- the till has the order and the till never heard of it. This is the only
-- place anybody can find out, so it records the refusals as well as the
-- successes, and keeps the reason rather than the fact of failure.
CREATE TABLE IF NOT EXISTS pos_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  order_number  TEXT    NOT NULL DEFAULT '',
  event         TEXT    NOT NULL,
  url           TEXT    NOT NULL DEFAULT '',
  ok            INTEGER NOT NULL DEFAULT 0,
  code          INTEGER,
  error         TEXT    NOT NULL DEFAULT '',
  attempts      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pos_deliveries ON pos_deliveries(restaurant_id, id DESC);

-- The UPI accounts a restaurant can be paid into.
--
-- One was assumed, and one is not what a small restaurant has. The counter has
-- a Paytm card propped against the till, the owner has a personal ID, and
-- there is usually a third belonging to whoever is actually standing there on
-- a Sunday. Which one is shown changes — the card gets swapped, an account
-- gets frozen, the owner wants today's takings somewhere specific — and with a
-- single field that meant retyping a VPA from a phone screen and mistyping it,
-- which sends a customer's money to a stranger.
--
-- So they are all kept, and one is marked as the one customers are shown.
-- restaurants.upi_vpa still holds that choice, because every payment path
-- already reads it; this table is where the choice comes from.
CREATE TABLE IF NOT EXISTS restaurant_upi (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  vpa           TEXT    NOT NULL,
  display_name  TEXT    NOT NULL DEFAULT '',
  label         TEXT    NOT NULL DEFAULT '',
  is_active     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upi_vpa ON restaurant_upi(restaurant_id, vpa);

-- A kitchen ticket: what was sent to the range, and when.
--
-- A KOT is not a bill and not an order. It is one round of an evening — the
-- drinks, then the starters, then the food somebody added at nine — and the
-- kitchen needs each round on its own slip while the table needs all of them
-- added up at the end. Without a record of which items went on which ticket,
-- reprinting a KOT reprints the whole table, and the range gets a second copy
-- of food it cooked an hour ago.
CREATE TABLE IF NOT EXISTS kots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq_no        INTEGER NOT NULL,
  note          TEXT    NOT NULL DEFAULT '',
  printed_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kots_order ON kots(order_id, id);

CREATE TABLE IF NOT EXISTS kot_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kot_id        INTEGER NOT NULL REFERENCES kots(id) ON DELETE CASCADE,
  order_item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  quantity      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kot_items ON kot_items(kot_id);
`)

// Which round of the kitchen each item went out on, so a reprint is a reprint
// of that round and not of the whole table.
addColumn('order_items', 'kot_id', 'INTEGER')

export const UPLOAD_DIR = SERVERLESS ? '/tmp/uploads' : path.join(path.dirname(DB_PATH), 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

/*
 * Photos uploaded from the dashboard, kept in the database as well as on disk.
 *
 * Only when the database is backed up. The backup follows the database file,
 * not the uploads folder beside it, and the host wipes that folder on every
 * restart — so a photo that lived only there was gone by morning. The copy in
 * here comes back with the database and is written back to disk on boot. The
 * disk is still what serves them, so how an image reaches a phone is unchanged.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS upload_files (
  name       TEXT PRIMARY KEY,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)
/*
 * One-off changes to the live data, each applied exactly once.
 *
 * With the database backed up and restored on every start, the committed
 * snapshot no longer reaches the live site, so a change to what is in the
 * data (rather than to the code) has to be made here. Each one is recorded
 * by name when it runs and never runs again, so an owner who changes the same
 * thing afterwards in their dashboard is not overruled at the next restart.
 * Live host only (BACKED_UP): tests and local copies keep their own data.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS data_fixes (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)
function dataFix(name: string, apply: () => void) {
  if (db.prepare('SELECT 1 FROM data_fixes WHERE name = ?').get(name)) return
  db.transaction(() => {
    apply()
    db.prepare('INSERT INTO data_fixes (name) VALUES (?)').run(name)
  })()
  console.log(`[data] applied ${name}`)
}
if (BACKED_UP) {
  // Only Revery is taking orders for now; every other place shows Closed
  // until its owner opens it from the dashboard.
  dataFix('2026-09-26-only-revery-open', () => {
    db.prepare("UPDATE restaurants SET is_open = CASE WHEN slug = 'revery' THEN 1 ELSE 0 END").run()
  })
  // Khapee does not deliver yet: orders are takeaway, from the car, or at the
  // restaurant. Revery was left with a live delivery area from testing, which
  // put delivery on offer. Off everywhere; a restaurant can switch it back on
  // from its own settings when it really delivers.
  // Revery's own picks for "Most ordered here", and its sections in the order
  // it wants them read: Maggi, Nachos, Quick Bites, Rice Bowls first, then the
  // rest of the food, then drinks, then desserts. Matched by name so it does
  // not depend on ids. Any section not named keeps its place after these.
  dataFix('2026-09-29-revery-featured-and-order', () => {
    const r = db.prepare("SELECT id FROM restaurants WHERE slug = 'revery'").get() as any
    if (!r) return
    const pick = (name: string) =>
      (db.prepare('SELECT id FROM menu_items WHERE restaurant_id = ? AND lower(name) = lower(?)').get(r.id, name) as any)?.id
    const featured = ['Chocolate Strawberry', 'Peri-Peri Cheese Maggi', "Bhatia's Bowl (Fully Loaded)"]
      .map(pick)
      .filter(Boolean)
    db.prepare('UPDATE restaurants SET featured_items = ? WHERE id = ?').run(featured.join(','), r.id)

    const order = [
      'Maggi', 'Nachos', 'Quick Bites', 'Rice Bowls', 'Fries', 'Wraps', 'Burgers', 'Pizza', 'Garlic Bread',
      'Open Toast', 'Sandwiches', 'Special Buns', 'Pasta',
      'Hot Coffee', 'Cold Coffee', 'Shakes', 'Iced Tea', 'Mocktails', 'Red Bull',
      'Desserts',
    ]
    const sections = db
      .prepare('SELECT id, name FROM menu_categories WHERE restaurant_id = ? ORDER BY sort_order, id')
      .all(r.id) as { id: number; name: string }[]
    const rank = (n: string) => {
      const i = order.findIndex((o) => o.toLowerCase() === n.trim().toLowerCase())
      return i === -1 ? order.length : i
    }
    const sorted = sections
      .map((c, i) => ({ ...c, i }))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i)
    const set = db.prepare('UPDATE menu_categories SET sort_order = ? WHERE id = ?')
    sorted.forEach((c, n) => set.run(n, c.id))
  })
  /*
   * One Eighty Seven Grams — a small-batch bakery (cloud kitchen, Indore and
   * Bangalore), on Khapee with its own look (theme 'grams'). Collect-only:
   * no tables, no car, no delivery. Added closed: takeaway is paid by UPI and
   * the bakery's UPI ID is not set yet, so it opens from its own dashboard
   * once that is in. Prices are placeholders the bakery will set itself.
   */
  dataFix('2026-10-04-add-187-grams', () => {
    if (db.prepare("SELECT 1 FROM restaurants WHERE slug = '187-grams'").get()) return
    const r = db
      .prepare(
        `INSERT INTO restaurants
           (slug, name, description, address, categories, emoji, hue, is_open, hours, prep_minutes, city, theme,
            accepts_pickup, accepts_takeaway, accepts_car, accepts_groups, accepts_delivery, codes_enabled, published_at)
         VALUES ('187-grams', '187 Grams', 'Small-batch bakes from a Le Cordon Bleu–trained kitchen.', 'Indore',
                 'Bakery, Desserts', '🍪', 50, 0, '11:00 AM – 9:00 PM', 30, 'Indore', 'grams',
                 1, 0, 0, 0, 0, 0, datetime('now'))`,
      )
      .run()
    const restaurantId = Number(r.lastInsertRowid)
    const menu: { section: string; items: [string, string, number, string][] }[] = [
      { section: 'Cookie Tins', items: [['Kinder Bueno Cookie Tin', 'A tin of chewy cookies, loaded with Kinder Bueno.', 120000, '🍪']] },
      { section: 'Bars', items: [['Belgian Chocolate French Biscuit Bar', 'Buttery French biscuit under a thick layer of Belgian chocolate.', 100000, '🍫']] },
      { section: 'Jars', items: [['Biscoff Raspberry Jar', 'Biscoff crumb, cream and sharp raspberry, layered in a jar.', 110000, '🫙']] },
      { section: 'Granola', items: [['Granola', 'House-baked, clustered granola. Good with yoghurt, better by the handful.', 100000, '🥣']] },
      { section: 'Bento Cakes', items: [['Customised Bento Cake', 'A little cake in a box, made to your message and colours. Tell us in the note.', 150000, '🎂']] },
    ]
    const addSection = db.prepare('INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (?, ?, ?)')
    const addItem = db.prepare(
      `INSERT INTO menu_items (restaurant_id, category_id, name, description, price_cents, emoji, hue, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 50, ?)`,
    )
    menu.forEach((m, i) => {
      const c = addSection.run(restaurantId, m.section, i)
      m.items.forEach(([name, desc, cents, emoji], j) => addItem.run(restaurantId, Number(c.lastInsertRowid), name, desc, cents, emoji, j))
    })
  })
  // 187 Grams has no reviews, so it shows no score — the 4.5 was the column's
  // default, not anything a customer said. Collect-only and paid up front.
  dataFix('2026-10-04-187-grams-no-rating', () => {
    db.prepare(
      `UPDATE restaurants
          SET rating = 0, accepts_pickup = 1, accepts_takeaway = 0, accepts_car = 0,
              accepts_groups = 0, accepts_delivery = 0, takeaway_prepaid_only = 1
        WHERE slug = '187-grams'`,
    ).run()
  })
  // 187 Grams takes orders from its own link, not from Khapee's front page.
  dataFix('2026-10-04-187-grams-unlisted', () => {
    db.prepare("UPDATE restaurants SET unlisted = 1 WHERE slug = '187-grams'").run()
  })
  // Revery's sixth table, with the token its printed QR card carries. If a
  // Table 6 was already added from the dashboard it takes this token, since
  // these are the cards going on the tables.
  dataFix('2026-10-04-revery-table-6', () => {
    const r = db.prepare("SELECT id FROM restaurants WHERE slug = 'revery'").get() as any
    if (!r) return
    const t6 = db.prepare("SELECT id FROM restaurant_tables WHERE restaurant_id = ? AND label = 'Table 6'").get(r.id) as any
    if (t6) db.prepare('UPDATE restaurant_tables SET token = ? WHERE id = ?').run('1be9748ea2db49f7', t6.id)
    else db.prepare("INSERT INTO restaurant_tables (restaurant_id, label, seats, token) VALUES (?, 'Table 6', 4, ?)").run(r.id, '1be9748ea2db49f7')
  })
  /*
   * A test café for Petpooja's sandbox, for Mr. Beans Saket's integration.
   *
   * The sandbox is a demo restaurant with a demo menu. Linked to the real Mr.
   * Beans Saket, its menu push would put that demo menu on their page and take
   * their own dishes off — so the sandbox is linked here instead: unlisted,
   * closed, and open to the people who run Khapee (KHAPEE_INSIGHTS_EMAILS) from
   * their own dashboard, where Settings → Petpooja takes the sandbox keys and
   * shows the webhook URLs. The keys are typed there, never kept in code.
   * restID 31zqndu7ar is the mapping code Petpooja issued for the sandbox.
   */
  dataFix('2026-10-08-petpooja-sandbox-cafe', () => {
    let r = db.prepare("SELECT id FROM restaurants WHERE slug = 'petpooja-sandbox'").get() as any
    if (!r) {
      const info = db
        .prepare(
          `INSERT INTO restaurants
             (slug, name, description, address, categories, emoji, hue, is_open, hours, prep_minutes, city,
              accepts_pickup, accepts_takeaway, accepts_car, accepts_groups, accepts_delivery, codes_enabled, unlisted, rating)
           VALUES ('petpooja-sandbox', 'Mr. Beans Saket — Petpooja test', 'Petpooja sandbox testing. Not a real café.',
                   'Indore', 'Cafe', '🧪', 260, 0, '9:00 AM – 11:00 PM', 20, 'Indore', 1, 1, 0, 0, 0, 0, 1, 0)`,
        )
        .run()
      r = { id: Number(info.lastInsertRowid) }
    }
    const emails = String(process.env.KHAPEE_INSIGHTS_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
    for (const email of emails) {
      const u = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email) as any
      if (u) db.prepare("INSERT OR IGNORE INTO restaurant_staff (user_id, restaurant_id, job_title) VALUES (?, ?, 'Owner')").run(u.id, r.id)
    }
    if (!db.prepare('SELECT 1 FROM petpooja_links WHERE restaurant_id = ?').get(r.id)) {
      db.prepare(
        `INSERT INTO petpooja_links (restaurant_id, rest_id, webhook_secret, enabled, push_orders)
         VALUES (?, '31zqndu7ar', ?, 1, 1)`,
      ).run(r.id, crypto.randomBytes(24).toString('base64url'))
    }
  })
  /*
   * Mr. Beans Saket's new menu, from FINAL SAKET MENU.pdf, as written out in
   * data/mrbeans-saket-oct-2026.json: 20 sections, add-ons and choices as the
   * printed menu offers them. Replaces the old menu outright — none of it had
   * photographs, and past orders keep their own copy of each dish's name.
   * Egg dishes are marked non-veg and say "Contains egg."; Khapee has only
   * veg and non-veg.
   */
  dataFix('2026-10-08-mr-beans-saket-menu', () => {
    const r = db.prepare("SELECT id FROM restaurants WHERE slug = 'mr-beans-saket'").get() as any
    if (!r) return
    const spec = JSON.parse(fs.readFileSync(path.join(dataDir, 'mrbeans-saket-oct-2026.json'), 'utf8'))
    const rid = r.id
    db.prepare(
      'DELETE FROM menu_item_addon_groups WHERE menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = ?)',
    ).run(rid)
    db.prepare('DELETE FROM menu_item_variations WHERE menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = ?)').run(rid)
    db.prepare('DELETE FROM menu_addon_items WHERE group_id IN (SELECT id FROM menu_addon_groups WHERE restaurant_id = ?)').run(rid)
    db.prepare('DELETE FROM menu_addon_groups WHERE restaurant_id = ?').run(rid)
    db.prepare('DELETE FROM menu_items WHERE restaurant_id = ?').run(rid)
    db.prepare('DELETE FROM menu_categories WHERE restaurant_id = ?').run(rid)

    const groupId = new Map<string, { id: number; max: number }>()
    let g = 0
    for (const [key, grp] of Object.entries<any>(spec.addonGroups)) {
      const gid = Number(
        db.prepare('INSERT INTO menu_addon_groups (restaurant_id, name, sort_order) VALUES (?, ?, ?)').run(rid, grp.name, g++)
          .lastInsertRowid,
      )
      grp.items.forEach(([name, rupees]: [string, number], n: number) =>
        db.prepare('INSERT INTO menu_addon_items (group_id, name, price_cents, sort_order) VALUES (?, ?, ?, ?)').run(gid, name, rupees * 100, n),
      )
      groupId.set(key, { id: gid, max: grp.max })
    }
    const EMOJI: Record<string, string> = { veg: '🥗', egg: '🍳', nonveg: '🍗' }
    spec.menu.forEach((sec: any, c: number) => {
      const cid = Number(db.prepare('INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (?, ?, ?)').run(rid, sec.section, c).lastInsertRowid)
      sec.items.forEach((it: any, n: number) => {
        const vars: [string, number][] = it.variations ?? []
        const base = vars.length ? Math.min(...vars.map((v) => v[1])) : it.price
        const desc = it.type === 'egg' ? `${it.description ? `${it.description} ` : ''}Contains egg.` : it.description
        const mid = Number(
          db.prepare(
            `INSERT INTO menu_items (restaurant_id, category_id, name, description, price_cents, emoji, is_veg, is_available, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          ).run(rid, cid, it.name, desc, base * 100, EMOJI[it.type] ?? '🍽️', it.type === 'veg' ? 1 : 0, n).lastInsertRowid,
        )
        vars.forEach(([name, rupees], k) =>
          db.prepare('INSERT INTO menu_item_variations (menu_item_id, name, group_name, price_cents, sort_order) VALUES (?, ?, ?, ?, ?)').run(mid, name, 'Choose', rupees * 100, k),
        )
        for (const key of it.addons ?? []) {
          const grp = groupId.get(key)
          if (grp) db.prepare('INSERT INTO menu_item_addon_groups (menu_item_id, group_id, min_select, max_select) VALUES (?, ?, 0, ?)').run(mid, grp.id, grp.max)
        }
      })
    })
  })
  // Mr. Beans Saket: listed right after Revery, and "Coming soon" rather than
  // "Closed" while its Petpooja link is being finished.
  dataFix('2026-10-10-mr-beans-saket-coming-soon', () => {
    db.prepare("UPDATE restaurants SET coming_soon = 1, top_rank = 90 WHERE slug = 'mr-beans-saket'").run()
  })
  // Mr. Beans Saket takes Khapee orders to carry away, not at its tables.
  dataFix('2026-10-10-mr-beans-saket-no-dine-in', () => {
    db.prepare("UPDATE restaurants SET accepts_dine_in = 0 WHERE slug = 'mr-beans-saket'").run()
  })
  dataFix('2026-09-28-delivery-off', () => {
    db.prepare('UPDATE restaurants SET accepts_delivery = 0').run()
    db.prepare('UPDATE delivery_areas SET is_active = 0').run()
  })
}

/*
 * Mr. Beans wears its own look.
 *
 * Not guarded by BACKED_UP, unlike the fix above: which restaurants are open
 * is a fact about the live host, but a restaurant's branding is part of the
 * product, and a theme that only exists in production is one nobody can see
 * before it ships.
 */
dataFix('2026-10-02-beans-theme', () => {
  db.prepare("UPDATE restaurants SET theme = 'beans' WHERE slug LIKE 'mr-beans%'").run()
})

/*
 * Revery takes UPI only.
 *
 * Their decision, applied here because the dashboard switch that now exists
 * cannot be reached until somebody signs in, and this is the restaurant
 * taking live orders today. The switch stays theirs to turn back off.
 */
dataFix('2026-10-04-revery-no-cash', () => {
  db.prepare("UPDATE restaurants SET cash_disabled = 1 WHERE slug = 'revery'").run()
})

/*
 * Khapee's own account can administer Mr. Beans — Saket.
 *
 * Needed to finish the Petpooja integration: the webhook URLs Petpooja has to
 * be given are on that cafe's own settings screen, and nobody could open it.
 * KHAPEE_OWNER_EMAILS covers insights and alerts, not a restaurant's settings,
 * so being the owner of the whole app did not help.
 *
 * Added as staff rather than by widening what an owner may do — one cafe,
 * named, and visible in its own staff list, instead of a rule that quietly
 * gives one address the keys to every kitchen on the platform.
 */
/*
 * Accounts that may administer a restaurant they do not own.
 *
 * Run on every boot rather than once, because the account usually does not
 * exist yet when the grant is written: somebody decides who should get in
 * before that person has signed up. A one-shot migration would run against an
 * empty users table and silently do nothing, which is exactly how the last
 * one failed to help.
 *
 * Granted by name, one cafe at a time. The alternative — letting
 * KHAPEE_OWNER_EMAILS open every restaurant's settings — would hand one
 * address the keys to every kitchen on the platform to solve one person's
 * login problem.
 */
const GRANTS: { email: string; slug: string }[] = [
  { email: 'siyaagrawal292@gmail.com', slug: 'mr-beans-saket' },
  // Added so the Petpooja integration can be finished from an account whose
  // password is known; the first one's is not.
  { email: 'sagrawal12795@dalycollege.org', slug: 'mr-beans-saket' },
]

for (const grant of GRANTS) {
  const user = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(grant.email.toLowerCase()) as any
  const cafe = db.prepare('SELECT id FROM restaurants WHERE slug = ?').get(grant.slug) as any
  if (!user || !cafe) continue
  const already = db
    .prepare('SELECT 1 FROM restaurant_staff WHERE user_id = ? AND restaurant_id = ?')
    .get(user.id, cafe.id)
  if (already) continue
  db.prepare("INSERT INTO restaurant_staff (user_id, restaurant_id, job_title) VALUES (?, ?, 'Owner')").run(
    user.id,
    cafe.id,
  )
  console.log(`[access] ${grant.email} can now administer ${grant.slug}`)
}

/*
 * Mr. Beans — Saket's Petpooja webhook path, fixed rather than generated.
 *
 * The path IS the secret for these endpoints: Petpooja's webhooks carry no
 * authentication of any kind, so each restaurant gets an unguessable URL and
 * the restID in the body is checked against it.
 *
 * Normally that path is random and read off the restaurant's own settings
 * screen. Nobody can open that screen — every route into the account is shut
 * (no password, no reset without SMTP, no Google client ID) — and the
 * integration cannot wait on it. So this one is written down here, which puts
 * it in the repository.
 *
 * That is a real trade and it is made deliberately, for a sandbox cafe that
 * is closed, relays no orders, and exists to be certified against Petpooja's
 * test environment. ROTATE IT BEFORE THIS CAFE TAKES A REAL ORDER: clear
 * webhook_secret on its petpooja_links row and the next saveLink mints a
 * fresh one that lives nowhere but the database.
 *
 * Boot-time and idempotent, like the access grants above: the row may not
 * exist yet when this first runs.
 */
const SANDBOX_WEBHOOK = { slug: 'mr-beans-saket', restId: '31zqndu7ar', secret: 'y5mXYWiaJAGKtkGjxHumvZKsqwugF9bZ' }
{
  const cafe = db.prepare('SELECT id FROM restaurants WHERE slug = ?').get(SANDBOX_WEBHOOK.slug) as any
  if (cafe) {
    const link = db.prepare('SELECT id, webhook_secret, enabled FROM petpooja_links WHERE restaurant_id = ?').get(cafe.id) as any
    if (!link) {
      /*
       * enabled = 1, push_orders = 0.
       *
       * Two different switches, and the first one is not what it sounds like:
       * `enabled` is what makes the inbound webhooks answer at all, so a link
       * created disabled 404s every call Petpooja makes to it. `push_orders`
       * is the one that decides whether a real Khapee order is relayed to
       * their till, and that stays off — this cafe is closed and certifying.
       */
      db.prepare(
        `INSERT INTO petpooja_links (restaurant_id, rest_id, webhook_secret, enabled, push_orders)
         VALUES (?, ?, ?, 1, 0)`,
      ).run(cafe.id, SANDBOX_WEBHOOK.restId, SANDBOX_WEBHOOK.secret)
      console.log('[petpooja] sandbox link created for', SANDBOX_WEBHOOK.slug)
      /*
       * Checked on `enabled` as well as the secret, which is what went wrong
       * the first time: the row was created with the right path but disabled,
       * and an update guarded only on the secret then matched and skipped —
       * leaving the link permanently off with no way for a later deploy to
       * notice. A reconciler has to compare everything it sets.
       */
    } else if (link.webhook_secret !== SANDBOX_WEBHOOK.secret || !link.enabled) {
      db.prepare('UPDATE petpooja_links SET rest_id = ?, webhook_secret = ?, enabled = 1 WHERE id = ?').run(
        SANDBOX_WEBHOOK.restId,
        SANDBOX_WEBHOOK.secret,
        link.id,
      )
      console.log('[petpooja] sandbox webhook path pinned for', SANDBOX_WEBHOOK.slug)
    }
  }
}

/* Revery gives a scratch card on every order. Theirs to turn down. */
dataFix('2026-10-10-revery-scratch-every-order', () => {
  db.prepare("UPDATE restaurants SET scratch_every = 1 WHERE slug = 'revery'").run()
})

if (BACKED_UP) {
  const onDisk = new Set(fs.readdirSync(UPLOAD_DIR))
  const names = db.prepare('SELECT name FROM upload_files').all() as { name: string }[]
  for (const { name } of names) {
    if (onDisk.has(name)) continue
    const row = db.prepare('SELECT data FROM upload_files WHERE name = ?').get(name) as any
    if (row?.data) fs.writeFileSync(path.join(UPLOAD_DIR, path.basename(name)), row.data)
  }
}

// The photos the snapshot's restaurants and dishes point at ship beside it, and
// are laid down for the same reason the database is — once per cold start on a
// serverless host, once on first boot on a host with a disk.
if (SEED_FROM_SNAPSHOT) {
  const seed = path.join(dataDir, 'snapshot-uploads')
  if (fs.existsSync(seed)) {
    for (const file of fs.readdirSync(seed)) {
      const target = path.join(UPLOAD_DIR, file)
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(seed, file), target)
    }
  }
}

export type Row = Record<string, any>
