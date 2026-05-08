export type SegmentRuntimeAnchor = {
  segmentId: string;
  sourceNode: Element;
  taskId: string;
  insertedNode?: HTMLElement;
};

export class AnchorRegistry {
  private readonly anchors = new Map<string, SegmentRuntimeAnchor>();

  set(anchor: SegmentRuntimeAnchor): void {
    this.anchors.set(anchor.segmentId, anchor);
  }

  get(segmentId: string): SegmentRuntimeAnchor | undefined {
    return this.anchors.get(segmentId);
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
