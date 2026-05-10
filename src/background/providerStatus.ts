import type { BackgroundResponse } from "@/messaging/contracts";
import {
  evaluateProviderReadiness,
  formatProviderLabel,
  resolveReadyProviderProfile,
} from "@/provider/readiness";
import type { ProviderProfile } from "@/provider/types";

type StoredProviderStateDependencies = {
  loadActiveProviderId: () => Promise<string | undefined>;
  loadProfiles: () => Promise<ProviderProfile[]>;
  persistActiveProviderId: (activeProviderId: string) => Promise<void>;
};

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isCompleteProfile(profile: ProviderProfile): boolean {
  return hasText(profile.apiKey) && hasText(profile.baseURL) && hasText(profile.textModel);
}

export function selectStoredActiveProviderId(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): string | undefined {
  if (hasText(activeProviderId) && profiles.some((profile) => profile.id === activeProviderId)) {
    return activeProviderId;
  }

  return profiles.find(isCompleteProfile)?.id;
}

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
  };
}
