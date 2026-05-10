import type { ProviderProfile } from "@/provider/types";

export type ProviderReadiness =
  | "ready"
  | "missingProvider"
  | "missingApiKey"
  | "missingBaseURL"
  | "missingTextModel"
  | "invalidActiveProvider";

type ProviderNotReady = Exclude<ProviderReadiness, "ready">;

export type ProviderReadinessResult =
  | {
      readiness: "ready";
      profile: ProviderProfile;
    }
  | {
      readiness: ProviderNotReady;
      profile?: never;
    };

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function evaluateProviderReadiness(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): ProviderReadinessResult {
  if (!hasText(activeProviderId)) {
    return { readiness: "missingProvider" };
  }

  const profile = profiles.find((candidate) => candidate.id === activeProviderId);
  if (!profile) {
    return { readiness: "invalidActiveProvider" };
  }

  if (!hasText(profile.apiKey)) {
    return { readiness: "missingApiKey" };
  }

  if (!hasText(profile.baseURL)) {
    return { readiness: "missingBaseURL" };
  }

  if (!hasText(profile.textModel)) {
    return { readiness: "missingTextModel" };
  }

  return { readiness: "ready", profile };
}

export function resolveReadyProviderProfile(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): ProviderProfile | undefined {
  const result = evaluateProviderReadiness(profiles, activeProviderId);
  return result.readiness === "ready" ? result.profile : undefined;
}

export function formatProviderLabel(profile: ProviderProfile | undefined): string {
  if (!profile) {
    return "未配置翻译服务";
  }

  try {
    return `${profile.displayName} / ${new URL(profile.baseURL).host}`;
  } catch {
    return profile.displayName;
  }
}
