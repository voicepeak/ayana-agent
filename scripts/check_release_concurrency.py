"""Isolated release probes: real loopback HTTP/WebSocket plus deterministic races.

Uses fixture model/TTS for load; never reads personal conversations or contacts APIs.
Run with .venv/Scripts/python.exe scripts/check_release_concurrency.py.
"""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
import socket
import struct
import sys
import time
import traceback

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ROOT = (Path(sys.argv[sys.argv.index('--backend-root') + 1]).resolve()
        if '--backend-root' in sys.argv else PROJECT_ROOT)
sys.path.insert(0, str(ROOT))

import httpx
import uvicorn
import websockets
from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.server import create_app

OUTPUT = PROJECT_ROOT / '.runtime/benchmarks' / ('release-concurrency-' + str(time.time_ns()))
OUTPUT.mkdir(parents=True)
TOKEN = 'release-qa-fixture-token-' + 'x' * 32


class Desktop:
    status = {'available': False}
    def close(self): pass
    def cancel(self): pass


class Tts:
    status = {'state': 'ready', 'engine': 'qa-fixture'}
    async def start(self): pass
    async def close(self): pass
    async def cancel(self, generation): await asyncio.sleep(0)
    async def synthesize(self, text, generation_id):
        await asyncio.sleep(.003)
        return {'sample_rate': 16000, 'channels': 1, 'duration_ms': 100,
                'pcm_base64': base64.b64encode(struct.pack('<1600f', *([.1] * 1600))).decode(),
                'engine': 'qa-fixture'}


class Client:
    def __init__(self): self.events = []
    async def send_json(self, event): self.events.append(event)


def runtime(name, tts=None):
    directory = OUTPUT / name
    (directory / 'config').mkdir(parents=True)
    (directory / 'config/local.json').write_text(json.dumps({
        'provider': 'local', 'voice': {'voice_mode': 'silent'},
        'stt': {'provider': 'disabled'}, 'send_screenshot': False,
        'ambient_attention': False, 'remember_user': False, 'save_history': True,
    }), encoding='utf-8')
    cfg = Settings(ROOT, directory)
    cfg.key = lambda: None
    cfg.search_key = lambda: ''
    return AgentRuntime(cfg, desktop=Desktop(), tts=tts or Tts())


async def settle(rt):
    await asyncio.sleep(.02)
    await asyncio.gather(*(q.join() for q in tuple(rt.client_queues.values())))


async def turn_burst():
    rt = runtime('turn-burst')
    client = Client(); rt.clients.add(client)
    await rt.start()
    try:
        await asyncio.gather(*(rt.handle({'type': 'turn.start', 'text': f'burst {i}'}) for i in range(100)))
        await rt.task
        await settle(rt)
        rows = rt.store.history(10000)
        stale = [r for r in rows if r['generation_id'] != rt.generation and r['status'] != 'cancelled']
        assert not stale, f'Stale active utterances: {stale}'
        assert len([e for e in client.events if e['type'] == 'user.message']) == 100
        assert not [e for e in client.events if e['type'] == 'error']
        return {'concurrent_turn_commands': 100, 'final_generation': rt.generation,
                'utterances': len(rows), 'stale_active_utterances': len(stale)}
    finally: await rt.close()


async def settings_burst():
    rt = runtime('settings-burst'); client = Client(); rt.clients.add(client)
    try:
        await asyncio.gather(*(rt.handle({'type': 'settings.update', 'request_id': f'save-{i}',
            'settings': {'volume': (i % 21) / 20, 'companion_ui': {'font_size': 16 + i % 20}}}) for i in range(200)))
        await settle(rt)
        acks = [e for e in client.events if e['type'] == 'settings.ready']
        assert len(acks) == len({e['request_id'] for e in acks}) == 200
        assert [e['seq'] for e in client.events] == sorted(e['seq'] for e in client.events)
        disk = json.loads(rt.settings.path.read_text(encoding='utf-8'))
        assert disk == rt.settings.values
        assert disk['companion_ui']['font_size'] == 35
        assert 'frame_width' in disk['companion_ui']
        return {'concurrent_saves': 200, 'correlated_receipts': len(acks), 'disk_matches_memory': True}
    finally: await rt.close()


async def conversation_burst():
    rt = runtime('conversation-burst'); rt.clients.add(Client())
    try:
        await asyncio.gather(*(rt.handle({'type': 'conversation.create'}) for _ in range(30)))
        ids = list(rt.conversations.records)
        deleted = [cid for cid in ids if cid != rt.conversations.current_id][:20]
        commands = [{'type': 'conversation.delete', 'conversation_id': cid} for cid in deleted]
        commands += [{'type': 'turn.start', 'text': f'conversation burst {i}'} for i in range(20)]
        await asyncio.gather(*(rt.handle(cmd) for cmd in commands))
        await rt.task
        assert not set(deleted).intersection(rt.conversations.records)
        assert rt.store.db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        return {'created': 30, 'deleted': 20, 'mixed_turns': 20, 'database_integrity': 'ok'}
    finally: await rt.close()


