// src/app/admin/page.tsx
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { apiUrl as maybeApiUrl } from "./_lib/api";

export const dynamic = "force-dynamic";

/* -------------------- Types -------------------- */
type UserRole = "admin" | "creator" | "user";

interface AdminUser {
  id: number;
  email: string;
  username: string | null;
  role: UserRole;
  is_active: boolean;
  email_verified_at: string | null;
  created_at: string;
}

interface AdminCreator {
  id: number;
  email: string;
  username: string | null;
  role: UserRole;
  user_active: boolean;
  creator_active: boolean;
  featured?: boolean | null;
  is_featured: boolean;
  is_listed?: boolean; // new
  display_name: string | null;
  created_at: string;
}

interface Category {
  id: number;
  name: string;
  slug: string | null;
  active: boolean;
  created_at: string;
}

interface UsersResponse { users: AdminUser[] }
interface CreatorsResponse { creators: AdminCreator[] }
interface CategoriesResponse { categories: Category[] }

/* -------------------- Helpers -------------------- */
async function apiUrl(path: string, qs?: Record<string, string>) {
  // Always pass a path that includes "/api/..." so rewrites and direct hits work.
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (typeof maybeApiUrl === "function") {
    return maybeApiUrl(normalized, qs);
  }
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const url = new URL(
    normalized.replace(/^\//, ""),
    base.endsWith("/") ? base : `${base}/`
  );
  if (qs) Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}
type CookiePair = { name: string; value: string };

async function buildAuthHeaders(): Promise<HeadersInit> {
  const store = await cookies(); // <-- await fixes TS error in your setup
  const all = store.getAll() as ReadonlyArray<CookiePair>;
  const token = store.get("token")?.value as string | undefined;

  const cookieHeader = all.map(({ name, value }) => `${name}=${value}`).join("; ");

  const headers: Record<string, string> = {};
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/* -------------------- Fetchers (SSR) -------------------- */
async function fetchUsers(): Promise<AdminUser[]> {
  const url = await apiUrl("/api/admin/users", { limit: "50", offset: "0" });
  const res = await fetch(url, { cache: "no-store", headers: await buildAuthHeaders() });
  if (!res.ok) throw new Error(`Failed to load users (${res.status}) ${await res.text().catch(()=> "")}`);
  const data: UsersResponse = await res.json();
  return data.users;
}

async function fetchCreators(): Promise<AdminCreator[]> {
  const url = await apiUrl("/api/admin/creators", { only_active: "true" });
  const res = await fetch(url, { cache: "no-store", headers: await buildAuthHeaders() });
  if (!res.ok) throw new Error(`Failed to load creators (${res.status}) ${await res.text().catch(()=> "")}`);
  const data: CreatorsResponse = await res.json();
  return data.creators;
}

async function fetchCategories(): Promise<Category[]> {
  const url = await apiUrl("/api/admin/categories");
  const res = await fetch(url, { cache: "no-store", headers: await buildAuthHeaders() });
  if (!res.ok) throw new Error(`Failed to load categories (${res.status}) ${await res.text().catch(()=> "")}`);
  const data: CategoriesResponse = await res.json();
  return data.categories;
}

/* -------------------- Server actions: Users -------------------- */
export async function deactivateUserAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/users/${id}/deactivate`);
  await fetch(url, { method: "POST", headers: await buildAuthHeaders() }).catch(()=>{});
  revalidatePath("/admin");
}

export async function reactivateUserAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/users/${id}/reactivate`);
  await fetch(url, { method: "POST", headers: await buildAuthHeaders() }).catch(()=>{});
  revalidatePath("/admin");
}

export async function hardDeleteUserAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/users/${id}`);
  await fetch(url, { method: "DELETE", headers: await buildAuthHeaders() }).catch(()=>{});
  revalidatePath("/admin");
}

/* -------------------- Server actions: Creators -------------------- */
export async function featureCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}/feature`);
  await fetch(url, { method: "PATCH", headers: await buildAuthHeaders() }).catch(()=>{});
  revalidatePath("/admin");
}

