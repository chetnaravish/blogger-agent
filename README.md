# Blogger Agent

Roz subah **8:00 AM** apne Blogger blog par ek naya article, apne aap.

- 🤖 Topic + article AI likhta hai (Groq)
- 🖼️ Images khud banti hain — **koi free image API key nahi lagti**
- ⏰ Chalta hai GitHub se, aapka laptop band bhi ho to chalega
- 🔒 Aapki keys `.env` me hain jo kabhi GitHub par nahi jaata

**Blog:** [chetnatechblog.blogspot.com](https://chetnatechblog.blogspot.com)

---

## 🔰 Main bilkul naya hoon — yahan se shuru karo

👉 **[HOW-TO.md](docs/HOW-TO.md) — poori step-by-step guide, Hinglish me**

Us ek file me sab kuch hai: keys kahan se leni hain, login kaise karna hai,
GitHub par kya daalna hai, aur error aaye to kya karna hai.

---

## Sirf 3 commands

| Command | Kya karta hai |
|---|---|
| `npm run check` | Batata hai kya-kya missing hai |
| `npm run auth` | **Ek hi baar** chalana hai (Google login) |
| `npm run post` / `npm run daily` | Article banata hai (pehle draft) |
| `npm run portfolio:dry` | Portfolio article banata hai, sirf `out/portfolio/` me likhta hai |
| `npm run portfolio:publish` | Portfolio article ko seedha portfolio repo me push karta hai |

---

## Kya chahiye

1. **Node.js** (18+) — [nodejs.org](https://nodejs.org) se download karo
2. **Groq API key** — [console.groq.com/keys](https://console.groq.com/keys)
3. **Google OAuth client** — Google Cloud Console se
4. **Blogger blog** — aapka already hai ✅

Details [HOW-TO.md](docs/HOW-TO.md) me hain.

---

## Safety

- `.env` me ki hui keys kabhi GitHub par nahi jaati (`.gitignore` me hai)
- Agent koi secret screen par print nahi karta
- Live publish tab hota hai jab aap khud `PUBLISH_AS_DRAFT="false"` karein

---

## Portfolio website (second article)

Agent do alag kaam karta hai, do alag code paths me:

| | Blogger | Portfolio |
|---|---|---|
| Code | `src/index.js` | `src/portfolioEntry.js` + `src/portfolio*.js` |
| Kab | Roz 8 AM IST | Har 3 din me ek baar (Blogger ke baad) |
| GitHub Actions | job `publish` | alag job `portfolio` (`needs: publish`) |
| Topic | roz ka naya topic (news / SEO) | **apne topics**: `prompts/portfolio_topics.json` (What is digital marketing, How to make your own chatbot, What is the YouTube algorithm...) |
| Style | SEO guide, third person | beginner explainer, **first person** (Chetna ki awaaz, "I / my / you"), proper English, portfolio template |

**Topics badalne ke liye** sirf `prompts/portfolio_topics.json` edit karein:
list upar se neeche use hoti hai, jo topic already portfolio pe hai wo skip
hota hai. List khatam ho jaye to Groq isi style ka naya topic suggest karta hai.

Portfolio job alag process me chalta hai, Blogger job ke baad. Wo fail ho
jaye to Blogger post pe koi asar nahi.
Jis din 3 din pure nahi hue, portfolio job bas "skipping" likh kar khatam
ho jata hai.

**Live karne ke liye:** GitHub > Settings > Secrets and variables > Actions:
- Secret `PORTFOLIO_GH_TOKEN` add karein
- Variable `PORTFOLIO_PUBLISH` = `true` add karein (iske bina har run dry run hai)

Naye env vars (details `.env.example` me):

| Variable | Kaam |
|---|---|
| `PORTFOLIO_GH_TOKEN` | Fine-grained GitHub token (Contents: Read and write) for `chetnaravish/portfolio` |
| `PORTFOLIO_REPO` | Default `chetnaravish/portfolio` |
| `PORTFOLIO_BRANCH` | Default `main` |
| `PORTFOLIO_SITE_URL` | Default `https://chetnaportflio.vercel.app` |
| `PORTFOLIO_GROQ_MODEL` | Optional; portfolio article ka Groq model. Blank = `GROQ_MODEL`. Blogger hamesha `GROQ_MODEL` use karta hai. |
| `PORTFOLIO_PUBLISH` | Daily push sirf tab jab exactly `"true"` ho |
| `PORTFOLIO_FORCE` | Optional; same date par dobara portfolio post force karna |
| `PORTFOLIO_INTERVAL_DAYS` | Default `3`; portfolio post ke beech minimum IST calendar days. `PORTFOLIO_FORCE=true` ise bypass karta hai. |

Portfolio interval `automation/published-posts.json` ki newest date se
calculate hota hai. `npm run portfolio:publish` interval bypass karta hai;
`npm run portfolio:dry` sirf warning deta hai, kabhi block nahi karta.

Commands:

```powershell
npm run portfolio:dry        # always dry, kabhi GitHub write nahi
npm run portfolio:publish    # real atomic commit, PORTFOLIO_PUBLISH ignore
npm run portfolio:scheduled  # wahi jo Actions chalata hai (interval + PORTFOLIO_PUBLISH)
```

Ek specific topic test karna ho:
`npm run portfolio:dry -- --topic="What is SEO" --category=digital_marketing`
(categories: `digital_marketing`, `ai`, `vibe_coding`).

Dry run `out/portfolio/` me wahi files banata hai jo commit hoti:
new post HTML, updated `blog.html`, updated `sitemap.xml`, updated
`automation/published-posts.json`, cover WebP aur card WebP.

Portfolio job jab `PORTFOLIO_PUBLISH` `"true"` nahi hota, tab sirf
dry run karta hai. Templates hamesha portfolio repo se runtime par padhe
jaate hain - is repo me copy nahi hote.

Portfolio repo me ye cheezein zaroori hain:

- `templates/blog-post.template.html`
- `templates/blog-card.template.html`
- `public/blog.html` with `<!-- BLOG_CARDS_START -->`
- `public/sitemap.xml` with `<!-- BLOG_SITEMAP_INSERT -->`
- `automation/published-posts.json` (optional; agent khud bana deta hai)

---

📖 **Full guide:** [docs/HOW-TO.md](docs/HOW-TO.md)