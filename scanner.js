/**
 * scanner.js — Roblox Badge Scanner
 * Запускается GitHub Actions каждые 5 минут.
 * Внутри одного запуска долбит API каждые 5 секунд ~4.5 минуты.
 * Как только инвентарь открылся — сохраняет в Cloudflare KV и останавливается.
 */

const USER_ID   = process.env.ROBLOX_USER_ID;   // задаётся в GitHub Secrets
const CF_KV_URL = process.env.CF_KV_URL;         // URL Cloudflare KV API
const CF_TOKEN  = process.env.CF_TOKEN;           // Cloudflare API Token

const ROBLOX_BADGES_API = "https://badges.roblox.com/v1/users";
const ROBLOX_USERS_API  = "https://users.roblox.com/v1/users";
const RETRY_INTERVAL_MS = 5000;   // 5 секунд между попытками
const MAX_RUNTIME_MS    = 270000; // 4.5 минуты — чуть меньше лимита Actions

// ─── Главная функция ──────────────────────────────────────────────────────────
async function main() {
  if (!USER_ID || !CF_KV_URL || !CF_TOKEN) {
    console.error("❌ Не заданы переменные окружения. Проверь GitHub Secrets.");
    process.exit(1);
  }

  console.log(`🎮 Сканирую игрока: ${USER_ID}`);
  console.log(`⏱  Буду пробовать ${MAX_RUNTIME_MS / 1000} секунд`);

  // Проверяем — может уже есть данные в KV?
  const existing = await kvGet(`badges:${USER_ID}`);
  if (existing && existing.status === "done") {
    console.log(`✅ Данные уже есть в KV (${existing.badges.length} ачивок). Выходим.`);
    process.exit(0);
  }

  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    attempt++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n🔄 Попытка #${attempt} (прошло ${elapsed}с)`);

    const result = await attemptFetch(USER_ID);

    if (result.success) {
      console.log(`✅ Успех! Найдено ${result.badges.length} ачивок для ${result.username}`);

      await kvPut(`badges:${USER_ID}`, {
        status:    "done",
        scannedAt: new Date().toISOString(),
        userId:    USER_ID,
        username:  result.username,
        badges:    result.badges
      });

      // Удаляем статус задачи если был
      await kvDelete(`task:${USER_ID}`);

      console.log("💾 Данные сохранены в Cloudflare KV навсегда.");
      process.exit(0);
    }

    if (result.reason === "user_not_found") {
      console.error(`❌ Игрок ${USER_ID} не найден. Проверь ID.`);
      process.exit(1);
    }

    console.log(`⏳ Инвентарь закрыт (${result.reason}). Жду 5 секунд...`);

    // Обновляем статус в KV чтобы Worker мог показывать прогресс
    await kvPut(`task:${USER_ID}`, {
      status:    "scanning",
      attempt,
      updatedAt: new Date().toISOString(),
      userId:    USER_ID,
      runner:    "github-actions"
    });

    await sleep(RETRY_INTERVAL_MS);
  }

  console.log(`\n⏰ Время вышло (${MAX_RUNTIME_MS / 1000}с). GitHub Actions запустит заново через 5 минут.`);
  process.exit(0);
}

// ─── Roblox API ───────────────────────────────────────────────────────────────
async function attemptFetch(userId) {
  try {
    // Получаем имя пользователя
    const userResp = await fetch(`${ROBLOX_USERS_API}/${userId}`, {
      headers: { Accept: "application/json" }
    });
    if (userResp.status === 404) return { success: false, reason: "user_not_found" };
    if (!userResp.ok)           return { success: false, reason: `user_${userResp.status}` };
    const { name: username } = await userResp.json();

    // Получаем бейджи с пагинацией
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
          id:          b.id,
          name:        b.name,
          description: b.description || "",
          imageUrl:    b.displayIconImageUrl || null,
          awardedAt:   b.created || null,
          enabled:     b.enabled
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

// ─── Cloudflare KV API ────────────────────────────────────────────────────────
// CF_KV_URL формат: https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/storage/kv/namespaces/NAMESPACE_ID

async function kvGet(key) {
  try {
    const resp = await fetch(`${CF_KV_URL}/values/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${CF_TOKEN}` }
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function kvPut(key, value) {
  try {
    const resp = await fetch(`${CF_KV_URL}/values/${encodeURIComponent(key)}`, {
      method:  "PUT",
      headers: {
        Authorization:  `Bearer ${CF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(value)
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`KV PUT error: ${err}`);
    }
  } catch (err) {
    console.error(`KV PUT exception: ${err}`);
  }
}

async function kvDelete(key) {
  try {
    await fetch(`${CF_KV_URL}/values/${encodeURIComponent(key)}`, {
      method:  "DELETE",
      headers: { Authorization: `Bearer ${CF_TOKEN}` }
    });
  } catch {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Старт ───────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error("💥 Неожиданная ошибка:", err);
  process.exit(1);
});
