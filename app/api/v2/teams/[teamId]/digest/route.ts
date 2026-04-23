import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { getAppBaseUrl, isEmailConfigured, sendEmail } from "@/lib/email";
import { itemsForOwner, buildTaskDigestEmail } from "@/lib/task-digest";
import { getUserActiveTeam, listTeamMembers } from "@/lib/teams";
import { fetchLatticeState } from "@/lib/v2-db";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!isEmailConfigured()) {
    return NextResponse.json(
      { error: "Email is not configured on the server yet." },
      { status: 503 },
    );
  }

  const { teamId } = await params;

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, teamId);
    if (!team || team.id !== teamId) {
      return NextResponse.json({ error: "No team found." }, { status: 404 });
    }
    if (team.role !== "owner" && team.role !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }

    const [state, members] = await Promise.all([
      fetchLatticeState(auth.supabase, team.id),
      listTeamMembers(auth.supabase, team.id),
    ]);

    const siteUrl = getAppBaseUrl();
    let sent = 0;
    let skipped = 0;

    for (const member of members) {
      if (!member.email) {
        skipped += 1;
        continue;
      }

      const items = itemsForOwner(state, member.name);
      const message = buildTaskDigestEmail({
        memberName: member.name || member.email,
        teamName: team.name,
        siteUrl,
        items,
      });

      await sendEmail({
        to: member.email,
        subject: `${team.name}: your current tasks`,
        text: message.text,
        html: message.html,
      });
      sent += 1;
    }

    return NextResponse.json({
      ok: true,
      sent,
      skipped,
    });
  } catch (err) {
    console.error("task digest POST", err);
    return NextResponse.json({ error: "Failed to send task emails." }, { status: 500 });
  }
}
