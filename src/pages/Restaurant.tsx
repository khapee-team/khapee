import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Header from '../components/Header'
import { api, ApiError } from '../lib/api'
import { useVegMode } from '../lib/veg'
import { dishMatches, searchWords } from '../lib/menu-search'
import { Art, EmptyState, ErrorState, LoadingBlock, money, useToast } from '../components/ui'
import { useCart } from '../lib/cart'
import { readTableContext } from '../lib/table-context'
import { ownOrderOnly, readDining } from '../lib/dining'
import { readIntent, saveIntent } from '../lib/intent'
import { readLastOrder } from '../lib/me'
import { useGroup } from '../lib/group'
import DiningBar from '../components/DiningBar'
import { PeopleIcon, SearchIcon } from '../components/icons'
import NoirMenu from '../components/NoirMenu'
import OptionsSheet, { hasOptions, type DishOptions } from '../components/OptionsSheet'
import type { Choice } from '../lib/cart'
import { applyTheme } from '../lib/themes'
import { NoirMark, NoirWordmark } from '../components/NoirBrand'
import { HutMark, HutWordmark } from '../components/HutBrand'
import { ReveryMark, ReveryWordmark } from '../components/ReveryBrand'
import { PaarrooMark, PaarrooWordmark } from '../components/PaarrooBrand'
import { GramsHero, GramsYum } from '../components/GramsBrand'
import { MrBeansHero } from '../components/MrBeansHero'
import { BeansFlourish, BeansMark, BeansWordmark } from '../components/BeansBrand'
import type { RestaurantCard } from './Home'

type MenuItem = {
  id: number
  name: string
  description: string
  priceCents: number
  emoji: string
  hue: number
  imageUrl: string | null
  isVeg: boolean
  isAvailable: boolean
  isSpecial: boolean
  /** Variations and add-ons, for the dishes that have them. */
  options?: DishOptions
}
type Category = { id: number; name: string; items: MenuItem[] }


