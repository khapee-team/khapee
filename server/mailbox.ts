/**
 * Does this email address exist? Asked of the domain's own mail server.
 *
 * The same question every mail server asks before taking a message: connect
 * to the domain's MX, say who it is for (RCPT TO), and read the answer — 250
 * for a mailbox that exists, 550 for one that does not. Nothing is sent; the
 * conversation ends with QUIT before any message.
 *
 * Google answers this plainly for Workspace domains (dalycollege.org runs on
 * Google), which is what lets the coupon say "that email doesn't exist" before
 * sending a code into nothing. Many hosts block outbound port 25; then, or on
 * any answer that is not a clear yes or no, it says "unknown" and the caller
 * carries on as if it had not asked.
 */
import dns from 'node:dns/promises'
import net from 'node:net'

export type Mailbox = 'yes' | 'no' | 'unknown'

export async function mailboxExists(email: string): Promise<Mailbox> {
  const domain = email.split('@')[1]
  if (!domain) return 'no'
  let host = ''
  try {
    const mx = await dns.resolveMx(domain)
    host = mx.sort((a, b) => a.priority - b.priority)[0]?.exchange ?? ''
  } catch {
    return 'unknown'
  }
  if (!host) return 'unknown'

  return new Promise<Mailbox>((resolve) => {
    const socket = net.connect(25, host)
    let done = false
    const finish = (answer: Mailbox) => {
      if (done) return
      done = true
      try {
        socket.write('QUIT\r\n')
      } catch {
        /* closing anyway */
      }
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(6000, () => finish('unknown'))
    socket.on('error', () => finish('unknown'))
    const steps = ['EHLO khapee.com', 'MAIL FROM:<verify@khapee.com>', `RCPT TO:<${email}>`]
    let step = 0
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      // A reply is complete on a line of three digits and a space.
      const last = buffer.split('\r\n').filter(Boolean).pop() ?? ''
      if (!/^\d{3} /.test(last)) return
      const code = Number(last.slice(0, 3))
      buffer = ''
      if (step === steps.length) return finish(code === 250 || code === 251 ? 'yes' : code >= 550 && code <= 553 ? 'no' : 'unknown')
      if (code >= 400) return finish('unknown')
      socket.write(steps[step++] + '\r\n')
    })
  })
}
