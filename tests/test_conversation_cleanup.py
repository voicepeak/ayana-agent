import json

from services.agent.storage import ConversationStore


def test_delete_reclaims_database_and_scoped_resources_preserving_shared_records(tmp_path):
    path = tmp_path / "history.sqlite3"
    store = ConversationStore(path)
    try:
        marker = "DELETE-THIS-CONTENT-" + "x" * 64000
        for cid in ("delete", "keep"):
            store.put_record("conversation", cid, {"conversation_id": cid})
            store.commit({"type": "user.message", "conversation_id": cid,
                          "text": marker if cid == "delete" else "keep this", "turn_id": cid})
        store.put_record("artifact", "exclusive", {"artifact_id": "exclusive", "path": "/keep/file.txt"})
        store.put_record("source", "shared", {"source_id": "shared"})
        store.put_record("memory", "memory", {"source": {"conversation_id": "delete"}, "content": "private"})
        store.commit({"type": "artifact.ready", "conversation_id": "delete", "artifact": {"artifact_id": "exclusive"}})
        for cid in ("delete", "keep"):
            store.commit({"type": "source.ready", "conversation_id": cid, "source": {"source_id": "shared"}})
        store.db.execute("INSERT INTO model_turns(scope,payload) VALUES(?,?)", ("conversation:delete", json.dumps({"messages": [marker]})))
        store.db.execute("INSERT INTO context_summaries VALUES(?,?)", ("conversation:delete", marker))
        store.db.commit()
        store.delete_conversation("delete")
        assert not store.get_record("conversation", "delete")
        assert not store.get_record("artifact", "exclusive")
        assert not store.get_record("memory", "memory")
        assert store.get_record("source", "shared") and store.get_record("conversation", "keep")
        assert not store.model_turns("conversation:delete") and not store.context_summary("conversation:delete")
        assert store.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert b"DELETE-THIS-CONTENT" not in path.read_bytes()
        wal = path.with_name(path.name + "-wal")
        assert not wal.exists() or not wal.stat().st_size
        assert store.search_history("keep this")["items"]
    finally:
        store.close()
