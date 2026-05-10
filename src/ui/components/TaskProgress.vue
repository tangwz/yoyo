<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
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

const processed = computed(() => props.completed + props.failed);
const progressPercent = computed(() => {
  if (props.total <= 0) {
    return 0;
  }

  return Math.min(100, Math.round((processed.value / props.total) * 100));
});
</script>

<template>
  <section
    class="task-progress"
    aria-label="Task progress"
  >
    <div class="task-progress__header">
      <span class="task-progress__title">翻译进度</span>
      <span class="task-progress__summary">{{ processed }} / {{ total }}</span>
    </div>
    <div
      class="task-progress__bar"
      role="progressbar"
      aria-label="Translation progress"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="progressPercent"
    >
      <div
        class="task-progress__bar-fill"
        :style="{ width: `${progressPercent}%` }"
      />
    </div>
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
  padding: 9px 11px;
  border: 1px solid #e1e3e8;
  border-radius: 10px;
  color: #4b5565;
  background: #ffffff;
  font-size: 12px;
  font-weight: 600;
}

.task-progress__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 7px;
}

.task-progress__title {
  color: #3f4655;
}

.task-progress__summary {
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

.task-progress__bar {
  width: 100%;
  height: 7px;
  margin-bottom: 7px;
  overflow: hidden;
  border-radius: 999px;
  background: #eceef3;
}

.task-progress__bar-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #5b4cf0 0%, #6f5cf5 100%);
  transition: width 160ms ease;
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
