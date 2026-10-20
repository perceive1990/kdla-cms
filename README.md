# KDLA Case Management System (v2.2)

A case management system for Kitwe District Land Alliance, written entirely in **JavaScript on Node.js** (Express) with **Azure Cosmos DB for NoSQL**, and designed to run on Azure's free tiers. It covers cases, clients, other parties, activity attendees, activity reports, stakeholder organisations, referrals and consultation rooms, and it offers a **JSON REST API** so other programs, scripts and reports can use the same data.

## What is new in version 2.2

| Change | What it means for KDLA |
|---|---|
| **Pure Node.js** | The whole project is JavaScript on Node.js, including the tools that build, package, test and deploy it. |
| **REST API** | 80 operations at `/api/v1` cover every part of the system, with a readable reference at `/api/docs` and an OpenAPI file for tools such as Postman and Power BI. |
| **Personal access tokens** | Staff can create named tokens under **Account > API access** for reports and scripts, and revoke them at any time. |
| **One set of rules** | The web pages and the API share the same business rules (`src/services/`), so confidentiality, permissions, duplicate checks and the audit trail behave identically in both. |
| **Safer saving** | Every record carries a version tag. Two people changing the same record at once can no longer overwrite each other without warning. |
| **Fairer login limit** | Only failed sign-ins count towards the per-connection limit, so a whole office sharing one internet connection can still log in each morning. |

## Features

These features follow what established legal aid and legal empowerment case management systems provide (for example LegalServer, Clio, and the paralegal case records approach promoted by Namati and the Grassroots Justice Network), adapted for a paralegal organisation in Zambia.

| Feature | What it does |
|---|---|
| **Case diary** | Record every meeting, phone call, mediation session, field visit and court appearance on the case, with time spent. Hours are totalled per case, per officer and per activity type. |
| **Tasks, hearings and deadlines** | Due dates, times and places, assigned to staff. A "My tasks" page, a dashboard list, an overdue badge in the menu, and a calendar file to add any hearing to a phone or Outlook calendar. |
| **Conflict of interest check** | Before saving a client, the system warns if the same name or NRC is recorded as an opponent (and the reverse). Each case shows conflict alerts, and a Conflict check page searches everyone KDLA acts for or against. |
| **Duplicate warnings** | Registering someone with the same name or NRC as an existing person asks for confirmation first. |
| **Case outcomes** | Concluding a case requires an outcome (resolved through mediation, by traditional authority, court decision, and so on), which turns activity counts into results. |
| **Confidential cases** | Gender-based violence and other sensitive cases can be marked confidential. Only the responsible officer, a named case team and administrators can open them; others see only that a confidential case exists. Every view is logged. |
| **Statistics for donors** | Cases opened and concluded, outcomes, resolution rate, median days to conclude, clients served by age, sex and disability, referrals, activity reach and hours worked, for any period, office and project. Export to CSV, print, or read them through the API. |
| **Attendance registers** | A whole community meeting register can be typed into one table. Attendees are created and linked to the report in one step. |
| **Referral letters** | Print a referral letter on KDLA letterhead, or save it as PDF, with the client details and reason. |
| **Consent (Data Protection Act 2021)** | Record whether each client agreed to KDLA storing their information and to sharing it on referral. Missing consent is flagged on lists, cases and referrals. |
| **Data access requests** | Administrators can download everything held about one person, as required when someone asks to see their data. |
| **Audit trail** | Logins, failed logins, views of confidential cases, downloads, exports and every change are recorded with who, when, from where, and whether it was done through the API. |
| **Two-step verification** | Codes from Microsoft Authenticator or Google Authenticator, with one-time recovery codes. It can be required for administrators or for everyone, on the web and the API alike. |
| **Account protection** | Accounts lock for 15 minutes after 5 wrong passwords. Automatic sign out after 60 idle minutes. Changing a password signs out other devices and ends API tokens. |
| **Themes** | Light, dark or automatic mode, four colours (KDLA green by default), and a larger text option. Each person chooses their own. |
| **Full data export** | Administrators can download all records as JSON for safekeeping. |
| **Install on a phone** | Staff can add the system to their phone's home screen like an app. |

## The API

### Where it is

| What | Address |
|---|---|
| API | `https://<your-app>.azurewebsites.net/api/v1` |
| Readable reference | `https://<your-app>.azurewebsites.net/api/docs` |
| OpenAPI file | `https://<your-app>.azurewebsites.net/api/v1/openapi.json` |

