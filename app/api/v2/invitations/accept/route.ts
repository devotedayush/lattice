import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
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
  try {
    const { teamSpaceId } = await acceptInvite(auth.supabase, auth.user, body.token);
    return NextResponse.json({ ok: true, teamSpaceId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Accept failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
