import {
  getChromeBuiltInAiBrowserSupport,
  type ChromeBuiltInAiBrowserSupport,
} from "@/provider/browserSupport";
import {
  isOpenAiCompatibleProviderProfile,
  type ProviderProfile,
} from "@/provider/types";

export type ProviderReadiness =
  | "ready"
  | "missingProvider"
  | "missingApiKey"
  | "missingBaseURL"
  | "missingTextModel"
  | "invalidActiveProvider"
  | "browserUnsupported";

type ProviderNotReady = Exclude<ProviderReadiness, "ready">;

export type ProviderReadinessContext = {
  chromeBuiltInAiBrowserSupport?: ChromeBuiltInAiBrowserSupport;
};

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

function isCompleteProfile(profile: ProviderProfile): boolean {
  if (profile.type === "chrome-built-in-ai") {
    return true;
  }

  if (!isOpenAiCompatibleProviderProfile(profile)) {
    return false;
  }

  return hasText(profile.apiKey) && hasText(profile.baseURL) && hasText(profile.textModel);
}

function isChromeBuiltInAiSupported(context: ProviderReadinessContext): boolean {
  return (
    context.chromeBuiltInAiBrowserSupport ?? getChromeBuiltInAiBrowserSupport()
  ).supported;
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

export function evaluateProviderReadiness(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
  context: ProviderReadinessContext = {},
): ProviderReadinessResult {
  if (!hasText(activeProviderId)) {
    return { readiness: "missingProvider" };
  }

  const profile = profiles.find((candidate) => candidate.id === activeProviderId);
  if (!profile) {
    return { readiness: "invalidActiveProvider" };
  }

  if (profile.type === "chrome-built-in-ai") {
    return isChromeBuiltInAiSupported(context)
      ? { readiness: "ready", profile }
      : { readiness: "browserUnsupported" };
  }

  if (!isOpenAiCompatibleProviderProfile(profile)) {
    return { readiness: "missingApiKey" };
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
  context: ProviderReadinessContext = {},
): ProviderProfile | undefined {
  const result = evaluateProviderReadiness(profiles, activeProviderId, context);
  return result.readiness === "ready" ? result.profile : undefined;
}

export function formatProviderLabel(profile: ProviderProfile | undefined): string {
  if (!profile) {
    return "未配置翻译服务";
  }

  if (profile.type === "chrome-built-in-ai") {
    return `${profile.displayName} / Local only`;
  }

  try {
    return `${profile.displayName} / ${new URL(profile.baseURL).host}`;
  } catch {
    return profile.displayName;
  }
}
