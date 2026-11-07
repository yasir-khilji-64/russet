# @russet/ai

**The model inference foundation for Russet.**

`@russet/ai` provides the model communication layer for Russet, a minimal, extensible, workspace-aware AI terminal agent.

Models differ in their protocols, reasoning capabilities, tool-calling behavior, authentication, and conversation formats. A dependable coding agent needs a consistent way to work with them without coupling its execution logic to any particular provider.

**Russet AI establishes that boundary.**

Built on [Pi AI](https://github.com/earendil-works/pi/tree/main/packages/ai), the package provides a small set of Russet-owned inference contracts while reusing established provider communication and streaming infrastructure.

## Philosophy

The package follows a few principles:

- **Provider independence.** Models should remain replaceable without redesigning the agent kernel.
- **Minimal abstraction.** Reuse Pi AI where appropriate and introduce only the contracts Russet needs.
- **Structured streaming.** Text, thinking, tool calls, and response lifecycle events remain independently observable.
- **Reasoning fidelity.** Preserve available provider-supplied thinking and compatible native continuation data without inventing unavailable information.
- **Reliable continuation.** Preserve portable conversation context across model changes without forwarding incompatible reasoning state.
- **Clear execution boundaries.** Model-generated tool requests are proposals. Validation, authorization, and execution belong to the runtime.
- **Explicit failures.** Cancellation, incomplete responses, and provider errors should remain distinguishable and observable.

The goal is a predictable inference layer that remains understandable as models and providers evolve.

## Architecture

`@russet/ai` separates model-facing concerns into a small collection of responsibilities:

| Component | Responsibility |
|---|---|
| **Models** | Curated definitions, model identities, and capability metadata |
| **Providers** | Provider-specific configuration, authentication, and Pi integration |
| **Inference** | Model requests, streaming events, completed responses, and usage |
| **Thinking** | Reasoning output classification and supported effort controls |
| **Conversation** | Structured messages, tool results, and continuation |
| **Reliability** | Cancellation, failures, partial output, and model-switching compatibility |

The public interface is exposed through `@russet/ai`. Pi-specific implementation details remain internal to the package.

The package does not execute tools, enforce workspace permissions, manage agent turns, or persist application sessions.

## Models and Providers

The initial supported model deployments are:

| Provider | Model | Environment |
|---|---|---|
| Ollama | `gpt-oss:20b` | Local inference |
| Groq | `openai/gpt-oss-20b` | Cloud inference |

Both use OpenAI-compatible Chat Completions through Pi AI.

Ollama runs through the configured local service without requiring user-provided API credentials. Groq uses `GROQ_API_KEY` for authentication.

The model registry remains intentionally small. Additional models and providers can be introduced as their compatibility is validated.

## Streaming and Continuation

The inference engine exposes dedicated event families:

- `response.*` — inference lifecycle and terminal outcomes.
- `text.*` — streamed assistant text.
- `thinking.*` — provider-supplied reasoning output.
- `toolcall.*` — streamed tool-call proposals.

Each output block maintains a stable Russet-generated identity throughout its lifecycle.

Completed responses preserve authoritative content, finish reasons, and available usage information.

Conversation continuation retains native provider state when compatible and uses portable conversation content when switching models. Foreign thinking blocks and signatures are excluded from cross-model context.

Tool calls are never executed by this package. Their completed arguments are exposed for independent validation and authorization.

## Examples and Verification

The end-to-end streaming example is available at `examples/streaming.mjs`.

After building the package, run:

- `node packages/ai/examples/streaming.mjs ollama` for local inference.
- `node packages/ai/examples/streaming.mjs groq` for cloud inference.

The example demonstrates streamed text and thinking, tool-call proposals, a synthetic arithmetic tool result, and conversation continuation.

The package uses Vitest for deterministic and provider conformance testing. Live Ollama and Groq tests are opt-in through `RUSSET_AI_LIVE=1`.

## Boundaries and Limitations

Native continuation currently uses in-memory handles. It is not a durable session format and cannot be restored automatically after a process restart.

Provider capabilities and reasoning controls may differ even when both providers serve the same underlying model family.

Model-generated tool arguments are untrusted. Schema validation, workspace restrictions, permissions, and execution remain outside `@russet/ai`.

Automatic provider fallback, persistent credential management, and agent orchestration are not part of this package's initial foundation.

## Built to Evolve

Russet AI is implemented in TypeScript with native Node.js ESM and maintained as part of the Russet pnpm monorepo.

Its architecture favors explicit interfaces, deterministic tests, and incremental provider compatibility over unnecessary inference infrastructure.

**Models will keep changing. The boundary between inference and the agent should remain dependable.**
