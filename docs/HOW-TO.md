# Blogger Agent — Poori Guide (Hinglish me)

Ye file aapko **step by step** sab kuch sikhaati hai. Zero se start karo —
har step ke baad ek number hai jo aapko batayega ki sahi ho ya nahi.

---

# 🔰 Part 0: Ek baar ki tayyari

## 0.1 — Node.js install karo

1. [nodejs.org](https://nodejs.org) kholein
2. Bade **LTS** wale button par click karein
3. Download ke baad install karo (sab kuch Next-Next karke)

**Check karo:** VS Code kholein → neeche se **Terminal** kholein
( menu: `Terminal` → `New Terminal`, ya keyboard se **Ctrl + `**)

Type karo:
```
node -v
```
Aapko kuch aisa dikhna chahiye: `v20.19.0` ya usse bada.

✅ **Agar number dikh raha hai = ho gaya.**

---

## 0.2 — Project folder kholo

1. VS Code kholein
2. `File` → `Open Folder`
3. Apna project folder chunein (`blogger-agent` wala folder)

> ⚠️ **Sahi folder chunein** jisme `package.json` hai. Terminal me `ls`
> chala ke dikhna chahiye `package.json`.

---

# Part 1: 5 Keys — kahan se laayein (ek baar)

Ye 5 cheezein chahiye. Har ek ka jawab neeche hai.

---

## Key 1 — `GOOGLE_CLIENT_ID`
## Key 2 — `GOOGLE_CLIENT_SECRET`

**Ye dono ek hi jagah se milte hain.**

1. [Google Cloud Console](https://console.cloud.google.com) kholein
2. Apna project chunein (ya naya banao)
3. Left menu → `APIs & Services` → `Credentials`
4. `OAuth 2.0 Client IDs` me apna **Desktop app** wala client dikhega
5. Us par click karke **`JSON` download** button dabao

Download hui file me ye do cheezein hongi:
- `client_id` → isse `GOOGLE_CLIENT_ID` me daalo
- `client_secret` → isse `GOOGLE_CLIENT_SECRET` me daalo

> 💡 Agar Desktop app wala client nahi hai to `Create Credentials`
> → `OAuth client ID` → Application type **Desktop app** chuno.

---

## Key 3 — `BLOGGER_BLOG_ID`

Aapke paas **already hai!**

Aapka blog URL hai:
```
https://www.blogger.com/blog/posts/1203887681519594903
                                    ^^^^^^^^^^^^^^^^^^^
                                    Yehi hai Blog ID
```

Bas number `1203887681519594903` copy karke `.env` me daalo.

> ✅ Ye humne pehle hi daal diya hai. Aapko kuch nahi karna.

---

## Key 4 — `GROQ_API_KEY`

1. [console.groq.com/keys](https://console.groq.com/keys) kholein
2. Google se sign up kar lein
3. **`Create API Key`** button dabao
4. Ek key banegi → usse copy karo

Ye key `gsk_` se shuru hoti hai.

---

## Key 5 — `GOOGLE_REFRESH_TOKEN`

**Ye sabse important hai aur ye `npm run auth` se milegi.**

Ye step agla hissa hai → [Part 2](#part-2-npm-run-auth--google-login) me
detail me hai. Wahan jaakar poora karo.

---

## Sab keys daal do

1. Project me `.env` file kholein (VS Code me left side me dikhega,
   agar na dikhe to `Ctrl + Shift + P` → `Show Hidden Files` type karo)

2. Ye values ke aage paste kar do:

```
GOOGLE_CLIENT_ID="yahan-apna-client-id"
GOOGLE_CLIENT_SECRET="yahan-apna-secret"
BLOGGER_BLOG_ID="1203887681519594903"
GROQ_API_KEY="gsk_yahan-apni-key"
```

3. File save karo (`Ctrl + S`)

---

## ✅ Check karo ki sab mil gaya

Terminal me type karo:
```
npm run check
```

**Achha output:**
```
[   OK   ] GOOGLE_CLIENT_ID
[   OK   ] GOOGLE_CLIENT_SECRET
[ MISSING ] GOOGLE_REFRESH_TOKEN
[   OK   ] BLOGGER_BLOG_ID
[   OK   ] GROQ_API_KEY
```

> 🔒 Ye command **sirf naam** dikhata hai. Aapki keys kabhi screen par
> nahi aati. Ye safe hai.

---

# Part 2: `npm run auth` — Google Login

**Ye command EXACTLY EK BAAR chalani hai.** Isse aapki permission milti
hai ki agent aapke blog par post kar sake.

## 2.1 — Command chalao

Terminal me type karo:
```
npm run auth
```

## 2.2 — Jo dikhega

Terminal me kuch aisa aayega:

```
=== Blogger Agent : one-time Google login ===

Local callback server started on http://localhost:3000
Opening your browser now...
```

> Aapka browser **khud khul jayega**. Agar na khule to terminal me ek
> lambi link dikhegi — usse copy karke Chrome me khol lein.

## 2.3 — Google screen par

1. Apna **Google account** chunein (wahi jo blog banata hai)
2. Password daalein
3. Ek warning aayegi:

```
Google hasn't verified this app
```

### ⚠️ Ye NORMAL hai — darne ki zaroorat nahi

Aapka apna app hai. Google ne bas verify nahi kiya hai (aapki company
website nahi hai isliye). Personal use ke liye bilkul theek hai.

Aapko ye karna hai:

```
"Advanced"  click karo
      ↓
"Go to <app ka naam> (unsafe)"  click karo
      ↓
"Allow"  click karo
```

> 💡 "Advanced" button chhota aur neeche hota hai — scroll karna pad
> sakta hai.

## 2.4 — Terminal me result

Browser "Login successful" dikha jayega. Ab **wapas terminal dekho** —
wahan ye likha hoga:

```
================= STEP 1 OF 2 =================

Ye line poora copy karke .env me paste kar dijiye:

GOOGLE_REFRESH_TOKEN="1//0eAbCdEf..."

----------------------------------------------
Ye sirf ek baar dikhega aur kisi file me likha nahi gaya.
```

**Ye poori line copy karo:**
```
GOOGLE_REFRESH_TOKEN="1//0eAbCdEf..."
```

> 🔒 **Ye bahut secret hai.** Kisi ko mat bhejna, screenshot mat lena.

## 2.5 — Blogs ki list

Thodi der baad terminal me aapke blogs ki list aayegi:

```
Name : Chetna's Tech Blog
URL  : https://chetnatechblog.blogspot.com/
Id   : 1203887681519594903
---- .env me likhiye: BLOGGER_BLOG_ID="1203887681519594903"
```

> ✅ Ye confirm karta hai ki **sahi blog** mila hai.

## 2.6 — Token `.env` me daalo

1. `.env` file kholein
2. Ye line dhoondhein:
   ```
   GOOGLE_REFRESH_TOKEN=""
   ```
3. Dono quotes ke **beech** token paste kar do:
   ```
   GOOGLE_REFRESH_TOKEN="1//0eAbCdEf..."
   ```
4. Save karo (`Ctrl + S`)

## ✅ Check karo

```
npm run check
```

Ab **sab 5 `[ OK ]`** dikhne chahiye:
```
[   OK   ] GOOGLE_CLIENT_ID
[   OK   ] GOOGLE_CLIENT_SECRET
[   OK   ] GOOGLE_REFRESH_TOKEN
[   OK   ] BLOGGER_BLOG_ID
[   OK   ] GROQ_API_KEY

RESULT: all required keys are present.
```

🎉 **Ab agent poora taiyar hai!**

---

# Part 3: Pehla article (Draft)

> ⚠️ Ye command **draft** banata hai. Aapke readers ko kuch nahi dikhega.

## 3.1 — Chalao

```
npm run post
```

## 3.2 — Jo hoga (2-3 minute lagega)

```
[1/8] Checking whether today's post already exists
      No live post for 2026-10-21. Safe to continue.
[2/8] Choosing a fresh topic
      Topic chosen: How to Use the Groq API for Free
[3/8] Writing the article
      Portfolio link: ON for 2026-10-21
      Title: ...
      Sections: 5, words: 1100
[4/8] Finding topic photos on Pixabay
[images] Source: Pixabay only.
[images] hero (laptop code editor) @ abc123 -> 48 KB
[5/8] Making the images reachable on the web
[cdn] Image is live (check 1).
[6/8] Building the Blogger HTML
      Portfolio link: included
[7/8] Saving the post as a DRAFT
[8/8] Saving the entry to posted.json

================ DONE ================
DRAFT saved. Open Blogger > Posts > Drafts to read it.
```

## 3.3 — Dekho

1. [blogger.com](https://www.blogger.com) kholein
2. Apna blog chunein
3. Left menu → **Posts** → **Drafts**
4. Naya draft dikhega — kholo aur padho

---

# Part 4: Live karna (jab draft perfect lage)

## 4.1 — Pehle check karo

Draft me ye dekh lein:
- Title theek hai?
- Article padhne layak hai?
- Images aa rahi hain?

## 4.2 — Live karo

`.env` me ye line badlo:
```
PUBLISH_AS_DRAFT="true"     ← ye tha
PUBLISH_AS_DRAFT="false"    ← ye karna hai
```

Save karo, phir:
```
npm run post
```

✅ Ab post **live** ho jayegi aur readers ko dikhegi.

---

# Part 5: Roz ka automation (GitHub se chalega)

Ab tak sab aapke laptop par chalta tha. Ab ise GitHub par chalaenge
taaki laptop band ho tab bhi roz post bane.

## 5.1 — GitHub par 5 Secrets daalo

1. Apna repo kholein: **github.com/chetnaravish/blogger-agent**
2. Upar **`Settings`** tab click karo
3. Left menu → **`Secrets and variables`**
4. **`Actions`** click karo
5. **`New repository secret`** (hara button) click karo

Ab har secret ke liye ye karo:

| Field | Kya bharo |
|---|---|
| **Name** | Neeche table se naam |
| **Secret** | `.env` se value copy karke paste |

### 5 secrets ki list

| # | Name (exactly yahi likho) | Value kahan se |
|---|---|---|
| 1 | `GROQ_API_KEY` | `.env` se |
| 2 | `GOOGLE_CLIENT_ID` | `.env` se |
| 3 | `GOOGLE_CLIENT_SECRET` | `.env` se |
| 4 | `GOOGLE_REFRESH_TOKEN` | `.env` se |
| 5 | `BLOGGER_BLOG_ID` | `1203887681519594903` |

Har ek ke baad **Add secret** dabao. Phir wapas **New repository
secret** se agla daalo.

> 🔒 **Values chat me kabhi mat bhejiye.** Sirf confirm karne ke liye
> bhi sirf *naam* bhejiye.

## 5.2 — Test chalao (manually)

1. Repo me **`Actions`** tab click karo
2. Left me **`Daily Blog Post`** click karo
3. Right me **`Run workflow`** button dabao
4. `publish_as_draft` = **`true`** chhod do
5. Green button **`Run workflow`** dabao

1-2 minute me run khatam hoga. Sab theek ho to **green tick** dikhega.

> ⏰ Ye **draft** banayega, live nahi. Aap phir se Blogger me draft
> check kar sakte ho.

## 5.3 — Bas, ho gaya! 🎉

Ab roz subah **8:00 AM IST** apne aap ek post banegi.

Aapko kuch nahi karna — na laptop on rakhna hai, na kuch.

---

## 5.4 — Roz subah 8 baje LIVE karni hai to?

**Tab tak sab draft hi banega — ye theek hai.** Jab aap ready ho:

**Settings** → **Secrets and variables** → **Actions** → **Variables**
→ **New repository variable**

| Field | Value |
|---|---|
| Name | `PUBLISH_LIVE_DAILY` |
| Value | `true` |

Ab har roz 8:00 AM wali post **seedha live** ho jayegi.

> ⚠️ **Dhyan rahe** — ye ON karte hi har roz post public ho jayegi.
> Pakka live karna hai tabhi karein.
>
> Wapas draft karna hai to wahi variable ka value `false` kar do
> (ya variable delete kar do).

**Sirf ek post karni hai live?** Uske liye variable ki zaroorat nahi —
bas **Actions** tab → **Run workflow** → `publish_as_draft` = **`false`**.

---

# Part 6: Error aaye to (Troubleshooting)

---

## ❌ `invalid_grant`

**Matlab:** Google bol raha hai purana token ab kaam nahi karta.

**Karo:**
```
npm run auth
```
Dobara login karo, naya token `.env` me daalo.

**Kyun hota hai:** Token revoke ho gaya, ya 6 mahine baad expire.

---

## ❌ `403` + `insufficientPermissions`

**Matlab:** Token ko Blogger ki permission nahi mili.

**Karo:**
```
npm run auth
```
Is baar Google screen par **saari permissions Allow** karna mat bhoolna.

Check: `npm run auth` ke end me likha hoga `Blogger scope GRANTED` ya nahi.

---

## ❌ `403` + `blogNotFound`

**Matlab:** `BLOGGER_BLOG_ID` galat hai.

**Karo:** `npm run auth` chalao — wo sahi id print karega.

---

## ❌ `redirect_uri_mismatch`

**Karo:** `npm run auth` **same browser** me chalayein. Incognito ya doosre
browser me mat chalayein.

---

## ❌ `redirect_uri_mismatch` (aur phir bhi)

Google kabhi kabhi port change karta hai. `npm run auth` **dobaara**
chalao — wo khud next free port (3000, 3001, ...) lega.

---

## ⚠️ Images nahi aa rahi

Terminal me dekho:
- `[images] hero (...) -> 48 KB` → Pixabay se image mil gayi, sahi chal raha hai
- `[images] Done. 0 image(s)` → search fail hua (net ya API key check karo).
  **Ye theek hai**, post bina image ke chali jaayegi. Agli baar try karo.

Agar ye dikhe:
```
[cdn] Timed out waiting for jsDelivr
```
Toh images GitHub par push nahi hui. Terminal me chalayein:
```
git add images
git commit -m "images"
git push
```

---

## ⚠️ `Model "xxx" is retired`

**Matlab:** Groq ne wo model band kar diya.

Agent **khud** naya model chun leta hai aur aapko bata deta hai:
```
[groq] Model "xxx" is retired. Switched to "yyy".
```

Koi kaam nahi karna. Agar manually fix karna ho to `.env` me:
```
GROQ_MODEL="qwen/qwen3.8-27b"
```

---

## ⚠️ `fetch failed`

**Matlab:** Net connection beech me toot gaya. Aksar iska matlab hota hai ki
Groq ka **per-minute token limit** khatam ho gaya tha.

Code khud 20 second rukh ke dobara try karta hai. Aapko kuch nahi karna.
Agar baar baar aaye to ek-ek step chala kar dekho — `npm run post`.

---

## ⚠️ Model JSON nahi de raha (`Failed to validate JSON`)

Ye problem **`gpt-oss` models** me hoti hai. Wo "reasoning" models hain —
token limit poora reasoning me kha jaata hai aur jawab khaali aa jaata hai.

Isliye project me default model **`qwen/qwen3.8-27b`** rakha hai, jo hamesha
theek JSON deta hai. Agar `.env` me `GROQ_MODEL` kuch aur set kiya hai to
use blank kar do, ya `qwen/qwen3.8-27b` kar do.

---

## ⚠️ `json_validate_failed`

**Matlab:** AI ne thoda galat format bheja.

Code khud 3 baar try karta hai. Phir bhi aaye to `.env` me
`GROQ_MODEL` badal ke `qwen/qwen3.8-27b` kar do.

---

## ❌ `.env` file nahi dikh rahi VS Code me

Left side me us par click karo → eye ka icon (`Show Hidden Files`) dabao.

---

## ❌ `npm` command nahi chal raha

Node.js install nahi hua. Part 0.1 dobara dekho, phir **VS Code
dobara kholo** (tabhi PATH update hoga).

---

# Part 7: Ek nazar me — sab commands

| Command | Kab chalana hai |
|---|---|
| `npm install` | Sirf ek baar, shuru me |
| `npm run check` | Har baar doubt ho ki kya missing hai |
| `npm run auth` | **Sirf ek baar** (Google login) |
| `npm run post` | Article banane ke liye |

| Git command | Kab |
|---|---|
| `git add images` | Images push karne ke liye |
| `git push` | Images push karne ke liye |

---

# 🎯 Aaj ka checklist

| # | Kaam | Hua? |
|---|---|---|
| 1 | Node.js install | ☐ |
| 2 | `.env` me 4 keys daali | ☐ |
| 3 | `npm run check` → sab OK | ☐ |
| 4 | `npm run auth` → login → token paste | ☐ |
| 5 | `npm run post` → draft bani | ☐ |
| 6 | Draft Blogger me check kiya | ☐ |
| 7 | GitHub par 5 Secrets daale | ☐ |
| 8 | Actions → Run workflow → green tick | ☐ |
| 9 | 🎉 Chaa gaya! | ☐ |

---

**Bas! Ab aap poora chala sakte ho.** Koi bhi step me atak jao to
mujhse pooch lena — kaam hai mera, aap sirf commands chalaiye. 💪