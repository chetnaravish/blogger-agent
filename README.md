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
| `npm run post` | Article banata hai (pehle draft) |

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

📖 **Full guide:** [docs/HOW-TO.md](docs/HOW-TO.md)