import { createHash } from "node:crypto";

const invite = process.argv[2];
if (!invite) {
  console.error('Usage: node gateway/scripts/hash-invite.mjs "invite-code"');
  process.exit(1);
}

console.log(createHash("sha256").update(invite, "utf8").digest("hex"));

