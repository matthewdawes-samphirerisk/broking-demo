"""
Read the broking spreadsheet and write it out for the dashboard.
Run:  python tools/build-data.py
"""
import openpyxl, json, datetime, os

SRC = os.path.join("data", "Demo Broking Data (RAW).xlsx")
OUT = os.path.join("public", "data.js")

wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
ws = wb["Policies"]

rows = list(ws.iter_rows(values_only=True))
headers = [str(h).strip() for h in rows[0]]

records = []
for r in rows[1:]:
    if r[0] is None:
        continue
    rec = {}
    for h, v in zip(headers, r):
        if isinstance(v, (datetime.datetime, datetime.date)):
            v = v.strftime("%Y-%m-%d")
        rec[h] = v
    records.append(rec)

wb.close()

os.makedirs("public", exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write("const POLICIES = ")
    json.dump(records, f, ensure_ascii=False)
    f.write(";\n")

print(f"wrote {OUT}: {len(records)} records, {len(headers)} fields")
