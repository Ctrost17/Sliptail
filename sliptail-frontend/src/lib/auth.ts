export type SafeUser = {
  id: number;
  email: string;
  username: string | null;
  role: "user" | "creator" | "admin";
  email_verified_at: string | null;
  created_at: string;
};

export type AuthState = {
  token: string | null;
  user: SafeUser | null;
};

export type LoginResponse = { token: string; user: SafeUser };

// Canonical key
const KEY = "auth";

// Legacy keys we’ll migrate from
const LEGACY_KEY = "sliptail.auth";
const LEGACY_TOKEN_KEY = "token";

/** Safely parse JSON and return undefined on failure */
function safeParse<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Normalize unknown object into AuthState */
function normalize(input: unknown): AuthState {
  if (typeof input === "object" && input !== null) {
    const maybe = input as Record<string, unknown>;
    const token = typeof maybe.token === "string" ? maybe.token : null;
    const user =
      typeof maybe.user === "object" && maybe.user !== null
        ? (maybe.user as SafeUser)
        : null;
    return { token, user };
  }
  return { token: null, user: null };
}

/** Read {token,user} from localStorage (with migration) */
export function loadAuth(): AuthState {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return { token: null, user: null };
  }

  // 1) Canonical key
  const current = safeParse<AuthState>(localStorage.getItem(KEY));
  if (current) return normalize(current);

  // 2) Legacy object
  const legacy = safeParse<AuthState>(localStorage.getItem(LEGACY_KEY));
  if (legacy) {
    const normalized = normalize(legacy);
    try {
      localStorage.setItem(KEY, JSON.stringify(normalized));
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* no-op */
    }
    return normalized;
  }

  // 3) Stray token
  const strayToken = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (strayToken && strayToken.trim()) {
    const migrated: AuthState = { token: strayToken, user: null };
    try {
      localStorage.setItem(KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch {
      /* no-op */
    }
    return migrated;
  }

  return { token: null, user: null };
}

/** Persist {token,user} */
export function saveAuth(state: AuthState): void {
  if (typeof window === "undefined" || !("localStorage" in window)) return;
  const normalized = normalize(state);
  try {
    localStorage.setItem(KEY, JSON.stringify(normalized));
  } catch {
    /* no-op */
  }
}

/** Clear all keys */
export function clearAuth(): void {
  if (typeof window === "undefined" || !("localStorage" in window)) return;
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* no-op */
  }
}