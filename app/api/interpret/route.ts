import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { interpretWithOpenAI } from "@/lib/ai";

export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const body = (await request.json()) as { input?: string };
  const input = body.input?.trim();

  if (!input) {
    return NextResponse.json({ error: "Missing input" }, { status: 400 });
  }

  const interpretation = await interpretWithOpenAI(input);

  return NextResponse.json(interpretation);
}
