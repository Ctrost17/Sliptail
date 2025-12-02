import { useEffect, useState } from "react";

export type AgencyConfig = {
  brandName: string;
  logoUrl: string | null;
  primaryColor: string;
  supportEmail: string;
  supportUrl: string;
  termsUrl: string;
  privacyUrl: string;
  isSliptail: boolean;
};

export function useAgencyConfig() {
  const [config, setConfig] = useState<AgencyConfig | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/agency/config", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) setConfig(data);
      } catch (err) {
        console.error("Failed to load agency config", err);
        if (!cancelled) {
          setConfig({
            brandName: "Sliptail",
            logoUrl: "/sliptail-logofull.png",
            primaryColor: "#10b981",
            supportEmail: "info@sliptail.com",
            supportUrl: "/support",
            termsUrl: "/terms",
            privacyUrl: "/privacy",
            isSliptail: true,
          });
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
