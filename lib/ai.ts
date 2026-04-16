import OpenAI from "openai";

import { fallbackInterpretation, type Interpretation } from "@/lib/lattice";

const systemPrompt = `You are Lattice, an AI-native team state interpreter.
Extract the user's natural update into living team state effects.
Use only these entity types: intent, promise, blocker, shift, request, reminder, signal.
Return compact JSON with:
- reply: a short visible interpretation
- entities: array of { type, title, detail, owner?, trigger?, target?, why?, linkedTo? }
- followUpQuestion?: one short question only when ambiguity blocks correctness
- broadcast?: short team-relevant bullets when the update affects more than one person
Prefer state mutation language over task-manager language.`;

export async function interpretWithOpenAI(input: string): Promise<Interpretation> {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackInterpretation(input);
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: input },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message.content;
  if (!content) {
    return fallbackInterpretation(input);
  }

  try {
    const parsed = JSON.parse(content) as Interpretation;
    if (!parsed.reply || !Array.isArray(parsed.entities)) {
      return fallbackInterpretation(input);
    }

    return parsed;
  } catch {
    return fallbackInterpretation(input);
  }
}
