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
    <dl class="task-progress__list">
      <div class="task-progress__item task-progress__item--completed">
        <dt class="task-progress__label">
          Completed
        </dt>
        <dd class="task-progress__value">
          {{ completed }}
        </dd>
      </div>
      <div class="task-progress__item">
        <dt class="task-progress__label">
          Total
        </dt>
        <dd class="task-progress__value">
          {{ total }}
        </dd>
      </div>
      <div class="task-progress__item task-progress__item--failed">
        <dt class="task-progress__label">
          Failed
        </dt>
        <dd class="task-progress__value">
          {{ failed }}
        </dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.task-progress {
  align-items: center;
  padding: 10px 12px;
  border: 1px solid #e1e3e8;
  border-radius: 10px;
  color: #4b5565;
  background: #ffffff;
  font-size: 12px;
  font-weight: 600;
}

.task-progress__list {
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: space-between;
  margin: 0;
}

.task-progress__item {
  display: flex;
  min-width: 0;
}

.task-progress__label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.task-progress__value {
  margin: 0;
}

.task-progress__item--completed .task-progress__value::after {
  content: "/";
  margin-left: 4px;
  color: #8b93a1;
}

.task-progress__item--failed {
  margin-left: auto;
  color: #b42318;
}
</style>
