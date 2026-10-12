/**
 * A restaurant's offer for people from one place — the first being 20% off at
 * Mr. Beans Saket for anyone with a @dalycollege.org email.
 *
 * The customer proves the address is theirs — a 6-digit code emailed to it,
 * typed back (below) — because a typed address proves nothing; and must press
 * Apply on the coupon, which is never applied on its own. The address rides on
 * the order and is shown to the restaurant beside it.
 *
 * The discount is a share of the dishes, never of a delivery fee, and it is
 * kept as a percentage on the order so that when the kitchen declines a dish
 * the discount is worked out again on what is left.
 */
import crypto from 'node:crypto'
import { db } from './db.ts'

db.exec(`
CREATE TABLE IF NOT EXISTS restaurant_offers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  email_domain  TEXT    NOT NULL,
  percent       INTEGER NOT NULL,
  label         TEXT    NOT NULL DEFAULT '',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_restaurant_offers ON restaurant_offers(restaurant_id, is_active);
`)

/*
 * The first one: 20% off at Mr. Beans Saket for Daly College. Made once, if
 * that restaurant has never had an offer, so switching it off later is not
 * undone on the next start.
 */
{
  const r = db.prepare("SELECT id FROM restaurants WHERE slug = 'mr-beans-saket'").get() as any
  if (r && !db.prepare('SELECT 1 FROM restaurant_offers WHERE restaurant_id = ?').get(r.id)) {
    db.prepare(
      "INSERT INTO restaurant_offers (restaurant_id, email_domain, percent, label) VALUES (?, 'dalycollege.org', 20, 'Daly College')",
    ).run(r.id)
  }
}

export type Offer = { id: number; domain: string; percent: number; label: string }

/** The offer running at a restaurant right now, if it has one. */
export function offerFor(restaurantId: number): Offer | null {
  const row = db
    .prepare('SELECT * FROM restaurant_offers WHERE restaurant_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1')
    .get(restaurantId) as any
  if (!row) return null
  return { id: row.id, domain: String(row.email_domain).toLowerCase(), percent: Number(row.percent), label: row.label }
}

/** The email, tidied, if it really ends in the offer's domain; otherwise null. */
export function qualifyingEmail(offer: Offer | null, email: unknown): string | null {
  if (!offer) return null
  const e = String(email ?? '').trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 1) return null
  const local = e.slice(0, at)
  const domain = e.slice(at + 1)
  if (domain !== offer.domain) return null
  if (!/^[a-z0-9._%+-]+$/.test(local)) return null
  return e
}

/** The discount on a dish total, in paise, rounded to the rupee. */
export function discountOn(dishesCents: number, percent: number): number {
  if (!(percent > 0) || dishesCents <= 0) return 0
  return Math.min(dishesCents, Math.round((dishesCents * percent) / 100 / 100) * 100)
}

/* --- Proving the email is theirs --------------------------------------------
 *
 * A 6-digit code sent to the address, typed back. School accounts for
 * students are kept out of "Continue with Google" on outside sites, but their
 * inbox receives mail like any other, so this works for every student.
 *
 * Typed back correctly, it gives this phone a pass: a random token that says
 * "this address was proved here". Only its hash is kept. It is what an order
 * carries to claim the offer, and it lasts a year.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS offer_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_offer_codes_email ON offer_codes(email, created_at);
CREATE TABLE IF NOT EXISTS offer_passes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL,
  token_hash  TEXT    NOT NULL UNIQUE,
  expires_at  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
`)

const hash = (s: string) => crypto.createHash('sha256').update(`khapee-offer:${s}`).digest('hex')

/** Makes a code for an address, or says why not. The caller sends it. */
export function newCode(email: string): { ok: true; code: string } | { ok: false; error: string } {
  const recent = db
    .prepare("SELECT COUNT(*) AS n FROM offer_codes WHERE email = ? AND created_at >= datetime('now', '-1 hour')")
    .get(email) as any
  if (Number(recent.n) >= 5) return { ok: false, error: 'Too many codes asked for. Try again in an hour.' }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  db.prepare("INSERT INTO offer_codes (email, code_hash, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))").run(
    email,
    hash(`${email}:${code}`),
  )
  return { ok: true, code }
}

/** Checks a typed code; right, it returns a pass for this phone to keep. */
export function checkCode(email: string, code: string): { ok: true; pass: string } | { ok: false; error: string } {
  const row = db
    .prepare(
      "SELECT * FROM offer_codes WHERE email = ? AND used_at IS NULL AND expires_at >= datetime('now') ORDER BY id DESC LIMIT 1",
    )
    .get(email) as any
  if (!row) return { ok: false, error: 'That code has expired. Send a new one.' }
  if (row.attempts >= 5) return { ok: false, error: 'Too many wrong tries. Send a new code.' }
  if (row.code_hash !== hash(`${email}:${String(code).replace(/\D/g, '')}`)) {
    db.prepare('UPDATE offer_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id)
    return { ok: false, error: 'That code isn’t right. Check the email and try again.' }
  }
  db.prepare("UPDATE offer_codes SET used_at = datetime('now') WHERE id = ?").run(row.id)
  const pass = crypto.randomBytes(24).toString('base64url')
  db.prepare("INSERT INTO offer_passes (email, token_hash, expires_at) VALUES (?, ?, datetime('now', '+365 days'))").run(
    email,
    hash(pass),
  )
  return { ok: true, pass }
}

/** The proved address a pass stands for, if it is still good and fits the offer. */
export function passEmail(offer: Offer | null, pass: unknown): string | null {
  if (!offer || !pass) return null
  const row = db
    .prepare("SELECT email FROM offer_passes WHERE token_hash = ? AND expires_at >= datetime('now')")
    .get(hash(String(pass))) as any
  return row ? qualifyingEmail(offer, row.email) : null
}
