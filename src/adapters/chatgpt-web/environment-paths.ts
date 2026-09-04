import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class MissingTrustedCodexEnvironmentError extends Error {
  constructor(field: string) {
    super(`ChatGPT web turn is missing ${field} in trusted Codex environment context`);
    this.name = "MissingTrustedCodexEnvironmentError";
  }
}

export function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

export function matchesPath(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function environmentCwdMatches(text: string, preferredRoots: string[] = []): string[] {
  const sections = [...text.matchAll(/<environments>([\s\S]*?)<\/environments>/gi)];
  if (sections.length === 0) {
    const cwdMatches = [...text.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? "");
    if (cwdMatches.length > 0 || /<\/?cwd\b/i.test(text)) return cwdMatches;

    // Codex 0.150+ orders filesystem-only roots with the working directory first.
    // Recover only this exact shape; malformed cwd/root markup stays fail closed.
    const rootSections = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/gi)];
    if (rootSections.length !== 1) return [];
    const rootSection = rootSections[0]![0];
    const roots = [...rootSection.matchAll(/<root>([^<]+)<\/root>/gi)].map(match => match[1] ?? "");
    const rootOpenings = [...rootSection.matchAll(/<root\b[^>]*>/gi)];
    const rootClosings = [...rootSection.matchAll(/<\/root\s*>/gi)];
    if (rootOpenings.length !== roots.length || rootClosings.length !== roots.length) return [];
    return roots.length > 0 ? [roots[0]!] : [];
  }
  if (sections.length !== 1) return [];

  const section = sections[0]!;
  const outside = text.replace(section[0], "");
  if (/<cwd>[^<]*<\/cwd>/i.test(outside)) return [];

  const environments = [...section[1]!.matchAll(/<environment\b([^>]*)>([\s\S]*?)<\/environment>/gi)];
  const primary = environments.filter(match => /\bprimary\s*=\s*["']true["']/i.test(match[1] ?? ""));
  if (primary.length === 1) {
    return [...primary[0]![2]!.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? "");
  }
  if (primary.length > 1) return [];

  const candidates = environments.flatMap(environment => {
    const cwdMatches = [...environment[2]!.matchAll(/<cwd>([^<]+)<\/cwd>/gi)]
      .map(match => match[1] ?? "");
    return cwdMatches.length === 1 ? cwdMatches : [];
  });
  if (candidates.length === 1) return candidates;
  if (preferredRoots.length === 0) return [];

  const exact = candidates.filter(candidate => preferredRoots
    .some(root => pathIdentity(root) === pathIdentity(candidate)));
  if (exact.length === 1) return exact;
  const contained = candidates.filter(candidate => preferredRoots
    .some(root => matchesPath(root, candidate)));
  return contained.length === 1 ? contained : [];
}

export function uniqueAbsolutePaths(values: string[], field: string): string[] {
  const decoded = values.map(value => decodeXmlText(value.trim()));
  if (decoded.length === 0) throw new MissingTrustedCodexEnvironmentError(field);
  if (decoded.some(path => !isAbsolute(path))) throw new Error(`ChatGPT web ${field} must contain absolute paths`);
  const unique = new Map<string, string>();
  for (const path of decoded.map(value => resolve(value))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

export function isCurrentThreadVisualizationRoot(path: string, metadata: Record<string, unknown>): boolean {
  const threadId = typeof metadata.thread_id === "string" ? metadata.thread_id.trim() : "";
  if (!threadId) return false;

  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  const base = pathIdentity(join(resolve(configuredCodexHome || join(homedir(), ".codex")), "visualizations"));
  const rel = relative(base, pathIdentity(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;

  const parts = rel.split(sep);
  const expectedThreadId = process.platform === "win32" ? threadId.toLowerCase() : threadId;
  return parts.length === 4
    && /^\d{4}$/.test(parts[0]!)
    && /^(?:0[1-9]|1[0-2])$/.test(parts[1]!)
    && /^(?:0[1-9]|[12]\d|3[01])$/.test(parts[2]!)
    && parts[3] === expectedThreadId;
}
