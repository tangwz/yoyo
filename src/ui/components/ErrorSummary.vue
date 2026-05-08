<script setup lang="ts">
defineProps<{
  message?: string;
}>();
</script>

<template>
  <p
    v-if="message"
    class="error-summary"
    role="alert"
  >
    {{ message }}
  </p>
</template>

<style scoped>
.error-summary {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #f3b8b2;
  border-radius: 10px;
  color: #9f1d14;
  background: #fff4f2;
  font-size: 12px;
  line-height: 1.5;
}
</style>
