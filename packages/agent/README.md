# @russet/agent

**The agent execution foundation for Russet.**

`@russet/agent` provides the execution kernel for Russet, a minimal, extensible, workspace-aware AI terminal agent.

A dependable agent needs more than model inference. It must coordinate user requests, streaming responses, tool proposals, execution outcomes, conversation continuation, and cancellation while retaining clear boundaries between model-generated intentions and authorized operations.

**Russet Agent establishes that coordination boundary.**

Built on [`@russet/ai`](../ai), the package provides a small, Russet-owned agent execution layer. It consumes provider-independent inference contracts and delegates tool validation, authorization, and execution to the runtime.

## Philosophy

The package follows a few principles:

- **Minimal execution.** Keep the agent kernel small, explicit, and understandable without introducing unnecessary orchestration infrastructure.
- **Separation of responsibilities.** Inference belongs to AI, operational authority belongs to Runtime, and execution coordination belongs to Agent.
- **Authoritative completion.** Model-generated tool proposals become eligible for execution only after successful, complete inference responses.
- **Deterministic execution.** Execute tool calls in a predictable order with explicit limits, structured outcomes, and reliable continuation.
- **Bounded autonomy.** Support authorized work while maintaining cancellation, execution limits, and runtime-enforced permissions.
- **Conversation fidelity.** Preserve completed model responses, tool-call identities, tool results, and compatible continuation information.
- **Observable behavior.** Expose agent lifecycle events independently of model streaming without making observers responsible for execution decisions.
- **Explicit failures.** Distinguish inference failures, permission denials, tool errors, cancellation, and uncertain side effects without reporting false success.

The goal is a predictable execution kernel that remains independently testable and adaptable to different developer workflows.

## Architecture

`@russet/agent` separates execution coordination into a small collection of responsibilities:

| Component | Responsibility |
|---|---|
| **Agent** | Agent construction, active conversation, and run ownership |
| **Execution** | Model invocation, completed response processing, tool coordination, and continuation |
| **Lifecycle** | Run states, transitions, completion, and interruption |
| **Events** | Agent-level observations, model-event forwarding, and execution updates |
| **Tools** | Runtime execution interface, ordered dispatch, and tool-result coordination |
| **Reliability** | Cancellation, execution limits, failure classification, and execution integrity |

The public interface is exposed through `@russet/agent`. Internal execution details remain private to the package.

The agent consumes `@russet/ai` through its public contracts and communicates with Runtime through an injected execution interface.

It does not implement provider protocols, concrete filesystem tools, permission evaluation, extension loading, session persistence, or terminal rendering.

## Execution Lifecycle

An agent run coordinates a user request through model inference, tool execution, and conversation continuation.

The execution flow follows a small iterative loop:

1. Accept a user request and prepare the active conversation.
2. Invoke the selected model through `@russet/ai`.
3. Forward model streaming events for observation.
4. Retrieve and evaluate the authoritative completed model response.
5. Complete the run when the model finishes normally.
6. When the model requests tools, extract complete proposals and delegate execution to Runtime.
7. Record structured tool results in the required conversation order.
8. Continue inference with the updated conversation until completion or interruption.

A model response requesting tools completes an inference request, not the agent run.

Streaming tool-call events are observational. They never independently authorize execution.

The kernel maintains a single active run per agent instance and uses an iterative execution model rather than recursive orchestration or a general-purpose workflow engine.

## Tools and Authorization

`@russet/agent` coordinates model-requested tool execution through a runtime-owned gateway.

The gateway supplies model-callable tool definitions and handles invocation under the effective runtime policy.

Tool arguments originate from untrusted model output. Structural validation by the AI layer does not replace runtime schema validation, workspace enforcement, or authorization.

Runtime determines whether an operation is allowed, requires approval, or must be denied.

The agent processes completed tool proposals sequentially and preserves their original identities and ordering.

Tool outcomes distinguish successful execution from validation failures, permission denials, execution errors, cancellation, and operations that were not executed.

A denied or failed operation must never be reported as successful.

Built-in tools and future extension-registered tools share the same execution boundary. The agent does not need to know how an individual tool was registered or implemented.

The gateway contract establishes how authorization activity is coordinated. It does not, by itself, implement a permission system or guarantee that an injected gateway enforces security policy.

## Conversation and Continuation