The reference page lists every operation with its fields, rules and error codes. It contains no data, so it opens without logging in.

### Signing in

1. Sign in with a staff username and password. Accounts with two-step verification also send the 6-digit code (or a recovery code) as `code`.

   ```bash
   curl -X POST https://<your-app>.azurewebsites.net/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username": "your.name", "password": "your password", "code": "123456"}'
   ```

   The reply contains a `token` that lasts 12 hours.

2. Send the token with every request:

   ```bash
   curl https://<your-app>.azurewebsites.net/api/v1/cases?status=open \
     -H "Authorization: Bearer kdla_your_token"
   ```

   The same two steps in Windows PowerShell:

   ```powershell
   $body = @{ username = "your.name"; password = "your password"; code = "123456" } | ConvertTo-Json
   $login = Invoke-RestMethod -Method Post "https://<your-app>.azurewebsites.net/api/v1/auth/login" -ContentType "application/json" -Body $body
   $headers = @{ Authorization = "Bearer $($login.token)" }
   Invoke-RestMethod "https://<your-app>.azurewebsites.net/api/v1/cases?status=open" -Headers $headers
   ```

3. For a report or script that runs on its own, create a **personal access token** under **Account > API access** (valid for up to 365 days). The page asks for your password and shows the token once. In Power BI Desktop, choose **Get data > Web > Advanced** and add the header `Authorization` with the value `Bearer` followed by the token.

### What it covers

| Area | Operations |
|---|---|
| Sign-in and your account | `POST /auth/login`, `POST /auth/logout`, `GET /me`, `POST /me/password`, `GET` and `POST /me/tokens`, `DELETE /me/tokens/{id}` |
| Cases | `GET` and `POST /cases`, `GET`, `PATCH` and `DELETE /cases/{id}`, `/cases/{id}/parties`, `/cases/{id}/conflicts` |
| Case diary | `GET` and `POST /cases/{id}/notes`, `GET` and `DELETE /cases/{id}/notes/{noteId}` |
| Files | `GET` and `POST /cases/{id}/attachments`, `GET` and `DELETE /cases/{id}/attachments/{fileId}`, and the same for `/reports` |
| People | `GET` and `POST /people`, `GET`, `PATCH` and `DELETE /people/{id}`, `/people/{id}/links`, `/people/{id}/personal-data`, `GET /conflicts` |
| Tasks and hearings | `GET` and `POST /tasks`, `GET`, `PATCH` and `DELETE /tasks/{id}`, `POST /tasks/{id}/done`, `GET /tasks/{id}/calendar.ics` |
| Activity reports | `GET` and `POST /reports`, `GET`, `PATCH` and `DELETE /reports/{id}`, `GET` and `POST /reports/{id}/attendees` |
| Referrals | `GET` and `POST /referrals`, `GET` and `DELETE /referrals/{id}`, `POST /referrals/{id}/follow-ups` |
| Organisations, projects and staff | `/stakeholders`, `/projects` and `/users`, with list, create, read and change, and delete where the web app allows it |
| Reference | `GET /choices` (every option list), `GET /statistics`, `GET /search` |
| Consultation rooms | `/rooms`, `/rooms/{id}/messages`, `/rooms/{id}/members`, `/rooms/{id}/leave` |
| Administration | `GET /audit`, `GET /export` |

### Rules

* **Same permissions as the web app.** Confidential cases, administrator-only actions, conflict of interest checks and consent warnings all apply. Actions are written to the audit trail and marked as done through the API.
* **Partial changes.** `PATCH` changes only the fields you send. Each record has an `etag`; send it back in an `If-Match` header and the change is refused with `412` if someone else changed the record first.
* **Lists** return `{"data": [...], "page": 1, "pageSize": 25, "total": 120, "pages": 5}`. Use `?page=` and `?pageSize=` (at most 100), and `?sort=field` or `?sort=-field` where offered.
* **Errors** return `{"error": {"code": "...", "message": "...", "fields": {...}}}`. The reference page lists every code.
* **Limits.** 240 requests a minute for each token, and 20 failed sign-ins every 15 minutes for each connection. Five wrong passwords lock the account, as on the web.
* **Tokens** are stored only as a SHA-256 hash. They stop working when they expire, when they are revoked, when the account is disabled, and when the person's sessions are signed out (for example after a password change).
* **Browsers on other sites** cannot call the API unless their address is listed in `API_CORS_ORIGINS`.

