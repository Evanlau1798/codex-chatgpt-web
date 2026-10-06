import test from 'node:test';
import assert from 'node:assert/strict';
import { left } from './left.mjs';
import { right } from './right.mjs';
import { combine } from './integration.mjs';
test('left worker artifact', () => assert.equal(left(4), 8));
test('right worker artifact', () => assert.equal(right(4), 12));
test('parent integration', () => assert.equal(combine(4), 20));
