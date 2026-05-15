import type { BackgroundResponse } from "@/messaging/contracts";
import {
  evaluateProviderReadiness,
  formatProviderLabel,
  resolveReadyProviderProfile,
  selectStoredActiveProviderId,
} from "@/provider/readiness";
import type { ProviderProfile } from "@/provider/types";

type StoredProviderStateDependencies = {
  loadActiveProviderId: () => Promise<string | undefined>;
  loadProfiles: () => Promise<ProviderProfile[]>;
  persistActiveProviderId: (activeProviderId: string) => Promise<void>;
};

export { selectStoredActiveProviderId };

export async function getStoredProviderState(
  dependencies: StoredProviderStateDependencies,
): Promise<{
  activeProviderId: string | undefined;
  profiles: ProviderProfile[];
}> {
  const [storedActiveProviderId, profiles] = await Promise.all([
    dependencies.loadActiveProviderId(),
    dependencies.loadProfiles(),
  ]);
  const activeProviderId = selectStoredActiveProviderId(profiles, storedActiveProviderId);

  if (activeProviderId && activeProviderId !== storedActiveProviderId) {
    await dependencies.persistActiveProviderId(activeProviderId).catch(() => undefined);
  }

  return { activeProviderId, profiles };
}

export function selectReadyProviderProfile(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): ProviderProfile | undefined {
  return resolveReadyProviderProfile(profiles, activeProviderId);
}

export function buildProviderStatusResponse(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): Extract<BackgroundResponse, { type: "providerStatus" }> {
  const readiness = evaluateProviderReadiness(profiles, activeProviderId);

  return {
    type: "providerStatus",
    configured: readiness.readiness === "ready",
    readiness: readiness.readiness,
    providerLabel: formatProviderLabel(readiness.profile),
    providerMode:
      readiness.readiness === "ready" && readiness.profile.type === "chrome-built-in-ai"
        ? "local-only"
        : "remote",
  };
}
