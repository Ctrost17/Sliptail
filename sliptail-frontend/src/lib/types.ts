export type Role = "user" | "creator" | "admin";

export interface SafeUser {
  id: number;
  email: string;
  username: string | null;
  role: Role;
  email_verified_at: string | null;
  created_at: string;
}