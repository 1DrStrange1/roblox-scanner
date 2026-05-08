# Roblox Scanner

Scan Roblox player badges and gamepasses with GitHub Actions + Cloudflare Workers.

## Features

✅ **Scan badges** from Roblox profiles  
✅ **Track gamepasses** owned by players  
✅ **Web UI** for viewing results  
✅ **JSON API** for programmatic access  
✅ **GitHub Actions** scheduled scanning  
✅ **Cloudflare KV** persistent storage  

---

## Quick Start

### 1. Fork the Repository
```bash
git clone https://github.com/1DrStrange1/roblox-scanner.git
cd roblox-scanner
```

### 2. Add Secrets to GitHub
See [SECRETS_SETUP.md](SECRETS_SETUP.md) for details.

Required secrets:
- `ROBLOX_TOKEN` — Your Roblox API token
- `ROBLOX_USER_ID` — User ID to scan
- `CF_TOKEN` — Cloudflare API token
- `CF_KV_URL` — KV namespace URL

### 3. Deploy to Cloudflare
See [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) for details.

1. Create KV namespace: `roblox-scanner`
2. Deploy the Worker
3. Bind KV namespace as `RBX`
4. Connect to your domain

### 4. Test
```bash
curl https://yourdomain.com/view/1234567890
```

---

## API Endpoints

### View (HTML)
```
GET /view/:userId
```
Returns an HTML page with badges and gamepasses.

### Results (JSON)
```
GET /results/:userId
```
Returns JSON data of badges and gamepasses.

### Status
```
GET /status/:userId
```
Returns current scan status.

### Delete Cache
```
DELETE /results/:userId
```
Delete cached results and trigger new scan.

---

## How It Works

1. **GitHub Actions** runs `scanner.js` on a schedule
2. Fetches data from **Roblox APIs**
3. Uses `ROBLOX_TOKEN` for authenticated requests
4. Stores results in **Cloudflare KV**
5. **Worker** serves results via HTTP

---

## Security

🔒 **Tokens stored securely:**
- GitHub Secrets (encrypted)
- Cloudflare Environment Variables (encrypted)
- Never committed to repository

---

## Troubleshooting

See [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md#troubleshooting) for common issues.

---

## License

MIT
