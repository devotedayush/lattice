import type { SupabaseClient, User } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

import { createSupabaseServiceClient } from "@/lib/supabase";

export type TeamRole = "owner" | "admin" | "member";
export type InviteState = "pending" | "accepted" | "revoked" | "expired";

export type TeamSummary = {
  id: string;
  name: string;
  role: TeamRole;
  memberCount?: number;
  createdBy?: string | null;
  memberName?: string;
  joinToken?: string | null;
};

export type TeamMemberRecord = {
  id: string;
  userId: string;
  name: string;
  role: TeamRole;
  email?: string | null;
  skills?: string[];
  focus?: string | null;
  bio?: string | null;
};

export type MemberStats = {
  completed: number;
  openCount: number;
  overdueCount: number;
  declinedCount: number;
  onTimeRate: number | null; // 0..1, null if no completed+due data
  avgDeliveryHours: number | null;
};

export type TeamInvite = {
  id: string;
  teamSpaceId: string;
  email: string;
  role: TeamRole;
  state: InviteState;
  token: string;
  expiresAt: string;
  createdAt: string;
};

export type JoinRequestState = "pending" | "approved" | "rejected" | "cancelled";

export type TeamJoinRequest = {
  id: string;
  teamSpaceId: string;
  userId: string;
  name: string | null;
  email: string | null;
  message: string | null;
  state: JoinRequestState;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
};

export type JoinLinkTeam = {
  teamSpaceId: string;
  teamName: string;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "team";
}

export function generateTeamId(name: string): string {
  const slug = slugify(name);
  const suffix = randomBytes(3).toString("hex");
  return `${slug}-${suffix}`;
}

export function generateInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function listUserTeams(
  supabase: SupabaseClient,
  userId: string,
): Promise<TeamSummary[]> {
  const primary = await supabase
    .from("team_members")
    .select("role, team_space_id, name, team_spaces(id, name, created_by, join_token)")
    .eq("user_id", userId);

  const response =
    primary.error && primary.error.code === "42703"
      ? await supabase
          .from("team_members")
          .select("role, team_space_id, name, team_spaces(id, name, created_by)")
          .eq("user_id", userId)
      : primary;

  if (response.error) throw response.error;
  type Row = {
    role: TeamRole;
    team_space_id: string;
    name: string | null;
    team_spaces:
      | { id: string; name: string; created_by: string | null; join_token: string | null }
      | { id: string; name: string; created_by: string | null; join_token: string | null }[]
      | null;
  };
  return ((response.data ?? []) as Row[]).map((row) => {
    const space = Array.isArray(row.team_spaces) ? row.team_spaces[0] : row.team_spaces;
    return {
      id: row.team_space_id,
      name: space?.name ?? row.team_space_id,
      role: row.role,
      createdBy: space?.created_by ?? null,
      memberName: row.name ?? undefined,
      joinToken: space?.join_token ?? null,
    };
  });
}

export async function createTeam(
  supabase: SupabaseClient,
  user: User,
  name: string,
): Promise<TeamSummary> {
  const id = generateTeamId(name);
  const displayName = name.trim() || "New team";

  const { error: spaceError } = await supabase.from("team_spaces").insert({
    id,
    name: displayName,
    active_intent: "Set your first goal",
    tensions: [],
    broadcast: [],
    created_by: user.id,
  });
  if (spaceError) throw spaceError;

  const memberId = `m-${id}-${user.id.slice(0, 8)}`;
  const displayMember = (user.user_metadata?.name as string | undefined) ?? user.email ?? "Owner";

  const { error: memberError } = await supabase.from("team_members").insert({
    id: memberId,
    team_space_id: id,
    user_id: user.id,
    name: displayMember,
    role: "owner" as TeamRole,
  });
  if (memberError) throw memberError;

  return { id, name: displayName, role: "owner", createdBy: user.id };
}

export async function getJoinLinkTeam(
  supabase: SupabaseClient,
  joinToken: string,
): Promise<JoinLinkTeam | null> {
  const { data, error } = await supabase
    .from("team_spaces")
    .select("id, name")
    .eq("join_token", joinToken)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    teamSpaceId: data.id,
    teamName: data.name,
  };
}

