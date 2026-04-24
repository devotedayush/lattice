import { NextResponse } from "next/server";

import { getJoinLinkTeam } from "@/lib/teams";
import { createSupabaseServiceClient } from "@/lib/supabase";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const admin = createSupabaseServiceClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing." },
      { status: 500 },
    );
  }

  const { token } = await params;
  try {
    const team = await getJoinLinkTeam(admin, token);
    if (!team) return NextResponse.json({ error: "Join link not found." }, { status: 404 });
    return NextResponse.json({ team });
  } catch (err) {
    console.error("join-links GET", err);
    return NextResponse.json({ error: "Failed to load join link." }, { status: 500 });
  }
}
