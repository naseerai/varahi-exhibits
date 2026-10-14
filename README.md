# Event Ticketing

Sell tickets for your events, collect attendee details, take payments, issue QR tickets, and check people in at the gate.

## Features

- **Customers**: browse events → fill details (name, mobile, email, age, gender, address) → add other members, each with their own ticket category → pay → get a QR ticket (print / save / download).
- **Ticket categories**: each event can have several categories (VIP, Gold, General, Student…), each with its own price, optional seat limit and description. The event's total capacity still applies on top. Removing a category that already has sales just stops selling it — sold tickets stay valid.
- **Admin** (`/admin`): create/edit/hide events (categories, total capacity, image), per-category sold / entered / revenue, see bookings with every member, live entered count, revenue, CSV export, manage team logins.
- **Entry staff** (`/scan`): scan QR with the phone camera (or type the ticket ID) → see how many people and their names → tick who is entering → **Mark as entered**. Re-scanning shows *ALREADY ENTERED*; unpaid or wrong-event tickets show red.

## Run it

Needs Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env     # then edit ADMIN_PASSWORD
npm start
```

Open http://localhost:3000. Team login is at http://localhost:3000/login.
The first admin account is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` on first start.
Forgot it? Change `ADMIN_PASSWORD` in `.env` and run `npm run reset-admin`.
Data is stored in `data/tickets.db` (SQLite) and uploaded event images in `data/uploads/`. Back up the whole `data/` folder.

## Payments (Razorpay)

Without keys the app runs in **demo mode** (a "Pay now" button simulates payment). To take real payments:

1. Create a Razorpay account → Settings → API Keys.
2. Put `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `.env` (use `rzp_test_…` keys first) and restart.

Payments are verified on the server using Razorpay's signature, so tickets can't be faked.

## Using the scanner on phones

Phone browsers only allow the camera on **HTTPS**. On your laptop `localhost` works, but for staff phones you must deploy the app with HTTPS (Render, Railway, a VPS with Caddy/Nginx, etc.) or use a tunnel such as `ngrok http 3000` for testing.

## Ideas for next steps

- Email/WhatsApp the ticket link after payment
- Razorpay webhook as a backup for customers who close the browser right after paying
- Coupon codes / early-bird pricing
