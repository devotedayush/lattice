import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { isPlatformAdminEmail } from "@/lib/platform-admin";
import { createSupabaseServiceClient } from "@/lib/supabase";

type TeamSpaceRow = {
  id: string;
  name: string;
  active_intent: string;
  created_at: string;
  updated_at: string;
};

type TeamMemberRow = {
  team_space_id: string;
  user_id: string | null;
  name: string;
  role: "owner" | "admin" | "member" | string | null;
  created_at: string;
};

type FieldObjectRow = {
  team_space_id: string;
  id: string;
  type: string;
  title: string;
  owner: string | null;
  status: string | null;
  confidence: number | string;
  updated_at: string;
  created_at: string;
};

type ChangeEventRow = {
  team_space_id: string;
  kind: string;
  summary: string;
  created_at: string;
};

type InterventionRow = {
  team_space_id: string;
  title: string;
  state: "suggested" | "accepted" | "dismissed" | "acted" | string;
  urgency: number;
  created_at: string;
};

type GoalRow = {
  team_space_id: string;
  id: string;
  title: string;
  state: string;
  confidence: number | string;
  updated_at: string;
};

type InviteRow = {
  team_space_id: string;
  state: string;
  created_at: string;
  expires_at: string;
};

type FeedbackRow = {
  id: string;
  email: string | null;
  message: string;
  created_at: string;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function isMissingFeedbackTable(error: SupabaseError | null | undefined) {
  return error?.code === "PGRST205" || error?.message?.includes("platform_feedback");
}

function asNumber(value: number | string | null | undefined, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isoDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function maxDate(...values: Array<string | null | undefined>): string | null {
  let best = 0;
  for (const value of values) {
    const ts = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(ts) && ts > best) best = ts;
  }
  return best ? new Date(best).toISOString() : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function computeTeamHealth(params: {
  blockers: number;
  atRiskPromises: number;
  openPromises: number;
  avgConfidence: number;
  recentChanges7d: number;
  suggestedInterventions: number;
}) {
  const score = clamp(
    100
      - params.blockers * 18
      - params.atRiskPromises * 14
      - Math.max(0, 65 - Math.round(params.avgConfidence * 100))
      - (params.recentChanges7d === 0 ? 8 : 0)
      - Math.max(0, params.suggestedInterventions - 1) * 6
      + Math.min(12, params.recentChanges7d * 2),
    8,
    98,
  );

  let status: "healthy" | "watch" | "at-risk" | "critical" = "healthy";
  if (params.blockers >= 3 || params.atRiskPromises >= 3 || params.avgConfidence < 0.45) {
    status = "critical";
  } else if (
    params.blockers >= 1 ||
    params.atRiskPromises >= 2 ||
    params.avgConfidence < 0.58
  ) {
    status = "at-risk";
  } else if (
    params.openPromises >= 5 ||
    params.suggestedInterventions >= 2 ||
    params.recentChanges7d <= 1
  ) {
    status = "watch";
  }

  return { score, status };
}

export async function GET(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  if (!isPlatformAdminEmail(auth.user.email)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const admin = createSupabaseServiceClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Platform admin analytics need SUPABASE_SERVICE_ROLE_KEY configured." },
      { status: 503 },
    );
  }

  const [
    teamsRes,
    membersRes,
    fieldObjectsRes,
    changesRes,
    interventionsRes,
    goalsRes,
    invitesRes,
    feedbackRes,
  ] = await Promise.all([
    admin
      .from("team_spaces")
      .select("id, name, active_intent, created_at, updated_at")
      .order("updated_at", { ascending: false }),
    admin
      .from("team_members")
      .select("team_space_id, user_id, name, role, created_at"),
    admin
      .from("field_objects")
      .select("team_space_id, id, type, title, owner, status, confidence, updated_at, created_at"),
    admin
      .from("change_events")
      .select("team_space_id, kind, summary, created_at")
      .order("created_at", { ascending: false })
      .limit(400),
    admin
      .from("interventions")
      .select("team_space_id, title, state, urgency, created_at")
      .order("created_at", { ascending: false })
      .limit(400),
    admin
      .from("goals")
      .select("team_space_id, id, title, state, confidence, updated_at"),
    admin
      .from("team_invitations")
      .select("team_space_id, state, created_at, expires_at")
      .order("created_at", { ascending: false })
      .limit(400),
    admin
      .from("platform_feedback")
      .select("id, email, message, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const feedbackMissing = isMissingFeedbackTable(feedbackRes.error);
  const firstError =
    teamsRes.error ||
    membersRes.error ||
    fieldObjectsRes.error ||
    changesRes.error ||
    interventionsRes.error ||
    goalsRes.error ||
    invitesRes.error ||
    (feedbackMissing ? null : feedbackRes.error);

  if (firstError) {
    console.error("/api/v2/admin/overview GET", firstError);
    return NextResponse.json({ error: "Failed to load admin analytics." }, { status: 500 });
  }

  const teams = (teamsRes.data ?? []) as TeamSpaceRow[];
  const members = (membersRes.data ?? []) as TeamMemberRow[];
  const fieldObjects = (fieldObjectsRes.data ?? []) as FieldObjectRow[];
  const changes = (changesRes.data ?? []) as ChangeEventRow[];
  const interventions = (interventionsRes.data ?? []) as InterventionRow[];
  const goals = (goalsRes.data ?? []) as GoalRow[];
  const invites = (invitesRes.data ?? []) as InviteRow[];
  const feedback = (feedbackMissing ? [] : (feedbackRes.data ?? [])) as FeedbackRow[];

  const membersByTeam = new Map<string, TeamMemberRow[]>();
  const fieldObjectsByTeam = new Map<string, FieldObjectRow[]>();
  const changesByTeam = new Map<string, ChangeEventRow[]>();
  const interventionsByTeam = new Map<string, InterventionRow[]>();
  const goalsByTeam = new Map<string, GoalRow[]>();
  const invitesByTeam = new Map<string, InviteRow[]>();

  for (const row of members) {
    const list = membersByTeam.get(row.team_space_id) ?? [];
    list.push(row);
    membersByTeam.set(row.team_space_id, list);
  }
  for (const row of fieldObjects) {
    const list = fieldObjectsByTeam.get(row.team_space_id) ?? [];
    list.push(row);
    fieldObjectsByTeam.set(row.team_space_id, list);
  }
  for (const row of changes) {
    const list = changesByTeam.get(row.team_space_id) ?? [];
    list.push(row);
    changesByTeam.set(row.team_space_id, list);
  }
  for (const row of interventions) {
    const list = interventionsByTeam.get(row.team_space_id) ?? [];
    list.push(row);
    interventionsByTeam.set(row.team_space_id, list);
  }
  for (const row of goals) {
    const list = goalsByTeam.get(row.team_space_id) ?? [];
    list.push(row);
    goalsByTeam.set(row.team_space_id, list);
  }
  for (const row of invites) {
    const list = invitesByTeam.get(row.team_space_id) ?? [];
    list.push(row);
    invitesByTeam.set(row.team_space_id, list);
  }

  const today = startOfDay(Date.now());
  const activity14d = Array.from({ length: 14 }, (_, i) => {
    const dayTs = today - (13 - i) * DAY_MS;
    return { day: isoDay(dayTs), updates: 0 };
  });
  const activityIndex = new Map(activity14d.map((item, i) => [item.day, i]));

  for (const change of changes) {
    const ts = Date.parse(change.created_at);
    if (!Number.isFinite(ts)) continue;
    const key = isoDay(startOfDay(ts));
    const idx = activityIndex.get(key);
    if (idx !== undefined) activity14d[idx].updates += 1;
  }

  const interventionStates = {
    suggested: 0,
    accepted: 0,
    acted: 0,
    dismissed: 0,
  };

  for (const row of interventions) {
    if (row.state === "suggested") interventionStates.suggested += 1;
    if (row.state === "accepted") interventionStates.accepted += 1;
    if (row.state === "acted") interventionStates.acted += 1;
    if (row.state === "dismissed") interventionStates.dismissed += 1;
  }

  const teamSnapshots = teams.map((team) => {
    const teamMembers = membersByTeam.get(team.id) ?? [];
    const teamObjects = fieldObjectsByTeam.get(team.id) ?? [];
    const teamChanges = changesByTeam.get(team.id) ?? [];
    const teamInterventions = interventionsByTeam.get(team.id) ?? [];
    const teamGoals = goalsByTeam.get(team.id) ?? [];
    const teamInvites = invitesByTeam.get(team.id) ?? [];

    const blockers = teamObjects.filter((item) => item.type === "blocker");
    const promises = teamObjects.filter((item) => item.type === "promise");
    const openPromises = promises.filter(
      (item) => !["done", "resolved", "dropped"].includes((item.status ?? "").toLowerCase()),
    );
    const atRiskPromises = openPromises.filter((item) => asNumber(item.confidence, 0.7) < 0.5);
    const activeGoal =
      teamGoals.find((goal) => goal.state === "active") ??
      [...teamGoals].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0] ??
      null;

    const promiseAvg =
      openPromises.length > 0
        ? openPromises.reduce((sum, item) => sum + asNumber(item.confidence, 0.7), 0) /
          openPromises.length
        : activeGoal
          ? asNumber(activeGoal.confidence, 0.7)
          : 0.7;
    const avgConfidence = Number(
      (
        activeGoal
          ? (promiseAvg + asNumber(activeGoal.confidence, 0.7)) / 2
          : promiseAvg
      ).toFixed(2),
    );

    const recentChanges7d = teamChanges.filter((row) => {
      const ts = Date.parse(row.created_at);
      return Number.isFinite(ts) && ts >= today - 6 * DAY_MS;
    }).length;

    const suggestedInterventions = teamInterventions.filter(
      (row) => row.state === "suggested",
    ).length;
    const acceptedInterventions = teamInterventions.filter(
      (row) => row.state === "accepted",
    ).length;
    const actedInterventions = teamInterventions.filter((row) => row.state === "acted").length;

    const health = computeTeamHealth({
      blockers: blockers.length,
      atRiskPromises: atRiskPromises.length,
      openPromises: openPromises.length,
      avgConfidence,
      recentChanges7d,
      suggestedInterventions,
    });

    const pendingInvites = teamInvites.filter((row) => row.state === "pending").length;
    const lastActivityAt = maxDate(
      team.updated_at,
      teamChanges[0]?.created_at,
      teamInterventions[0]?.created_at,
      activeGoal?.updated_at,
      teamObjects[0]?.updated_at,
    );

    return {
      id: team.id,
      name: team.name,
      activeIntent: team.active_intent,
      memberCount: teamMembers.length,
      ownerCount: teamMembers.filter((m) => m.role === "owner").length,
      adminCount: teamMembers.filter((m) => m.role === "admin").length,
      openPromises: openPromises.length,
      blockers: blockers.length,
      atRiskPromises: atRiskPromises.length,
      avgConfidence,
      recentChanges7d,
      suggestedInterventions,
      acceptedInterventions,
      actedInterventions,
      pendingInvites,
      healthScore: health.score,
      healthStatus: health.status,
      activeGoal: activeGoal
        ? {
            title: activeGoal.title,
            confidence: asNumber(activeGoal.confidence, avgConfidence),
          }
        : null,
      lastActivityAt,
    };
  });

  const healthDistribution = {
    healthy: 0,
    watch: 0,
    "at-risk": 0,
    critical: 0,
  };

  for (const team of teamSnapshots) {
    healthDistribution[team.healthStatus] += 1;
  }

  const uniqueUsers = new Set(members.map((row) => row.user_id).filter(Boolean));
  const openPromisesTotal = teamSnapshots.reduce((sum, team) => sum + team.openPromises, 0);
  const blockersTotal = teamSnapshots.reduce((sum, team) => sum + team.blockers, 0);
  const avgHealthScore =
    teamSnapshots.length > 0
      ? Math.round(
          teamSnapshots.reduce((sum, team) => sum + team.healthScore, 0) / teamSnapshots.length,
        )
      : 0;
  const avgConfidence =
    teamSnapshots.length > 0
      ? Number(
          (
            teamSnapshots.reduce((sum, team) => sum + team.avgConfidence, 0) / teamSnapshots.length
          ).toFixed(2),
        )
      : 0;
  const pendingInvites = invites.filter((row) => row.state === "pending").length;
  const teamsAtRisk = teamSnapshots.filter(
    (team) => team.healthStatus === "at-risk" || team.healthStatus === "critical",
  ).length;

  const recentActivity = changes.slice(0, 12).map((row) => {
    const team = teams.find((item) => item.id === row.team_space_id);
    return {
      teamId: row.team_space_id,
      teamName: team?.name ?? row.team_space_id,
      kind: row.kind,
      summary: row.summary,
      createdAt: row.created_at,
    };
  });

  const recentFeedback = feedback.slice(0, 10).map((row) => ({
    id: row.id,
    email: row.email,
    message: row.message,
    createdAt: row.created_at,
  }));

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    overview: {
      teams: teams.length,
      memberRows: members.length,
      uniqueUsers: uniqueUsers.size,
      updatesLast14d: activity14d.reduce((sum, item) => sum + item.updates, 0),
      openPromises: openPromisesTotal,
      blockers: blockersTotal,
      avgHealthScore,
      avgConfidence,
      pendingInvites,
      teamsAtRisk,
      feedbackCount: feedback.length,
    },
    activity14d,
    interventionStates,
    healthDistribution,
    teamSnapshots: teamSnapshots.sort((a, b) => {
      if (a.healthScore !== b.healthScore) return a.healthScore - b.healthScore;
      return b.recentChanges7d - a.recentChanges7d;
    }),
    recentActivity,
    recentFeedback,
  });
}
