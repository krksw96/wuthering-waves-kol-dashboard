#!/usr/bin/env python3
import json
import os
import posixpath
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


REQUIRED_HEADERS = [
    "방송 날짜",
    "순위",
    "이름",
    "유튜브",
    "유튜브 평균 조회수",
    "방송 시간",
    "최고 시청자",
    "평균 시청자",
    "뷰어십",
    "데이터 링크",
]
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"x": MAIN_NS, "r": OFFICE_REL_NS, "pr": PACKAGE_REL_NS}


def inspect_xlsx(xlsx_path):
    with zipfile.ZipFile(xlsx_path) as archive:
        shared_strings = _read_shared_strings(archive)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        workbook_relationships = _read_relationships(archive, "xl/_rels/workbook.xml.rels")

        for sheet in workbook.findall("x:sheets/x:sheet", NS):
            relationship_id = sheet.get(f"{{{OFFICE_REL_NS}}}id")
            target = workbook_relationships.get(relationship_id, "")
            if not target:
                continue
            sheet_path = _resolve_part("xl/workbook.xml", target)
            sheet_root = ET.fromstring(archive.read(sheet_path))
            rows = _read_rows(sheet_root, shared_strings)
            header_row = _find_header_row(rows)
            if header_row is None:
                continue
            return _build_diagnostics(archive, sheet.get("name", ""), sheet_path, sheet_root, rows, header_row)

    raise ValueError("No worksheet contains the required Feishu headers.")


def fetch_exported_xlsx(config, opener=urllib.request.urlopen, sleep=time.sleep):
    tenant_token = _authenticate(config, opener)
    headers = _api_headers(config, tenant_token)
    create_payload = _request_json(
        opener,
        f'{config["base_url"]}/open-apis/drive/v1/export_tasks',
        method="POST",
        headers=headers,
        payload={"file_extension": "xlsx", "token": config["spreadsheet_token"], "type": "sheet"},
    )
    ticket = _find_first(create_payload, "ticket")
    if not ticket:
        raise RuntimeError("Feishu export task response did not include a ticket.")

    file_token = ""
    for attempt in range(config["poll_retries"]):
        query = urllib.parse.urlencode({"token": config["spreadsheet_token"]})
        poll_payload = _request_json(
            opener,
            f'{config["base_url"]}/open-apis/drive/v1/export_tasks/{urllib.parse.quote(ticket)}?{query}',
            headers=headers,
        )
        file_token = _find_first(poll_payload, "file_token")
        if file_token:
            break
        if attempt + 1 < config["poll_retries"]:
            sleep(config["poll_interval_seconds"])
    if not file_token:
        raise TimeoutError(f'Feishu XLSX export did not finish after {config["poll_retries"]} polls.')

    download_url = (
        f'{config["base_url"]}/open-apis/drive/v1/export_tasks/file/'
        f'{urllib.parse.quote(file_token)}/download'
    )
    return _request_bytes(opener, download_url, headers=headers)


def _authenticate(config, opener):
    payload = _request_json(
        opener,
        f'{config["base_url"]}/open-apis/auth/v3/tenant_access_token/internal',
        method="POST",
        headers=_gateway_headers(config),
        payload={"app_id": config["app_id"], "app_secret": config["app_secret"]},
    )
    token = payload.get("tenant_access_token", "")
    if not token:
        raise RuntimeError("Feishu authentication response did not include a tenant access token.")
    return token


