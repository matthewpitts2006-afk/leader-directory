# Leader Directory

A small phone-friendly website for our leaders: the roster, school calendars and days off, and Club / Lunch Room Visit scheduling.

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

### 4. Tell Supabase where the site lives
In Supabase: **Authentication > URL Configuration**.
- **Site URL**: your GitHub Pages address from step 3.
- **Redirect URLs**: add the same address.

Without this, the sign-in link in the email will not come back to the site.

### 5. Set up sign-in email (needed before inviting other leaders)
Supabase's built-in email sender is only for testing. It is heavily rate limited and may only deliver to people on your Supabase team, so it will work for you but not for 60 leaders. Before inviting others, go to **Authentication > Emails > SMTP Settings** and connect an email service (Brevo, Resend, or a Gmail app password are common free choices). You enter those credentials in the Supabase dashboard yourself; they never go in this repository. Check Supabase's current docs on "custom SMTP" for the exact limits.

## Everyday admin tasks

Sign in with your admin email. Admins see extra buttons that other leaders do not.

| Task | How |
| --- | --- |
| **Approve a new email** | **More** tab > Approved emails > type the email > **Approve**. That person can now sign in with a link. Tick "Admin" to let them manage the directory too. |
| **Remove someone's access** | **More** tab > Approved emails > **Remove** next to their email. |
| **Add a leader** | **Roster** tab > **Add leader** (or **More** > **Add leader**). |
| **Update phone or email** | **Roster** tab > **Edit** next to the person > fill in Phone / Email > **Save**. |
| **Move a leader or change team lead** | Same Edit form: change Assignment or tick "Team lead". |
| **Add a school event** | **More** tab > **Add school event**. Pick the type, date and schools. For home basketball games, end the location with "(home)". |
| **Change or delete a school event** | **Calendar** > tap the event > **Edit**. |

Approving an email and adding a leader to the roster are separate steps: the roster is the list people see, the approved list is who may sign in.

## What every leader can do
- See the roster, calendar and school pages.
- Schedule a Club or Lunch Room Visit, one time or every week, and choose who is going. The form warns when a date lands on a day off at that school and can skip those dates.
- Edit or cancel one visit or a whole weekly series.
- Tap any event > **Add to my calendar** (downloads a calendar file) or **Google Calendar**.

## Privacy
- Only approved emails can sign in; the database refuses everyone else, including for phone numbers and emails.
- `Data/`, `supabase/seed.sql` and `BUILD_BRIEF.md` contain names and are listed in `.gitignore`, so they stay on your computer and are never uploaded.

## Trying it on your own computer
With `config.js` still unfilled, run `python3 -m http.server 8000` in this folder and open `http://localhost:8000`. It runs a private demo using the files in `Data/` and saves only in that browser.

## Files
- `index.html`, `css/`, `js/`: the site
- `config.js`: the two Supabase settings
- `supabase/schema.sql`: tables and security rules
- `tools/make_seed.py`: rebuilds `supabase/seed.sql` from `Data/`
