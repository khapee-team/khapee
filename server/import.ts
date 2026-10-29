/**
 * Bulk-import restaurants, menus and photos from a local JSON file.
 *
 *   npm run import -- my-restaurants.json
 *
 * Image paths inside the file are read from your own disk and copied into the
 * app's upload folder. Nothing is fetched over the network.
 * See data/sample-import.json for the shape.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db, UPLOAD_DIR } from './db.ts'
import { hashPassword } from './auth.ts'
import { tableToken } from './ids.ts'

type ImportItem = {
  name: string
  description?: string
  price: number | string
  emoji?: string
  hue?: number
  veg?: boolean
  available?: boolean
  image?: string
  /** Groups this item under a heading inside its section. */
  group?: string
}

type ImportRestaurant = {
  name: string
  description?: string
  address?: string
  phone?: string
  categories?: string[] | string
  emoji?: string
  hue?: number
  hours?: string
  prepMinutes?: number
  rating?: number
  isOpen?: boolean
  tables?: number
  image?: string
  staff?: { name?: string; email: string; password?: string; title?: string }
  menu?: { category: string; items: ImportItem[] }[]
}

const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

function copyImage(source: string | undefined, baseDir: string): string | null {
  if (!source) return null
  if (/^https?:/i.test(source)) {
    console.warn(`  ! skipped remote image (${source}) — point at a file on this machine instead`)
    return null
  }
  const resolved = path.isAbsolute(source) ? source : path.resolve(baseDir, source)
  const ext = path.extname(resolved).toLowerCase()
  if (!ALLOWED_IMAGE_EXT.has(ext)) {
    console.warn(`  ! skipped ${source} — use a JPG, PNG, WEBP or GIF`)
    return null
  }
  if (!fs.existsSync(resolved)) {
    console.warn(`  ! image not found: ${resolved}`)
    return null
  }
  const file = `${crypto.randomBytes(10).toString('hex')}${ext === '.jpeg' ? '.jpg' : ext}`
  fs.copyFileSync(resolved, path.join(UPLOAD_DIR, file))
  return file
}

function uniqueSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'restaurant'
  let slug = base
  for (let n = 2; db.prepare('SELECT 1 FROM restaurants WHERE slug = ?').get(slug); n++) slug = `${base}-${n}`
  return slug
}

function toCents(price: number | string): number {
  const value = Number(String(price).replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid price: ${price}`)
  return Math.round(value * 100)
}

/** Adds sections and dishes to a restaurant that already exists. */
function mergeMenu(restaurantId: number, entry: ImportRestaurant, baseDir: string): number {
  let added = 0
  entry.menu?.forEach((section, ci) => {
    let category = db
      .prepare('SELECT * FROM menu_categories WHERE restaurant_id = ? AND lower(name) = lower(?)')
      .get(restaurantId, section.category) as any
    if (!category) {
      const next = db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menu_categories WHERE restaurant_id = ?')
        .get(restaurantId) as any
      const info = db
        .prepare('INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (?, ?, ?)')
        .run(restaurantId, section.category, next.n + ci)
      category = { id: Number(info.lastInsertRowid) }
    }
    section.items?.forEach((item, ii) => {
      const clash = db
        .prepare('SELECT 1 FROM menu_items WHERE restaurant_id = ? AND lower(name) = lower(?)')
        .get(restaurantId, item.name)
      if (clash) return
      db.prepare(
        `INSERT INTO menu_items
          (restaurant_id, category_id, name, description, price_cents, emoji, hue, is_veg, is_available, sort_order, image_path, group_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        restaurantId,
        category.id,
        item.name,
        item.description ?? '',
        toCents(item.price),
        item.emoji ?? '🍽️',
        Math.max(0, Math.min(360, Number(item.hue) || 24)),
        item.veg === false ? 0 : 1,
        item.available === false ? 0 : 1,
        ci * 100 + ii,
        copyImage(item.image, baseDir),
        item.group ?? '',
      )
      added++
    })
  })
  return added
}

