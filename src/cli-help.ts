import { CHATGPT_CONNECTOR_NAME } from "./config";
import { VERSION } from "./version";

export const HELP = `codex-chatgpt-web ${VERSION}

Focused ChatGPT web-backed models for the native Codex harness.

Usage:
  codex-chatgpt-web setup --browser-only [options]
  codex-chatgpt-web setup --full --tunnel-id ID --runtime-key-file PATH [options]
  codex-chatgpt-web login
  codex-chatgpt-web doctor [--json]
  codex-chatgpt-web route <status|connect|disconnect>
  codex-chatgpt-web subagents <status|compatibility-v1|native>
  codex-chatgpt-web browser check
  codex-chatgpt-web dev launcher
  codex-chatgpt-web dev status [--json]
  codex-chatgpt-web dev setup <--browser-only|--full> [options]
  codex-chatgpt-web dev chat NAME [--model MODEL] [MESSAGE]
  codex-chatgpt-web dev list
  codex-chatgpt-web serve
  codex-chatgpt-web mcp [--broker-socket PATH]
  codex-chatgpt-web service <status|install|start|restart|stop|cancel-turns>
  codex-chatgpt-web tunnel <status|start|restart|stop|key-import>
  codex-chatgpt-web open <tunnels|runtime-keys|connectors>
  codex-chatgpt-web uninstall --yes

Setup options:
  --browser-only               Account-eligible Web models, full context/images, no local tools or tunnel
  --full                       Account-eligible Web models with tools through the configured connector
  --automatic-browser-interaction
                               Send prompts and read ChatGPT state through browser automation (default)
  --zero-risk-browser-interaction
                               Full mode: select, paste, and send in the launcher yourself
  --zero-risk-pro              Zero Risk: also install the explicit Pro-sized model row
  --zero-risk-default          Zero Risk: install only the default model row
  --port NUMBER                Loopback Responses port (default: 17841)
  --chrome PATH                Google Chrome/Chromium executable used for account login
  --browser-host-descriptor PATH
                               Use the embedded launcher browser described by this owner-only file
  --refresh-account-capabilities
                               Re-read the authenticated account's available Web models
  --app-name NAME              Automatic-mode ChatGPT connector name (default: ${CHATGPT_CONNECTOR_NAME})
  --tunnel-id ID               Existing OpenAI tunnel id (full mode)
  --runtime-key-file PATH      File containing a Tunnels Read+Use runtime key
  --codex-only                 Install only the native Codex integration
  --claude-only                Install only the Claude Code integration
  --replace-codex-route        Reversibly replace an existing openai_base_url
  --subagent-protocol MODE     compatibility-v1 (default) or native (advanced)
  --restart-service            Explicitly restart this project's daemon after an update
  --login                      Refresh the stored ChatGPT login even if one exists
  --auto-approve-tool-calls    Opt in to per-call browser clicks on "Allow once" prompts
  --enhanced-session           Enable Enhanced Web session mode
  --standard-session           Disable Enhanced Web session mode
  --bigger-context             Enable experimental adaptive context (Enhanced mode must be off)
  --standard-context           Disable experimental multi-message context
  --acknowledge-unofficial     Accept the one-time unofficial-browser-automation notice

Global:
  --home PATH                  Override ~/.codex-chatgpt-web
  -h, --help
  -v, --version
`;
