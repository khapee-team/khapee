# Running Khapee 24/7 for free on Oracle Cloud

Why move off Render's free plan: it sleeps after fifteen idle minutes and has no
disk, so every wake and every deploy rebuilds the database from the snapshot.
That wipes the list of phones signed up for order alerts, and the order that
wakes the server rings nobody. No setting fixes that; it is what the plan is.

Oracle Cloud's **Always Free** tier gives a real server that never sleeps, with
a disk that keeps its data. On it, nothing is ever rebuilt from the snapshot
after the first boot, so orders, menu edits and alert phones all stay put.

What runs on the server (all in this folder):

| File | What it does |
|---|---|
| `docker-compose.yml` | The app, plus Caddy in front for HTTPS. Both restart on their own, including after a reboot |
| `Caddyfile` | Gets and renews the HTTPS certificate for khapee.com automatically |
| `setup.sh` | One-time setup on a fresh server. Safe to run again |
| `update.sh` | Every two minutes: deploys new commits on `main` (so shipping is still `git push`), and backs up the database once a day, keeping 14 days |
| `.env.example` | The settings. Copied to `deploy/.env` on the server, never committed |

---

## Steps

About 30 minutes, most of it Oracle's sign-up.

### 1. Make the Oracle account

Sign up at <https://www.oracle.com/cloud/free/>. It asks for a card to verify
you; the Always Free resources are not charged.

- **Home region: India West (Mumbai)** or **India South (Hyderabad)** — closest
  to Indore. It cannot be changed later.

### 2. Upgrade the account to Pay As You Go — do not skip

Oracle **stops Always Free servers that look idle** (under 20% CPU for a week),
after an email warning. Khapee will look idle most of the time. Accounts on
Pay As You Go are not subject to this, and the Always Free server still costs
nothing.

Console → **Billing & Cost Management → Upgrade and Manage Payment → Pay As You
Go**. Then **Billing → Budgets → Create Budget** of ₹100 with an email alert,
so any charge at all is announced the moment it happens.

### 3. Create the server

Console → **Compute → Instances → Create instance**.

- **Image:** Canonical Ubuntu 24.04
- **Shape:** Ampere → `VM.Standard.A1.Flex`, **2 OCPUs, 12 GB memory**
  (labelled *Always Free-eligible*)
- **Networking:** keep "Assign a public IPv4 address" on
- **SSH keys:** "Generate a key pair for me" and **download the private key**

If it says *Out of capacity*, try another availability domain in the same
screen, or again in an hour — Oracle's free Arm servers are popular.

Note the **public IP address** on the instance page.

### 4. Open ports 80 and 443

On the instance page: **Subnet → Default Security List → Add Ingress Rules**,
twice:

- Source `0.0.0.0/0`, TCP, destination port `80`
- Source `0.0.0.0/0`, TCP, destination port `443`

### 5. Run the setup

From your computer (use the key you downloaded):

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@YOUR_SERVER_IP
```

Then on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/siyaAgrawal/khapee/main/deploy/setup.sh -o setup.sh
bash setup.sh
```

The repository is private, so `curl` cannot fetch that file directly unless
the repository is public. If it fails, paste the file's contents instead:
`nano setup.sh`, paste, save, then `bash setup.sh`.

It stops twice, on purpose:

1. **It prints a deploy key.** Add it at github.com/khapee-team/khapee →
   Settings → Deploy keys → Add deploy key (title `khapee-server`, write access
   **off**). Run `bash setup.sh` again.
2. **It asks for the settings.** `nano /opt/khapee/deploy/.env` and fill in:
   - `KHAPEE_SECRET` — **copy it from Render** (the khapee service →
     Environment). The same value keeps everybody signed in *and* keeps every
     phone's order alerts working with no re-setup.
   - `KHAPEE_OWNER_EMAILS`, and the `SMTP_*` lines for order emails.

   Run `bash setup.sh` a third time. It builds and starts Khapee.

### 6. Point khapee.com at the server

At your domain registrar, change the DNS records:

- `khapee.com` → **A** record → your server's public IP
- `www.khapee.com` → **A** record → the same IP

Remove the old records that point at Render. Within minutes Caddy gets the
HTTPS certificate on its own. Check it:

```bash
curl https://khapee.com/api/health
```

### 7. Switch Render off

Once the health check above answers from the new server, suspend the `ordro`
service on Render (Settings → Suspend) so there is only one Khapee taking
orders. The marketing site service can stay where it is.

---

## Day to day

- **Shipping:** `git push origin main`. The server deploys it within two minutes.
- **Logs:** `sudo docker compose -f /opt/khapee/deploy/docker-compose.yml logs -f app`
- **Every order alert:** `... logs app | grep '\[alerts\]'` — each order says how
  many phones it rang, or why none.
- **Backups:** daily, inside the data volume at `/data/backups`, last 14 days.
  To copy one to your computer:
  `sudo docker compose -f /opt/khapee/deploy/docker-compose.yml cp app:/data/backups ./backups`

## What changes compared with Render

- The database is permanent. The snapshot seeds the very first boot only; after
  that, `npm run snapshot` is no longer how menu edits are kept.
- The keep-awake ping switches itself off here (there is a disk, so nothing to
  protect).
- Order alerts no longer need anybody to reopen the app after a deploy.
