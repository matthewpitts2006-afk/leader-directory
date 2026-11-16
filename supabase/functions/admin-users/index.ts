// Edge Function: admin-users
// Lets a signed-in ADMIN create an account with a temporary password, reset a
// leader's password to a new temporary one, or remove an account.
//
// Passwords are never stored in a readable form: the temporary password is made
// here, handed to Supabase Auth (which keeps only a hash), and returned once to
// the admin's screen. The service-role key is supplied by Supabase to this
// function automatically; it is never in the website or this repository.
//
// Deploy with "Verify JWT" turned OFF; this function checks the caller itself.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// 12 random characters, without look-alikes such as 0/O and 1/l.
function tempPassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const c = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => alphabet[b % alphabet.length]);
  return `${c.slice(0, 4).join("")}-${c.slice(4, 8).join("")}-${c.slice(8).join("")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Who is calling? They must be signed in and marked as an admin.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who } = await admin.auth.getUser(token);
    const callerEmail = who?.user?.email?.toLowerCase();
    if (!callerEmail) return json({ error: "Please sign in again." }, 401);
    const { data: callerRow } = await admin.from("allowed_emails").select("is_admin").ilike("email", callerEmail).maybeSingle();
    if (!callerRow?.is_admin) return json({ error: "Only an admin can do this." }, 403);

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That does not look like an email address." }, 400);

    const findUser = async () => {
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw error;
        const hit = data.users.find((u) => (u.email || "").toLowerCase() === email);
        if (hit) return hit;
        if (data.users.length < 200) return null;
      }
      return null;
    };
    const { data: row } = await admin.from("allowed_emails").select("email, is_admin").ilike("email", email).maybeSingle();

    if (body.action === "set-temp-password") {
      if (!row && !body.create) return json({ error: "That email is not on the approved list." }, 404);
      if (email === callerEmail) return json({ error: "Change your own password under More > Your account." }, 400);
      // Approve the email first; the database refuses to create accounts for unapproved emails.
      if (!row) {
        const { error } = await admin.from("allowed_emails").insert({ email, is_admin: !!body.is_admin, must_change_password: true });
        if (error) throw error;
      }
      const password = tempPassword();
      const user = await findUser();
      const { error } = user
        ? await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true })
        : await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw error;
      const { error: flagError } = await admin.from("allowed_emails").update({ must_change_password: true }).ilike("email", email);
      if (flagError) throw flagError;
      return json({ temp_password: password });
    }

    if (body.action === "remove") {
      if (email === callerEmail) return json({ error: "You cannot remove your own account." }, 400);
      const { error } = await admin.from("allowed_emails").delete().ilike("email", email);
      if (error) throw error;
      const user = await findUser();
      if (user) {
        const { error: delError } = await admin.auth.admin.deleteUser(user.id);
        if (delError) throw delError;
      }
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
