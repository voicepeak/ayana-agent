"""Read-only document units with stable locations; no macros or formula execution."""
import posixpath
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile
from .registry import ToolError

DOCUMENT_FORMATS = {".pdf", ".docx", ".xlsx", ".pptx"}
MAX_PART = 8 * 1024 * 1024
MAX_ARCHIVE = 32 * 1024 * 1024
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def xml(archive, name):
    info = archive.getinfo(name)
    if info.file_size > MAX_PART:
        raise ToolError("document_size", "文档内部数据超过解析上限，请缩小读取范围或拆分文档")
    raw = archive.read(name)
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ToolError("unsupported_document", "文档包含不支持的 XML 定义")
    return ET.fromstring(raw)


def relationships(archive, folder, name):
    result = {}
    for item in xml(archive, f"{folder}/_rels/{name}.rels"):
        if item.get("TargetMode") == "External":
            continue
        target = item.get("Target", "")
        part = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(folder, target))
        if not part.startswith(folder + "/"):
            continue
        result[item.get("Id")] = part
    return result


def word_text(node):
    return "".join(item.text or "" if item.tag == W + "t" else "\t" if item.tag == W + "tab" else "\n"
                   for item in node.iter() if item.tag in {W + "t", W + "tab", W + "br"})


def ooxml_units(target, format):
    with zipfile.ZipFile(target) as archive:
        if sum(info.file_size for info in archive.infolist()) > MAX_ARCHIVE or len(archive.infolist()) > 10000:
            raise ToolError("document_size", "文档展开后超过读取上限，请拆分文档")
        if format == "docx":
            paragraph, table = 0, 0
            body = xml(archive, "word/document.xml").find(W + "body")
            if body is None:
                raise ToolError("invalid_document", "Word 文档缺少正文")
            for node in body:
                if node.tag == W + "p":
                    paragraph += 1
                    yield {"kind": "paragraph", "paragraph": paragraph, "text": word_text(node)}
                elif node.tag == W + "tbl":
                    table += 1
                    for row, item in enumerate(node.findall(W + "tr"), 1):
                        cells = ["\n".join(word_text(p) for p in cell.findall(W + "p")) for cell in item.findall(W + "tc")]
                        yield {"kind": "table_row", "table": table, "row": row, "text": "\t".join(cells)}
        elif format == "xlsx":
            shared = []
            if "xl/sharedStrings.xml" in archive.namelist():
                shared = ["".join(node.text or "" for node in item.iter(S + "t")) for item in xml(archive, "xl/sharedStrings.xml")]
            mapping = relationships(archive, "xl", "workbook.xml")
            workbook = xml(archive, "xl/workbook.xml")
            for sheet in workbook.iter(S + "sheet"):
                part = mapping.get(sheet.get(R + "id"))
                if not part or not part.startswith("xl/worksheets/"):
                    continue
                for cell in xml(archive, part).iter(S + "c"):
                    value = cell.findtext(S + "v", "")
                    cell_type = cell.get("t", "n")
                    if cell_type == "s":
                        value = shared[int(value)]
                    elif cell_type == "inlineStr":
                        value = "".join(node.text or "" for node in cell.iter(S + "t"))
                    formula = cell.findtext(S + "f")
                    unit = {"kind": "cell", "sheet": sheet.get("name"), "cell": cell.get("r"), "cell_type": cell_type,
                            "text": value}
                    if formula is not None:
                        unit.update(formula=formula[:1000], calculation="cached_not_recomputed")
                    yield unit
        else:
            mapping = relationships(archive, "ppt", "presentation.xml")
            presentation = xml(archive, "ppt/presentation.xml")
            for number, item in enumerate(presentation.iter(P + "sldId"), 1):
                part = mapping.get(item.get(R + "id"))
                if not part or not part.startswith("ppt/slides/"):
                    continue
                slide = xml(archive, part)
                text = "\n".join("".join(node.text or "" for node in paragraph.iter(A + "t")) for paragraph in slide.iter(A + "p"))
                yield {"kind": "slide", "slide": number, "text": text}


def pdf_units(target, start_unit=1):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise ToolError("document_dependency", "当前环境缺少 PDF 读取组件") from None
    import logging
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    with target.open("rb") as source:
        reader = PdfReader(source, strict=False)
        if reader.is_encrypted and not reader.decrypt(""):
            raise ToolError("document_locked", "PDF 有密码保护，需要先解锁文档")
        for number in range(start_unit, len(reader.pages) + 1):
            page = reader.pages[number - 1]
            text = page.extract_text() or ""
            yield {"kind": "page", "page": number, "text": text, "requires_ocr": not bool(text.strip())}


def extract_page(path, start_unit=1, max_units=20, offset=0):
    target = Path(path)
    format = target.suffix.lower().lstrip(".")
    iterator = pdf_units(target, start_unit) if format == "pdf" else ooxml_units(target, format)
    units, used, position, next_position = [], 0, 0, None
    try:
        for position, unit in enumerate(iterator, start_unit if format == "pdf" else 1):
            if position < start_unit:
                continue
            if len(units) >= max_units or used >= 48000:
                next_position = {"start_unit": position, "offset": 0}
                break
            remaining = (48000 - used) // 4
            text = unit.pop("text")
            content = text[offset:offset + remaining]
            fragment = offset + len(content) < len(text)
            units.append({**unit, "unit": position, "content": content, "start_character": offset, "truncated": fragment})
            used += len(content.encode("utf-8"))
            if fragment:
                next_position = {"start_unit": position, "offset": offset + len(content)}
                break
            offset = 0
    finally:
        iterator.close()
    return {"format": format, "units": units, "content": "\n".join(item["content"] for item in units),
            "next_position": next_position, "complete": next_position is None and start_unit == 1,
            "requires_ocr": any(item.get("requires_ocr") for item in units),
            "extraction": "cached_values_and_formulas" if format == "xlsx" else "text_and_locations"}
