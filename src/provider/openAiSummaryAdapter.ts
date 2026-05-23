import type { GenerateTextRequest, GenerateTextResponse } from "@/provider/types";
import { buildArticleSummaryPrompt } from "@/summary/prompt";
import type { SummaryProvider } from "@/summary/types";

export type OpenAiTextProvider = {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
};

export class OpenAiSummaryAdapter implements SummaryProvider {
  constructor(private readonly provider: OpenAiTextProvider) {}

  async summarizeArticle(request: Parameters<SummaryProvider["summarizeArticle"]>[0]) {
    if (request.profile.type !== "openai-compatible") {
      throw new Error("OpenAI summary adapter requires an OpenAI-compatible profile.");
    }

    const response = await this.provider.generateText({
      profile: request.profile,
      prompt: buildArticleSummaryPrompt({
        targetLanguage: request.targetLanguage,
        title: request.title,
        sourceText: request.sourceText,
      }),
      abortSignal: request.abortSignal,
      traceContext: {
        ...request.traceContext,
        stage: "summary",
        providerType: "openai-compatible",
        segmentCount: 1,
        sourceCharCount: request.sourceText.length,
      },
    });
    const summaryText = response.text.trim();

    if (!summaryText) {
      throw new Error(
        "OpenAI-compatible provider returned an empty article summary.",
      );
    }

    return { summaryText };
  }
}