def _request_json(opener, url, method="GET", headers=None, payload=None):
    response_bytes = _request_bytes(opener, url, method=method, headers=headers, payload=payload)
    try:
        result = json.loads(response_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("Feishu API returned invalid JSON.") from error
    if isinstance(result, dict) and result.get("code", 0) != 0:
        raise RuntimeError(f'Feishu API request failed with code {result.get("code")}')
    return result


def _request_bytes(opener, url, method="GET", headers=None, payload=None):
    request_headers = dict(headers or {})
    data = None
    if payload is not None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json; charset=utf-8")
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with opener(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Feishu API HTTP error: {error.code}") from error
    except urllib.error.URLError as error:
        raise RuntimeError("Feishu API network request failed.") from error


def _gateway_headers(config):
    headers = {}
    if config["api_key"]:
        headers["Authorization"] = f'Bearer {config["api_key"]}'
        headers["X-API-Key"] = config["api_key"]
    return headers


def _api_headers(config, tenant_token):
    headers = _gateway_headers(config)
    headers["Authorization"] = f"Bearer {tenant_token}"
    return headers


def _find_first(value, key):
    if isinstance(value, dict):
        if value.get(key):
            return value[key]
        for child in value.values():
            found = _find_first(child, key)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_first(child, key)
            if found:
                return found
    return ""


def _read_shared_strings(archive):
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return ["".join(node.itertext()) for node in root.findall("x:si", NS)]


def _read_relationships(archive, relationships_path):
    try:
        root = ET.fromstring(archive.read(relationships_path))
    except KeyError:
        return {}
    return {relationship.get("Id", ""): relationship.get("Target", "") for relationship in root}


def _resolve_part(source_part, target):
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))


def _read_rows(sheet_root, shared_strings):
    rows = {}
    for row_node in sheet_root.findall("x:sheetData/x:row", NS):
        row_number = int(row_node.get("r", "0") or 0)
        cells = {}
        for cell_node in row_node.findall("x:c", NS):
            reference = cell_node.get("r", "")
            column_index = _column_index(reference)
            cells[column_index] = {
                "value": _cell_value(cell_node, shared_strings),
                "style": int(cell_node.get("s", "0") or 0),
            }
        rows[row_number] = {"node": row_node, "cells": cells}
    return rows


def _cell_value(cell_node, shared_strings):
    cell_type = cell_node.get("t", "")
    if cell_type == "inlineStr":
        inline = cell_node.find("x:is", NS)
        return "" if inline is None else "".join(inline.itertext())
    value_node = cell_node.find("x:v", NS)
    if value_node is None or value_node.text is None:
        return ""
    value = value_node.text
    if cell_type == "s":
        try:
            return shared_strings[int(value)]
        except (ValueError, IndexError):
            return ""
    return value


def _find_header_row(rows):
    required = set(REQUIRED_HEADERS)
    for row_number in sorted(rows):
        values = {cell["value"].strip() for cell in rows[row_number]["cells"].values() if cell["value"].strip()}
        if required.issubset(values):
            return row_number
    return None


def _build_diagnostics(archive, sheet_name, sheet_path, sheet_root, rows, header_row):
    header_cells = rows[header_row]["cells"]
    ordered_headers = [header_cells[index]["value"].strip() for index in sorted(header_cells)]
    header_columns = {cell["value"].strip(): index for index, cell in header_cells.items()}
    creator_column = header_columns["이름"]
    youtube_column = header_columns["유튜브"]
    max_column = max(header_columns.values())
    max_row = max(rows, default=0)
    hyperlinks = _read_hyperlinks(archive, sheet_path, sheet_root)

    creators = []
    creator_links = {}
    for row_number in sorted(rows):
        if row_number <= header_row:
            continue
        creator = rows[row_number]["cells"].get(creator_column, {}).get("value", "").strip()
        if not creator:
            continue
        if creator not in creators:
            creators.append(creator)
        hyperlink = hyperlinks.get(f"{_column_name(youtube_column)}{row_number}", "")
        if hyperlink and creator not in creator_links:
            creator_links[creator] = hyperlink

    missing_creators = [creator for creator in creators if creator not in creator_links]
    inspected_rows = []
    for row_number in range(2, 22):
        row = rows.get(row_number)
        height = row["node"].get("ht") if row is not None else None
        cells = row["cells"] if row is not None else {}
        inspected_rows.append({
            "row": row_number,
            "height": float(height) if height is not None else None,
            "style_indexes": [
                cells.get(column_index, {}).get("style", 0)
                for column_index in range(1, max_column + 1)
            ],
        })

    vectors = [row["style_indexes"] for row in inspected_rows]
    return {
        "selected_sheet": sheet_name,
        "headers": ordered_headers,
        "max_row": max_row,
        "column_widths": _column_widths(sheet_root),
        "rows_2_21": inspected_rows,
        "style_vectors_identical": len(vectors) <= 1 or all(vector == vectors[0] for vector in vectors[1:]),
        "unique_creator_count": len(creators),
        "creator_youtube_hyperlinks": creator_links,
        "creators_with_youtube_hyperlink_count": len(creator_links),
        "missing_youtube_hyperlink_creators": missing_creators,
        "missing_youtube_hyperlink_count": len(missing_creators),
    }

