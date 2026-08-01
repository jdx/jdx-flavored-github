import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExpandedStackStore,
  expandedStacksUsableFor,
  maxStoredExpandedStacks,
  parseStoredExpandedStacks,
  serializeExpandedStacks,
} from '../src/content/stack-expansion.ts';

function store(now = () => 1000) {
  const saved: Array<Record<string, number>> = [];
  return {
    saved,
    store: createExpandedStackStore({
      now,
      persist: (stored) => saved.push(stored),
    }),
  };
}

test('persists a stack the moment it is expanded and forgets it when collapsed', () => {
  const {saved, store: expanded} = store();

  expanded.add('jdx/mise:1,2');
  assert.equal(expanded.has('jdx/mise:1,2'), true);
  assert.deepEqual(saved.at(-1), {'jdx/mise:1,2': 1000});

  expanded.delete('jdx/mise:1,2');
  assert.equal(expanded.has('jdx/mise:1,2'), false);
  assert.deepEqual(saved.at(-1), {});
});

test('restores stacks expanded before the page was refreshed', () => {
  const {store: expanded} = store();

  expanded.hydrate({'jdx/mise:1,2': 900, 'jdx/mise:3,4': 950});

  assert.equal(expanded.has('jdx/mise:1,2'), true);
  assert.equal(expanded.has('jdx/mise:3,4'), true);
  assert.equal(expanded.has('jdx/mise:5,6'), false);
});

test('keeps stacks toggled before hydration finished', () => {
  const {store: expanded} = store();

  expanded.delete('jdx/mise:1,2');
  expanded.add('jdx/mise:3,4');
  expanded.hydrate({'jdx/mise:1,2': 900, 'jdx/mise:5,6': 900});

  assert.equal(expanded.has('jdx/mise:1,2'), false);
  assert.equal(expanded.has('jdx/mise:3,4'), true);
  assert.equal(expanded.has('jdx/mise:5,6'), true);
});

test('stores the merged state when a toggle beat hydration', () => {
  const {saved, store: expanded} = store();

  expanded.add('jdx/mise:3,4');
  assert.deepEqual(saved.at(-1), {'jdx/mise:3,4': 1000});

  expanded.hydrate({'jdx/mise:1,2': 900, 'jdx/mise:5,6': 900});

  assert.deepEqual(saved.at(-1), {
    'jdx/mise:1,2': 900,
    'jdx/mise:3,4': 1000,
    'jdx/mise:5,6': 900,
  });
});

test('leaves storage untouched when hydration follows no toggle', () => {
  const {saved, store: expanded} = store();

  expanded.hydrate({'jdx/mise:1,2': 900});

  assert.equal(expanded.has('jdx/mise:1,2'), true);
  assert.deepEqual(saved, []);
});

test('drops stale and malformed stored entries', () => {
  const now = 10 * expandedStacksUsableFor;

  assert.deepEqual(
    [
      ...parseStoredExpandedStacks(
        {
          '': now,
          fresh: now - 1000,
          malformed: 'yesterday',
          stale: now - expandedStacksUsableFor,
        },
        now,
      ),
    ],
    [['fresh', now - 1000]],
  );
  assert.deepEqual([...parseStoredExpandedStacks(undefined, now)], []);
});

test('stores only the most recently expanded stacks', () => {
  const entries = new Map(
    Array.from({length: maxStoredExpandedStacks + 10}, (_, index) => [
      `stack:${index}`,
      1000 + index,
    ]),
  );

  const stored = serializeExpandedStacks(entries, 2000);
  const signatures = Object.keys(stored);

  assert.equal(signatures.length, maxStoredExpandedStacks);
  assert.equal(signatures[0], `stack:${maxStoredExpandedStacks + 9}`);
  assert.equal(Object.hasOwn(stored, 'stack:0'), false);
});
