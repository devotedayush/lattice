export const PLATFORM_ADMIN_EMAIL = "maantech123@gmail.com";

export function isPlatformAdminEmail(email?: string | null): boolean {
  return (email ?? "").trim().toLowerCase() === PLATFORM_ADMIN_EMAIL;
}
