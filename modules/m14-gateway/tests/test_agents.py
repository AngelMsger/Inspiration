from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any

import pytest

from inspiration.contracts.models import (
    AgentApproval,
    AgentRunContext,
    AgentRunStatus,
    AgentSpec,
    AgentStepKind,
    ChatRole,
    ModelTier,
    Principal,
    PrincipalKind,
    SensitivityLabel,
    ToolEffect,
    ToolSpec,
    UsageStatus,
)
from inspiration.gateway import FunctionTool, Gateway, MemoryRuns, MemoryUsage, Prompt, PromptRegistry, Runtime
from inspiration.gateway.agents import ReplayTools, ToolRegistry, action_schema

TASK = "m9.comment_assistant"
TENANT = "ten_01JC000000000000000000TEN1"
PROPOSAL = "prp_01JC000000000000000000PRP1"

SEARCH = ToolSpec(
    name="search",
    description="Search claims the caller may read.",
    input_schema={"type": "object", "required": ["query"], "properties": {"query": {"type": "string"}}},
    effect=ToolEffect.read,
)
PROPOSE = ToolSpec(
    name="propose_edit",
    description="Propose an edit to a page block. A steward or owner approves it.",
    input_schema={
        "type": "object",
        "required": ["block_key", "text"],
        "properties": {"block_key": {"type": "string"}, "text": {"type": "string"}},
    },
    effect=ToolEffect.propose,
)


def spec(**overrides: Any) -> AgentSpec:
    fields: dict[str, Any] = {
        "name": TASK,
        "version": "0.1.0",
        "prompt_version": "comment@1",
        "tools": ["search", "propose_edit"],
        "max_steps": 6,
        "max_tokens": 24_000,
        "approval": AgentApproval.owner,
        "tier": ModelTier.standard,
        "output_schema": {"type": "object", "required": ["reply"], "properties": {"reply": {"type": "string"}}},
    }
    fields.update(overrides)
    return AgentSpec(**fields)


def context(**principal: Any) -> AgentRunContext:
    fields: dict[str, Any] = {
        "id": "agt_01JC000000000000000000AGT1",
        "kind": PrincipalKind.agent,
        "tenant_id": TENANT,
        "on_behalf_of": "usr_01JC000000000000000000USR1",
    }
    fields.update(principal)
    return AgentRunContext(principal=Principal(**fields), budget_key=f"tenant:{TENANT}/m9", trace_id="trace-1")


def call(tool: str, **arguments: Any) -> str:
    return json.dumps({"thought": f"use {tool}", "action": "call_tool", "tool": tool, "arguments": arguments})


def final(**output: Any) -> str:
    return json.dumps({"thought": "done", "action": "final", "output": output})


class Tools:
    """search and propose_edit, recording their calls. search labels its result."""

    def __init__(self, sensitivity: SensitivityLabel | None = SensitivityLabel.confidential) -> None:
        self.sensitivity = sensitivity
        self.calls: list[tuple[str, Mapping[str, Any]]] = []

    async def search(self, args: Mapping[str, Any], ctx: AgentRunContext) -> dict[str, Any]:
        self.calls.append(("search", args))
        result: dict[str, Any] = {"hits": [{"claim_id": "clm_01JC000000000000000000CLM1", "text": "Cap is 600 CNY"}]}
        if self.sensitivity is not None:
            result["sensitivity"] = self.sensitivity.value
        return result

    async def propose(self, args: Mapping[str, Any], ctx: AgentRunContext) -> dict[str, Any]:
        self.calls.append(("propose_edit", args))
        return {"proposal_id": PROPOSAL, "status": "pending"}

    def registry(self) -> ToolRegistry:
        return ToolRegistry([FunctionTool(SEARCH, self.search), FunctionTool(PROPOSE, self.propose)])


@pytest.fixture
def prompts() -> PromptRegistry:
    reg = PromptRegistry()
    reg.register(
        Prompt(
            task=TASK,
            version="comment@1",
            system="You answer comments on knowledge pages, with citations.",
            user="Comment: {{input}}",
        )
    )
    return reg


