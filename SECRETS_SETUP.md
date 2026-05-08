# GitHub Actions Secrets

Add these to your repository settings:

## Required Secrets

### `ROBLOX_TOKEN`
Your Roblox account API token. 

**⚠️ SECURITY:** Never commit this! Only store in GitHub Secrets.

**Get it from:** [Roblox Developer Settings](https://www.roblox.com/my/account)

---

### `ROBLOX_USER_ID`
The Roblox User ID to scan for badges/gamepasses.

Example: `1234567890`

---

### `CF_TOKEN`
Cloudflare API token with KV permissions.

**Get it from:**
1. Cloudflare Dashboard → My Profile → API Tokens
2. Create token with permissions:
   - `Workers KV Storage: Edit`
   - Account resources only

---

### `CF_KV_URL`
Full KV namespace API URL.

**Format:**
```
https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{NAMESPACE_ID}
```

**Get values from:**
- `ACCOUNT_ID`: Cloudflare Dashboard → Account Settings
- `NAMESPACE_ID`: Cloudflare Dashboard → Workers → KV → Namespace ID

---

## How to Add Secrets

1. Go to your GitHub repo
2. **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Enter name and value
5. Click **Add secret**

---

## Testing

After adding secrets, run:
```bash
git commit --allow-empty -m "trigger workflow"
git push
```

Check **Actions** tab to see if it worked.
