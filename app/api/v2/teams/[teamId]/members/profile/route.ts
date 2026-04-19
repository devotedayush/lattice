import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { updateMemberProfile } from "@/lib/teams";

// PATCH /api/v2/teams/[teamId]/members/profile
//   { skills?: string[]; focus?: string | null; bio?: string | null }
//
// Self-edit only. The RLS policy on team_members is expected to allow a user
// to update their own row; we match on team_space_id + user_id = current user
// to ensure that. Arrays get sanitized (trim, dedupe, <= 20 entries).
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { teamId } = await params;

  let body: {
    name?: string;
    skills?: string[];
    focus?: string | null;
    bio?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // Find the caller's own team_member row for this team.
  const { data: me, error: meErr } = await auth.supabase
    .from("team_members")
    .select("id")
    .eq("team_space_id", teamId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (meErr) {
    console.error("profile PATCH lookup", meErr);
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
  if (!me) {
    return NextResponse.json(
      { error: "You are not a member of this team." },
      { status: 403 },
    );
  }

  const name =
    typeof body.name === "string" ? body.name.trim().slice(0, 60) || undefined : undefined;

  const skills = Array.isArray(body.skills)
    ? Array.from(
        new Set(
          body.skills
            .map((s) => (typeof s === "string" ? s.trim() : ""))
            .filter((s) => s.length > 0 && s.length <= 40),
        ),
      ).slice(0, 20)
    : undefined;

  const focus =
    body.focus === null
      ? null
      : typeof body.focus === "string"
      ? body.focus.trim().slice(0, 200) || null
      : undefined;

  const bio =
    body.bio === null
      ? null
      : typeof body.bio === "string"
      ? body.bio.trim().slice(0, 600) || null
      : undefined;

  try {
    await updateMemberProfile(auth.supabase, {
      teamSpaceId: teamId,
      memberId: me.id,
      name,
      skills,
      focus,
      bio,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("profile PATCH", err);
    const message = err instanceof Error ? err.message : "Update failed.";
    return NextResponse.json({ error: message }, { status: 403 });
  }
}
