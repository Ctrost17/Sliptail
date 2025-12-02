// src/app/admin/page.tsx
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { apiUrl as maybeApiUrl } from "./_lib/api";

import ConfirmDeleteForm from "./_components/ConfirmDeleteForm";

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
  is_listed?: boolean;
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

interface UsersResponse {
  users: AdminUser[];
}
interface CreatorsResponse {
  creators: AdminCreator[];
}
interface CategoriesResponse {
  categories: Category[];
}

/* -------------------- Helpers -------------------- */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // replace spaces and symbols with "-"
    .replace(/^-+|-+$/g, ""); // trim leading/trailing "-"
}

async function apiUrl(path: string, qs?: Record<string, string>) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (typeof maybeApiUrl === "function") {
    return maybeApiUrl(normalized, qs);
  }
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const url = new URL(
    normalized.replace(/^\//, ""),
    base.endsWith("/") ? base : `${base}/`
  );
  if (qs)
    Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

type CookiePair = { name: string; value: string };

async function buildAuthHeaders(): Promise<HeadersInit> {
  const store = await cookies();
  const all = store.getAll() as ReadonlyArray<CookiePair>;
  const token = store.get("token")?.value as string | undefined;

  const cookieHeader = all
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");

  const headers: Record<string, string> = {};
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Read a page number from searchParams safely
function getPageParam(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const n = parseInt(raw || "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/* -------------------- Fetchers (SSR) -------------------- */
async function fetchUsers(): Promise<AdminUser[]> {
  // Fetch up to 500 users; we’ll paginate in memory
  const url = await apiUrl("/api/admin/users", {
    limit: "500",
    offset: "0",
  });
  const res = await fetch(url, {
    cache: "no-store",
    headers: await buildAuthHeaders(),
  });
  if (!res.ok)
    throw new Error(
      `Failed to load users (${res.status}) ${await res
        .text()
        .catch(() => "")}`
    );
  const data: UsersResponse = await res.json();
  return data.users;
}

async function fetchCreators(): Promise<AdminCreator[]> {
  // Fetch up to 500 creators; we’ll paginate in memory
  const url = await apiUrl("/api/admin/creators", {
    only_active: "true",
    limit: "500",
    offset: "0",
  });
  const res = await fetch(url, {
    cache: "no-store",
    headers: await buildAuthHeaders(),
  });
  if (!res.ok)
    throw new Error(
      `Failed to load creators (${res.status}) ${await res
        .text()
        .catch(() => "")}`
    );
  const data: CreatorsResponse = await res.json();
  return data.creators;
}

async function fetchCategories(): Promise<Category[]> {
  const url = await apiUrl("/api/admin/categories");
  const res = await fetch(url, {
    cache: "no-store",
    headers: await buildAuthHeaders(),
  });
  if (!res.ok)
    throw new Error(
      `Failed to load categories (${res.status}) ${await res
        .text()
        .catch(() => "")}`
    );
  const data: CategoriesResponse = await res.json();
  return data.categories;
}

/* -------------------- Server actions: Users -------------------- */
export async function deactivateUserAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/users/${id}/deactivate`);
  await fetch(url, {
    method: "POST",
    headers: await buildAuthHeaders(),
  }).catch(() => {});
  revalidatePath("/admin");
}

export async function reactivateUserAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/users/${id}/reactivate`);
  await fetch(url, {
    method: "POST",
    headers: await buildAuthHeaders(),
  }).catch(() => {});
  revalidatePath("/admin");
}

export async function hardDeleteUserAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/users/${id}`);
  const res = await fetch(url, {
    method: "DELETE",
    headers: await buildAuthHeaders(),
  }).catch((err) => {
    console.error("hardDeleteUserAction fetch error", err);
  });

  if (res && !res.ok) {
    const text = await res.text().catch(() => "");
    console.error("hardDeleteUserAction failed", res.status, text);
  }

  revalidatePath("/admin");
}

/* -------------------- Server actions: Creators -------------------- */
export async function featureCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}/feature`);
  await fetch(url, {
    method: "PATCH",
    headers: await buildAuthHeaders(),
  }).catch(() => {});
  revalidatePath("/admin");
}

