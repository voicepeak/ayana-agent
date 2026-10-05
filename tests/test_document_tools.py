from pathlib import Path
import zipfile
import pytest
from services.agent.tools.document_formats import W, S, P, A, R
from services.agent.tools.documents import DocumentReader
from services.agent.tools.policy import DirectoryPolicy
from services.agent.tools.registry import ToolError
from tests.test_full_access import runtime_for


def zipped(path, parts):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in parts.items():
            archive.writestr(name, text)


def word(path):
    zipped(path, {"word/document.xml": f'<w:document xmlns:w="{W[1:-1]}"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格值</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>最后一段</w:t></w:r></w:p></w:body></w:document>'})


def test_word_pages_include_paragraph_and_table_locations_and_stale_checks(tmp_path):
    path = tmp_path / "note.docx"
    word(path)
    reader = DocumentReader(DirectoryPolicy(tmp_path))
    first = reader.read("output", "note.docx", max_units=1)
    assert first["units"][0]["paragraph"] == 1 and first["content"] == "第一段"
    second = reader.read("output", "note.docx", max_units=1, cursor=first["next_cursor"])
    assert second["units"][0]["table"] == 1 and second["units"][0]["row"] == 1
    final = reader.read("output", "note.docx", cursor=second["next_cursor"])
    assert final["content"] == "最后一段" and not final["next_cursor"] and not final["complete"]
    word(path)
    with pytest.raises(ToolError, match="文档已改变"):
        reader.read("output", "note.docx", cursor=first["next_cursor"])
    assert not reader.workers


def test_excel_shared_inline_formula_and_sheet_locations(tmp_path):
    zipped(tmp_path / "table.xlsx", {
        "xl/workbook.xml": f'<workbook xmlns="{S[1:-1]}" xmlns:r="{R[1:-1]}"><sheets><sheet name="销售" r:id="sheet1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="sheet1" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/sharedStrings.xml": f'<sst xmlns="{S[1:-1]}"><si><t>名称</t></si></sst>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S[1:-1]}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>中文</t></is></c><c r="C1"><f>SUM(C2:C3)</f><v>42</v></c></row></sheetData></worksheet>'})
    value = DocumentReader(DirectoryPolicy(tmp_path)).read("output", "table.xlsx")
    assert [unit["content"] for unit in value["units"]] == ["名称", "中文", "42"]
    assert value["units"][2]["cell"] == "C1" and value["units"][2]["sheet"] == "销售"
    assert value["units"][2]["formula"] == "SUM(C2:C3)"
    assert value["units"][2]["calculation"] == "cached_not_recomputed"


def test_slides_use_presentation_order(tmp_path):
    zipped(tmp_path / "deck.pptx", {
        "ppt/presentation.xml": f'<p:presentation xmlns:p="{P[1:-1]}" xmlns:r="{R[1:-1]}"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>',
        "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
        "ppt/slides/slide1.xml": f'<root xmlns:a="{A[1:-1]}"><a:p><a:r><a:t>后展示</a:t></a:r></a:p></root>',
        "ppt/slides/slide2.xml": f'<root xmlns:a="{A[1:-1]}"><a:p><a:r><a:t>先展示</a:t></a:r></a:p></root>'})
    value = DocumentReader(DirectoryPolicy(tmp_path)).read("output", "deck.pptx")
    assert [(unit["slide"], unit["content"]) for unit in value["units"]] == [(1, "先展示"), (2, "后展示")]


def make_pdf(path, locked=False):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer = PdfWriter()
    for text in ("first page", "second page", ""):
        page = writer.add_blank_page(width=300, height=300)
        if text:
            font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
            page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
            stream = DecodedStreamObject()
            stream.set_data(f'BT /F1 12 Tf 20 200 Td ({text}) Tj ET'.encode())
            page[NameObject('/Contents')] = writer._add_object(stream)
    if locked:
        writer.encrypt('test-password')
    writer.write(path)


def test_pdf_page_selection_scan_signal_and_encryption(tmp_path):
    make_pdf(tmp_path / "pages.pdf")
    reader = DocumentReader(DirectoryPolicy(tmp_path))
    page = reader.read("output", "pages.pdf", start_unit=2, max_units=1)
    assert page["units"][0]["page"] == 2 and "second page" in page["content"]
    empty = reader.read("output", "pages.pdf", cursor=page["next_cursor"])
    assert empty["requires_ocr"] and empty["units"][0]["page"] == 3
    make_pdf(tmp_path / "locked.pdf", True)
    with pytest.raises(ToolError, match="密码保护"):
        reader.read("output", "locked.pdf")


@pytest.mark.asyncio
async def test_documents_use_existing_read_tool_and_grants_without_write_access(tmp_path):
    runtime = runtime_for(tmp_path / "data")
    word(tmp_path / "note.docx")
    runtime.policy.grant("docs", tmp_path, write=False)
    try:
        value = await runtime.registry.execute("files.read", {"root_id": "docs", "path": "note.docx", "max_units": 1})
        assert value["content"] == "第一段" and value["sha256"] is None
        with pytest.raises(ToolError):
            await runtime.registry.execute("files.propose_edit", {"root_id": "docs", "path": "note.docx", "base_sha256": "x" * 64, "content": "changed"})
        with pytest.raises(ToolError):
            await runtime.registry.execute("files.read", {"root_id": "docs", "path": "../note.docx"})
    finally:
        await runtime.close()


def test_document_parser_rejects_entities_and_bounded_zip_parts(tmp_path):
    zipped(tmp_path / "bad.docx", {"word/document.xml": '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///example">]><x/>'})
    reader = DocumentReader(DirectoryPolicy(tmp_path))
    with pytest.raises(ToolError, match="XML 定义"):
        reader.read("output", "bad.docx")
