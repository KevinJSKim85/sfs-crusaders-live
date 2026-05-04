# Firebase Setup — SFS Crusader Hub Admin

This adds an admin panel (`admin.html`, served at `/admin` in production) where staff can:
- Set the weekly **lunch menu** (paste a public Google Drive PDF link → embedded on the dashboard)
- Post **announcements** for the Clubs & Announcements widget

The dashboard reads from Firebase Firestore. The admin panel writes to it. Everything else stays static — deployed via GitHub Pages, Vercel, Netlify, or Firebase Hosting.

> **Cost**: free. Uses Firestore + Auth (Spark plan). No Storage = no Blaze plan required.

---

## Step 1 — Create the Firebase project

1. Go to <https://console.firebase.google.com>.
2. Click **Add project** → name `SFS Crusader Hub` → **Continue**.
3. Disable Google Analytics → **Create project**.

## Step 2 — Register a web app

1. Project dashboard → click the **`</>`** (web) icon.
2. Nickname: `Crusader Hub` → **Register app** (skip Hosting).
3. Copy the `firebaseConfig` object that appears.

## Step 3 — Enable services (Firestore + Auth only)

In the left sidebar:

### Firestore Database
1. **Build → Firestore Database → Create database**
2. Mode: **Production** → Location: **`asia-northeast3`** (Seoul) → Enable.

### Authentication
1. **Build → Authentication → Get started**
2. Sign-in method tab → **Google** → Enable toggle ON → set support email → Save.
3. Settings → **Authorized domains** → add your production domain (e.g. `sfs-crusaders-live.vercel.app`). `localhost` is allowed by default.

> **Storage is intentionally skipped.** Lunch PDFs are stored on Google Drive and embedded by URL — no Storage bucket needed, no Blaze plan upgrade.

## Step 4 — Admin email allowlist

Open `firebase-config.js` and `firestore.rules`. Replace the email in the allowlist with the Google account(s) that should manage content:

```js
// firebase-config.js
window.ADMIN_EMAILS = [
  "your-admin@example.com"
];
```

```ruby
# firestore.rules
function isAdmin() {
  return request.auth != null
      && request.auth.token.email_verified == true
      && request.auth.token.email in [
           "your-admin@example.com"
         ];
}
```

> The client-side allowlist controls UI behavior; the server-side rule is the real enforcement gate. Keep them identical.

## Step 5 — Paste your Firebase config

Open `firebase-config.js` and replace each `REPLACE_ME` with the matching value from the `firebaseConfig` object you copied in Step 2.

## Step 6 — Deploy security rules

`firebase-tools` and `firebase.json` are already set up. From the project folder:

```bash
firebase login                                            # one-time, opens browser
firebase use sfs-crusader-hub                             # link this folder to the project
firebase deploy --only firestore:rules                    # publish the rules
```

Future rule edits redeploy with the same `firebase deploy` command.

## Step 7 — Test locally

1. Serve the folder: `python3 -m http.server 8000`
2. Open `http://localhost:8000/admin.html`
3. **Sign in with Google** → use an admin email
4. **Lunch tab**: paste a Drive link + week label → Save
5. **Announcements tab**: post a test announcement
6. Open `http://localhost:8000/index.html` → confirm the lunch PDF embeds and announcement appears

## Step 8 — Deploy

The HTML files are static — deploy via GitHub push (Vercel auto-builds), drag-and-drop to Netlify, etc.

After deploy, **add the production domain** to **Firebase Console → Authentication → Settings → Authorized domains**. Otherwise Google sign-in fails on production with "auth/unauthorized-domain".

`vercel.json` enables clean URLs so the admin page is reachable at:
- `https://YOUR-DOMAIN/admin` (production)
- `http://localhost:PORT/admin.html` (local — clean URLs only apply on Vercel)

---

## How lunch updates work

```
Avery (every week):
  1. Upload PDF to Google Drive (any folder)
  2. Right-click → Share → "Anyone with the link" → Viewer
  3. Copy link → paste into /admin Lunch tab → Save
  
Dashboard (auto):
  - Reads driveFileId from Firestore every 5 minutes
  - Embeds via https://drive.google.com/file/d/{ID}/preview
  - No upload bandwidth, no storage cost, no file size limit
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `/admin` shows "Firebase not configured" | `firebase-config.js` still has `REPLACE_ME` placeholders. |
| `auth/unauthorized-domain` on sign-in | Production domain missing from Firebase **Authorized domains**. |
| Sign-in popup blocked | Browser blocked it — click the popup blocker icon and allow. |
| "Access denied: ..." after sign-in | Email not in `ADMIN_EMAILS` + `firestore.rules`. Add it, redeploy rules. |
| Lunch PDF doesn't embed | Drive file isn't public — re-share with **Anyone with the link → Viewer**. Some browsers (Safari) may show a download prompt instead of inline preview. |
| Permission denied on write | Server-side rules don't include your email. Update `firestore.rules` and `firebase deploy --only firestore:rules`. |
| Announcements don't show on dashboard | Open browser console — look for Firestore errors. Confirm Firestore is enabled and rules deployed. |

## Data model

### Firestore

```
config/lunch          // single doc
  driveFileId:  string  ("1AbCdEfGhIjK...")
  driveUrl:     string  (the original link the admin pasted)
  week:         string  ("Week of May 5–9, 2026")
  updatedAt:    timestamp

announcements/{auto}  // many docs
  title:        string
  body:         string
  link:         string | null
  tag:          "news" | "event" | "info" | "update"
  active:       boolean
  createdAt:    timestamp
```

No Firebase Storage usage. Lunch PDFs live in Google Drive.