### Bringing in existing records

Records kept elsewhere can be loaded with a short script that calls `POST /api/v1/people`, `POST /api/v1/cases` and the other create operations. The same validation, duplicate checks and case numbering apply as when staff type the records in.

## Run it on your computer (no Azure needed)

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env          # uses the built-in in-memory database
npm run seed-demo             # optional: fictional demo records
npm start                     # open http://localhost:3000 (API at http://localhost:3000/api/v1)
```

Log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`. You will be asked to choose a new password. Data is kept in `data/dev-db.json` between restarts.

Run the checks with `npm run check` (linter and all tests).

## Deploy to Azure (free tier)

### What it uses

| Resource | Tier | Notes |
|---|---|---|
| Azure Cosmos DB for NoSQL | Free tier | All containers share one database at 1000 RU/s, which is the free allowance. Only one free tier account is allowed per subscription. |
| App Service | F1 Free, Linux | Sleeps when idle (the first visit after a quiet period is slow), has a daily CPU quota and about 1 GB of disk. Fine for a small team. |
| Storage account (optional) | Standard LRS | For attachments. Not free after the first 12 months on a new Azure account, but a few GB costs very little. Set `USE_BLOB=no` to keep files on the App Service disk instead. |

Please confirm the current limits on Microsoft's pages before relying on them: [Cosmos DB free tier](https://learn.microsoft.com/azure/cosmos-db/free-tier) and [App Service quotas](https://learn.microsoft.com/azure/app-service/web-sites-monitor).

### Option A: deploy from GitHub (recommended)

Every change pushed to the `main` branch of your GitHub repository is tested and, when the tests pass, deployed to Azure automatically. Pull requests are tested but not deployed.

**One-time setup** (about 15 minutes, nothing to install):

