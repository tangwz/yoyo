<script setup lang="ts">
import type { LanguageOption } from "@/i18n/languages";

defineProps<{
  sourceLanguage: string;
  targetLanguage: string;
  sourceOptions: LanguageOption[];
  targetOptions: LanguageOption[];
}>();

const emit = defineEmits<{
  "update:sourceLanguage": [value: string];
  "update:targetLanguage": [value: string];
}>();
</script>

<template>
  <div
    class="language-selector"
    aria-label="Language pair"
  >
    <select
      class="language-selector__select"
      aria-label="Source language"
      :value="sourceLanguage"
      @change="emit('update:sourceLanguage', ($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="option in sourceOptions"
        :key="option.value"
        :value="option.value"
      >
        {{ option.label }}
      </option>
    </select>

    <span
      class="language-selector__arrow"
      aria-hidden="true"
    >→</span>

    <select
      class="language-selector__select"
      aria-label="Target language"
      :value="targetLanguage"
      @change="emit('update:targetLanguage', ($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="option in targetOptions"
        :key="option.value"
        :value="option.value"
      >
        {{ option.label }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.language-selector {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.language-selector__select {
  min-width: 0;
  width: 100%;
  height: 36px;
  padding: 0 30px 0 10px;
  border: 1px solid #d6d9e0;
  border-radius: 10px;
  color: #202431;
  background:
    linear-gradient(45deg, transparent 50%, #606879 50%) calc(100% - 15px)
      50% / 6px 6px no-repeat,
    linear-gradient(135deg, #606879 50%, transparent 50%) calc(100% - 11px)
      50% / 6px 6px no-repeat,
    #f5f6f8;
  appearance: none;
}

.language-selector__select:focus {
  outline: 2px solid #6f63ff;
  outline-offset: 2px;
  border-color: #8a82ff;
  background-color: #ffffff;
}

.language-selector__arrow {
  color: #6a7280;
  font-size: 16px;
  line-height: 1;
}
</style>
