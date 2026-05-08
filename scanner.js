const USER_ID    = process.env.ROBLOX_USER_ID;
const CF_KV_URL  = process.env.CF_KV_URL;
const CF_TOKEN   = process.env.CF_TOKEN;
const WORKER_URL = process.env.WORKER_URL;
const PROXY_KEY  = process.env.PROXY_KEY;

const ROBLOX_BADGES_API = "https://badges.roblox.com/v1/users";
const ROBLOX_USERS_API  = "https://users.roblox.com/v1/users";
const RETRY_INTERVAL_MS = 5000;
const MAX_RUNTIME_MS    = 270000;

// Все запросы к Roblox идут через Cloudflare Worker (обходит блокировку IP)
async function robloxFetch(url) {
  console.log(`[ROBLOX_FETCH] POST to ${WORKER_URL}/proxy with URL: ${url}`);
  const resp = await fetch(`${WORKER_URL}/proxy`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "x-proxy-key":   PROXY_KEY
    },
    body: JSON.stringify({ url })
  });
  console.log(`[ROBLOX_FETCH] Response status: ${resp.status}`);
  return resp;
}

async function main() {
  if (!USER_ID || !CF_KV_URL || !CF_TOKEN || !WORKER_URL || !PROXY_KEY) {
    console.error("❌ Missing environment variables. Check GitHub Secrets.");
    console.error(`USER_ID: ${USER_ID ? "✓" : "✗"}`);
    console.error(`CF_KV_URL: ${CF_KV_URL ? "✓" : "✗"}`);
    console.error(`CF_TOKEN: ${CF_TOKEN ? "✓" : "✗"}`);
    console.error(`WORKER_URL: ${WORKER_URL ? "✓" : "✗"}`);
    console.error(`PROXY_KEY: ${PROXY_KEY ? "✓" : "✗"}`);
    process.exit(1);
  }

  console.log(`\n🎮 Scanning player: ${USER_ID}\n`);

  const existing = await kvGet(`badges:${USER_ID}`);
  if (existing?.status === "done" && existing.badges.length > 0) {
    console.log(`✅ Already have ${existing.badges.length} badges. Done.`);
    process.exit(0);
  }

  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    attempt++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n⏱️  Attempt #${attempt} (${elapsed}s elapsed)\n`);

    const result = await attemptFetch(USER_ID);

    if (result.success && result.badges.length > 0) {
      console.log(`\n✨ Found ${result.badges.length} badges for ${result.username}\n`);

      await kvPut(`badges:${USER_ID}`, {
        status:    "done",
        scannedAt: new Date().toISOString(),
        userId:    USER_ID,
        username:  result.username,
        badges:    result.badges,
        gamepasses: []
      });
      console.log("💾 Badges saved. Now scanning gamepasses...");

      const gamepasses = await fetchGamepasses(USER_ID);
      console.log(`🎫 Found ${gamepasses.length} gamepasses`);

      await kvPut(`badges:${USER_ID}`, {
        status:    "done",
        scannedAt: new Date().toISOString(),
        userId:    USER_ID,
        username:  result.username,
        badges:    result.badges,
        gamepasses
      });

      await kvDelete(`task:${USER_ID}`);
      console.log("✅ All data saved.");
      process.exit(0);
    }

    if (result.reason === "user_not_found") {
      console.error(`❌ Player ${USER_ID} not found.`);
      process.exit(1);
    }

    if (result.success && result.badges.length === 0) {
      console.log(`⚠️  Inventory open but 0 badges. Retrying in 5s...`);
    } else {
      console.log(`🔒 Inventory private (${result.reason}). Retrying in 5s...`);
    }

    await sleep(RETRY_INTERVAL_MS);
  }

  console.log(`⏰ Time limit reached. Next run in ~30s via cron.`);
  process.exit(0);
}

