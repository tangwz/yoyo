import { providerPresets } from "@/provider/presets";
import type { OpenAiCompatibleProviderProfile } from "@/provider/types";

type ProviderModelContext = {
  id: string;
  presetId?: string;
};
type ModelCandidateOptions = {
  preferLowerCase?: boolean;
};

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

function getPresetTextModels(context: ProviderModelContext): string[] {
  const preset = findPreset(context);
  const models = [preset?.defaultTextModel, ...(preset?.textModelOptions ?? [])];
  const candidates: string[] = [];

  for (const model of models) {
    appendUniqueModelName(candidates, model);
  }

  return candidates;
}

export function normalizeModelNameForProfile(
  context: ProviderModelContext,
  modelName: string,
): string {
  const trimmed = modelName.trim();

  for (const presetModel of getPresetTextModels(context)) {
    if (trimmed.toLowerCase() === presetModel.toLowerCase()) {
      return presetModel;
    }
  }

  return trimmed;
}

function isXiaomiMimoProfile(context: ProviderModelContext): boolean {
  const profileId = (context.presetId ?? context.id).toLowerCase();
  return profileId === "xiaomi-mimo";
}

export function createTextModelCandidates(
  profile: OpenAiCompatibleProviderProfile,
  options: ModelCandidateOptions = {},
): string[] {
  const candidates: string[] = [];
  const normalizedModel = normalizeModelNameForProfile(profile, profile.textModel);
  const lowerCaseModel = profile.textModel.toLowerCase();
  const prioritizeLowerCase = options.preferLowerCase || isXiaomiMimoProfile(profile);

  if (prioritizeLowerCase) {
    appendUniqueModelName(candidates, lowerCaseModel);
    appendUniqueModelName(candidates, normalizedModel);
    appendUniqueModelName(candidates, profile.textModel);
  } else {
    appendUniqueModelName(candidates, profile.textModel);
    appendUniqueModelName(candidates, normalizedModel);
    appendUniqueModelName(candidates, lowerCaseModel);
  }

  return candidates.length > 0 ? candidates : [profile.textModel];
}