async def slow_consumer():
    class Slow(Client):
        async def send_json(self, event): await asyncio.Future()
        async def close(self, **kwargs): self.closed = True
    rt = runtime('slow-consumer'); slow = Slow(); fast = Client()
    rt.clients.update((slow, fast))
    try:
        for i in range(500): await rt.emit('qa.probe', index=i)
        await settle(rt)
        assert slow not in rt.clients
        assert slow not in rt.client_senders and slow not in rt.client_queues
        assert len(fast.events) == 500
        return {'broadcasts': 500, 'slow_client_evicted': True, 'healthy_client_events': len(fast.events)}
    finally: await rt.close()


async def close_during_command():
    class DelayedCancel(Tts):
        def __init__(self): self.entered = asyncio.Event(); self.release = asyncio.Event(); self.calls = 0
        async def cancel(self, generation):
            self.calls += 1
            if self.calls == 1:
                self.entered.set()
                await self.release.wait()
    tts = DelayedCancel(); rt = runtime('shutdown-race', tts)
    command = asyncio.create_task(rt.handle({'type': 'turn.start', 'text': 'turn during shutdown'}))
    await tts.entered.wait()
    closing = asyncio.create_task(rt.close())
    try:
        await asyncio.sleep(.01)
        assert not closing.done(), 'Shutdown must wait for the active command'
        tts.release.set()
        result = (await asyncio.gather(command, return_exceptions=True))[0]
        await closing
        assert not isinstance(result, BaseException), f'In-flight command after close: {type(result).__name__}: {result}'
        assert rt.task is None or rt.task.done(), 'Shutdown left a new untracked turn running'
        return {'closed': rt.closed, 'in_flight_command_completed': True}
    finally:
        tts.release.set()
        await asyncio.gather(command, return_exceptions=True)
        await asyncio.gather(closing, return_exceptions=True)
        if rt.task and not rt.task.done():
            rt.task.cancel(); await asyncio.gather(rt.task, return_exceptions=True)
        await rt.close()