export async function unfeatureCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}/unfeature`);
  await fetch(url, {
    method: "POST",
    headers: await buildAuthHeaders(),
  }).catch(() => {});
  revalidatePath("/admin");
}

export async function hardDeleteCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}`);
  await fetch(url, {
    method: "DELETE",
    headers: await buildAuthHeaders(),
  }).catch(() => {});
  revalidatePath("/admin");
}

export async function hideCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}/hide`);
  await fetch(url, {
    method: "POST",
    headers: await buildAuthHeaders(),
  }).catch(() => {});
  revalidatePath("/admin");
}

export async function showCreatorAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/creators/${id}/show`);
  await fetch(url, {
    method: "POST",
    headers: await buildAuthHeaders(),
  }).catch(() => {});
  revalidatePath("/admin");
}

/* -------------------- Server actions: Categories -------------------- */
export async function createCategoryAction(formData: FormData) {
  "use server";

  const rawName = String(formData.get("name") ?? "").trim();
  if (!rawName) return;

  const name = rawName;
  const slug = slugifyName(rawName); // auto-generate slug

  const url = await apiUrl("/api/admin/categories");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await buildAuthHeaders()),
    },
    body: JSON.stringify({ name, slug }),
    cache: "no-store",
  });

  const text = await res.text().catch(() => "");
  console.log("createCategoryAction", {
    url,
    status: res.status,
    body: text,
  });

  if (!res.ok) {
    return;
  }

  revalidatePath("/admin");
}

export async function updateCategoryAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!Number.isFinite(id) || !name) return;

  const url = await apiUrl(`/api/admin/categories/${id}`);
  await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(await buildAuthHeaders()),
    },
    body: JSON.stringify({ name }), // leave slug alone
  }).catch(() => {});
  revalidatePath("/admin");
}

