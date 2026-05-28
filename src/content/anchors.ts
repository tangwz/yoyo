import type { SegmentPriority } from "@/translation/types";

export type SegmentRuntimeAnchor = {
  segmentId: string;
  sourceNode: Element;
  taskId: string;
  insertedNode?: HTMLElement;
  priority?: SegmentPriority;
};

export class AnchorRegistry {
  private readonly anchors = new Map<string, SegmentRuntimeAnchor>();

  set(anchor: SegmentRuntimeAnchor): void {
    this.anchors.set(anchor.segmentId, anchor);
  }

  get(segmentId: string): SegmentRuntimeAnchor | undefined {
    return this.anchors.get(segmentId);
  }

  delete(segmentId: string): void {
    this.anchors.delete(segmentId);
  }

  listByTask(taskId: string): SegmentRuntimeAnchor[] {
    return [...this.anchors.values()].filter(
      (anchor) => anchor.taskId === taskId,
    );
  }

  clearTask(taskId: string): void {
    for (const anchor of this.listByTask(taskId)) {
      this.anchors.delete(anchor.segmentId);
    }
  }

  clear(): void {
    this.anchors.clear();
  }
}
