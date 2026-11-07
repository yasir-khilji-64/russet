# Russet

**A coding agent, on your terms.**

Russet is a minimal, extensible, workspace-aware AI terminal agent built for developers who value simplicity, transparency, autonomy, and control.

AI models are constantly improving, but a dependable coding agent is more than the model behind it. The runtime determines how models understand projects, interact with tools, manage permissions, execute operations, maintain context, and turn instructions into useful work.

**Russet focuses on building that runtime well.**

Inspired primarily by [Pi](https://github.com/earendil-works/pi), with ideas drawn from [OpenCode](https://github.com/anomalyco/opencode) and other coding agents, Russet embraces a small, composable architecture rather than a feature-heavy assistant.

Its goal is to provide the essential capabilities of a reliable coding agent while remaining understandable, adaptable, and independent of any particular model provider.

## Philosophy

Russet is guided by a few principles:

- **Runtime over model dependency.** Models should be replaceable without redesigning the agent. A consistent runtime provides the foundation for conversation, tools, execution, and operational control.
- **Minimalism with purpose.** Keep the agent kernel small and focused. Every abstraction, dependency, and feature should justify the complexity it introduces.
- **Transparency by design.** Model responses, tool calls, permission decisions, file changes, and execution outcomes should remain observable rather than hidden behind automation.
- **Developer autonomy.** Routine authorized work should proceed without repetitive approvals, while consequential operations remain subject to explicit authority.
- **Workspace-first operation.** An explicitly selected directory defines the working context and boundaries for managed filesystem operations, independently of Git or repository metadata.
- **Extensibility through composition.** Developers should be able to introduce tools, instructions, and workflow-specific behavior without modifying or forking the agent kernel.
- **Continuity without complexity.** Conversations and execution state should remain coherent across model interactions, with persistent sessions and recovery supporting longer-running workflows.
- **Local ownership.** Developers control their workspaces, configurations, credentials, and extensions without requiring a Russet-operated backend.

The goal is not to build an agent that does everything. It is to build one that handles the essential work reliably and can evolve without losing its simplicity.

## Architecture

Russet separates its responsibilities into five focused packages:

| Package | Responsibility |
|---|---|
| **`@russet/ai`** | Unified model communication, streaming, model metadata, credentials, and provider-independent interfaces |
| **`@russet/agent`** | Minimal agent kernel, execution lifecycle, conversation coordination, tool continuation, and events |
| **`@russet/runtime`** | Workspace management, permissions, tools, operating modes, extensions, configuration, and sessions |
| **`@russet/tui`** | Interactive terminal interface, streaming presentation, user input, and approval interactions |
| **`@russet/code`** | Developer-facing CLI, application bootstrap, and integration of the underlying packages |

The model layer remains independent of agent execution and workspace policy. The agent kernel coordinates model interactions and tool requests without owning concrete tools or execution permissions.

The runtime provides those capabilities, validates operations, and enforces authorization independently of the model. The terminal interface presents the interaction without controlling the underlying execution rules.

Russet uses [Pi AI](https://github.com/earendil-works/pi/tree/main/packages/ai) as its initial inference foundation while retaining ownership of its agent execution, permissions, extensions, sessions, and developer experience.

This separation keeps the system understandable, independently testable, and adaptable without introducing unnecessary orchestration infrastructure.

## The Coding Experience

Russet is designed around a straightforward workflow: select a workspace, choose a model, describe what needs to be done, and let the agent work within clearly defined boundaries.

The initial experience focuses on:

- Exploring and understanding codebases and other workspace contents.
- Listing, reading, and searching permitted files.
- Making precise, authorized file edits and modifications.
- Executing explicitly permitted commands and development workflows.
- Streaming model responses, available reasoning content, and tool activity.
- Using project-specific instructions and configuration to guide behavior.
- Switching models while preserving portable conversational context.
- Extending agent capabilities through supported tools and lifecycle hooks.
- Maintaining sessions and supporting recovery from interruptions.
- Handling errors, cancellation, and execution limits predictably.
- Providing a focused, keyboard-driven terminal experience.

Russet provides two operating modes:

- **Exploration mode.** Inspect, search, understand, and plan without modifying workspace files or executing arbitrary shell commands.
- **Modification mode.** Make authorized file changes and perform permitted operations while retaining exploration capabilities.

These are descriptive names; the final user-facing mode names have not yet been selected.

Modes share the same agent kernel and session. Switching modes does not require recreating the agent or discarding conversation context.

Russet aims to make understanding a workspace and making changes to it feel like two parts of the same continuous workflow.

### Execution and trust

Russet follows a deterministic permission model built around `allow`, `ask`, and `deny` decisions.

In its write-capable mode, ordinary authorized file operations inside the active workspace can proceed automatically. More consequential operations, including command execution, are governed by explicit runtime policy and scoped approvals.

Built-in filesystem tools are designed to enforce workspace boundaries, protected paths, and restrictions against prohibited external access, including symlink-based escapes.

**Russet does not include an operating-system sandbox in its initial releases.**

Shell commands and trusted native extensions execute with the privileges available to the running process. Selecting a workspace determines the operational context, but does not isolate subprocesses from the rest of the filesystem, network, or operating system.

Permissions control what Russet authorizes through its managed execution interfaces. They are not a substitute for operating-system isolation.

Russet therefore emphasizes clear authorization, visible execution consequences, and honest security boundaries rather than promising containment it cannot enforce.

## Built to Evolve

Russet begins with a small, curated collection of models sourced from [models.dev](https://models.dev), using Pi AI for provider communication and inference.

The initial proof of concept focuses on local inference through Ollama, with support for OpenAI, Anthropic, and Google Gemini targeted for the MVP.

The model registry remains intentionally small at first. Additional models and provider configurations can be introduced as their compatibility and behavior are validated.

Russet is built with TypeScript and Node.js, organized as a pnpm monorepo, with [Ink](https://github.com/vadimdemedes/ink) and React powering its terminal interface.

**The initial development scope targets Linux and macOS.** Windows and PowerShell support are deferred to future development.

Russet deliberately avoids built-in MCP infrastructure, subagents, multi-agent orchestration, and other large coordination systems. Developers can introduce advanced workflows through trusted extensions without making those systems mandatory parts of the core.

As the project matures, capabilities should evolve through small, stable interfaces and demonstrated requirements rather than speculative abstractions.

**Extensibility should be a property of the architecture, not an excuse for unnecessary complexity.**

---

**Russet is built on a simple conviction: models will keep changing, but the agent that turns their capabilities into useful work should remain understandable, dependable, adaptable, and yours to control.**