export async function getUserActiveTeam(
  supabase: SupabaseClient,
  userId: string,
  preferredId?: string | null,
): Promise<TeamSummary | null> {
  const teams = await listUserTeams(supabase, userId);
  if (teams.length === 0) return null;
  if (preferredId) {
    const match = teams.find((t) => t.id === preferredId);
    if (match) return match;
  }
  return teams[0];
}

export async function listTeamMembers(
  supabase: SupabaseClient,
  teamSpaceId: string,
): Promise<TeamMemberRecord[]> {
  const { data, error } = await supabase
    .from("team_members")
    .select("id, user_id, name, role, skills, focus, bio")
    .eq("team_space_id", teamSpaceId);
  if (error) throw error;
  type Row = {
    id: string;
    user_id: string;
    name: string;
    role: TeamRole;
    skills: string[] | null;
    focus: string | null;
    bio: string | null;
  };
  const rows = (data ?? []) as Row[];

  // Enrich with auth.users.email when the service role key is available.
  // Without it we simply omit the email field — caller already allows it.
  const admin = createSupabaseServiceClient();
  const emails = new Map<string, string>();
  if (admin) {
    const results = await Promise.all(
      rows.map(async (r) => {
        try {
          return await admin.auth.admin.getUserById(r.user_id);
        } catch (err) {
          console.error("listTeamMembers: getUserById failed", r.user_id, err);
          return null;
        }
      }),
    );
    results.forEach((res, i) => {
      if (res?.error) {
        console.error("listTeamMembers: getUserById error", rows[i].user_id, res.error);
      }
      const email = res?.data?.user?.email;
      if (email) emails.set(rows[i].user_id, email);
    });
  } else if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      "listTeamMembers: SUPABASE_SERVICE_ROLE_KEY not set — emails will be omitted.",
    );
  }

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    role: r.role,
    email: emails.get(r.user_id) ?? null,
    skills: r.skills ?? [],
    focus: r.focus,
    bio: r.bio,
  }));
}

export async function updateMemberProfile(
  supabase: SupabaseClient,
  params: {
    teamSpaceId: string;
    memberId: string;
    name?: string;
    skills?: string[];
    focus?: string | null;
    bio?: string | null;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (params.name !== undefined) patch.name = params.name;
  if (params.skills !== undefined) patch.skills = params.skills;
  if (params.focus !== undefined) patch.focus = params.focus;
  if (params.bio !== undefined) patch.bio = params.bio;
  if (Object.keys(patch).length === 0) return;
  const { data, error } = await supabase
    .from("team_members")
    .update(patch)
    .eq("id", params.memberId)
    .eq("team_space_id", params.teamSpaceId)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("Profile update denied (you can only edit your own row).");
  }
}

