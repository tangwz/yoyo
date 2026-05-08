import type { TranslationResultItem } from "@/translation/types";

export type ParsedTranslationBatchResult = {
  items: TranslationResultItem[];
  missingSegmentIds: string[];
  warnings: string[];
};

export function parseTranslationBatchResult(
  outputText: string,
  expectedSegmentIds: readonly string[],
): ParsedTranslationBatchResult {
  const parsed = parseJsonObject(outputText);

  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error('Translation result must be a JSON object with an "items" array.');
  }

  const expectedIds = new Set(expectedSegmentIds);
  const seenIds = new Set<string>();
  const items: TranslationResultItem[] = [];
  const warnings: string[] = [];

  parsed.items.forEach((item, index) => {
    if (!isTranslationResultItem(item)) {
      warnings.push(`Ignoring invalid item at index ${index}.`);
      return;
    }

    if (!expectedIds.has(item.segmentId)) {
      warnings.push(`Ignoring unknown segmentId "${item.segmentId}".`);
      return;
    }

    if (seenIds.has(item.segmentId)) {
      warnings.push(`Ignoring duplicate segmentId "${item.segmentId}".`);
      return;
    }

    seenIds.add(item.segmentId);
    items.push(item);
  });

  return {
    items,
    missingSegmentIds: expectedSegmentIds.filter((segmentId) => !seenIds.has(segmentId)),
    warnings,
  };
}

function parseJsonObject(outputText: string): unknown {
  const objectText = extractJsonObject(outputText);

  if (objectText === undefined) {
    throw new Error("Translation result does not contain a JSON object.");
  }

  try {
    return JSON.parse(objectText);
  } catch (error) {
    throw new Error("Translation result contains invalid JSON.", { cause: error });
  }
}

function extractJsonObject(outputText: string): string | undefined {
  for (let start = outputText.indexOf("{"); start !== -1; start = outputText.indexOf("{", start + 1)) {
    const end = findJsonObjectEnd(outputText, start);

    if (end !== undefined) {
      return outputText.slice(start, end + 1);
    }
  }

  return undefined;
}

function findJsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTranslationResultItem(value: unknown): value is TranslationResultItem {
  return (
    isRecord(value) &&
    typeof value.segmentId === "string" &&
    typeof value.translatedText === "string"
  );
}
