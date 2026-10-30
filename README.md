# Khapee — order ahead, skip the wait

**What it is:** a food pre-ordering app for cafes and restaurants. Customers order from their
phone before they arrive, from their table by scanning a QR code, or for pickup, and the kitchen
sees each order on a live board and moves it through to ready.

**Who it's for:** students and anyone short on time who would rather order ahead than queue, and
the local cafes and restaurants that serve them.

**Status:** live, with restaurants in Indore onboarded.

**Live site:** <https://khapee.com>

**License:** All rights reserved (see [LICENSE](LICENSE)).

## Team

Khapee was co-founded and built by two collaborators:

- *Siya Agrawal* (@siyaAgrawal), Co-founder
- *Shaurya Gupta* (@shauryagupta11890-spec), Co-founder

Siya and Shaurya worked together on Khapee at every stage, from research and product design to code and getting cafes on board.

## How it works

Customers browse a menu, say where they are, and order. Staff watch orders land on a live board
and move them through to completion. The app is a single Node process with a SQLite database,
local password hashing, and QR codes generated and scanned in the browser. Payments go straight
from the customer's UPI app to the restaurant; Khapee never holds money. Running it locally needs
no API keys or third-party accounts. How the live site is hosted is in [DEPLOY.md](DEPLOY.md).

The marketing website lives separately in [`website/`](website/) and does not talk to the app.

## Run it

```bash
npm install
```

```bash
npm run dev
```

- Customer app + staff dashboard: <http://localhost:5273>
- API (started automatically alongside it): <http://localhost:4273>

The database is created and seeded on first boot at `data/khapee.db`.

### Demo accounts

Password for all of them: `password123`

| Role     | Email                      | Restaurant              |
| -------- | -------------------------- | ----------------------- |
| Customer | `siya@tablo.test`          | —                       |
| Customer | `nikhil@tablo.test`        | —                       |
| Staff    | `staff@mornington.test`    | Mornington Coffee House |
| Staff    | `staff@basilandbay.test`   | Basil & Bay             |
| Staff    | `staff@tandoorroom.test`   | The Tandoor Room        |
| Staff    | `staff@sakurabowl.test`    | Sakura Bowl (closed)    |
| Staff    | `staff@malwachai.test`     | Malwa Chai & Poha       |

The seeded restaurants are **invented demo businesses** used to exercise the app. Customers can
also order as a guest — an account is never required.

## Adding your own restaurants

Three ways, all local:

1. **Restaurant sign-up** — `/for-restaurants` creates the owner account, the restaurant and its
   tables (with QR codes) in one step, then drops you into the editor.
2. **The dashboard** — *Restaurant* edits name, description, cuisines, address, phone, hours,
   prep time, cover photo and fallback artwork. *Menu* adds, edits, reorders into sections,
   prices, photographs and deletes dishes, and flips anything to sold out.
3. **Bulk import** — for many restaurants at once:

```bash
npm run import -- data/sample-import.json
```

The JSON file describes restaurants, menus, staff logins and image paths; see
[data/sample-import.json](data/sample-import.json) for the shape. Image paths point at files on
your own disk and are copied into the app's upload folder — nothing is fetched over the network,
so use photos you took or otherwise have the right to use. Menus, descriptions and photography
on other ordering platforms belong to those platforms and the restaurants; don't copy them in.

### Other commands

```bash
npm test
```

```bash
npm run seed
```

`npm test` boots a throwaway server against its own database and drives the whole API
(217 assertions covering all three ordering scenarios, group ordering, payments, location,
restaurant editing and their failure paths).
`npm run seed` wipes and reseeds the demo data. `npm run build && npm start` serves the built
app from the API server on port 4273.

## The three ordering scenarios

**Case 1 — already seated, verified by access code.** Staff open *Access codes* → *Generate new
code* and read out something like `K7X92P` (or show its QR). The customer picks
*I'm at the restaurant* at checkout, types or scans the code, chooses their table, and orders.
Codes expire (default 10 minutes, live countdown on both sides), are single-use by default, are
bound to one restaurant, and can be cancelled by staff.

**Case 2 — seated, identified by table QR.** Every table has its own printable QR
(*Tables* in the dashboard). Scanning it opens that restaurant's menu with the table already
set, so checkout skips the code step entirely. The customer picks whether they'll pay at the
counter or through the app; either way the order lands as `UNPAID` and staff flip it to `PAID`
when they've been paid. No payment is processed by the app.

**Case 3 — pickup, ordered before arriving.** The customer picks *Order for pickup*, enters a
name, and gets an order number like `#A482` plus a QR. Staff see it as a pickup order, prepare
it, and mark it *Ready for pickup*. On arrival, *Verify order* in the dashboard either scans the
customer's QR or takes the typed order number, shows the order, and hands over — *Picked up*.

## Group ordering

