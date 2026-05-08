const USER_ID    = process.env.ROBLOX_USER_ID;
const CF_KV_URL  = process.env.CF_KV_URL;
const CF_TOKEN   = process.env.CF_TOKEN;
const WORKER_URL = process.env.WORKER_URL;
const PROXY_KEY  = process.env.PROXY_KEY;

const RETRY_INTERVAL_MS = 5000;
const MAX_RUNTIME_MS    = 270000;

async function robloxFetch(url) {
  return fetch(`${WORKER_URL}/proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-proxy-key": PROXY_KEY
    },
    body: JSON.stringify({ url })
  });
}

async function main() {
  if (!USER_ID || !CF_KV_URL || !CF_TOKEN || !WORKER_URL || !PROXY_KEY) {
    console.error("Missing env variables");
    process.exit(1);
  }

  console.log(`Scanning player: ${USER_ID}`);

  const existing = await kvGet(`badges:${USER_ID}`);
  if (existing?.status === "done" && existing.badges?.length > 0) {
    console.log(`Already scanned: ${existing.badges.length}`);
    process.exit(0);
  }

  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < MAX_RUNTIME_MS) {
    attempt++;
    console.log(`Attempt #${attempt}`);

    const result = await attemptFetch(USER_ID);

    if (result.success) {
      console.log(`Found ${result.badges.length} badges`);

      await kvPut(`badges:${USER_ID}`, {
        status: "done",
        scannedAt: new Date().toISOString(),
        userId: USER_ID,
        username: result.username,
        badges: result.badges,
        gamepasses: []
      });

      const gamepasses = await fetchGamepasses(USER_ID);

      await kvPut(`badges:${USER_ID}`, {
        status: "done",
        scannedAt: new Date().toISOString(),
        userId: USER_ID,
        username: result.username,
        badges: result.badges,
        gamepasses
      });

      await kvDelete(`task:${USER_ID}`);

      console.log("DONE");
      process.exit(0);
    }

    if (result.reason === "not_found") {
      console.error("User not found");
      process.exit(1);
    }

    if (result.reason === "blocked_or_private") {
      console.log("Blocked/Private/403 — retrying...");
    } else {
      console.log(`Retry reason: ${result.reason}`);
    }

    await sleep(RETRY_INTERVAL_MS);
  }

  console.log("Timeout reached");
}

async function attemptFetch(userId) {
  try {
    const userResp = await robloxFetch(
      `https://users.roblox.com/v1/users/${userId}`
    );

    if (userResp.status === 404)
      return { success: false, reason: "not_found" };

    if (!userResp.ok)
      return { success: false, reason: `user_${userResp.status}` };

    const user = await userResp.json();

    const badges = [];
    let cursor = "";
    let pages = 0;

    do {
      const url =
        `https://badges.roblox.com/v1/users/${userId}/badges?limit=100&sortOrder=Asc` +
        (cursor ? `&cursor=${cursor}` : "");

      const resp = await robloxFetch(url);

      const text = await resp.text();

      // DEBUG (очень важно)
      // console.log("STATUS:", resp.status);
      // console.log(text);

      if (resp.status === 404)
        return { success: false, reason: "not_found" };

      if (resp.status === 401)
        return { success: false, reason: "auth" };

      if (resp.status === 403)
        return { success: false, reason: "blocked_or_private" };

      if (!resp.ok)
        return { success: false, reason: `badges_${resp.status}` };

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { success: false, reason: "invalid_json" };
      }

      for (const b of (data.data || [])) {
        badges.push({
          id: b.id,
          name: b.name,
          gameId: b.awarder?.id || null
        });
      }

      cursor = data.nextPageCursor || "";
      pages++;

    } while (cursor && pages < 100);

    return {
      success: true,
      username: user.name,
      badges
    };

  } catch (e) {
    return { success: false, reason: "network_error", detail: String(e) };
  }
}

async function fetchGamepasses(userId) {
  const result = [];

  try {
    let cursor = "";
    let pages = 0;

    do {
      const url =
        `https://games.roblox.com/v2/users/${userId}/game-passes?limit=100` +
        (cursor ? `&cursor=${cursor}` : "");

      const resp = await robloxFetch(url);

      const text = await resp.text();

      if (!resp.ok) break;

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        break;
      }

      const items = data.data || [];

      for (const g of items) {
        result.push({
          id: g.id,
          name: g.name
        });
      }

      cursor = data.nextPageCursor || "";
      pages++;

      if (items.length < 100) break;

    } while (pages < 50);

  } catch (e) {
    console.log("gamepasses error", e);
  }

  return result;
}

async function kvGet(key) {
  const r = await fetch(`${CF_KV_URL}/values/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${CF_TOKEN}` }
  });
  if (!r.ok) return null;
  return r.json();
}

async function kvPut(key, value) {
  await fetch(`${CF_KV_URL}/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${CF_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)
  });
}

async function kvDelete(key) {
  await fetch(`${CF_KV_URL}/values/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${CF_TOKEN}` }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

main().catch(console.error);
