import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "inspect-feishu-export.py"
HEADERS = [
    "\ubc29\uc1a1 \ub0a0\uc9dc", "\uc21c\uc704", "\uc774\ub984", "\uc720\ud29c\ube0c",
    "\uc720\ud29c\ube0c \ud3c9\uade0 \uc870\ud68c\uc218", "\ubc29\uc1a1 \uc2dc\uac04",
    "\ucd5c\uace0 \uc2dc\uccad\uc790", "\ud3c9\uade0 \uc2dc\uccad\uc790", "\ubdf0\uc5b4\uc2ed",
    "\ub370\uc774\ud130 \ub9c1\ud06c",
]


def load_inspector_module():
    spec = importlib.util.spec_from_file_location("inspect_feishu_export", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InspectFeishuExportTests(unittest.TestCase):
    def test_inspects_target_sheet_and_only_exposes_creator_youtube_links(self):
        inspector = load_inspector_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            xlsx_path = Path(temp_dir) / "fixture.xlsx"
            self._write_fixture(xlsx_path)
            inspection = inspector.inspect_xlsx(xlsx_path)
        self.assertEqual(inspection["selected_sheet"], "KOL Data")
        self.assertEqual(inspection["headers"], HEADERS)
        self.assertEqual(inspection["max_row"], 3)
        self.assertEqual(inspection["column_widths"], {"A": 12.5, "D": 24.0})
        self.assertEqual(len(inspection["rows_2_21"]), 20)
        self.assertEqual(
            inspection["rows_2_21"][:2],
            [
                {"row": 2, "height": 22.0, "style_indexes": [1, 1, 2, 3, 1, 1, 1, 1, 1, 4]},
                {"row": 3, "height": None, "style_indexes": [1, 1, 5, 3, 1, 1, 1, 1, 1, 4]},
            ],
        )
        self.assertEqual(
            inspection["rows_2_21"][-1],
            {"row": 21, "height": None, "style_indexes": [0] * 10},
        )
        self.assertEqual(inspection["style_vectors_identical"], False)
        self.assertEqual(inspection["unique_creator_count"], 2)
        self.assertEqual(inspection["creator_youtube_hyperlinks"], {"Alpha": "https://youtube.com/@alpha"})
        self.assertEqual(inspection["creators_with_youtube_hyperlink_count"], 1)
        self.assertEqual(inspection["missing_youtube_hyperlink_creators"], ["Beta"])
        self.assertEqual(inspection["missing_youtube_hyperlink_count"], 1)
        self.assertNotIn("https://example.com/private", json.dumps(inspection, ensure_ascii=False))

    @staticmethod
    def _write_fixture(path):
        strings = HEADERS + ["Alpha", "Beta", "Alpha channel", "Hidden data"]
        shared_xml = "".join(f"<si><t>{value}</t></si>" for value in strings)
        headers = "".join(f'<c r="{chr(65 + i)}1" t="s"><v>{i}</v></c>' for i in range(len(HEADERS)))
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("xl/workbook.xml", WORKBOOK_XML)
            archive.writestr("xl/_rels/workbook.xml.rels", WORKBOOK_RELS_XML)
            archive.writestr("xl/sharedStrings.xml", f'<sst xmlns="{MAIN_NS}">{shared_xml}</sst>')
            archive.writestr("xl/worksheets/sheet1.xml", worksheet_xml(headers))
            archive.writestr("xl/worksheets/_rels/sheet1.xml.rels", SHEET_RELS_XML)


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
WORKBOOK_XML = f'<workbook xmlns="{MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="KOL Data" sheetId="1" r:id="rId1"/></sheets></workbook>'
WORKBOOK_RELS_XML = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
SHEET_RELS_XML = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdYoutube" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://youtube.com/@alpha" TargetMode="External"/><Relationship Id="rIdPrivate" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/private" TargetMode="External"/></Relationships>'


def worksheet_xml(headers):
    return f'''<worksheet xmlns="{MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cols><col min="1" max="1" width="12.5"/><col min="4" max="4" width="24"/></cols><sheetData><row r="1">{headers}</row><row r="2" ht="22"><c r="A2" s="1"><v>45500</v></c><c r="B2" s="1"><v>1</v></c><c r="C2" s="2" t="s"><v>10</v></c><c r="D2" s="3" t="s"><v>12</v></c><c r="E2" s="1"><v>1000</v></c><c r="F2" s="1"><v>2</v></c><c r="G2" s="1"><v>500</v></c><c r="H2" s="1"><v>300</v></c><c r="I2" s="1"><v>600</v></c><c r="J2" s="4" t="s"><v>13</v></c></row><row r="3"><c r="A3" s="1"><v>45501</v></c><c r="B3" s="1"><v>2</v></c><c r="C3" s="5" t="inlineStr"><is><t>Beta</t></is></c><c r="D3" s="3"><v></v></c><c r="E3" s="1"><v>900</v></c><c r="F3" s="1"><v>3</v></c><c r="G3" s="1"><v>400</v></c><c r="H3" s="1"><v>250</v></c><c r="I3" s="1"><v>750</v></c><c r="J3" s="4"><v>99</v></c></row></sheetData><hyperlinks><hyperlink ref="D2" r:id="rIdYoutube"/><hyperlink ref="J2" r:id="rIdPrivate"/></hyperlinks></worksheet>'''


if __name__ == "__main__":
    unittest.main()