The agent maintains the active conversation across model requests and tool interactions.

Conversation content uses the public message contracts provided by `@russet/ai`.

Completed assistant responses retain their authoritative content and available provider continuation information. Tool results preserve the identifiers and ordering required for subsequent inference.

When a model requests multiple tools, the conversation must account for every completed proposal before another model request can begin.

Model switching preserves portable conversation content while leaving provider-specific context conversion to `@russet/ai`.

Compatible native continuation information is retained during active execution without treating process-local handles as durable session records.

Conversation inspection provides defensive snapshots while preserving the identity of native continuation handles.

The agent owns in-memory conversation coordination. Persistent sessions, restoration, and recovery belong to Runtime.

## Events and Observability

`@russet/agent` distinguishes two event domains:

- **Model events** describe individual inference requests, including streamed text, thinking, tool proposals, and model completion.
- **Agent events** describe run lifecycle, execution coordination, tool outcomes, approval-related activity, and terminal states.

Agent events provide a consistent observation interface for terminal rendering, diagnostics, headless execution, and deterministic tests.

Event consumers observe execution without becoming implicit authorization mechanisms.

Each run has a distinct identity, ordered lifecycle events, and one terminal outcome.

Model request identities and tool-call identities remain correlated with their originating inference responses.

Operational failures remain distinguishable from ordinary completion.

Event delivery is run-scoped and observational. Subscribers are not awaited by the execution loop, and subscriber failures must not change execution outcomes.

The event system is not a durable audit journal, persistent event stream, or authorization mechanism.

## Cancellation and Reliability

Agent execution is explicitly cancellable and bounded.

Cancellation propagates through active model inference and runtime tool execution. Once cancellation becomes effective, the agent must not dispatch additional tool operations.

Cancellation does not imply that an already-started side effect has been reversed.

Operations with uncertain outcomes must not be treated as successful or automatically repeated.

Execution limits bound model requests and tool attempts, preventing unrestricted model-tool continuation loops.

Limits are configurable per run, with validated defaults. An active tool operation that does not confirm its outcome after cancellation can cause the run to become interrupted, preventing further execution on the affected Agent instance.

The cancellation grace period bounds the Agent's wait for an execution outcome. It does not forcibly terminate the underlying operation.

The kernel favors explicit failure handling and deterministic behavior over implicit retries or speculative recovery.

## Examples and Verification

The package uses Vitest for deterministic testing of agent execution and lifecycle behavior.

Verification focuses on:

- Model streaming and authoritative completion.
- Agent lifecycle and event ordering.
- Completed tool-call extraction and sequential execution.
- Tool-result correlation and conversation continuation.
- Runtime authorization boundaries.
- Permission denials and execution failures.
- Cancellation and execution limits.
- Partial tool batches and uncertain outcomes.
- Model switching and conversation fidelity.
- Package independence and public API compatibility.

The agent kernel is designed to be tested with injected inference and tool-execution implementations without requiring live providers or concrete Runtime services.

A live inference example can demonstrate real model streaming, agent coordination, tool execution through an example gateway, and model continuation.

A scripted inference example can deterministically exercise cancellation, denials, execution limits, and uncertain outcomes.

These examples validate different boundaries. An example gateway does not establish real workspace authorization, operating-system isolation, or production tool safety.

Live model and concrete Runtime integration tests provide additional evidence of cross-package compatibility.

## Boundaries and Limitations

`@russet/agent` is not an inference provider SDK, permission engine, filesystem runtime, session database, or terminal interface.

It relies on `@russet/ai` for provider communication, reasoning representation, model streaming, and compatible conversation conversion.

It relies on Runtime for tool validation, workspace restrictions, authorization, approvals, and actual execution.

The current architecture has several intentional constraints and unresolved capabilities.

**Execution model.** One run is active per Agent instance. Tool proposals execute sequentially, and a failed or denied operation stops dispatch of the remaining batch. Steering, concurrent tool execution, queued user messages, and parallel agent orchestration are not implemented.

**Conversation persistence.** Active conversation state is maintained in memory. Native provider continuation uses process-local handles, which are not a durable session representation. The current AI context builder requires compatible native handles for same-model continuation, so restored history cannot yet be assumed to work after a process restart. Durable restoration requires a validated portable fallback in `@russet/ai`.

