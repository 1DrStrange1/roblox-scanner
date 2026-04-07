const USER_ID   = process.env.ROBLOX_USER_ID;
const CF_KV_URL = process.env.CF_KV_URL;
const CF_TOKEN  = process.env.CF_TOKEN;

const ROBLOX_BADGES_API    = "https://badges.roblox.com/v1/users";
const ROBLOX_USERS_API     = "https://users.roblox.com/v1/users";
const ROBLOX_INVENTORY_API = "https://inventory.roblox.com/v1/users";
const RETRY_INTERVAL_MS    = 5000;
const MAX_RUNTIME_MS       = 270000;

async function main() {
  if (!USER_ID || !CF_KV_URL || !CF_TOKEN) {
    console.error("Missing environment variables. Check GitHub Secrets.");
    process.exit(1);
  }

  console.log(`Scanning player: ${USER_ID}`);

  const existing = await kvGet(`badges:${USER_ID}`);
  if (existing?.status === "done" && existing.badges.length > 0) {
    console.log(`Already have ${existing.badges.length} badges. Done.`);
    process.exit(0);
  }

  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    attempt++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`Attempt #${attempt} (${elapsed}s elapsed)`);

    const result = await attemptFetch(USER_ID);

    if (result.success && result.badges.length > 0) {
      console.log(`Found ${result.badges.length} badges for ${result.username}`);

      // Сохраняем ачивки сразу
      await kvPut(`badges:${USER_ID}`, {
        status:    "done",
        scannedAt: new Date().toISOString(),
        userId:    USER_ID,
        username:  result.username,
        badges:    result.badges,
        gamepasses: []
      });
      console.log("Badges saved. Now scanning gamepasses...");

      // Сканируем геймпассы — если инвентарь закроется, ачивки уже сохранены
      const gamepasses = await fetchGamepasses(USER_ID);
      console.log(`Found ${gamepasses.length} gamepasses`);

      // Обновляем запись с геймпассами
      await kvPut(`badges:${USER_ID}`, {
        status:    "done",
        scannedAt: new Date().toISOString(),
        userId:    USER_ID,
        username:  result.username,
        badges:    result.badges,
        gamepasses
      });

      await kvDelete(`task:${USER_ID}`);
      console.log("All data saved.");
      process.exit(0);
    }

    if (result.reason === "user_not_found") {
      console.error(`Player ${USER_ID} not found.`);
      process.exit(1);
    }

    if (result.success && result.badges.length === 0) {
      console.log(`Inventory open but 0 badges. Retrying in 5s...`);
    } else {
      console.log(`Inventory private (${result.reason}). Retrying in 5s...`);
    }

    await sleep(RETRY_INTERVAL_MS);
  }

  console.log(`Time limit reached. Next run in ~30s via cron.`);
  process.exit(0);
}

async function attemptFetch(userId) {
  try {
    const userResp = await fetch(`${ROBLOX_USERS_API}/${userId}`, {
      headers: { Accept: "application/json" }
    });
    if (userResp.status === 404) return { success: false, reason: "user_not_found" };
    if (!userResp.ok)           return { success: false, reason: `user_${userResp.status}` };
    const { name: username } = await userResp.json();

    const badges = [];
    let cursor = "", pages = 0;

    do {
      const url  = `${ROBLOX_BADGES_API}/${userId}/badges?limit=100&sortOrder=Asc` +
                   (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const resp = await fetch(url, { headers: { Accept: "application/json" } });

      if (resp.status === 403 || resp.status === 401)
        return { success: false, reason: "private" };
      if (!resp.ok)
        return { success: false, reason: `badges_${resp.status}` };

      const page = await resp.json();
      for (const b of (page.data || [])) {
        badges.push({
          id:       b.id,
          name:     b.name,
          gameId:   b.awarder?.id   || null,
          gameName: b.awarder?.name || null
        });
      }
      cursor = page.nextPageCursor || "";
      pages++;
    } while (cursor && pages < 100);

    return { success: true, username, badges };
  } catch (err) {
    return { success: false, reason: "network_error", detail: String(err) };
  }
}

async function fetchGamepasses(userId) {
  const gamepasses = [];
  let cursor = "", pages = 0;

  try {
    do {
      const url = `${ROBLOX_INVENTORY_API}/${userId}/items/GamePass?limit=100&sortOrder=Asc` +
                  (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const resp = await fetch(url, { headers: { Accept: "application/json" } });

      if (!resp.ok) {
        console.log(`Gamepasses fetch failed: ${resp.status}`);
        break;
      }

      const page = await resp.json();
      for (const g of (page.data || [])) {
        gamepasses.push({
          id:       g.id,
          name:     g.name,
          gameId:   g.assetType === "GamePass" ? null : null
        });
      }
      cursor = page.nextPageCursor || "";
      pages++;
    } while (cursor && pages < 100);
  } catch (err) {
    console.log(`Gamepasses error: ${err}`);
  }

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
    if (!resp.ok) console.error(`KV PUT error: ${await resp.text()}`);
  } catch (err) { console.error(`KV PUT exception: ${err}`); }
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
  console.error("Unexpected error:", err);
  process.exit(1);
});
