---
name: pro-researcher
description: "Delegate deep research, architecture reviews, literature searches, and open-ended direction-finding to ChatGPT 6 Pro sub-agents. Use when a broad investigation can reveal causes, alternatives, or a better approach beyond the immediate implementation."
---

# Pro Researcher

Use **ChatGPT 6 Pro** as a research partner. These agents can work with a large context, inspect a repository, and investigate web sources through the tools available to them. Their strength is deep investigation: finding architectural problems, connecting research to the code, challenging assumptions, and helping choose a direction.

Use them proactively when that broader view would help. You do not need a precise bug or a finished plan before asking; an abstract topic or an uncertain architectural direction is a valid assignment. Handle routine implementation locally or with coding agents. Pro researchers can edit local files, but research is their primary role.

## Select the researcher

- Inspect the available sub-agent tool and explicitly select **ChatGPT 6 Pro**. In Codex Web GPT, use `model: "chatgpt-web/gpt-6-pro"`, `reasoning_effort: "max"`, and `fork_context: false`. Use the general-purpose agent role so a coding-only role does not narrow the investigation.
- Start with no inherited conversation history. Give the researcher a self-contained assignment instead. Fork history only if the user explicitly asks for it.
- Confirm the requested model and effort are available. If the launch is rejected or the model is unavailable, explain that limitation; do not silently choose another model or create a separate user-owned chat as a substitute.
- Run **no more than two Pro researchers at once** for the task. An agent that is quiet or waiting still occupies a slot. Do not have them spawn additional researchers.
- Use two only for genuinely different questions or useful independent perspectives. Avoid duplicate investigations. A small edit or skill-maintenance task does not need a research agent.

## Give one simple assignment

Write a short, direct prompt: what to investigate, the context needed to understand it, and what would help you next. Usually one paragraph is enough. Do not build a layered prompt with elaborate roles, mandatory report templates, or a prescribed conclusion. Give the researcher room to discover something you did not anticipate.

- For repository work, include the local repository path and a few useful starting files if known. Let the agent explore beyond them.
- Encourage extensive use of external sources when useful: other developers' experience, issue discussions, fixes and design choices in popular similar repositories, documentation, and research papers. Do not limit the investigation to local code. Ask what those sources teach us, how it applies here, and for direct links.
- If the repository is public and the relevant local code matches it or differs only slightly, **also include its public URL**. This gives the researcher another way to navigate the files. Mention relevant unpublished differences briefly; use the local files for those differences.
- For literature research, asking for work from the **last one or two months** can be particularly useful. Choose the time window for the question, include older foundational work when relevant, and ask for direct sources and their practical relevance.
- Research should normally leave files unchanged. If file edits are part of the assignment, specify their scope and avoid overlapping writes with your own work or another agent.
- Ask for useful findings, a recommended direction, supporting sources or file locations, and unresolved questions. This is guidance for a useful answer, not a rigid output format.

For example:

> Review the architecture in /path/to/repository, also public at https://github.com/owner/repository. Long-running tasks sometimes lose their state. Investigate the deeper causes and recommend a direction for fixing them, with relevant file locations. Where useful, draw extensively on external sources, other developers' experience, and popular similar repositories; link the sources that inform your recommendation. Research only; leave files unchanged.

Or:

> Research approaches to persistent memory for long-running agents, focusing on papers from the last two months. What looks promising for this project, and what should we investigate next? The code is at /path/to/repository. Include direct sources and their limitations; leave files unchanged.

## Let the investigation finish

Pro research can take **30 minutes or longer**. A quiet interval is normal; elapsed time alone is not a failure.

- Prepare the assignment before launch, then **send no messages, pings, corrections, or queued follow-ups while the agent is working**. Do not interrupt, close, restart, resend the assignment, or spawn a replacement because it is taking time. An explicit user instruction to stop takes precedence.
- Continue useful independent work without duplicating the investigation or changing files the researcher owns.
- Check progress through available **read-only status or progress tools** every few minutes when useful. Use completion notifications where available. Do not ask the researcher to stop and produce a progress report.
- When its result is needed, wait for completion. Keep individual blocking waits within the tool and environment limits; a wait timeout is not a research deadline and does not mean the agent failed.
- If it reports a real terminal failure or needs user input, surface that clearly. Do not treat an incomplete investigation as a finished result or inject a mid-run correction.

## Use the result

Read the final answer before deciding what to implement. Follow the sources and inspect the code relevant to the conclusions you will use. Keep observations, hypotheses, and recommendations distinct; a persuasive research answer is not itself a tested fix.

Bring the useful direction back into the main task. Implement and verify the chosen changes locally or with a coding agent. If the completed research raises a new question, a follow-up assignment can build on that result without repeating the whole investigation.
