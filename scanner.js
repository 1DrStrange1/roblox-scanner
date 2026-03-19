/**
 * scanner.js — Roblox Badge Scanner
 * Сканирует каждые 5 сек в течение 4.5 минут.
 * Когда время выходит — триггерит новый запуск через GitHub API (через ~10 сек).
 * Останавливается только когда найдено больше 0 ачивок.
 */

const USER_ID    = process.env.ROBLOX_USER_ID;
const CF_KV_URL  = process.env.CF_KV_URL;
const CF_TOKEN   = process.env.CF_TOKEN;
const GH_TOKEN   = process.env.GH_TOKEN;    // GitHub Personal Access Token
const GH_REPO    = process.env.GH_REPO;     // формат: owner/repo  например: 1DrStrange1/roblox-scanner

const ROBLOX_BADGES_API = "https://badges.roblox.com/v1/users";
const ROBLOX_USERS_API  = "https://users.roblox.com/v1/users";
const RETRY_INTERVAL_MS = 5000;
const MAX_RUNTIME_MS    = 270000; // 4.5 минуты

async function main() {
  if (!USER_ID || !CF_KV_URL || !CF_TOKEN) {
    console.error("❌ Не заданы переменные окружения. Проверь GitHub Secrets.");
    process.exit(1);
  }

  console.log(`🎮 Сканирую игрока: ${USER_ID}`);

  const existing = await kvGet(`badges:${USER_ID}`);
  if (existing?.status === "done" && existing.badges.length > 0) {
    console.log(`✅ Данные уже есть (${existing.badges.length} ачивок). Выходим.`);
    process.exit(0);
  }

  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    attempt++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n🔄 Попытка #${attempt} (прошло ${elapsed}с)`);

    const result = await attemptFetch(USER_ID);

    if (result.success && result.badges.length > 0) {
      console.log(`✅ Найдено ${result.badges.length} ачивок для ${result.username}`);
      console.log(`📅 Запрашиваю даты получения для сортировки...`);

      const awardedDates = await fetchAwardedDates(USER_ID, result.badges.map(b => b.id));
      result.badges.sort((a, b) => {
        const da = awardedDates[a.id] ? new Date(awardedDates[a.id]) : new Date(0);
        const db = awardedDates[b.id] ? new Date(awardedDates[b.id]) : new Date(0);
        return db - da;
      });

      await kvPut(`badges:${USER_ID}`, {
        status:    "done",
        scannedAt: new Date().toISOString(),
        userId:    USER_ID,
        username:  result.username,
        badges:    result.badges
      });
      await kvDelete(`task:${USER_ID}`);

      console.log("✅ Данные сохранены навсегда.");
      process.exit(0);
    }

    if (result.reason === "user_not_found") {
      console.error(`❌ Игрок ${USER_ID} не найден.`);
      process.exit(1);
    }

    if (result.success && result.badges.length === 0) {
      console.log(`⏳ Инвентарь открыт но ачивок 0. Жду 5 секунд...`);
    } else {
      console.log(`⏳ Инвентарь закрыт (${result.reason}). Жду 5 секунд...`);
    }

    await kvPut(`task:${USER_ID}`, {
      status:    "scanning",
      attempt,
      updatedAt: new Date().toISOString(),
      userId:    USER_ID,
      runner:    "github-actions"
    });

    await sleep(RETRY_INTERVAL_MS);
  }

  // Время вышло — запускаем себя заново через GitHub API
  console.log(`\n⏰ Время вышло. Запускаю новый workflow через GitHub API...`);
  await triggerNewRun();
  process.exit(0);
}

// ─── Триггер нового запуска через GitHub API ──────────────────────────────────
async function triggerNewRun() {
  if (!GH_TOKEN || !GH_REPO) {
    console.log("⚠️ GH_TOKEN или GH_REPO не заданы — жди следующего cron через 5 минут.");
    return;
  }

  // Ждём 10 секунд перед перезапуском
  await sleep(10000);

  try {
    const resp = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/scan.yml/dispatches`, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${GH_TOKEN}`,
        Accept:         "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ref: "main" })
    });

    if (resp.ok || resp.status === 204) {
      console.log("🚀 Новый запуск успешно запущен! Продолжаю сканировать...");
    } else {
      const err = await resp.text();
      console.log(`⚠️ Не удалось запустить: ${resp.status} ${err}`);
    }
  } catch (err) {
    console.log(`⚠️ Ошибка при запуске: ${err}`);
  }
}

// ─── Roblox API ───────────────────────────────────────────────────────────────
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

async function fetchAwardedDates(userId, badgeIds) {
  const dates = {};
  const BATCH = 100;
  for (let i = 0; i < badgeIds.length; i += BATCH) {
    const chunk = badgeIds.slice(i, i + BATCH);
    try {
      const resp = await fetch(
        `${ROBLOX_BADGES_API}/${userId}/badges/awarded-dates?badgeIds=${chunk.join(",")}`,
        { headers: { Accept: "application/json" } }
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const item of (data.data || [])) {
        dates[item.badgeId] = item.awardedDate || null;
      }
    } catch {}
    if (i + BATCH < badgeIds.length) await sleep(200);
  }
  return dates;
}

// ─── KV ──────────────────────────────────────────────────────────────────────
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
  console.error("💥 Неожиданная ошибка:", err);
  process.exit(1);
});
