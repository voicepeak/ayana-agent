from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import threading
import pytest
from services.agent.tools.browser import BrowserTools
from services.agent.tools.registry import ToolError

pytest.importorskip("playwright")
if os.name == "nt" and not Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe").is_file():
    pytest.skip("Browser integration requires installed Edge", allow_module_level=True)


@pytest.fixture
def website():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/frame":
                html = '<label>框架输入<input id="framed"></label>'
            elif self.path == "/many":
                html = '<p>' + '正文内容' * 10000 + '</p>' + ''.join(f'<button>按钮{i}</button>' for i in range(100))
            else:
                html = '''<!doctype html><html><title>Ayana form</title><body>
                <label>用户名<input id="name"></label><label>密码<input type="password" value="private-test-value"></label>
                <label>同意<input id="agree" type="checkbox"></label><select id="choice"><option value="one">一</option><option value="two">二</option></select>
                <button id="save" onclick="document.querySelector('#result').textContent='已保存：'+document.querySelector('#name').value">保存</button>
                <p id="result">尚未保存</p><iframe src="/frame"></iframe></body></html>'''
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(html.encode())
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_port}'
    server.shutdown()
    server.server_close()
    thread.join(3)


def managed(tmp_path):
    return BrowserTools(lambda: True, tmp_path / "profile", headless=True, channel="msedge" if os.name == "nt" else None)


@pytest.mark.asyncio
async def test_real_browser_observation_masks_password_and_reads_frame(tmp_path, website):
    browser = managed(tmp_path)
    try:
        observation = await browser.open(website)
        assert observation["title"] == "Ayana form" and observation["http_status"] == 200
        assert "尚未保存" in observation["text"]
        password = next(item for item in observation["elements"] if item["type"] == "password")
        assert password["redacted"] and password["value"] is None
        assert "private-test-value" not in str(observation)
        frame = next(item for item in observation["frames"] if item["url"].endswith('/frame'))
        framed = await browser.observe(observation["page_id"], frame["frame_id"])
        assert any(item["name"] == "框架输入" for item in framed["elements"])
        assert framed["snapshot_id"] != observation["snapshot_id"]
    finally:
        await browser.close()
    assert not browser.pages and not browser.driver and not browser.context


@pytest.mark.asyncio
async def test_text_and_element_pagination_reaches_late_page_content(tmp_path, website):
    browser = managed(tmp_path)
    try:
        page = await browser.open(website + '/many')
        assert page["next_text_offset"] and page["next_element_offset"] == 80
        later = await browser.observe(page["page_id"], text_offset=page["next_text_offset"], element_offset=80)
        assert any(item["name"] == "按钮99" for item in later["elements"])
        assert later["next_element_offset"] is None
    finally:
        await browser.close()


@pytest.mark.asyncio
async def test_browser_rejects_non_web_urls_and_revoked_access(tmp_path, website):
    access = [True]
    browser = BrowserTools(lambda: access[0], tmp_path / 'profile', headless=True, channel='msedge' if os.name == 'nt' else None)
    try:
        for url in ('javascript:alert(1)', 'file:///C:/test', 'https://user:password@example.com'):
            with pytest.raises(ToolError):
                await browser.open(url)
        page = await browser.open(website)
        access[0] = False
        with pytest.raises(ToolError, match='Full access'):
            await browser.observe(page["page_id"])
    finally:
        await browser.close()


def element(observation, name):
    return next(item['element_id'] for item in observation['elements'] if item['name'] == name)


@pytest.mark.asyncio
async def test_real_form_fill_check_select_and_submit_with_fresh_evidence(tmp_path, website):
    browser = managed(tmp_path)
    try:
        page = await browser.open(website)
        value = await browser.act(page['page_id'], page['snapshot_id'], 'fill', element(page, '用户名'), text='Ayana中文')
        current = value['observation']
        assert next(item for item in current['elements'] if item['name'] == '用户名')['value'] == 'Ayana中文'
        with pytest.raises(ToolError, match='快照已失效'):
            await browser.act(page['page_id'], page['snapshot_id'], 'click', element(page, '保存'))
        value = await browser.act(current['page_id'], current['snapshot_id'], 'check', element(current, '同意'), checked=True)
        current = value['observation']
        assert next(item for item in current['elements'] if item['name'] == '同意')['checked']
        select_id = next(item['element_id'] for item in current['elements'] if item['tag'] == 'select')
        value = await browser.act(current['page_id'], current['snapshot_id'], 'select', select_id, text='two')
        current = value['observation']
        assert next(item for item in current['elements'] if item['tag'] == 'select')['value'] == 'two'
        submitted = await browser.act(current['page_id'], current['snapshot_id'], 'click', element(current, '保存'))
        assert '已保存：Ayana中文' in submitted['observation']['text']
        assert submitted['verification'] == 'observation_only'
        current = submitted['observation']
        closed = await browser.act(current['page_id'], current['snapshot_id'], 'close')
        assert closed['expected_result_verified']
    finally:
        await browser.close()


@pytest.mark.asyncio
async def test_detached_identical_element_and_changed_dom_are_rejected(tmp_path, website):
    browser = managed(tmp_path)
    try:
        snapshot = await browser.open(website)
        _, page = browser._pick(snapshot['page_id'])
        await page.evaluate("document.querySelector('#save').replaceWith(document.querySelector('#save').cloneNode(true))")
        with pytest.raises(ToolError, match='已改变'):
            await browser.act(snapshot['page_id'], snapshot['snapshot_id'], 'click', element(snapshot, '保存'))
        snapshot = await browser.observe(snapshot['page_id'])
        await page.evaluate("document.querySelector('#result').textContent='页面改变'")
        with pytest.raises(ToolError, match='已改变'):
            await browser.act(snapshot['page_id'], snapshot['snapshot_id'], 'click', element(snapshot, '保存'))
        assert await page.locator('#result').inner_text() == '页面改变'
    finally:
        await browser.close()


@pytest.mark.asyncio
async def test_uncertain_action_consumes_snapshot_and_requires_observation(tmp_path, website, monkeypatch):
    browser = managed(tmp_path)
    try:
        page = await browser.open(website)
        original = browser._observe
        async def broken_observation(*args, **kwargs):
            raise RuntimeError('simulated observation failure after input')
        monkeypatch.setattr(browser, '_observe', broken_observation)
        with pytest.raises(ToolError) as error:
            await browser.act(page['page_id'], page['snapshot_id'], 'fill', element(page, '用户名'), text='already sent')
        assert error.value.code == 'browser_action_unconfirmed'
        with pytest.raises(ToolError, match='快照已失效'):
            await browser.act(page['page_id'], page['snapshot_id'], 'fill', element(page, '用户名'), text='duplicate')
        monkeypatch.setattr(browser, '_observe', original)
        observed = await browser.observe(page['page_id'])
        assert next(item for item in observed['elements'] if item['name'] == '用户名')['value'] == 'already sent'
    finally:
        await browser.close()
