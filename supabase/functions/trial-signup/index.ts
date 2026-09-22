import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const APP_URL = "https://presupuestopro.norialabs.site/?activate=1";
const TRIAL_DAYS = 7;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, message: "Método no permitido." }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();

    if (!validEmail(email)) {
      return json({ ok: false, message: "Escribe un correo electrónico válido." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return json({ ok: false, message: "Configuración del servidor incompleta." }, 500);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // One trial per email. Existing owners/subscribers are also not converted.
    const { data: existing, error: existingError } = await admin
      .from("licenses")
      .select("user_id,email,status,license_type,trial_started_at,trial_ends_at")
      .eq("email", email)
      .maybeSingle();

    if (existingError) {
      console.error("license lookup", existingError);
      return json({ ok: false, message: "No pudimos verificar este correo. Inténtalo nuevamente." }, 500);
    }

    if (existing) {
      if (existing.license_type === "trial" || existing.status === "trial") {
        return json({
          ok: false,
          message: "Este correo ya tiene o ya tuvo un acceso de prueba. Si ya activaste tu cuenta, entra desde “Ya tengo una cuenta”.",
        }, 409);
      }

      return json({
        ok: false,
        message: "Este correo ya está asociado a una cuenta de Presupuesto Rápido PRO.",
      }, 409);
    }

    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: APP_URL,
      data: { source: "private_trial", trial_days: TRIAL_DAYS },
    });

    if (inviteError || !invited?.user?.id) {
      console.error("invite", inviteError);
      const msg = String(inviteError?.message || "").toLowerCase();
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
        return json({
          ok: false,
          message: "Este correo ya está asociado a una cuenta. Usa “Ya tengo una cuenta” para ingresar.",
        }, 409);
      }
      return json({ ok: false, message: "No pudimos enviar la invitación. Inténtalo nuevamente." }, 500);
    }

    const userId = invited.user.id;
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const trialValues = {
      email,
      status: "trial",
      plan: "individual",
      max_devices: 2,
      trial_started_at: startedAt.toISOString(),
      trial_ends_at: endsAt.toISOString(),
      paid_until: null,
      payment_provider: "trial",
      billing_cycle: null,
      auto_renew: false,
      last_payment_at: null,
      canceled_at: null,
      license_type: "trial",
    };

    const { data: updated, error: updateError } = await admin
      .from("licenses")
      .update(trialValues)
      .eq("user_id", userId)
      .select("user_id")
      .maybeSingle();

    if (updateError) {
      console.error("license update", updateError);
      await admin.auth.admin.deleteUser(userId).catch(() => {});
      return json({ ok: false, message: "No pudimos activar la prueba. Inténtalo nuevamente." }, 500);
    }

    if (!updated) {
      const { error: insertError } = await admin
        .from("licenses")
        .insert({ user_id: userId, ...trialValues });

      if (insertError) {
        console.error("license insert", insertError);
        await admin.auth.admin.deleteUser(userId).catch(() => {});
        return json({ ok: false, message: "No pudimos activar la prueba. Inténtalo nuevamente." }, 500);
      }
    }

    return json({
      ok: true,
      message: "Listo. Revisa tu correo y pulsa “Activar mi acceso” para crear tu contraseña.",
    });
  } catch (error) {
    console.error("trial-signup", error);
    return json({ ok: false, message: "Ocurrió un error inesperado. Inténtalo nuevamente." }, 500);
  }
});