@pytest.fixture
def make_runtime(gateway: Gateway, prompts: PromptRegistry) -> Callable[..., Runtime]:
    def make(tools: ToolRegistry, **kwargs: Any) -> Runtime:
        return Runtime(gateway, tools, prompts, **kwargs)

    return make


async def test_a_run_calls_tools_collects_proposals_and_waits_for_approval(
    gateway: Gateway, make_runtime: Callable[..., Runtime]
) -> None:
    tools = Tools()
    gateway.provider("cloud").script(TASK, call("search", query="hotel cap"))
    # search returned confidential content, so every later step must stay on the local model.
    gateway.provider("local").script(
        TASK, call("propose_edit", block_key="b_cap", text="The cap is 600 CNY."), final(reply="Updated, see claim.")
    )
    runs = MemoryRuns()
    result = await make_runtime(tools.registry(), runs=runs).run(spec(), {"comment": "Is the cap 500?"}, context())

    assert result.status == AgentRunStatus.needs_approval
    assert result.output == {"reply": "Updated, see claim."}
    assert result.proposal_ids == [PROPOSAL]
    assert [s.kind for s in result.steps] == [AgentStepKind.tool_call, AgentStepKind.tool_call, AgentStepKind.final]
    assert [name for name, _ in tools.calls] == ["search", "propose_edit"]
    assert len(gateway.provider("cloud").calls) == 1 and len(gateway.provider("local").calls) == 2
    usage = gateway.usage
    assert isinstance(usage, MemoryUsage)
    assert [r.sensitivity for r in usage.records] == [
        SensitivityLabel.internal,
        SensitivityLabel.confidential,
        SensitivityLabel.confidential,
    ]
    assert result.usage.input_tokens == sum(r.usage.input_tokens for r in usage.records)
    assert result.cost.amount == pytest.approx(sum(r.cost.amount for r in usage.records))
    assert result.run_id.startswith("run_") and result.trace_id == "trace-1"
    assert await runs.get(result.run_id) == result


async def test_invalid_arguments_are_reported_to_the_model(
    gateway: Gateway, make_runtime: Callable[..., Runtime]
) -> None:
    tools = Tools(sensitivity=None)
    seen: list[str] = []

    def after_error(messages: Any) -> str:
        seen.append(next(m.content for m in reversed(messages) if m.role == ChatRole.user))
        return call("search", query="hotel cap")

    gateway.provider("cloud").script(TASK, call("search"), after_error, final(reply="ok"))
    result = await make_runtime(tools.registry()).run(spec(approval=AgentApproval.none), "q", context())

    assert result.status == AgentRunStatus.completed
    error = result.steps[0]
    assert error.kind == AgentStepKind.error and error.tool == "search"
    assert error.error is not None and "'query' is a required property" in error.error
    assert seen[0].startswith("Error: invalid arguments for search")
    assert tools.calls == [("search", {"query": "hotel cap"})]


async def test_an_unknown_tool_is_corrected_inside_the_gateway(
    gateway: Gateway, make_runtime: Callable[..., Runtime]
) -> None:
    # The action schema enumerates the tools, so the gateway's corrective retry catches this.
    gateway.provider("cloud").script(TASK, call("delete_everything"), final(reply="ok"))
    result = await make_runtime(Tools().registry()).run(spec(approval=AgentApproval.none), "q", context())
    assert result.status == AgentRunStatus.completed and len(result.steps) == 1


async def test_output_that_never_matches_the_schema_fails_the_run(
    gateway: Gateway, make_runtime: Callable[..., Runtime]
) -> None:
    gateway.provider("cloud").script(TASK, final(answer="x"), final(answer="y"))
    result = await make_runtime(Tools().registry()).run(spec(), "q", context())
    assert result.status == AgentRunStatus.failed
    assert result.error is not None and "reply" in result.error
    assert result.steps[-1].kind == AgentStepKind.error


async def test_a_failing_tool_does_not_end_the_run(gateway: Gateway, make_runtime: Callable[..., Runtime]) -> None:
    async def broken(args: Mapping[str, Any], ctx: AgentRunContext) -> Any:
        raise RuntimeError("index offline")

    tools = ToolRegistry([FunctionTool(SEARCH, broken), FunctionTool(PROPOSE, Tools().propose)])
    gateway.provider("cloud").script(TASK, call("search", query="x"), final(reply="Search is down."))
    result = await make_runtime(tools).run(spec(approval=AgentApproval.none), "q", context())
    assert result.status == AgentRunStatus.completed
    assert result.steps[0].error == "RuntimeError: index offline"
    assert result.steps[0].result == "Error: RuntimeError: index offline"


