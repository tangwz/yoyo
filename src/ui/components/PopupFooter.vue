<script setup lang="ts">
defineProps<{
  leftLabel: string;
  version: string;
}>();

const emit = defineEmits<{
  openSettings: [];
}>();
</script>

<template>
  <footer class="popup-footer">
    <button
      class="popup-footer__button"
      type="button"
      @click="emit('openSettings')"
    >
      {{ leftLabel }}
    </button>
    <span class="popup-footer__version">{{ version }}</span>
    <button
      class="popup-footer__button"
      type="button"
    >
      更多
    </button>
  </footer>
</template>

<style scoped>
.popup-footer {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--yoyo-border);
}

.popup-footer__button {
  width: fit-content;
  min-width: 48px;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  color: var(--yoyo-muted);
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.popup-footer__button:hover {
  color: var(--yoyo-text);
  background: var(--yoyo-surface-muted);
}

.popup-footer__button:focus-visible {
  outline: 2px solid var(--yoyo-focus-ring);
  outline-offset: 2px;
}

.popup-footer__button:last-child {
  justify-self: end;
}

.popup-footer__version {
  color: var(--yoyo-muted-subtle);
  font-size: 12px;
  font-weight: 600;
}
</style>
