"""Execution evidence describes its scope, never declares the user's goal done."""
RETRYABLE = {"file_conflict", "scope_changed", "stale_cursor", "unknown_window", "window_changed",
             "shell_busy", "process_busy", "tool_timeout", "network_error", "stale_snapshot"}


def receipt(name, result=None, effect="read", code=None, message=None):
    data = result if isinstance(result, dict) else {}
    status = data.get("status")
    verification = "observed" if effect == "read" else "unverified"
    execution, scope = "succeeded", "returned_data" if effect == "read" else "operation_only"
    if code:
        execution, verification, scope = "failed", "unverified", "none"
        if code == "browser_action_unconfirmed":
            execution, scope = "uncertain", "input_may_have_been_sent"
    elif data.get("timed_out"):
        execution, verification, scope = "timed_out", "unverified", "none"
        code, message = "tool_timeout", "执行超时，已停止本次操作"
    elif "exit_code" in data and data["exit_code"] not in {0, None}:
        execution, verification, scope = "failed", "unverified", "command_exit"
        code, message = "command_failed", f"命令退出码为 {data['exit_code']}，请结合输出判断原因"
    elif status in {"failed", "cancelled"}:
        execution, verification, scope = status, "unverified", "none"
        code, message = status, data.get("reason", "操作未完成")
    elif status in {"open_requested", "input_sent", "needs_verification"}:
        execution, scope = "requested", "request_only"
    elif status in {"waiting_approval", "proposed"}:
        execution, scope = "waiting_approval", "proposal_only"
    elif data.get("expected_result_verified") is True:
        verification, scope = "verified", "observed_expected_result"
    elif status == "window_observed":
        verification, scope = "observed", "application_window_only"
    elif name in {"files.create", "files.propose_edit", "files.propose_restore"} and data.get("sha256"):
        verification, scope = "verified", "file_contents_hash"
    elif name == "shell.run":
        verification, scope = "execution_only", "command_exit_and_output"
    elif name.startswith("process."):
        verification, scope = "observed", "process_state_only"
    elif name.startswith("browser."):
        verification, scope = "observed", "browser_page_observation"
    return {"execution": execution, "verification": verification, "scope": scope,
            "code": code, "message": message, "retryable": code in RETRYABLE, "audience": "assistant"}
