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

  // Capture up-front so we can include it in *every* error response — the actual
  // cause of "Audio file might be corrupted or unsupported" is almost always a
  // mime/container mismatch (mobile Safari = audio/mp4, not audio/webm) and we
  // can't diagnose that from a generic 400 on the client.
  const fileInfo = {
    name: file.name,
    size: file.size,
    type: file.type || "unknown",
  };

  if (file.size === 0) {
    return NextResponse.json(
      { error: "Empty audio file (0 bytes). Mic may not have captured anything.", file: fileInfo },
      { status: 400 },
    );
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  const model = process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe";

  try {
    const transcription = await openai.audio.transcriptions.create({ file, model });
    return NextResponse.json({ text: transcription.text });
  } catch (err) {
    console.error("/api/transcribe failed", { fileInfo, model, err });
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : typeof err === "string" ? err : "unknown error";
    const upstreamStatus =
      typeof err === "object" && err && "status" in err && typeof (err as { status: unknown }).status === "number"
        ? ((err as { status: number }).status)
        : undefined;
    return NextResponse.json(
      {
        error: `Transcribe failed: ${detail}`,
        upstreamStatus,
        file: fileInfo,
        model,
      },
      { status: upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 500 ? 400 : 500 },
    );
  }
}
