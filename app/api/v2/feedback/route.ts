import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { isPlatformAdminEmail, PLATFORM_ADMIN_EMAIL } from "@/lib/platform-admin";

type SupabaseError = {
  code?: string;
  message?: string;
};

function isMissingFeedbackTable(error: SupabaseError) {
  return error.code === "PGRST205" || error.message?.includes("platform_feedback");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function emailFeedbackFallback(params: { message: string; userEmail: string | null }) {
  if (!isEmailConfigured()) {
    return false;
  }

  const fromLabel = params.userEmail ?? "Unknown user";
  await sendEmail({
    to: PLATFORM_ADMIN_EMAIL,
    subject: "New Orgmind feedback",
    text: `Feedback from ${fromLabel}\n\n${params.message}`,
    html: `
      <p><strong>Feedback from:</strong> ${escapeHtml(fromLabel)}</p>
      <p style="white-space: pre-wrap;">${escapeHtml(params.message)}</p>
    `,
  });
  return true;
}

export async function GET(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const isAdmin = isPlatformAdminEmail(auth.user.email);
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
    if (isMissingFeedbackTable(error)) {
      try {
        const emailed = await emailFeedbackFallback({ message, userEmail: auth.user.email ?? null });
        if (emailed) {
          console.warn("/api/v2/feedback POST used email fallback because platform_feedback is missing.");
          return NextResponse.json({ ok: true, delivery: "email" });
        }
      } catch (emailError) {
        console.error("/api/v2/feedback fallback email", emailError);
      }

      return NextResponse.json(
        { error: "Feedback storage is not set up yet. Apply the platform feedback migration." },
        { status: 503 },
      );
    }

    console.error("/api/v2/feedback POST", error);
    return NextResponse.json({ error: "Failed to submit feedback." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
