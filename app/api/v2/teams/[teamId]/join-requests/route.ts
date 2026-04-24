import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { createSupabaseServiceClient } from "@/lib/supabase";
import { listJoinRequests, reviewJoinRequest } from "@/lib/teams";

export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { teamId } = await params;
  try {
    const requests = await listJoinRequests(auth.supabase, teamId);
    return NextResponse.json({ requests });
  } catch (err) {
    console.error("join-requests GET", err);
    return NextResponse.json({ error: "Failed to list join requests." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { teamId } = await params;

  let body: { joinRequestId?: string; action?: "approve" | "reject" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.joinRequestId || !body.action) {
    return NextResponse.json({ error: "joinRequestId and action required." }, { status: 400 });
  }

  const { data: membership, error: membershipError } = await auth.supabase
    .from("team_members")
    .select("role")
    .eq("team_space_id", teamId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (membershipError) {
    return NextResponse.json({ error: "Failed to verify admin access." }, { status: 500 });
  }
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return NextResponse.json({ error: "Only team owners or admins can review join requests." }, { status: 403 });
  }

  const admin = createSupabaseServiceClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing." },
      { status: 500 },
    );
  }

  try {
    await reviewJoinRequest(admin, auth.user, {
      teamSpaceId: teamId,
      joinRequestId: body.joinRequestId,
      action: body.action,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("join-requests PATCH", err);
    const msg = err instanceof Error ? err.message : "Join request review failed.";
    return NextResponse.json({ error: msg }, { status: 403 });
  }
}
