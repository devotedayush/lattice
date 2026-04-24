import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { createJoinRequest } from "@/lib/teams";
import { createSupabaseServiceClient } from "@/lib/supabase";

export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { token?: string; message?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.token) return NextResponse.json({ error: "token required." }, { status: 400 });

  const admin = createSupabaseServiceClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing." },
      { status: 500 },
    );
  }

  try {
    const result = await createJoinRequest(admin, auth.user, {
      joinToken: body.token,
      message: body.message,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Join request failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
