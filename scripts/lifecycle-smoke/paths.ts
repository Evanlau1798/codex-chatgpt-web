import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface PathJoiner {
  join: (...paths: string[]) => string;
}

export function joinSmokePath(path: PathJoiner, ...parts: string[]): string {
  return path.join(...parts);
}

export function smokePath(...parts: string[]): string {
  return join(...parts);
}

export function findClaudeTranscript(configDir: string, sessionId: string): string {
  const projects = join(configDir, "projects");
  const matches = existsSync(projects)
    ? readdirSync(projects, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(projects, entry.name, `${sessionId}.jsonl`))
      .filter(existsSync)
    : [];
  if (matches.length === 0) {
    throw new Error(`Claude transcript was not found for session ${sessionId}`);
  }
  if (matches.length > 1) {
    throw new Error(`Claude transcript is ambiguous for session ${sessionId}`);
  }
  return matches[0]!;
}
