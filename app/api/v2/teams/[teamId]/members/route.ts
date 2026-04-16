import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { listTeamMembers, removeMember, updateMemberRole, type TeamRole } from "@/lib/teams";

const roles: TeamRole[] = ["owner", "admin", "member"];

export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { teamId } = await params;
  try {
    const members = await listTeamMembers(auth.supabase, teamId);
    return NextResponse.json({ members });
  } catch (err) {
    console.error("members GET", err);
    return NextResponse.json({ error: "Failed to list members." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { teamId } = await params;
  let body: { memberId?: string; role?: TeamRole };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.memberId || !body.role || !roles.includes(body.role)) {
    return NextResponse.json({ error: "memberId and role required." }, { status: 400 });
  }
  try {
    await updateMemberRole(auth.supabase, { teamSpaceId: teamId, memberId: body.memberId, role: body.role });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("members PATCH", err);
    return NextResponse.json({ error: "Update failed (admin required)." }, { status: 403 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { teamId } = await params;
  const url = new URL(request.url);
  const memberId = url.searchParams.get("memberId");
  if (!memberId) return NextResponse.json({ error: "memberId required." }, { status: 400 });
  try {
    await removeMember(auth.supabase, { teamSpaceId: teamId, memberId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("members DELETE", err);
    return NextResponse.json({ error: "Remove failed (admin required)." }, { status: 403 });
  }
}
