import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Enhanced contributor intake", () => {
  test("issue forms target existing fork labels and public fork guidance", () => {
    const bug = read(".github/ISSUE_TEMPLATE/bug-report.yml");
    const feature = read(".github/ISSUE_TEMPLATE/feature-request.yml");
    const config = read(".github/ISSUE_TEMPLATE/config.yml");

    expect(bug).toContain('title: "[Bug] "');
    expect(bug).toMatch(/labels:\s*\n\s*- bug/);
    expect(feature).toContain('title: "[Feature] "');
    expect(feature).toMatch(/labels:\s*\n\s*- enhancement/);
    expect(`${bug}\n${config}`).toContain("Evanlau1798/codex-chatgpt-web/blob/main/TROUBLESHOOTING.md");
    expect(config).toContain("miuuyy/codex-chatgpt-web/discussions");
    expect(config).toContain("Evanlau1798/codex-chatgpt-web/blob/main/SECURITY.md");
    expect(`${bug}\n${feature}\n${config}`).not.toContain("miuuyy/codex-chatgpt-web/issues");
  });

  test("pull requests use deterministic lifecycle and low-usage Web gates", () => {
    const template = read(".github/PULL_REQUEST_TEMPLATE.md");

    expect(template).toContain("bun run lifecycle:sim --lane=all");
    expect(template).toContain("low-usage Web contract smoke");
    expect(template).toContain("did not retry a 429 or verification limit");
    expect(template).toContain("manual `deep` profile");
  });
});
