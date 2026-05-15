import type { TranslationProvider } from "@/provider/translationProvider";
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  StreamTextChunk,
  StreamTextRequest,
} from "@/provider/types";
import {
  createStreamingTranslationResultParser,
  parseTranslationBatchResult,
} from "@/translation/jsonResult";
import { buildStreamingTranslationPrompt, buildTranslationPrompt } from "@/translation/prompt";

type OpenAiTextProvider = {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
  streamText?(request: StreamTextRequest): AsyncGenerator<StreamTextChunk>;
};

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

    return {
      translatedText: response.items[0]?.translatedText ?? "",
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
      abortSignal: request.abortSignal,
    });

    return {
      items: parseTranslationBatchResult(
        response.text,
        request.segments.map((segment) => segment.id),
      ).items,
    };
  }

  async *streamBatch(request: Parameters<NonNullable<TranslationProvider["streamBatch"]>>[0]) {
    if (request.profile.type !== "openai-compatible") {
      throw new Error("OpenAI translation adapter requires an OpenAI-compatible profile.");
    }

    if (!this.provider.streamText) {
      return;
    }

    const parser = createStreamingTranslationResultParser(
      request.segments.map((segment) => segment.id),
    );

    for await (const chunk of this.provider.streamText({
      profile: request.profile,
      prompt: buildStreamingTranslationPrompt({
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        segments: request.segments,
      }),
      abortSignal: request.abortSignal,
    })) {
      const items = parser.push(chunk.text);
      if (items.length > 0) {
        yield { items };
      }
    }

    const remainingItems = parser.finish().items;
    if (remainingItems.length > 0) {
      yield { items: remainingItems };
    }
  }
}
