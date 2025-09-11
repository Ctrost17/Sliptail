"use client";

import Link from "next/link";

export default function AdminHome() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Admin Portal</h1>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link href="/admin/users" className="border rounded-2xl p-4 shadow hover:shadow-md">
          <div className="text-lg font-medium">Users</div>
          <div className="text-sm opacity-70">View & delete users</div>
        </Link>
        <Link href="/admin/creators" className="border rounded-2xl p-4 shadow hover:shadow-md">
          <div className="text-lg font-medium">Creators</div>
          <div className="text-sm opacity-70">Feature creators</div>
        </Link>
        <Link href="/admin/categories" className="border rounded-2xl p-4 shadow hover:shadow-md">
          <div className="text-lg font-medium">Categories</div>
          <div className="text-sm opacity-70">Add / Edit / Remove</div>
        </Link>
      </div>
    </div>
  );
}