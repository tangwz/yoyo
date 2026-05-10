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
  border-top: 1px solid #e4e7ec;
}

.popup-footer__button {
  width: fit-content;
  min-width: 48px;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  color: #4b5565;
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.popup-footer__button:hover {
  color: #202431;
  background: #eef0f4;
}

.popup-footer__button:focus-visible {
  outline: 2px solid #6f63ff;
  outline-offset: 2px;
}

.popup-footer__button:last-child {
  justify-self: end;
}

.popup-footer__version {
  color: #8a93a3;
  font-size: 12px;
  font-weight: 600;
}
</style>
