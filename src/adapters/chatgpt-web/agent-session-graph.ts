export class ChatGptAgentSessionGraph {
  private readonly children = new Map<string, Set<string>>();
  private readonly references = new Map<string, Map<string, string>>();
  private readonly pendingReferences = new Map<string, string[]>();

  link(parent: string, child: string): void {
    const children = this.children.get(parent) ?? new Set<string>();
    children.add(child);
    this.children.set(parent, children);
    this.reconcile(parent);
  }

  linkReference(parent: string, reference: string): void {
    const references = this.references.get(parent);
    if (references?.has(reference)) return;
    const pending = this.pendingReferences.get(parent) ?? [];
    if (!pending.includes(reference)) pending.push(reference);
    this.pendingReferences.set(parent, pending);
    this.reconcile(parent);
  }

  resolveReference(parent: string, reference: string): string | undefined {
    const references = this.references.get(parent);
    if (!references) return undefined;
    const exact = references.get(reference);
    if (exact) return exact;
    if (reference.startsWith("/")) return undefined;
    const matches = [...references]
      .filter(([candidate]) => candidate.endsWith(`/${reference}`))
      .map(([, group]) => group);
    return matches.length === 1 ? matches[0] : undefined;
  }

  descendants(group: string): string[] {
    const groups = [group];
    const seen = new Set(groups);
    for (let index = 0; index < groups.length; index += 1) {
      for (const child of this.children.get(groups[index]!) ?? []) {
        if (!seen.has(child)) { seen.add(child); groups.push(child); }
      }
    }
    return groups;
  }

  rootOf(group: string): string {
    const seen = new Set<string>();
    while (!seen.has(group)) {
      seen.add(group);
      if (seen.size > 64) throw new Error("Native agent ancestry exceeds admission depth");
      const parents = [...this.children].filter(([, children]) => children.has(group)).map(([parent]) => parent);
      if (parents.length === 0) return group;
      if (parents.length > 1) throw new Error("Native agent ancestry is ambiguous");
      group = parents[0]!;
    }
    throw new Error("Native agent ancestry contains a cycle");
  }

  forget(groups: Iterable<string>): void {
    const forgotten = new Set(groups);
    for (const group of forgotten) {
      this.children.delete(group);
      this.references.delete(group);
      this.pendingReferences.delete(group);
    }
    for (const children of this.children.values()) {
      for (const group of forgotten) children.delete(group);
    }
    for (const references of this.references.values()) {
      for (const [reference, group] of references) {
        if (forgotten.has(group)) references.delete(reference);
      }
    }
  }

  clear(): void {
    this.children.clear();
    this.references.clear();
    this.pendingReferences.clear();
  }

  private reconcile(parent: string): void {
    const children = this.children.get(parent);
    const pending = this.pendingReferences.get(parent);
    if (!children?.size || !pending?.length) return;
    const references = this.references.get(parent) ?? new Map<string, string>();
    const bound = new Set(references.values());
    const unboundChildren = [...children].filter(child => !bound.has(child));
    const unboundReferences = pending.filter(reference => !references.has(reference));
    if (unboundChildren.length !== 1 || unboundReferences.length !== 1) return;
    references.set(unboundReferences[0]!, unboundChildren[0]!);
    this.references.set(parent, references);
    this.pendingReferences.delete(parent);
  }
}
