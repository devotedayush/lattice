"use client";

import { use, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";

import { createSupabaseBrowserClient } from "@/lib/supabase";

type JoinTeam = {
  teamSpaceId: string;
  teamName: string;
};

export default function JoinTeamPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadingTeam, setLoadingTeam] = useState(true);
  const [requested, setRequested] = useState(false);
  const [team, setTeam] = useState<JoinTeam | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    let cancelled = false;
    const loadTeam = async () => {
      setLoadingTeam(true);
      try {
        const res = await fetch(`/api/v2/join-links/${encodeURIComponent(token)}`);
        const data = (await res.json().catch(() => ({}))) as { team?: JoinTeam; error?: string };
        if (cancelled) return;
        if (!res.ok || !data.team) {
          setErr(data.error ?? "Join link not valid.");
          setTeam(null);
          return;
        }
        setTeam(data.team);
      } finally {
        if (!cancelled) setLoadingTeam(false);
      }
    };
    void loadTeam();
    return () => {
      cancelled = true;
    };
  }, [token]);

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

  useEffect(() => {
    if (!session || !team || requested) return;
    let cancelled = false;
    const submitRequest = async () => {
      setBusy(true);
      setErr(null);
      setStatus(`Sending your request to join ${team.teamName}…`);
      try {
        const res = await fetch("/api/v2/join-requests", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          team?: JoinTeam;
          alreadyMember?: boolean;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setErr(data.error ?? "Join request failed.");
          setStatus(null);
          return;
        }
        if (data.team) setTeam(data.team);
        if (data.alreadyMember) {
          setStatus(`You are already in ${data.team?.teamName ?? team.teamName}. Taking you in…`);
          setTimeout(() => router.replace("/"), 700);
          return;
        }
        setRequested(true);
        setStatus(`Request sent to ${data.team?.teamName ?? team.teamName}. An owner or admin needs to approve it.`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void submitRequest();
    return () => {
      cancelled = true;
    };
  }, [requested, router, session, team, token]);

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

  if (checking || loadingTeam) {
    return (
      <div className="auth-wrap">
        <div className="muted small">Loading…</div>
      </div>
    );
  }

  if (err && !team) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="brand" style={{ marginBottom: 20 }}>
            <span className="brand-dot" aria-hidden /> Lattice
          </div>
          <h1>Join link not available</h1>
          <div className="auth-error">{err}</div>
        </div>
      </div>
    );
  }

  if (session || requested) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="brand" style={{ marginBottom: 20 }}>
            <span className="brand-dot" aria-hidden /> Lattice
          </div>
          <h1>{requested ? "Request sent" : "Joining…"}</h1>
          {team && <p className="muted">Team: {team.teamName}</p>}
          {status && <p className="muted">{status}</p>}
          {err && <div className="auth-error">{err}</div>}
          {requested && (
            <button type="button" className="btn-ghost" onClick={() => router.push("/")}>
              Back to app
            </button>
          )}
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
        <h1>Request to join</h1>
        <p className="muted">
          {team ? `Create an account or sign in to request access to ${team.teamName}.` : "Create an account or sign in to request access."}
        </p>

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
            {mode === "signin" ? "Sign in & request access" : "Create account & request access"}
          </button>
        </form>

        {err && <div className="auth-error">{err}</div>}
      </div>
    </div>
  );
}