export default function Restaurant() {
  const { id } = useParams()
  const restaurantId = Number(id)
  const navigate = useNavigate()
  const toast = useToast()
  const { add, quantityOf, setQuantity, count, totalCents, cart } = useCart()
  const [veg, setVeg] = useVegMode()

  const [data, setData] = useState<{
    restaurant: RestaurantCard
    menu: Category[]
    /** Half open: the kitchen has shut but some of the menu is still going. */
    limited?: { on: boolean; sections?: string[]; notice?: string; prepaidOnly?: boolean }
  } | null>(null)
  const [error, setError] = useState('')
  const tableCtx = readTableContext(restaurantId)
  const dining = readDining(restaurantId)
  /* Whether they have already said they are taking it away. Kept in state as
     well as storage so the card can show it was chosen without a reload. */
  const [intent, setIntent] = useState(() => !!readIntent(restaurantId))
  // Confirmed with the server before it is believed — see lib/group.ts. A
  // remembered table that no longer exists used to make ordering impossible.
  const { group: activeGroup } = useGroup()
  // Somebody in their car was being told "You're at table GSRCQ — add to it"
  // in the same breath as "In the car". The session they are actually in wins.
  const inThisGroup = activeGroup?.restaurantId === restaurantId && !ownOrderOnly(restaurantId)

  /**
   * `quietly` refetches without blanking the page first, which is what a
   * refresh in the background has to do — clearing to a spinner every time
   * somebody switches back to the tab is worse than a stale price.
   */
  const load = (quietly = false) => {
    setError('')
    if (!quietly) setData(null)
    api<{
      restaurant: RestaurantCard
      menu: Category[]
      limited?: { on: boolean; sections?: string[]; notice?: string; prepaidOnly?: boolean }
    }>(`/restaurants/${restaurantId}${veg ? '?veg=1' : ''}`)
      .then(setData)
      .catch((e: ApiError) => setError(e.message))
  }

  useEffect(() => load(), [restaurantId, veg]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * A menu left open on a phone is a photograph of a moment.
   *
   * The restaurant edits a price or marks something sold out, looks at the
   * page it already had open, and sees the old menu — because nothing asked
   * the server again. Coming back to the tab is the moment to ask.
   */
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') load(true)
    }
    document.addEventListener('visibilitychange', again)
    window.addEventListener('focus', again)
    return () => {
      document.removeEventListener('visibilitychange', again)
      window.removeEventListener('focus', again)
    }
  }, [restaurantId, veg]) // eslint-disable-line react-hooks/exhaustive-deps

  // A restaurant with its own look gets its own menu component. Everything
  // outside the menu — cart bar, dining bar, table context — is shared, so a
  // theme changes how the food reads and nothing about how ordering works.
  const theme = (data?.restaurant.theme ?? '') as 'noir' | 'hut' | 'revery' | 'paarroo' | 'beans' | 'grams' | 'plain' | ''
  const noir = theme === 'noir'
  const hut = theme === 'hut'
  const revery = theme === 'revery'
  const paarroo = theme === 'paarroo'
  const beans = theme === 'beans'
  /**
   * "plain" is not a look of its own — it is the ordinary page with the
   * photographs left off. A restaurant whose pictures are not good enough to
   * sell the food is better read than looked at, and the standard layout is
   * easier to use than any of the dressed-up ones.
   */
  const noPhotos = theme === 'plain'
  /* One Eighty Seven Grams: the standard page (and its one-tap ordering)
     dressed in the bakery's own look — see GramsBrand and .grams-page. */
  const grams = theme === 'grams'

  /**
   * Finding one dish on a long menu.
   *
   * Nineteen sections and eighty dishes is four screens of scrolling to answer
   * "do they do a cold coffee". The section chips help someone browsing; they
   * are no help at all to someone who already knows what they want. Matching
   * the description as well as the name is deliberate — people search for
   * "paneer" and the paneer is often only in the description.
   */
  const [query, setQuery] = useState('')
  /** Themed restaurants share the menu and page shell, dressed differently. */
  const themed = noir || hut || revery || paarroo
  const noirPage = themed

  /**
   * A themed restaurant takes the page's palette with it. The app otherwise
   * follows the device, and on a phone set to light this page rendered cream on
   * cream — the theme's own colours assume a dark ground. Cleared on the way
   * out so the rest of the app goes back to whatever the device asked for.
   */
  useEffect(() => applyTheme(theme), [theme])

  /** The menu as it should read right now: every section, minus what was typed out. */
  const words = searchWords(query)
  const needle = query.trim()
  const shown = !words.length
    ? (data?.menu ?? [])
    : (data?.menu ?? [])
        .map((c) => ({ ...c, items: c.items.filter((i) => dishMatches(i, c.name, words)) }))
        .filter((c) => c.items.length > 0)
  const foundCount = shown.reduce((n, c) => n + c.items.length, 0)

  /** The dish whose size and extras are being chosen, if any. */
  const [choosing, setChoosing] = useState<MenuItem | null>(null)

  const onAdd = (item: MenuItem, choice?: Choice) => {
    if (!data) return
    if (!data.restaurant.isOpen) {
      toast(data.restaurant.comingSoon ? `${data.restaurant.name} is coming soon to Khapee.` : `${data.restaurant.name} is closed right now.`, 'bad')
      return
    }
    // A dish with a size or extras is chosen first; the themed menus hand
    // over their own copy of the dish, so the options are read from ours.
    const full = (data.menu ?? []).flatMap((c) => c.items).find((i) => i.id === item.id) ?? item
    if (!choice && hasOptions(full.options)) {
      setChoosing(full)
      return
    }
    const outcome = add({ id: data.restaurant.id, name: data.restaurant.name }, full, choice)
    if (outcome === 'switched') toast('Started a new cart for this restaurant', 'info')
    // No tables to order at: the only way left is takeaway, so it is chosen.
    if (data.restaurant.acceptsDineIn === false && data.restaurant.acceptsPickup && !intent && !dining) {
      saveIntent(restaurantId)
      setIntent(true)
    }
  }

  /* The restaurant's offer, if it has one — see server/offers.ts. */
  const [offer, setOffer] = useState<{ domain: string; percent: number; label: string } | null>(null)
  useEffect(() => {
    api<{ offer: any }>(`/orders/offer/${restaurantId}`)
      .then((r) => setOffer(r.offer))
      .catch(() => setOffer(null))
  }, [restaurantId])

  /* What people actually order here, first — see /restaurants/:id/popular. */
  const [popularIds, setPopularIds] = useState<number[]>([])
  useEffect(() => {
    api<{ ids: number[] }>(`/restaurants/${restaurantId}/popular`)
      .then((r) => setPopularIds(r.ids ?? []))
      .catch(() => setPopularIds([]))
  }, [restaurantId])
  const allItems = (data?.menu ?? []).flatMap((c) => c.items)
  const byId = new Map(allItems.map((i) => [i.id, i]))
  const popular = popularIds.map((pid) => byId.get(pid)).filter((i): i is MenuItem => !!i && i.isAvailable)

  /* The last order here, for "Order again" — only what is still on and available. */
  const last = readLastOrder(restaurantId).filter((l) => byId.get(l.menuItemId)?.isAvailable)
  const lastTotal = last.reduce((n, l) => n + (byId.get(l.menuItemId)?.priceCents ?? l.priceCents) * l.quantity, 0)
  const orderAgain = () => {
    if (!data) return
    for (const l of last) {
      const item = byId.get(l.menuItemId)
      // A dish with options needs choosing again, so it is not re-added blind.
      if (!item || hasOptions(item.options)) continue
      onAdd(item)
      if (l.quantity > 1) setQuantity(item.id, l.quantity)
    }
  }

  /**
   * Where this order is going, which decides the one button at the bottom.
   *
   * At a table or in the car the order is placed from here — no cart screen,
   * no checkout — because everything the checkout would ask is already known
   * (the table from the QR, the name and number from last time). Takeaway is
   * paid first, so its button goes straight to UPI.
   */
  const seated = !!tableCtx || (!!dining && (dining.serviceMode === 'dine_in' || dining.serviceMode === 'car' || !dining.serviceMode))
  const takingAway = !seated && intent

  /** One dish, the same everywhere on the page. No empty picture box when there is no photo. */
  const renderItem = (item: MenuItem) => {
    const qty = quantityOf(item.id)
    const inThisCart = cart.restaurantId === data!.restaurant.id
    const photo = noPhotos ? null : item.imageUrl
    return (
      <article
        key={item.id}
        className={`item-card ${photo ? '' : 'item-compact'} ${item.isAvailable ? '' : 'item-unavailable'} ${qty > 0 && inThisCart ? 'in-cart' : ''}`}
      >
        {photo && <Art emoji={item.emoji} hue={item.hue} imageUrl={photo} alt={item.name} className="item-art" />}
        <div className="item-body">
          <div className="item-title">
            <span className={`veg-dot ${item.isVeg ? '' : 'nonveg'}`} aria-hidden />
            {item.isSpecial && <span className="star" title="This month">★</span>}
            {item.name}
          </div>
          {item.description && <p className="item-desc">{item.description}</p>}
          <div className="item-foot">
            <span className="item-price">{money(item.priceCents)}</span>
            {!item.isAvailable ? (
              <span className="badge">Sold out</span>
            ) : qty > 0 && inThisCart ? (
              <div className="stepper">
                <button onClick={() => setQuantity(item.id, qty - 1)} aria-label={`Remove one ${item.name}`}>
                  −
                </button>
                <span>{qty}</span>
                <button onClick={() => onAdd(item)} aria-label={`Add one ${item.name}`}>
                  +
                </button>
              </div>
            ) : (
              <button className="btn btn-add btn-sm" onClick={() => onAdd(item)} disabled={!data!.restaurant.isOpen}>
                Add
              </button>
            )}
          </div>
        </div>
      </article>
    )
  }

  return (
    <div className="app">
      <Header />
      <main className={`page ${themed ? 'noir-page' : ''} ${hut ? 'hut-page' : ''} ${revery ? 'revery-page' : ''} ${paarroo ? 'paarroo-page' : ''} ${beans ? 'mb-page' : ''} ${grams ? 'grams-page' : ''}`}>
        {error && <ErrorState message={error} onRetry={load} />}
        {!data && !error && <LoadingBlock label="Loading the menu…" />}

        {data && (
          <>
            {/*
              Said before anything is chosen, not after.

              The alternative is somebody filling a basket at ten past ten and
              being told at the checkout that none of it can be made — which is
              the same information delivered at the worst possible moment.
            */}
            {data.limited?.on && (
              <div className="half-open-notice" role="status">
                <span aria-hidden>🌙</span>
                <span>{data.limited.notice}</span>
              </div>
            )}
            {themed ? (
              <header className="noir-hero">
                <div className="noir-hero-art">
                  <Art
                    emoji={data.restaurant.emoji}
                    hue={data.restaurant.hue}
                    imageUrl={noPhotos ? null : data.restaurant.imageUrl}
                    alt={data.restaurant.name}
                    className="noir-hero-img"
                  />
                  <span className="noir-hero-veil" aria-hidden />
                  <span className="noir-hero-sheen" aria-hidden />
                </div>

                <div className="noir-hero-lockup">
                  <span className="noir-hero-mark">
                    {beans ? (
                      <BeansMark size={176} />
                    ) : paarroo ? (
                      <PaarrooMark size={50} />
                    ) : revery ? (
                      <ReveryMark size={50} />
                    ) : hut ? (
                      <HutMark size={48} />
                    ) : (
                      <NoirMark size={46} />
                    )}
                  </span>
                  {beans ? (
                    <BeansWordmark name={data.restaurant.name} />
                  ) : paarroo ? (
                    <PaarrooWordmark />
                  ) : revery ? (
                    <ReveryWordmark />
                  ) : hut ? (
                    <HutWordmark />
                  ) : (
                    <NoirWordmark />
                  )}
                  {beans && <BeansFlourish />}
                  <p className="noir-hero-line">{data.restaurant.description}</p>
                  <div className="noir-hero-meta">
                    <span className={data.restaurant.isOpen ? 'noir-open' : 'noir-shut'}>
                      {data.restaurant.isOpen ? 'Open now' : data.restaurant.comingSoon ? 'Coming soon' : 'Closed'}
                    </span>
                    <span>{data.restaurant.hours}</span>
                    <span>~{data.restaurant.prepMinutes} min</span>
                  </div>
                </div>

                {/* Ordering to wherever you are standing in the area, beside
                    eating in, takeaway and the kerb — because from the street
                    it is simply another way to order from this kitchen. */}
                {data.restaurant.isOpen &&
                  !dining &&
                  (data.restaurant.precincts ?? []).map((p) => (
                    <Link key={p.id} className="road-cta" to={`/r/${restaurantId}/nearby/${p.slug}`}>
                      <span className="road-cta-mark" aria-hidden>
                        🚶
                      </span>
                      <span>
                        <strong>Somewhere in {p.name}?</strong>
                        <span className="tiny muted">
                          Tell them where you are and they&rsquo;ll walk it over.
                        </span>
                      </span>
                      <span className="road-cta-go" aria-hidden>
                        →
                      </span>
                    </Link>
                  ))}
                {data.restaurant.isOpen && data.restaurant.acceptsCar && !dining && (
                  <Link className="road-cta" to={`/r/${restaurantId}/car`}>
                    <span className="road-cta-mark" aria-hidden>
                      🚗
                    </span>
                    <span>
                      <strong>Sitting in your car?</strong>
                      <span className="tiny muted">Order from the road — we&rsquo;ll bring it out.</span>
                    </span>
                    <span className="road-cta-go" aria-hidden>
                      →
                    </span>
                  </Link>
                )}
                {data.restaurant.isOpen && data.restaurant.acceptsPickup && !dining && (
                  <button
                    type="button"
                    className={`road-cta ${intent ? 'is-chosen' : ''}`}
                    onClick={() => {
                      saveIntent(restaurantId)
                      setIntent(true)
                      toast('Takeaway it is — add what you want.', 'good')
                    }}
                  >
                    <span className="road-cta-mark" aria-hidden>
                      🥡
                    </span>
                    <span>
                      <strong>Taking it away?</strong>
                      <span className="tiny muted">
                        {intent
                          ? 'Chosen. Order now, collect when you get here.'
                          : 'Order now and collect it — tell them when you set off.'}
                      </span>
                    </span>
                    <span className="road-cta-go" aria-hidden>
                      {intent ? '✓' : '→'}
                    </span>
                  </button>
                )}
                {data.restaurant.isOpen && (
                  <div className="noir-hero-dining">
                    <DiningBar restaurantId={restaurantId} codesEnabled={data.restaurant.codesEnabled !== false} />
                  </div>
                )}
                {inThisGroup && (
                  <Link className="noir-hero-group" to="/group">
                    You&rsquo;re at table {activeGroup!.code} — add to it
                  </Link>
                )}
              </header>
            ) : beans ? (
              <>
                <MrBeansHero
                  name={data.restaurant.name}
                  isOpen={data.restaurant.isOpen}
                  comingSoon={data.restaurant.comingSoon}
                  hours={data.restaurant.hours}
                  prepMinutes={data.restaurant.prepMinutes}
                  takeawayOnly={data.restaurant.acceptsDineIn === false && !data.restaurant.acceptsCar}
                />
                {data.restaurant.isOpen && !dining && (data.restaurant.acceptsCar || data.restaurant.acceptsPickup) && (
                  <div className="way-in mb-way-in">
                    {data.restaurant.acceptsCar && (
                      <Link className="way-in-btn" to={`/r/${restaurantId}/car`}>
                        In my car
                      </Link>
                    )}
                    {data.restaurant.acceptsPickup && (
                      <button
                        type="button"
                        className={`way-in-btn ${intent ? 'is-chosen' : ''}`}
                        onClick={() => {
                          saveIntent(restaurantId)
                          setIntent(true)
                          toast('Takeaway — add what you’d like, then pay by UPI.', 'good')
                        }}
                      >
                        {intent ? 'Takeaway ✓' : 'Order takeaway'}
                      </button>
                    )}
                  </div>
                )}
                {data.restaurant.isOpen && data.restaurant.acceptsDineIn !== false && (
                  <div className="mb-dining">
                    <DiningBar restaurantId={restaurantId} codesEnabled={data.restaurant.codesEnabled !== false} />
                  </div>
                )}
              </>
            ) : grams ? (
              <>
                <GramsHero
                  isOpen={data.restaurant.isOpen}
                  hours={data.restaurant.hours}
                  prepMinutes={data.restaurant.prepMinutes}
                />
                {data.restaurant.isOpen && data.restaurant.acceptsPickup && !dining && !intent && (
                  <div className="way-in grams-way-in">
                    <button
                      type="button"
                      className="way-in-btn"
                      onClick={() => {
                        saveIntent(restaurantId)
                        setIntent(true)
                        toast('Add what you’d like, then pay by UPI.', 'good')
                      }}
                    >
                      Order to collect <span aria-hidden>→</span>
                    </button>
                  </div>
                )}
              </>
            ) : (
            <div className={`r-hero ${seated || noPhotos || !data.restaurant.imageUrl ? 'r-hero-slim' : ''}`}>
              {/* The big picture only when there is a real one and nobody is
                  sitting down yet — at a table it is a screen of scrolling
                  between the customer and the menu. */}
              {!seated && !noPhotos && data.restaurant.imageUrl && (
                <Art
                  emoji={data.restaurant.emoji}
                  hue={data.restaurant.hue}
                  imageUrl={data.restaurant.imageUrl}
                  alt={data.restaurant.name}
                  className={`r-hero-art ${data.restaurant.isOpen ? '' : 'closed-art'}`}
                />
              )}
              <div className="r-hero-body">
                <div className="row row-wrap" style={{ justifyContent: 'space-between' }}>
                  <h1>{data.restaurant.name}</h1>
                  <span className={`badge ${data.restaurant.isOpen ? 'badge-open' : data.restaurant.comingSoon ? 'badge-soon' : 'badge-closed'}`}>
                    {data.restaurant.isOpen ? 'Open now' : data.restaurant.comingSoon ? 'Coming soon' : 'Closed'}
                  </span>
                </div>
                {!seated && data.restaurant.description && (
                  <p className="muted" style={{ marginTop: 4 }}>
                    {data.restaurant.description}
                  </p>
                )}
                {!seated && (
                <div className="r-card-meta">
                  {data.restaurant.rating ? <span className="rating">★ {data.restaurant.rating.toFixed(1)}</span> : null}
                  <span className={data.restaurant.rating ? 'dot-sep' : ''}>
                    {data.restaurant.categories.join(' · ')}
                  </span>
                  <span className="dot-sep">{data.restaurant.hours}</span>
                  <span className="dot-sep">~{data.restaurant.prepMinutes} min</span>
                </div>
                )}
                {/* Ordering to wherever you are standing in the area, beside
                    eating in, takeaway and the kerb — because from the street
                    it is simply another way to order from this kitchen. */}
                {data.restaurant.isOpen &&
                  !dining &&
                  (data.restaurant.precincts ?? []).map((p) => (
                    <Link key={p.id} className="road-cta" to={`/r/${restaurantId}/nearby/${p.slug}`}>
                      <span className="road-cta-mark" aria-hidden>
                        🚶
                      </span>
                      <span>
                        <strong>Somewhere in {p.name}?</strong>
                        <span className="tiny muted">
                          Tell them where you are and they&rsquo;ll walk it over.
                        </span>
                      </span>
                      <span className="road-cta-go" aria-hidden>
                        →
                      </span>
                    </Link>
                  ))}
                {/* How they are ordering, as two small buttons side by side
                    rather than two screen-wide cards — the menu is what they
                    came for. */}
                {data.restaurant.isOpen && !dining && (data.restaurant.acceptsCar || data.restaurant.acceptsPickup) && (
                  <div className="way-in">
                    {data.restaurant.acceptsCar && (
                      <Link className="way-in-btn" to={`/r/${restaurantId}/car`}>
                        <span aria-hidden>🚗</span> In my car
                      </Link>
                    )}
                    {data.restaurant.acceptsPickup && (
                      <button
                        type="button"
                        className={`way-in-btn ${intent ? 'is-chosen' : ''}`}
                        onClick={() => {
                          saveIntent(restaurantId)
                          setIntent(true)
                          toast('Takeaway — add what you want, then pay by UPI.', 'good')
                        }}
                      >
                        <span aria-hidden>🥡</span> {intent ? 'Takeaway ✓' : 'Takeaway'}
                      </button>
                    )}
                  </div>
                )}
                {data.restaurant.isOpen && data.restaurant.acceptsDineIn !== false && (
                  <div style={{ marginTop: 10 }}>
                    <DiningBar restaurantId={restaurantId} codesEnabled={data.restaurant.codesEnabled !== false} />
                  </div>
                )}

                {inThisGroup && (
                  <div className="row row-wrap" style={{ marginTop: 12 }}>
                    <Link className="btn btn-secondary btn-sm" to="/group">
                      <PeopleIcon size={15} />
                      You&rsquo;re at table {activeGroup!.code} — add to it
                    </Link>
                  </div>
                )}
              </div>
            </div>
            )}

            {!!needle && foundCount === 0 && (
              <EmptyState
                emoji="🔍"
                title={`Nothing matching \u201c${query.trim()}\u201d`}
                body={veg ? 'Try another word, or turn off Veg only.' : 'Try another word.'}
                action={
                  <button className="btn btn-secondary" onClick={() => setQuery('')}>
                    Show the whole menu
                  </button>
                }
              />
            )}

            {/* Every menu gets this, themed or not.
                It used to live inside the plain branch only, which put it on
                every short menu and on none of the long ones — the themed
                restaurants are the ones with a hundred and fifty dishes
                across sixteen sections, and they are exactly who cannot find
                the cold coffee by scrolling. */}
            {/* Above the section chips, because someone who knows what they
                want should not have to read the chips to find out it is not
                there. */}
            {offer && (
              <p className="offer-note">
                🎓 {offer.label ? `${offer.label}: ` : ''}
                <strong>{offer.percent}% off coupon</strong> — verify your @{offer.domain} email at checkout to
                unlock it.
              </p>
            )}
            <div className="menu-find">
              <span className="menu-find-mark" aria-hidden>
                <SearchIcon size={16} />
              </span>
              <input
                className="input menu-find-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${data.restaurant.name}\u2019s menu`}
                aria-label="Search the menu"
                type="search"
              />
              {!!needle && (
                <button className="menu-find-clear" onClick={() => setQuery('')} aria-label="Clear search">
                  ✕
                </button>
              )}
            </div>
            {!!needle && (
              <p className="tiny muted menu-find-count">
                {foundCount} {foundCount === 1 ? 'dish' : 'dishes'} matching &ldquo;{query.trim()}&rdquo;
              </p>
            )}

            {themed ? (
              <NoirMenu
                theme={theme}
                /* The filtered menu, not the whole one: searching has to
                   narrow what is on screen or it is not searching. */
                menu={shown}
                /* And while something is typed, show every match at once
                   rather than one section at a time — a search that hides
                   results behind a section chip has answered the wrong
                   question. */
                forceAll={!!needle}
                isOpen={data.restaurant.isOpen}
                quantityOf={quantityOf}
                setQuantity={setQuantity}
                onAdd={onAdd}
                inThisCart={cart.restaurantId === data.restaurant.id}
              />
            ) : (
              <>
            <nav className="menu-nav">
              <button
                className={`veg-toggle veg-toggle-sm ${veg ? 'on' : ''}`}
                onClick={() => setVeg(!veg)}
                aria-pressed={veg}
                aria-label="Veg only"
              >
                <span className="veg-mark" aria-hidden />
                Veg
              </button>
              {shown.map((c) => (
                <a key={c.id} href={`#cat-${c.id}`} className="chip">
                  {c.name}
                </a>
              ))}
            </nav>

            {!needle &&
              data.menu.every((c) => c.items.length === 0) &&
              (veg ? (
                <EmptyState
                  emoji="🥬"
                  title="Nothing veg here"
                  action={
                    <button className="btn btn-secondary" onClick={() => setVeg(false)}>
                      Show everything
                    </button>
                  }
                />
              ) : (
                <EmptyState emoji="📋" title="No dishes yet" body="This restaurant hasn't published a menu." />
              ))}

            {!needle && last.length > 0 && data.restaurant.isOpen && (
              <button type="button" className="order-again" onClick={orderAgain}>
                <span className="order-again-mark" aria-hidden>
                  ↻
                </span>
                <span className="order-again-body">
                  <strong>Order again</strong>
                  <span>
                    {last.map((l) => `${l.quantity}× ${byId.get(l.menuItemId)?.name ?? l.name}`).join(', ')}
                  </span>
                </span>
                <span className="order-again-price">{money(lastTotal)}</span>
              </button>
            )}

            {!needle && popular.length > 0 && (
              <section className="menu-section">
                <h2>Most ordered here</h2>
                <div className="item-grid">{popular.map(renderItem)}</div>
              </section>
            )}

            {shown.map((category) => (
              <section key={category.id} id={`cat-${category.id}`} className="menu-section">
                <h2>{category.name}</h2>
                <div className="item-grid">
                  {category.items.map(renderItem)}
                </div>
              </section>
            ))}
            {grams && !needle && (
              <p className="grams-signoff">
                <GramsYum />
                <span>Baked in small batches, in Indore.</span>
              </p>
            )}
              </>
            )}
          </>
        )}
      </main>

      <OptionsSheet
        dish={choosing && choosing.options ? { name: choosing.name, priceCents: choosing.priceCents, options: choosing.options } : null}
        onClose={() => setChoosing(null)}
        onAdd={(choice) => {
          if (choosing) onAdd(choosing, choice)
          setChoosing(null)
        }}
      />

      {count > 0 && cart.restaurantId === restaurantId && (
        <div className="cart-bar">
          <div className="cart-bar-info">
            <strong>
              {count} item{count > 1 ? 's' : ''} · {money(totalCents)}
            </strong>
            <span>
              {inThisGroup
                ? `Adding to group ${activeGroup!.code}`
                : dining?.tableLabel || tableCtx?.tableLabel
                  ? `${cart.restaurantName} · ${dining?.tableLabel || tableCtx?.tableLabel}`
                  : cart.restaurantName}
            </span>
          </div>
          {/* One tap. At a table or in the car the order goes in from here;
              takeaway opens UPI; anything else goes straight to the one
              screen that asks what is still unknown. The cart screen is no
              longer a stop on the way — the steppers on the menu are the cart. */}
          <button
            className="btn btn-accent"
            onClick={() =>
              navigate(inThisGroup ? '/cart' : seated || takingAway ? '/checkout?go=1' : '/checkout')
            }
          >
            {inThisGroup
              ? 'Add to table'
              : seated
                ? `Place order · ${money(totalCents)}`
                : takingAway
                  ? `Pay & order · ${money(totalCents)}`
                  : 'Continue'}
          </button>
        </div>
      )}


      {count > 0 && cart.restaurantId !== restaurantId && (
        <div className="cart-bar">
          <div className="cart-bar-info">
            <strong>Cart from {cart.restaurantName}</strong>
            <span>Adding here will start a new cart</span>
          </div>
          <Link className="btn btn-secondary btn-sm" to="/cart">
            Open
          </Link>
        </div>
      )}
    </div>
  )
}
