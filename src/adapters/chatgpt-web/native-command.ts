import { posix, win32 } from "node:path";

export const ONE_SHOT_SHELL_TTY_ERROR = "The one-shot shell_command cannot provide a TTY or accept later stdin. Pipe input inside the same command and use APIs compatible with the active platform shell.";

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

export function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
): string {
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return execGatewayResultProgram([
    `const result = await tools[${JSON.stringify(gatewayNestedToolName(nestedToolName))}](${JSON.stringify(nestedInput)});`,
  ]);
}

export function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
): string {
  const execCommandName = gatewayNestedToolName("exec_command");
  const shellCommandName = gatewayNestedToolName("shell_command");
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native command tool registry is unavailable\");",
    "const nativeCommandNames = new Set(ALL_TOOLS.map(tool => tool?.name));",
    `const nativeCommandCandidates = ${JSON.stringify([execCommandName, shellCommandName])}.filter(name => nativeCommandNames.has(name));`,
    "if (nativeCommandCandidates.length !== 1) throw new Error(\"Expected exactly one native command tool; found \" + (nativeCommandCandidates.join(\", \") || \"none\"));",
    "const nativeCommandName = nativeCommandCandidates[0];",
    "const nativeCommand = tools[nativeCommandName];",
    "if (typeof nativeCommand !== \"function\") throw new Error(\"Native command tool \" + nativeCommandName + \" is listed but unavailable\");",
    `if (nativeCommandName === ${JSON.stringify(shellCommandName)} && ${execCommandArguments.tty === true}) throw new Error(${JSON.stringify(ONE_SHOT_SHELL_TTY_ERROR)});`,
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await nativeCommand(nativeCommandInput);",
  ]);
}

export function claudeBashCommand(cmd: string, workdir?: string): string {
  if (!workdir) return cmd;
  const quoted = /^[A-Za-z0-9_./:@%+=,-]+$/.test(workdir)
    ? workdir
    : `'${workdir.replaceAll("'", `'"'"'`)}'`;
  return `cd -- ${quoted} && ${cmd}`;
}

export function assertClaudeBashCommand(command: string): void {
  if (/^\s*(?:Get-(?:Content|ChildItem)|Select-String|Test-Path|Set-Location)\b/i.test(command)) {
    throw new Error(
      "Claude Code Bash executes POSIX Bash; use a POSIX command such as cat instead of PowerShell cmdlets.",
    );
  }
}

export function readTextFileCommand(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (!filePath || /[\0\r\n]/.test(filePath)) throw new Error("Codex read-only file path is invalid");
  const pathApi = platform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(filePath)) throw new Error("Codex read-only file path must be absolute");
  if (platform === "win32") {
    const literal = `'${filePath.replaceAll("'", "''")}'`;
    return `Get-Content -Raw -Encoding UTF8 -LiteralPath ${literal}`;
  }
  const literal = `'${filePath.replaceAll("'", `'"'"'`)}'`;
  return `cat -- ${literal}`;
}
