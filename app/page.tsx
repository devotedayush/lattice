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

type Tab = "pulse" | "timeline" | "interventions" | "commitments";

type TeamSummary = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
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
  const [composerOpen, setComposerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [activeTeam, setActiveTeam] = useState<TeamSummary | null>(null);
  const [needsTeam, setNeedsTeam] = useState(false);
  const [teamPanel, setTeamPanel] = useState<"none" | "create" | "manage">("none");
  const [simulating, setSimulating] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

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
      if (init.body && !headers.has("Content-Type")) {
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
    setTeams(data.teams ?? []);
    if (!data.teams?.length) {
      setNeedsTeam(true);
      setActiveTeam(null);
    } else {
      setNeedsTeam(false);
      setActiveTeam((prev) => prev ?? data.teams[0]);
    }
  }, [authedFetch, session]);

  const loadState = useCallback(
    async (teamId?: string) => {
      if (!session) return;
      const tid = teamId ?? activeTeam?.id;
      if (!tid) return;
      try {
        setLoading(true);
        const res = await authedFetch(`/api/v2/state?team=${encodeURIComponent(tid)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { state: LatticeState | null; team: TeamSummary | null };
        if (data.state) setState(data.state);
        if (data.team) setActiveTeam(data.team);
      } finally {
        setLoading(false);
      }
    },
    [authedFetch, session, activeTeam?.id],
  );

  useEffect(() => {
    if (session) void loadTeams();
  }, [session, loadTeams]);

  useEffect(() => {
    if (session && activeTeam) void loadState(activeTeam.id);
  }, [session, activeTeam, loadState]);

  // Supabase realtime: refresh state when anything in this team changes
  useEffect(() => {
    if (!supabase || !activeTeam) return;
    const channel = supabase
      .channel(`lattice-${activeTeam.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "change_events", filter: `team_space_id=eq.${activeTeam.id}` },
        () => void loadState(activeTeam.id),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "interventions", filter: `team_space_id=eq.${activeTeam.id}` },
        () => void loadState(activeTeam.id),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "goals", filter: `team_space_id=eq.${activeTeam.id}` },
        () => void loadState(activeTeam.id),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "field_objects", filter: `team_space_id=eq.${activeTeam.id}` },
        () => void loadState(activeTeam.id),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, activeTeam, loadState]);

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
        onSignOut={() => supabase?.auth.signOut()}
        teams={teams}
        activeTeam={activeTeam}
        onSwitch={(t) => setActiveTeam(t)}
        onCreate={() => setTeamPanel("create")}
        onManage={() => setTeamPanel("manage")}
      />

      <Tabs tab={tab} onChange={setTab} />

      {tab === "pulse" && (
        <PulseView
          state={state}
          onOpenComposer={() => setComposerOpen(true)}
          authedFetch={authedFetch}
          teamId={teamId}
          onState={setState}
          onSimulate={runSimulate}
          onAnalyze={runAnalyze}
          simulating={simulating}
          analyzing={analyzing}
        />
      )}
      {tab === "timeline" && <TimelineView state={state} />}
      {tab === "interventions" && (
        <InterventionsView
          state={state}
          authedFetch={authedFetch}
          onRefresh={setState}
          teamId={teamId}
        />
      )}
      {tab === "commitments" && (
        <CommitmentsView state={state} authedFetch={authedFetch} teamId={teamId} onState={setState} />
      )}

      <VoiceDock onClick={() => setComposerOpen(true)} />

      {composerOpen && (
        <ComposerSheet
          onClose={() => setComposerOpen(false)}
          authedFetch={authedFetch}
          teamId={teamId}
          onApplied={(next) => {
            setState(next);
            setComposerOpen(false);
          }}
        />
      )}

      {teamPanel === "create" && (
        <CreateTeamModal
          authedFetch={authedFetch}
          onClose={() => setTeamPanel("none")}
          onCreated={async (t) => {
            await loadTeams();
            setActiveTeam(t);
            setTeamPanel("none");
          }}
        />
      )}

      {teamPanel === "manage" && activeTeam && (
        <ManageTeamModal
          authedFetch={authedFetch}
          team={activeTeam}
          onClose={() => setTeamPanel("none")}
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
  onSignOut,
  teams,
  activeTeam,
  onSwitch,
  onCreate,
  onManage,
}: {
  email: string;
  onSignOut: () => void;
  teams: TeamSummary[];
  activeTeam: TeamSummary | null;
  onSwitch: (t: TeamSummary) => void;
  onCreate: () => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-dot" aria-hidden />
        Lattice
      </div>
      <div className="topbar-actions">
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
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
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
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
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
  userId: string;
  role: "owner" | "admin" | "member";
  name: string | null;
  email: string | null;
  joinedAt: string;
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

function ManageTeamModal({
  authedFetch,
  team,
  onClose,
}: {
  authedFetch: AuthedFetch;
  team: TeamSummary;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, i] = await Promise.all([
      authedFetch(`/api/v2/teams/${team.id}/members`),
      authedFetch(`/api/v2/teams/${team.id}/invites`),
    ]);
    if (m.ok) {
      const data = (await m.json()) as { members: MemberRow[] };
      setMembers(data.members ?? []);
    }
    if (i.ok) {
      const data = (await i.json()) as { invites: InviteRow[] };
      setInvites(data.invites ?? []);
    }
  }, [authedFetch, team.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
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
    await authedFetch(`/api/v2/teams/${team.id}/invites?inviteId=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await load();
  };

  const changeRole = async (memberId: string, nextRole: "owner" | "admin" | "member") => {
    await authedFetch(`/api/v2/teams/${team.id}/members`, {
      method: "PATCH",
      body: JSON.stringify({ memberId, role: nextRole }),
    });
    await load();
  };

  const removeMember = async (memberId: string) => {
    await authedFetch(`/api/v2/teams/${team.id}/members?memberId=${encodeURIComponent(memberId)}`, {
      method: "DELETE",
    });
    await load();
  };

  const canAdmin = team.role === "owner" || team.role === "admin";
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="sheet-head">
          <div className="title">{team.name}</div>
          <button className="btn-ghost small" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-body">
          <h4>Members</h4>
          <div className="stack" style={{ gap: 8 }}>
            {members.map((m) => (
              <div key={m.userId} className="commitment" style={{ gridTemplateColumns: "1fr auto" }}>
                <div>
                  <div className="commitment-title">{m.name || m.email || m.userId}</div>
                  <div className="commitment-meta">
                    <span>{m.email}</span>
                    <span>· {m.role}</span>
                  </div>
                </div>
                {canAdmin && (
                  <div className="row" style={{ gap: 6 }}>
                    <select
                      value={m.role}
                      onChange={(e) => changeRole(m.userId, e.target.value as "owner" | "admin" | "member")}
                      disabled={team.role !== "owner" && m.role === "owner"}
                    >
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </select>
                    <button className="btn-ghost small" onClick={() => removeMember(m.userId)}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {canAdmin && (
            <>
              <h4 style={{ marginTop: 18 }}>Invite someone</h4>
              <form onSubmit={invite} className="row" style={{ gap: 8 }}>
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
              {err && <div className="auth-error">{err}</div>}
            </>
          )}

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
}) {
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
          <button className="btn-ghost" onClick={onAnalyze} disabled={analyzing}>
            {analyzing ? "Analyzing…" : "Run analysis"}
          </button>
          <button className="btn-ghost" onClick={onSimulate} disabled={simulating}>
            {simulating ? "…" : "Simulate teammate"}
          </button>
        </div>
      </div>

      <div className="meta-strip">
        <div className="meta-card">
          <div className="meta-label">Confidence</div>
          <div className={`meta-value ${conf < 0.5 ? "warn" : "accent"}`}>
            {Math.round(conf * 100)}%
          </div>
          <div className="meta-sub">How likely we hit the goal right now</div>
        </div>
        <div className="meta-card">
          <div className="meta-label">At risk</div>
          <div className={`meta-value ${atRisk > 0 ? "warn" : ""}`}>{atRisk}</div>
          <div className="meta-sub">
            {atRisk === 0 ? "Nothing on fire" : "Commitments below 50% or blocked"}
          </div>
        </div>
        <div className="meta-card">
          <div className="meta-label">Blockers</div>
          <div className={`meta-value ${openBlockers > 0 ? "warn" : ""}`}>{openBlockers}</div>
          <div className="meta-sub">
            {openBlockers === 0 ? "Clear" : "Open, needs attention"}
          </div>
        </div>
      </div>

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
              <TimelineItem key={ev.id} ev={ev} />
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

function TimelineView({ state }: { state: LatticeState }) {
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
              <TimelineItem key={ev.id} ev={ev} detailed />
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

function TimelineItem({ ev, detailed }: { ev: ChangeEvent; detailed?: boolean }) {
  const accent = accentForChangeKind(ev.kind);
  return (
    <div className="timeline-item">
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
}: {
  state: LatticeState;
  authedFetch: AuthedFetch;
  onRefresh: (next: LatticeState) => void;
  teamId: string | undefined;
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
              <InterventionCard key={iv.id} iv={iv} onPatch={patch} />
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
}: {
  iv: Intervention;
  onPatch: (id: string, state: InterventionState) => Promise<void>;
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
    <div className={`intervention ${iv.urgency >= 4 ? "urgent" : ""}`}>
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
}: {
  state: LatticeState;
  authedFetch: AuthedFetch;
  teamId: string | undefined;
  onState: (s: LatticeState) => void;
}) {
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
  const grouped = useMemo(() => {
    const order: FieldObjectType[] = ["promise", "blocker", "request", "reminder", "shift", "signal"];
    const byType = new Map<FieldObjectType, FieldObject[]>();
    for (const f of state.fieldObjects) {
      if (!byType.has(f.type)) byType.set(f.type, []);
      byType.get(f.type)!.push(f);
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
            <h2 className="section-title">{labelForType(g.type)}</h2>
            <span className="section-meta">{g.items.length}</span>
          </div>
          <div className="commitment-list">
            {g.items.map((f) => (
              <CommitmentRow key={f.id} f={f} onAct={act} />
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
}: {
  f: FieldObject;
  onAct: (id: string, action: "complete" | "resolve" | "drop") => Promise<void>;
}) {
  const confClass = f.confidence < 0.4 ? "low" : f.confidence < 0.7 ? "mid" : "";
  const [busy, setBusy] = useState(false);
  const closed = f.status === "done" || f.status === "resolved" || f.status === "dropped";
  const click = async (action: "complete" | "resolve" | "drop") => {
    setBusy(true);
    try {
      await onAct(f.id, action);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="commitment" style={closed ? { opacity: 0.55 } : undefined}>
      <div>
        <div className="commitment-title">{f.title}</div>
        <div className="commitment-meta">
          <span className={`commitment-type ${f.type}`}>{labelForType(f.type)}</span>
          {f.owner && <span>{f.owner}</span>}
          {f.status && <span>· {f.status}</span>}
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <div className="small muted">{Math.round(f.confidence * 100)}%</div>
        <div className="conf-bar">
          <div className={`fill ${confClass}`} style={{ width: `${f.confidence * 100}%` }} />
        </div>
        {!closed && (f.type === "promise" || f.type === "request") && (
          <button className="btn-ghost small" disabled={busy} onClick={() => click("complete")}>
            Done
          </button>
        )}
        {!closed && f.type === "blocker" && (
          <button className="btn-ghost small" disabled={busy} onClick={() => click("resolve")}>
            Resolved
          </button>
        )}
        {!closed && (
          <button className="btn-ghost small" disabled={busy} onClick={() => click("drop")}>
            Drop
          </button>
        )}
      </div>
    </div>
  );
}

function labelForType(t: FieldObjectType): string {
  const map: Record<FieldObjectType, string> = {
    intent: "Intent",
    promise: "Promises",
    blocker: "Blockers",
    request: "Requests",
    reminder: "Reminders",
    shift: "Shifts",
    signal: "Signals",
  };
  return map[t];
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
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const form = new FormData();
        form.append("audio", blob, "update.webm");
        setStatus("Transcribing…");
        try {
          const res = await authedFetch("/api/transcribe", { method: "POST", body: form });
          const data = (await res.json()) as { text?: string; error?: string };
          if (data.error) {
            setStatus(data.error);
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
