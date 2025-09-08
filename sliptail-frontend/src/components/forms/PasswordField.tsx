"use client";
import { useState, InputHTMLAttributes, forwardRef } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label?: string;
  error?: string;
};

const Eye = ({ className = "h-5 w-5" }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M1.5 12S5 4.5 12 4.5 22.5 12 22.5 12 19 19.5 12 19.5 1.5 12 1.5 12Z"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const EyeOff = ({ className = "h-5 w-5" }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    <path
      d="M4.5 7.5S7.5 4.5 12 4.5c4.5 0 7.5 3 7.5 3s1.5 1.5 3 4.5c-1.5 3-3 4.5-3 4.5s-3 3-7.5 3c-4.5 0-7.5-3-7.5-3S3 12 1.5 12"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    />
  </svg>
);

const PasswordField = forwardRef<HTMLInputElement, Props>(
  ({ label = "Password", error, className = "", id, ...rest }, ref) => {
    const [visible, setVisible] = useState(false);
    const inputId = id || "password";

    return (
      <div className="w-full">
        <label htmlFor={inputId} className="block text-xs font-medium text-neutral-700">
          {label}
        </label>
        <div className="mt-1 relative">
          <input
            id={inputId}
            ref={ref}
            type={visible ? "text" : "password"}
            className={`w-full rounded-xl border px-3 py-2 pr-10 focus:outline-none focus:ring-2 focus:ring-black/20 ${className}`}
            autoComplete="current-password"
            {...rest}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="absolute inset-y-0 right-0 px-3 flex items-center text-neutral-500 hover:text-neutral-800"
            aria-label={visible ? "Hide password" : "Show password"}
            title={visible ? "Hide password" : "Show password"}
          >
            {visible ? <EyeOff /> : <Eye />}
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    );
  }
);

PasswordField.displayName = "PasswordField";
export default PasswordField;