async def test_step_and_token_limits(gateway: Gateway, make_runtime: Callable[..., Runtime]) -> None:
    tools = Tools(sensitivity=None)
    gateway.provider("cloud").script(TASK, call("search", query="a"), call("search", query="b"))
    result = await make_runtime(tools.registry()).run(spec(max_steps=2), "q", context())
    assert result.status == AgentRunStatus.max_steps and len(result.steps) == 2

    gateway.provider("cloud").script(TASK, call("search", query="a"))
    # A different input, so the first step is not served from the response cache.
    result = await make_runtime(tools.registry()).run(spec(max_tokens=1), "q2", context())
    assert result.status == AgentRunStatus.budget_exceeded and len(result.steps) == 1


async def test_gateway_budget_exhaustion_stops_the_run(gateway: Gateway, make_runtime: Callable[..., Runtime]) -> None:
    gateway.provider("cloud").script(TASK, call("search", query="word " * 300))
    ctx = context().model_copy(update={"budget_key": "tenant:capped/m9"})
    result = await make_runtime(Tools(sensitivity=None).registry()).run(spec(), "q", ctx)
    assert result.status == AgentRunStatus.budget_exceeded
    assert result.steps[-1].kind == AgentStepKind.error


async def test_agents_must_act_on_behalf_of_a_person(make_runtime: Callable[..., Runtime]) -> None:
    with pytest.raises(ValueError, match="on behalf of"):
        await make_runtime(Tools().registry()).run(spec(), "q", context(on_behalf_of=None))


async def test_service_principals_run_without_a_person(gateway: Gateway, make_runtime: Callable[..., Runtime]) -> None:
    gateway.provider("cloud").script(TASK, final(reply="ok"))
    ctx = context(id="svc_01JC000000000000000000SVC1", kind=PrincipalKind.service, on_behalf_of=None)
    result = await make_runtime(Tools().registry()).run(spec(approval=AgentApproval.none), "q", ctx)
    assert result.status == AgentRunStatus.completed


async def test_unknown_tools_in_a_spec_are_rejected(make_runtime: Callable[..., Runtime]) -> None:
    with pytest.raises(KeyError, match="get_sop"):
        await make_runtime(Tools().registry()).run(spec(tools=["search", "get_sop"]), "q", context())


async def test_replay_returns_recorded_results_without_calling_tools(
    gateway: Gateway, make_runtime: Callable[..., Runtime]
) -> None:
    tools = Tools()
    script = [call("propose_edit", block_key="b_cap", text="600"), final(reply="done")]
    gateway.provider("cloud").script(TASK, call("search", query="hotel cap"))
    gateway.provider("local").script(TASK, *script)
    recorded = await make_runtime(tools.registry()).run(spec(), "q", context())

    replayed = await make_runtime(ReplayTools([SEARCH, PROPOSE], recorded)).run(spec(), "q", context())

    assert len(tools.calls) == 2  # only the recorded run touched the real tools
    assert [s.result for s in replayed.steps] == [s.result for s in recorded.steps]
    assert replayed.proposal_ids == recorded.proposal_ids
    # The replayed search result keeps its label, so every step routes as in the recorded run
    # and, with the same messages at temperature 0, is answered from the response cache.
    usage = gateway.usage
    assert isinstance(usage, MemoryUsage)
    again = usage.records[len(recorded.steps) :]
    assert [r.sensitivity for r in again] == [r.sensitivity for r in usage.records[: len(recorded.steps)]]
    assert {r.status for r in again} == {UsageStatus.cached}


def test_action_schema_is_one_flat_object() -> None:
    schema = action_schema(spec(), [SEARCH, PROPOSE])
    assert "oneOf" not in json.dumps(schema)
    assert schema["properties"]["tool"] == {"enum": ["search", "propose_edit"]}
    assert schema["properties"]["output"]["required"] == ["reply"]
