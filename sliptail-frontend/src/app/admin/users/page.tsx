import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { apiUrl } from "../_lib/api";

export const dynamic = "force-dynamic";

type RoleFilter = "ALL" | "ADMIN" | "CREATOR" | "USER";

interface AdminUser {
  id: number;
  email: string;
  username: string | null;
  role: "admin" | "creator" | "user" | "ADMIN" | "CREATOR" | "USER";
  is_active: boolean;
  email_verified_at: string | null;
  created_at: string;
}

interface UsersResponse {
  users: AdminUser[];
}

interface PageProps {
  searchParams?: {
    role?: RoleFilter;
    query?: string;
    only_active?: string; // "true" | "false"
    limit?: string;
    offset?: string;
  };
}

/** Build headers that forward auth to the backend (Cookie + optional Bearer). */
async function buildAuthHeaders(): Promise<HeadersInit> {
  const store = await cookies();
  const all = store.getAll(); // [{ name, value }, ...]
  const token = store.get("token")?.value;

  const cookieHeader = all
    .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

  const headers: Record<string, string> = {};
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function fetchUsers(role: RoleFilter, query = "", onlyActive = true): Promise<{ data: AdminUser[]; error?: string }> {
  const url = await apiUrl("/api/admin/users", {
    role,
    query: query || undefined,
    only_active: onlyActive ? "true" : undefined,
  });

  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: await buildAuthHeaders(),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const msg = `HTTP ${res.status} ${res.statusText} — ${bodyText.slice(0, 200)}`;
      // eslint-disable-next-line no-console
      console.error("Admin users fetch failed", { url, msg });
      return { data: [], error: msg };
    }

    const data: UsersResponse = await res.json();
    return { data: data.users };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    // eslint-disable-next-line no-console
    console.error("Admin users fetch error", { url, msg });
    return { data: [], error: msg };
  }
}

/** Server Action: delete a user by id (hard delete on your backend) */
export async function deleteUserAction(formData: FormData) {
  "use server";
  const idRaw = formData.get("id");
  const id = Number(idRaw);
  if (!Number.isFinite(id)) return;

  const url = await apiUrl(`/api/admin/users/${id}`);

  const res = await fetch(url, {
    method: "DELETE",
    headers: await buildAuthHeaders(),
  });

  if (!res.ok) {
    let body: unknown = undefined;
    try { body = await res.json(); } catch {}
    // eslint-disable-next-line no-console
    console.error("deleteUserAction error:", {
      url,
      status: res.status,
      statusText: res.statusText,
      body,
    });
  }

  revalidatePath("/admin/users");
}

export default async function UsersPage({ searchParams }: PageProps) {
  const role = (searchParams?.role ?? "ALL") as RoleFilter;
  const query = searchParams?.query ?? "";
  const onlyActive = (searchParams?.only_active ?? "true") === "true";

  const { data: users, error } = await fetchUsers(role, query, onlyActive);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Users</h2>

      {error && (
        <div className="rounded-xl border p-3 text-sm text-red-700 bg-red-50">
          <div className="font-medium mb-1">Couldn’t load users</div>
          <div className="opacity-80 break-all">{error}</div>
          <div className="opacity-60 mt-1">
            Tip: ensure you’re logged in as an <b>admin</b> and that your backend is reachable at <code>NEXT_PUBLIC_API_BASE</code> (or dev fallback).
          </div>
        </div>
      )}

      {/* Filters */}
      <form method="GET" className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col">
          <label className="text-sm opacity-70">Role</label>
          <select name="role" defaultValue={role} className="border rounded px-3 py-2">
            <option value="ALL">All</option>
            <option value="USER">User</option>
            <option value="CREATOR">Creator</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-sm opacity-70">Search</label>
          <input
            name="query"
            defaultValue={query}
            placeholder="email or username"
            className="border rounded px-3 py-2"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            id="only_active"
            type="checkbox"
            name="only_active"
            value="true"
            defaultChecked={onlyActive}
          />
          <label htmlFor="only_active" className="text-sm">Only active</label>
        </div>
        <button className="border rounded px-3 py-2">Apply</button>
      </form>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left p-2">ID</th>
              <th className="text-left p-2">Email</th>
              <th className="text-left p-2">Username</th>
              <th className="text-left p-2">Role</th>
              <th className="text-left p-2">Active</th>
              <th className="text-left p-2">Joined</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b">
                <td className="p-2">{u.id}</td>
                <td className="p-2">{u.email}</td>
                <td className="p-2">{u.username ?? "—"}</td>
                <td className="p-2">{String(u.role).toUpperCase()}</td>
                <td className="p-2">{u.is_active ? "Yes" : "No"}</td>
                <td className="p-2">{new Date(u.created_at).toLocaleDateString()}</td>
                <td className="p-2">
                  <form action={deleteUserAction}>
                    <input type="hidden" name="id" value={u.id} />
                    <button className="rounded px-3 py-1 border hover:bg-gray-50">
                      Delete (hard)
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {users.length === 0 && !error && (
              <tr>
                <td className="p-4 text-center opacity-70" colSpan={7}>
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
