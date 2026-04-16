import { createSupabaseUserServerClient } from "@/lib/supabase";

export async function requireUserSupabaseClient(request: Request) {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return { error: "Sign in required.", status: 401 as const };
  }

  const supabase = createSupabaseUserServerClient(authorization);

  if (!supabase) {
    return { error: "Supabase is not configured.", status: 503 as const };
  }

  const token = authorization.slice("Bearer ".length);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return { error: "Session expired. Please sign in again.", status: 401 as const };
  }

  return { supabase, user };
}
