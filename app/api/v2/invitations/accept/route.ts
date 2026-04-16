import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { createSupabaseServiceClient } from "@/lib/supabase";
import { acceptInvite } from "@/lib/teams";

export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.token) return NextResponse.json({ error: "token required." }, { status: 400 });

  // Invitees are not yet members, so RLS on team_invitations blocks them from
  // reading their own invite by token. Use the service-role client to look up
  // and accept the invite — we've already verified the user via their Bearer.
  const admin = createSupabaseServiceClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing." },
      { status: 500 },
    );
  }

  try {
    const { teamSpaceId } = await acceptInvite(admin, auth.user, body.token);
    return NextResponse.json({ ok: true, teamSpaceId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Accept failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
