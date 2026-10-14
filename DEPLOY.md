# Deploying EventPass to a live server

This guide puts the app on **one Ubuntu server (VPS)** with:

- **SQLite** database (built in — nothing extra to install)
- **Caddy** for free automatic HTTPS
- **systemd** to keep the app running and start it on boot
- **daily backups**

Time needed: about 1 hour. Commands marked **(server)** are typed in the SSH session; **(your PC)** in PowerShell on your computer.

---

## 0. What you need first

| Item | Notes |
|---|---|
| A VPS | Ubuntu **24.04**, 2 vCPU, 2–4 GB RAM, ~40 GB disk. India region (Mumbai/Bangalore) for speed. DigitalOcean, AWS Lightsail, Hostinger VPS, Hetzner, etc. ~₹500–1,500/month. |
| A domain | e.g. `tickets.yourdomain.com` |
| Razorpay and/or Cashfree | Account **activated for live payments** (KYC done, website approved). |
| SMS (smsgw.in) | Username, password, DLT sender ID, PE ID, and an **approved OTP template** + its template ID. |

> Do **not** use Vercel, Netlify, or free Render/Heroku — their disk is wiped on restart and you would lose bookings.

---

## 1. Point your domain at the server

In your domain provider's DNS settings add an **A record**:

| Type | Name | Value |
|---|---|---|
| A | `tickets` (or `@` for the bare domain) | your server's public IP |

It can take 5–30 minutes to work. Check with: `ping tickets.yourdomain.com` (your PC).

---

## 2. Prepare the server

Log in **(your PC)**:
```powershell
ssh root@YOUR_SERVER_IP
```

Then **(server)**:
```bash
# Updates + basic tools
apt update && apt -y upgrade
apt -y install curl ufw debian-keyring debian-archive-keyring apt-transport-https

# Firewall: only SSH and web traffic
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# Node.js 22 (the app needs 22.13 or newer)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
node -v        # must print v22.13 or higher

# Caddy (automatic HTTPS)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy

# A dedicated user for the app, plus folders for code, data and backups
useradd --system --home /var/lib/eventpass --shell /usr/sbin/nologin eventpass
mkdir -p /opt/eventpass /var/lib/eventpass /var/lib/eventpass-backups
chown -R eventpass:eventpass /opt/eventpass /var/lib/eventpass /var/lib/eventpass-backups
```

---

## 3. Upload the app

**(your PC)** — in PowerShell, from the project folder. This packs the code **without** your local test data, `.env` or `node_modules`:
```powershell
cd C:\Users\user\ticket_management
tar -czf $env:TEMP\eventpass.tar.gz --exclude=node_modules --exclude=data --exclude=.env --exclude=.git .
scp $env:TEMP\eventpass.tar.gz root@YOUR_SERVER_IP:/tmp/
```

**(server)**:
```bash
tar -xzf /tmp/eventpass.tar.gz -C /opt/eventpass
chown -R eventpass:eventpass /opt/eventpass
cd /opt/eventpass && sudo -u eventpass npm ci --omit=dev --no-audit --no-fund
```

> You start with a **fresh, empty database** on the server. Your local test bookings stay on your PC.

---

## 4. Create the production settings (`.env`)

**(server)**:
```bash
nano /opt/eventpass/.env
```
Paste this and fill in your values (save: `Ctrl+O`, Enter, `Ctrl+X`):

```ini
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=1
PUBLIC_URL=https://tickets.yourdomain.com
CURRENCY=INR

DATA_DIR=/var/lib/eventpass
BACKUP_DIR=/var/lib/eventpass-backups
BACKUP_KEEP_DAYS=14
SEED_SAMPLE=0
WEB_CONCURRENCY=1

# First admin login (used only on the very first start). Use a long, unique password.
ADMIN_USERNAME=admin
ADMIN_PASSWORD=CHANGE-THIS-to-a-long-password

# Razorpay (live keys start with rzp_live_)
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

# Cashfree (live keys) — leave empty if you don't use it
CASHFREE_APP_ID=
CASHFREE_SECRET_KEY=
CASHFREE_ENV=production

# SMS OTP (smsgw.in) — template text must match your DLT template EXACTLY
SMSGW_USERNAME=
SMSGW_PASSWORD=
SMSGW_SENDER=
SMSGW_PE_ID=
SMSGW_TEMPLATE_ID=
SMS_OTP_TEMPLATE=Your OTP for ticket booking is {otp}. It is valid for 5 minutes. Do not share it with anyone.
SMSGW_COUNTRY_CODE=
```

Lock it down (it contains your payment and SMS secrets):
```bash
chown eventpass:eventpass /opt/eventpass/.env && chmod 600 /opt/eventpass/.env
```

> **Tip:** Go live with **test** gateway keys first (`rzp_test_…`, `CASHFREE_ENV=sandbox` + sandbox keys), do a full test booking, then swap in live keys and restart (step 9).

---

## 5. Start the app

**(server)**:
```bash
cp /opt/eventpass/deploy/eventpass.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now eventpass
systemctl status eventpass --no-pager      # should say "active (running)"
curl http://127.0.0.1:3000/healthz         # should print {"ok":true}
```
See the logs any time with: `journalctl -u eventpass -f`

---

## 6. Turn on HTTPS

**(server)**:
```bash
cp /opt/eventpass/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile        # replace tickets.example.com with YOUR domain
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
systemctl reload caddy
```
Open **https://tickets.yourdomain.com** — you should see the site with a padlock. (If not: the DNS from step 1 may not be ready yet; check `journalctl -u caddy -n 50`.)

