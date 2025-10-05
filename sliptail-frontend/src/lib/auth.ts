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
  lastActivity?: number | null; // track client activity
};

export type LoginResponse = { token: string; user: SafeUser };

export const INACTIVITY_LIMIT_MS = 20 * 60 * 1000; // 20 minutes

// Track last client activity in the stored auth object
declare module "./auth" {} // keep TS happy if path-based tooling

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
    const lastActivity =
      typeof maybe.lastActivity === "number" ? maybe.lastActivity : null;
    return { token, user, lastActivity };
  }
  return { token: null, user: null, lastActivity: null };
}

function isExpired(state: AuthState, limitMs = INACTIVITY_LIMIT_MS): boolean {
  if (!state?.token) return false;
  const last = typeof state.lastActivity === "number" ? state.lastActivity : 0;
  if (!last) return false;
  return Date.now() - last >= limitMs;
}

/** Read {token,user} from localStorage (with migration) */
export function loadAuth(): AuthState {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return { token: null, user: null, lastActivity: null };
  }

  // 1) Canonical key
  const current = safeParse<AuthState>(localStorage.getItem(KEY));
  if (current) {
    const normalized = normalize(current);
    if (isExpired(normalized)) {
      // auto-logout: wipe and return empty
      try { localStorage.removeItem(KEY); } catch {}
      return { token: null, user: null, lastActivity: null };
    }
    return normalized;
  }

  // 2) Legacy object
  const legacy = safeParse<AuthState>(localStorage.getItem(LEGACY_KEY));
  if (legacy) {
    const normalized = normalize(legacy);
    if (isExpired(normalized)) {
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {}
      return { token: null, user: null, lastActivity: null };
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(normalized));
      localStorage.removeItem(LEGACY_KEY);
    } catch {}
    return normalized;
  }

  // 3) Stray token
  const strayToken = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (strayToken && strayToken.trim()) {
    const migrated: AuthState = { token: strayToken, user: null, lastActivity: Date.now() };
    try {
      localStorage.setItem(KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch {}
    return migrated;
  }

  return { token: null, user: null, lastActivity: null };
}

/** Persist {token,user} and stamp lastActivity */
export function saveAuth(state: AuthState): void {
  if (typeof window === "undefined" || !("localStorage" in window)) return;
  const normalized = normalize(state);
  const withTs: AuthState = { ...normalized, lastActivity: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(withTs));
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

/** Touch only lastActivity without changing token/user */
export function markActivity(): void {
  if (typeof window === "undefined" || !("localStorage" in window)) return;
  const current = safeParse<AuthState>(localStorage.getItem(KEY)) || { token: null, user: null };
  if (!current?.token) return; // don't stamp if logged out
  const updated: AuthState = { ...normalize(current), lastActivity: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(updated));
  } catch {}
}

/** Returns ms remaining until auto-logout (or Infinity if not logged in) */
export function inactivityRemainingMs(limitMs = INACTIVITY_LIMIT_MS): number {
  const st = loadAuth();
  if (!st.token) return Number.POSITIVE_INFINITY;
  const last = typeof st.lastActivity === "number" ? st.lastActivity : 0;
  if (!last) return limitMs;
  return Math.max(0, limitMs - (Date.now() - last));
}

/**
 * Installs inactivity listeners + timeout.
 * Call once (e.g., in AuthProvider) and keep/dispose the returned cleanup.
 */
export function startInactivityWatch(onExpire: () => void, limitMs = INACTIVITY_LIMIT_MS) {
  if (typeof window === "undefined") return () => {};

  let timer: number | null = null;

  const reset = () => {
    // If tab is hidden, don't reset just because of background churn
    if (document.hidden) return;
    markActivity();
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const st = loadAuth();
      if (isExpired(st, limitMs)) {
        clearAuth();
        onExpire();
      }
    }, limitMs);
  };

  // Window-level activity
  const WIN_EVENTS: (keyof WindowEventMap)[] = [
    "click",
    "mousemove",
    "keydown",
    "scroll",
    "touchstart",
  ];
  WIN_EVENTS.forEach((ev) => window.addEventListener(ev, reset as EventListener, { passive: true }));

  // Document visibility (must be on document, not window)
  const onVisibility = () => reset();
  document.addEventListener("visibilitychange", onVisibility);

  // --- Treat media playback as activity (so watching a long video/audio doesn't log you out) ---
  let mediaHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let playingMediaCount = 0;

  const onMediaPlay = (e: Event) => {
    const el = e.target as HTMLMediaElement | null;
    if (!el) return;
    playingMediaCount += 1;
    markActivity(); // immediate stamp when playback starts

    if (!mediaHeartbeatTimer) {
      mediaHeartbeatTimer = setInterval(() => {
        if (!document.hidden && playingMediaCount > 0) {
          markActivity();
        }
      }, 60_000); // once per minute is enough
    }
  };

  const onMediaStop = (e: Event) => {
    const el = e.target as HTMLMediaElement | null;
    if (!el) return;
    if (playingMediaCount > 0) playingMediaCount -= 1;
    if (playingMediaCount === 0 && mediaHeartbeatTimer) {
      clearInterval(mediaHeartbeatTimer);
      mediaHeartbeatTimer = null;
    }
  };

  // Capture media events on the document so it works for all audio/video elements
  document.addEventListener("play", onMediaPlay, true);
  document.addEventListener("pause", onMediaStop, true);
  document.addEventListener("ended", onMediaStop, true);
  document.addEventListener("emptied", onMediaStop, true);
  document.addEventListener("abort", onMediaStop, true);
  document.addEventListener("error", onMediaStop, true);

  // initialize
  reset();

  // Cleanup
  return () => {
    if (timer) window.clearTimeout(timer);
    WIN_EVENTS.forEach((ev) => window.removeEventListener(ev, reset as EventListener));
    document.removeEventListener("visibilitychange", onVisibility);

    // cleanup media listeners + heartbeat
    document.removeEventListener("play", onMediaPlay, true);
    document.removeEventListener("pause", onMediaStop, true);
    document.removeEventListener("ended", onMediaStop, true);
    document.removeEventListener("emptied", onMediaStop, true);
    document.removeEventListener("abort", onMediaStop, true);
    document.removeEventListener("error", onMediaStop, true);
    if (mediaHeartbeatTimer) {
      clearInterval(mediaHeartbeatTimer);
      mediaHeartbeatTimer = null;
    }
    playingMediaCount = 0;
  };
}
