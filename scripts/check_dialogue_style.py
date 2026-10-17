"""Probe synthetic chats for repeated phrasing; never use personal chat history or audio.

Examples:
  python scripts/check_dialogue_style.py --dry-run
  python scripts/check_dialogue_style.py --scenario daily --scenario continuity
  python scripts/check_dialogue_style.py --against-system baseline.system.md

Live mode uses the configured model API. Counts flag patterns for human review;
they are not pass/fail thresholds or a naturalness score.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import httpx

from services.agent.avatars import AvatarCatalog
from services.agent.config import Settings
from services.agent.prompts import PromptAssembler, tool_prompt
from services.agent.providers.model import OpenAIProvider
from services.agent.tools.registry import ToolRegistry

SCENARIOS = {
    'daily': ['下午好呀。', '今天挺凉快的。', '刚买了杯奶茶，居然没踩雷。',
              '还不错。', '你今天怎么这么正经，装高手是吧。', '嗯。'],
    'continuity': ['我不喜欢别人叫我天才，也不喜欢聊天时老被叫名字。',
                   '我今天又在改那个桌面小项目。', '折腾半天，终于能用了。',
                   '我只是随口分享，不用给我安排计划。', '你自己想当一个天才吗？',
                   '那你还记得我刚才说过不喜欢什么吗？'],
    'short': ['早。'],
    'rest': ['今天什么也没干，就躺着刷了会儿手机。'],
    'literature': ['文学作品里的不可靠叙述者，为什么会让故事更有意思？'],
    'disagree': ['我觉得故事都应该把每个人的动机解释得一清二楚，你同意吗？'],
}


def metrics(records):
    good = [record for record in records if 'error' not in record]
    replies = [''.join(record['ja']) for record in good]
    sentences = [text for record in good for text in record['ja']]
    openings = Counter(re.sub(r'^[\s…、。]+', '', text)[:5] for text in replies)
    spans = Counter()
    for text in replies:
        spans.update({text[i:i + 9] for i in range(max(0, len(text) - 8))
                      if not re.search(r'[。！？!?]', text[i:i + 9])})
    return {
        'successful_replies': len(good), 'failed_replies': len(records) - len(good),
        'sentences': len(sentences), 'sentence_counts': [len(record['ja']) for record in good],
        'question_endings': sum(bool(re.search(r'[？?][」』]*$', text)) for text in replies),
        'replies_with_ellipsis': sum('…' in text for text in replies),
        'replies_with_name': sum(bool(re.search('[紀纪]', text)) for text in replies),
        'repeated_openings': [(text, count) for text, count in openings.most_common() if count >= 2],
        'repeated_9_character_spans': [(text, count) for text, count in spans.most_common(20) if count >= 3],
    }


async def run(settings, prompts, scenarios):
    semaphore = asyncio.Semaphore(4)
    async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(75, connect=12)) as client:
        async def sequence(version, name, questions):
            history, avatar, records = [], [], []
            for turn, question in enumerate(questions, 1):
                context = {
                    'question': question, 'avatar_context': avatar[-3:],
                    'emotion': {'mood': '平静', 'intensity': 0.2, 'energy': 65, 'patience': 70, 'warmth': 55},
                    'observation': {'available': False}, 'speech_budget': {'used': 0, 'remaining': 8},
                }
                user = {'role': 'user', 'content': [{'type': 'text', 'text': json.dumps(context, ensure_ascii=False)}]}
                provider = OpenAIProvider(settings, client, thinking=True)
                phases, events = [], []
                provider.request_observer = lambda body, **meta: phases.append(meta.get('phase', 'main'))
                record = {'version': version, 'scenario': name, 'turn': turn, 'question': question}
                try:
                    async with semaphore:
                        async for event in provider.stream_reply([
                            {'role': 'system', 'content': prompts[version]}, *history, user,
                        ]):
                            events.append(event)
                    speeches = [event for event in events if event.get('type') == 'speech']
                    translations = {event['key']: event['display_zh'] for event in events if event.get('type') == 'translation'}
                    if not speeches or any(event['key'] not in translations for event in speeches):
                        raise ValueError('Reply did not contain complete speech/translation pairs')
                    record.update(ja=[event['speech_ja'] for event in speeches],
                                  zh=[translations[event['key']] for event in speeches],
                                  expressions=[event.get('expression') for event in speeches])
                    history.extend([user, provider.assistant_message()])
                    avatar.extend({'expression': event.get('expression'), 'pose': event.get('pose')} for event in speeches)
                except Exception as error:
                    # Only synthetic text is saved; never serialize credentials or HTTP requests.
                    record.update(error=type(error).__name__, raw_response=provider.response_text)
                record.update(usage=provider.usage, repairs=[phase for phase in phases if phase != 'main'])
                records.append(record)
                print(json.dumps({key: record.get(key) for key in ('version', 'scenario', 'turn', 'zh', 'error')}, ensure_ascii=False), flush=True)
                if 'error' in record:
                    # Continuing would compare conversations with different missing histories.
                    break
            return records

        groups = await asyncio.gather(*(sequence(version, name, questions)
                                        for version in prompts for name, questions in scenarios.items()))
    return [record for group in groups for record in group]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--scenario', action='append', choices=SCENARIOS, help='Repeat to select scenarios; default: all')
    parser.add_argument('--against-system', type=Path, help='Optional baseline system prompt snapshot')
    parser.add_argument('--data-dir', type=Path, help='Use model settings from this data directory')
    parser.add_argument('--output', type=Path, help='New JSON report; existing files are never overwritten')
    parser.add_argument('--dry-run', action='store_true', help='Inspect prompt metadata and cases without calling the API')
    args = parser.parse_args()
    settings = Settings(ROOT, data_root=args.data_dir)
    catalog = AvatarCatalog(ROOT, character=settings.values.get('character'))
    bundle = PromptAssembler(ROOT, catalog).build(costume=settings.values.get('avatar_costume', '校服'),
                                                 tools=tool_prompt(ToolRegistry(), native_tools=True))
    prompts = {'current': bundle.system}
    if args.against_system:
        prompts['baseline'] = args.against_system.read_text(encoding='utf-8')
    scenarios = {name: SCENARIOS[name] for name in dict.fromkeys(args.scenario or SCENARIOS)}
    report = {
        'format': 'ayana.dialogue-style.v1', 'created_at': datetime.now(timezone.utc).isoformat(),
        'model': settings.values.get('model'), 'temperature': settings.values.get('temperature'),
        'planned_replies_per_version': sum(map(len, scenarios.values())), 'scenarios': list(scenarios),
        'system_sha256': {name: hashlib.sha256(prompt.encode()).hexdigest() for name, prompt in prompts.items()},
        'system_chars': {name: len(prompt) for name, prompt in prompts.items()},
        'scope': 'Synthetic text only; excludes personal history, screenshots, memory writes, tool execution and audio.',
        'limitations': 'Small stochastic sample; counts are review flags, not a naturalness score. Runtime mood and real tools are not simulated.',
    }
    if args.dry_run:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    if settings.values.get('provider') != 'openai' or not settings.key():
        parser.error('Live mode requires an online model with configured credentials')
    target = args.output or ROOT / '.runtime/benchmarks' / ('dialogue-style-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f') + '.json')
    if target.exists():
        parser.error('Output already exists; choose a new path')
    records = asyncio.run(run(settings, prompts, scenarios))
    report.update(samples=records, metrics={name: metrics([record for record in records if record['version'] == name]) for name in prompts})
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('x', encoding='utf-8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
    print(json.dumps({'report': str(target.resolve()), 'metrics': report['metrics']}, ensure_ascii=False, indent=2))
    if any('error' in record for record in records):
        raise SystemExit(1)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
