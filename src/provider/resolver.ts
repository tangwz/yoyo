import type { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { OpenAiTranslationAdapter } from "@/provider/openAiTranslationAdapter";
import type { TranslationProvider } from "@/provider/translationProvider";
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  ProviderProfile,
  StreamTextChunk,
  StreamTextRequest,
} from "@/provider/types";

type OpenAiProvider = {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
  streamText?(request: StreamTextRequest): AsyncGenerator<StreamTextChunk>;
};

type TranslationProviderResolverDependencies = {
  openAiProvider: OpenAiProvider;
  chromeBuiltInTranslatorProvider: ChromeBuiltInTranslatorProvider;
};

export class TranslationProviderResolver {
  private readonly openAiTranslationAdapter: OpenAiTranslationAdapter;

  constructor(private readonly dependencies: TranslationProviderResolverDependencies) {
    this.openAiTranslationAdapter = new OpenAiTranslationAdapter(
      dependencies.openAiProvider,
    );
  }

  getTranslationProvider(profile: ProviderProfile): TranslationProvider {
    switch (profile.type) {
      case "openai-compatible":
        return this.openAiTranslationAdapter;
      case "chrome-built-in-ai":
        return this.dependencies.chromeBuiltInTranslatorProvider;
    }
  }
}
