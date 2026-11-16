# Leader Directory

A small phone-friendly website for our leaders: the roster, school calendars and days off, event scheduling with weekly availability, and the onboarding pipeline.

- The site is plain HTML, CSS and JavaScript, hosted free on GitHub Pages.
- Sign-in and all data live in Supabase (free tier). Nothing personal is stored in this repository.

## One-time setup

### 1. Create the Supabase project
1. Go to supabase.com, sign in, and create a new project (any name, any region near Alabama). Save the database password somewhere safe; this app never needs it.
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, and press **Run**.
3. Open `supabase/seed.sql` on your computer (it is not in GitHub on purpose). Near the top, replace `YOUR_EMAIL_HERE` with the email you will sign in with. Paste the whole file into the SQL Editor and press **Run**. This loads the 62 leaders and 45 school events and makes you the admin. Run it only once.

### 2. Connect the site to Supabase
1. In Supabase, open **Project Settings > API** (newer projects: **API Keys**).
2. Open `config.js` in this folder and fill in lines 7 and 8:
   - `SUPABASE_URL`: the Project URL, like `https://abcdefgh.supabase.co`
   - `SUPABASE_ANON_KEY`: the **anon public** key (newer projects call it the **publishable** key)
3. Never put the `service_role` / secret key or a password in this file. The anon key is designed to be public; the database rules in `schema.sql` are what protect the data.

### 3. Turn on GitHub Pages
1. In the GitHub repository: **Settings > Pages**.
2. Under **Build and deployment**, set **Source** to "Deploy from a branch", **Branch** to `main` and folder `/ (root)`, then **Save**.
3. After a minute the page shows your site address, like `https://YOUR-NAME.github.io/leader-directory/`.

### 4. Update 2 database changes
1. **SQL Editor**: paste all of `supabase/migration_002.sql` and press **Run**. It only adds things; nothing existing is removed.
2. Paste all of `supabase/seed_update2.sql` (on your computer only, not in GitHub) and press **Run** once. This loads the onboarding prospects and holding list.

### 5. Server functions (accounts and emails)
Two small Supabase Edge Functions do the jobs the website is not allowed to do itself:

| Function | What it does | Code |
| --- | --- | --- |
| `admin-users` | Creates accounts, resets passwords, removes accounts. Admins only. | `supabase/functions/admin-users/index.ts` |
| `onboarding-email` | Sends the daily stall reminder and the Monday CSV export. | `supabase/functions/onboarding-email/index.ts` |

In Supabase: **Edge Functions > Deploy a new function > Via Editor**. Use the exact name from the table, paste the file's contents, and deploy. For each function, open its **Details** and turn **Verify JWT** off (each function checks who is calling by itself).

Then run `supabase/cron.sql` in the SQL Editor. That schedules the reminder for 7:30 AM Central every day and the export for Monday mornings.

### 6. Sign-in settings
In Supabase: **Authentication > Sign In / Providers**.
- Keep **Email** enabled.
- Turn **Allow new users to sign up** off. Accounts are created only by admins inside the app.

Your own first password: **Authentication > Users**. If your email is listed, delete that user, then **Add user > Create new user**, type your email and a password you choose, and tick **Auto Confirm User**. From then on you create everyone else's account inside the app.

### 7. Gmail for the reminder emails
The emails are sent from your Gmail account using a Gmail **App Password**. This is a separate 16-letter password that only lets an app send mail; it is not your normal password.

1. Your Google account needs **2-Step Verification** on: myaccount.google.com > Security.
2. Go to myaccount.google.com/apppasswords, type a name such as "Leader Directory", and press **Create**. Google shows 16 letters once.
3. In Supabase: **Edge Functions > Secrets**. Add two secrets:
   - `GMAIL_USER`: your full Gmail address
   - `GMAIL_APP_PASSWORD`: the 16 letters (spaces do not matter)
4. In the app: **Onboarding > Onboarding settings > Send me a test reminder**, then **Send me a test weekly export**. Both should arrive in your inbox within a minute.

Never put the App Password in this repository, in `config.js`, or in a chat. It lives only in Supabase's secrets.

**Updating the Gmail app password later** (for example if Google revokes it or you change your Google password): create a new one at myaccount.google.com/apppasswords, then in Supabase **Edge Functions > Secrets** edit `GMAIL_APP_PASSWORD` and paste the new one. Delete the old one on the Google page. Nothing else changes.

## Everyday admin tasks

