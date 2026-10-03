# Run and verify the app

How to open Financiers in a browser to check it: in **GitHub Codespaces** (nothing to install), in
**VS Code** on your computer, or shared temporarily through **Cloudflare**. Every option runs the
same code with **demo data only**: invented customers, loans and payments.

> Never load real customer data into these environments. They are for checking the software;
> production runs on the AWS setup in [doc 13](13-deployment-architecture.md), after Phase 8
> (security hardening) and the ⚖ reviews.

## Quick reference

| You want to… | Use | Time | Needs |
|---|---|---|---|
| Click through the app yourself, nothing installed | **GitHub Codespaces** | ~5 min first time | A GitHub account with access to the repo |
| Work on it on your own computer | **VS Code + Dev Containers** (or a manual setup) | ~10 min | Docker Desktop, VS Code |
| Show it to someone else for an hour | **Cloudflare Quick Tunnel** in front of either of the above | 2 min | `cloudflared` |
| A stable demo link for a few reviewers | **Cloudflare Tunnel + Cloudflare Access** | ~20 min | A domain on Cloudflare (free plan is enough) |

**Not possible:** GitHub Pages and Cloudflare Pages host only static websites. This app needs a
running Node.js API, a PostgreSQL database and file storage, so it cannot run on them as it is.
GitHub Actions runs the automated tests on every push; it does not host the app.

---

## 1. GitHub Codespaces (recommended for checking)

A Codespace is a cloud computer that GitHub runs for you, with VS Code in the browser. The
repository has a ready configuration in `.devcontainer/`: Node 22, pnpm and PostgreSQL 16. On
first start it installs everything, creates the database and loads the demo data.

1. Open the repository on GitHub: `https://github.com/adityakottu/Financiers`.
2. Click **Code** (the green button) → **Codespaces** tab → **Create codespace on main**.
   - If the branch you want is not `main` yet, first choose it in the branch selector, then create
     the codespace.
3. Wait for the setup to finish. The terminal shows `Ready. Start the app with: pnpm demo`, plus
   the **demo sign-ins**. They are also saved in the file `.demo-credentials`, which git ignores.
4. In the terminal, run:
   ```bash
   pnpm demo
   ```
   It builds and starts the app. When it prints *Financiers is running*, open the **Ports** tab
   (next to Terminal) → port **3000** → the globe icon (**Open in Browser**).
