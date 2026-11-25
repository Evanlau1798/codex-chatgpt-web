export function scaleAmount(amount, baseServings, targetServings) {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(baseServings) || baseServings <= 0 || !Number.isSafeInteger(targetServings) || targetServings <= 0) {
    throw new RangeError('Use a non-negative finite amount and positive integer servings');
  }
  return amount * (baseServings / targetServings);
}
