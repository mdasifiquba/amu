# Supabase setup (static website, no custom web server)

1. Create a Supabase project. This direct-browser setup uses Supabase's hosted Data API; it does not connect the browser to the Aiven PostgreSQL socket.
2. In **Project Settings → API**, copy the **Project URL** and the **publishable/anon key** into `supabase-config.js`. Never put the `service_role` key or database password in browser code.
3. In **SQL Editor**, run `supabase-setup.sql` to create the submissions table and its Row Level Security policies.
4. In **Authentication → Users**, create one admin account with an email and a strong password. Copy the admin email.
5. In SQL Editor, replace `YOUR_ADMIN_EMAIL` in the commented update statement at the end of `supabase-setup.sql`, uncomment those lines, and run them. This grants admin access through protected `app_metadata`.
6. Configure Render as a **Static Site** with publish directory `.` (the checked-in `render.yaml` is configured this way). Redeploy after setting the Supabase config.

Students can submit records using the public publishable/anon key, but Row Level Security prevents anonymous reads. Only authenticated users marked `app_metadata.role = admin` can read or delete results. Since test answers and scoring run in the browser, this is suitable for a practice mock test, not a tamper-proof exam system.

The previously shared Aiven credentials are separate and should be rotated. A Supabase project is required for this setup; the Aiven URI cannot be used as the Supabase project URL or anon key.