export async function unfeatureCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}/unfeature`);
  await fetch(url, { method: "POST", headers: await buildAuthHeaders() }).catch(()=>{});
  revalidatePath("/admin");
}

export async function hardDeleteCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}`);
  await fetch(url, { method: "DELETE", headers: await buildAuthHeaders() }).catch(()=>{});
  revalidatePath("/admin");
}

export async function hideCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}/hide`);
  await fetch(url, { method: "POST", headers: await buildAuthHeaders() }).catch(() => {});
  revalidatePath("/admin");
}

export async function showCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}/show`);
  await fetch(url, { method: "POST", headers: await buildAuthHeaders() }).catch(() => {});
  revalidatePath("/admin");
}

/* -------------------- Server actions: Categories -------------------- */
export async function createCategoryAction(formData: FormData) {
  "use server";
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim() || null;
  if (!name) return;
  const url = await apiUrl("/api/admin/categories");
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await buildAuthHeaders()) },
    body: JSON.stringify({ name, slug }),
  }).catch(()=>{});
  revalidatePath("/admin");
}

export async function updateCategoryAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim() || null;
  const slug = String(formData.get("slug") ?? "").trim() || null;
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/categories/${id}`);
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await buildAuthHeaders()) },
    body: JSON.stringify({ name, slug }),
  }).catch(()=>{});
  revalidatePath("/admin");
}

export async function toggleCategoryActiveAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  const nextActive = String(formData.get("nextActive") ?? "") === "true";
  if (!Number.isFinite(id)) return;
  // Toggle using the public categories PATCH but still include /api prefix.
  const url = await apiUrl(`/api/categories/${id}`);
  await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await buildAuthHeaders()) },
    body: JSON.stringify({ active: nextActive }),
  }).catch(()=>{});
  revalidatePath("/admin");
}

export async function deleteCategoryAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/categories/${id}`);
  await fetch(url, { method: "DELETE", headers: await buildAuthHeaders() }).catch(()=>{});
  revalidatePath("/admin");
}

