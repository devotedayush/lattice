import { NextResponse } from "next/server";
import OpenAI from "openai";

import { requireUserSupabaseClient } from "@/lib/auth-server";

export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not set. Text input still works in the prototype." },
      { status: 503 },
    );
  }

  const form = await request.formData();
  const file = form.get("audio");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  try {
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe",
    });
    return NextResponse.json({ text: transcription.text });
  } catch (err) {
    console.error("/api/transcribe failed", err);
    const message =
      err instanceof Error ? err.message : "Transcription failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
