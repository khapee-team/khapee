import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import { api, ApiError } from '../lib/api'
import { useSession } from '../lib/session'
import { useVegMode } from '../lib/veg'
import { LoadingBlock, Spinner, useToast } from '../components/ui'
import { STATUS_LABEL, type OrderStatus } from '../../shared/orders'

/**
 * An account page in the ordinary sense: who you are, how to reach you, what
 * you have ordered. Nothing here is required to use the app — an order only
 * ever needs a name typed at checkout.
 */
export default function Profile() {
  const { user, refresh, logout } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const [vegOnly, setVegOnly] = useVegMode()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [orders, setOrders] = useState<any[] | null>(null)

  useEffect(() => {
    if (!user) return
    setName(user.name)
    setPhone(user.phone ?? '')
  }, [user])

  useEffect(() => {
    if (!user) return
    api<{ orders: any[] }>('/orders/mine')
      .then((r) => setOrders(r.orders))
      .catch(() => setOrders([]))
  }, [user])

  if (!user) {
    return (
      <div className="app">
        <Header />
        <main className="page">
          <div className="profile-signin">
            <div className="avatar avatar-lg" aria-hidden>
              ◗
            </div>
            <h1>Your profile</h1>
            <p className="muted">Sign in to keep your orders and details here.</p>
            <Link className="btn btn-accent btn-lg btn-block" to="/login">
              Sign in
            </Link>
            <Link className="btn btn-ghost btn-block" to="/register">
              Create an account
            </Link>
            <p className="tiny muted" style={{ marginTop: 14 }}>
              You can order without one.
            </p>
          </div>
        </main>
      </div>
    )
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api('/auth/me', { method: 'PATCH', body: { name: name.trim(), phone: phone.trim() } })
      await refresh()
      toast('Saved', 'good')
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSaving(false)
    }
  }

  // Made by a first order: no email of their own, only their number.
  const phoneOnly = user.email.endsWith("@guest.khapee.com")
  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('')

  const since = new Date(user.memberSince)
  const sinceLabel = Number.isNaN(since.getTime())
    ? ''
    : since.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="app">
      <Header />
      <main className="page">
        <section className="profile-head">
          <div className="avatar avatar-lg">{initials || '◗'}</div>
          <div style={{ minWidth: 0 }}>
            <h1>{user.name}</h1>
            <p className="muted">{phoneOnly ? user.phone : user.email}</p>
            {sinceLabel && <p className="tiny muted">Since {sinceLabel}</p>}
          </div>
        </section>

        <div className="edit-grid">
          <form className="card card-pad" onSubmit={save}>
            <h2 style={{ marginBottom: 14 }}>Details</h2>
            {error && <div className="form-error">{error}</div>}

            <div className="field">
              <label htmlFor="pr-name">Name</label>
              <input id="pr-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="pr-phone">Phone</label>
              <input
                id="pr-phone"
                className="input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                autoComplete="tel"
              />
            </div>
            {!phoneOnly && (
              <div className="field">
                <label htmlFor="pr-email">Email</label>
                <input id="pr-email" className="input" value={user.email} readOnly disabled />
              </div>
            )}

            <button className="btn btn-accent btn-lg" disabled={saving}>
              {saving ? <Spinner /> : 'Save'}
            </button>
          </form>

          <div className="stack">
            <section className="card card-pad">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2>Veg only</h2>
                <button
                  className={`switch ${vegOnly ? 'on' : ''}`}
                  onClick={() => setVegOnly(!vegOnly)}
                  aria-pressed={vegOnly}
                  aria-label="Veg only"
                />
              </div>
            </section>

            <section className="card card-pad">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <h2>Orders</h2>
                <Link className="btn btn-ghost btn-sm" to="/orders">
                  All
                </Link>
              </div>
              {orders === null ? (
                <LoadingBlock />
              ) : orders.length === 0 ? (
                <p className="tiny muted">None yet</p>
              ) : (
                <ul className="group-items">
                  {orders.slice(0, 4).map((o) => (
                    <li key={o.id}>
                      <Link to={`/order/${o.orderNumber}`}>
                        #{o.orderNumber} · {o.restaurantName}
                      </Link>
                      <span className="tiny muted">{STATUS_LABEL[o.status as OrderStatus]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {user.restaurants.length > 0 && (
              <section className="card card-pad">
                <h2 style={{ marginBottom: 10 }}>Your restaurants</h2>
                <ul className="group-items">
                  {user.restaurants.map((r) => (
                    <li key={r.id}>
                      <span>
                        {r.emoji} {r.name}
                      </span>
                      <Link className="tiny" to="/staff/orders">
                        Open
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <button
              className="btn btn-ghost btn-block"
              onClick={async () => {
                await logout()
                navigate('/')
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