export async function createInvite(
  supabase: SupabaseClient,
  user: User,
  params: { teamSpaceId: string; email: string; role: TeamRole },
): Promise<TeamInvite> {
  const id = `inv-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const token = generateInviteToken();
  const { data, error } = await supabase
    .from("team_invitations")
    .insert({
      id,
      team_space_id: params.teamSpaceId,
      email: params.email.trim().toLowerCase(),
      token,
      role: params.role,
      state: "pending" as InviteState,
      invited_by: user.id,
    })
    .select("id, team_space_id, email, role, state, token, expires_at, created_at")
    .single();
  if (error) throw error;
  const row = data as {
    id: string;
    team_space_id: string;
    email: string;
    role: TeamRole;
    state: InviteState;
    token: string;
    expires_at: string;
    created_at: string;
  };
  return {
    id: row.id,
    teamSpaceId: row.team_space_id,
    email: row.email,
    role: row.role,
    state: row.state,
    token: row.token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function listInvites(
  supabase: SupabaseClient,
  teamSpaceId: string,
): Promise<TeamInvite[]> {
  const { data, error } = await supabase
    .from("team_invitations")
    .select("id, team_space_id, email, role, state, token, expires_at, created_at")
    .eq("team_space_id", teamSpaceId)
    .eq("state", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    teamSpaceId: row.team_space_id,
    email: row.email,
    role: row.role,
    state: row.state,
    token: row.token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}

export async function revokeInvite(
  supabase: SupabaseClient,
  inviteId: string,
): Promise<void> {
  // .select() after update returns affected rows — 0 means RLS denied or not found.
  const { data, error } = await supabase
    .from("team_invitations")
    .update({ state: "revoked" })
    .eq("id", inviteId)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("Revoke denied (admin required or invite not found).");
  }
}

export async function acceptInvite(
  supabase: SupabaseClient,
  user: User,
  token: string,
): Promise<{ teamSpaceId: string }> {
  const { data: inviteRow, error: inviteErr } = await supabase
    .from("team_invitations")
    .select("id, team_space_id, email, role, state, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (inviteErr) throw inviteErr;
  if (!inviteRow) throw new Error("Invite not found.");
  const invite = inviteRow as {
    id: string;
    team_space_id: string;
    email: string;
    role: TeamRole;
    state: InviteState;
    expires_at: string;
  };
  if (invite.state !== "pending") throw new Error(`Invite is ${invite.state}.`);
  if (Date.parse(invite.expires_at) < Date.now()) throw new Error("Invite has expired.");

  // Insert or upgrade member
  const existing = await supabase
    .from("team_members")
    .select("id")
    .eq("team_space_id", invite.team_space_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing.data?.id) {
    await supabase
      .from("team_members")
      .update({ role: invite.role })
      .eq("id", existing.data.id);
  } else {
    const memberId = `m-${invite.team_space_id}-${user.id.slice(0, 8)}`;
    const { error: memberError } = await supabase.from("team_members").insert({
      id: memberId,
      team_space_id: invite.team_space_id,
      user_id: user.id,
      name: (user.user_metadata?.name as string | undefined) ?? user.email ?? "Member",
      role: invite.role,
    });
    if (memberError) throw memberError;
  }

  await supabase
    .from("team_invitations")
    .update({ state: "accepted", accepted_by: user.id })
    .eq("id", invite.id);

  return { teamSpaceId: invite.team_space_id };
}

export async function createJoinRequest(
  supabase: SupabaseClient,
  user: User,
  params: { joinToken: string; message?: string | null },
): Promise<{ request: TeamJoinRequest; team: JoinLinkTeam; alreadyMember?: boolean }> {
  const team = await getJoinLinkTeam(supabase, params.joinToken);
  if (!team) throw new Error("Join link not found.");

  const existingMember = await supabase
    .from("team_members")
    .select("id")
    .eq("team_space_id", team.teamSpaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingMember.error) throw existingMember.error;
  if (existingMember.data?.id) {
    return {
      team,
      alreadyMember: true,
      request: {
        id: `existing-${team.teamSpaceId}-${user.id}`,
        teamSpaceId: team.teamSpaceId,
        userId: user.id,
        name: (user.user_metadata?.name as string | undefined) ?? null,
        email: user.email ?? null,
        message: params.message?.trim() || null,
        state: "approved",
        createdAt: new Date().toISOString(),
      },
    };
  }

  const { data: existingRequest, error: existingRequestError } = await supabase
    .from("team_join_requests")
    .select("id, state, created_at")
    .eq("team_space_id", team.teamSpaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingRequestError) throw existingRequestError;

  if (existingRequest?.state === "pending") {
    throw new Error("You already have a pending request for this team.");
  }

  const payload = {
    team_space_id: team.teamSpaceId,
    user_id: user.id,
    name: ((user.user_metadata?.name as string | undefined) ?? user.email ?? "Member").trim(),
    email: user.email ?? null,
    message: params.message?.trim() || null,
    state: "pending" as JoinRequestState,
    reviewed_by: null,
    reviewed_at: null,
  };

  if (existingRequest?.id) {
    const { data, error } = await supabase
      .from("team_join_requests")
      .update(payload)
      .eq("id", existingRequest.id)
      .select("id, team_space_id, user_id, name, email, message, state, reviewed_by, reviewed_at, created_at")
      .single();
    if (error) throw error;
    return {
      team,
      request: {
        id: data.id,
        teamSpaceId: data.team_space_id,
        userId: data.user_id,
        name: data.name,
        email: data.email,
        message: data.message,
        state: data.state,
        reviewedBy: data.reviewed_by,
        reviewedAt: data.reviewed_at,
        createdAt: data.created_at,
      },
    };
  }

  const requestId = `join-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const { data, error } = await supabase
    .from("team_join_requests")
    .insert({
      id: requestId,
      ...payload,
    })
    .select("id, team_space_id, user_id, name, email, message, state, reviewed_by, reviewed_at, created_at")
    .single();
  if (error) throw error;
  return {
    team,
    request: {
      id: data.id,
      teamSpaceId: data.team_space_id,
      userId: data.user_id,
      name: data.name,
      email: data.email,
      message: data.message,
      state: data.state,
      reviewedBy: data.reviewed_by,
      reviewedAt: data.reviewed_at,
      createdAt: data.created_at,
    },
  };
}

