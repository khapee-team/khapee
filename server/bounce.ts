/**
 * Did that email bounce? Read from the sending account's own inbox.
 *
 * Asking a domain's mail server whether a mailbox exists (mailbox.ts) needs
 * outbound port 25, which most hosts — Render included — block. What every
 * host allows is IMAP over TLS. So after a code is sent through Gmail, this
 * looks in the same Gmail account (SMTP_USER / SMTP_PASS, the app password
 * works for IMAP too) for the "Address not found" bounce Google sends back
 * within a few seconds when the address does not exist.
 *
 * One plain IMAP conversation, no library: log in, open the inbox, search for
 * a bounce from today that mentions the address, log out. Anything that goes
 * wrong is "unknown", and the caller treats unknown as "sent".
 */
import tls from 'node:tls'

/** One IMAP session: run the commands in order, return every line received. */
function imap(commands: string[], timeoutMs = 8000): Promise<string | null> {
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!user || !pass) return Promise.resolve(null)
  return new Promise((resolve) => {
    const socket = tls.connect({ host: 'imap.gmail.com', port: 993, servername: 'imap.gmail.com' })
    let log = ''
    let step = -1 // -1 waits for the greeting
    let done = false
    const finish = (value: string | null) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))
    const next = () => {
      step++
      if (step >= commands.length) return finish(log)
      socket.write(`A${step} ${commands[step]}\r\n`)
    }
    socket.on('data', (chunk) => {
      log += chunk.toString()
      if (step === -1) {
        if (/^\* OK/m.test(log)) next()
        return
      }
      const tagged = new RegExp(`^A${step} (OK|NO|BAD)`, 'm').exec(log)
      if (!tagged) return
      if (tagged[1] !== 'OK') return finish(null)
      next()
    })
  })
}

const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`

/** Today, the way IMAP's SEARCH SINCE wants it: 9-Oct-2026. */
function imapDate(d = new Date()): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

/**
 * Waits a little for a bounce to the address. True when one arrived — the
 * address does not exist. False otherwise, including when it could not look.
 */
export async function bounced(email: string, { tries = 3, gapMs = 3500 } = {}): Promise<boolean> {
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!user || !pass) return false
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, gapMs))
    const log = await imap([
      `LOGIN ${quote(user)} ${quote(pass.replace(/\s+/g, ''))}`,
      'SELECT INBOX',
      `SEARCH SINCE ${imapDate()} FROM "mailer-daemon" TEXT ${quote(email)}`,
      'LOGOUT',
    ])
    if (log === null) return false
    const hits = /^\* SEARCH([\d ]*)$/m.exec(log)?.[1]?.trim()
    if (hits) return true
  }
  return false
}
