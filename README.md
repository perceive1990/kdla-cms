# KDLA Reports and Case Documentation

The system Kitwe District Land Alliance uses to document its cases and report on its work, written entirely in **JavaScript on Node.js** (Express) with **Azure Cosmos DB for NoSQL**, and designed to run on Azure's free tiers. It covers cases, clients, other parties, activity attendees, project logframes (M&E), work plans, activity reports, stakeholder organisations, referrals and consultation rooms, and it offers a **JSON REST API** so other programs, scripts and reports can use the same data.

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
| **Work plans** | Plan each quarter or year as numbered activities with dates, the person responsible, targets and a budget. Administrators approve the plan and staff update progress. Activity reports linked to a planned activity show what was delivered against what was planned. |
| **M&E (logframes)** | Each project's logframe: overall objective, intermediate objectives, outputs and activities, with indicators, baselines and targets. Work plans draw their activities from it, so every activity report counts towards the results above it. Indicators update from the reports and attendance registers, or from values recorded by staff. A results chain diagram, charts and a printable infographic show what is on track. |
| **Referral letters** | Print a referral letter on KDLA letterhead, or save it as PDF, with the client details and reason. |
| **Consent (Data Protection Act 2021)** | Record whether each client agreed to KDLA storing their information and to sharing it on referral. Missing consent is flagged on lists, cases and referrals. |
| **Read-only users** | An administrator can give an account the **Read only** role (Administration, Staff accounts) for board members, donors' monitors or auditors. They can open, print and export everything an officer can see, but cannot add, change or delete anything, on the web or through the API. They can still change their own password and appearance, and are not offered as officers, facilitators or compilers. Confidential cases stay hidden from them. |
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
| M&E (logframes) | `GET`, `POST`, `PATCH` and `DELETE /projects/{id}/logframe`, `POST /projects/{id}/logframe/import`, results and indicators under `/projects/{id}/logframe/results` and `/projects/{id}/logframe/indicators`, and `POST /projects/{id}/logframe/indicators/{indicatorId}/values` |
| Work plans | `GET` and `POST /workplans`, `GET`, `PATCH` and `DELETE /workplans/{id}`, `POST /workplans/{id}/status`, `POST /workplans/{id}/copy`, `POST /workplans/{id}/activities`, `GET`, `PATCH` and `DELETE /workplans/{id}/activities/{itemId}`, `POST /workplans/{id}/activities/{itemId}/status` |
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
3. Upload `kdla-case-management-v2.2.2.zip` with the **Upload** button, then run, with your own GitHub account and repository name:

   ```bash
   unzip -o kdla-case-management-v2.2.2.zip && cd kdla-cms && bash infra/github-setup.sh perceive1990/kdla-cms
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
2. Upload `kdla-case-management-v2.2.2.zip` with the **Upload** button, then run:

   ```bash
   unzip -o kdla-case-management-v2.2.2.zip && cd kdla-cms && bash infra/provision.sh
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

## Upgrading with the nonprofit Azure grant

