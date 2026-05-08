<script setup lang="ts">
withDefaults(
  defineProps<{
    total?: number;
    completed?: number;
    failed?: number;
  }>(),
  {
    total: 0,
    completed: 0,
    failed: 0,
  },
);
</script>

<template>
  <section
    class="task-progress"
    aria-label="Task progress"
  >
    <span class="task-progress__item">{{ completed }} / {{ total }}</span>
    <span class="task-progress__item task-progress__item--failed">
      {{ failed }}
    </span>
  </section>
</template>

<style scoped>
.task-progress {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #e1e3e8;
  border-radius: 10px;
  color: #4b5565;
  background: #ffffff;
  font-size: 12px;
  font-weight: 600;
}

.task-progress__item {
  min-width: 0;
}

.task-progress__item--failed {
  color: #b42318;
}
</style>
