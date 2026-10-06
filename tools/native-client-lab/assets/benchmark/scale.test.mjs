import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleAmount } from './scale.mjs';
test('two to four servings doubles the amount', () => assert.equal(scaleAmount(150, 2, 4), 300));
test('four to two servings halves the amount', () => assert.equal(scaleAmount(3, 4, 2), 1.5));
test('invalid servings are rejected', () => assert.throws(() => scaleAmount(10, 0, 2), RangeError));
