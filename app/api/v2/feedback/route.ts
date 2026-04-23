import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";

const ADMIN_EMAIL = "maantech123@gmail.com";

export async function GET(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const isAdmin = (auth.user.email ?? "").toLowerCase() === ADMIN_EMAIL;
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const { data, error } = await auth.supabase
    .from("platform_feedback")
    .select("id, user_id, email, message, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("/api/v2/feedback GET", error);
    return NextResponse.json({ error: "Failed to load feedback." }, { status: 500 });
  }
  return NextResponse.json({
    feedback: (data ?? []).map((row) => ({
      id: row.id,
      userId: row.user_id,
      email: row.email,
      message: row.message,
      createdAt: row.created_at,
    })),
  });
}

export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: { message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "Feedback message required." }, { status: 400 });
  }
  if (message.length > 4000) {
    return NextResponse.json({ error: "Keep it under 4000 characters." }, { status: 400 });
  }
  const { error } = await auth.supabase.from("platform_feedback").insert({
    user_id: auth.user.id,
    email: auth.user.email ?? null,
    message,
  });
  if (error) {
    console.error("/api/v2/feedback POST", error);
    return NextResponse.json({ error: "Failed to submit feedback." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
