import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

interface PageProps {
  searchParams?: {
    query?: string;
    only_active?: string; // "true" | "false"
  };
}

type UserRole = "admin" | "creator" | "user" | "ADMIN" | "CREATOR" | "USER";

interface AdminCreator {
  id: number;                 // users.id
  email: string;
  username: string | null;
  role: UserRole;

  user_active: boolean;       // users.is_active
  creator_active: boolean;    // creator_profiles.is_active
  is_featured: boolean;       // creator_profiles.is_featured

  display_name: string | null;
  created_at: string;         // creator_profiles.created_at
  updated_at: string;         // creator_profiles.updated_at
}

interface CreatorsResponse {
  creators: AdminCreator[];
}

async function fetchCreators(query = "", onlyActive = true): Promise<AdminCreator[]> {
  const base = process.env.NEXT_PUBLIC_API_BASE!;
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (onlyActive) params.set("only_active", "true");

  const cookieHeader = cookies().toString();

  const res = await fetch(`${base}/api/admin/creators?${params.toString()}`, {
    cache: "no-store",
    headers: {
      Cookie: cookieHeader,
    },
  });
  if (!res.ok) throw new Error("Failed to load creators");
  const data: CreatorsResponse = await res.json();
  return data.creators;
}

/** Server Action: feature creator (PATCH alias supported by your backend) */
export async function featureCreatorAction(formData: FormData): Promise<void> {
  "use server";
  const idRaw = formData.get("id");
  const id = Number(idRaw);
  if (!Number.isFinite(id)) return;

  const base = process.env.NEXT_PUBLIC_API_BASE!;
  const cookieHeader = cookies().toString();

  await fetch(`${base}/api/admin/creators/${id}/feature`, {
    method: "PATCH",
    headers: { Cookie: cookieHeader },
  }).catch(() => { /* swallow; UI stays consistent via revalidate */ });

  revalidatePath("/admin/creators");
}

/** Server Action: unfeature creator */
export async function unfeatureCreatorAction(formData: FormData): Promise<void> {
  "use server";
  const idRaw = formData.get("id");
  const id = Number(idRaw);
  if (!Number.isFinite(id)) return;

  const base = process.env.NEXT_PUBLIC_API_BASE!;
  const cookieHeader = cookies().toString();

  await fetch(`${base}/api/admin/creators/${id}/unfeature`, {
    method: "POST",
    headers: { Cookie: cookieHeader },
  }).catch(() => {});

  revalidatePath("/admin/creators");
}

/** Server Action: hard-delete creator (and dependents) */
export async function deleteCreatorAction(formData: FormData): Promise<void> {
  "use server";
  const idRaw = formData.get("id");
  const id = Number(idRaw);
  if (!Number.isFinite(id)) return;

  const base = process.env.NEXT_PUBLIC_API_BASE!;
  const cookieHeader = cookies().toString();

  await fetch(`${base}/api/admin/creators/${id}`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader },
  }).catch(() => {});

  revalidatePath("/admin/creators");
}

export default async function CreatorsPage({ searchParams }: PageProps) {
  const query = searchParams?.query ?? "";
  const onlyActive = (searchParams?.only_active ?? "true") === "true";

  const creators = await fetchCreators(query, onlyActive);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Creators</h2>

      {/* Filters */}
      <form method="GET" className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col">
          <label className="text-sm opacity-70">Search</label>
          <input
            name="query"
            defaultValue={query}
            placeholder="email, username, or display name"
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
              <th className="text-left p-2">Display</th>
              <th className="text-left p-2">Role</th>
              <th className="text-left p-2">User Active</th>
              <th className="text-left p-2">Creator Active</th>
              <th className="text-left p-2">Featured</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {creators.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="p-2">{c.id}</td>
                <td className="p-2">{c.email}</td>
                <td className="p-2">{c.username ?? "—"}</td>
                <td className="p-2">{c.display_name ?? "—"}</td>
                <td className="p-2">{String(c.role).toUpperCase()}</td>
                <td className="p-2">{c.user_active ? "Yes" : "No"}</td>
                <td className="p-2">{c.creator_active ? "Yes" : "No"}</td>
                <td className="p-2">{c.is_featured ? "Yes" : "No"}</td>
                <td className="p-2">
                  <div className="flex gap-2">
                    {!c.is_featured ? (
                      <form action={featureCreatorAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <button className="rounded px-3 py-1 border hover:bg-gray-50">
                          Feature
                        </button>
                      </form>
                    ) : (
                      <form action={unfeatureCreatorAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <button className="rounded px-3 py-1 border hover:bg-gray-50">
                          Unfeature
                        </button>
                      </form>
                    )}
                    <form action={deleteCreatorAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <button className="rounded px-3 py-1 border hover:bg-gray-50">
                        Delete (hard)
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
            {creators.length === 0 && (
              <tr>
                <td className="p-4 text-center opacity-70" colSpan={9}>
                  No creators found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