**Interruption and recovery.** The Agent records uncertain execution outcomes and blocks subsequent runs on the affected instance. This protection is in memory and does not survive process termination. There is no durable execution journal, automatic rollback, or cross-process reconciliation mechanism.

**Cancellation guarantees.** Cancellation is cooperative. The Agent can stop dispatching additional operations and bound its wait for an unresponsive tool after cancellation, but it cannot guarantee that arbitrary inference providers, extensions, or child processes have terminated. An uncancelled operation is not subject to a general wall-clock execution deadline.

**Execution resources.** Model-request and tool-attempt limits are supported. Comprehensive token budgets, cost enforcement, context-window management, tool-output size limits, and execution-resource quotas are not implemented by the Agent.

**Tool-result representation.** Tool results currently use text content through the public AI conversation contract. Rich multimodal tool results and arbitrary structured execution artifacts are not part of the current continuation interface.

**Authorization and approval.** The Agent can observe approval requests and decisions, but it does not issue approvals or enforce permissions. Approval scope, expiry, replay protection, policy evaluation, and final handler authorization must be implemented and verified in Runtime.

**Events and diagnostics.** Agent events are observational and are not persisted or replayed. The event system does not provide subscriber backpressure, a durable audit trail, or comprehensive sensitive-data redaction. Full streaming content should not be assumed safe for unrestricted logging or untrusted extension consumers.

**Extension isolation.** The execution gateway does not provide operating-system isolation. Extensions running in the host process may inherit its privileges unless a separate isolation mechanism is implemented.

**Provider behavior.** Inference capabilities, thinking availability, tool selection, and continuation behavior vary by provider. Automatic provider fallback and transparent recovery from every provider failure are not guaranteed.

These limitations do not invalidate the execution kernel. They define the boundaries within which its current guarantees apply.

## MVP Readiness

The current Agent foundation validates the core architecture: provider-independent inference, run lifecycle management, model-tool continuation, runtime gateway coordination, cancellation, and deterministic execution limits.

A usable Russet MVP requires additional integration and reliability work before these capabilities can be treated as complete product-level guarantees.

The following requirements are grouped by ownership so they can be implemented without unnecessarily expanding `@russet/agent`.

### Runtime Execution and Workspace Security

**Owner: `@russet/runtime`**

The execution gateway must be backed by real managed tools rather than demonstration handlers.

Runtime must provide tool registration, schema validation, workspace-aware execution, enforceable permission decisions, and reliable structured outcomes.

Workspace enforcement must account for path normalization, symbolic links, resource boundaries, filesystem changes, and other relevant bypass conditions.

Command execution must operate under explicit authorization and actual process-level restrictions. Tool permissions must not be confused with operating-system sandboxing.

**Acceptance condition:** Real managed operations succeed only within their authorized scope, and unauthorized operations cannot reach their handlers.

### Approval Enforcement and User Interaction

**Owners: Runtime, Application, and TUI**

The runtime approval service must bind a decision to the exact operation, including its identity, normalized arguments, target resources, workspace context, effective policy, and validity period.

Approvals must be checked immediately before execution. Expired, reused, mismatched, or cancelled approvals must not authorize a handler.

The terminal interface must support clear approval requests, denial, cancellation, and operation previews. Headless execution must fail closed when required approval is unavailable.

**Acceptance condition:** An approval can authorize only the intended operation, and a denied or stale approval never results in execution.

### Durable Sessions and Portable Continuation

**Owners: Runtime and `@russet/ai`, with Agent integration**

Persistent sessions must preserve portable conversation content, ordered tool results, model identities, and relevant execution metadata.

The AI layer must support safe portable continuation when a process-local native handle cannot be restored, while retaining compatible native continuation during active execution.

Session restoration must validate conversation structure, handle incomplete records, and avoid treating serialized native handles as recoverable provider state.

The Agent should continue managing active execution without owning the session database.

**Acceptance condition:** A persisted conversation can be restored in a new process and continued safely with a supported model.

### Execution Journaling and Recovery

**Owner: Runtime, with Agent lifecycle integration**

Side-effecting operations require durable execution identities and records sufficient to distinguish proposed, authorized, started, completed, failed, and uncertain operations.

An interrupted or crashed process must not silently replay an operation whose effects are unknown.

Runtime must provide a reconciliation strategy before permitting execution to resume from an uncertain state. The initial strategy may require explicit user intervention rather than automatic recovery.