export async function listJoinRequests(
  supabase: SupabaseClient,
  teamSpaceId: string,
): Promise<TeamJoinRequest[]> {
  const { data, error } = await supabase
    .from("team_join_requests")
    .select("id, team_space_id, user_id, name, email, message, state, reviewed_by, reviewed_at, created_at")
    .eq("team_space_id", teamSpaceId)
    .eq("state", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;

  type Row = {
    id: string;
    team_space_id: string;
    user_id: string;
    name: string | null;
    email: string | null;
    message: string | null;
    state: JoinRequestState;
    reviewed_by: string | null;
    reviewed_at: string | null;
    created_at: string;
  };

  const rows = (data ?? []) as Row[];
  const admin = createSupabaseServiceClient();
  const emails = new Map<string, string>();
  if (admin) {
    const results = await Promise.all(
      rows
        .filter((row) => !row.email)
        .map(async (row) => {
          try {
            return await admin.auth.admin.getUserById(row.user_id);
          } catch (err) {
            console.error("listJoinRequests: getUserById failed", row.user_id, err);
            return null;
          }
        }),
    );
    results.forEach((res, i) => {
      const row = rows.filter((candidate) => !candidate.email)[i];
      const email = res?.data?.user?.email;
      if (row?.user_id && email) emails.set(row.user_id, email);
    });
  }

  return rows.map((row) => ({
    id: row.id,
    teamSpaceId: row.team_space_id,
    userId: row.user_id,
    name: row.name,
    email: row.email ?? emails.get(row.user_id) ?? null,
    message: row.message,
    state: row.state,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  }));
}

export async function reviewJoinRequest(
  supabase: SupabaseClient,
  reviewer: User,
  params: { teamSpaceId: string; joinRequestId: string; action: "approve" | "reject" },
): Promise<void> {
  const { data: requestRow, error: requestError } = await supabase
    .from("team_join_requests")
    .select("id, team_space_id, user_id, name, email, state")
    .eq("id", params.joinRequestId)
    .eq("team_space_id", params.teamSpaceId)
    .maybeSingle();
  if (requestError) throw requestError;
  if (!requestRow) throw new Error("Join request not found.");
  if (requestRow.state !== "pending") throw new Error(`Join request is ${requestRow.state}.`);

  if (params.action === "approve") {
    const existingMember = await supabase
      .from("team_members")
      .select("id")
      .eq("team_space_id", requestRow.team_space_id)
      .eq("user_id", requestRow.user_id)
      .maybeSingle();
    if (existingMember.error) throw existingMember.error;

    if (!existingMember.data?.id) {
      const memberId = `m-${requestRow.team_space_id}-${requestRow.user_id.slice(0, 8)}`;
      const { error: memberError } = await supabase.from("team_members").insert({
        id: memberId,
        team_space_id: requestRow.team_space_id,
        user_id: requestRow.user_id,
        name: requestRow.name ?? requestRow.email ?? "Member",
        role: "member" as TeamRole,
      });
      if (memberError) throw memberError;
    }
  }

  const nextState: JoinRequestState = params.action === "approve" ? "approved" : "rejected";
  const { error: updateError } = await supabase
    .from("team_join_requests")
    .update({
      state: nextState,
      reviewed_by: reviewer.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", requestRow.id);
  if (updateError) throw updateError;
}

export async function updateMemberRole(
  supabase: SupabaseClient,
  params: { teamSpaceId: string; memberId: string; role: TeamRole },
): Promise<void> {
  const { error } = await supabase
    .from("team_members")
    .update({ role: params.role })
    .eq("id", params.memberId)
    .eq("team_space_id", params.teamSpaceId);
  if (error) throw error;
}

export async function removeMember(
  supabase: SupabaseClient,
  params: { teamSpaceId: string; memberId: string },
): Promise<void> {
  const { error } = await supabase
    .from("team_members")
    .delete()
    .eq("id", params.memberId)
    .eq("team_space_id", params.teamSpaceId);
  if (error) throw error;
}
