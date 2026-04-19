import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { createInvite, listInvites, revokeInvite, type TeamRole } from "@/lib/teams";

const roles: TeamRole[] = ["owner", "admin", "member"];

export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { teamId } = await params;
  try {
    const invites = await listInvites(auth.supabase, teamId);
    return NextResponse.json({ invites });
  } catch (err) {
    console.error("invites GET", err);
    return NextResponse.json({ error: "Failed to list invites." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { teamId } = await params;
  let body: { email?: string; role?: TeamRole };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const email = body.email?.trim();
  const role: TeamRole = body.role && roles.includes(body.role) ? body.role : "member";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email required." }, { status: 400 });
  }
  try {
    const invite = await createInvite(auth.supabase, auth.user, {
      teamSpaceId: teamId,
      email,
      role,
    });
    return NextResponse.json({ invite });
  } catch (err) {
    console.error("invites POST", err);
    return NextResponse.json({ error: "Invite failed (admin required)." }, { status: 403 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  await params; // teamId not used for delete, invite id is enough
  const url = new URL(request.url);
  const inviteId = url.searchParams.get("inviteId");
  if (!inviteId) return NextResponse.json({ error: "inviteId required." }, { status: 400 });
  try {
    await revokeInvite(auth.supabase, inviteId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("invites DELETE", err);
    const msg = err instanceof Error ? err.message : "Revoke failed.";
    return NextResponse.json({ error: msg }, { status: 403 });
  }
}
