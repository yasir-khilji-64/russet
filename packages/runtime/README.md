# @russet/runtime

**The workspace and operational foundation for Russet.**

`@russet/runtime` provides the workspace-aware execution infrastructure for Russet, a minimal, extensible AI terminal agent.

A dependable coding harness must understand its workspace, maintain relevant context, validate model-requested operations, and enforce clear boundaries between instructions and execution authority.

**Russet Runtime establishes those operational boundaries.**

Built to integrate with [`@russet/agent`](../agent) and [`@russet/ai`](../ai), the package owns workspace management, context preparation, tools, permissions, extensions, configuration, and session infrastructure.

## Philosophy

The package follows a few principles:

- **Workspace-first.** Associate operations with an explicit workspace independent of Git or repository metadata.
- **Context-aware.** Provide relevant project instructions and workspace information without overwhelming model context.
- **Deterministic authority.** Enforce permissions independently of model-generated intentions or project instructions.
- **Managed execution.** Validate, authorize, and execute operations through a common runtime gateway.
- **Bounded autonomy.** Allow routine authorized work while preserving explicit restrictions, approvals, and cancellation.
- **Developer extensibility.** Support custom capabilities without modifying the Agent kernel or bypassing authorization.
- **Reliable outcomes.** Distinguish successful operations, failures, cancellation, and uncertain side effects.
- **Minimal infrastructure.** Prefer focused components, public contracts, and independently testable behavior over unnecessary frameworks.

The goal is a small, dependable runtime that adapts to the developer's workspace and workflow.

## Architecture

`@russet/runtime` organizes operational responsibilities into focused components:

| Component | Responsibility |
|---|---|
| **Runtime** | Construction, lifecycle, and integration |
| **Workspace** | Workspace identity, resource resolution, and filesystem boundaries |
| **Policy** | Permissions, protected resources, and operating modes |
| **Context** | `AGENTS.md` discovery, scoped instructions, and inference-context preparation |
| **Tools** | Registration, schema validation, managed handlers, and execution results |
| **Approvals** | Scoped authorization requests and decision enforcement |
| **Extensions** | Trusted capability registration and lifecycle |
| **Configuration** | YAML settings, validation, and precedence |
| **Sessions** | Conversation persistence, workspace association, and recovery |
| **Credentials** | Russet-owned authentication storage |

The public interface is exposed through `@russet/runtime`. Internal implementation details remain private to the package.

Runtime implements the tool execution gateway consumed by `@russet/agent` and supplies context through the Agent's context-preparation interface.

The Agent coordinates execution. Runtime determines operational authority. AI handles model inference.

## Workspace Policy and Context

A workspace is an explicitly selected filesystem root with associated operating restrictions and contextual information.

Workspace identity does not depend on Git. Managed operations must respect workspace boundaries, protected resources, and effective permissions.

Runtime supports two operating modes through a shared policy system, with authorization decisions represented as `allow`, `ask`, or `deny`.

Context management is a separate responsibility from authorization.

Runtime discovers workspace-root and applicable nested `AGENTS.md` files, preserves their scopes and sources, and prepares relevant instructions for model inference.

Context preparation supports bounded content, deterministic ordering, source tracking, and refresh between inference requests.

Project instructions guide model behavior but never grant execution authority.

The precise prompt representation, instruction precedence, and context-refresh semantics are established through implementation and verification rather than assumed from another harness.

## Tools and Authorization

Runtime implements the existing `ToolExecutionGateway` contract exposed by `@russet/agent`.

Model-facing tool definitions use schema-neutral descriptions, while Runtime owns authoritative TypeBox validation and execution handlers.

A completed model tool call is an untrusted proposal.

Runtime resolves the registered tool, validates arguments, determines affected resources, evaluates permissions, obtains required approvals, and executes the handler only when authorized.

Built-in and extension-registered tools share the same execution boundary.

Tool results must accurately represent success, rejection, failure, cancellation, truncation, and possible side effects.

The gateway does not provide operating-system isolation for arbitrary executable code.

## Execution Lifecycle

A managed tool operation follows a predictable sequence:

1. Receive a completed tool proposal from Agent.
2. Resolve the registered tool and validate its arguments.
3. Resolve applicable workspace resources and restrictions.
4. Evaluate effective policy and request approval when necessary.
5. Revalidate execution-sensitive conditions.
6. Execute the authorized handler with cancellation and resource limits.
7. Return a structured outcome for Agent continuation.

A denied operation never reaches its handler.

Runtime does not schedule model requests or manage the Agent's execution loop.

## Context and Session Continuity

Runtime prepares workspace context while Agent maintains the active conversation.

Context snapshots distinguish instruction sources, their applicable scopes, and their revisions.

Model context and durable session history are separate. Context selection may reduce information sent to a model without deleting authoritative conversation records.

Session infrastructure preserves relevant conversation, workspace, authorization, and execution information.

Provider-native continuation remains the responsibility of AI. Process-local continuation handles must not be treated as durable session state.

Uncertain side-effecting operations must not be automatically repeated during recovery.

## Events and Reliability

Runtime produces authorization decisions, approval updates, execution outcomes, and operational diagnostics.

It preserves execution identities supplied by Agent and reports relevant activity through the established gateway interfaces.

Cancellation is cooperative. It prevents further authorized dispatch but does not guarantee rollback or termination of arbitrary underlying operations.

Runtime must bound relevant filesystem operations and tool outputs, communicate truncation accurately, and avoid reporting uncertain execution as successful.

Operational diagnostics should remain useful without exposing credentials or unnecessarily disclosing sensitive workspace content.

## Examples and Verification

The package uses Vitest for deterministic unit and integration testing.

Verification focuses on:

- Workspace identity, boundaries, and protected resources.
- Permission evaluation and operating modes.
- Root and nested `AGENTS.md` discovery.
- Context assembly, scoping, and refresh.
- Tool registration, TypeBox validation, and authorization.
- Managed file operations and structured results.
- Approval integrity, cancellation, and uncertain outcomes.
- Extension registration and configuration precedence.
- Session continuity and recovery.
- Integration with the existing Agent and AI contracts.

Runtime components should be testable without live model providers.

Filesystem-boundary tests require real temporary directories and relevant adversarial scenarios. Live inference tests provide additional evidence of complete harness integration.

## Boundaries and Limitations

`@russet/runtime` is not an inference SDK, Agent kernel, terminal interface, or operating-system sandbox.

Workspace enforcement applies to properly mediated operations. Ordinary filesystem checks cannot guarantee complete containment against every filesystem race or hostile local process.

In-process extensions may inherit host privileges. Runtime tool permissions do not isolate arbitrary extension code.

Setting a child process's working directory does not restrict its operating-system authority.

`AGENTS.md` content is model-facing guidance, not trusted security configuration. Prompt formatting and source labels do not independently prevent prompt injection.

Session persistence, execution recovery, credential storage, and advanced resource management require their own explicit guarantees and verification.

These boundaries preserve a small, understandable operational architecture without overstating its security or reliability.

## Built to Evolve

Russet Runtime is developed in TypeScript with native Node.js ESM as part of the Russet pnpm monorepo.

Its architecture favors explicit authority, focused public contracts, deterministic tests, and incremental implementation.

New capabilities should extend the Runtime through supported interfaces rather than expanding the Agent kernel or introducing unnecessary orchestration infrastructure.

**The Workspace defines the environment. Context informs the Agent. Policy determines authority. Runtime executes authorized operations.**
