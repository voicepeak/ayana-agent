from __future__ import annotations

import asyncio
from copy import deepcopy
import httpx
import json

from .context import summarize_history, summary_batches


class ConversationRuntime:
    def _select_history(self):
        self.prompt_history.select("", self.settings.values, conversation_id=self.conversations.current_id)

    async def _conversation_snapshot(self, changed=False):
        self._select_history()
        await self.emit("conversation.changed" if changed else "conversations.ready",
                        **self.conversations.snapshot(), summary=self.prompt_history.summary,
                        retained_turns=len(self.prompt_history.turns))
        await self.emit("sources.ready", sources=[source for source in self.web.sources.values()
                        if source.get("conversation_id") == self.conversations.current_id],
                        sources_conversation_id=self.conversations.current_id)

    async def _history_snapshot(self, cid=None, before=None):
        cid = cid or self.conversations.current_id
        if before is not None and (type(before) is not int or before <= 0):
            raise ValueError("无效的历史分页位置")
        page = await asyncio.to_thread(self.conversations.history, cid, before)
        await self.emit("history.ready", history=page["items"], history_conversation_id=cid,
                        has_more=page["has_more"], before=page["before"], prepend=before is not None)

    async def _conversation_command(self, cmd):
        kind = cmd["type"]
        if kind == "conversations.get":
            await self._conversation_snapshot()
            await self._memory_snapshot()
        elif kind == 'conversation.history':
            cid = cmd.get('conversation_id')
            if not isinstance(cid,str) or cid not in self.conversations.records:
                raise ValueError('找不到这段对话')
            before = cmd.get('before')
            if before is not None and (type(before) is not int or before <= 0):
                raise ValueError('无效的分页位置')
            page = await asyncio.to_thread(self.conversations.history, cid, before)
            await self.emit('conversation.review', review_id=cid, request_id=cmd.get('request_id'),
                            title=self.conversations.records[cid]['title'], prepend=bool(cmd.get('prepend', before is not None)), **page)
        elif kind == 'conversation.search':
            query = cmd.get('query', '')
            if not isinstance(query,str) or len(query)>200:
                raise ValueError('搜索词最多 200 字')
            before, start, end = (cmd.get(key) for key in ('before','start','end'))
            for value in (before,start,end):
                if value is not None and (type(value) not in {int,float} or value<0):
                    raise ValueError('无效的搜索范围')
            if before is not None and type(before) is not int:
                raise ValueError('无效的分页位置')
            if start is not None and end is not None and start>=end:
                raise ValueError('结束日期应晚于开始日期')
            if self.conversations.persist:
                page = await asyncio.to_thread(self.store.search_history, query.strip(), before, start, end)
            else:
                items = [dict(item,conversation_id=cid,text=item.get('text') or item.get('display_zh') or item.get('speech_ja',''))
                         for cid in self.conversations.records for item in self.conversations.live.get(cid, {}).values()]
                items = sorted([item for item in items if (before is None or item['id']<before)
                    and (start is None or item['created']>=start) and (end is None or item['created']<end)
                    and query.casefold() in item['text'].casefold()],key=lambda item:item['id'],reverse=True)
                page = {'items':items[:40],'has_more':len(items)>40,'before':items[39]['id'] if len(items)>40 else None}
            for item in page['items']:
                item['title'] = self.conversations.records.get(item['conversation_id'],{}).get('title','之前的对话')
            await self.emit('conversation.search-results', query=query, request_id=cmd.get('request_id'),
                            prepend=before is not None, **page)
        elif kind == 'conversation.export':
            cid, format = cmd.get('conversation_id'), cmd.get('format','markdown')
            if not isinstance(cid,str) or cid not in self.conversations.records or format not in {'markdown','json'}:
                raise ValueError('无效的导出对话或格式')
            items, before = [], None
            while True:
                page = await asyncio.to_thread(self.conversations.history,cid,before)
                items = [*page['items'],*items]
                if not page['has_more']:
                    break
                before = page['before']
            from datetime import datetime
            import re
            record = self.conversations.records[cid]
            data = {'title':record['title'],'conversation_id':cid,'messages':items,
                    'summary':self.store.context_summary('conversation:'+cid) if self.conversations.persist else ''}
            if format == 'json':
                content = json.dumps(data,ensure_ascii=False,indent=2)
            else:
                content = '# '+record['title']+'\n\n'+'\n\n'.join(
                    '### '+datetime.fromtimestamp(item['created']).strftime('%Y-%m-%d %H:%M:%S')+' · '+
                    ('你' if item['role']=='user' else '彩名')+'\n\n'+str(item.get('text') or item.get('display_zh') or item.get('speech_ja',''))
                    for item in items)
            directory = self.settings.data_root / 'artifacts/conversations'
            directory.mkdir(parents=True,exist_ok=True)
            path = directory / (re.sub(r'[^a-zA-Z0-9_-]','_',cid)+'-'+datetime.now().strftime('%Y%m%d-%H%M%S%f')+
                                ('.json' if format=='json' else '.md'))
            await asyncio.to_thread(path.write_text,content,encoding='utf-8')
            await self.emit('conversation.exported',path=str(path),title=record['title'],request_id=cmd.get('request_id'))
        elif kind == 'conversation.delete':
            cid = cmd.get('conversation_id')
            if not isinstance(cid,str) or cid not in self.conversations.records:
                raise ValueError('找不到这段对话')
            active = self.conversations.current_id == cid
            # Stop background writers before removing their source conversation.
            for job in (self.memory_task, self.context_job, *tuple(self.subtitle_jobs)):
                if job and not job.done():
                    job.cancel()
            await asyncio.gather(*(job for job in (self.memory_task, self.context_job, *tuple(self.subtitle_jobs)) if job), return_exceptions=True)
            self.memory_state = 'ready'
            if active:
                await self.cancel('conversation_deleted')
                self.last_reply_turn = self.last_reply_delivered = None
                self.last_reply_keys = {}
                self.turn_id = ''
                self.target = self.snapshot = None
                self.observation = None
                await self.emit('snapshot.invalidated')
                await self.emit('session.started',target=None,provider=self.settings.values['provider'])
            self.memory.forget_source(cid)
            await asyncio.to_thread(self.conversations.delete,cid)
            self.prompt_history.temporary.pop('conversation:'+cid,None)
            if active:
                self.prompt_history.scope = None
                self._select_history()
            self.prompt_trace.clear()
            self.utterances = {uid:record for uid,record in self.utterances.items() if record.get('conversation_id')!=cid}
            self.recent_observations = [item for item in self.recent_observations if item['conversation_id'] != cid]
            await self.emit('conversation.deleted',deleted_id=cid,request_id=cmd.get('request_id'))
            await self._conversation_snapshot(changed=active)
            await self._history_snapshot()
            await self._memory_snapshot()
            await self._capabilities_snapshot()
        elif kind == 'memory.get':
            await self._memory_snapshot()
        elif kind in {'memory.update','memory.forget'}:
            if kind == 'memory.update':
                self.memory.update(cmd.get('memory_id'),cmd.get('content'))
            else:
                self.memory.forget(cmd.get('memory_id'))
            self.prompt_trace.clear()
            await self._memory_snapshot(cmd.get('request_id'))
        elif kind in {"conversation.create", "conversation.select"}:
            if kind == "conversation.select":
                cid = cmd.get("conversation_id")
                if not isinstance(cid, str) or cid not in self.conversations.records:
                    raise ValueError("找不到这个话题")
                if cid == self.conversations.current_id:
                    await self._conversation_snapshot()
                    return True
            await self.cancel("conversation_changed")
            self.last_reply_turn = None
            self.last_reply_keys = {}
            self.last_reply_delivered = None
            self.turn_id = ""
            if kind == "conversation.create":
                await asyncio.to_thread(self.conversations.create)
            else:
                await asyncio.to_thread(self.conversations.select, cid)
            self.target = self.snapshot = None
            await self.emit("snapshot.invalidated")
            await self.emit("session.started", target=None, provider=self.settings.values["provider"])
            await self._conversation_snapshot(changed=True)
            await self._history_snapshot()
        elif kind == "conversation.rename":
            await asyncio.to_thread(self.conversations.rename, cmd.get("title"), cmd.get('conversation_id'))
            await self._conversation_snapshot()
        else:
            return False
        return True

    async def _compact_history(self, reserve_chars, gen):
        count = self.prompt_history.compaction_count(reserve_chars)
        if not count:
            return
        await self.emit("context.state", state="compacting")
        turns = deepcopy(self.prompt_history.turns[:count])
        for turn in turns:
            turn["reply_reception"] = self.store.reception(turn["turn_id"], turn["keys"])
            for key, uid in turn["keys"].items():
                if record := self.utterances.get(uid):
                    turn["reply_reception"].append({"key": key, "status": record.get("status", "generated"),
                                                   "displayed": record.get("displayed", False)})
        if self.model_client is None:
            self.model_client = httpx.AsyncClient(timeout=httpx.Timeout(75, connect=12), trust_env=False)
        try:
            async with asyncio.timeout(48):
                summary = self.prompt_history.summary
                for batch in summary_batches(turns, self._summary_budget()):
                    summary = await summarize_history(self.settings, self.model_client, summary, batch,
                                                      request_observer=self._record_prompt)
                    if gen != self.generation:
                        raise asyncio.CancelledError
                await asyncio.to_thread(self.prompt_history.compact, count, summary)
            await self._conversation_snapshot()
        finally:
            await self.emit("context.state", state="ready")
