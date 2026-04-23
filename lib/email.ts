import nodemailer from "nodemailer";

type MailArgs = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getAppBaseUrl() {
  return (
    env("APP_BASE_URL") ??
    env("NEXT_PUBLIC_APP_URL") ??
    env("VERCEL_PROJECT_PRODUCTION_URL")?.replace(/^https?:\/\//, "https://") ??
    "http://localhost:3000"
  );
}

export function isEmailConfigured() {
  return Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS"));
}

function createTransport() {
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");

  if (!host || !user || !pass) {
    throw new Error("Email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.");
  }

  const port = Number(env("SMTP_PORT") ?? "465");
  const secure = (env("SMTP_SECURE") ?? "true").toLowerCase() !== "false";

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

export async function sendEmail(args: MailArgs) {
  const transporter = createTransport();
  const from = env("EMAIL_FROM") ?? env("SMTP_USER");

  if (!from) {
    throw new Error("Email sender is not configured.");
  }

  await transporter.sendMail({
    from,
    to: args.to,
    subject: args.subject,
    text: args.text,
    html: args.html,
  });
}