async function attemptFetch(userId) {
  try {
    console.log(`\n📍 Step 1: Fetching user info...`);
    const userResp = await robloxFetch(`${ROBLOX_USERS_API}/${userId}`);
    console.log(`   Status: ${userResp.status}`);
    
    if (userResp.status === 404) {
      console.log(`   ❌ User not found (404)`);
      return { success: false, reason: "user_not_found" };
    }
    if (!userResp.ok) {
      console.log(`   ❌ Error: ${userResp.status}`);
      return { success: false, reason: `user_${userResp.status}` };
    }
    
    const userData = await userResp.json();
    const username = userData.name;
    console.log(`   ✅ User found: ${username}`);

    const badges = [];
    let cursor = "", pages = 0;

    console.log(`\n📍 Step 2: Fetching badges...`);
    do {
      const url  = `${ROBLOX_BADGES_API}/${userId}/badges?limit=100&sortOrder=Asc` +
                   (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      console.log(`   📄 Page ${pages + 1}: Fetching...`);
      
      const resp = await robloxFetch(url);
      console.log(`   Status: ${resp.status}`);

      if (resp.status === 403 || resp.status === 401) {
        console.log(`   ❌ Access denied (${resp.status})`);
        return { success: false, reason: "private" };
      }
      if (!resp.ok) {
        const errText = await resp.text();
        console.log(`   ❌ Error: ${resp.status}`);
        console.log(`   Response: ${errText.substring(0, 300)}`);
        return { success: false, reason: `badges_${resp.status}` };
      }

      const page = await resp.json();
      console.log(`   📦 Raw response (first 500 chars):`);
      console.log(`      ${JSON.stringify(page).substring(0, 500)}`);
      
      const pageSize = (page.data || []).length;
      console.log(`   🏅 Found ${pageSize} badges on this page`);
      
      for (const b of (page.data || [])) {
        badges.push({
          id:     b.id,
          name:   b.name,
          gameId: b.awarder?.id || null
        });
      }
      cursor = page.nextPageCursor || "";
      pages++;
      console.log(`   📊 Total badges so far: ${badges.length}`);
      console.log(`   🔄 Has next page: ${cursor ? "YES" : "NO"}`);
    } while (cursor && pages < 100);

    console.log(`\n✨ Total badges found: ${badges.length}\n`);
    return { success: true, username, badges };
  } catch (err) {
    console.error(`\n💥 ERROR in attemptFetch:`, err);
    console.error(err.stack);
    return { success: false, reason: "network_error", detail: String(err) };
  }
}

async function fetchGamepasses(userId) {
  const gamepasses = [];
  let lastId = null;
  let pages  = 0;

  try {
    console.log(`\n📍 Step 3: Fetching gamepasses...`);
    do {
      let url = `https://apis.roblox.com/game-passes/v1/users/${userId}/game-passes?count=100`;
      if (lastId) url += `&exclusiveStartId=${lastId}`;

      console.log(`   📄 Page ${pages + 1}: Fetching...`);
      const resp = await robloxFetch(url);
      console.log(`   Status: ${resp.status}`);

      if (!resp.ok) {
        console.log(`   ⚠️  Gamepasses fetch failed: ${resp.status}`);
        break;
      }

      const page = await resp.json();
      const items = page.gamePasses || page.data || [];

      console.log(`   🎫 Found ${items.length} gamepasses on this page`);

      if (items.length === 0) break;

      for (const g of items) {
        gamepasses.push({
          id:          g.gamePassId,
          name:        g.name,
          creatorId:   g.creator?.creatorId   || null,
          creatorName: g.creator?.name        || null,
          creatorType: g.creator?.creatorType || null
        });
      }

      lastId = items[items.length - 1].gamePassId;
      pages++;
      console.log(`   📊 Total gamepasses so far: ${gamepasses.length}`);
      if (items.length < 100) break;
    } while (pages < 100);
  } catch (err) {
    console.log(`   ❌ Gamepasses error: ${err}`);
  }

  console.log(`\n✨ Total gamepasses found: ${gamepasses.length}\n`);
  return gamepasses;
}

async function kvGet(key) {
  try {
    const resp = await fetch(`${CF_KV_URL}/values/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${CF_TOKEN}` }
    });
    if (!resp.ok) return null;
    return JSON.parse(await resp.text());
  } catch { return null; }
}

async function kvPut(key, value) {
  try {
    const resp = await fetch(`${CF_KV_URL}/values/${encodeURIComponent(key)}`, {
      method:  "PUT",
      headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify(value)
    });
    if (!resp.ok) console.error(`❌ KV PUT error: ${await resp.text()}`);
  } catch (err) { console.error(`❌ KV PUT exception: ${err}`); }
}

async function kvDelete(key) {
  try {
    await fetch(`${CF_KV_URL}/values/${encodeURIComponent(key)}`, {
      method:  "DELETE",
      headers: { Authorization: `Bearer ${CF_TOKEN}` }
    });
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