def _read_hyperlinks(archive, sheet_path, sheet_root):
    relationships_path = posixpath.join(
        posixpath.dirname(sheet_path),
        "_rels",
        posixpath.basename(sheet_path) + ".rels",
    )
    relationships = _read_relationships(archive, relationships_path)
    hyperlinks = {}
    for hyperlink in sheet_root.findall("x:hyperlinks/x:hyperlink", NS):
        reference = hyperlink.get("ref", "")
        relationship_id = hyperlink.get(f"{{{OFFICE_REL_NS}}}id")
        target = relationships.get(relationship_id, "")
        if target:
            hyperlinks[reference] = target
    return hyperlinks


def _column_widths(sheet_root):
    widths = {}
    for column in sheet_root.findall("x:cols/x:col", NS):
        minimum = int(column.get("min", "0") or 0)
        maximum = int(column.get("max", "0") or 0)
        if minimum <= 0 or maximum <= 0 or column.get("width") is None:
            continue
        label = _column_name(minimum)
        if maximum != minimum:
            label += f":{_column_name(maximum)}"
        widths[label] = float(column.get("width"))
    return widths


def _column_index(reference):
    letters = "".join(character for character in reference if character.isalpha())
    result = 0
    for character in letters.upper():
        result = result * 26 + ord(character) - ord("A") + 1
    return result


def _column_name(index):
    name = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(ord("A") + remainder) + name
    return name


def _config_from_env():
    api_key = os.environ.get("FEISHU_API_KEY") or os.environ.get("KURO_API_KEY") or os.environ.get("KOL_DATA_API_KEY") or ""
    config = {
        "app_id": os.environ.get("FEISHU_APP_ID", ""),
        "app_secret": os.environ.get("FEISHU_APP_SECRET", ""),
        "spreadsheet_token": os.environ.get("FEISHU_SPREADSHEET_TOKEN", ""),
        "sheet_id": os.environ.get("FEISHU_SHEET_ID", ""),
        "base_url": os.environ.get("FEISHU_API_BASE_URL", "https://ai-gateway.kurogames.com").rstrip("/"),
        "api_key": api_key,
        "poll_retries": int(os.environ.get("FEISHU_EXPORT_POLL_RETRIES", "20")),
        "poll_interval_seconds": float(os.environ.get("FEISHU_EXPORT_POLL_INTERVAL_SECONDS", "3")),
    }
    missing = [key for key in ("app_id", "app_secret", "spreadsheet_token", "sheet_id") if not config[key]]
    if missing:
        raise RuntimeError("Missing required Feishu environment variables: " + ", ".join(missing))
    if config["poll_retries"] < 1:
        raise RuntimeError("FEISHU_EXPORT_POLL_RETRIES must be at least 1.")
    return config


def main():
    config = _config_from_env()
    xlsx_bytes = fetch_exported_xlsx(config)
    with tempfile.TemporaryDirectory(prefix="feishu-xlsx-") as temp_dir:
        xlsx_path = Path(temp_dir) / "export.xlsx"
        xlsx_path.write_bytes(xlsx_bytes)
        diagnostics = inspect_xlsx(xlsx_path)
    print("FEISHU_XLSX_INSPECTION=" + json.dumps(diagnostics, ensure_ascii=False, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
