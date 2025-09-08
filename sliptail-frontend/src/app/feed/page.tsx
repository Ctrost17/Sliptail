import { fetchApi } from "@/lib/api";

type Membership = {
  creator_id: number;
  status: string;
  has_access: boolean;
};

type Post = {
  id: number;
  creator_id: number;
  title: string | null;
  body: string | null;
  media_path: string | null;
  created_at: string;
};

export const revalidate = 0;

async function getMemberships() {
  const data = (await fetchApi<{ memberships: Membership[] }>("/api/memberships/mine")) as { memberships: Membership[] };
  return (data?.memberships ?? []).filter((m) => m.has_access);
}

async function getPostsForCreator(creatorId: number) {
  const data = (await fetchApi<{ posts: Post[] }>(`/api/posts/${creatorId}`)) as { posts: Post[] };
  return data?.posts ?? [];
}

export default async function MembershipFeedPage() {
  const memberships = await getMemberships();
  const postsArrays = await Promise.all(memberships.map((m) => getPostsForCreator(m.creator_id)));
  const posts = postsArrays.flat().sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));

  return (
    <main className="max-w-5xl mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold">Membership Feed</h1>
      {posts.length === 0 && <div className="text-sm text-neutral-600">No posts yet.</div>}
      {posts.map((post) => (
        <article key={post.id} className="rounded-2xl border p-3">
          <div className="text-xs opacity-70 mb-1">
            Creator #{post.creator_id} · {new Date(post.created_at).toLocaleString()}
          </div>
          {post.title && <h2 className="font-semibold">{post.title}</h2>}
          {post.media_path && (
            <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-100 mt-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={post.media_path} alt="post" className="h-full w-full object-cover" />
            </div>
          )}
          {post.body && <p className="mt-2 text-sm whitespace-pre-wrap">{post.body}</p>}
        </article>
      ))}
    </main>
  );
}