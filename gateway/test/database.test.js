import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nanoid } from "nanoid";
import { DatabaseError, openLiveRoomDatabase } from "../src/database.js";
import { hashAccessCode, hashPassword } from "../src/security.js";

test("registration code creates one user and cannot be reused", () => {
  const { db, cleanup } = openTempDb();
  try {
    db.insertRegistrationCode({
      id: nanoid(12),
      codeHash: hashAccessCode("HOSHA-7K2P-MQ9A")
    });

    const user = db.createUserWithRegistrationCode({
      registrationCodeHash: hashAccessCode("hosha-7k2p-mq9a"),
      user: {
        id: "user-1",
        username: "Friend.One",
        passwordHash: hashPassword("password-1"),
        nickname: "Friend"
      }
    });

    assert.equal(user.id, "user-1");
    assert.equal(db.countRegistrationCodes().available, 0);
    assert.throws(() => {
      db.createUserWithRegistrationCode({
        registrationCodeHash: hashAccessCode("HOSHA-7K2P-MQ9A"),
        user: {
          id: "user-2",
          username: "friend-two",
          passwordHash: hashPassword("password-2"),
          nickname: "Friend Two"
        }
      });
    }, (error) => error instanceof DatabaseError && error.code === "registration_code_used");
  } finally {
    cleanup();
  }
});

test("usernames are unique after normalization", () => {
  const { db, cleanup } = openTempDb();
  try {
    db.insertRegistrationCode({ id: "code-1", codeHash: hashAccessCode("HOSHA-AAAA-1111") });
    db.insertRegistrationCode({ id: "code-2", codeHash: hashAccessCode("HOSHA-BBBB-2222") });

    db.createUserWithRegistrationCode({
      registrationCodeHash: hashAccessCode("HOSHA-AAAA-1111"),
      user: {
        id: "user-1",
        username: "Friend",
        passwordHash: hashPassword("password-1"),
        nickname: "Friend"
      }
    });

    assert.throws(() => {
      db.createUserWithRegistrationCode({
        registrationCodeHash: hashAccessCode("HOSHA-BBBB-2222"),
        user: {
          id: "user-2",
          username: "friend",
          passwordHash: hashPassword("password-2"),
          nickname: "Friend Again"
        }
      });
    }, (error) => error instanceof DatabaseError && error.code === "username_taken");
  } finally {
    cleanup();
  }
});

test("room messages are persisted and returned oldest to newest within limit", () => {
  const { db, cleanup } = openTempDb();
  try {
    for (let index = 0; index < 105; index += 1) {
      db.insertRoomMessage({
        type: "danmaku",
        id: `message-${index}`,
        room_id: "room-1",
        user_id: "user-1",
        nickname: "Friend",
        role: "user",
        text: `message ${index}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      }, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
    }

    const messages = db.listRecentRoomMessages("room-1", 100);
    assert.equal(messages.length, 100);
    assert.equal(messages[0].id, "message-5");
    assert.equal(messages[99].id, "message-104");
  } finally {
    cleanup();
  }
});

test("user profile and password can be updated", () => {
  const { db, cleanup } = openTempDb();
  try {
    db.insertRegistrationCode({ id: "code-1", codeHash: hashAccessCode("HOSHA-PROF-1111") });
    const user = db.createUserWithRegistrationCode({
      registrationCodeHash: hashAccessCode("HOSHA-PROF-1111"),
      user: {
        id: "user-1",
        username: "Friend",
        passwordHash: hashPassword("password-1"),
        nickname: "Friend"
      }
    });

    const updated = db.updateUserProfile(user.id, {
      nickname: "Blue Friend",
      avatarUrl: "https://example.com/avatar.png"
    });
    assert.equal(updated.nickname, "Blue Friend");
    assert.equal(updated.avatar_url, "https://example.com/avatar.png");

    const passwordUpdated = db.updateUserPassword(user.id, hashPassword("new-password-1"));
    assert.equal(passwordUpdated.id, "user-1");
    assert.notEqual(passwordUpdated.password_hash, user.password_hash);

    const onlineUpdated = db.addUserOnlineSeconds(user.id, 95);
    assert.equal(onlineUpdated.total_online_seconds, 95);
    assert.equal(db.countUsers(), 1);

    const audience = db.listAudienceUsers();
    assert.equal(audience.length, 1);
    assert.equal(audience[0].nickname, "Blue Friend");
    assert.equal(audience[0].total_online_seconds, 95);
  } finally {
    cleanup();
  }
});

function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-room-db-"));
  const db = openLiveRoomDatabase(path.join(dir, "live-room.sqlite"));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
