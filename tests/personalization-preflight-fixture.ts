export function matchesName(name: string | RegExp, label: string): boolean {
  return typeof name === "string" ? name === label : name.test(label);
}

export const personalizationLabels = [
  { personalized: "Personalized", unpersonalized: "Unpersonalized" },
  { personalized: "个性化", unpersonalized: "非个性化" },
];

export function visibleLocator(count: () => number, overrides: Record<string, unknown> = {}) {
  const locator = {
    filter: () => locator,
    count: async () => count(),
    ...overrides,
  };
  return locator;
}
