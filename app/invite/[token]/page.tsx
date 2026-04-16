"use client";

import { use, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";

import { createSupabaseBrowserClient } from "@/lib/supabase";

export default function InviteAcceptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sign-in form
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    if (!supabase) {
      setChecking(false);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, [supabase]);

  // Once signed in, accept the invite automatically.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const accept = async () => {
      setBusy(true);
      setStatus("Accepting invite…");
      try {
        const res = await fetch("/api/v2/invitations/accept", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json()) as { ok?: boolean; teamSpaceId?: string; error?: string };
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setErr(data.error ?? "Invite not valid.");
          setStatus(null);
          return;
        }
        setStatus("Joined. Taking you in…");
        setTimeout(() => router.replace("/"), 600);
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void accept();
    return () => {
      cancelled = true;
    };
  }, [session, token, router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setErr(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setErr(error.message);
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name } },
        });
        if (error) setErr(error.message);
      }
    } finally {
      setBusy(false);
    }
  };

  if (checking) {
    return (
      <div className="auth-wrap">
        <div className="muted small">Loading…</div>
      </div>
    );
  }

  if (session) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="brand" style={{ marginBottom: 20 }}>
            <span className="brand-dot" aria-hidden /> Lattice
          </div>
          <h1>Joining…</h1>
          {status && <p className="muted">{status}</p>}
          {err && <div className="auth-error">{err}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: 20 }}>
          <span className="brand-dot" aria-hidden /> Lattice
        </div>
        <h1>You&apos;re invited</h1>
        <p className="muted">Sign in or create an account to accept.</p>

        <div className="auth-tabs">
          <button
            type="button"
            className="tab"
            aria-selected={mode === "signin"}
            onClick={() => setMode("signin")}
          >
            Sign in
          </button>
          <button
            type="button"
            className="tab"
            aria-selected={mode === "signup"}
            onClick={() => setMode("signup")}
          >
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === "signup" && (
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <input
            type="email"
            placeholder="you@team.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="btn-primary" type="submit" disabled={busy}>
            {mode === "signin" ? "Sign in & join" : "Create account & join"}
          </button>
        </form>

        {err && <div className="auth-error">{err}</div>}
      </div>
    </div>
  );
}
