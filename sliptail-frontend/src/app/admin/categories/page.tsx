import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { apiUrl } from "../_lib/api";

interface Category {
  id: number;
  name: string;
  slug: string | null;
  active: boolean;
  created_at: string;
}

interface CategoriesResponse {
  categories: Category[];
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

async function fetchCategories(): Promise<Category[]> {
  const url = await apiUrl("/api/admin/categories");
  const res = await fetch(url, {
    cache: "no-store",
    headers: await buildAuthHeaders(),
  });
  if (!res.ok) throw new Error("Failed to load categories");
  const data: CategoriesResponse = await res.json();
  return data.categories;
}

/* --------------------------- Server Actions --------------------------- */

export async function createCategoryAction(formData: FormData): Promise<void> {
  "use server";
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim() || null;
  if (!name) return;

  const url = await apiUrl("/api/admin/categories");
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await buildAuthHeaders()) },
    body: JSON.stringify({ name, slug }),
  }).catch(() => {});

  revalidatePath("/admin/categories");
}

export async function updateCategoryAction(formData: FormData): Promise<void> {
  "use server";
  const idRaw = formData.get("id");
  const name = String(formData.get("name") ?? "").trim() || null;
  const slug = String(formData.get("slug") ?? "").trim() || null;

  const id = Number(idRaw);
  if (!Number.isFinite(id)) return;

  const url = await apiUrl(`/api/admin/categories/${id}`);
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await buildAuthHeaders()) },
    body: JSON.stringify({ name, slug }),
  }).catch(() => {});

  revalidatePath("/admin/categories");
}

export async function toggleActiveAction(formData: FormData): Promise<void> {
  "use server";
  const idRaw = formData.get("id");
  const nextActive = String(formData.get("nextActive") ?? "") === "true";

  const id = Number(idRaw);
  if (!Number.isFinite(id)) return;

  // Uses your protected PATCH in routes/categories.js
  const url = await apiUrl(`/api/categories/${id}`);
  await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await buildAuthHeaders()) },
    body: JSON.stringify({ active: nextActive }),
  }).catch(() => {});

  revalidatePath("/admin/categories");
}

export async function deleteCategoryAction(formData: FormData): Promise<void> {
  "use server";
  const idRaw = formData.get("id");
  const id = Number(idRaw);
  if (!Number.isFinite(id)) return;

  const url = await apiUrl(`/api/admin/categories/${id}`);
  await fetch(url, {
    method: "DELETE",
    headers: await buildAuthHeaders(),
  }).catch(() => {});

  revalidatePath("/admin/categories");
}

/* ------------------------------- Page -------------------------------- */

export default async function CategoriesPage() {
  const categories = await fetchCategories();

  return (
    <div className="space-y-6">
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

      {/* List / Edit / Toggle / Delete */}
      <div className="space-y-2">
        {categories.map((cat) => (
          <div key={cat.id} className="flex flex-col sm:flex-row sm:items-center gap-3 border rounded-2xl p-3">
            {/* Edit Name/Slug */}
            <form action={updateCategoryAction} className="flex flex-wrap gap-2 items-end">
              <input type="hidden" name="id" value={cat.id} />
              <div className="flex flex-col">
                <label className="text-sm opacity-70">Name</label>
                <input name="name" defaultValue={cat.name} className="border rounded px-3 py-2" />
              </div>
              <div className="flex flex-col">
                <label className="text-sm opacity-70">Slug</label>
                <input name="slug" defaultValue={cat.slug ?? ""} className="border rounded px-3 py-2" />
              </div>
              <button className="border rounded px-3 py-2">Save</button>
            </form>

            {/* Toggle Active */}
            <form action={toggleActiveAction} className="ml-0 sm:ml-auto">
              <input type="hidden" name="id" value={cat.id} />
              <input type="hidden" name="nextActive" value={(!cat.active).toString()} />
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
          <div className="p-4 text-center opacity-70 border rounded-2xl">No categories yet.</div>
        )}
      </div>
    </div>
  );
}