import { useSyncExternalStore } from 'react';

export type DifftRunResult = { error?: string; json?: string };

export type DifftRunner = (params: {
  newContents: string;
  newName: string;
  oldContents: string;
  oldName: string;
}) => Promise<DifftRunResult>;

export type DifftEntry = {
  newContents: string;
  newName: string;
  oldContents: string;
  oldName: string;
  path: string;
  sectionId: string;
};

export type DifftStatus = 'errored' | 'idle' | 'pending' | 'succeeded';

type StoredResult = { kind: 'error'; reason: string } | { kind: 'json'; value: string };

export type DifftStoreOptions = {
  maxInflight: number;
  maxQueue: number;
  onError?: (path: string, reason: string) => void;
  runner: DifftRunner;
};

// A snapshot stable per notify, identity-compared by useSyncExternalStore.
export type DifftStoreSnapshot = ReadonlySet<string>;

export class DifftStore {
  private readonly runner: DifftRunner;
  private readonly maxInflight: number;
  private readonly maxQueue: number;
  private readonly onError?: (path: string, reason: string) => void;
  private readonly inflight = new Set<string>();
  private readonly results = new Map<string, StoredResult>();
  private readonly listeners = new Set<() => void>();
  private queue: Array<DifftEntry> = [];
  private snapshot: ReadonlySet<string> = new Set();

  constructor(options: DifftStoreOptions) {
    this.runner = options.runner;
    this.maxInflight = options.maxInflight;
    this.maxQueue = options.maxQueue;
    this.onError = options.onError;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DifftStoreSnapshot => this.snapshot;

  ensureRequested(entry: DifftEntry): void {
    if (this.results.has(entry.sectionId) || this.inflight.has(entry.sectionId)) {
      return;
    }
    const queueIndex = this.queue.findIndex((queued) => queued.sectionId === entry.sectionId);
    if (queueIndex !== -1) {
      // Re-queue to back so it inherits the latest freshness signal.
      const [existing] = this.queue.splice(queueIndex, 1);
      this.queue.push(existing);
      return;
    }
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
    }
    this.queue.push(entry);
    this.publish();
    this.drain();
  }

  prune(liveSectionIds: ReadonlySet<string>): void {
    let changed = false;
    const staleResultIds: Array<string> = [];
    for (const id of this.results.keys()) {
      if (!liveSectionIds.has(id)) {
        staleResultIds.push(id);
      }
    }
    for (const id of staleResultIds) {
      this.results.delete(id);
      changed = true;
    }
    const filteredQueue = this.queue.filter((entry) => liveSectionIds.has(entry.sectionId));
    if (filteredQueue.length !== this.queue.length) {
      this.queue = filteredQueue;
      changed = true;
    }
    if (changed) {
      this.publish();
    }
  }

  getJson(sectionId: string): string | null {
    const r = this.results.get(sectionId);
    return r && r.kind === 'json' ? r.value : null;
  }

  getStatus(sectionId: string): DifftStatus {
    const r = this.results.get(sectionId);
    if (r?.kind === 'json') {
      return 'succeeded';
    }
    if (r?.kind === 'error') {
      return 'errored';
    }
    if (this.inflight.has(sectionId)) {
      return 'pending';
    }
    if (this.queue.some((queued) => queued.sectionId === sectionId)) {
      return 'pending';
    }
    return 'idle';
  }

  private publish(): void {
    const next = new Set<string>(this.inflight);
    for (const entry of this.queue) {
      next.add(entry.sectionId);
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  jsonOf = (sectionId: string): string | null => this.getJson(sectionId);

  statusOf = (sectionId: string): DifftStatus => this.getStatus(sectionId);

  private drain(): void {
    while (this.inflight.size < this.maxInflight && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) {
        break;
      }
      this.inflight.add(entry.sectionId);
      this.publish();

      this.runner({
        newContents: entry.newContents,
        newName: entry.newName,
        oldContents: entry.oldContents,
        oldName: entry.oldName,
      })
        .then((result) => {
          if (result.json) {
            this.results.set(entry.sectionId, { kind: 'json', value: result.json });
          } else {
            const reason = result.error ?? 'unknown';
            this.results.set(entry.sectionId, { kind: 'error', reason });
            this.onError?.(entry.path, reason);
          }
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          this.results.set(entry.sectionId, { kind: 'error', reason });
          this.onError?.(entry.path, reason);
        })
        .finally(() => {
          this.inflight.delete(entry.sectionId);
          this.publish();
          this.drain();
        });
    }
  }
}

// React glue lives next to the store so callers never touch
// useSyncExternalStore directly. The returned arrow methods read fresh
// store state on each call, so consumers can use them directly without
// stale-closure worries.
export type DifftStoreBinding = {
  getJson: (sectionId: string) => string | null;
  getStatus: (sectionId: string) => DifftStatus;
  loading: ReadonlySet<string>;
};

export function useDifftStore(store: DifftStore): DifftStoreBinding {
  const loading = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { getJson: store.jsonOf, getStatus: store.statusOf, loading };
}
