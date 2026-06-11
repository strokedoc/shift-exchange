# Shift Exchange

A shared shift-exchange board for physician teams. Built with Vite + React + Tailwind + Firebase Realtime Database, deployed to GitHub Pages.

---

## 1. Firebase setup (5 minutes)

1. Go to [firebase.google.com](https://firebase.google.com) and sign in.
2. Click **Add project** → give it a name (e.g. `shift-exchange`) → Continue through the prompts.
3. In the left sidebar go to **Build → Realtime Database** → **Create database**.
4. Choose a region (e.g. `us-central1`) → select **Start in test mode** → Enable.
5. In the left sidebar go to **Project Settings** (gear icon) → **Your apps** → click the `</>` web icon to register a web app → give it a nickname → **Register app**.
6. Copy the `firebaseConfig` object shown and paste the values into `src/firebase.js`.

### Database rules (paste in the Rules tab of Realtime Database)

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

> These open rules are fine for an internal team tool. Tighten them later if needed.

---

## 2. GitHub setup (5 minutes)

1. Create a new GitHub repository named exactly `shift-exchange` (public).
2. In this folder, run:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin https://github.com/strokedoc/shift-exchange.git
   git push -u origin main
   ```
3. Install dependencies and deploy:
   ```bash
   npm install
   npm run deploy
   ```
   This builds the app and pushes the `dist/` folder to the `gh-pages` branch automatically.
4. In your GitHub repo go to **Settings → Pages** and confirm the source is set to the `gh-pages` branch.

Your app will be live at: `https://YOURUSERNAME.github.io/shift-exchange`

---

## 3. Update your username

Before deploying, replace `YOURUSERNAME` in `package.json` → `"homepage"` with your actual GitHub username.

---

## Local development

```bash
npm install
npm run dev
```
