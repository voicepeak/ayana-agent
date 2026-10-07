"""Bounded task state independent of speech generations."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

from .tools.registry import ToolError
from .work import validate_report, check_evidence, pointer, usable_result
import json


@dataclass
class TaskRunner:
    goal: str
    limits: dict
    task_id: str = field(default_factory=lambda: "task-" + uuid.uuid4().hex[:12])
    state: str = "running"
    rounds: int = 0
    calls: int = 0
    elapsed: float = 0
    clock: float = field(default_factory=time.monotonic)
    results: dict = field(default_factory=dict)
    kind: str = "unknown"
    resolved_goal: str = ""
    detail: str = "normal"
    report_status: str = "running"
    reason: str = ""
    checks: list = field(default_factory=list)
    effects: list = field(default_factory=list)
    repair_requested: bool = False
    continues_task_id: str | None = None
    observations: dict = field(default_factory=dict)
    failures: dict = field(default_factory=dict)

    def note_observation(self, signature, digest):
        """Count identical read results so a stuck repeat can be broken.

        A changed digest means the call learned something new; only an
        unchanged digest is treated as no progress.
        """
        previous = self.observations.get(signature)
        repeats = previous["repeats"] + 1 if previous and previous["digest"] == digest else 0
        self.observations[signature] = {"digest": digest, "repeats": repeats}
        return repeats

    def note_failure(self, signature):
        """Count identical failures; the second one stops the retry loop."""
        repeats = self.failures.get(signature, 0) + 1
        self.failures[signature] = repeats
        return repeats

    def report(self, event):
        event = validate_report(event)
        kind = event.get("kind", self.kind)
        # An executed effect no longer allows the report to become an unrelated
        # chat/answer, but keeping the already-agreed kind (an answer that also
        # wrote a supporting file) must stay reportable.
        if self.effects and kind not in {self.kind, "action"}:
            raise ValueError("已经执行操作，不能改成闲聊或知识回答")
        if self.kind != "unknown" and kind != self.kind:
            raise ValueError("同一轮不能更换任务类型")
        checks = event.get("checks", self.checks)
        if self.checks and [c["description"] for c in checks] != [c["description"] for c in self.checks]:
            raise ValueError("不能删除或替换已经约定的完成条件")
        self.kind = kind
        self.continues_task_id = event.get("continues_task_id", self.continues_task_id)
        self.resolved_goal = event.get("goal", self.resolved_goal or self.goal)
        self.detail = event.get("detail", self.detail)
        self.report_status = event["status"]
        self.reason = event.get("reason", "")
        self.checks = checks

    def outcome(self):
        if self.report_status == "blocked":
            return "blocked"
        if self.report_status == "needs_input":
            return "needs_input"
        if self.kind == "unknown" and not self.effects:
            if getattr(self, "verification_pending", False):
                return "needs_verification"
            if any("error" in result["value"] for result in self.results.values()):
                return "failed"
            return "replied"
        if self.kind == "action" or self.effects:
            if (self.report_status == "complete" and self.checks
                    and all(check_evidence(check, self.results) for check in self.checks)):
                return "succeeded"
            return "needs_verification"
        return "succeeded" if self.report_status == "complete" else "replied"

    def transition(self, state):
        now = time.monotonic()
        if self.state == "running":
            self.elapsed += now - self.clock
        self.clock, self.state = now, state

    def check(self):
        elapsed = self.elapsed + (time.monotonic() - self.clock if self.state == "running" else 0)
        if elapsed >= self.limits.get("seconds", 180):
            raise ToolError("task_timeout", "任务执行时间已用完")

    def next_round(self):
        self.check()
        if self.rounds >= self.limits.get("rounds", 12):
            raise ToolError("round_budget", "任务模型轮次已用完")
        self.rounds += 1

    def next_call(self):
        self.check()
        if self.calls >= self.limits.get("calls", 24):
            raise ToolError("call_budget", "任务工具次数已用完")
        self.calls += 1

    def public(self):
        return {"task_id": self.task_id, "goal": self.goal, "state": self.state,
                "rounds": self.rounds, "calls": self.calls, "kind": self.kind,
                "resolved_goal": self.resolved_goal or self.goal, "reason": self.reason,
                "continues_task_id": self.continues_task_id,
                "checks": [{"description": c["description"], "verified": check_evidence(c, self.results)} for c in self.checks]}

    def completion_feedback(self):
        feedback = []
        for check in self.checks:
            if check_evidence(check, self.results):
                continue
            facts = []
            for fact in check.get("evidence", []):
                entry = self.results.get(fact["call_id"])
                issue = "unknown current-task call_id" if not entry else "result is failed or only a request receipt"
                actual = None
                if entry and usable_result(entry["value"]):
                    try:
                        actual = pointer(entry["value"].get("result"), fact["pointer"])
                        if len(json.dumps(actual, ensure_ascii=False)) > 1000:
                            actual = {"preview": json.dumps(actual, ensure_ascii=False)[:1000], "truncated": True}
                        issue = "actual value does not match the evidence comparison"
                    except (KeyError, IndexError, TypeError, ValueError):
                        issue = "pointer does not exist in this tool result"
                facts.append({**fact, "actual": actual, "issue": issue})
            feedback.append({"description": check["description"], "issues": facts or ["no tool evidence supplied"]})
        return feedback
