import type { BackgroundResponse } from "@/messaging/contracts";
import {
  evaluateProviderReadiness,
  formatProviderLabel,
  resolveReadyProviderProfile,
} from "@/provider/readiness";
import type { ProviderProfile } from "@/provider/types";

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