Exactly-once execution must not be claimed for arbitrary tools without the necessary guarantees.

**Acceptance condition:** Restarting or restoring a session cannot silently repeat an uncertain side-effecting operation.

### Cancellation and Process Control

**Owners: Runtime and AI, coordinated by Agent**

Runtime must define cancellation behavior for each managed tool, including child-process termination, cleanup, and truthful side-effect reporting.

Inference cancellation must be verified against the selected providers. Unresponsive inference and execution operations require explicit bounded-shutdown or interruption behavior.

A timeout or cancellation request must never be treated as evidence that an underlying operation has stopped.

**Acceptance condition:** Cancellation prevents new work, cooperatively stops supported active operations, and accurately reports any unresolved execution state.

### Context, Output, and Resource Management

**Owners: AI, Agent, and Runtime according to responsibility**

Long-running conversations require explicit context-window management, including safe history reduction or compaction without corrupting tool-call/result relationships.

Runtime must bound tool-output size, handle truncation transparently, and prevent unexpectedly large outputs from overwhelming inference context.

Available model usage and cost information should be aggregated and exposed for observability. Additional execution-time, token, and cost budgets should be introduced where the product requires enforceable resource ceilings.

**Acceptance condition:** Supported workloads remain bounded, and context or output reduction does not violate conversation integrity.

### Observability and Diagnostic Safety

**Owners: Agent, Runtime, and Application**

The application must provide useful run-level diagnostics, execution correlation, failure reporting, and resource-usage visibility.

Runtime must retain authorization and execution evidence independently of transient Agent events.

Sensitive content, credentials, raw reasoning, and tool arguments require explicit handling rules before being stored, displayed, or forwarded to extensions.

Existing Agent event contracts should remain observational. Persistent logging and telemetry should be implemented by appropriately trusted components.

**Acceptance condition:** Failures and authorization decisions can be investigated without assuming that unredacted event streams are safe to persist.

### Extension Integration and Trust

**Owner: Runtime and Extension System**

The MVP extension mechanism must allow registered tools to participate in the same model-advertisement, validation, authorization, execution, and result-reporting lifecycle as built-in tools.

Extension tools must not bypass the runtime gateway or acquire broader permissions simply because they are externally registered.

The supported trust model must be explicit. If extensions execute in-process, they must be treated as trusted code unless independent isolation is provided.

A complete extension marketplace, untrusted-code sandbox, or generalized plugin orchestration system is not required to validate this boundary.

**Acceptance condition:** A registered extension tool executes through the same authorization and continuation path as a built-in tool, without changing the Agent execution loop.

### End-to-End Integration and Security Verification

**Owners: AI, Agent, Runtime, and Application**

Deterministic Agent tests must be complemented by integration tests using real model providers and real runtime-managed tools.

Verification must cover successful execution, denial, approval, cancellation, invalid arguments, workspace-boundary enforcement, partial tool batches, uncertain outcomes, and conversation restoration.

Security-focused tests should include prompt-injected tool requests, unauthorized targets, stale approvals, sensitive-data exposure, and attempts to exceed execution limits.

The final system must demonstrate that Agent coordination, Runtime authority, and model continuation remain independent while operating together.

**Acceptance condition:** A real supported model can request a managed tool, Runtime can authorize and execute it safely, and the Agent can return the verified outcome for successful model continuation.

### Capabilities Not Required for the MVP

The MVP does not need built-in subagents, multi-agent orchestration, native MCP hosting, concurrent tool dispatch, automatic provider routing, or a general-purpose workflow engine.

These capabilities should be considered only when concrete requirements justify them.

The initial single-run, sequential-execution architecture remains a deliberate design choice. It does not need to be replaced merely because more advanced orchestration patterns exist.

## Built to Evolve

Russet Agent is implemented in TypeScript with native Node.js ESM and maintained as part of the Russet pnpm monorepo.

Its architecture favors small public contracts, explicit lifecycle semantics, deterministic tests, and independently owned packages.

New capabilities should integrate through supported Runtime and application interfaces rather than expanding the kernel with specialized orchestration behavior.

The MVP should strengthen security, persistence, recovery, and system integration while preserving the established division of responsibilities.

**Models provide inference. Runtime determines authority. The Agent coordinates execution.**