---

## 7. First login & admin setup

1. Go to `https://tickets.yourdomain.com/login`, sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
2. **Change password** (sidebar) to a new strong one.
3. **Team & staff** → add a *Staff* account for each gate scanner person.
4. **Payments** → check your gateway(s) show **Live**, pick the **default**.
5. **Events** → create your first event (cover image, ticket categories, payment gateway).

---

## 8. Connect the payment webhooks

Copy the webhook URLs from **Admin → Payments** (they look like `https://tickets.yourdomain.com/api/webhooks/razorpay`).

**Razorpay** — Dashboard → *Account & Settings* → *Webhooks* → *Add new webhook*
- URL: `https://tickets.yourdomain.com/api/webhooks/razorpay`
- Secret: any long random text → put the **same** text in `RAZORPAY_WEBHOOK_SECRET`
- Events: `payment.captured`, `order.paid`
- Also: *Payment capture* should be **automatic** (default for new accounts).

**Cashfree** — Merchant Dashboard → *Developers* → *Webhooks* → *Add webhook*
- URL: `https://tickets.yourdomain.com/api/webhooks/cashfree`, version **2023-08-01**, event **Payment Success**
- Also: *Developers* → *Whitelisting* → add your domain `tickets.yourdomain.com` (Cashfree blocks payments from domains that aren't whitelisted).

After changing `.env`: `systemctl restart eventpass`

---

## 9. Test everything on the live site (before announcing)

On your phone:
1. Open the site → choose tickets → **Continue** → OTP arrives by **SMS** → sign in.
2. Fill details → **Pay** with a small real payment (or test keys first).
3. You land on the **QR ticket**; it also shows under **My account**.
4. Log in as staff on another phone → **Scanner** → scan the QR → **Mark as entered**. (The camera works because the site is HTTPS.)
5. **Admin → Bookings** shows the booking, "Paid via", and the entry badge.

When switching from test to live keys: edit `.env`, then `systemctl restart eventpass`.

---

## 10. Backups (do not skip)

**Daily backup on the server** — **(server)**:
```bash
crontab -u eventpass -e
```
Add this line (runs every night at 2:30 AM):
```
30 2 * * * cd /opt/eventpass && /usr/bin/node --disable-warning=ExperimentalWarning scripts/backup.js >> /var/lib/eventpass-backups/backup.log 2>&1
```
Test it once now:
```bash
sudo -u eventpass bash -c "cd /opt/eventpass && npm run backup"
ls /var/lib/eventpass-backups
```

**Copy backups off the server** (if the server dies, on-server backups die with it). Easiest: [rclone](https://rclone.org) to Google Drive / Backblaze B2 / S3:
```bash
apt -y install rclone
rclone config                  # create a remote, e.g. named "gdrive"
crontab -e                     # (as root) add:
0 3 * * * rclone sync /var/lib/eventpass-backups gdrive:eventpass-backups
```
Many VPS providers also offer automatic server snapshots for a small fee — turn that on too.

**Restore** a backup:
```bash
systemctl stop eventpass
cp /var/lib/eventpass-backups/<date>/tickets.db /var/lib/eventpass/tickets.db
rm -f /var/lib/eventpass/tickets.db-wal /var/lib/eventpass/tickets.db-shm
cp -r /var/lib/eventpass-backups/<date>/uploads /var/lib/eventpass/
chown -R eventpass:eventpass /var/lib/eventpass
systemctl start eventpass
```

---

## 11. Updating the app later

**(your PC)** — pack and upload the new version (same command as step 3):
```powershell
cd C:\Users\user\ticket_management
tar -czf $env:TEMP\eventpass.tar.gz --exclude=node_modules --exclude=data --exclude=.env --exclude=.git .
scp $env:TEMP\eventpass.tar.gz root@YOUR_SERVER_IP:/tmp/
```
**(server)**:
```bash
bash /opt/eventpass/deploy/update.sh
```
It backs up the database, installs the new code (your `.env` and data are kept) and restarts.

---

## 12. Day-to-day

| Task | Command (server) |
|---|---|
| Is it running? | `systemctl status eventpass` |
| Live logs | `journalctl -u eventpass -f` |
| Restart | `systemctl restart eventpass` |
| Forgot admin password | set `ADMIN_PASSWORD` in `.env`, then `sudo -u eventpass bash -c "cd /opt/eventpass && npm run reset-admin"` |
| Disk space | `df -h` |

**Uptime alert (free):** add `https://tickets.yourdomain.com/healthz` to [UptimeRobot](https://uptimerobot.com) to get an SMS/email if the site goes down.

**Server security:** use SSH keys instead of passwords, and keep Ubuntu updated (`apt update && apt -y upgrade`, or enable `unattended-upgrades`).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Site doesn't open / no padlock | DNS not pointing at the server yet, or ports 80/443 blocked (`ufw status`; also check your VPS provider's firewall panel). |
| `502 Bad Gateway` | App isn't running: `journalctl -u eventpass -n 50`. Often a typo in `.env`. |
| OTP SMS not arriving | Check `journalctl -u eventpass | grep sms`. Usually the text doesn't match the DLT template exactly, or wrong sender/template ID. |
| Payment done but no ticket | Webhook not set up / wrong secret. Customer can open *My account* → *Check payment*; the server also asks the gateway directly. |
| Cashfree "domain not whitelisted" | Add your domain in Cashfree → Developers → Whitelisting. |
| Scanner camera doesn't open | Must be opened over **https://**, and allow camera permission in the browser. |
