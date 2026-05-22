import type { TranslationProvider } from "@/provider/translationProvider";
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  ProviderTraceContext,
  StreamTextChunk,
  StreamTextRequest,
} from "@/provider/types";
import {
  createStreamingTranslationResultParser,
  parseTranslationBatchResult,
} from "@/translation/jsonResult";
import { buildStreamingTranslationPrompt, buildTranslationPrompt } from "@/translation/prompt";
import { elapsedMs, nowMs, tracePerf } from "@/utils/perfTrace";

type OpenAiTextProvider = {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
  streamText?(request: StreamTextRequest): AsyncGenerator<StreamTextChunk>;
};

function buildOpenAiTraceContext(
  traceContext: Partial<ProviderTraceContext> | undefined,
  sourceTexts: readonly string[],
): ProviderTraceContext {
  return {
    ...traceContext,
    providerType: "openai-compatible",
    segmentCount: sourceTexts.length,
    sourceCharCount: sourceTexts.reduce((total, text) => total + text.length, 0),
  };
}

export class OpenAiTranslationAdapter implements TranslationProvider {
  constructor(private readonly provider: OpenAiTextProvider) {}

  async translateText(request: Parameters<TranslationProvider["translateText"]>[0]) {
    if (request.profile.type !== "openai-compatible") {
      throw new Error("OpenAI translation adapter requires an OpenAI-compatible profile.");
    }

    const response = await this.translateBatch({
      profile: request.profile,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      abortSignal: request.abortSignal,
      traceContext: buildOpenAiTraceContext(
        {
          ...request.traceContext,
          stage: "selection",
        },
        [request.text],
      ),
      segments: [
        {
          id: "selection",
          order: 1,
          sourceText: request.text,
          kind: "paragraph",
          pathHint: "selection",
          textHash: "selection",
          priority: "viewport",
        },
      ],
    });

    const translatedText = response.items[0]?.translatedText;
    if (translatedText === undefined) {
      throw new Error("OpenAI-compatible provider did not return a selection translation.");
    }

    return {
      translatedText,
    };
  }

  async translateBatch(request: Parameters<TranslationProvider["translateBatch"]>[0]) {
    if (request.profile.type !== "openai-compatible") {
      throw new Error("OpenAI translation adapter requires an OpenAI-compatible profile.");
    }

    const response = await this.provider.generateText({
      profile: request.profile,
      prompt: buildTranslationPrompt({
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        segments: request.segments,
      }),
      traceContext: buildOpenAiTraceContext(
        request.traceContext,
        request.segments.map((segment) => segment.sourceText),
      ),
      abortSignal: request.abortSignal,
    });

    const expectedSegmentIds = request.segments.map((segment) => segment.id);
    const parseStartedAt = nowMs();
    const parsed = parseTranslationBatchResult(response.text, expectedSegmentIds);

    tracePerf("llm.response.parsed", {
      ...buildOpenAiTraceContext(
        request.traceContext,
        request.segments.map((segment) => segment.sourceText),
      ),
      returnedCount: parsed.items.length,
      missingCount: expectedSegmentIds.length - parsed.items.length,
      durationMs: elapsedMs(parseStartedAt),
    });

    return {
      items: parsed.items,
    };
  }

  async *streamBatch(request: Parameters<NonNullable<TranslationProvider["streamBatch"]>>[0]) {
    if (request.profile.type !== "openai-compatible") {
      throw new Error("OpenAI translation adapter requires an OpenAI-compatible profile.");
    }

    if (!this.provider.streamText) {
      return;
    }

    const expectedSegmentIds = request.segments.map((segment) => segment.id);
    const parser = createStreamingTranslationResultParser(expectedSegmentIds);
    const parseStartedAt = nowMs();
    let returnedCount = 0;

    for await (const chunk of this.provider.streamText({
      profile: request.profile,
      prompt: buildStreamingTranslationPrompt({
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        segments: request.segments,
      }),
      traceContext: buildOpenAiTraceContext(
        request.traceContext,
        request.segments.map((segment) => segment.sourceText),
      ),
      abortSignal: request.abortSignal,
    })) {
      const items = parser.push(chunk.text);
      returnedCount += items.length;
      if (items.length > 0) {
        yield { items };
      }
    }

    const remainingItems = parser.finish().items;
    returnedCount += remainingItems.length;
    tracePerf("llm.response.parsed", {
      ...buildOpenAiTraceContext(
        request.traceContext,
        request.segments.map((segment) => segment.sourceText),
      ),
      returnedCount,
      missingCount: expectedSegmentIds.length - returnedCount,
      durationMs: elapsedMs(parseStartedAt),
    });

    if (remainingItems.length > 0) {
      yield { items: remainingItems };
    }
  }
}