5. Sign in as `manager.kkd` with the demo password, and see [§4 What to check](#4-what-to-check).

Notes:
- The forwarded address (`https://<codespace-name>-3000.app.github.dev`) is **private** by
  default: only you, signed in to GitHub, can open it. To let a colleague in, add them to the
  repository and have them create their own codespace. Or use Cloudflare (§3); don't make the
  port public.
- The setup sets `APP_ORIGIN` in `apps/api/.env` to your codespace's address. The API refuses
  sign-ins from any other address (CSRF protection), so this step is required.
- Codespaces stop after 30 minutes idle, and stopped ones are deleted after 30 days. Your data is
  kept while the codespace exists. To start again from fresh demo data:
  `rm apps/api/.env .demo-credentials`, then `pnpm setup`, then `pnpm demo`.
- Free GitHub accounts include a monthly Codespaces allowance. This configuration asks for a
  4-core machine.

## 2. VS Code on your computer

### Option A: Dev Containers (same setup as Codespaces)

1. Install **Docker Desktop** and **VS Code**, then the VS Code extension **Dev Containers**
   (`ms-vscode-remote.remote-containers`).
2. Clone the repository and open the folder in VS Code:
   ```bash
   git clone https://github.com/adityakottu/Financiers.git
   code Financiers
   ```
3. When VS Code offers **Reopen in Container**, accept. Otherwise press `F1` and run
   *Dev Containers: Reopen in Container*. The first build takes a few minutes.
4. In VS Code's terminal: `pnpm demo`, then open <http://localhost:3000>.

### Option B: Without containers

Requirements: Node 22, pnpm 10 (`corepack enable`), Docker (for PostgreSQL) or a local
PostgreSQL 16 with a database `financiers_dev` owned by user `fin`, password `fin`.

```bash
git clone https://github.com/adityakottu/Financiers.git && cd Financiers
docker compose up -d postgres     # skip if you run PostgreSQL yourself
pnpm setup                        # installs, creates apps/api/.env with new keys, migrates, loads demo data
pnpm demo                         # builds and starts on http://localhost:3000
```

For development with live reload, use `pnpm dev:api` and `pnpm dev:web` in two terminals instead
of `pnpm demo`. Export the settings first: `set -a; . apps/api/.env; set +a`.

**Windows:** use WSL 2 (Ubuntu) and run the commands inside it, or use Option A.

## 3. Sharing through Cloudflare

Cloudflare Tunnel publishes the app running in your codespace or on your computer at an https
address, without opening any port. Your machine has to stay on while people use it.

### 3a. Quick Tunnel: a temporary link, no account needed

1. Install `cloudflared`. In a codespace or on Linux:
   ```bash
   curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
   sudo dpkg -i cloudflared.deb
   ```
   On macOS: `brew install cloudflared`. On Windows: `winget install --id Cloudflare.cloudflared`.
2. With `pnpm demo` running, open a second terminal:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   It prints an address like `https://random-words.trycloudflare.com`.
3. Allow that address in `apps/api/.env`: add it to `APP_ORIGIN` (comma-separated) and set
   `PUBLIC_WEB_URL` to it, so the QR codes on receipts point to it. For example:
   ```
   APP_ORIGIN=https://random-words.trycloudflare.com,http://localhost:3000
   PUBLIC_WEB_URL=https://random-words.trycloudflare.com
   ```
4. Stop `pnpm demo` (Ctrl+C) and start it again so the API reads the change. Share the link and the
   demo passwords.
5. When done, press Ctrl+C in the tunnel terminal. The link stops working, and the address changes
   every time.

Anyone with a Quick Tunnel link can reach the sign-in page. Use it only with demo data, for short
sessions, and change the demo passwords if the link spreads.

### 3b. A stable address limited to named people (Cloudflare Access)

Needs a domain whose DNS is on Cloudflare; the free plan works. In this example the domain is
`demo.yourfirm.in`.

1. On the machine running the app:
   ```bash
   cloudflared tunnel login                          # opens the browser; pick your domain
   cloudflared tunnel create financiers-demo
   cloudflared tunnel route dns financiers-demo demo.yourfirm.in
   cloudflared tunnel run --url http://localhost:3000 financiers-demo
   ```
2. In the Cloudflare dashboard go to **Zero Trust** → **Access** → **Applications** → **Add an
   application** → **Self-hosted**:
   - Application domain: `demo.yourfirm.in`.
   - Add a policy: **Allow** → **Emails** → the reviewers' email addresses.
   Cloudflare then emails each reviewer a one-time code before they can see the page.
3. Set `APP_ORIGIN` and `PUBLIC_WEB_URL` to `https://demo.yourfirm.in` as in 3a, then restart
   `pnpm demo`.

This is still a demo machine. A real deployment follows doc 13: data stored in India, a managed
database, backups and a firewall.

---

## 4. What to check

Demo branches are **KKD** (Kakinada) and **RJY** (Rajahmundry). All demo users except `admin`
share the demo password.

| Sign in as | Role | Check |
|---|---|---|
| `manager.kkd` | Branch Manager | **Dashboard**: branch figures, collections chart, *Collector performance*. **Recovery** → the case with "asset held" → *Record sale*. **Reports** → *Overdue loans* → *Excel* / *PDF*. **Reconciliation** → *Day close*. |
| `collector.kkd` | Collection Employee. Use a phone, or the browser's mobile view. | **Dashboard**: *To collect*. **My collections** → record a cash payment and open the receipt. **Recovery** → a case → *Add note / call / visit*. End-of-day cash: *Declare*. |
| `accounts.kkd` | Accountant (sets up 2FA at first sign-in) | **Reports** → *Trial balance* says "balanced". *General ledger* → pick 1310. **Download CA pack**. **Expenses** → post an approved claim. **Reconciliation** → statement lines. |
| `admin` | Super Admin (must change password and set up 2FA) | **Dashboard**: company view and branch table. **Waiting for you** → approvals. **Recovery** → *Approvals* → approve the sale and the write-off; your password is asked again. |

Things that should **not** be possible:
- The person who asked for something approves it (reversals, expenses, journals, cash differences,
  stage moves, sales, write-offs, day reopen).
- A collector sees another collector's work, or accounting reports.
- Money posted to a closed business day, or to a locked month.
- A payment reversed after the bank has confirmed it.

Automated checks, the same ones GitHub runs on every push:
```bash
pnpm typecheck
for p in money contracts loan-engine; do (cd packages/$p && npx vitest run); done
(cd apps/api && npx vitest run)   # needs PostgreSQL; creates and drops financiers_test
```

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| Sign-in fails with *Request origin not allowed* | Add the address in your browser's bar to `APP_ORIGIN` in `apps/api/.env`, then restart `pnpm demo`. |
| `Run 'pnpm setup' first` | `apps/api/.env` is missing. Run `pnpm setup`. |
| Setup waits on *Database* | PostgreSQL isn't running. Run `docker compose up -d postgres`. In a dev container, *Rebuild Container*. |
| Forgot the demo passwords | They are in `.demo-credentials` at the repository root. |
| Want fresh demo data | `rm apps/api/.env .demo-credentials`, drop and recreate the `financiers_dev` database, then `pnpm setup`. |
| `<Html> should not be imported outside of pages/_document` when building | `NODE_ENV=development` is exported in your shell. `pnpm demo` already unsets it; for manual builds run `env -u NODE_ENV pnpm --filter @fin/web build`. |