async def duplicate_playback_receipts():
    rt = runtime('receipt-order'); rt.clients.add(Client())
    try:
        await rt.handle({'type': 'turn.start', 'text': 'receipt test'})
        await rt.task
        uid, item = next(iter(rt.utterances.items()))
        total = item['total_samples']
        base = {'utterance_id': uid, 'generation_id': rt.generation}
        await rt.handle({**base, 'type': 'playback.ended', 'played_samples': total})
        await rt.handle({**base, 'type': 'playback.progress', 'played_samples': total // 2})
        assert rt.utterances[uid]['status'] == 'played', 'Late progress reverted a finished utterance to playing'
        assert rt.utterances[uid]['played_samples'] == total, 'Playback samples moved backwards'
        return {'terminal_status_preserved': True}
    finally: await rt.close()


async def disconnected_client_cleanup():
    rt = runtime('disconnect-cleanup'); client = Client()
    try:
        await rt.connected(client); await settle(rt)
        await rt.disconnected(client)
        assert client not in rt.client_senders, 'Disconnected client retains an idle sender task'
        assert client not in rt.client_queues, 'Disconnected client retains its event queue'
        return {'sender_and_queue_released': True}
    finally: await rt.close()


async def network_load():
    rt = runtime('network'); app = create_app(TOKEN, rt.settings, rt)
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); sock.listen(128)
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='critical', access_log=False))
    server_task = asyncio.create_task(server.serve(sockets=[sock]))
    clients, readers, events, times, latencies = [], [], {}, {}, []
    try:
        while not server.started:
            if server_task.done(): await server_task
            await asyncio.sleep(.01)
        url = f'http://127.0.0.1:{port}'
        headers = {'Authorization': 'Bearer ' + TOKEN}
        async with httpx.AsyncClient(base_url=url, trust_env=False) as http:
            assert (await http.get('/health')).status_code == 401
            assert (await http.post('/shutdown')).status_code == 401
            assert (await http.get('/debug/prompts/export')).status_code == 401
            assert (await http.get('/health', headers=headers)).status_code == 200
            for origin in (None, 'https://evil.example'):
                try:
                    async with websockets.connect(f'ws://127.0.0.1:{port}/ws',
                            additional_headers={} if origin is None else headers, origin=origin):
                        raise AssertionError('Untrusted WebSocket accepted')
                except websockets.exceptions.InvalidStatus: pass

            async def consume(ws, index):
                async for raw in ws:
                    event = json.loads(raw); events[index].append(event)
                    req = event.get('request_id')
                    if index == 0 and req in times and event['type'] == 'settings.ready':
                        latencies.append((time.perf_counter() - times.pop(req)) * 1000)
            for i in range(16):
                ws = await websockets.connect(f'ws://127.0.0.1:{port}/ws', additional_headers=headers)
                clients.append(ws); events[i] = []; readers.append(asyncio.create_task(consume(ws, i)))
            await asyncio.sleep(.15)
            async def send_batch(index, ws):
                for n in range(20):
                    req = f'network-{index}-{n}'; times[req] = time.perf_counter()
                    await ws.send(json.dumps({'type': 'settings.update', 'request_id': req,
                                              'settings': {'volume': (n % 11) / 10}}))
            started = time.perf_counter()
            await asyncio.gather(*(send_batch(i, ws) for i, ws in enumerate(clients)))
            deadline = time.monotonic() + 15
            while times and time.monotonic() < deadline: await asyncio.sleep(.02)
            assert not times, f'Missing {len(times)} settings persistence receipts'
            elapsed = time.perf_counter() - started
            for malformed in ('{', 'null', '[]', '{}', '{"type":"turn.start","text":""}'):
                await clients[0].send(malformed)
            await clients[0].send(json.dumps({'type': 'settings.get'}))
            await asyncio.sleep(.2)
            assert len([e for e in events[0] if e['type'] == 'error']) >= 5
            assert (await http.get('/health', headers=headers)).status_code == 200
            # Large Unicode input tests the transport's byte limit, not Python character count.
            large = await websockets.connect(f'ws://127.0.0.1:{port}/ws', additional_headers=headers)
            try:
                await large.send('x' * (2 * 1024 * 1024 + 1))
                while True: await asyncio.wait_for(large.recv(), 5)
            except websockets.exceptions.ConnectionClosed as error:
                assert error.rcvd and error.rcvd.code == 1009, f'Oversize close: {error}'
            finally: await large.close()
            assert rt.store.db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            ordered = sorted(latencies)
            for stream in events.values():
                seqs = [e['seq'] for e in stream]
                assert seqs == sorted(seqs), 'WebSocket event order inverted'
            await asyncio.gather(*(ws.close() for ws in clients))
            await asyncio.gather(*readers)
            await asyncio.sleep(.05)
            assert not rt.client_senders and not rt.client_queues, 'Disconnected network clients leaked senders/queues'
            return {'websocket_clients': 16, 'concurrent_persistence_commands': 320,
                    'receipts': len(latencies), 'seconds': round(elapsed, 3),
                    'commands_per_second': round(320 / elapsed, 1),
                    'receipt_p50_ms': round(ordered[len(ordered)//2], 1),
                    'receipt_p95_ms': round(ordered[int(len(ordered)*.95)], 1),
                    'auth_origin_validation': True, 'malformed_commands_recovered': True,
                    'oversize_close_code': 1009, 'database_integrity': 'ok',
                    'sender_tasks_after_disconnect': len(rt.client_senders),
                    'client_queues_after_disconnect': len(rt.client_queues)}
    finally:
        await asyncio.gather(*(ws.close() for ws in clients), return_exceptions=True)
        await asyncio.gather(*readers, return_exceptions=True)
        server.should_exit = True
        await asyncio.wait_for(server_task, 8)
        sock.close()


async def main():
    report = {'scope': 'Fixture model/TTS, real SQLite, authenticated loopback HTTP/WebSocket; isolated profiles',
              'backend_root': str(ROOT), 'python': sys.executable, 'checks': []}
    for probe in (turn_burst, settings_burst, conversation_burst, slow_consumer, close_during_command,
                  duplicate_playback_receipts, disconnected_client_cleanup, network_load):
        started = time.perf_counter()
        try:
            result = await asyncio.wait_for(probe(), 40)
            check = {'name': probe.__name__, 'passed': True, 'details': result}
        except Exception as error:
            check = {'name': probe.__name__, 'passed': False, 'error': f'{type(error).__name__}: {error}',
                     'traceback': traceback.format_exc()}
        check['elapsed_ms'] = round((time.perf_counter() - started) * 1000)
        report['checks'].append(check)
        print(json.dumps({k: v for k, v in check.items() if k != 'traceback'}, ensure_ascii=True), flush=True)
    report['passed'] = all(c['passed'] for c in report['checks'])
    destination = OUTPUT / 'report.json'
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'report': str(destination)}))
    return 0 if report['passed'] else 1


if __name__ == '__main__': sys.exit(asyncio.run(main()))
