// src/app/admin/_components/ConfirmDeleteForm.tsx
"use client";

import { useState, useTransition, useEffect } from "react";
import { createPortal } from "react-dom";

type Props = {
  id: number;
  action: (formData: FormData) => Promise<void> | void;
  confirmMessage: string;
};

export default function ConfirmDeleteForm({
  id,
  action,
  confirmMessage,
}: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (open) {
      // Prevent body scroll when modal is open
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const onConfirm = () => {
    startTransition(() => {
      const fd = new FormData();
      fd.append("id", String(id));
      action(fd);
    });
    setOpen(false);
  };

  const modalContent = open ? (
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
      style={{ position: 'fixed' }}
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl">
        <h3 className="mb-2 text-sm font-semibold text-neutral-900">
          Confirm delete
        </h3>
        <p className="mb-4 text-xs text-neutral-700">{confirmMessage}</p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={isPending}
            className="inline-flex cursor-pointer items-center rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-default disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="inline-flex cursor-pointer items-center rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-default disabled:opacity-60"
          >
            {isPending ? "Deleting..." : "Yes, delete"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex cursor-pointer items-center rounded-full border border-red-300 px-2 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-50"
      >
        Delete
      </button>

      {/* Render modal in a portal at document.body level */}
      {mounted && modalContent && createPortal(modalContent, document.body)}
    </>
  );
}