One table, one shared session, everyone orders for themselves.

The first person picks **Eating as a group?** on the restaurant page, proves they're there (table
QR or staff code), chooses the table, and gets a group code like `GTQV4` plus a QR to show round
the table. Everyone else scans it or types the code, sees *which restaurant, which table, which
group* before joining, then adds their own food. Items are attributed to whoever ordered them, and
the kitchen gets one ticket per table with each person's items grouped underneath their name.

Paying is flexible: **pay for my items**, **pay the whole group bill**, or **enter any amount** to
split it however the table likes. The running total, amount paid and amount remaining update as
people settle. The host closes the session once nothing is outstanding; after that no one can add
to it, and it stays in everyone's order history.

## Payment (UPI, no payment provider)

The restaurant enters its own UPI ID under *Restaurant → UPI*. Khapee then builds a standard
`upi://pay` request — rendered as a QR locally — so money moves **directly from the customer's UPI
app to the restaurant's account**. There is no Razorpay, no PhonePe SDK, no API key, and no
account in the middle.

The honest consequence: without a payment provider or bank webhook, **the app cannot verify a
payment by itself**. So the customer taps *I've paid* (optionally with their UTR), and the
restaurant confirms it against their own UPI notification under **Payments**. Nothing is marked
PAID until a human at the restaurant says it arrived. Restaurants that leave the UPI field blank
simply take payment at the counter as before.

## Finding restaurants near you

The browse page has a **Near me** button. It uses the browser's own geolocation API, sends the
coordinates to this app's API only, and sorts by straight-line distance against coordinates the
restaurants pinned themselves (*Restaurant → Map pin*). No maps service, no geocoding service, and
no location data is stored. Restaurants without a pin still appear, just unsorted.

## Status flows

```
Dine in            NEW → ACCEPTED → PREPARING → READY            → COMPLETED
Takeaway / Pickup  NEW → ACCEPTED → PREPARING → READY_FOR_PICKUP → PICKED_UP
```

Every restaurant chooses which of dine-in, takeaway, pickup and group tables it offers
(*Restaurant → How you take orders*); anything switched off disappears from the customer's
checkout and is refused by the API.

Staff can step an order forward, step it back one place to undo a mis-tap, or cancel it. The
board updates over server-sent events, with an 8-second poll as a fallback; the customer's
tracking page updates the same way.

## What the restaurant dashboard does

- **Orders** — a live board (New / Accepted / Preparing / Ready / Completed) with order number,
  type, table, customer, items and quantities, time, total, payment status, and today's totals.
- **Menu** — add sections and dishes, edit names, descriptions, prices and photos, flip an item
  to sold out the moment it runs out, or close the restaurant entirely.
- **Access codes** — generate, show as QR, watch the countdown, cancel.
- **Tables** — add or remove tables, each with its own QR to print.
- **Verify order** — scan or type an order number to confirm a handover.
- **Restaurant** — your public profile: name, description, cuisines, address, phone, hours, prep
  time, cover photo, and the generated artwork used when there is no photo.

## How it is put together

```
server/          Express API
  db.ts          SQLite schema + additive migrations (better-sqlite3)
  seed.ts        demo restaurants, menus, tables, accounts
  import.ts      bulk import from a local JSON file
  uploads.ts     photo storage on disk (data/uploads)
  auth.ts        bcrypt hashing + session tokens
  ids.ts         access codes, order numbers, table tokens
  events.ts      server-sent-event fan-out
  orders-service.ts  order creation, pricing, access-code checks
  routes/        auth · public · orders · staff
shared/orders.ts status flows shared by client and server
src/             React + Vite app (customer and staff)
tests/run.ts     end-to-end API tests
```

Notes on the design:

- **Prices and totals are always computed server-side** from the database; anything the client
  sends about price is ignored.
- **Dine-in orders need proof of presence** — a valid access code or a scanned table QR.
  Neither is accepted from a different restaurant.
- **Staff are scoped to one restaurant.** Every staff route checks ownership, so one
  restaurant cannot see or touch another's orders, menu, tables, or codes.
- **Guest receipts** are kept in `localStorage` with a per-order token, so a customer who never
  signed in can still reopen their order; the token is required to read it.
- **QR codes** are drawn in the browser with `qrcode` and decoded from the camera with `jsqr`.
  Manual entry is offered everywhere a scanner appears, and the scanner degrades to a clear
  message when the camera is unavailable.
- **Food and restaurant imagery** is either a photo the restaurant uploaded — resized in the
  browser, stored in `data/uploads`, served by this app — or generated locally (a deterministic
  gradient tile plus the dish glyph). No image service is involved either way.
- **Editing is scoped by session, not by id.** The profile route takes no restaurant id at all,
  and every menu, category, table and photo route re-checks that the row belongs to the signed-in
  staff member's restaurant.
