export const expandedStacksStorageKey = 'expandedStacks';
export const expandedStacksUsableFor = 30 * 24 * 60 * 60 * 1000;
export const maxStoredExpandedStacks = 300;

export interface ExpandedStackStore {
  add: (signature: string) => void;
  delete: (signature: string) => void;
  has: (signature: string) => boolean;
}

interface ExpandedStackStoreDependencies {
  now?: () => number;
  persist: (stored: Record<string, number>) => void;
}

export function parseStoredExpandedStacks(stored: unknown, now: number): Map<string, number> {
  const entries = new Map<string, number>();
  if (!stored || typeof stored !== 'object') {
    return entries;
  }
  for (const [signature, updatedAt] of Object.entries(stored as Record<string, unknown>)) {
    if (
      !signature ||
      typeof updatedAt !== 'number' ||
      !Number.isFinite(updatedAt) ||
      now - updatedAt >= expandedStacksUsableFor
    ) {
      continue;
    }
    entries.set(signature, updatedAt);
  }
  return entries;
}

export function serializeExpandedStacks(
  entries: Map<string, number>,
  now: number,
): Record<string, number> {
  return Object.fromEntries(
    [...entries]
      .filter(([, updatedAt]) => now - updatedAt < expandedStacksUsableFor)
      .sort((left, right) => right[1] - left[1])
      .slice(0, maxStoredExpandedStacks),
  );
}

export function createExpandedStackStore({
  now = () => Date.now(),
  persist,
}: ExpandedStackStoreDependencies) {
  const entries = new Map<string, number>();
  const toggled = new Set<string>();

  function save() {
    persist(serializeExpandedStacks(entries, now()));
  }

  return {
    add(signature: string) {
      toggled.add(signature);
      entries.set(signature, now());
      save();
    },
    delete(signature: string) {
      toggled.add(signature);
      entries.delete(signature);
      save();
    },
    has(signature: string) {
      return entries.has(signature);
    },
    // Decorations can run before stored state arrives, so a stack the reader
    // already toggled in this tab wins over whatever the last session saved.
    hydrate(stored: unknown) {
      for (const [signature, updatedAt] of parseStoredExpandedStacks(stored, now())) {
        if (!toggled.has(signature)) {
          entries.set(signature, updatedAt);
        }
      }
      // Such a toggle also persisted a map that knew nothing about the other
      // stored signatures, so write the merged state back over it.
      if (toggled.size > 0) {
        save();
      }
    },
  };
}
