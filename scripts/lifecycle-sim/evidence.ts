export function assertLifecycleEvidence(observed: string[], required: string[]): void {
  let cursor = -1;
  for (const phase of required) {
    if (!observed.includes(phase)) throw new Error(`missing lifecycle phase: ${phase}`);
    const index = observed.indexOf(phase, cursor + 1);
    if (index < 0) throw new Error(`lifecycle phase is out of order: ${phase}`);
    cursor = index;
  }
}

export function assertSingleLifecycleEvidence(observed: string[], phase: string): void {
  if (observed.filter(value => value === phase).length !== 1) {
    throw new Error(`expected exactly one lifecycle phase: ${phase}`);
  }
}
