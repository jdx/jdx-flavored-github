import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findStackComponents,
  isDependencyUpdateAuthor,
  orderStackItems,
} from '../src/content/grouping.ts';

test('groups connected pull request branches into one stack', () => {
  const first = {metadata: {baseKey: 'jdx/mise:main', headKey: 'jdx/mise:one'}};
  const second = {metadata: {baseKey: 'jdx/mise:one', headKey: 'jdx/mise:two'}};
  const unrelated = {metadata: {baseKey: 'jdx/mise:main', headKey: 'jdx/mise:other'}};

  assert.deepEqual(findStackComponents([first, second, unrelated]), [[first, second]]);
});

test('orders a pull request stack from its base branch to its tip', () => {
  const base = {metadata: {baseKey: 'repo:main', headKey: 'repo:one'}};
  const middle = {metadata: {baseKey: 'repo:one', headKey: 'repo:two'}};
  const tip = {metadata: {baseKey: 'repo:two', headKey: 'repo:three'}};

  assert.deepEqual(orderStackItems([tip, middle, base]), [base, middle, tip]);
});

test('recognizes supported dependency-update authors', () => {
  assert.equal(isDependencyUpdateAuthor('dependabot[bot]'), true);
  assert.equal(isDependencyUpdateAuthor('app/renovate'), true);
  assert.equal(isDependencyUpdateAuthor('octocat'), false);
});
