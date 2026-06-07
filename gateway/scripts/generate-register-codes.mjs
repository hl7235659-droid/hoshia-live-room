import { randomInt } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { openLiveRoomDatabase } from "../src/database.js";
import { hashAccessCode } from "../src/security.js";

const count = Number(process.argv[2] || 20);
if (!Number.isInteger(count) || count <= 0 || count > 500) {
  console.error("Usage: node gateway/scripts/generate-register-codes.mjs 20");
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.resolve(scriptDir, "../data/live-room.sqlite");
const dbPath = path.resolve(process.env.SQLITE_DB_PATH || defaultDbPath);
const db = openLiveRoomDatabase(dbPath);
const codes = [];

while (codes.length < count) {
  const code = generateRegistrationCode();
  try {
    db.insertRegistrationCode({
      id: nanoid(12),
      codeHash: hashAccessCode(code)
    });
    codes.push(code);
  } catch (error) {
    if (!String(error?.message || "").includes("UNIQUE constraint failed")) {
      throw error;
    }
  }
}

const summary = db.countRegistrationCodes();
console.log(`Generated ${codes.length} registration codes.`);
console.log(`SQLite: ${dbPath}`);
console.log(`Available codes in database: ${summary.available}/${summary.total}`);
console.log("");
for (const code of codes) {
  console.log(code);
}

function generateRegistrationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `HOSHA-${randomChunk(alphabet, 4)}-${randomChunk(alphabet, 4)}`;
}

function randomChunk(alphabet, length) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[randomInt(0, alphabet.length)];
  }
  return value;
}
