"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import { api, setAuthToken } from "@/lib/api";
import { loadAuth, saveAuth, clearAuth, AuthState, SafeUser } from "@/lib/auth";
import { startInactivityWatch, markActivity } from "@/lib/auth"; // already present
import axios from "axios";

type AuthContextType = {
  user: SafeUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (
    email: string,
    password: string,
    username?: string
  ) => Promise<"verify-sent">;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

// Shallow “meaningful” equality: same token and same user id (or both null)
function sameAuth(a: AuthState, b: AuthState) {
  const tEqual = a.token === b.token;
  const aId = a.user?.id ?? null;
  const bId = b.user?.id ?? null;
  return tEqual && aId === bId;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [{ user, token }, setAuth] = useState<AuthState>({
    user: null,
    token: null,
  });
  const [loading, setLoading] = useState(true);

  // Track last applied state to avoid re-applying same thing.
  const lastAppliedRef = useRef<AuthState>({ user: null, token: null });

  const fetchMe = useCallback(async (): Promise<SafeUser> => {
    const { data } = await api.get<{ user: SafeUser }>("/auth/me");
    return data.user;
  }, []);

  /** Apply new auth state if it actually changed */
  const applyAuthState = useCallback((next: AuthState) => {
    if (sameAuth(next, lastAppliedRef.current)) {
      return; // nothing meaningful changed; skip writes & state updates
    }
    const tok = next.token ?? null;
    setAuthToken(tok);
    setAuth(next);
    saveAuth(next);
    lastAppliedRef.current = next;

    // ⬅️ added: stamp activity whenever auth is applied (e.g., login/rehydrate)
    if (tok) markActivity();
  }, []);

  /** Clear auth everywhere */
  const clearAllAuth = useCallback(() => {
    clearAuth();
    try {
      localStorage.removeItem("token");
    } catch {
      /* no-op */
    }
    const cleared: AuthState = { user: null, token: null };
    setAuth(cleared);
    setAuthToken(null);
    lastAppliedRef.current = cleared;
  }, []);

  /**
   * Read from localStorage, attach token, fetch /auth/me if needed,
   * and normalize through applyAuthState — but only if changed.
   */
const rehydrateFromLocal = useCallback(async () => {
  const stored = loadAuth();

  // 1) Try to pick up a stored/bare token first
  let tok = stored.token || null;
  if (!tok) {
    const strayToken =
      typeof window !== "undefined"
        ? window.localStorage.getItem("token")
        : null;
    if (strayToken) tok = strayToken;
  }

  // 2) If we *do* have a token, use it as before
  if (tok) {
    if (stored.user) {
      const next: AuthState = { token: tok, user: stored.user };
      applyAuthState(next);
      return;
    }
    // fetch user with bearer if we only have token
    setAuthToken(tok);
    try {
      const me = await fetchMe();
      applyAuthState({ token: tok, user: me });
    } catch {
      clearAllAuth();
    }
    return;
  }

  // 3) NEW: No token? Try cookie-based session (Google OAuth flow)
  try {
    // axios/fetch in our helpers send cookies (withCredentials / credentials:'include')
    const me = await fetchMe();
    // We have a server session via cookie; keep token null (we don't need a bearer)
    applyAuthState({ token: null, user: me });
    return;
  } catch {
    // no cookie-based session either -> logged out
    clearAllAuth();
    return;
  }
}, [applyAuthState, clearAllAuth, fetchMe]);


  // Hydrate on mount; set up cross-tab sync via native storage event only
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await rehydrateFromLocal();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const onStorage = (e: StorageEvent) => {
      // storage events DO NOT fire in the same tab that wrote the storage.
      // So this safely picks up changes from *other* tabs.
      if (e.key === "auth" || e.key === "token") {
        void rehydrateFromLocal();
      }
      // ⬅️ added: if another tab triggers a logout (including inactivity), mirror it
      if (e.key === "auth:logout") {
        clearAllAuth();
      }
    };

    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
    };
  }, [rehydrateFromLocal, clearAllAuth]);

  // --- Actions ---

  const login = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      try {
        const { data } = await api.post<{ token: string; user: SafeUser }>(
          "/auth/login",
          { email, password }
        );
        applyAuthState({ token: data.token, user: data.user });
      } catch (e: unknown) {
        const message = axios.isAxiosError<{ error?: string }>(e)
          ? e.response?.data?.error ?? "Login failed"
          : "Login failed";
        throw new Error(message);
      } finally {
        setLoading(false);
      }
    },
    [applyAuthState]
  );

  const signup = useCallback(
    async (
      email: string,
      password: string,
      username?: string
    ): Promise<"verify-sent"> => {
      setLoading(true);
      try {
        const { data } = await api.post<{ checkEmail: boolean }>(
          "/auth/signup",
          { email, password, username }
        );
        if (data?.checkEmail) return "verify-sent";
        throw new Error("Signup failed");
      } catch (e: unknown) {
        const message = axios.isAxiosError<{ error?: string }>(e)
          ? e.response?.data?.error ?? "Signup failed"
          : "Signup failed";
        throw new Error(message);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      /* network errors ignored */
    }
    clearAllAuth();
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("auth:logout", String(Date.now()));
      }
    } catch {/* no-op */}
  }, [clearAllAuth]);

  // ⬅️ added: start/stop inactivity watcher when token changes
  const stopWatchRef = useRef<null | (() => void)>(null);
  useEffect(() => {
    // tear down any previous watcher
    if (stopWatchRef.current) {
      stopWatchRef.current();
      stopWatchRef.current = null;
    }

    if (token) {
      // start watching; on inactivity, perform a real logout
      stopWatchRef.current = startInactivityWatch(() => {
        logout();
      });
      // mark initial activity so we don't insta-timeout after login/rehydrate
      markActivity();
    }

    return () => {
      if (stopWatchRef.current) {
        stopWatchRef.current();
        stopWatchRef.current = null;
      }
    };
  }, [token, logout]);

  const value = useMemo(
    () => ({ user, token, loading, login, signup, logout }),
    [user, token, loading, login, signup, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
