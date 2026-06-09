import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "../src/server.js";
import { cookieStatus, normalizeSearchResponse, resolveQqMusic } from "../src/qqmusic.js";

test("cookie status redacts sensitive values", () => {
  const status = cookieStatus("uin=o123456789; qm_keyst=DUMMY_QM_KEY; skey=DUMMY_SKEY");
  assert.equal(status.configured, true);
  assert.equal(status.qq, "12***89");
  assert.equal(status.has_qm_keyst, true);
  assert.equal(status.has_skey, true);
  assert.equal(JSON.stringify(status).includes("DUMMY_QM_KEY"), false);
  assert.equal(JSON.stringify(status).includes("DUMMY_SKEY"), false);
});

test("normalizes QQ search response", () => {
  const items = normalizeSearchResponse({
    data: {
      song: {
        list: [{
          id: 1,
          mid: "songmid",
          name: "晴天",
          interval: 269,
          singer: [{ name: "周杰伦" }],
          album: { mid: "albummid", name: "叶惠美" },
          file: { media_mid: "mediamid", size_320: 1 }
        }]
      }
    }
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "晴天");
  assert.equal(items[0].artist, "周杰伦");
  assert.equal(items[0].songmid, "songmid");
  assert.equal(items[0].mediaMid, "mediamid");
  assert.equal(items[0].platform, "QQMusicVIP");
  assert.equal(items[0].artwork.includes("albummid"), true);
});

test("normalizes modern musicu search response", () => {
  const items = normalizeSearchResponse({
    req_1: {
      data: {
        body: {
          song: {
            list: [{
              mid: "modern-songmid",
              name: "一路向北",
              singer: [{ name: "周杰伦" }],
              album: { mid: "modern-album", name: "十一月的萧邦" },
              file: { media_mid: "modern-media", size_128mp3: 1 }
            }]
          }
        }
      }
    }
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].songmid, "modern-songmid");
  assert.equal(items[0].mediaMid, "modern-media");
  assert.equal(items[0].title, "一路向北");
});

test("resolve returns safe error when QQ does not provide purl", async () => {
  const result = await resolveQqMusic({
    cookie: "uin=o123456789; qm_keyst=DUMMY_QM_KEY;",
    item: { songmid: "songmid", mediaMid: "mediamid", file: { size_320: 1 } },
    fetchImpl: async () => jsonResponse({
      code: 0,
      req: { data: { sip: ["https://example.test/"] } },
      req_0: { data: { midurlinfo: [{ purl: "" }] } }
    })
  });
  assert.deepEqual(result, { success: false, error: "qqmusic_unplayable" });
});

test("management API stores cookie but never returns it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqmusic-resolver-"));
  const cookieFile = join(dir, "cookies.txt");
  const server = createServer({ cookieFile, fetchImpl: async () => jsonResponse({ code: 0, data: { song: { list: [] } } }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const cookie = "uin=o123456789; qm_keyst=DUMMY_QM_KEY; skey=DUMMY_SKEY";
    const saved = await fetchJson(`http://127.0.0.1:${port}/auth/cookie`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie })
    });
    assert.equal(saved.ok, true);
    assert.equal(JSON.stringify(saved).includes("DUMMY_QM_KEY"), false);
    assert.equal(await readFile(cookieFile, "utf8"), cookie);

    const status = await fetchJson(`http://127.0.0.1:${port}/auth/status`);
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes("DUMMY_QM_KEY"), false);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    }
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  return await response.json();
}