export function importFile(file: string, merge = false) {
  const absolute = path.resolve(file)
  const baseDir = path.dirname(absolute)
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  const list: ImportRestaurant[] = Array.isArray(parsed) ? parsed : parsed.restaurants
  if (!Array.isArray(list)) throw new Error('Expected a JSON array of restaurants, or { "restaurants": [...] }')

  let added = 0
  let items = 0

  for (const entry of list) {
    if (!entry?.name) {
      console.warn('  ! skipped an entry with no name')
      continue
    }
    const existing = db.prepare('SELECT id FROM restaurants WHERE lower(name) = lower(?)').get(entry.name) as any
    if (existing) {
      if (!merge) {
        console.log(`  · "${entry.name}" already exists — skipped (pass --merge to add its menu)`)
        continue
      }
      const count = db.transaction(() => mergeMenu(existing.id, entry, baseDir))()
      items += count
      console.log(`  ✓ ${entry.name} — merged ${count} new items`)
      continue
    }

    db.transaction(() => {
      const categories = (Array.isArray(entry.categories) ? entry.categories : String(entry.categories ?? '').split(','))
        .map((c) => String(c).trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(', ')

      const info = db
        .prepare(
          `INSERT INTO restaurants
            (slug, name, description, address, categories, emoji, hue, is_open, hours, prep_minutes, rating, phone, image_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          uniqueSlug(entry.name),
          entry.name,
          entry.description ?? '',
          entry.address ?? '',
          categories,
          entry.emoji ?? '🍽️',
          Math.max(0, Math.min(360, Number(entry.hue) || 210)),
          entry.isOpen === false ? 0 : 1,
          entry.hours ?? '9:00 AM – 11:00 PM',
          Math.max(1, Math.min(180, Number(entry.prepMinutes) || 20)),
          Math.max(0, Math.min(5, Number(entry.rating) || 0)),
          entry.phone ?? '',
          copyImage(entry.image, baseDir),
        )
      const restaurantId = Number(info.lastInsertRowid)

      if (entry.staff?.email) {
        const email = entry.staff.email.trim().toLowerCase()
        const clash = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any
        if (clash) {
          console.warn(`  ! staff email ${email} already in use — no account created for ${entry.name}`)
        } else {
          // No password in the file: make a random one and print it once, so a
          // real restaurant never ends up on a shared, guessable default.
          let password = entry.staff.password
          if (!password) {
            password = crypto.randomBytes(9).toString('base64url')
            console.log(`  ✓ ${email} — generated password (shown once, pass it on securely): ${password}`)
          }
          const userInfo = db
            .prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'staff')`)
            .run(entry.staff.name ?? entry.name, email, hashPassword(password))
          db.prepare('INSERT INTO restaurant_staff (user_id, restaurant_id, job_title) VALUES (?, ?, ?)').run(
            Number(userInfo.lastInsertRowid),
            restaurantId,
            entry.staff.title ?? 'Owner',
          )
        }
      }

      const tableCount = Math.max(0, Math.min(60, Number(entry.tables ?? 6)))
      for (let t = 1; t <= tableCount; t++) {
        db.prepare('INSERT INTO restaurant_tables (restaurant_id, label, seats, token) VALUES (?, ?, 4, ?)').run(
          restaurantId,
          `Table ${t}`,
          tableToken(),
        )
      }

      entry.menu?.forEach((section, ci) => {
        const categoryInfo = db
          .prepare('INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (?, ?, ?)')
          .run(restaurantId, section.category, ci)
        const categoryId = Number(categoryInfo.lastInsertRowid)
        section.items?.forEach((item, ii) => {
          db.prepare(
            `INSERT INTO menu_items
              (restaurant_id, category_id, name, description, price_cents, emoji, hue, is_veg, is_available, sort_order, image_path, group_label)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            restaurantId,
            categoryId,
            item.name,
            item.description ?? '',
            toCents(item.price),
            item.emoji ?? '🍽️',
            Math.max(0, Math.min(360, Number(item.hue) || 24)),
            item.veg === false ? 0 : 1,
            item.available === false ? 0 : 1,
            ci * 100 + ii,
            copyImage(item.image, baseDir),
            item.group ?? '',
          )
          items++
        })
      })
      added++
      console.log(`  ✓ ${entry.name}`)
    })()
  }

  console.log(`\n  Imported ${added} restaurant${added === 1 ? '' : 's'} and ${items} menu items.\n`)
  return { added, items }
}

const args = process.argv.slice(2)
const merge = args.includes('--merge')
const fileArg = args.find((a) => !a.startsWith('--'))
if (fileArg) {
  try {
    importFile(fileArg, merge)
  } catch (err) {
    console.error(`\n  Import failed: ${(err as Error).message}\n`)
    process.exit(1)
  }
} else if (process.argv[1]?.includes('import')) {
  console.log('\n  Usage: npm run import -- path/to/restaurants.json [--merge]\n')
}
