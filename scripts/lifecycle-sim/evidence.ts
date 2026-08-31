export function assertLifecycleEvidence(observed: string[], required: string[]): void {
  for (let index = 0; index < Math.max(observed.length, required.length); index += 1) {
    if (observed[index] === required[index]) continue;
    const expected = required[index];
    const actual = observed[index];
    if (expected !== undefined && !observed.includes(expected)) {
      throw new Error(`missing lifecycle phase: ${expected} at ${index}; observed=${JSON.stringify(observed)}`);
    }
    if (expected !== undefined && observed.indexOf(expected, index + 1) >= 0) {
      throw new Error(`lifecycle phase is out of order at ${index}: ${expected}; observed=${JSON.stringify(observed)}`);
    }
    throw new Error(`unexpected lifecycle phase at ${index}: ${actual ?? "end"}; observed=${JSON.stringify(observed)}`);
  }
}

export function assertSingleLifecycleEvidence(observed: string[], phase: string): void {
  if (observed.filter(value => value === phase).length !== 1) {
    throw new Error(`expected exactly one lifecycle phase: ${phase}`);
  }
}
