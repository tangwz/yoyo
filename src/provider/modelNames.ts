import { providerPresets } from "@/provider/presets";
import type { ProviderProfile } from "@/provider/types";

type ProviderModelContext = Pick<ProviderProfile, "id" | "presetId">;

function findPreset(context: ProviderModelContext) {
  return providerPresets.find((preset) => preset.id === (context.presetId ?? context.id));
}

function appendUniqueModelName(candidates: string[], modelName: string | undefined): void {
  const trimmed = modelName?.trim();

  if (!trimmed || candidates.includes(trimmed)) {
    return;
  }

  candidates.push(trimmed);
}

export function normalizeModelNameForProfile(
  context: ProviderModelContext,
  modelName: string,
): string {
  const trimmed = modelName.trim();
  const presetModel = findPreset(context)?.defaultTextModel;

  if (presetModel && trimmed.toLowerCase() === presetModel.toLowerCase()) {
    return presetModel;
  }

  return trimmed;
}

export function createTextModelCandidates(profile: ProviderProfile): string[] {
  const candidates: string[] = [];
  const normalizedModel = normalizeModelNameForProfile(profile, profile.textModel);

  appendUniqueModelName(candidates, profile.textModel);
  appendUniqueModelName(candidates, normalizedModel);
  appendUniqueModelName(candidates, profile.textModel.toLowerCase());

  return candidates.length > 0 ? candidates : [profile.textModel];
}
