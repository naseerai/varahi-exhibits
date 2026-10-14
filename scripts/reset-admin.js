// Sets the password of ADMIN_USERNAME to ADMIN_PASSWORD from .env (creates the admin if missing).
// Usage: npm run reset-admin
try { process.loadEnvFile(); } catch { /* .env is optional */ }
const crypto = require('node:crypto');
const db = require('../db');

const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!password || password.length < 8) {
  console.error('Set ADMIN_PASSWORD (at least 8 characters) in .env first.');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  db.prepare(`UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?`).run(hash, existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
} else {
  db.prepare(`INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, 'Administrator', ?, 'admin', ?)`)
    .run(username, hash, new Date().toISOString());
}
console.log(`Admin "${username}" password set from .env.`);
