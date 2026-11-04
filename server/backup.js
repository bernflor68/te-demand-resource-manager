// Consistent online backup of the SQLite database (VACUUM INTO). Usage: node server/backup.js
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

const dir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `te-${new Date().toISOString().slice(0, 10)}.sqlite`);
fs.rmSync(file, { force: true });
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
const old = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort().slice(0, -14);
for (const f of old) fs.rmSync(path.join(dir, f));
console.log(`Backup written: ${file} (kept ${Math.min(14, fs.readdirSync(dir).length)} backups)`);
