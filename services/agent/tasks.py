"""Bounded task state independent of speech generations."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

from .tools.registry import ToolError


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
                "rounds": self.rounds, "calls": self.calls}
