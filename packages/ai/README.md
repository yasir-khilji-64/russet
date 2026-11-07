# @russet/ai

**The inference foundation for a coding agent, on your terms.**

`@russet/ai` is the model integration package for [Russet](https://github.com/yasir-khilji-64/russet), a minimal, extensible, workspace-aware AI terminal agent.

Language models differ in their APIs, capabilities, reasoning behavior, authentication, and conversation formats. A dependable agent needs a consistent way to communicate with them without tying its execution logic to any particular provider.

**Russet AI provides that boundary.**

Built on [Pi AI](https://github.com/earendil-works/pi/tree/main/packages/ai), the package provides provider-independent inference contracts while reusing established infrastructure for model communication, streaming, tool calling, authentication, and conversation compatibility.

Its purpose is not to create another comprehensive inference SDK, but to expose the essential model capabilities through a small, predictable interface that the rest of Russet can depend on.

## Philosophy

The package follows a few principles:

- **Provider independence.** Model providers and their protocols should remain replaceable without redesigning the agent kernel.
- **Minimal abstraction.** Reuse Pi AI's inference infrastructure and introduce Russet-owned contracts only where they establish meaningful boundaries.
- **Structured streaming.** Text, thinking, and tool calls should remain distinct, observable parts of a model response.
- **Accurate reasoning representation.** Preserve provider-supplied thinking, reasoning summaries, and native continuation information without inventing unavailable content.
- **Reliable continuation.** Maintain portable conversation history while respecting provider-specific requirements for subsequent model requests.
- **Explicit capabilities.** Model metadata should describe known capabilities without assuming that every provider supports identical behavior.
- **Clear ownership.** Inference communicates model requests and responses; tool execution, permissions, and workspace authority belong elsewhere.

The goal is a small inference layer that remains understandable as models and providers evolve.

## Architecture

`@russet/ai` owns the model-facing responsibilities of Russet:

| Component | Responsibility |
|---|---|
| **Model Registry** | Curated model definitions, identities, capabilities, and selection metadata |
| **Provider Integration** | Provider configuration, protocol compatibility, and inference through Pi AI |
| **Inference** | Model requests, streaming events, completed responses, and usage information |
| **Credentials** | Authentication resolution interfaces and injectable credential storage contracts |
| **Conversation** | Portable messages, tool-call representations, and provider-native continuation |

The package exposes Russet-owned interfaces while keeping provider-specific implementation details within its inference adapter.

It does not implement the agent execution loop, manage workspaces, execute tools, enforce permissions, render the terminal interface, or persist sessions.

Tool schemas cross into the package as JSON Schema-compatible definitions. Authoritative tool validation and execution remain the responsibility of `@russet/runtime`.

This separation keeps the inference layer independently testable and allows the agent kernel to operate without understanding native provider protocols.

## Models and Providers

Russet AI begins with a small, curated model registry using selected metadata from [models.dev](https://models.dev).

The initial proof of concept targets two deployments of GPT-OSS 20B:

| Provider | Model | Environment |
|---|---|---|
| Ollama | `gpt-oss:20b` | Local |
| Groq | `openai/gpt-oss-20b` | Cloud |

Both use OpenAI-compatible inference through Pi AI, while retaining their own provider configuration, authentication, and compatibility behavior.

The broader Russet MVP targets OpenAI, Anthropic, and Google Gemini.

The registry remains intentionally small. Models are introduced as their required capabilities and provider behavior are validated, without requiring a full external catalog or network-based metadata initialization during startup.

## Streaming and Reasoning

Russet AI is designed around incremental model responses.

Its model event contract distinguishes text, thinking, tool calls, and response lifecycle events. Each streamed block maintains a stable identity from its initial event through completion.

Thinking is supported as a first-class capability. The package distinguishes readable provider-supplied reasoning, summaries, opaque continuation state, and unavailable reasoning.

Completed responses preserve the authoritative content and metadata needed for conversation continuation.

Structured tool calls are exposed as model requests, not executed operations. The agent and runtime remain responsible for validating, authorizing, and executing them.

## Built to Evolve

Russet AI is developed with TypeScript and Node.js as part of the pnpm-based Russet monorepo.

The initial implementation focuses on Linux and macOS, with Vitest providing deterministic and provider-level conformance testing.

As additional model providers are introduced, the package should evolve through focused compatibility improvements rather than unnecessary transport implementations or abstraction layers.

**The model should remain replaceable. The contract between inference and the agent should remain dependable.**