The free plan sleeps when idle, has a daily CPU quota and keeps files on a small disk. When the Microsoft nonprofit Azure grant (USD 2,000 a year, activated in the [Nonprofit Hub](https://nonprofit.microsoft.com) under Offers > Azure $2,000 Sponsorship, on the billing profile of this subscription) shows under Billing > Payment methods > Azure credits, open Cloud Shell (Bash) and run:

```
git clone https://github.com/perceive1990/kdla-cms && cd kdla-cms && bash infra/upgrade.sh
```

It moves the web app to the Basic B1 plan with Always On, adds a Blob storage account for photos and attachments (files saved earlier are copied across automatically and stay readable meanwhile), and keeps daily Cosmos DB backups for 7 days. It asks you to type UPGRADE first. `TIER=F1 bash infra/upgrade.sh` goes back to the free plan. Set a budget alert under Cost Management > Budgets, because anything beyond the grant is billed at normal prices.

### Moving to another subscription

If the grant was activated as a separate Azure Sponsorship subscription, move the app into it from Cloud Shell:

```
git clone https://github.com/perceive1990/kdla-cms && cd kdla-cms && bash infra/move-subscription.sh
```

It lists your subscriptions, asks which one to move into, shows what will move and waits for you to type MOVE. The web address, database, files and logins stay the same. The GitHub deploy connection is set up again afterwards (sign in to GitHub when asked). Add other resource groups with `RESOURCE_GROUPS="kdla-cms-rg other-rg"`.

## Data protection (Zambia Data Protection Act No. 3 of 2021)

This is general information, not legal advice. Please confirm the details with a lawyer or the Data Protection Commission.

* **Sensitive data and storage outside Zambia.** The Act treats information such as sex, marital status and health as sensitive, and restricts transferring sensitive data outside Zambia without consent. Azure has no region in Zambia, so the data is stored in South Africa (or the region you choose). The consent wording on the client form mentions this. Make sure clients are told and agree.
* **Register as a data controller.** Controllers must register with the Data Protection Commission.
* **Consent.** Record each client's answers on their page. Lists can be filtered to show clients without recorded consent.
* **Access, correction and deletion.** Use "Download all data held" on a person's page for access requests, Edit to correct, and Delete to erase.
* **Security and accountability.** Confidential cases, two-step verification, automatic sign out and the audit trail help meet the duty to keep data secure. Report any breach to the Commission and to the people affected.
* **API access.** A token acts as the person who created it, so it should be stored like a password and revoked when it is no longer needed. Programs that receive data through the API (for example a Power BI report) also hold personal data and need the same care.
* **Retention.** Keep personal data only as long as it is needed. Audit entries are deleted automatically after `AUDIT_RETENTION_DAYS` (3 years by default).

## Work plans

**Programmes > Work plans** holds the plan for each period, for example "Kitwe Office work plan, January to March 2027".

1. **Start a plan** with its period, office, project and budget currency. It starts as a draft that anyone can change.
2. **Add the planned activities:** number, activity, type, district, the person responsible, start and end dates, how many times it should take place, how many people it should reach, the budget and the expected output. Numbers are given automatically and must be unique within the plan.
3. **An administrator approves the plan.** After approval only administrators change the activities. Everyone can still update the progress of each activity: not started, in progress, completed, postponed or cancelled.
4. **Write the activity reports from the plan.** The report button next to each activity opens a new report already linked to it, or choose the activity in the "Work plan activity" field of any report. Each linked report counts as one delivery, and its registered attendees plus its head count are the people reached.
5. **Follow progress** on the plan page: activities completed, times delivered against planned, people reached against the target, the budget and overdue activities. Each person's dashboard lists their activities due in the next 30 days.
6. **Close the plan** at the end of the period (administrators). A closed plan cannot change until an administrator reopens it.

**People reached.** People reached is counted, not typed. On each activity report, open **Attendance and signed registers**, tick who attended and add walk-ins, and give the head count of anyone not registered by name (on the report form, "Others not individually registered"). The numbers count once an administrator approves the attendance. They then show on the work plan, the logframe and Statistics. For a logframe indicator that is not worked out from reports, set its source to **Recorded by staff** and record each value on the indicator.

**Reports by office.** Every activity report belongs to an office. Staff write and change activity reports, and their attendance registers, only for their own office: a colleague in Fisenge Office cannot write a report for Kakolo Office, and only sees "Write report" on the work plans of their own office (or plans with no office). The report form shows their office and offers only their office's work plan activities. Everyone can still read every report. Administrators can write for any office and choose it on the form. Staff need an office on their account (Administration, Staff accounts) to write reports. Reports written before this rule took the office of their work plan, or else of the colleague who compiled them. The Activity reports list filters by office, and the CSV export includes it.

**Activity reports from the plan.** Each planned activity lists its activity reports (date and title, each opening the report) and has a **Write report** button. At the bottom of the plan, **Activity reports for this plan** lists every linked report with its date, activity and people reached, with a link that opens them in Activity reports. **An activity can only be marked Completed once at least one activity report is linked to it**: until then the status list shows "Completed (write the report first)", on the web pages and in the API. Activities completed earlier without a report are flagged "Completed without an activity report", with a link to write it.

**Combined work plan** (on the Work plans page) brings the plans of all offices together for a period you choose, for example a quarter or a year, with the option to limit it to one project. It shows the totals, the activities by office and by project, and every office's planned activities with their venue, responsible person, dates, targets and status, followed by signature lines. Draft plans are left out unless you tick "Include draft plans"; cancelled activities and activities dated outside the period are left out. Print it or save it as PDF on landscape A4, or export it as CSV. **By default it leaves out every budget amount, so it can go to external people**; tick "Show the budget (internal use only)" for the internal version, which is marked "Internal: includes budget". A single plan's printout shows its budget, with a "Without the budget (for external people)" version.

**Copy** starts the next period from an existing plan: the same activities, with progress reset and no reports linked. Change the period of the copy with "Move the activity dates with the plan" ticked, and the activities move with it (a plan moved from 1 January to 1 April moves every activity three months). **Export CSV** gives the plan with its planned and delivered figures. **Print** gives the whole plan on landscape A4 with the KDLA header, a summary, every activity (logframe link, venue, responsible, dates, times held, people reached, budget and status), totals and signature lines for who prepared and who approved it, to print or save as PDF for donor reports and team meetings.

## M&E (logframes)

**Programmes > M&E (logframes)** holds each project's logframe, the results chain of its Theory of Change. It shows how the activities contribute to the project's results.

1. **Set up the logframe** (administrators). Open the project under M&E and choose **Set up the logframe**.
2. **Import it from Excel.** List one row per entry in the columns Level, Code, Text, Unit, Baseline, Target, Means of verification and Source, then save the sheet as CSV UTF-8 and import it, or copy the rows and paste them. **Download the template** shows the layout. Rows go in order: each intermediate objective under the overall objective, each output under the intermediate objective above it, each activity under the output above it, and each indicator under the row above it. Entries can also be added and changed one by one.
3. **Choose where each indicator's value comes from.** Either colleagues record it from time to time ("Recorded by staff"), or the system works it out:
   * from the activity reports of the planned activities linked to the result and everything under it: activities held, people reached (different registered attendees plus head counts), registered attendees, women and girls, children, persons with disabilities, and the shares of women and girls, children and persons with disabilities;
   * from the case records of the project period: cases opened, clients served and referrals made.
4. **Draw the work plans from the logframe.** A new work plan for a project with a logframe opens **Add activities from the logframe**: tick the logframe activities the plan will carry out and set the venue, who is responsible, the dates, how many times, the people to reach and the budget. Each becomes a planned activity linked to its logframe activity. One planned activity at a time works too: choose its "Logframe activity", which also fills in an empty title. Once a project's logframe has activities, every planned activity in that project's work plans must come from it, on the web pages and in the API; activities added before then are flagged "Not from the logframe" on the plan until they are linked or cancelled. Work plans without a project, or for a project without a logframe, stay free. The logframe page lists the planned activities of the project's work plans that are not linked yet.
5. **Follow progress.** The logframe page has three views:
   * **Results chain**: the Theory of Change as a diagram, read from the bottom up. Each activity shows how many times it was held against the plan and the people reached; each output and objective shows its status and its indicators as small progress bars. Above it are the key figures (people reached, activities held, indicators by status, project time passed), and below it who was reached (shares of women and girls, children and persons with disabilities against their targets, attendees by age and sex), activities held by output and the planned budget by output.
   * **Indicators**: every indicator as a bar for the value now, a line for the target and, for counts, a dashed line where it should be by now.
   * **Details**: the full logframe with editing, recorded values and the planned activities linked to each result.

   Counts are judged against the share of the project period that has passed (on track when no more than 10 points behind it); shares such as the percentage of women are judged against their target. **Print logframe** gives the classic logframe matrix (results, indicators, baseline, target, actual, status and means of verification) on landscape A4; the logframe page and the infographic print on landscape A4 too. **Infographic** gives the same figures on landscape A4 pages to print or save as PDF for donors, the board and partners. **Export CSV** gives the logframe with its figures, in the import layout, for donor reports.

Administrators set up and change the logframe; everyone can record indicator values. The level names can follow each donor's words (for example Goal, Outcome, Output and Activity) under **Settings**.

## Users and permissions

* **Officers** can view, add and edit records, write case diary entries, manage tasks, and use the API with the same rights.
* **Administrators** can also delete records, manage staff accounts and projects, see the audit trail, export data, unlock accounts and reset two-step verification.
* **Confidential cases** can only be opened by the responsible officer, the case team and administrators. Client names remain visible in the client list, so register a client with initials or a code name if their identity itself must be protected.

To allow officers to delete records, remove `requireAdmin` from the delete routes in `src/routes/` and `adminOnly` from those in `src/api/routes/`.

Other commands: `npm run create-admin -- <username> <password> "Full Name"` and `npm run init-db`.

## Phone app

Staff can install the system on Android phones, iPhones and computers as an app called **KDLA Reports** (user menu > Install the phone app). It is a progressive web app: the same site, login and data, with its own home screen icon and full screen window, at no cost and without an app store. It needs internet. The service worker (`src/pwa/sw.js`, served at `/sw.js`) keeps only design files on the device and never stores pages, files or API answers, so client data does not stay on a lost phone. Without a connection it shows `/offline`.

## Appearance

### Filtering beneficiaries by community

Clients, other parties, activity attendees and **All beneficiaries** filter by **community**: the village or area recorded for each person, listed with how many people live there. Spellings that differ only in capitals or spacing count as one community. Print and **Export CSV** follow the filter, and **Beneficiary statistics** has the same filter, so a community's figures by age, sex and disability can be printed on their own.

### Importing activity attendees from a register

**Activity attendees, Import a register** registers everyone on a signed attendance register at once. Upload the register as a Word document (.docx, with the register as a table) or a CSV file, choose the office (staff import for their own office; administrators choose) and, optionally, the type of activity. Columns are recognised by what they hold: full name, NRC, sex (M or F), village or area (the Organization or Community column), present (yes or no) and phone. Registers rarely give ages, so by default F is recorded as Woman and M as Man; untick "Everyone on this register is an adult" for registers with children. A preview shows what happens to each line before anything is saved: new people are registered; people already registered with the same NRC get the office and area where missing; lines repeating an NRC from earlier in the register, and people marked absent, are skipped; mistyped NRCs are left out with a note. The first word of a full name becomes the first name and the rest the last name. Activity attendees now carry an office, shown and filtered on the attendee list and included in the CSV export.

### Attendance: invite list, signed registers and approval

Attendance follows five steps, shown on each report's **Attendance** page:

1. **Invite list before the activity.** On a work plan, **Invite list** on each planned activity shortlists who to invite. **Import a village or area** adds every registered activity attendee whose village or area matches (spelling and spacing are matched loosely); **Add people one by one** searches by name, NRC, phone or area. **Tick all** ticks every area, every person found or every invited person at once (click again to untick). Tick people and press **Confirmed coming**, **Not coming** or **Not yet confirmed** to record who has confirmed; the list counts each, and the work plan shows how many confirmed. Only staff of the plan's office change it.
2. **Print the register.** The register for signing prints the invited people first, by village or area, with whether they confirmed they are coming (Y or N), their sex and age, age, NRC, phone, disability and village or area filled in, and their recorded answer on sharing (✓ agrees, ✗ declines, blank if not yet recorded), then blank lines for walk-ins.
3. **Correct after the activity.** On the activity report's **Attendance** page, tick who came, add walk-ins and new people (**Add walk-ins and new people**), and correct people's details.
4. **Upload the signed registers and submit.** Scans or photos of every signed page are uploaded under **Signed registers**; **Submit attendance** needs at least one, and someone recorded as attending (or a head count).
5. **Administrator's check.** Administrators see on the dashboard how many reports wait, and **Activity reports** filters by attendance. They compare each person with the signed registers and tick only those who signed (the office's ticks are the starting point), then **Approve with the ticked people**, or **Return for correction** with a note saying what to fix. Only the ticked people stay on the register and count; the people the office ticked are kept on record, and those not confirmed show "not confirmed by the administrator". After approval only an administrator can change the register, with **Save verification**.

**One register per planned activity.** A person is recorded on only one register (activity report) of a planned activity, so an activity held several times does not count the same people twice. Anyone already recorded at one session is not invited again by an area import, is not printed on new registers, and cannot be ticked, linked by NRC from the walk-in register, or chosen on the report form for another session; the attendance page shows the date of the register they are on. The same person can still be invited to and recorded at the other activities of the work plan.

**Only approved attendance counts** as people reached in statistics, work plan progress and the logframe; the activity itself still counts as held once its report exists. Submitted and approved attendance is locked: nobody can tick, add people, change the head count or remove a signed register until an administrator returns it. Reports written before this workflow keep their attendance as approved.

### Payment acquittal

Payments can be prepared on the work plan before the activity, like the invite list: **Payments** on each planned activity sets the costs, rates and who receives them for the people on its invite list, and prints the acquittal form with their names. The work plan shows how many people are to be paid and the total. When the activity report is written, its payment acquittal starts from the one prepared on the work plan; tick there who was actually paid and save, and the report keeps its own copy while the plan keeps what was prepared.

Each activity report has a **Payment acquittal** (also linked from its attendance page). Set the currency, then tick the costs the activity's attendees are eligible for and set each rate: transport, lunch, dinner, incidental, accommodation (per night), airtime, and up to three **Other** costs you name yourself (for example stationery). Each cost also has a number of days, so lunch for a three-day workshop is paid at its rate for three days; accommodation is set in nights for each person. Only the ticked costs appear as columns on the page and on the printed form. Then tick, for each person invited to or recorded at the activity, the costs they receive, with the number of nights for accommodation; **Tick all** buttons tick a cost for everyone. The page works out each person's total and the totals per allowance. **Print acquittal form** gives a landscape A4 form under the KDLA letterhead with the activity, the rates, each person's name, NRC, phone, amounts and total, a column for their signature or thumbprint on receipt, and lines for who prepared, paid and approved it. Staff of the activity's office prepare it; once the attendance is approved, only an administrator can change it. People on another register of the same planned activity cannot be added.

### Attendance registers for signing

Every activity can print its own attendance register for people to sign at the meeting. On a work plan, **Register** on each planned activity prints one before the meeting; on an activity report, **Register for signing** prints one too, optionally with the names already registered. Each register prints on landscape A4 under the KDLA letterhead, with the activity, type, date, venue, district, office, project, work plan activity and facilitator filled in (blank lines where something is not known yet), a consent statement, and lines numbered across the pages. The columns follow the app's attendance register form (first name, last name, confirmed coming, girl, boy, woman or man, age, NRC, phone, disability, village or area, agrees to share, signature or thumbprint), so the filled sheets are quick to type in afterwards under **Add attendance register**. The first page holds 10 lines and each further page 15; by default there are enough lines for the people expected at one session (people to reach divided by the number of times), and **Lines** sets any other number.

### Beneficiary statistics

**Statistics, Beneficiary statistics** (also the **Statistics** button on Direct beneficiaries) reports on everyone registered as a beneficiary: clients, other parties and activity attendees. It shows the total, women and girls, children and persons with disabilities (numbers and shares), a table of each type by age and sex (girls, boys, women, men, female, male, total and with disability), beneficiaries registered each month or year, and the breakdown by village or area, project, civil status and how clients heard about KDLA. It covers everyone registered to date unless you choose a period, a type or a project. **Print or save as PDF** gives an A4 report under the KDLA letterhead; **Export CSV** gives every figure for Excel. People counted only by head count on activity reports are not registered beneficiaries and are not included.

### Printing

Every report and record prints, or saves as PDF, from its **Print** button: activity reports, case files, client and party profiles, referrals and referral letters, stakeholders, statistics and the infographic, work plans, logframes, and the lists of cases, people, activity reports, referrals, stakeholders, tasks, work plans and the audit trail. Printouts carry the KDLA letterhead with the date and who printed them, and leave out buttons, filters and data entry forms. Lists and tables print on landscape A4; single records print on portrait. Printing a list prints every record that matches its filters, not only the page on screen.

Each person chooses light, dark or automatic mode, a colour and the text size under **Appearance** in their account menu. The moon or sun button in the top bar switches between light and dark. Printouts are always light.

## Logo

The logo is KDLA's own: Zambia in lime green with K, D, L and A stepping across it, and "Land is Life" underneath. The map is drawn from Natural Earth's public-domain outline of Zambia, so it stays sharp at every size. `public/images/logo.svg` is the full logo (login page), `logo-mark.svg` the map and letters (header, printed documents, letters), and the PNGs (`logo.png`, `logo-mark.png`, `app-*`, `icon-*`, `maskable-*`, `apple-touch-icon.png`) are rendered from them for the app and the phone app icons. Their addresses carry the asset version, so browsers fetch a new logo after each deployment.

## Changing drop-down options

**Districts, offices and types of activity:** administrators change these in the app under **Administration > Drop-down lists** (one per line, in the order they should appear). The page shows how many records use each entry: for types of activity, the activity reports, planned activities, activity attendees and clients' "heard about KDLA through". A new type of activity appears at once on the activity report, planned activity, attendee and client forms and in the filters and statistics. Saved records keep their value when an entry is renamed or removed.

**Other lists** (case types, legal services, activities, statuses, outcomes, diary entry types and task types) are in `src/choices.js`. Edit the file on GitHub and the change deploys automatically. Existing records keep their stored value. The API returns the current lists at `GET /api/v1/choices`.

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
| `APP_NAME`, `APP_SHORT_NAME` | the system's name, default "KDLA Reports and Case Documentation", and the name under the phone app icon, default "KDLA Reports" |

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
public/                 CSS, JavaScript, logo (logo.svg, logo-mark.svg and PNGs), app icons
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
| `reports` | activity reports with attendees and attachments, and the planned activity they deliver |
| `workplans` | work plans with their planned activities |
| `logframes` | one logframe per project (its id is the project id), with its results, indicators and recorded values |
| `stakeholders` | partner organisations |
| `referrals` | referrals with follow ups embedded |
| `rooms` / `messages` | consultation rooms; messages partitioned by `/roomId` |
| `audit` | audit trail, removed automatically after the retention period |
| `meta` | case number counters |
| `sessions` | login sessions, removed automatically when they expire |
| `apiTokens` | API tokens (a SHA-256 hash only), removed automatically when they expire |
