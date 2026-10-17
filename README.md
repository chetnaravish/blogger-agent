# Blogger Agent

Roz **ek blog post** apne Blogger blog par — khud-ba-khud, bina laptop on rakhe.

- **Blog:** [chetnatechblog.blogspot.com](https://chetnatechblog.blogspot.com)
- **Time:** har din subah **8:00 AM IST**
- **Kaun likhta hai:** Groq AI (OpenAI-compatible API)
- **Images:** Pollinations + Openverse — **dono FREE, koi API key nahi**
- **Publish karta hai:** Blogger API v3 (Google OAuth 2.0)

---

## 1. Architecture — kaise kaam karta hai

```
GitHub Actions cron (8:00 AM IST)
          |
          v
   src/index.js  (ek baar chalta hai, phir exit)
          |
    [1] guard     -> aaj ka post pehle se live hai? toh ruk jao
    [2] topic     -> Groq: naya topic (purane titles se bachkar)
    [3] article   -> Groq: 700-1000 words ka article (JSON)
    [4] images    -> Pollinations (main) / Openverse (backup)
    [5] push      -> images commit+push -> jsDelivr par 200 ka wait
    [6] html      -> Blogger-ready HTML (sanitized)
    [7] post      -> Blogger API v3 posts.insert
    [8] log       -> posted.json me entry
          |
          v
   posted.json + images/  wapas repo me commit
```

### Folder structure

| File | Kaam |
|---|---|
| `src/index.js` | Poora pipeline, ek run, phir exit |
| `src/config.js` | `.env` values + defaults |
| `src/groq.js` | Groq wrapper. **Retired model auto-replace** bhi yahi karta hai |
| `src/topic.js` | Naya topic choose karta hai |
| `src/article.js` | Article likhta hai + validate karta hai (3 retry) |
| `src/images.js` | Pollinations + Openverse + resize/save (0 library) |
| `src/cdn.js` | jsDelivr URL, HTTP 200 check, git push |
| `src/html.js` | HTML sanitize + final post HTML |
| `src/blogger.js` | OAuth token + `posts.insert` |
| `src/logger.js` | `posted.json` + **IST** date calculation |
| `scripts/auth.js` | **One-time** Google login -> refresh token |
| `scripts/check-env.js` | Missing keys ka naam batata hai (value kabhi nahi) |
| `images/` | Generated images (git me jate hain) |
| `posted.json` | Kis din kya post hua |

---

## 2. Keys kahan se laani hain

Sirf **5 keys** chahiye. **Images ke liye koi key nahi chahiye.**

| Variable | Kahan se milegi |
|---|---|
| `GOOGLE_CLIENT_ID` | [Google Cloud Console](https://console.cloud.google.com) > APIs & Services > Credentials > aapka **Desktop app** OAuth client > "Download JSON" |
| `GOOGLE_CLIENT_SECRET` | Usi same JSON file me |
| `BLOGGER_BLOG_ID` | `npm run auth` chalao — wo blog ke naam ke saath id print karta hai |
| `GOOGLE_REFRESH_TOKEN` | `npm run auth` chalao — wo refresh token print karta hai |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) > sign up > **Create API Key** |

### Google Cloud setup (sirf ek baar)

1. Naya project banao
2. **Blogger API** enable karo (APIs & Services > Library)
3. OAuth consent screen: type **External**, app **"In production"** me daalo
   - Isse refresh token 7 din me expire nahi hota
   - *"Google hasn't verified this app"* warning aayegi — **ye normal hai**, personal use ke liye theek hai
4. Scopes me add karo: `https://www.googleapis.com/auth/blogger`
5. Credentials > **OAuth client ID** > type **Desktop app** > download JSON

---

## 3. Setup — step by step

### Install

```bash
npm install
```

Sirf ek dependency hai: `dotenv`.

### `.env` bharo

`.env` kholo aur 5 values bharo:

```bash
GOOGLE_CLIENT_ID="yahan-apna-client-id"
GOOGLE_CLIENT_SECRET="yahan-apna-secret"
GROQ_API_KEY="gsk_..."
GOOGLE_REFRESH_TOKEN=""      # npm run auth se bharenge
BLOGGER_BLOG_ID=""           # npm run auth se bharenge
```

> **Security:** `.env` `.gitignore` me hai. Kabhi bhi ise commit ya
> chat me paste mat karna. Check karne ke liye:
>
> ```bash
> git check-ignore .env     # .env print hona chahiye
> ```

### Check karo

```bash
npm run check
```

Sirf **naam** dikhata hai, kabhi value nahi. Sab `[ OK ]` aaye toh ready ho.

### `npm run auth` (ek baar, hi)

- Local server `http://localhost:3000` par chalega
- Browser khulega Google ke consent screen par
- **Warning aayegi: "Google hasn't verified this app"**
  - `Advanced` click karo -> `Go to ... (unsafe)` -> `Allow`
- Terminal me **refresh token** print hoga — use copy karke `.env` me
  `GOOGLE_REFRESH_TOKEN="..."` me paste karo
- Wo aapke **saare blogs** ka naam, URL aur id bhi print karta hai —
  `chetnatechblog.blogspot.com` wali id copy karke `BLOGGER_BLOG_ID` me daalo

> `refresh_token` sirf ek baar dikhta hai. Terminal ka scrollback
> share mat karna.

---

## 4. Daily commands

| Command | Kya karta hai |
|---|---|
| `npm run check` | Missing keys ki **sirf list** dikhata hai |
| `npm run auth` | One-time Google login (refresh token + blog id) |
| `npm run post` | Poora pipeline **ek baar** chalata hai |

### Draft test (safe)

`.env` me `PUBLISH_AS_DRAFT="true"` rakho (default hi `true` hai).

```bash
npm run post
```

Post **draft** banega — sirf aapko Blogger > Posts > Drafts me dikhega.
Readers ko kuch nahi dikhega.

### Live jana

1. Draft ko Blogger me kholo aur padho
2. Sab theek lage toh `.env` me badlo:
   ```bash
   PUBLISH_AS_DRAFT="false"
   ```
3. `npm run post` chalao

> Live karne se pehle **ek draft zaroor check kar lo**.

---

## 5. Images — kaise kaam karti hain (bina key)

1. **Pollinations** (main) — free AI images, `image.pollinations.ai`
   - Free tier me **1 image per 45 seconds** hai, isliye 3 images me ~90 second lagte hain
2. **Openverse** (backup) — free real photos
   - Sirf CC BY / CC0 / PDM licenses, credit post ke neeche dikhta hai
3. Dono fail -> post **bina image** ke publish ho jaata hai. Crash nahi karta.

Har image ke saath:
- **1280px se chhoti** (actually Pollinations 1024 deta hai)
- **300 KB se chhota** JPEG
- **Alt text** (screen readers ke liye)
- Photographer + license link (Openverse wali images)

### Images kahan rehti hain

Blogger API se image upload nahi hoti. Isliye:

```
images/ folder  ->  GitHub  ->  jsDelivr CDN  ->  blog post
```

```
https://cdn.jsdelivr.net/gh/chetnaravish/blogger-agent@main/images/2026-10-17-hero-a1b2c3.jpg
```

> **Important:** jsDelivr tab tak **404** deta hai jab tak image GitHub par push
> nahi hoti. Isliye agent **pehle images push karta hai**, phir 200 ka wait
> karta hai, **phir** post publish karta hai. Isiliye roz **2 commits** bante
> hain (ek images ka, ek `posted.json` ka). Isse readers ko kabhi tooti image
> nahi dikhti.

Local run me agent push **nahi** karta (aapki marzi). Wahan terminal me
batayega:

```bash
git add images && git commit -m "images" && git push
```

uske baad wahi process 200 ka wait karega.

---

## 6. GitHub setup

### 6a. Secrets daalo

Repo page > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**

Har ek ke liye:

| Name | Value |
|---|---|
| `GROQ_API_KEY` | aapki Groq key |
| `GOOGLE_CLIENT_ID` | aapka client id |
| `GOOGLE_CLIENT_SECRET` | aapka client secret |
| `GOOGLE_REFRESH_TOKEN` | `npm run auth` wala token |
| `BLOGGER_BLOG_ID` | aapka blog id |

> Sirf **naam** daalo secret list me. Values yahan mat likho.

**Optional** — same page > **Variables** tab:

`GROQ_MODEL`, `BLOG_NICHE`, `BLOG_LANGUAGE`

### 6b. Pehli baar manually chalao

Tab me jao: **Actions** > **Daily Blog Post** > **Run workflow**

- `publish_as_draft` = `true` chhod do (sabse pehle draft hi test karo)
- Green tick aaye to workflow theek hai
- Blogger me draft check karo

### 6c. Live jao (manually)

Jab draft perfect lage:

**Actions** > **Daily Blog Post** > **Run workflow** > `publish_as_draft` = **`false`**

> Roz 8:00 AM ke liye `PUBLISH_AS_DRAFT` ko `false` karne ki zaroorat
> **nahi** — default `true` hi rakho har run ke liye, aur terminal me
> `npm run post` se live karo. Ya agar daily auto-live chahiye to
> workflow ka `PUBLISH_AS_DRAFT` line badal do.

### Cron timing

```yaml
- cron: "30 2 * * *"
```

`30 2 * * *` UTC hai = **8:00 AM IST** (UTC + 5:30).

> **Note:** GitHub ka cron **kuch minute late** chalta hai, aur busy
> din me thoda aur late bhi. Ye normal hai, is project me koi bug nahi hai.

---

## 7. Troubleshooting

### `invalid_grant`
Google bol raha hai refresh token marr gaya (revoke / delete / doosre app ka).

```bash
npm run auth      # dobara login, naya token copy karo
```

`.env` me `GOOGLE_REFRESH_TOKEN` update karo.

### `403 insufficientPermissions` (ya "insufficient authentication scopes")
Token ko Blogger ka permission nahi mila.

```bash
npm run auth
```

Is baar Google screen par **saare permissions Allow** karo. Check karo:
`npm run auth` ke end me likha hoga `Blogger scope GRANTED` ya nahi.

### `403` + "blogNotFound"
`BLOGGER_BLOG_ID` galat hai. `npm run auth` se dobara nikalo.

### `redirect_uri_mismatch`
`npm run auth` **dusre browser ya incognito window** me chalayein,
aur poora URL copy karke same browser me kholein.

### JSON parse error / "reply was not valid topic JSON"
AI ne thoda galat format bheja. Code khud **3 baar retry** karta hai.
Agar bar bar aaye to `GROQ_MODEL` change karo — jaise `qwen/qwen3.8-27b`.

### "Model ... is retired" / "not available"
Groq ne model retire kar diya. Agent **khud** naya model chun leta hai
aur terminal me likhta hai:

```
[groq] Model "x" is retired. Switched to "y".
```

Manually pin karna ho to `.env` me `GROQ_MODEL` bhar do.

### `json_validate_failed`
Model ko valid JSON dene me dikkat. Code pehle strict JSON mode try
karta hai, phir plain text maang ke khud parse karta hai. Agar phir bhi
fail ho to `GROQ_MODEL` badal do.

### Images nahi aa rahi
- Terminal me dekho: `Sources used: Pollinations (...)` ya `none`
- Dono source fail hue → post bina image ke chala jaata hai (ye theek hai)
- `[cdn] Timed out waiting for jsDelivr` → images push nahi hue.
  Local run me `git push` karke dobara chalao

### `[cdn] Could not read the GitHub remote`
`git remote -v` chalao — origin set nahi hai.

---

## 8. Settings reference (`.env`)

| Variable | Default | Kaam |
|---|---|---|
| `BLOG_NICHE` | `AI tools, web development, and digital marketing for beginners` | Kis topic me likhna hai |
| `BLOG_LANGUAGE` | `English` | Article ka language |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Text model |
| `PUBLISH_AS_DRAFT` | `true` | `true` = draft, `false` = live |
| `AUTO_COMMIT_PUSH` | `false` | `true` = agent khud images push kare (CI me) |
| `IMAGE_TIMEOUT_SEC` | `60` | Ek image ka max wait |

---

## 9. Security

- `.env` `.gitignore` me hai — commit nahi hoga
- `client_secret*.json` bhi `.gitignore` me hai
- Repo **public** hai, isliye koi bhi secret kabhi bhi commit na ho
- Agent kabhi secret print nahi karta — `npm run check` sirf **naam** dikhata hai
- GitHub Actions me secrets sirf **GitHub Secrets** se aati hain
- Publish karna hamesha `PUBLISH_AS_DRAFT` se control hota hai

Har commit se pehle:

```bash
git status
git check-ignore .env     # .env print hona chahiye
```

---

## 10. Common commands (PowerShell)

```bash
npm install
npm run check
npm run auth
npm run post

git status
git add .
git commit -m "your message"
git push
```

---

**Hinglish summary:** Ye project roz subah 8 baje ek naya blog post
apne Blogger blog par daalta hai — topic AI sochta hai, article likhta
hai, images banata hai, aur publish karta hai. Aapko sirf ek baar
`npm run auth` chalana hai, uske baad sab apne aap hota hai.