1. On GitHub, create a repository for the code, or use an existing one. If it is new, leave it empty (no README, .gitignore or licence) and the setup uploads the code for you.
2. Sign in to the [Azure portal](https://portal.azure.com) and open **Cloud Shell** (the `>_` icon at the top). Choose **Bash**.
3. Upload `kdla-case-management-v2.2.1.zip` with the **Upload** button, then run, with your own GitHub account and repository name:

   ```bash
   unzip -o kdla-case-management-v2.2.1.zip && cd kdla-cms && bash infra/github-setup.sh perceive1990/kdla-cms
   ```

4. When the script shows a one-time code, open [github.com/login/device](https://github.com/login/device), enter the code and approve.

The script then:

* creates the Azure resources with `infra/provision.sh` if they do not exist yet, and shows the first administrator password (write it down);
* creates an Azure managed identity that only this repository's `main` branch can use, through OpenID Connect, so no password or key is stored in GitHub, and allows it to deploy to this one web app and nothing else;
* saves the connection details as the repository's Actions secrets and the web app name as an Actions variable;
* uploads the code if the repository is empty, or starts a deployment of what is already there;
* follows the first run and reports the site address when it is live.

If your Azure account is not allowed to grant roles (that needs the Owner or User Access Administrator role on the subscription), the script uses a publish profile instead and says so. An Owner can run the script again later to switch to OpenID Connect.

**Day to day:** change files on GitHub (the pencil icon on any file) or on a computer with git, and push to `main`. Follow each run under the repository's **Actions** tab: lint and tests first, then the deployment and a health check of the site and database. A failed test stops the deployment, so the live site keeps running the last version that passed. To undo a change, revert its commit on GitHub; the revert deploys like any other change.

The repository can be public: the code contains no passwords or keys, which stay in Azure and in GitHub's encrypted secrets. To make it private, open the repository's **Settings > General** and change its visibility.

### Option B: one script, without GitHub

**On Windows, use Azure Cloud Shell** (nothing to install):

1. Sign in to the [Azure portal](https://portal.azure.com) and open **Cloud Shell** (the `>_` icon at the top). Choose **Bash**.
2. Upload `kdla-case-management-v2.2.1.zip` with the **Upload** button, then run:

   ```bash
   unzip -o kdla-case-management-v2.2.1.zip && cd kdla-cms && bash infra/provision.sh
   ```

On Mac or Linux you can instead install the [Azure CLI](https://aka.ms/azcli) and Node.js, run `az login`, and run `bash infra/provision.sh` in the project folder.

The script creates the resource group, the free tier Cosmos DB account, the free web app and its settings, then deploys the code. At the end it prints the site and API addresses and the first administrator password. Write the password down. The first login asks for a new password and then sets up two-step verification for administrators.

Options: `LOCATION=northeurope` to use another region, `COSMOS_MODE=serverless` if the subscription already has a free tier Cosmos DB account, `USE_BLOB=no` to skip the storage account, `REQUIRE_2FA=all` to require two-step verification for everyone. Run the script again at any time to deploy a new version. The same options work with `infra/github-setup.sh`, which uses this script to create the resources.

### Option C: Azure portal

1. **Cosmos DB**: Create > Azure Cosmos DB > **Azure Cosmos DB for NoSQL**. Set **Apply Free Tier Discount** to *Apply*, capacity mode *Provisioned throughput*. After creation, copy **Keys > Primary connection string**.
2. **Web App**: Create > Web App. Publish *Code*, runtime *Node 22 LTS*, OS *Linux*, pricing plan **Free F1**.
3. In the Web App, **Settings > Environment variables**, add:

   | Name | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DB_DRIVER` | `cosmos` |
   | `COSMOS_CONNECTION_STRING` | the connection string from step 1 |
   | `SESSION_SECRET` | a long random string (at least 32 characters) |
   | `ADMIN_USERNAME` | `admin` |
   | `ADMIN_PASSWORD` | a temporary password of 10 or more characters |
   | `REQUIRE_2FA` | `admins` |
   | `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` |
   | `AZURE_STORAGE_CONNECTION_STRING` | optional, from a storage account |

4. **Settings > Configuration**: turn **HTTPS Only** on. Startup command: `npm start`.
5. Deploy the code: run `node scripts/package.js app.zip` in this folder, then upload `app.zip` with **Deployment Center**, or run `az webapp deploy --name <app> --resource-group <rg> --src-path app.zip --type zip`.

The app creates the database and containers itself on first start. Check the connection at `https://<app>.azurewebsites.net/healthz?db=1`.

## Data protection (Zambia Data Protection Act No. 3 of 2021)

This is general information, not legal advice. Please confirm the details with a lawyer or the Data Protection Commission.

* **Sensitive data and storage outside Zambia.** The Act treats information such as sex, marital status and health as sensitive, and restricts transferring sensitive data outside Zambia without consent. Azure has no region in Zambia, so the data is stored in South Africa (or the region you choose). The consent wording on the client form mentions this. Make sure clients are told and agree.
* **Register as a data controller.** Controllers must register with the Data Protection Commission.
* **Consent.** Record each client's answers on their page. Lists can be filtered to show clients without recorded consent.
* **Access, correction and deletion.** Use "Download all data held" on a person's page for access requests, Edit to correct, and Delete to erase.
* **Security and accountability.** Confidential cases, two-step verification, automatic sign out and the audit trail help meet the duty to keep data secure. Report any breach to the Commission and to the people affected.
* **API access.** A token acts as the person who created it, so it should be stored like a password and revoked when it is no longer needed. Programs that receive data through the API (for example a Power BI report) also hold personal data and need the same care.
* **Retention.** Keep personal data only as long as it is needed. Audit entries are deleted automatically after `AUDIT_RETENTION_DAYS` (3 years by default).

## Users and permissions

* **Officers** can view, add and edit records, write case diary entries, manage tasks, and use the API with the same rights.
* **Administrators** can also delete records, manage staff accounts and projects, see the audit trail, export data, unlock accounts and reset two-step verification.
* **Confidential cases** can only be opened by the responsible officer, the case team and administrators. Client names remain visible in the client list, so register a client with initials or a code name if their identity itself must be protected.

To allow officers to delete records, remove `requireAdmin` from the delete routes in `src/routes/` and `adminOnly` from those in `src/api/routes/`.

Other commands: `npm run create-admin -- <username> <password> "Full Name"` and `npm run init-db`.

## Appearance

Each person chooses light, dark or automatic mode, a colour and the text size under **Appearance** in their account menu. The moon or sun button in the top bar switches between light and dark. Printouts are always light.

## Changing drop-down options

All lists (offices, districts, case types, legal services, activities, statuses, outcomes, diary entry types and task types) are in `src/choices.js`. Edit the file and redeploy. Existing records keep their stored value. The API returns the current lists at `GET /api/v1/choices`.

## Configuration reference

See `.env.example`. The most important settings:

| Setting | Purpose |
|---|---|
| `DB_DRIVER` | `cosmos` in Azure, `memory` for local use and tests |
| `COSMOS_CONNECTION_STRING` | or `COSMOS_ENDPOINT` + `COSMOS_KEY` |
| `COSMOS_THROUGHPUT` | shared RU/s for the database, default `1000`. Use `0` for a serverless account |
| `SESSION_SECRET` | required in production, 32 or more random characters |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` | automatic sign out, default 60 minutes idle and 12 hours in total |
| `LOGIN_MAX_FAILURES` / `LOCK_MINUTES` | account lock, default 5 attempts and 15 minutes |
| `REQUIRE_2FA` | `none`, `admins` or `all` |
| `AUDIT_RETENTION_DAYS` | how long audit entries are kept, default 1095 (0 keeps them forever) |
| `AZURE_STORAGE_CONNECTION_STRING` | store attachments in Blob Storage (private container) |
| `UPLOAD_DIR` | disk folder for attachments when Blob Storage is not set |
| `MAX_UPLOAD_MB` | per file limit, default 10 |
| `API_ENABLED` | `false` switches the API (and its documentation page) off |
| `API_TOKEN_HOURS` | how long a token from `POST /api/v1/auth/login` lasts, default 12 |
| `API_PERSONAL_TOKEN_MAX_DAYS` | longest life of a personal access token, default 365 |
| `API_RATE_LIMIT` | requests per minute for each token, default 240 |
| `API_CORS_ORIGINS` | web sites allowed to call the API from a browser, comma separated, default none |
| `ORG_FULL_NAME`, `ORG_ADDRESS`, `ORG_CONTACT` | shown on referral letters |

## Quality checks

* The app refuses to start in production without a database or a session secret, so it can never silently run on temporary storage and lose data.
* Anonymous visitors, bots and API calls never create session records in the database.
* File uploads are only processed for signed-in staff, and the API checks access to the record before it reads an upload.
* Rate limiting works behind Azure's proxy, which adds the visitor's port number to their address.
* Search engines are told not to index the site, and browsers always load new styles and scripts after a deployment.
* Dependencies have no known vulnerabilities (`npm audit`), the code passes a linter, and 26 groups of automated tests cover the web workflows, the API and the security rules.
* Not yet tested against a live Cosmos DB account: the Microsoft emulator could not be downloaded in the build environment, so the database calls were checked against the SDK's published interface and the in-memory driver that mirrors it. Run `/healthz?db=1` and a short trial after the first deployment.

## Project layout

```
server.js               start-up, data upgrades, clean shutdown
src/app.js              Express app, security, sessions
src/services/           business rules shared by the web pages and the API
src/routes/             web pages, one file per section (cases, tasks, people, reports, statistics, ...)
src/api/                REST API: sign-in and tokens, routes, OpenAPI description, documentation page
src/db/                 Cosmos DB driver, in-memory driver, query builder, container list
src/access.js           who may see confidential cases
src/conflicts.js        conflict of interest and duplicate checks
src/audit.js            audit trail
src/limits.js           sign-in rate limit shared by the web and the API
src/totp.js             two-step verification codes
src/theme.js            appearance options
src/choices.js          drop-down options
views/                  EJS page templates
public/                 CSS, JavaScript, logo, app icons
scripts/                create-admin, init-db, seed-demo, package (builds the deployment zip)
infra/provision.sh      Azure setup script
infra/github-setup.sh   connects a GitHub repository to the Azure web app (deploy on every push to main)
.github/workflows/      GitHub Actions: lint, tests, deployment and a health check
test/                   automated tests (npm test)
```

## Data model (Cosmos DB containers)

One database with shared throughput, partitioned by `/id` except where noted.

| Container | Contents |
|---|---|
| `users` | staff accounts, appearance and security settings |
| `projects` | donor projects |
| `people` | clients, other parties and attendees (`kind` field), with consent |
| `cases` | case files with parties, outcome, team, attachments and history |
| `caseNotes` | case diary entries, partitioned by `/caseId` |
| `tasks` | tasks, hearings and deadlines |
| `reports` | activity reports with attendees and attachments |
| `stakeholders` | partner organisations |
| `referrals` | referrals with follow ups embedded |
| `rooms` / `messages` | consultation rooms; messages partitioned by `/roomId` |
| `audit` | audit trail, removed automatically after the retention period |
| `meta` | case number counters |
| `sessions` | login sessions, removed automatically when they expire |
| `apiTokens` | API tokens (a SHA-256 hash only), removed automatically when they expire |
