import { expect, test } from "bun:test";
import { assertClaudeBashCommand } from "../src/adapters/chatgpt-web/native-command";

test("rejects PowerShell cmdlets before forwarding a command to Claude Bash", () => {
  for (const command of [
    "Get-Content -Raw file.txt",
    "  Get-ChildItem tests",
    "Select-String -Pattern smoke file.log",
    "Test-Path C:\\temp",
    "Set-Location G:\\repo",
  ]) {
    expect(() => assertClaudeBashCommand(command)).toThrow("Claude Code Bash executes POSIX Bash");
  }
});

test("accepts POSIX commands and PowerShell-looking text that is not the executable", () => {
  for (const command of [
    "cat -- file.txt",
    "rg 'Get-Content' src",
    "printf '%s\\n' 'Test-Path'",
    "git status --short",
  ]) {
    expect(() => assertClaudeBashCommand(command)).not.toThrow();
  }
});
