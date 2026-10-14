// Safe online backup of the database + uploaded images (works while the app is running).
//   node scripts/backup.js            -> writes to BACKUP_DIR (default: <data dir>/../eventpass-backups)
// Keeps the newest BACKUP_KEEP_DAYS (default 14) daily copies. Run it from cron, then copy the
// backup folder off the server (rclone to Google Drive / S3 / Backblaze) — see DEPLOY.md.
try { process.loadEnvFile(); } catch { /* .env is optional */ }
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const backupRoot = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, '..', 'eventpass-backups'));
const keepDays = Number(process.env.BACKUP_KEEP_DAYS) || 14;

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const target = path.join(backupRoot, stamp);
fs.mkdirSync(target, { recursive: true });

// VACUUM INTO makes a consistent copy even while bookings are being written.
const db = new DatabaseSync(path.join(dataDir, 'tickets.db'));
db.exec('PRAGMA busy_timeout = 10000');
db.exec(`VACUUM INTO '${path.join(target, 'tickets.db').replace(/'/g, "''")}'`);
db.close();

const uploads = path.join(dataDir, 'uploads');
if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(target, 'uploads'), { recursive: true });

// Delete backups older than keepDays.
const cutoff = Date.now() - keepDays * 86400_000;
for (const name of fs.readdirSync(backupRoot)) {
  const p = path.join(backupRoot, name);
  if (p !== target && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
}
console.log(`Backup written to ${target}`);