/* -------------------- Page -------------------- */
export default async function AdminDashboardPage() {
  const [users, creators, categories] = await Promise.all([
    fetchUsers(),
    fetchCreators(),
    fetchCategories(),
  ]);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Admin Dashboard</h1>

      {/* USERS */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Users</h2>
        <div className="overflow-x-auto border rounded-xl">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="p-2 text-left">ID</th>
                <th className="p-2 text-left">Email</th>
                <th className="p-2 text-left">Role</th>
                <th className="p-2 text-left">Active</th>
                <th className="p-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="p-2">{u.id}</td>
                  <td className="p-2">{u.email}</td>
                  <td className="p-2">{u.role}</td>
                  <td className="p-2">{u.is_active ? "Yes" : "No"}</td>
                  <td className="p-2 space-x-2">
                    {u.is_active ? (
                      <form action={deactivateUserAction} className="inline">
                        <input type="hidden" name="id" value={u.id} />
                        <button className="px-2 py-1 border rounded">Deactivate</button>
                      </form>
                    ) : (
                      <form action={reactivateUserAction} className="inline">
                        <input type="hidden" name="id" value={u.id} />
                        <button className="px-2 py-1 border rounded">Reactivate</button>
                      </form>
                    )}
                    <form action={hardDeleteUserAction} className="inline">
                      <input type="hidden" name="id" value={u.id} />
                      <button className="px-2 py-1 border rounded">Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td className="p-3 text-center opacity-70" colSpan={5}>
                    No users.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* CREATORS */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Creators</h2>
        <div className="overflow-x-auto border rounded-xl">
          <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="p-2 text-left">ID</th>
                  <th className="p-2 text-left">Email</th>
                  <th className="p-2 text-left">Display name</th>
                  <th className="p-2 text-left">Featured</th>
                  <th className="p-2 text-left">Listed</th>
                  <th className="p-2 text-left">Active</th>
                  <th className="p-2 text-left">Actions</th>
                </tr>
              </thead>
            <tbody>
                {creators.map((c) => {
                  const isFeatured = Boolean(c.is_featured || c.featured);
                  const isListed = c.is_listed ?? true;
                  return (
                    <tr key={c.id} className="border-t">
                      <td className="p-2">{c.id}</td>
                      <td className="p-2">{c.email}</td>
                      <td className="p-2">{c.display_name || "-"}</td>
                      <td className="p-2">{isFeatured ? "Yes" : "No"}</td>
                      <td className="p-2">{isListed ? "Yes" : "No"}</td>
                      <td className="p-2">
                        {c.user_active && c.creator_active ? "Yes" : "No"}
                      </td>
                      <td className="p-2 space-x-2">
                        {isFeatured ? (
                          <form action={unfeatureCreatorAction} className="inline">
                            <input type="hidden" name="id" value={c.id} />
                            <button className="px-2 py-1 border rounded">Unfeature</button>
                          </form>
                        ) : (
                          <form action={featureCreatorAction} className="inline">
                            <input type="hidden" name="id" value={c.id} />
                            <button className="px-2 py-1 border rounded">Feature</button>
                          </form>
                        )}

                        {isListed ? (
                          <form action={hideCreatorAction} className="inline">
                            <input type="hidden" name="id" value={c.id} />
                            <button className="px-2 py-1 border rounded">Hide</button>
                          </form>
                        ) : (
                          <form action={showCreatorAction} className="inline">
                            <input type="hidden" name="id" value={c.id} />
                            <button className="px-2 py-1 border rounded">Show</button>
                          </form>
                        )}

                        <form action={hardDeleteCreatorAction} className="inline">
                          <input type="hidden" name="id" value={c.id} />
                          <button className="px-2 py-1 border rounded">Delete</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              {creators.length === 0 && (
                <tr>
                  <td className="p-3 text-center opacity-70" colSpan={7}>
                    No creators.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* CATEGORIES */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Categories</h2>

        {/* Create */}
        <form action={createCategoryAction} className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col">
            <label className="text-sm opacity-70">Name</label>
            <input name="name" required className="border rounded px-3 py-2" />
          </div>
          <div className="flex flex-col">
            <label className="text-sm opacity-70">Slug</label>
            <input name="slug" className="border rounded px-3 py-2" />
          </div>
          <button className="border rounded px-3 py-2">Add</button>
        </form>

        {/* List/Edit/Toggle/Delete */}
        <div className="space-y-2">
          {categories.map((cat) => (
            <div
              key={cat.id}
              className="flex flex-col sm:flex-row sm:items-center gap-3 border rounded-2xl p-3"
            >
              {/* Edit */}
              <form action={updateCategoryAction} className="flex flex-wrap gap-2 items-end">
                <input type="hidden" name="id" value={cat.id} />
                <div className="flex flex-col">
                  <label className="text-sm opacity-70">Name</label>
                  <input name="name" defaultValue={cat.name} className="border rounded px-3 py-2" />
                </div>
                <div className="flex flex-col">
                  <label className="text-sm opacity-70">Slug</label>
                  <input
                    name="slug"
                    defaultValue={cat.slug ?? ""}
                    className="border rounded px-3 py-2"
                  />
                </div>
                <button className="border rounded px-3 py-2">Save</button>
              </form>

              {/* Toggle active */}
              <form action={toggleCategoryActiveAction} className="ml-0 sm:ml-auto">
                <input type="hidden" name="id" value={cat.id} />
                <input
                  type="hidden"
                  name="nextActive"
                  value={(!cat.active).toString()}
                />
                <button className="border rounded px-3 py-2">
                  {cat.active ? "Deactivate" : "Activate"}
                </button>
              </form>

              {/* Delete */}
              <form action={deleteCategoryAction}>
                <input type="hidden" name="id" value={cat.id} />
                <button className="border rounded px-3 py-2">Delete</button>
              </form>
            </div>
          ))}

          {categories.length === 0 && (
            <div className="p-4 text-center opacity-70 border rounded-2xl">
              No categories yet.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