Sign in with your admin email. Admins see extra buttons that other leaders do not.

| Task | How |
| --- | --- |
| **Create an account for a leader** | **More** > Accounts > type their email > **Create account**. A temporary password is shown once; pass it on by text or in person. They choose their own password the first time they sign in. |
| **Reset a forgotten password** | **More** > Accounts > **Reset password** next to their email. You get a new temporary password to pass on. Nobody, including admins, can see a leader's actual password. |
| **Add an admin** | **More** > Accounts > **Make admin** next to their email (or tick "Admin" when creating the account). Admins can also be set in Supabase: Table Editor > `allowed_emails` > set `is_admin` to true. |
| **Remove someone's access** | **More** > Accounts > **Remove**. Their account is deleted. |
| **Add a leader** | **Roster** > **Add leader** (or **More** > **Add leader**). |
| **Update phone or email** | **Roster** > **Edit** next to the person > fill in Phone / Email > **Save**. |
| **Move a leader or change team lead** | Same Edit form: change Assignment or tick "Team lead". |
| **Let a team lead edit availability** | Tick "Team lead" on their roster entry **and** put their sign-in email in the Email box. That is how the app knows which leader is signed in. |
| **Tag Onboarding Team members** | **Roster** > **Edit** next to the person > Tags > tick **Onboarding Team** > **Save**. They need an email on their roster entry to get the daily reminder. **Onboarding > Onboarding settings** lists who is tagged and who is missing an email. |
| **Edit stall thresholds** | **Onboarding** > Onboarding settings > change the days for each stage (2 to 5) > **Save days**. |
| **Change semester start dates** | **More** > Semester start dates. Team leads see a "review availability" reminder for about a month after each date. |
| **Remove a saved "Other" event name** | **More** > Saved event names > tap the name. |
| **Add a school event** | **More** > **Add school event**. Pick the type, date and schools. For home basketball games, end the location with "(home)". |
| **Change or delete a school event** | **Calendar** > tap the event > **Edit**. |

Creating an account and adding a leader to the roster are separate steps: the roster is the list people see, the account list is who may sign in.

## What every leader can do
- Sign in with email and password. No email is sent. They stay signed in on that device until they sign out, and can change their password under **More > Your account**.
- See the roster, calendar, school pages, team availability and the Onboarding page.
- Schedule an event (Club, Lunch Room Visit, Cookie Run, Hang Out, Small Group, or Other with its own name) at a school or group, one time or every week, with a start and end time. The form lists that site's team and marks each person Available or Not available from their weekly availability; assigning someone who is not available shows a warning but is allowed. For schools it still warns about days off and can skip them.
- After an event's date, mark it Completed and tick who went, or mark it Canceled (**Calendar > Past events**, or the Month view).
- Work the onboarding pipeline: add prospects, move stages, add notes, release (with a reason), move to the holding list, and add someone to the roster at Final Decision.
- Tap any event > **Add to my calendar** or **Google Calendar**.

Team leads (and admins) also enter their team's weekly availability: **Roster > Availability** next to the team name.

## Onboarding notes
- Only the stage is tracked. Do not record background-check results or details in notes.
- "Days in stage" counts from the last stage change; for the imported prospects it counts from the day they were imported.
- Imported prospects with spreadsheet problems carry a **Needs review** badge listing what was wrong. An admin opens the prospect and taps **Mark as reviewed** once it is fixed.

## Privacy
- Only approved emails can sign in; the database refuses everyone else, including for phone numbers and emails.
- Passwords are kept only as hashes by Supabase. Nobody can read one back; admins can only replace it with a new temporary one.
- `Data/`, `supabase/seed*.sql` and the brief files contain names and are listed in `.gitignore`, so they stay on your computer and are never uploaded.
- The Gmail App Password and Supabase's service key live only in Supabase. They are never in this repository.

## Trying it on your own computer
Run `python3 -m http.server 8000` in this folder and open `http://localhost:8000/?demo`. It runs a private demo using the files in `Data/` and saves only in that browser; nothing reaches the real database.

## Files
- `index.html`, `css/`, `js/`: the site
- `config.js`: the two Supabase settings
- `supabase/schema.sql`, `supabase/migration_002.sql`: tables and security rules
- `supabase/functions/`: the two server functions
- `supabase/cron.sql`: the email schedule
- `tools/make_seed.py`, `tools/make_seed_update2.py`: rebuild the seed files from `Data/`
