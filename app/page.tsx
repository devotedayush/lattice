"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Session } from "@supabase/supabase-js";

import { isPlatformAdminEmail } from "@/lib/platform-admin";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import {
  accentForChangeKind,
  atRiskCount,
  emptyLatticeState,
  formatRelative,
  glyphForChangeKind,
  goalDrift,
  labelForChangeKind,
  structuralAnalysis,
  teamConfidence,
  type ChangeEvent,
  type InterpretationV2,
  type Intervention,
  type InterventionState,
  type LatticeState,
} from "@/lib/v2";
import type { FieldObject, FieldObjectType } from "@/lib/lattice";
import { statsForMember } from "@/lib/member-stats";

type Tab = "pulse" | "timeline" | "interventions" | "commitments";

type TeamSummary = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
  memberName?: string;
  joinToken?: string | null;
};

type AuthedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const SAMPLES = [
  "Onboarding flow is done except for the last copy block — waiting on brand.",
  "Dropping analytics for now. Only the demo walkthrough matters this week.",
  "Priya, can the auth patch land before tonight's dry run?",
  "Remind me at 8 to retry the deploy after the auth fix.",
];

export default function Page() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [state, setState] = useState<LatticeState>(emptyLatticeState);
  const [tab, setTab] = useState<Tab>("pulse");
  const [orbKick, setOrbKick] = useState(0);
  const [chatPrefill, setChatPrefill] = useState<{ text: string; at: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const [needsTeam, setNeedsTeam] = useState(false);
  const [teamPanel, setTeamPanel] = useState<"none" | "create" | "manage">("none");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [members, setMembers] = useState<
    {
      id: string;
      name: string;
      role: string;
      email?: string | null;
      skills?: string[];
      focus?: string | null;
      bio?: string | null;
    }[]
  >([]);
  const [simulating, setSimulating] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [liveStatus, setLiveStatus] = useState<string>("watching");
  const isPlatformAdmin = isPlatformAdminEmail(session?.user.email);
  const [updatedIds, setUpdatedIds] = useState<Set<string>>(new Set());
  const loadStateRequest = useRef(0);
  const markUpdated = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setUpdatedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    setLiveStatus("change just landed");
    setTimeout(() => {
      setUpdatedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setLiveStatus("watching");
    }, 2400);
  }, []);

  useEffect(() => {
    if (!supabase) {
      setCheckingAuth(false);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingAuth(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, next) => {
      setSession(next);
      if (!next) setState(emptyLatticeState);
    });
    return () => subscription.unsubscribe();
  }, [supabase]);

  const authedFetch = useCallback<AuthedFetch>(
    async (input, init = {}) => {
      if (!session) throw new Error("Sign in required.");
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${session.access_token}`);
      // Only default JSON for body types that aren't already structured (FormData,
      // Blob, URLSearchParams set their own Content-Type / multipart boundary).
      const body = init.body;
      const isStructured =
        typeof FormData !== "undefined" && body instanceof FormData ||
        typeof Blob !== "undefined" && body instanceof Blob ||
        typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams;
      if (body && !headers.has("Content-Type") && !isStructured) {
        headers.set("Content-Type", "application/json");
      }
      return fetch(input, { ...init, headers });
    },
    [session],
  );

  const loadTeams = useCallback(async () => {
    if (!session) return;
    const res = await authedFetch("/api/v2/teams");
    if (!res.ok) return;
    const data = (await res.json()) as { teams: TeamSummary[] };
    const nextTeams = data.teams ?? [];
    setTeams(nextTeams);
    if (!nextTeams.length) {
      setNeedsTeam(true);
      setActiveTeamId(null);
    } else {
      setNeedsTeam(false);
      setActiveTeamId((prev) => (prev && nextTeams.some((team) => team.id === prev) ? prev : nextTeams[0].id));
    }
  }, [authedFetch, session]);

  const loadState = useCallback(
    async (teamId?: string) => {
      if (!session) return;
      const tid = teamId ?? activeTeamId;
      if (!tid) return;
      const requestId = ++loadStateRequest.current;
      try {
        setLoading(true);
        const res = await authedFetch(`/api/v2/state?team=${encodeURIComponent(tid)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { state: LatticeState | null; team: TeamSummary | null };
        if (loadStateRequest.current !== requestId) return;
        if (data.state) setState(data.state);
      } finally {
        if (loadStateRequest.current === requestId) {
          setLoading(false);
        }
      }
    },
    [authedFetch, session, activeTeamId],
  );

  useEffect(() => {
    if (session) void loadTeams();
  }, [session, loadTeams]);

  useEffect(() => {
    if (session && activeTeamId) void loadState(activeTeamId);
  }, [session, activeTeamId, loadState]);

  // Clear team-scoped UI immediately so switching teams never shows stale content.
  useEffect(() => {
    setState(emptyLatticeState);
    setMembers([]);
    setUpdatedIds(new Set());
  }, [activeTeamId]);

  // Load members for the active team so we can power the reassign dropdown.
  useEffect(() => {
    if (!session || !activeTeamId) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(
          `/api/v2/teams/${encodeURIComponent(activeTeamId)}/members`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          members?: { id: string; name: string; role: string; email?: string | null; skills?: string[]; focus?: string | null; bio?: string | null }[];
        };
        if (!cancelled) setMembers(data.members ?? []);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, activeTeamId, authedFetch]);

  // Supabase realtime: refresh state when anything in this team changes
  useEffect(() => {
    if (!supabase || !activeTeamId) return;
    const bump = (payload: { new?: { id?: string }; old?: { id?: string } }) => {
      const id = payload?.new?.id ?? payload?.old?.id;
      if (id) markUpdated([id]);
      void loadState(activeTeamId);
    };
    const channel = supabase
      .channel(`lattice-${activeTeamId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "change_events", filter: `team_space_id=eq.${activeTeamId}` },
        bump,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "interventions", filter: `team_space_id=eq.${activeTeamId}` },
        bump,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "goals", filter: `team_space_id=eq.${activeTeamId}` },
        bump,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "field_objects", filter: `team_space_id=eq.${activeTeamId}` },
        bump,
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, activeTeamId, loadState, markUpdated]);

  const activeTeam = useMemo(
    () => teams.find((team) => team.id === activeTeamId) ?? null,
    [teams, activeTeamId],
  );
  const teamId = activeTeam?.id;

  const runSimulate = async () => {
    if (!teamId) return;
    setSimulating(true);
    try {
      const res = await authedFetch("/api/v2/simulate-teammate", {
        method: "POST",
        body: JSON.stringify({ teamId }),
      });
      if (res.ok) {
        const data = (await res.json()) as { state: LatticeState };
        if (data.state) setState(data.state);
      }
    } finally {
      setSimulating(false);
    }
  };

  const runSeed = async () => {
    if (!teamId) return;
    if (!confirm("This will wipe and reload demo data for this team. Continue?")) return;
    setSeeding(true);
    setLiveStatus("seeding demo story…");
    try {
      const res = await authedFetch("/api/v2/demo-seed", {
        method: "POST",
        body: JSON.stringify({ teamId, reset: true }),
      });
      if (res.ok) {
        const data = (await res.json()) as { state: LatticeState };
        if (data.state) setState(data.state);
        setLiveStatus("demo loaded");
        setTimeout(() => setLiveStatus("watching"), 2000);
      }
    } finally {
      setSeeding(false);
    }
  };

  const runAnalyze = async () => {
    if (!teamId) return;
    setAnalyzing(true);
    try {
      const res = await authedFetch("/api/v2/analyze", {
        method: "POST",
        body: JSON.stringify({ teamId }),
      });
      if (res.ok) {
        const data = (await res.json()) as { state: LatticeState };
        if (data.state) setState(data.state);
      }
    } finally {
      setAnalyzing(false);
    }
  };

  if (checkingAuth) {
    return (
      <div className="auth-wrap">
        <div className="muted small">Loading…</div>
      </div>
    );
  }

  if (!session) {
    return <AuthGate supabase={supabase} />;
  }

  if (needsTeam) {
    return (
      <FirstTeamGate
        authedFetch={authedFetch}
        onCreated={async () => {
          await loadTeams();
        }}
        onSignOut={() => supabase?.auth.signOut()}
        email={session.user.email ?? ""}
      />
    );
  }

  return (
    <div className="shell">
      <Topbar
        email={session.user.email ?? ""}
        isPlatformAdmin={isPlatformAdmin}
        onSignOut={() => supabase?.auth.signOut()}
        teams={teams}
        activeTeam={activeTeam}
        onSwitch={(t) => setActiveTeamId(t.id)}
        onCreate={() => setTeamPanel("create")}
        onManage={() => setTeamPanel("manage")}
        onAdmin={() => setAdminOpen(true)}
        onFeedback={() => setFeedbackOpen(true)}
        liveStatus={liveStatus}
        onSeed={runSeed}
        seeding={seeding}
      />

      <Tabs tab={tab} onChange={setTab} />

      {tab === "pulse" && (
        <PulseView
          state={state}
          onOpenComposer={() => setOrbKick((k) => k + 1)}
          authedFetch={authedFetch}
          teamId={teamId}
          onState={setState}
          onSimulate={runSimulate}
          onAnalyze={runAnalyze}
          simulating={simulating}
          analyzing={analyzing}
          updatedIds={updatedIds}
          orbKick={orbKick}
          chatPrefill={chatPrefill}
          onChatPrefill={(text) => setChatPrefill({ text, at: Date.now() })}
          activeTeam={activeTeam}
          members={members}
          onMembersChanged={async () => {
            if (!activeTeam) return;
            const res = await authedFetch(
              `/api/v2/teams/${encodeURIComponent(activeTeam.id)}/members`,
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              members?: { id: string; name: string; role: string; email?: string | null; skills?: string[]; focus?: string | null; bio?: string | null }[];
            };
            setMembers(data.members ?? []);
          }}
        />
      )}
      {tab === "timeline" && <TimelineView state={state} updatedIds={updatedIds} />}
      {tab === "interventions" && (
        <InterventionsView
          state={state}
          authedFetch={authedFetch}
          onRefresh={setState}
          teamId={teamId}
          updatedIds={updatedIds}
        />
      )}
      {tab === "commitments" && (
        <CommitmentsView
          state={state}
          authedFetch={authedFetch}
          teamId={teamId}
          onState={setState}
          updatedIds={updatedIds}
          activeTeam={activeTeam}
          members={members}
        />
      )}

      <VoiceDock
        onClick={() => {
          if (tab !== "pulse") setTab("pulse");
          setOrbKick((k) => k + 1);
        }}
      />

      {teamPanel === "create" && (
        <CreateTeamModal
          authedFetch={authedFetch}
          onClose={() => setTeamPanel("none")}
          onCreated={async (t) => {
            await loadTeams();
            setActiveTeamId(t.id);
            setTeamPanel("none");
          }}
        />
      )}

      {teamPanel === "manage" && activeTeam && (
        <ManageTeamModal
          authedFetch={authedFetch}
          team={activeTeam}
          state={state}
          onClose={() => setTeamPanel("none")}
        />
      )}

      {feedbackOpen && (
        <FeedbackModal
          authedFetch={authedFetch}
          userEmail={session.user.email ?? ""}
          onClose={() => setFeedbackOpen(false)}
        />
      )}

      {adminOpen && isPlatformAdmin && (
        <AdminDashboardModal
          authedFetch={authedFetch}
          onClose={() => setAdminOpen(false)}
        />
      )}

      {loading && !state.goals.length && <div className="muted small" style={{ textAlign: "center", marginTop: 20 }}>Loading state…</div>}
    </div>
  );
}

// ----------------------------------------------------------------------
// Topbar
// ----------------------------------------------------------------------

function Topbar({
  email,
  isPlatformAdmin,
  onSignOut,
  teams,
  activeTeam,
  onSwitch,
  onCreate,
  onManage,
  onAdmin,
  onFeedback,
  liveStatus,
  onSeed,
  seeding,
}: {
  email: string;
  isPlatformAdmin: boolean;
  onSignOut: () => void;
  teams: TeamSummary[];
  activeTeam: TeamSummary | null;
  onSwitch: (t: TeamSummary) => void;
  onCreate: () => void;
  onManage: () => void;
  onAdmin: () => void;
  onFeedback: () => void;
  liveStatus: string;
  onSeed: () => void;
  seeding: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-dot breathing" aria-hidden />
        Lattice
        <span className="live-status" aria-live="polite">{liveStatus}</span>
      </div>
      <div className="topbar-actions">
        {activeTeam?.role === "owner" && (
          <button className="btn-ghost small" onClick={onSeed} disabled={seeding} title="Wipe + load a rich demo story">
            {seeding ? "Loading…" : "Load demo"}
          </button>
        )}
        {isPlatformAdmin && (
          <button className="btn-ghost small" onClick={onAdmin}>
            Admin
          </button>
        )}
        <div className="team-switch" style={{ position: "relative" }}>
          <button className="btn-ghost small" onClick={() => setOpen((o) => !o)}>
            {activeTeam ? activeTeam.name : "No team"} ▾
          </button>
          {open && (
            <div
              className="team-menu"
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 4px)",
                background: "var(--bg)",
                border: "1px solid var(--line)",
                borderRadius: 10,
                padding: 6,
                minWidth: 220,
                maxWidth: "calc(100vw - 24px)",
                zIndex: 60,
                boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
              }}
              onMouseLeave={() => setOpen(false)}
            >
              {teams.map((t) => (
                <button
                  key={t.id}
                  className="btn-ghost small"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "6px 8px",
                    background: t.id === activeTeam?.id ? "var(--line-soft, #f5f4f1)" : "transparent",
                  }}
                  onClick={() => {
                    onSwitch(t);
                    setOpen(false);
                  }}
                >
                  <span>{t.name}</span>
                  <span className="muted small">{t.role}</span>
                </button>
              ))}
              <div style={{ borderTop: "1px solid var(--line)", margin: "6px 0" }} />
              <button
                className="btn-ghost small"
                style={{ width: "100%", textAlign: "left", padding: "6px 8px" }}
                onClick={() => {
                  onCreate();
                  setOpen(false);
                }}
              >
                + New team
              </button>
              {activeTeam && (
                <button
                  className="btn-ghost small"
                  style={{ width: "100%", textAlign: "left", padding: "6px 8px" }}
                  onClick={() => {
                    onManage();
                    setOpen(false);
                  }}
                >
                  Manage members & invites
                </button>
              )}
            </div>
          )}
        </div>
        <button className="btn-ghost small" onClick={onFeedback} title="Send platform feedback">
          Feedback
        </button>
        <span className="user small">{email}</span>
        <button className="btn-ghost small" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}

// First-run experience: no teams yet.
function FirstTeamGate({
  authedFetch,
  onCreated,
  onSignOut,
  email,
}: {
  authedFetch: AuthedFetch;
  onCreated: () => Promise<void> | void;
  onSignOut: () => void;
  email: string;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [token, setToken] = useState("");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authedFetch("/api/v2/teams", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setErr(data.error ?? "Failed.");
        return;
      }
      await onCreated();
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authedFetch("/api/v2/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setErr(data.error ?? "Invite not valid.");
        return;
      }
      await onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: 20 }}>
          <span className="brand-dot" aria-hidden /> Lattice
        </div>
        <h1>Start a team</h1>
        <p className="muted">Give it a name. You can invite people in a sec.</p>
        <form onSubmit={create} style={{ marginTop: 14 }}>
          <input
            type="text"
            placeholder="e.g. Growth pod, Core eng, Studio B"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button className="btn-primary" type="submit" disabled={busy}>
            Create team
          </button>
        </form>

        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0" }}>
          <div style={{ flex: 1, borderTop: "1px solid var(--line)" }} />
          <span className="muted small">or</span>
          <div style={{ flex: 1, borderTop: "1px solid var(--line)" }} />
        </div>

        <h3 style={{ margin: "0 0 6px" }}>Joining an existing team?</h3>
        <p className="muted small">Paste the invite token someone sent you.</p>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="invite token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn-ghost" disabled={busy || !token.trim()} onClick={accept}>
            Join
          </button>
        </div>

        {err && <div className="auth-error">{err}</div>}

        <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between" }}>
          <span className="muted small">{email}</span>
          <button className="btn-ghost small" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

// Create team modal (from within an existing session).
function CreateTeamModal({
  authedFetch,
  onClose,
  onCreated,
}: {
  authedFetch: AuthedFetch;
  onClose: () => void;
  onCreated: (t: TeamSummary) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authedFetch("/api/v2/teams", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = (await res.json()) as { team?: TeamSummary; error?: string };
      if (!res.ok || !data.team) {
        setErr(data.error ?? "Failed.");
        return;
      }
      await onCreated(data.team);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "min(420px, calc(100vw - 16px))" }}>
        <div className="sheet-head">
          <div className="title">New team</div>
          <button className="btn-ghost small" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-body">
          <form onSubmit={submit} className="stack" style={{ gap: 10 }}>
            <input
              type="text"
              placeholder="Team name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
            <div className="sheet-actions">
              <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>Create</button>
            </div>
          </form>
          {err && <div className="auth-error">{err}</div>}
        </div>
      </div>
    </div>
  );
}

// Manage members + invites modal.
type MemberRow = {
  id: string;
  userId: string;
  role: "owner" | "admin" | "member";
  name: string | null;
  email: string | null;
  skills?: string[];
  focus?: string | null;
  bio?: string | null;
};

type InviteRow = {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  state: string;
  token: string;
  expiresAt: string;
  createdAt: string;
};

type JoinRequestRow = {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  message?: string | null;
  state: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: string;
};

function ManageTeamModal({
  authedFetch,
  team,
  state,
  onClose,
}: {
  authedFetch: AuthedFetch;
  team: TeamSummary;
  state: LatticeState;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [joinRequests, setJoinRequests] = useState<JoinRequestRow[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);
  const [sendingDigest, setSendingDigest] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, i, r] = await Promise.all([
      authedFetch(`/api/v2/teams/${team.id}/members`),
      authedFetch(`/api/v2/teams/${team.id}/invites`),
      authedFetch(`/api/v2/teams/${team.id}/join-requests`),
    ]);
    if (m.ok) {
      const data = (await m.json()) as { members: MemberRow[] };
      setMembers(data.members ?? []);
    }
    if (i.ok) {
      const data = (await i.json()) as { invites: InviteRow[] };
      setInvites(data.invites ?? []);
    }
    if (r.ok) {
      const data = (await r.json()) as { requests: JoinRequestRow[] };
      setJoinRequests(data.requests ?? []);
    }
  }, [authedFetch, team.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const res = await authedFetch(`/api/v2/teams/${team.id}/invites`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const data = (await res.json()) as { invite?: InviteRow; error?: string };
      if (!res.ok) {
        setErr(data.error ?? "Invite failed.");
        return;
      }
      setEmail("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (id: string) => {
    setErr(null);
    setOk(null);
    await authedFetch(`/api/v2/teams/${team.id}/invites?inviteId=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await load();
  };

  const changeRole = async (memberId: string, nextRole: "owner" | "admin" | "member") => {
    setErr(null);
    setOk(null);
    await authedFetch(`/api/v2/teams/${team.id}/members`, {
      method: "PATCH",
      body: JSON.stringify({ memberId, role: nextRole }),
    });
    await load();
  };

  const removeMember = async (memberId: string) => {
    setErr(null);
    setOk(null);
    await authedFetch(`/api/v2/teams/${team.id}/members?memberId=${encodeURIComponent(memberId)}`, {
      method: "DELETE",
    });
    await load();
  };

  const reviewJoinRequest = async (joinRequestId: string, action: "approve" | "reject") => {
    setErr(null);
    setOk(null);
    const res = await authedFetch(`/api/v2/teams/${team.id}/join-requests`, {
      method: "PATCH",
      body: JSON.stringify({ joinRequestId, action }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setErr(data.error ?? "Failed to review join request.");
      return;
    }
    setOk(action === "approve" ? "Join request approved." : "Join request rejected.");
    await load();
  };

  const sendTaskDigest = async () => {
    setSendingDigest(true);
    setErr(null);
    setOk(null);
    try {
      const res = await authedFetch(`/api/v2/teams/${team.id}/digest`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        sent?: number;
        skipped?: number;
        error?: string;
      };
      if (!res.ok) {
        setErr(data.error ?? "Failed to send task emails.");
        return;
      }
      setOk(`Sent ${data.sent ?? 0} emails${data.skipped ? `, skipped ${data.skipped}` : ""}.`);
    } finally {
      setSendingDigest(false);
    }
  };

  const canAdmin = team.role === "owner" || team.role === "admin";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const joinLinkToken = team.joinToken ?? team.id;
  const joinLink = `${origin}/join/${joinLinkToken}`;

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "min(560px, calc(100vw - 16px))" }}>
        <div className="sheet-head">
          <div className="title">{team.name}</div>
          <button className="btn-ghost small" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-body">
          <h4>Members</h4>
          <div className="stack" style={{ gap: 8 }}>
            {members.map((m) => {
              const stats = m.name ? statsForMember(state, m.name) : null;
              return (
                <div
                  key={m.userId}
                  className="commitment"
                  style={{ gridTemplateColumns: "1fr auto" }}
                >
                  <div>
                    <div className="commitment-title">{m.name || m.email || m.userId}</div>
                    <div className="commitment-meta">
                      <span>{m.email}</span>
                      <span>· {m.role}</span>
                    </div>
                    {(m.skills?.length || m.focus) && (
                      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                        {(m.skills ?? []).slice(0, 6).map((s) => (
                          <span
                            key={s}
                            className="sample-chip"
                            style={{ cursor: "default", fontSize: 11 }}
                          >
                            {s}
                          </span>
                        ))}
                        {m.focus && (
                          <span className="small muted" style={{ alignSelf: "center" }}>
                            {m.focus}
                          </span>
                        )}
                      </div>
                    )}
                    {stats && (stats.completed > 0 || stats.openCount > 0) && (
                      <div className="small muted" style={{ marginTop: 2 }}>
                        {stats.completed} shipped
                        {stats.openCount ? ` · ${stats.openCount} open` : ""}
                        {stats.overdueCount ? ` · ${stats.overdueCount} overdue` : ""}
                        {stats.onTimeRate !== null
                          ? ` · ${Math.round(stats.onTimeRate * 100)}% on-time`
                          : ""}
                        {stats.avgDeliveryHours !== null
                          ? ` · ~${stats.avgDeliveryHours}h avg`
                          : ""}
                      </div>
                    )}
                  </div>
                  {canAdmin && (
                    <div className="row" style={{ gap: 6 }}>
                      <select
                        value={m.role}
                        onChange={(e) =>
                          changeRole(m.id, e.target.value as "owner" | "admin" | "member")
                        }
                        disabled={team.role !== "owner" && m.role === "owner"}
                      >
                        <option value="owner">owner</option>
                        <option value="admin">admin</option>
                        <option value="member">member</option>
                      </select>
                      <button className="btn-ghost small" onClick={() => removeMember(m.id)}>
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {canAdmin && (
            <>
              <h4 style={{ marginTop: 18 }}>Email task digest</h4>
              <p className="muted small" style={{ marginTop: 0 }}>
                Sends each teammate their currently assigned items plus a link back to the site.
              </p>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn-primary small"
                  onClick={() => void sendTaskDigest()}
                  disabled={sendingDigest}
                >
                  {sendingDigest ? "Sending…" : "Email everyone their tasks"}
                </button>
              </div>

              <h4 style={{ marginTop: 18 }}>Shareable join link</h4>
              <p className="muted small" style={{ marginTop: 0 }}>
                Anyone with this link can create an account, then request access for you to approve.
              </p>
              <div className="commitment" style={{ gridTemplateColumns: "1fr auto" }}>
                <div>
                  <div className="commitment-title">Join request link</div>
                  <div className="small muted" style={{ wordBreak: "break-all", marginTop: 4 }}>
                    {joinLink}
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn-ghost small"
                    onClick={() => navigator.clipboard?.writeText(joinLink)}
                  >
                    Copy link
                  </button>
                </div>
              </div>

              <h4 style={{ marginTop: 18 }}>Invite someone</h4>
              <form onSubmit={invite} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <input
                  type="email"
                  placeholder="teammate@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  style={{ flex: 1 }}
                />
                <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")}>
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
                <button type="submit" className="btn-primary small" disabled={busy}>
                  Send
                </button>
              </form>
            </>
          )}

          {canAdmin && joinRequests.length > 0 && (
            <>
              <h4 style={{ marginTop: 18 }}>Join requests</h4>
              <div className="stack" style={{ gap: 8 }}>
                {joinRequests.map((request) => (
                  <div key={request.id} className="commitment" style={{ gridTemplateColumns: "1fr auto" }}>
                    <div>
                      <div className="commitment-title">
                        {request.name || request.email || request.userId}
                      </div>
                      <div className="commitment-meta">
                        {request.email && <span>{request.email}</span>}
                        <span>· {request.state}</span>
                      </div>
                      {request.message && (
                        <div className="small muted" style={{ marginTop: 4 }}>
                          {request.message}
                        </div>
                      )}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        type="button"
                        className="btn-primary small"
                        onClick={() => void reviewJoinRequest(request.id, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn-ghost small"
                        onClick={() => void reviewJoinRequest(request.id, "reject")}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {err && <div className="auth-error">{err}</div>}
          {ok && <div className="auth-ok">{ok}</div>}

          {invites.length > 0 && (
            <>
              <h4 style={{ marginTop: 18 }}>Pending invites</h4>
              <div className="stack" style={{ gap: 8 }}>
                {invites.map((iv) => {
                  const link = `${origin}/invite/${iv.token}`;
                  return (
                    <div key={iv.id} className="commitment" style={{ gridTemplateColumns: "1fr auto" }}>
                      <div>
                        <div className="commitment-title">{iv.email}</div>
                        <div className="commitment-meta">
                          <span>{iv.role}</span>
                          <span>· {iv.state}</span>
                        </div>
                        <div className="small muted" style={{ wordBreak: "break-all", marginTop: 4 }}>
                          {link}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <button
                          className="btn-ghost small"
                          onClick={() => navigator.clipboard?.writeText(link)}
                        >
                          Copy link
                        </button>
                        {canAdmin && (
                          <button className="btn-ghost small" onClick={() => revokeInvite(iv.id)}>
                            Revoke
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Tabs
// ----------------------------------------------------------------------

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const items: { id: Tab; label: string }[] = [
    { id: "pulse", label: "Pulse" },
    { id: "timeline", label: "Timeline" },
    { id: "interventions", label: "Interventions" },
    { id: "commitments", label: "Commitments" },
  ];
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          role="tab"
          aria-selected={tab === item.id}
          className="tab"
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------
// Pulse (home)
// ----------------------------------------------------------------------

function PulseView({
  state,
  onOpenComposer,
  authedFetch,
  teamId,
  onState,
  onSimulate,
  onAnalyze,
  simulating,
  analyzing,
  updatedIds,
  orbKick,
  chatPrefill,
  onChatPrefill,
  activeTeam,
  members,
  onMembersChanged,
}: {
  state: LatticeState;
  onOpenComposer: () => void;
  authedFetch: AuthedFetch;
  teamId: string | undefined;
  onState: (s: LatticeState) => void;
  onSimulate: () => void;
  onAnalyze: () => void;
  simulating: boolean;
  analyzing: boolean;
  updatedIds: Set<string>;
  orbKick: number;
  chatPrefill: { text: string; at: number } | null;
  onChatPrefill: (text: string) => void;
  activeTeam: TeamSummary | null;
  members: { id: string; name: string; role: string; email?: string | null; skills?: string[]; focus?: string | null; bio?: string | null }[];
  onMembersChanged: () => Promise<void>;
}) {
  const myMember = activeTeam
    ? members.find(
        (m) => m.name.trim().toLowerCase() === activeTeam.memberName?.trim().toLowerCase(),
      )
    : undefined;
  const activeGoal = state.goals.find((g) => g.state === "active");
  const conf = teamConfidence(state);
  const atRisk = atRiskCount(state);
  const topInterventions = state.interventions
    .filter((i) => i.state === "suggested")
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 2);
  const recentChanges = state.changeEvents.slice(0, 5);
  const openBlockers = state.fieldObjects.filter((f) => f.type === "blocker").length;
  const [editingGoal, setEditingGoal] = useState(false);

  const saveGoal = async (title: string, detail: string) => {
    if (!teamId || !title.trim()) return;
    const res = await authedFetch("/api/v2/goal", {
      method: "POST",
      body: JSON.stringify({ title: title.trim(), detail: detail.trim() || undefined, teamId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { state: LatticeState };
      onState(data.state);
      setEditingGoal(false);
    }
  };

  return (
    <>
      <div className="hero">
        <div className="hero-eyebrow">What the team is trying to do</div>
        {editingGoal ? (
          <GoalEditor
            initialTitle={activeGoal?.title ?? ""}
            initialDetail={activeGoal?.detail ?? ""}
            onCancel={() => setEditingGoal(false)}
            onSave={saveGoal}
          />
        ) : (
          <>
            <h1 className="hero-goal">
              {activeGoal?.title ?? state.intent ?? "No goal set yet."}
            </h1>
            {activeGoal?.detail && <p className="hero-detail">{activeGoal.detail}</p>}
            {activeGoal && (
              <ConfidenceSparkline
                signals={state.confidenceSignals.filter(
                  (s) => s.targetType === "goal" && s.targetId === activeGoal.id,
                )}
                current={conf}
              />
            )}
          </>
        )}
        <div className="hero-actions">
          <button className="btn-primary" onClick={onOpenComposer}>
            Give an update
          </button>
          {!editingGoal && (
            <button className="btn-ghost" onClick={() => setEditingGoal(true)}>
              {activeGoal ? "Edit goal" : "Set goal"}
            </button>
          )}
        </div>
      </div>

      <StatusBar conf={conf} atRisk={atRisk} openBlockers={openBlockers} />

      {teamId && (
        <MyProfile
          authedFetch={authedFetch}
          teamId={teamId}
          me={myMember}
          state={state}
          onSaved={onMembersChanged}
        />
      )}

      <MorningBrief authedFetch={authedFetch} teamId={teamId} />

      <Nudges authedFetch={authedFetch} teamId={teamId} onReply={onChatPrefill} />

      <LatticeChat
        authedFetch={authedFetch}
        teamId={teamId}
        onState={onState}
        orbKick={orbKick}
        prefill={chatPrefill}
      />

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What changed</h2>
          <span className="section-meta">{state.changeEvents.length} updates</span>
        </div>
        {recentChanges.length === 0 ? (
          <div className="empty">Nothing logged yet. Tap the orb and tell Lattice what&apos;s happening.</div>
        ) : (
          <div className="timeline">
            {recentChanges.map((ev) => (
              <TimelineItem key={ev.id} ev={ev} flash={updatedIds.has(ev.id)} />
            ))}
          </div>
        )}
      </section>

      {topInterventions.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">What to do next</h2>
            <span className="section-meta">Suggested</span>
          </div>
          <div className="intervention-list">
            {topInterventions.map((iv) => (
              <div key={iv.id} className={`intervention ${iv.urgency >= 4 ? "urgent" : ""}`}>
                <div>
                  <div className="intervention-title">
                    {iv.title}
                    <span className={`urgency-pill u-${iv.urgency}`}>
                      {iv.urgency >= 4 ? "High" : iv.urgency >= 3 ? "Medium" : "Low"}
                    </span>
                  </div>
                  <div className="intervention-rationale">{iv.rationale}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {state.tensions.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Open tensions</h2>
          </div>
          <div className="stack">
            {state.tensions.slice(0, 3).map((t, i) => (
              <div key={i} className="commitment" style={{ gridTemplateColumns: "1fr" }}>
                <div className="commitment-title">{t}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function GoalEditor({
  initialTitle,
  initialDetail,
  onCancel,
  onSave,
}: {
  initialTitle: string;
  initialDetail: string;
  onCancel: () => void;
  onSave: (title: string, detail: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [detail, setDetail] = useState(initialDetail);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onSave(title, detail);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What's the team trying to achieve?"
        style={{ fontSize: 20, fontFamily: "var(--font-serif, serif)" }}
      />
      <textarea
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder="Any context — why it matters, what success looks like."
        rows={2}
      />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn-ghost small" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-primary small" disabled={busy || !title.trim()} onClick={submit}>
          {busy ? "Saving…" : "Save goal"}
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Timeline (Plan vs Reality)
// ----------------------------------------------------------------------

function TimelineView({ state, updatedIds }: { state: LatticeState; updatedIds: Set<string> }) {
  const drift = goalDrift(state);
  const analysis = structuralAnalysis(state);
  const activeGoal = state.goals.find((g) => g.state === "active");
  const previousGoal = activeGoal?.previousGoalId
    ? state.goals.find((g) => g.id === activeGoal.previousGoalId)
    : null;

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Plan vs reality</h2>
          <span className="section-meta">Where the team drifted</span>
        </div>
        <div className="pvr">
          <div className="pvr-row">
            <div className="pvr-col">
              <h4>What we said</h4>
              {previousGoal ? (
                <div className="pvr-item pvr-strike">{previousGoal.title}</div>
              ) : (
                <div className="pvr-item muted">No earlier goal on record</div>
              )}
              {drift.driftingCommitments.length === 0 && activeGoal && (
                <div className="pvr-item muted small">
                  Everything still points at the current goal.
                </div>
              )}
              {drift.driftingCommitments.map((f) => (
                <div key={f.id} className="pvr-item pvr-strike">
                  {f.title}
                </div>
              ))}
            </div>
            <div className="pvr-col">
              <h4>What&apos;s actually happening</h4>
              <div className="pvr-item">
                <strong>{activeGoal?.title ?? state.intent ?? "No goal set"}</strong>
                {activeGoal?.detail && (
                  <div className="muted small" style={{ marginTop: 4 }}>
                    {activeGoal.detail}
                  </div>
                )}
              </div>
              <div className="pvr-item muted small">
                {drift.alignedCount} aligned commitment{drift.alignedCount === 1 ? "" : "s"}
                {drift.driftingCommitments.length > 0
                  ? ` · ${drift.driftingCommitments.length} drifting`
                  : ""}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Everything that&apos;s shifted</h2>
          <span className="section-meta">
            {state.changeEvents.length} total
          </span>
        </div>
        {state.changeEvents.length === 0 ? (
          <div className="empty">No changes recorded yet.</div>
        ) : (
          <div className="timeline">
            {state.changeEvents.map((ev) => (
              <TimelineItem key={ev.id} ev={ev} detailed flash={updatedIds.has(ev.id)} />
            ))}
          </div>
        )}
      </section>

      {analysis.totalBlockers > 1 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Patterns worth noticing</h2>
          </div>
          <div className="stack">
            {analysis.overloaded.map((o) => (
              <div key={o.owner} className="commitment" style={{ gridTemplateColumns: "1fr" }}>
                <div>
                  <div className="commitment-title">{o.owner} is carrying {o.count} blockers</div>
                  <div className="commitment-meta">Probably worth pairing or redistributing.</div>
                </div>
              </div>
            ))}
            {analysis.recurring.slice(0, 3).map((r) => (
              <div key={r.token} className="commitment" style={{ gridTemplateColumns: "1fr" }}>
                <div>
                  <div className="commitment-title">
                    <span className="mono">{r.token}</span> keeps coming up
                  </div>
                  <div className="commitment-meta">
                    Appears in {r.count} blockers — might be a deeper problem.
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function TimelineItem({ ev, detailed, flash }: { ev: ChangeEvent; detailed?: boolean; flash?: boolean }) {
  const accent = accentForChangeKind(ev.kind);
  return (
    <div className={`timeline-item${flash ? " just-updated" : ""}`}>
      <div className={`timeline-glyph ${accent}`}>{glyphForChangeKind(ev.kind)}</div>
      <div className="timeline-body">
        <div className="timeline-kind">{labelForChangeKind(ev.kind)}</div>
        <div className="timeline-summary">{ev.summary}</div>
        {detailed && ev.detail && <div className="timeline-detail">{ev.detail}</div>}
        {detailed && ev.impact?.teamReadable && (
          <div className="timeline-detail">↳ {ev.impact.teamReadable}</div>
        )}
      </div>
      <div className="timeline-time">{formatRelative(ev.createdAt)}</div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Interventions
// ----------------------------------------------------------------------

function InterventionsView({
  state,
  authedFetch,
  onRefresh,
  teamId,
  updatedIds,
}: {
  state: LatticeState;
  authedFetch: AuthedFetch;
  onRefresh: (next: LatticeState) => void;
  teamId: string | undefined;
  updatedIds: Set<string>;
}) {
  const suggested = state.interventions
    .filter((i) => i.state === "suggested")
    .sort((a, b) => b.urgency - a.urgency);
  const handled = state.interventions.filter((i) => i.state !== "suggested").slice(0, 10);

  const patch = async (id: string, next: InterventionState) => {
    const res = await authedFetch("/api/v2/intervention", {
      method: "PATCH",
      body: JSON.stringify({ id, state: next, teamId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { state: LatticeState };
      if (data.state) onRefresh(data.state);
    }
  };

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What to do next</h2>
          <span className="section-meta">{suggested.length} open</span>
        </div>
        {suggested.length === 0 ? (
          <div className="empty">Nothing urgent. Things will show up here as state shifts.</div>
        ) : (
          <div className="intervention-list">
            {suggested.map((iv) => (
              <InterventionCard key={iv.id} iv={iv} onPatch={patch} flash={updatedIds.has(iv.id)} />
            ))}
          </div>
        )}
      </section>

      {handled.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Already handled</h2>
          </div>
          <div className="intervention-list">
            {handled.map((iv) => (
              <div key={iv.id} className="intervention" style={{ opacity: 0.7 }}>
                <div>
                  <div className="intervention-title">
                    {iv.title}
                    <span className="urgency-pill">{iv.state}</span>
                  </div>
                  <div className="intervention-rationale">{iv.rationale}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function InterventionCard({
  iv,
  onPatch,
  flash,
}: {
  iv: Intervention;
  onPatch: (id: string, state: InterventionState) => Promise<void>;
  flash?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const doPatch = async (next: InterventionState) => {
    setBusy(true);
    try {
      await onPatch(iv.id, next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`intervention ${iv.urgency >= 4 ? "urgent" : ""}${flash ? " just-updated" : ""}`}>
      <div>
        <div className="intervention-title">
          {iv.title}
          <span className={`urgency-pill u-${iv.urgency}`}>
            {iv.urgency >= 4 ? "High" : iv.urgency >= 3 ? "Medium" : "Low"}
          </span>
        </div>
        <div className="intervention-rationale">{iv.rationale}</div>
      </div>
      <div className="intervention-actions">
        <button className="btn-ghost small" disabled={busy} onClick={() => doPatch("dismissed")}>
          Dismiss
        </button>
        <button className="btn-primary small" disabled={busy} onClick={() => doPatch("acted")}>
          Mark acted
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Commitments
// ----------------------------------------------------------------------

function CommitmentsView({
  state,
  authedFetch,
  teamId,
  onState,
  updatedIds,
  activeTeam,
  members,
}: {
  state: LatticeState;
  authedFetch: AuthedFetch;
  teamId: string | undefined;
  onState: (s: LatticeState) => void;
  updatedIds: Set<string>;
  activeTeam: TeamSummary | null;
  members: { id: string; name: string; role: string; email?: string | null; skills?: string[]; focus?: string | null; bio?: string | null }[];
}) {
  const canMutate = (f: FieldObject): boolean => {
    if (!activeTeam) return false;
    if (activeTeam.role === "owner" || activeTeam.role === "admin") return true;
    if (!f.owner || !activeTeam.memberName) return false;
    return f.owner.trim().toLowerCase() === activeTeam.memberName.trim().toLowerCase();
  };
  const reassign = async (id: string, owner: string | null) => {
    const res = await authedFetch("/api/v2/commitment", {
      method: "PATCH",
      body: JSON.stringify({ id, action: "set_owner", owner, teamId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { state: LatticeState };
      if (data.state) onState(data.state);
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      alert(data.error ?? "Reassign failed.");
    }
  };
  const act = async (id: string, action: "complete" | "resolve" | "drop") => {
    const res = await authedFetch("/api/v2/commitment", {
      method: "PATCH",
      body: JSON.stringify({ id, action, teamId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { state: LatticeState };
      if (data.state) onState(data.state);
    }
  };
  const setDue = async (id: string, dueAt: string | null) => {
    const res = await authedFetch("/api/v2/commitment", {
      method: "PATCH",
      body: JSON.stringify({ id, action: "set_due", dueAt, teamId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { state: LatticeState };
      if (data.state) onState(data.state);
    }
  };
  const respond = async (
    id: string,
    mode: "decline" | "defer" | "scope_change",
    reason: string,
    deferredUntil?: string | null,
  ) => {
    const res = await authedFetch("/api/v2/commitment", {
      method: "PATCH",
      body: JSON.stringify({
        id,
        action: mode,
        reason,
        deferredUntil: deferredUntil ?? null,
        teamId,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { state: LatticeState };
      if (data.state) onState(data.state);
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      alert(data.error ?? "Update failed.");
    }
  };
  const grouped = useMemo(() => {
    const order: FieldObjectType[] = ["promise", "blocker", "request", "reminder", "shift", "signal"];
    const byType = new Map<FieldObjectType, FieldObject[]>();
    for (const f of state.fieldObjects) {
      if (!byType.has(f.type)) byType.set(f.type, []);
      byType.get(f.type)!.push(f);
    }
    // Sort promises/blockers by urgency: overdue first, then soonest due, then undated last.
    const urgencyScore = (f: FieldObject): number => {
      if (f.status === "done" || f.status === "dropped" || f.status === "resolved") return 1e15;
      if (!f.dueAt) return 1e14;
      const t = Date.parse(f.dueAt);
      return Number.isFinite(t) ? t : 1e14;
    };
    for (const [, items] of byType) {
      items.sort((a, b) => urgencyScore(a) - urgencyScore(b));
    }
    return order
      .map((t) => ({ type: t, items: byType.get(t) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [state.fieldObjects]);

  if (grouped.length === 0) {
    return (
      <section className="section">
        <div className="empty">Nothing here yet. Tell Lattice what you&apos;re working on.</div>
      </section>
    );
  }

  return (
    <>
      {grouped.map((g) => (
        <section className="section" key={g.type}>
          <div className="section-head">
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <h2 className="section-title" style={{ margin: 0 }}>
                {labelForType(g.type)}
              </h2>
              <TypeInfoButton type={g.type} />
            </div>
            <span className="section-meta">{g.items.length}</span>
          </div>
          <div className="commitment-list">
            {g.items.map((f) => (
              <CommitmentRow
                key={f.id}
                f={f}
                onAct={act}
                onReassign={reassign}
                onSetDue={setDue}
                onRespond={respond}
                flash={updatedIds.has(f.id)}
                canMutate={canMutate(f)}
                currentMemberName={activeTeam?.memberName ?? null}
                members={members}
              />
            ))}
          </div>
        </section>
      ))}

      {state.assumptions.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Things we&apos;re assuming</h2>
            <span className="section-meta">{state.assumptions.length}</span>
          </div>
          <div className="commitment-list">
            {state.assumptions.map((a) => (
              <div key={a.id} className="commitment">
                <div>
                  <div className="commitment-title">{a.statement}</div>
                  <div className="commitment-meta">
                    <span className={`commitment-type ${a.state === "at_risk" || a.state === "invalidated" ? "blocker" : ""}`}>
                      {a.state.replace("_", " ")}
                    </span>
                    {a.tiedTo && <span>tied to {a.tiedTo}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function CommitmentRow({
  f,
  onAct,
  onReassign,
  onSetDue,
  onRespond,
  flash,
  canMutate = true,
  currentMemberName,
  members = [],
}: {
  f: FieldObject;
  onAct: (id: string, action: "complete" | "resolve" | "drop") => Promise<void>;
  onReassign?: (id: string, owner: string | null) => Promise<void>;
  onSetDue?: (id: string, dueAt: string | null) => Promise<void>;
  onRespond?: (
    id: string,
    mode: "decline" | "defer" | "scope_change",
    reason: string,
    deferredUntil?: string | null,
  ) => Promise<void>;
  flash?: boolean;
  canMutate?: boolean;
  currentMemberName?: string | null;
  members?: { id: string; name: string; role: string; email?: string | null; skills?: string[]; focus?: string | null; bio?: string | null }[];
}) {
  const confClass = f.confidence < 0.4 ? "low" : f.confidence < 0.7 ? "mid" : "";
  const [busy, setBusy] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [respondOpen, setRespondOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const closed = f.status === "done" || f.status === "resolved" || f.status === "dropped";
  const ownedByMe = Boolean(
    canMutate &&
      currentMemberName &&
      f.owner &&
      f.owner.trim().toLowerCase() === currentMemberName.trim().toLowerCase(),
  );
  const dueMeta = fmtDueMeta(f.dueAt);
  const deferredActive = (() => {
    if (!f.deferredUntil) return null;
    const t = Date.parse(f.deferredUntil);
    return Number.isFinite(t) && t > Date.now() ? new Date(t) : null;
  })();
  const click = async (action: "complete" | "resolve" | "drop") => {
    setBusy(true);
    try {
      await onAct(f.id, action);
    } finally {
      setBusy(false);
    }
  };
  const pickOwner = async (name: string | null) => {
    if (!onReassign) return;
    setOwnerOpen(false);
    setBusy(true);
    try {
      await onReassign(f.id, name);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`commitment${flash ? " just-updated" : ""}`} style={closed ? { opacity: 0.55 } : undefined}>
      <div>
        <div className="commitment-title">{f.title}</div>
        <div className="commitment-meta" style={{ position: "relative" }}>
          <span
            className={`commitment-type ${f.type}`}
            title={typeDescription(f.type)}
            style={{ cursor: "help" }}
          >
            {labelForType(f.type)}
          </span>
          {onReassign && canMutate && !closed ? (
            <button
              type="button"
              className="btn-ghost small"
              onClick={() => setOwnerOpen((o) => !o)}
              disabled={busy}
              style={{
                padding: "0 6px",
                borderRadius: 6,
                fontSize: "inherit",
                color: f.owner ? undefined : "var(--muted)",
              }}
              title="Reassign"
            >
              {f.owner ?? "unassigned"} ▾
            </button>
          ) : (
            f.owner && <span>{f.owner}</span>
          )}
          {ownedByMe && <span className="muted">· assigned to you</span>}
          {f.status && <span>· {f.status}</span>}
          {dueMeta && (
            <span
              className={dueMeta.late ? "warn" : undefined}
              title={f.dueAt ? new Date(f.dueAt).toLocaleString() : undefined}
            >
              · {dueMeta.label}
            </span>
          )}
          {deferredActive && (
            <span className="muted" title={f.declineReason ?? undefined}>
              · deferred until {deferredActive.toLocaleDateString()}
            </span>
          )}
          {f.declineReason && !deferredActive && f.status === "dropped" && (
            <span className="muted" title={f.declineReason}>
              · declined
            </span>
          )}
          {ownerOpen && (
            <div
              onMouseLeave={() => setOwnerOpen(false)}
              style={{
                position: "absolute",
                top: "100%",
                left: 60,
                marginTop: 4,
                background: "var(--bg)",
                border: "1px solid var(--line)",
                borderRadius: 10,
                padding: 4,
                minWidth: 180,
                maxWidth: "calc(100vw - 24px)",
                zIndex: 30,
                boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
              }}
            >
              {members.length === 0 && (
                <div
                  className="small muted"
                  style={{ padding: "6px 10px" }}
                >
                  No team members loaded.
                </div>
              )}
              {members.map((m) => {
                const isCurrent =
                  f.owner?.trim().toLowerCase() === m.name.trim().toLowerCase();
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="btn-ghost small"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      width: "100%",
                      padding: "6px 10px",
                      background: isCurrent ? "var(--line-soft, #f5f4f1)" : "transparent",
                      textAlign: "left",
                      gap: 10,
                    }}
                    disabled={isCurrent}
                    onClick={() => void pickOwner(m.name)}
                    title={m.email ?? undefined}
                  >
                    <span
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        minWidth: 0,
                      }}
                    >
                      <span>{m.name}</span>
                      {m.email && (
                        <span
                          className="muted small"
                          style={{
                            fontSize: 11,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 200,
                          }}
                        >
                          {m.email}
                        </span>
                      )}
                    </span>
                    <span className="muted small">{m.role}</span>
                  </button>
                );
              })}
              {f.owner && (
                <>
                  <div style={{ borderTop: "1px solid var(--line)", margin: "4px 0" }} />
                  <button
                    type="button"
                    className="btn-ghost small"
                    style={{ width: "100%", textAlign: "left", padding: "6px 10px" }}
                    onClick={() => void pickOwner(null)}
                  >
                    Unassign
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <div className="small muted" title="Lattice's confidence this commitment will land">
          {Math.round(f.confidence * 100)}% conf
        </div>
        <div className="conf-bar" title="Confidence, not progress">
          <div className={`fill ${confClass}`} style={{ width: `${f.confidence * 100}%` }} />
        </div>
        {!closed && canMutate && (f.type === "promise" || f.type === "request") && (
          <>
            {ownedByMe ? (
              <>
                <button className="btn-ghost small" disabled={busy} onClick={() => click("complete")}>
                  Done
                </button>
                {onRespond && (
                  <button
                    className="btn-ghost small"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void onRespond(f.id, "decline", "Can't do it from my side").finally(() =>
                        setBusy(false),
                      );
                    }}
                    title="Mark this as something you can't take on"
                  >
                    Can&apos;t do
                  </button>
                )}
              </>
            ) : (
              <button className="btn-ghost small" disabled={busy} onClick={() => click("complete")}>
                Done
              </button>
            )}
          </>
        )}
        {!closed && canMutate && f.type === "blocker" && (
          <button className="btn-ghost small" disabled={busy} onClick={() => click("resolve")}>
            Resolved
          </button>
        )}
        {!closed && canMutate && onSetDue && (
          <div style={{ position: "relative" }}>
            <button
              className="btn-ghost small"
              disabled={busy}
              onClick={() => setDueOpen((o) => !o)}
              title="Set or clear the due date"
            >
              {f.dueAt ? "Due…" : "Set due"}
            </button>
            {dueOpen && (
              <DuePicker
                current={f.dueAt}
                onPick={async (iso) => {
                  setDueOpen(false);
                  setBusy(true);
                  try {
                    await onSetDue(f.id, iso);
                  } finally {
                    setBusy(false);
                  }
                }}
                onClose={() => setDueOpen(false)}
              />
            )}
          </div>
        )}
        {!closed && canMutate && onRespond && !ownedByMe && (f.type === "promise" || f.type === "request") && (
          <div style={{ position: "relative" }}>
            <button
              className="btn-ghost small"
              disabled={busy}
              onClick={() => setRespondOpen((o) => !o)}
              title="Respond: can't do it, plan changed, or defer"
            >
              Can&apos;t do
            </button>
            {respondOpen && (
              <RespondPopover
                onClose={() => setRespondOpen(false)}
                onSubmit={async (mode, reason, until) => {
                  setRespondOpen(false);
                  setBusy(true);
                  try {
                    await onRespond(f.id, mode, reason, until ?? null);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )}
          </div>
        )}
        {!closed && canMutate && (
          <button className="btn-ghost small" disabled={busy} onClick={() => click("drop")}>
            Drop
          </button>
        )}
      </div>
    </div>
  );
}

function fmtDueMeta(dueAt?: string): { label: string; late: boolean } | null {
  if (!dueAt) return null;
  const t = Date.parse(dueAt);
  if (!Number.isFinite(t)) return null;
  const diffMs = t - Date.now();
  const diffH = diffMs / 36e5;
  if (diffH < -1) {
    const d = Math.round(-diffH / 24);
    return { label: d >= 1 ? `${d}d late` : `${Math.round(-diffH)}h late`, late: true };
  }
  if (diffH < 24) {
    if (diffH < 1) return { label: "due soon", late: false };
    return { label: `due in ${Math.round(diffH)}h`, late: diffH < 6 };
  }
  const days = Math.round(diffH / 24);
  return { label: `due in ${days}d`, late: false };
}

function futureDateInput(daysFromNow: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

function DuePicker({
  current,
  onPick,
  onClose,
}: {
  current?: string;
  onPick: (iso: string | null) => void;
  onClose: () => void;
}) {
  const defaultDate = current
    ? new Date(current).toISOString().slice(0, 10)
    : futureDateInput(1);
  const [date, setDate] = useState(defaultDate);
  const quick = [
    { label: "Today", days: 0 },
    { label: "Tomorrow", days: 1 },
    { label: "Friday", days: (5 - new Date().getDay() + 7) % 7 || 7 },
    { label: "Next week", days: 7 },
  ];
  const apply = () => {
    const [y, m, d] = date.split("-").map(Number);
    const iso = new Date(Date.UTC(y, m - 1, d, 23, 59)).toISOString();
    onPick(iso);
  };
  return (
    <div
      onMouseLeave={onClose}
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 4,
        background: "var(--bg)",
        border: "1px solid var(--line)",
        borderRadius: 10,
        padding: 10,
        zIndex: 30,
        minWidth: 220,
        maxWidth: "calc(100vw - 24px)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
      }}
    >
      <div className="small muted" style={{ marginBottom: 6 }}>
        Due date
      </div>
      <div className="row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            className="sample-chip"
            onClick={() => {
              const iso = new Date(
                Date.now() + q.days * 86_400_000,
              );
              iso.setHours(23, 59, 0, 0);
              onPick(iso.toISOString());
            }}
          >
            {q.label}
          </button>
        ))}
      </div>
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        style={{ width: "100%" }}
      />
      <div className="row" style={{ gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
        {current && (
          <button type="button" className="btn-ghost small" onClick={() => onPick(null)}>
            Clear
          </button>
        )}
        <button type="button" className="btn-primary small" onClick={apply}>
          Save
        </button>
      </div>
    </div>
  );
}

function RespondPopover({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (
    mode: "decline" | "defer" | "scope_change",
    reason: string,
    until?: string,
  ) => Promise<void>;
}) {
  const [mode, setMode] = useState<"decline" | "defer" | "scope_change">("defer");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState(() => futureDateInput(3));
  const submit = async () => {
    if (mode === "defer") {
      const [y, m, d] = until.split("-").map(Number);
      const iso = new Date(Date.UTC(y, m - 1, d, 23, 59)).toISOString();
      await onSubmit("defer", reason, iso);
    } else {
      await onSubmit(mode, reason);
    }
  };
  return (
    <div
      onMouseLeave={onClose}
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 4,
        background: "var(--bg)",
        border: "1px solid var(--line)",
        borderRadius: 10,
        padding: 12,
        zIndex: 30,
        minWidth: 280,
        maxWidth: "calc(100vw - 24px)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
      }}
    >
      <div className="stack" style={{ gap: 8 }}>
        <label className="row" style={{ gap: 6, alignItems: "center" }}>
          <input
            type="radio"
            name="respond-mode"
            checked={mode === "defer"}
            onChange={() => setMode("defer")}
          />
          <span>Busy — defer until</span>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            disabled={mode !== "defer"}
            style={{ flex: 1, marginLeft: 4 }}
          />
        </label>
        <label className="row" style={{ gap: 6, alignItems: "center" }}>
          <input
            type="radio"
            name="respond-mode"
            checked={mode === "scope_change"}
            onChange={() => setMode("scope_change")}
          />
          <span>Plan changed</span>
        </label>
        <label className="row" style={{ gap: 6, alignItems: "center" }}>
          <input
            type="radio"
            name="respond-mode"
            checked={mode === "decline"}
            onChange={() => setMode("decline")}
          />
          <span>Can&apos;t do it at all</span>
        </label>
        <textarea
          placeholder="Reason (optional — helps the team understand)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
        />
        <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
          <button type="button" className="btn-ghost small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary small" onClick={submit}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// Morning brief: what changed, what's at risk, what needs a decision.
// Profile is always editable — no edit toggle. Fields save on blur so the
// user just types and moves on. Status chip next to the section title shows
// saving / saved / error without modal drama.
function MyProfile({
  authedFetch,
  teamId,
  me,
  state,
  onSaved,
}: {
  authedFetch: AuthedFetch;
  teamId: string;
  me?: {
    id: string;
    name: string;
    role: string;
    skills?: string[];
    focus?: string | null;
    bio?: string | null;
  };
  state: LatticeState;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me?.name ?? "");
  const [skillsText, setSkillsText] = useState((me?.skills ?? []).join(", "));
  const [focus, setFocus] = useState(me?.focus ?? "");
  const [bio, setBio] = useState(me?.bio ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  // Canonical strings used for dirty-check — avoids firing saves when blur
  // happens on an unchanged field.
  const canonicalName = me?.name ?? "";
  const canonicalSkills = (me?.skills ?? []).join(", ");
  const canonicalFocus = me?.focus ?? "";
  const canonicalBio = me?.bio ?? "";

  // Re-sync local state when the remote profile changes (e.g. after save).
  useEffect(() => {
    setName(canonicalName);
  }, [canonicalName]);
  useEffect(() => {
    setSkillsText(canonicalSkills);
  }, [canonicalSkills]);
  useEffect(() => {
    setFocus(canonicalFocus);
  }, [canonicalFocus]);
  useEffect(() => {
    setBio(canonicalBio);
  }, [canonicalBio]);

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const stats = me ? statsForMember(state, me.name) : null;

  const persist = async (payload: {
    name?: string;
    skills?: string[];
    focus?: string | null;
    bio?: string | null;
  }) => {
    setStatus("saving");
    setErr(null);
    try {
      const res = await authedFetch(
        `/api/v2/teams/${encodeURIComponent(teamId)}/members/profile`,
        {
          method: "PATCH",
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(data.error ?? "Could not save.");
        setStatus("error");
        return;
      }
      await onSaved();
      setStatus("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setStatus("idle"), 1600);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save.");
      setStatus("error");
    }
  };

  const saveNameIfDirty = () => {
    const trimmed = name.trim();
    if (trimmed === canonicalName) return;
    if (!trimmed) {
      // Refuse to save an empty name — names own commitments, empty is broken.
      setErr("Name can't be empty.");
      setStatus("error");
      setName(canonicalName);
      return;
    }
    void persist({ name: trimmed });
  };

  const saveSkillsIfDirty = () => {
    if (skillsText === canonicalSkills) return;
    const skills = skillsText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    void persist({ skills });
  };

  const saveFocusIfDirty = () => {
    if (focus === canonicalFocus) return;
    void persist({ focus: focus.trim() || null });
  };

  const saveBioIfDirty = () => {
    if (bio === canonicalBio) return;
    void persist({ bio: bio.trim() || null });
  };

  if (!me) return null;

  const hasProfile = (me.skills?.length ?? 0) > 0 || !!me.focus || !!me.bio;

  const statusChip =
    status === "saving" ? (
      <span className="small muted">saving…</span>
    ) : status === "saved" ? (
      <span className="small muted">saved</span>
    ) : status === "error" && err ? (
      <span className="small" style={{ color: "#b4451e" }}>{err}</span>
    ) : null;

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Your profile</h2>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          {stats && (stats.completed > 0 || stats.openCount > 0) && (
            <span className="small muted" title="Based on your history in this team">
              {stats.completed} shipped
              {stats.openCount ? ` · ${stats.openCount} open` : ""}
              {stats.overdueCount ? ` · ${stats.overdueCount} overdue` : ""}
              {stats.onTimeRate !== null
                ? ` · ${Math.round(stats.onTimeRate * 100)}% on-time`
                : ""}
            </span>
          )}
          {statusChip}
          <button
            type="button"
            className="btn-ghost small"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Done" : hasProfile ? "Edit profile" : "Add profile"}
          </button>
        </div>
      </div>

      {!editing && hasProfile && (
        <div className="stack" style={{ gap: 6 }}>
          {(me.skills?.length ?? 0) > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {me.skills!.map((s) => (
                <span key={s} className="sample-chip" style={{ cursor: "default" }}>
                  {s}
                </span>
              ))}
            </div>
          )}
          {me.focus && (
            <div className="small muted">
              <strong style={{ color: "var(--ink, inherit)" }}>Focus:</strong> {me.focus}
            </div>
          )}
          {me.bio && <div className="small muted">{me.bio}</div>}
        </div>
      )}

      {editing && (
        <div className="stack" style={{ gap: 8 }}>
          <label className="stack" style={{ gap: 4 }}>
            <span className="small muted">Display name (how the team sees you in commitments)</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveNameIfDirty}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Your name"
              autoFocus
            />
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="small muted">Skills (comma-separated)</span>
            <input
              type="text"
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
              onBlur={saveSkillsIfDirty}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="frontend, design, infra, go, customer calls"
            />
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="small muted">Focus — the kind of work you usually take</span>
            <input
              type="text"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              onBlur={saveFocusIfDirty}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Backend services and data pipelines"
            />
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="small muted">Notes (optional)</span>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              onBlur={saveBioIfDirty}
              placeholder="Fast on prototyping, slow on polish. Out Thursdays."
              rows={2}
            />
          </label>
        </div>
      )}
    </section>
  );
}

// Compact risk strip — just the two dots. Confidence lives in the sparkline
// above, so we don't double-render it here.
function StatusBar({
  atRisk,
  openBlockers,
}: {
  conf: number;
  atRisk: number;
  openBlockers: number;
}) {
  const qualitative =
    atRisk === 0 && openBlockers === 0
      ? "all clear"
      : openBlockers > 0
      ? "needs attention"
      : "watching";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        margin: "6px 0 18px",
        padding: "0 2px",
        fontSize: 13,
        flexWrap: "wrap",
      }}
    >
      <StatusDot
        label="at risk"
        count={atRisk}
        active={atRisk > 0}
        activeColor="#9a7a1a"
      />
      <StatusDot
        label={openBlockers === 1 ? "blocker" : "blockers"}
        count={openBlockers}
        active={openBlockers > 0}
        activeColor="#b4451e"
      />
      <span className="small muted" title="Overall team state">
        · {qualitative}
      </span>
    </div>
  );
}

function StatusDot({
  label,
  count,
  active,
  activeColor,
}: {
  label: string;
  count: number;
  active: boolean;
  activeColor: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: active ? activeColor : "var(--muted)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: active ? activeColor : "var(--line, #d6d2c8)",
          display: "inline-block",
        }}
      />
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: active ? 600 : 400 }}>
        {count}
      </span>
      <span className="small" style={{ color: "inherit" }}>
        {label}
      </span>
    </span>
  );
}

function MorningBrief({
  authedFetch,
  teamId,
}: {
  authedFetch: AuthedFetch;
  teamId: string | undefined;
}) {
  type Brief = { changed: string[]; atRisk: string[]; needsDecision: string[] };
  const [brief, setBrief] = useState<Brief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch("/api/v2/brief", {
        method: "POST",
        body: JSON.stringify({ teamId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not load brief.");
        return;
      }
      const data = (await res.json()) as { brief: Brief; generatedAt: string };
      setBrief(data.brief);
      setGeneratedAt(data.generatedAt);
    } catch {
      setError("Could not load brief.");
    } finally {
      setBusy(false);
    }
  }, [authedFetch, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const empty =
    brief !== null &&
    brief.changed.length === 0 &&
    brief.atRisk.length === 0 &&
    brief.needsDecision.length === 0;

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Morning brief</h2>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          {generatedAt && (
            <span className="section-meta" title={generatedAt}>
              {formatRelative(generatedAt)}
            </span>
          )}
          <button className="btn-ghost small" onClick={() => void load()} disabled={busy || !teamId}>
            {busy ? "…" : "Refresh"}
          </button>
        </div>
      </div>
      {error && <div className="empty">{error}</div>}
      {!error && brief === null && !busy && (
        <div className="empty">Pulling the last few days together…</div>
      )}
      {!error && empty && (
        <div className="empty">Quiet — nothing new worth flagging in the last few days.</div>
      )}
      {!error && brief && !empty && (
        <div className="stack" style={{ gap: 10 }}>
          <BriefColumn label="What changed" items={brief.changed} accent="neutral" />
          <BriefColumn label="What's at risk" items={brief.atRisk} accent="warn" />
          <BriefColumn label="Needs a decision" items={brief.needsDecision} accent="accent" />
        </div>
      )}
    </section>
  );
}

function BriefColumn({
  label,
  items,
  accent,
}: {
  label: string;
  items: string[];
  accent: "neutral" | "warn" | "accent";
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className={`small muted`} style={{ marginBottom: 4 }}>
        {label}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.45 }}>
        {items.map((it, i) => (
          <li
            key={i}
            className={accent === "warn" ? "warn" : accent === "accent" ? "accent" : undefined}
          >
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Check-ins Lattice would send out on its own. Derived live from state.
function Nudges({
  authedFetch,
  teamId,
  onReply,
}: {
  authedFetch: AuthedFetch;
  teamId: string | undefined;
  onReply: (text: string) => void;
}) {
  type Nudge = {
    id: string;
    kind: string;
    person: string;
    prompt: string;
    reason: string;
    urgency: 1 | 2 | 3;
  };
  const [nudges, setNudges] = useState<Nudge[] | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!teamId) return;
    setBusy(true);
    try {
      const res = await authedFetch(`/api/v2/nudges?team=${encodeURIComponent(teamId)}`);
      if (!res.ok) {
        setNudges([]);
        return;
      }
      const data = (await res.json()) as { nudges?: Nudge[] };
      setNudges(data.nudges ?? []);
    } catch {
      setNudges([]);
    } finally {
      setBusy(false);
    }
  }, [authedFetch, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (nudges ?? []).filter((n) => !dismissed.has(n.id));

  if (nudges === null && busy) return null;
  if (visible.length === 0) return null;

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Needs a check-in</h2>
        <span className="section-meta">{visible.length}</span>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {visible.slice(0, 5).map((n) => (
          <div
            key={n.id}
            className="commitment"
            style={{ gridTemplateColumns: "1fr auto", alignItems: "center" }}
          >
            <div>
              <div className="commitment-title">{n.prompt}</div>
              <div className="commitment-meta">
                <span className={`urgency-pill u-${n.urgency}`}>
                  {n.urgency >= 3 ? "High" : n.urgency === 2 ? "Medium" : "Low"}
                </span>
                <span>{n.person}</span>
                <span>· {n.reason}</span>
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="btn-ghost small"
                onClick={() => onReply(n.prompt)}
                title="Send this to the chat so you can reply"
              >
                Reply
              </button>
              <button
                className="btn-ghost small"
                onClick={() =>
                  setDismissed((prev) => {
                    const next = new Set(prev);
                    next.add(n.id);
                    return next;
                  })
                }
                title="Hide this for now"
              >
                Snooze
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Single entry point: ask Lattice OR tell Lattice. One input, one thread.
// Classifies intent — questions go to /api/v2/ask, statements to /api/v2/interpret
// and land as real state (blockers, commitments, etc.). The floating orb pipes
// voice into the same thread via `orbKick`.
function LatticeChat({
  authedFetch,
  teamId,
  onState,
  orbKick,
  prefill,
}: {
  authedFetch: AuthedFetch;
  teamId: string | undefined;
  onState: (s: LatticeState) => void;
  orbKick: number;
  prefill: { text: string; at: number } | null;
}) {
  type Turn = { role: "user" | "assistant"; content: string; kind?: "ask" | "update" };
  const MAX_TURNS = 6;
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const samples = [
    "What's a signal vs a shift?",
    "What am I forgetting?",
    "Blocked on auth — need Priya today.",
    "Who's overloaded?",
    "How does this app work?",
  ];

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  // Classify: questions go to ask, everything else is logged as state.
  const looksLikeQuestion = (text: string): boolean => {
    const t = text.trim();
    if (!t) return false;
    if (t.endsWith("?")) return true;
    const first = t.split(/\s+/)[0]?.toLowerCase() ?? "";
    const qStarters = new Set([
      "what", "who", "when", "where", "why", "how", "which",
      "is", "are", "am", "do", "does", "did", "can", "could",
      "should", "would", "will", "was", "were", "have", "has",
    ]);
    return qStarters.has(first);
  };

  const runAsk = async (text: string, history: Turn[]) => {
    const res = await authedFetch("/api/v2/ask", {
      method: "POST",
      body: JSON.stringify({
        query: text,
        teamId,
        history: history.map((t) => ({ role: t.role, content: t.content })),
      }),
    });
    // Read as text first so we can still surface the failure when the platform
    // returns HTML (Vercel 504/404 etc.) instead of the JSON envelope.
    const raw = await res.text();
    let data: { answer?: string; error?: string; stage?: string; upstreamStatus?: number } = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      return `Ask failed (HTTP ${res.status}): ${raw.slice(0, 200) || "no response body"}`;
    }
    if (!res.ok || data.error) {
      const parts = [
        `Ask failed (HTTP ${res.status}${data.upstreamStatus ? ` / upstream ${data.upstreamStatus}` : ""})`,
        data.stage ? `stage=${data.stage}` : null,
        data.error ?? null,
      ].filter(Boolean);
      return parts.join(" · ");
    }
    return data.answer ?? "No answer.";
  };

  const runUpdate = async (text: string) => {
    const res = await authedFetch("/api/v2/interpret", {
      method: "POST",
      body: JSON.stringify({ input: text, apply: true, teamId }),
    });
    const data = (await res.json()) as
      | { interpretation: InterpretationV2; state: LatticeState }
      | { error: string };
    if ("error" in data) return data.error;
    if (data.state) onState(data.state);
    const reply = data.interpretation.reply || "Logged.";
    const recorded = data.interpretation.richReply?.recorded ?? [];
    return recorded.length > 0 ? `${reply}\n\n· ${recorded.slice(0, 3).join("\n· ")}` : reply;
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !teamId || busy) return;
    setBusy(true);
    setStatus(null);
    setQ("");
    const kind: "ask" | "update" = looksLikeQuestion(trimmed) ? "ask" : "update";
    const userTurn: Turn = { role: "user", content: trimmed, kind };
    const history = turns.slice(-MAX_TURNS);
    setTurns((prev) => [...prev, userTurn]);
    try {
      const answer =
        kind === "ask" ? await runAsk(trimmed, history) : await runUpdate(trimmed);
      setTurns((prev) => [...prev, { role: "assistant", content: answer, kind }]);
    } catch (e) {
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: e instanceof Error ? e.message : "Something went wrong.",
          kind,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const startRecord = useCallback(async () => {
    if (recording || busy) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        // Use the recorder's actual mimeType — Safari produces audio/mp4, not webm.
        // Hardcoding "audio/webm" is how we end up with OpenAI rejecting the file.
        const mime = recorder.mimeType || "audio/webm";
        const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
        const blob = new Blob(chunksRef.current, { type: mime });
        const form = new FormData();
        form.append("audio", blob, `update.${ext}`);
        setStatus(`Transcribing… (${mime}, ${Math.round(blob.size / 1024)} KB)`);
        try {
          const res = await authedFetch("/api/transcribe", { method: "POST", body: form });
          const raw = await res.text();
          let data: { text?: string; error?: string; upstreamStatus?: number; file?: { type?: string; size?: number }; model?: string } = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            setStatus(`Transcription failed (HTTP ${res.status}): ${raw.slice(0, 200) || "no body"}`);
            return;
          }
          if (!res.ok || data.error) {
            const parts = [
              `Transcription failed (HTTP ${res.status}${data.upstreamStatus ? `/upstream ${data.upstreamStatus}` : ""})`,
              data.file ? `sent: ${data.file.type ?? "?"} ${Math.round((data.file.size ?? 0) / 1024)}KB` : null,
              data.model ? `model: ${data.model}` : null,
              data.error ?? null,
            ].filter(Boolean);
            setStatus(parts.join(" · "));
            return;
          }
          setStatus(null);
          if (data.text) await send(data.text);
          else setStatus("Nothing was transcribed — try again.");
        } catch (e) {
          setStatus(e instanceof Error ? e.message : "Transcription failed.");
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setStatus("Recording — tap mic again to stop.");
    } catch {
      setStatus("Microphone unavailable.");
    }
    // send is intentionally not in deps — we want the latest closure at stop time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authedFetch, recording, busy]);

  const stopRecord = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
  }, []);

  // Floating orb click → focus chat + start recording.
  useEffect(() => {
    if (orbKick === 0) return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    inputRef.current?.focus();
    if (!recording) void startRecord();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbKick]);

  // External prefill (e.g. "Reply" on a nudge) → drop it into the input.
  useEffect(() => {
    if (!prefill) return;
    setQ(prefill.text);
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    inputRef.current?.focus();
  }, [prefill]);

  const reset = () => {
    setTurns([]);
    setQ("");
    setStatus(null);
  };

  const visibleTurns = turns.slice(-MAX_TURNS);

  return (
    <section ref={sectionRef} className="section ask-section">
      <div className="ask-box">
        <div className="section-head" style={{ marginBottom: 8 }}>
          <h2 className="section-title">Talk to Lattice</h2>
          <span className="section-meta">Ask a question, or just tell it what&apos;s happening.</span>
        </div>
        {visibleTurns.length > 0 && (
          <div
            ref={threadRef}
            className="ask-thread"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              maxHeight: 320,
              overflowY: "auto",
              marginBottom: 10,
              padding: "4px 2px",
            }}
          >
            {visibleTurns.map((t, i) => (
              <div
                key={i}
                className={`ask-turn ${t.role}`}
                style={{
                  alignSelf: t.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "8px 12px",
                  borderRadius: 12,
                  background: t.role === "user" ? "var(--line-soft, #f5f4f1)" : "transparent",
                  border: t.role === "assistant" ? "1px solid var(--line)" : "none",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.45,
                }}
              >
                {t.role === "user" && t.kind === "update" && (
                  <div className="small muted" style={{ marginBottom: 2 }}>
                    logged as update
                  </div>
                )}
                {t.content}
              </div>
            ))}
            {busy && (
              <div
                className="ask-turn assistant thinking"
                style={{ alignSelf: "flex-start", padding: "8px 12px" }}
              >
                <span className="dot" /> <span className="dot" /> <span className="dot" />
              </div>
            )}
          </div>
        )}
        {status && (
          <div className="small muted" style={{ marginBottom: 6 }}>
            {status}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(q);
          }}
          className="ask-form"
        >
          <button
            type="button"
            className={`voice-orb ${recording ? "recording" : ""}`}
            onClick={recording ? stopRecord : startRecord}
            aria-label={recording ? "Stop recording" : "Start recording"}
            style={{ width: 36, height: 36, flex: "0 0 auto" }}
            disabled={busy && !recording}
          >
            <span className="voice-dot" />
          </button>
          <input
            ref={inputRef}
            className="ask-input"
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              visibleTurns.length === 0
                ? "Ask Lattice — or just tell it what's happening."
                : "Follow up, or log another update…"
            }
          />
          <button type="submit" className="btn-primary small" disabled={busy || !q.trim()}>
            {busy ? "…" : "Send"}
          </button>
          {turns.length > 0 && (
            <button
              type="button"
              className="btn-ghost small ask-form__new"
              onClick={reset}
              disabled={busy}
              title="Start a fresh conversation"
            >
              New
            </button>
          )}
        </form>
        {visibleTurns.length === 0 && (
          <div className="ask-samples">
            {samples.map((s) => (
              <button
                key={s}
                type="button"
                className="sample-chip"
                onClick={() => void send(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// Confidence sparkline — rendered under the active goal.
function ConfidenceSparkline({
  signals,
  current,
}: {
  signals: { createdAt: string; confidence: number }[];
  current: number;
}) {
  const points = useMemo(() => {
    const sorted = [...signals].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    const vals = sorted.map((s) => s.confidence);
    if (vals.length < 2) {
      // Fabricate a flat baseline so there's always something to show.
      return vals.length === 1 ? [vals[0], current] : [current, current];
    }
    return vals;
  }, [signals, current]);

  const w = 160;
  const h = 28;
  const last = points[points.length - 1] ?? current;
  const color = last < 0.5 ? "var(--warn)" : last < 0.75 ? "var(--warm)" : "var(--accent)";
  const d = points
    .map((v, i) => {
      const x = (i / Math.max(1, points.length - 1)) * w;
      const y = h - v * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="sparkline" title="Goal confidence over time">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        <circle
          cx={w}
          cy={h - last * h}
          r={2.4}
          fill={color}
        />
      </svg>
      <span className="sparkline-label">{Math.round(last * 100)}% confidence</span>
    </div>
  );
}

function labelForType(t: FieldObjectType): string {
  const map: Record<FieldObjectType, string> = {
    intent: "Intent",
    promise: "Commitments",
    blocker: "Blockers",
    request: "Requests",
    reminder: "Reminders",
    shift: "Shifts",
    signal: "Signals",
  };
  return map[t];
}

function typeDescription(t: FieldObjectType): string {
  const map: Record<FieldObjectType, string> = {
    intent: "What the team is trying to do — a direction, not a task.",
    promise: "A concrete thing someone agreed to deliver — has an owner, optional due date, and a confidence.",
    blocker: "Something stopping progress. Open until resolved or dropped.",
    request: "An ask from one person to another, not yet accepted. States: draft, sent, acknowledged, resolved, denied.",
    reminder: "A self-nudge tied to a time or trigger. Not a commitment to anyone else.",
    shift: "A direction change or scope pivot — a signal that what the team was doing has changed.",
    signal: "A weak observation worth remembering but not yet actionable.",
  };
  return map[t];
}

function typeExample(t: FieldObjectType): string {
  const map: Record<FieldObjectType, string> = {
    intent: "Ship a demo people trust by Friday.",
    promise: "Demo video — know2, due Fri, 80% confidence.",
    blocker: "Vendor API is down — Priya.",
    request: "Ask legal to review the data policy.",
    reminder: "Remind me at 8pm to retry the deploy.",
    shift: "Dropping analytics this week — focus is the demo.",
    signal: "Legal has been quiet for two weeks.",
  };
  return map[t];
}

function TypeInfoButton({ type }: { type: FieldObjectType }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`What is a ${labelForType(type).toLowerCase().replace(/s$/, "")}?`}
        title="What is this?"
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: "1px solid var(--line)",
          background: "transparent",
          color: "var(--muted)",
          fontSize: 11,
          fontStyle: "italic",
          fontFamily: "serif",
          lineHeight: "16px",
          padding: 0,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        i
      </button>
      {open && (
        <div
          onMouseLeave={() => setOpen(false)}
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: "min(260px, calc(100vw - 24px))",
            maxWidth: 340,
            background: "var(--bg)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            padding: 10,
            zIndex: 20,
            boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontSize: 13 }}>{typeDescription(type)}</div>
          <div className="small muted" style={{ marginTop: 6, fontStyle: "italic" }}>
            e.g. “{typeExample(type)}”
          </div>
        </div>
      )}
    </span>
  );
}

// ----------------------------------------------------------------------
// Voice dock (floating)
// ----------------------------------------------------------------------

function VoiceDock({ onClick }: { onClick: () => void }) {
  return (
    <div className="voice-dock">
      <button className="voice-orb" aria-label="Log an update" onClick={onClick}>
        <span className="voice-dot" />
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------
// Composer sheet (voice + text + rich reply)
// ----------------------------------------------------------------------

function ComposerSheet({
  onClose,
  authedFetch,
  onApplied,
  teamId,
}: {
  onClose: () => void;
  authedFetch: AuthedFetch;
  onApplied: (next: LatticeState) => void;
  teamId: string | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("Hit the orb to talk, or type below.");
  const [recording, setRecording] = useState(false);
  const [interpretation, setInterpretation] = useState<InterpretationV2 | null>(null);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const runInterpret = useCallback(
    async (input: string, apply: boolean) => {
      if (!input.trim()) return;
      setBusy(true);
      setStatus(apply ? "Applying…" : "Interpreting…");
      try {
        const res = await authedFetch("/api/v2/interpret", {
          method: "POST",
          body: JSON.stringify({ input, apply, teamId }),
        });
        const data = (await res.json()) as
          | { interpretation: InterpretationV2; state: LatticeState }
          | { error: string };
        if ("error" in data) {
          setStatus(data.error);
          return;
        }
        setInterpretation(data.interpretation);
        if (apply) {
          onApplied(data.state);
        } else {
          setStatus("Preview ready — apply or edit.");
        }
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Interpretation failed.");
      } finally {
        setBusy(false);
      }
    },
    [authedFetch, onApplied, teamId],
  );

  const startRecord = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = recorder.mimeType || "audio/webm";
        const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
        const blob = new Blob(chunksRef.current, { type: mime });
        const form = new FormData();
        form.append("audio", blob, `update.${ext}`);
        setStatus(`Transcribing… (${mime}, ${Math.round(blob.size / 1024)} KB)`);
        try {
          const res = await authedFetch("/api/transcribe", { method: "POST", body: form });
          const raw = await res.text();
          let data: { text?: string; error?: string; upstreamStatus?: number; file?: { type?: string; size?: number }; model?: string } = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            setStatus(`Transcription failed (HTTP ${res.status}): ${raw.slice(0, 200) || "no body"}`);
            return;
          }
          if (!res.ok || data.error) {
            const parts = [
              `Transcription failed (HTTP ${res.status}${data.upstreamStatus ? `/upstream ${data.upstreamStatus}` : ""})`,
              data.file ? `sent: ${data.file.type ?? "?"} ${Math.round((data.file.size ?? 0) / 1024)}KB` : null,
              data.error ?? null,
            ].filter(Boolean);
            setStatus(parts.join(" · "));
            return;
          }
          if (data.text) {
            setDraft(data.text);
            await runInterpret(data.text, false);
          }
        } catch (e) {
          setStatus(e instanceof Error ? e.message : "Transcription failed.");
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setStatus("Recording… tap again to stop.");
    } catch {
      setStatus("Microphone unavailable.");
    }
  }, [authedFetch, runInterpret]);

  const stopRecord = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await runInterpret(draft, false);
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="title">What&apos;s happening?</div>
          <button className="btn-ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body">
          <div className="row" style={{ gap: 14 }}>
            <button
              className={`voice-orb ${recording ? "recording" : ""}`}
              onClick={recording ? stopRecord : startRecord}
              aria-label={recording ? "Stop recording" : "Start recording"}
              style={{ width: 56, height: 56, flex: "0 0 auto" }}
            >
              <span className="voice-dot" />
            </button>
            <div className="stack" style={{ flex: 1, gap: 6 }}>
              <div className="small muted">{status}</div>
              <form onSubmit={onSubmit} className="stack" style={{ gap: 8 }}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Say it like you&apos;d say it in standup. Blockers, progress, changes — whatever."
                />
              </form>
            </div>
          </div>

          <div className="sheet-samples" style={{ marginTop: 14 }}>
            {SAMPLES.map((s) => (
              <button
                key={s}
                type="button"
                className="sample-chip"
                onClick={() => setDraft(s)}
              >
                {s.slice(0, 60)}…
              </button>
            ))}
          </div>

          <div className="sheet-actions">
            <button className="btn-ghost" disabled={busy || !draft.trim()} onClick={() => runInterpret(draft, false)}>
              Preview
            </button>
            <button
              className="btn-primary"
              disabled={busy || !draft.trim()}
              onClick={() => runInterpret(draft, true)}
            >
              Log & apply
            </button>
          </div>

          {interpretation && <RichReply interpretation={interpretation} />}
        </div>
      </div>
    </div>
  );
}

function RichReply({ interpretation }: { interpretation: InterpretationV2 }) {
  const r = interpretation.richReply;
  return (
    <div className="rich-reply">
      <div className="rich-reply-head">{r?.headline ?? interpretation.reply}</div>

      {r?.recorded && r.recorded.length > 0 && (
        <>
          <h4>Recorded</h4>
          <ul>
            {r.recorded.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </>
      )}

      {interpretation.changes.length > 0 && (
        <>
          <h4>Detected changes</h4>
          <div>
            {interpretation.changes.map((c, i) => (
              <span key={i} className="change-preview-row">
                <span className="mono">{glyphForChangeKind(c.kind)}</span>
                {c.summary}
              </span>
            ))}
          </div>
        </>
      )}

      {r?.implications && r.implications.length > 0 && (
        <>
          <h4>Implications</h4>
          <ul>
            {r.implications.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </>
      )}

      {r?.suggested && r.suggested.length > 0 && (
        <>
          <h4>Suggested next</h4>
          <ul>
            {r.suggested.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </>
      )}

      {interpretation.followUpQuestion && (
        <div className="follow-up">{interpretation.followUpQuestion}</div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Auth gate
// ----------------------------------------------------------------------

function AuthGate({ supabase }: { supabase: ReturnType<typeof createSupabaseBrowserClient> }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setErr(null);
    setOk(null);
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setErr(error.message);
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name } },
        });
        if (error) {
          setErr(error.message);
        } else if (data.session) {
          // Email confirmation is off — Supabase returned a session directly.
          setOk("Account ready.");
        } else {
          // No session came back. Either email confirmation is still on in
          // Supabase, or the project returns a user-without-session response.
          // Try an explicit sign-in; if that fails with "Email not confirmed",
          // the dashboard toggle didn't save.
          const signIn = await supabase.auth.signInWithPassword({ email, password });
          if (signIn.error) {
            setErr(
              signIn.error.message.toLowerCase().includes("confirm")
                ? "Supabase still requires email confirmation. Turn it off in Authentication → Sign In / Providers → Email → Confirm email."
                : signIn.error.message,
            );
          } else {
            setOk("Account ready.");
          }
        }
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: 20 }}>
          <span className="brand-dot" aria-hidden /> Lattice
        </div>
        <h1>Know what&apos;s actually going on.</h1>
        <p className="muted">Talk to Lattice like you&apos;d talk to a teammate. It keeps the rest of the team in sync.</p>

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
          <button className="btn-primary" type="submit" disabled={loading}>
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        {err && <div className="auth-error">{err}</div>}
        {ok && <div className="auth-ok">{ok}</div>}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Feedback
// ----------------------------------------------------------------------

type FeedbackItem = {
  id: string;
  userId: string;
  email: string | null;
  message: string;
  createdAt: string;
};

type AdminOverview = {
  generatedAt: string;
  overview: {
    teams: number;
    memberRows: number;
    uniqueUsers: number;
    updatesLast14d: number;
    openPromises: number;
    blockers: number;
    avgHealthScore: number;
    avgConfidence: number;
    pendingInvites: number;
    teamsAtRisk: number;
    feedbackCount: number;
  };
  activity14d: { day: string; updates: number }[];
  interventionStates: {
    suggested: number;
    accepted: number;
    acted: number;
    dismissed: number;
  };
  healthDistribution: {
    healthy: number;
    watch: number;
    "at-risk": number;
    critical: number;
  };
  teamSnapshots: Array<{
    id: string;
    name: string;
    activeIntent: string;
    memberCount: number;
    ownerCount: number;
    adminCount: number;
    openPromises: number;
    blockers: number;
    atRiskPromises: number;
    avgConfidence: number;
    recentChanges7d: number;
    suggestedInterventions: number;
    acceptedInterventions: number;
    actedInterventions: number;
    pendingInvites: number;
    healthScore: number;
    healthStatus: "healthy" | "watch" | "at-risk" | "critical";
    activeGoal: { title: string; confidence: number } | null;
    lastActivityAt: string | null;
  }>;
  recentActivity: Array<{
    teamId: string;
    teamName: string;
    kind: string;
    summary: string;
    createdAt: string;
  }>;
  recentFeedback: Array<{
    id: string;
    email: string | null;
    message: string;
    createdAt: string;
  }>;
};

function healthTone(status: AdminOverview["teamSnapshots"][number]["healthStatus"]) {
  if (status === "critical") return { label: "Critical", fg: "#8a2f16", bg: "#fde6dc" };
  if (status === "at-risk") return { label: "At risk", fg: "#9a5b09", bg: "#fff0cc" };
  if (status === "watch") return { label: "Watch", fg: "#355b73", bg: "#e5f0f8" };
  return { label: "Healthy", fg: "#22604a", bg: "#dff5ea" };
}

function AdminDashboardModal({
  authedFetch,
  onClose,
}: {
  authedFetch: AuthedFetch;
  onClose: () => void;
}) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await authedFetch("/api/v2/admin/overview");
      const payload = (await res.json().catch(() => ({}))) as AdminOverview & { error?: string };
      if (!res.ok) {
        setErr(payload.error ?? "Failed to load admin dashboard.");
        return;
      }
      setData(payload);
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxActivity = Math.max(...(data?.activity14d.map((item) => item.updates) ?? [1]), 1);
  const healthTotal = data
    ? Object.values(data.healthDistribution).reduce((sum, count) => sum + count, 0)
    : 0;
  const interventionTotal = data
    ? Object.values(data.interventionStates).reduce((sum, count) => sum + count, 0)
    : 0;

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "min(1120px, calc(100vw - 16px))", maxHeight: "calc(100vh - 24px)" }}
      >
        <div className="sheet-head">
          <div>
            <div className="title">Admin dashboard</div>
            {data?.generatedAt && (
              <div className="muted small">Updated {formatRelative(data.generatedAt)}</div>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn-ghost small" onClick={() => void load()} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button className="btn-ghost small" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="sheet-body" style={{ overflow: "auto" }}>
          {err && <div className="auth-error">{err}</div>}
          {!err && !data && loading && <div className="muted small">Loading platform analytics…</div>}

          {data && (
            <div className="stack" style={{ gap: 16 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: 10,
                }}
              >
                <AdminKpi label="Teams" value={String(data.overview.teams)} note={`${data.overview.teamsAtRisk} need attention`} />
                <AdminKpi label="People" value={String(data.overview.uniqueUsers)} note={`${data.overview.memberRows} memberships`} />
                <AdminKpi label="Updates" value={String(data.overview.updatesLast14d)} note="last 14 days" />
                <AdminKpi label="Open work" value={String(data.overview.openPromises)} note={`${data.overview.blockers} blockers`} />
                <AdminKpi label="Health" value={`${data.overview.avgHealthScore}`} note={`${Math.round(data.overview.avgConfidence * 100)}% confidence`} />
                <AdminKpi label="Invites" value={String(data.overview.pendingInvites)} note={`${data.overview.feedbackCount} feedback notes`} />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1.5fr) minmax(280px, 0.9fr)",
                  gap: 12,
                }}
              >
                <section className="section" style={{ margin: 0 }}>
                  <div className="section-head">
                    <h2 className="section-title">Activity trend</h2>
                    <span className="section-meta">Change events per day</span>
                  </div>
                  <svg viewBox="0 0 640 220" style={{ width: "100%", height: 220, display: "block" }}>
                    <line x1="28" y1="184" x2="620" y2="184" stroke="var(--line)" strokeWidth="1" />
                    {data.activity14d.map((item, index) => {
                      const x = 40 + index * 42;
                      const barHeight = Math.max(6, (item.updates / maxActivity) * 126);
                      const y = 184 - barHeight;
                      const label = item.day.slice(5);
                      return (
                        <g key={item.day}>
                          <rect x={x} y={y} width="24" height={barHeight} rx="8" fill="#355b73" opacity="0.88" />
                          <text x={x + 12} y={198} textAnchor="middle" fontSize="10" fill="var(--muted)">
                            {label}
                          </text>
                          <text x={x + 12} y={y - 8} textAnchor="middle" fontSize="10" fill="#355b73">
                            {item.updates}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </section>

                <section className="section" style={{ margin: 0 }}>
                  <div className="section-head">
                    <h2 className="section-title">Health mix</h2>
                    <span className="section-meta">Across all teams</span>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                      gap: 6,
                      marginBottom: 12,
                    }}
                  >
                    {[
                      ["healthy", "#2d7c61"],
                      ["watch", "#3f6f8f"],
                      ["at-risk", "#c98311"],
                      ["critical", "#c4512d"],
                    ].map(([key, color]) => {
                      const count = data.healthDistribution[key as keyof typeof data.healthDistribution];
                      const width = healthTotal ? (count / healthTotal) * 100 : 0;
                      return (
                        <div key={key}>
                          <div className="small muted" style={{ marginBottom: 4, textTransform: "capitalize" }}>
                            {key}
                          </div>
                          <div
                            style={{
                              height: 10,
                              borderRadius: 999,
                              background: "var(--line-soft, #f2f1ee)",
                              overflow: "hidden",
                            }}
                          >
                            <div style={{ width: `${width}%`, height: "100%", background: color }} />
                          </div>
                          <div style={{ marginTop: 6, fontWeight: 600 }}>{count}</div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="small muted" style={{ marginBottom: 8 }}>
                    Intervention pipeline
                  </div>
                  <div className="stack" style={{ gap: 8 }}>
                    {[
                      ["suggested", "#768fa3"],
                      ["accepted", "#4a7b68"],
                      ["acted", "#2d7c61"],
                      ["dismissed", "#a0745b"],
                    ].map(([key, color]) => {
                      const count = data.interventionStates[key as keyof typeof data.interventionStates];
                      const width = interventionTotal ? (count / interventionTotal) * 100 : 0;
                      return (
                        <div key={key}>
                          <div
                            className="small"
                            style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}
                          >
                            <span style={{ textTransform: "capitalize" }}>{key}</span>
                            <span className="muted">{count}</span>
                          </div>
                          <div
                            style={{
                              height: 10,
                              borderRadius: 999,
                              background: "var(--line-soft, #f2f1ee)",
                              overflow: "hidden",
                            }}
                          >
                            <div style={{ width: `${width}%`, height: "100%", background: color }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>

              <section className="section" style={{ margin: 0 }}>
                <div className="section-head">
                  <h2 className="section-title">Team watchlist</h2>
                  <span className="section-meta">Lowest health first</span>
                </div>
                <div className="stack" style={{ gap: 10 }}>
                  {data.teamSnapshots.map((team) => {
                    const tone = healthTone(team.healthStatus);
                    return (
                      <div
                        key={team.id}
                        style={{
                          border: "1px solid var(--line)",
                          borderRadius: 14,
                          padding: 12,
                          background: "var(--bg)",
                        }}
                      >
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(0, 1.6fr) minmax(280px, 1fr)",
                            gap: 14,
                            alignItems: "start",
                          }}
                        >
                          <div>
                            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                              <div>
                                <div style={{ fontWeight: 700 }}>{team.name}</div>
                                <div className="small muted" style={{ marginTop: 2 }}>
                                  {team.activeGoal?.title ?? team.activeIntent}
                                </div>
                              </div>
                              <span
                                className="small"
                                style={{
                                  background: tone.bg,
                                  color: tone.fg,
                                  borderRadius: 999,
                                  padding: "4px 8px",
                                  fontWeight: 700,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {tone.label}
                              </span>
                            </div>
                            <div
                              style={{
                                marginTop: 10,
                                height: 10,
                                borderRadius: 999,
                                background: "var(--line-soft, #f2f1ee)",
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  width: `${team.healthScore}%`,
                                  height: "100%",
                                  background:
                                    team.healthStatus === "critical"
                                      ? "#c4512d"
                                      : team.healthStatus === "at-risk"
                                        ? "#c98311"
                                        : team.healthStatus === "watch"
                                          ? "#4f7c9a"
                                          : "#2d7c61",
                                }}
                              />
                            </div>
                            <div className="small muted" style={{ marginTop: 8 }}>
                              Score {team.healthScore} · {team.recentChanges7d} updates in 7d
                              {team.lastActivityAt ? ` · active ${formatRelative(team.lastActivityAt)}` : ""}
                            </div>
                          </div>

                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                              gap: 10,
                            }}
                          >
                            <AdminMetric label="Members" value={String(team.memberCount)} />
                            <AdminMetric label="Open work" value={String(team.openPromises)} />
                            <AdminMetric label="Blockers" value={String(team.blockers)} />
                            <AdminMetric label="At risk" value={String(team.atRiskPromises)} />
                            <AdminMetric label="Confidence" value={`${Math.round(team.avgConfidence * 100)}%`} />
                            <AdminMetric label="Pending invites" value={String(team.pendingInvites)} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)",
                  gap: 12,
                }}
              >
                <section className="section" style={{ margin: 0 }}>
                  <div className="section-head">
                    <h2 className="section-title">Recent activity</h2>
                    <span className="section-meta">Across the platform</span>
                  </div>
                  <div className="timeline">
                    {data.recentActivity.map((item) => (
                      <div key={`${item.teamId}-${item.createdAt}-${item.summary}`} className="timeline-item">
                        <div className="timeline-glyph">•</div>
                        <div className="timeline-body">
                          <div className="timeline-title">{item.summary}</div>
                          <div className="timeline-meta">
                            <span>{item.teamName}</span>
                            <span>· {item.kind.replaceAll("_", " ")}</span>
                            <span>· {formatRelative(item.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="section" style={{ margin: 0 }}>
                  <div className="section-head">
                    <h2 className="section-title">Feedback inbox</h2>
                    <span className="section-meta">{data.recentFeedback.length} latest notes</span>
                  </div>
                  <div className="stack" style={{ gap: 8 }}>
                    {data.recentFeedback.length === 0 && (
                      <div className="muted small">No feedback yet.</div>
                    )}
                    {data.recentFeedback.map((item) => (
                      <div
                        key={item.id}
                        style={{
                          border: "1px solid var(--line)",
                          borderRadius: 12,
                          padding: 10,
                          background: "var(--bg)",
                        }}
                      >
                        <div
                          className="small muted"
                          style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
                        >
                          <span>{item.email ?? "Unknown user"}</span>
                          <span>{formatRelative(item.createdAt)}</span>
                        </div>
                        <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{item.message}</div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminKpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 14,
        padding: 12,
        background: "linear-gradient(180deg, rgba(255,255,255,0.9), rgba(247,246,242,0.9))",
      }}
    >
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 28, lineHeight: 1.1, fontWeight: 800, marginTop: 6 }}>{value}</div>
      <div className="small muted" style={{ marginTop: 4 }}>{note}</div>
    </div>
  );
}

function AdminMetric({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 12,
        padding: 10,
        background: "var(--line-soft, #f6f4f1)",
      }}
    >
      <div className="small muted">{label}</div>
      <div style={{ marginTop: 4, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function FeedbackModal({
  authedFetch,
  userEmail,
  onClose,
}: {
  authedFetch: AuthedFetch;
  userEmail: string;
  onClose: () => void;
}) {
  const isAdmin = isPlatformAdminEmail(userEmail);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const loadAdmin = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingList(true);
    try {
      const res = await authedFetch("/api/v2/feedback");
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(data.error ?? "Failed to load feedback.");
        return;
      }
      const data = (await res.json()) as { feedback: FeedbackItem[] };
      setItems(data.feedback ?? []);
    } finally {
      setLoadingList(false);
    }
  }, [authedFetch, isAdmin]);

  useEffect(() => {
    void loadAdmin();
  }, [loadAdmin]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const res = await authedFetch("/api/v2/feedback", {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(data.error ?? "Failed to submit.");
        return;
      }
      setMessage("");
      setOk("Thanks — your feedback was sent.");
      if (isAdmin) await loadAdmin();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "min(560px, calc(100vw - 16px))" }}
      >
        <div className="sheet-head">
          <div className="title">{isAdmin ? "Platform feedback" : "Send feedback"}</div>
          <button className="btn-ghost small" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-body">
          {!isAdmin && (
            <p className="muted small" style={{ marginTop: 0 }}>
              Tell us what&apos;s working, what&apos;s broken, or what you wish existed. Goes
              straight to the platform admin.
            </p>
          )}

          <form onSubmit={submit} className="stack" style={{ gap: 10 }}>
            <textarea
              placeholder="Your feedback…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              maxLength={4000}
              required
              style={{ width: "100%", resize: "vertical" }}
            />
            <div className="sheet-actions">
              <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={busy || !message.trim()}>
                {busy ? "Sending…" : "Send feedback"}
              </button>
            </div>
          </form>
          {err && <div className="auth-error">{err}</div>}
          {ok && <div className="auth-ok">{ok}</div>}

          {isAdmin && (
            <div style={{ marginTop: 18 }}>
              <div
                className="muted small"
                style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}
              >
                <span>All submissions ({items.length})</span>
                <button
                  className="btn-ghost small"
                  onClick={() => void loadAdmin()}
                  disabled={loadingList}
                >
                  {loadingList ? "Loading…" : "Refresh"}
                </button>
              </div>
              {!items.length && !loadingList && (
                <div className="muted small">No feedback yet.</div>
              )}
              <div className="stack" style={{ gap: 8 }}>
                {items.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      border: "1px solid var(--line)",
                      borderRadius: 10,
                      padding: 10,
                      background: "var(--bg)",
                    }}
                  >
                    <div
                      className="muted small"
                      style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
                    >
                      <span>{item.email ?? item.userId.slice(0, 8)}</span>
                      <span>{formatRelative(item.createdAt)}</span>
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{item.message}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
