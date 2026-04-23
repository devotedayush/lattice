import type { FieldObject } from "@/lib/lattice";
import type { LatticeState } from "@/lib/v2";

export type MemberDigestItem = {
  id: string;
  type: FieldObject["type"];
  title: string;
  detail: string;
  status?: string;
  dueAt?: string;
};

export function normalizeOwner(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export function itemsForOwner(state: LatticeState, owner: string): MemberDigestItem[] {
  const target = normalizeOwner(owner);
  if (!target) return [];

  return state.fieldObjects
    .filter((item) => {
      const currentOwner = normalizeOwner(item.owner);
      if (!currentOwner || currentOwner !== target) return false;
      if (item.type === "promise" && (item.status === "done" || item.status === "dropped")) return false;
      if (item.type === "blocker" && (item.status === "resolved" || item.status === "dropped")) return false;
      return true;
    })
    .map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      detail: item.detail,
      status: item.status,
      dueAt: item.dueAt,
    }));
}

function labelForType(type: FieldObject["type"]) {
  switch (type) {
    case "promise":
      return "Task";
    case "blocker":
      return "Blocker";
    case "request":
      return "Request";
    case "reminder":
      return "Reminder";
    case "shift":
      return "Shift";
    case "signal":
      return "Signal";
    default:
      return "Item";
  }
}

function formatDue(date: string | undefined) {
  if (!date) return null;
  const parsed = Date.parse(date);
  if (!Number.isFinite(parsed)) return date;
  return new Date(parsed).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildTaskDigestEmail(params: {
  memberName: string;
  teamName: string;
  siteUrl: string;
  items: MemberDigestItem[];
}) {
  const count = params.items.length;
  const intro =
    count === 0
      ? "You have no active assigned items right now."
      : `You currently have ${count} assigned ${count === 1 ? "item" : "items"} in ${params.teamName}.`;

  const lines = params.items.map((item, index) => {
    const extra = [
      item.status ? `status: ${item.status}` : null,
      item.dueAt ? `due: ${formatDue(item.dueAt)}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    return `${index + 1}. [${labelForType(item.type)}] ${item.title}${extra ? ` (${extra})` : ""}\n${item.detail}`;
  });

  const text = [
    `Hi ${params.memberName},`,
    "",
    intro,
    "",
    ...(lines.length ? lines.flatMap((line) => [line, ""]) : ["Open the workspace to review the team state and add updates.", ""]),
    `Open OrgMind: ${params.siteUrl}`,
  ].join("\n");

  const htmlItems = params.items
    .map((item) => {
      const meta = [
        labelForType(item.type),
        item.status ? `Status: ${item.status}` : null,
        item.dueAt ? `Due: ${formatDue(item.dueAt)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return `
        <li style="margin:0 0 14px 0;">
          <div style="font-weight:600;color:#111827;">${escapeHtml(item.title)}</div>
          <div style="font-size:13px;color:#4b5563;margin:4px 0;">${escapeHtml(meta)}</div>
          <div style="font-size:14px;color:#111827;line-height:1.5;">${escapeHtml(item.detail)}</div>
        </li>
      `;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;background:#f5f1e8;padding:24px;color:#111827;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e5e7eb;">
        <p style="margin:0 0 12px 0;font-size:16px;">Hi ${escapeHtml(params.memberName)},</p>
        <p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;">${escapeHtml(intro)}</p>
        ${
          htmlItems
            ? `<ol style="padding-left:20px;margin:0 0 22px 0;">${htmlItems}</ol>`
            : `<p style="margin:0 0 22px 0;font-size:15px;line-height:1.6;">Open the workspace to review the team state and add updates.</p>`
        }
        <a href="${escapeHtml(params.siteUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:600;">Open OrgMind</a>
      </div>
    </div>
  `;

  return { text, html };
}
