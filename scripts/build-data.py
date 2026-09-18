"""Generate public/data.json from the cleaned workbook.

Run after the source spreadsheet changes:
    python scripts/build-data.py
"""
import json, os, openpyxl

SRC = os.path.join(os.path.dirname(__file__), "..", "data", "Demo Broking Data (CLEANED).xlsx")
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data.json")

ws = openpyxl.load_workbook(SRC, data_only=True)["Policies"]
hdr = [c.value for c in ws[1]]

FIELDS = {
    "Policy ID": "policyId", "Client": "client", "Account Owner": "owner",
    "Product Line": "product", "Country": "country", "Region": "region",
    "Distribution": "distribution", "Business Type": "businessType",
    "Status": "status", "Currency": "currency",
    "Inception Date": "inception", "Expiry Date": "expiry",
    "GWP (GBP)": "gwp", "Revenue (GBP)": "revenue",
}

policies = []
for i in range(2, ws.max_row + 1):
    src = {h: ws.cell(i, j).value for j, h in enumerate(hdr, 1)}
    row = {}
    for xl, key in FIELDS.items():
        v = src[xl]
        if key in ("inception", "expiry"):
            v = v.date().isoformat()
        elif key in ("gwp", "revenue"):
            v = round(float(v), 2)
        row[key] = v
    policies.append(row)

with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"policies": policies}, f, indent=0)

print(f"{len(policies)} policies -> {os.path.normpath(OUT)}")
print(f"  GWP     {sum(p['gwp'] for p in policies):>15,.2f}")
print(f"  Revenue {sum(p['revenue'] for p in policies):>15,.2f}")
