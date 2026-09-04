import { readFileSync, writeFileSync } from "node:fs";

export function reconcileReleaseChecksums(local: string, published: unknown): string {
  const built = new Map<string, string>();
  for (const line of local.trimEnd().split(/\r?\n/)) {
    const entry = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!entry || entry[2] === "checksums.txt" || built.has(entry[2]!)) throw new Error("Invalid local release checksum manifest");
    built.set(entry[2]!, entry[1]!);
  }
  if (!Array.isArray(published)) throw new Error("Published release asset inventory is missing");
  const seen = new Set<string>();
  for (const asset of published) {
    if (!asset || typeof asset !== "object" || typeof asset.name !== "string" || seen.has(asset.name)) {
      throw new Error("Published release asset inventory is invalid");
    }
    seen.add(asset.name);
    if (asset.name === "checksums.txt") continue;
    const expected = built.get(asset.name);
    if (!expected || asset.digest !== `sha256:${expected}`) throw new Error("Published asset differs from the locally built release");
  }
  if ([...built.keys()].some(name => !seen.has(name))) throw new Error("A locally built asset is absent from the release");
  return [...built].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, hash]) => `${hash}  ${name}\n`).join("");
}

if (import.meta.main) {
  const [local, inventory, output] = process.argv.slice(2);
  if (!local || !inventory || !output) throw new Error("Expected local manifest, published inventory, and output paths");
  writeFileSync(output, reconcileReleaseChecksums(readFileSync(local, "utf8"), JSON.parse(readFileSync(inventory, "utf8"))));
}
