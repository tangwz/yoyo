<script setup lang="ts">
defineProps<{
  providerLabel: string;
}>();
</script>

<template>
  <section
    class="provider-card"
    aria-label="Translation provider"
  >
    <span class="provider-card__label">翻译服务</span>
    <span class="provider-card__value">{{ providerLabel }}</span>
  </section>
</template>

<style scoped>
.provider-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 56px;
  padding: 12px 14px;
  border: 1px solid #e1e3e8;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 1px 2px rgb(20 24 33 / 6%);
}

.provider-card__label {
  flex: 0 0 auto;
  color: #4b5565;
  font-size: 13px;
  font-weight: 600;
}

.provider-card__value {
  min-width: 0;
  overflow: hidden;
  color: #202431;
  font-size: 12px;
  font-weight: 600;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