export async function toggleCategoryActiveAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  const nextActive = String(formData.get("nextActive") ?? "") === "true";
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/categories/${id}`);
  await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await buildAuthHeaders()),
    },
    body: JSON.stringify({ active: nextActive }),
  }).catch(() => {});
  revalidatePath("/admin");
}

export async function deleteCategoryAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const url = await apiUrl(`/api/admin/categories/${id}`);
  await fetch(url, {
    method: "DELETE",
    headers: await buildAuthHeaders(),
  }).catch(() => {});
  revalidatePath("/admin");
}

/* -------------------- Page -------------------- */
export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  const [users, creators, categories] = await Promise.all([
    fetchUsers(),
    fetchCreators(),
    fetchCategories(),
  ]);

  const PER_PAGE = 20;

  // Totals
  const totalUsers = users.length;
  const totalCreators = creators.length;
  const featuredCreators = creators.filter((c) => c.is_featured).length;
  const totalCategories = categories.length;

  // Current pages
  const userTotalPages = Math.max(1, Math.ceil(totalUsers / PER_PAGE));
  const creatorTotalPages = Math.max(1, Math.ceil(totalCreators / PER_PAGE));

  const userPageRaw = getPageParam(searchParams?.userPage);
  const creatorPageRaw = getPageParam(searchParams?.creatorPage);

  const userPage = Math.min(userPageRaw, userTotalPages);
  const creatorPage = Math.min(creatorPageRaw, creatorTotalPages);

  const userStart = (userPage - 1) * PER_PAGE;
  const creatorStart = (creatorPage - 1) * PER_PAGE;

  const pagedUsers = users.slice(userStart, userStart + PER_PAGE);
  const pagedCreators = creators.slice(
    creatorStart,
    creatorStart + PER_PAGE
  );

  const makeHref = (uPage: number, cPage: number) =>
    `/admin?userPage=${uPage}&creatorPage=${cPage}`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-300 via-cyan-400 to-sky-400 px-2 py-4 sm:px-3 sm:py-6 md:py-10">
      <main className="mx-auto max-w-6xl space-y-6 rounded-3xl bg-white/90 backdrop-blur-xl px-3 py-4 shadow-2xl sm:space-y-8 sm:px-4 sm:py-6 md:px-6 md:py-7 lg:px-8 lg:py-8">
        {/* Header + summary */}
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl md:text-3xl">
              Sliptail Admin
            </h1>
            <p className="text-xs text-neutral-600 sm:text-sm">
              Overview of users, creators, and categories. Only visible to
              admins.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 text-right text-[11px] sm:text-xs md:text-sm sm:grid-cols-4">
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-2.5 py-2 sm:px-3">
              <div className="text-[9px] font-medium uppercase tracking-wide text-emerald-700">
                Users
              </div>
              <div className="text-base font-semibold text-emerald-900 sm:text-lg">
                {totalUsers}
              </div>
            </div>
            <div className="rounded-2xl border border-cyan-100 bg-cyan-50 px-2.5 py-2 sm:px-3">
              <div className="text-[9px] font-medium uppercase tracking-wide text-cyan-700">
                Creators
              </div>
              <div className="text-base font-semibold text-cyan-900 sm:text-lg">
                {totalCreators}
              </div>
            </div>
            <div className="rounded-2xl border border-sky-100 bg-sky-50 px-2.5 py-2 sm:px-3">
              <div className="text-[9px] font-medium uppercase tracking-wide text-sky-700">
                Featured
              </div>
              <div className="text-base font-semibold text-sky-900 sm:text-lg">
                {featuredCreators}
              </div>
            </div>
            <div className="rounded-2xl border border-neutral-200 bg-neutral-50 px-2.5 py-2 sm:px-3">
              <div className="text-[9px] font-medium uppercase tracking-wide text-neutral-600">
                Categories
              </div>
              <div className="text-base font-semibold text-neutral-900 sm:text-lg">
                {totalCategories}
              </div>
            </div>
          </div>
        </header>

        {/* USERS + CREATORS side by side on desktop */}
        <section className="grid gap-4 md:gap-6 lg:grid-cols-2">
          {/* USERS */}
          <section className="space-y-3 rounded-2xl border border-neutral-200 bg-white/95 p-3 shadow-sm sm:p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold sm:text-lg">Users</h2>
                <p className="text-[11px] text-neutral-500 sm:text-xs">
                  Manage basic user accounts and active status.
                </p>
              </div>
              <span className="text-[11px] text-neutral-500 sm:text-xs">
                {totalUsers} total
              </span>
            </div>

            <div className="-mx-2 overflow-x-auto rounded-xl border bg-neutral-50 sm:mx-0">
              <table className="min-w-full text-[11px] sm:text-xs md:text-sm">
                <thead className="bg-neutral-100 text-neutral-700">
                  <tr>
                    <th className="hidden p-2 text-left font-medium sm:table-cell">
                      ID
                    </th>
                    <th className="p-2 text-left font-medium">Email</th>
                    <th className="hidden p-2 text-left font-medium sm:table-cell">
                      Role
                    </th>
                    <th className="p-2 text-left font-medium">Active</th>
                    <th className="p-2 text-left font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y text-neutral-800">
                  {pagedUsers.map((user) => (
                    <tr key={user.id}>
                      <td className="hidden p-2 align-top text-[10px] text-neutral-500 sm:table-cell">
                        {user.id}
                      </td>
                      <td className="p-2 align-top break-all">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[11px] sm:text-xs">
                            {user.email}
                          </span>
                          <span className="text-[10px] text-neutral-500 sm:hidden">
                            {user.role.toUpperCase()}
                          </span>
                        </div>
                      </td>
                      <td className="hidden p-2 align-top text-[11px] uppercase tracking-wide text-neutral-600 sm:table-cell">
                        {user.role}
                      </td>
                      <td className="p-2 align-top text-[11px]">
                        {user.is_active ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-100">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 ring-1 ring-neutral-200">
                            Inactive
                          </span>
                        )}
                      </td>
                      <td className="p-2 align-top text-[11px]">
                        <div className="flex flex-wrap gap-1">
                          {user.is_active ? (
                            <form action={deactivateUserAction}>
                              <input
                                type="hidden"
                                name="id"
                                value={user.id}
                              />
                              <button
                                type="submit"
                                className="inline-flex cursor-pointer items-center rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] font-medium text-neutral-700 hover:bg-neutral-100"
                              >
                                Deactivate
                              </button>
                            </form>
                          ) : (
                            <form action={reactivateUserAction}>
                              <input
                                type="hidden"
                                name="id"
                                value={user.id}
                              />
                              <button
                                type="submit"
                                className="inline-flex cursor-pointer items-center rounded-full border border-emerald-300 px-2 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-50"
                              >
                                Reactivate
                              </button>
                            </form>
                          )}
                          <ConfirmDeleteForm
                            action={hardDeleteUserAction}
                            id={user.id}
                            confirmMessage="Are you sure you want to permanently delete this user and all their related data? This cannot be undone."
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                  {pagedUsers.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="p-3 text-center text-[11px] text-neutral-500"
                      >
                        No users on this page.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Users pagination */}
            <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-neutral-600">
              <span>
                Page {userPage} of {userTotalPages}
              </span>
              <div className="flex gap-2">
                {userPage > 1 && (
                  <Link
                    href={makeHref(userPage - 1, creatorPage)}
                    className="rounded-full border border-neutral-300 px-2 py-1 text-[10px] hover:bg-neutral-100"
                  >
                    Previous
                  </Link>
                )}
                {userPage < userTotalPages && (
                  <Link
                    href={makeHref(userPage + 1, creatorPage)}
                    className="rounded-full border border-neutral-300 px-2 py-1 text-[10px] hover:bg-neutral-100"
                  >
                    Next
                  </Link>
                )}
              </div>
            </div>
          </section>

          {/* CREATORS */}
          <section className="space-y-3 rounded-2xl border border-neutral-200 bg-white/95 p-3 shadow-sm sm:p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold sm:text-lg">
                  Creators
                </h2>
                <p className="text-[11px] text-neutral-500 sm:text-xs">
                  View creator profiles and control listing and featured
                  status.
                </p>
              </div>
              <span className="text-[11px] text-neutral-500 sm:text-xs">
                {totalCreators} total
              </span>
            </div>

            <div className="-mx-2 overflow-x-auto rounded-xl border bg-neutral-50 sm:mx-0">
              <table className="min-w-full text-[11px] sm:text-xs md:text-sm">
                <thead className="bg-neutral-100 text-neutral-700">
                  <tr>
                    <th className="hidden p-2 text-left font-medium md:table-cell">
                      ID
                    </th>
                    <th className="p-2 text-left font-medium">Creator</th>
                    <th className="hidden p-2 text-left font-medium md:table-cell">
                      User
                    </th>
                    <th className="hidden p-2 text-left font-medium sm:table-cell">
                      Profile
                    </th>
                    <th className="p-2 text-left font-medium">Featured</th>
                    <th className="hidden p-2 text-left font-medium sm:table-cell">
                      Listed
                    </th>
                    <th className="p-2 text-left font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y text-neutral-800">
                  {pagedCreators.map((creator) => (
                    <tr key={creator.id}>
                      <td className="hidden p-2 align-top text-[10px] text-neutral-500 md:table-cell">
                        {creator.id}
                      </td>
                      <td className="p-2 align-top">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[11px] font-medium sm:text-xs">
                            {creator.display_name || "Untitled"}
                          </span>
                          <span className="text-[10px] text-neutral-500">
                            {creator.email}
                          </span>
                          {/* On mobile show small status pills under creator */}
                          <div className="mt-1 flex flex-wrap gap-1 sm:hidden">
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-medium ring-1 ${
                                creator.creator_active
                                  ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
                                  : "bg-neutral-100 text-neutral-600 ring-neutral-200"
                              }`}
                            >
                              {creator.creator_active
                                ? "Profile active"
                                : "Profile inactive"}
                            </span>
                            {creator.is_featured && (
                              <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-[9px] font-medium text-sky-700 ring-1 ring-sky-100">
                                Featured
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="hidden p-2 align-top text-[11px] md:table-cell">
                        {creator.user_active ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-100">
                            User active
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 ring-1 ring-neutral-200">
                            User inactive
                          </span>
                        )}
                      </td>
                      <td className="hidden p-2 align-top text-[11px] sm:table-cell">
                        {creator.creator_active ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-100">
                            Profile active
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 ring-1 ring-neutral-200">
                            Profile inactive
                          </span>
                        )}
                      </td>
                      <td className="p-2 align-top text-[11px]">
                        {creator.is_featured ? (
                          <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700 ring-1 ring-sky-100">
                            Featured
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 ring-1 ring-neutral-200">
                            Not featured
                          </span>
                        )}
                      </td>
                      <td className="hidden p-2 align-top text-[11px] sm:table-cell">
                        {creator.is_listed ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-100">
                            Listed
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 ring-1 ring-neutral-200">
                            Hidden
                          </span>
                        )}
                      </td>
                      <td className="p-2 align-top text-[11px]">
                        <div className="flex flex-wrap gap-1">
                          {creator.is_featured ? (
                            <form action={unfeatureCreatorAction}>
                              <input
                                type="hidden"
                                name="id"
                                value={creator.id}
                              />
                              <button
                                type="submit"
                                className="inline-flex cursor-pointer items-center rounded-full border border-sky-300 px-2 py-0.5 text-[10px] font-medium text-sky-700 hover:bg-sky-50"
                              >
                                Unfeature
                              </button>
                            </form>
                          ) : (
                            <form action={featureCreatorAction}>
                              <input
                                type="hidden"
                                name="id"
                                value={creator.id}
                              />
                              <button
                                type="submit"
                                className="inline-flex cursor-pointer items-center rounded-full border border-sky-300 px-2 py-0.5 text-[10px] font-medium text-sky-700 hover:bg-sky-50"
                              >
                                Feature
                              </button>
                            </form>
                          )}

                          {creator.is_listed ? (
                            <form action={hideCreatorAction}>
                              <input
                                type="hidden"
                                name="id"
                                value={creator.id}
                              />
                              <button
                                type="submit"
                                className="inline-flex cursor-pointer items-center rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] font-medium text-neutral-700 hover:bg-neutral-100"
                              >
                                Hide
                              </button>
                            </form>
                          ) : (
                            <form action={showCreatorAction}>
                              <input
                                type="hidden"
                                name="id"
                                value={creator.id}
                              />
                              <button
                                type="submit"
                                className="inline-flex cursor-pointer items-center rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] font-medium text-neutral-700 hover:bg-neutral-100"
                              >
                                Show
                              </button>
                            </form>
                          )}
                          <ConfirmDeleteForm
                            action={hardDeleteCreatorAction}
                            id={creator.id}
                            confirmMessage="Are you sure you want to permanently delete this creator, their profile, and all related data? This cannot be undone."
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                  {pagedCreators.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="p-3 text-center text-[11px] text-neutral-500"
                      >
                        No creators on this page.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Creators pagination */}
            <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-neutral-600">
              <span>
                Page {creatorPage} of {creatorTotalPages}
              </span>
              <div className="flex gap-2">
                {creatorPage > 1 && (
                  <Link
                    href={makeHref(userPage, creatorPage - 1)}
                    className="rounded-full border border-neutral-300 px-2 py-1 text-[10px] hover:bg-neutral-100"
                  >
                    Previous
                  </Link>
                )}
                {creatorPage < creatorTotalPages && (
                  <Link
                    href={makeHref(userPage, creatorPage + 1)}
                    className="rounded-full border border-neutral-300 px-2 py-1 text-[10px] hover:bg-neutral-100"
                  >
                    Next
                  </Link>
                )}
              </div>
            </div>
          </section>
        </section>

        {/* CATEGORIES full width */}
        <section className="space-y-3 rounded-2xl border border-neutral-200 bg-white/95 p-3 shadow-sm sm:space-y-4 sm:p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-base font-semibold sm:text-lg">
                Categories
              </h2>
              <p className="text-[11px] text-neutral-500 sm:text-xs">
                Manage the categories creators can attach to their profiles.
              </p>
            </div>
            <span className="text-[11px] text-neutral-500 sm:text-xs">
              {totalCategories} total
            </span>
          </div>

          {/* Create category */}
          <form
            action={createCategoryAction}
            className="flex flex-col gap-2 rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 p-3 text-xs sm:flex-row sm:items-center sm:gap-3 sm:text-sm"
          >
            <div className="flex-1 space-y-1">
              <label className="text-[11px] font-medium text-neutral-700 sm:text-xs">
                New category name
              </label>
              <input
                type="text"
                name="name"
                placeholder="e.g. Fitness, Gaming, Coaching..."
                className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs outline-none ring-emerald-200 placeholder:text-neutral-400 focus:ring sm:text-sm"
              />
            </div>
            <button
              type="submit"
              className="inline-flex cursor-pointer items-center justify-center rounded-full bg-emerald-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 sm:text-sm"
            >
              Add category
            </button>
          </form>

          {/* Category list */}
          <div className="-mx-2 overflow-x-auto rounded-xl border bg-neutral-50 sm:mx-0">
            <table className="min-w-full text-[11px] sm:text-xs md:text-sm">
              <thead className="bg-neutral-100 text-neutral-700">
                <tr>
                  <th className="hidden p-2 text-left font-medium sm:table-cell">
                    ID
                  </th>
                  <th className="p-2 text-left font-medium">Name</th>
                  <th className="hidden p-2 text-left font-medium sm:table-cell">
                    Slug
                  </th>
                  <th className="p-2 text-left font-medium">Active</th>
                  <th className="p-2 text-left font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y text-neutral-800">
                {categories.map((category) => (
                  <tr key={category.id}>
                    <td className="hidden p-2 align-top text-[10px] text-neutral-500 sm:table-cell">
                      {category.id}
                    </td>
                    <td className="p-2 align-top">
                      <form
                        action={updateCategoryAction}
                        className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2"
                      >
                        <input type="hidden" name="id" value={category.id} />
                        <input
                          type="text"
                          name="name"
                          defaultValue={category.name}
                          className="w-full rounded-lg border border-neutral-300 bg-white px-2 py-1 text-[11px] outline-none ring-emerald-200 focus:ring sm:text-xs"
                        />
                      </form>
                    </td>
                    <td className="hidden p-2 align-top text-[11px] text-neutral-600 sm:table-cell">
                      {category.slug}
                    </td>
                    <td className="p-2 align-top text-[11px]">
                      <form action={toggleCategoryActiveAction}>
                        <input
                          type="hidden"
                          name="id"
                          value={category.id}
                        />
                        <input
                          type="hidden"
                          name="nextActive"
                          value={category.active ? "false" : "true"}
                        />
                        <button
                          type="submit"
                          className={`inline-flex cursor-pointer items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${
                            category.active
                              ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
                              : "bg-neutral-100 text-neutral-600 ring-neutral-200"
                          }`}
                        >
                          {category.active ? "Active" : "Inactive"}
                        </button>
                      </form>
                    </td>
                    <td className="p-2 align-top text-[11px]">
                      <form action={deleteCategoryAction}>
                        <input type="hidden" name="id" value={category.id} />
                        <button
                          type="submit"
                          className="cursor-pointer rounded-full border border-red-200 px-2 py-1 text-[10px] font-medium text-red-600 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
