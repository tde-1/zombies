"""Export the catalogue as JSON, so the site and the next agent do not need SQLite."""
import json, os, sys
sys.path.insert(0, r'C:\Users\b\Desktop\Zombies\archive')
from lib import catalogue

WORK = r'C:\Users\b\ZombiesDev\archive'
db = catalogue.connect()
maps = {}
for r in db.execute("SELECT * FROM maps ORDER BY norm, source"):
    d = maps.setdefault(r["norm"], {"norm": r["norm"], "names": [], "sightings": [],
                                    "authors": [], "tags": [], "links": []})
    if r["name"] not in d["names"]:
        d["names"].append(r["name"])
    if r["author"] and r["author"] not in d["authors"]:
        d["authors"].append(r["author"])
    for t in json.loads(r["tags"] or "[]"):
        if t not in d["tags"]:
            d["tags"].append(t)
    d["sightings"].append({"source": r["source"], "url": r["source_url"],
                           "released": r["released"],
                           "description": (r["description"] or "")[:2000] or None,
                           "extra": json.loads(r["extra"] or "{}")})
for r in db.execute("SELECT l.*, m.norm norm FROM links l JOIN maps m ON m.key=l.map_key"):
    d = maps.get(r["norm"])
    if d is None:
        continue
    if any(x["url"] == r["url"] for x in d["links"]):
        continue
    d["links"].append({"url": r["url"], "host": r["host"], "label": r["label"],
                       "verdict": r["verdict"], "size": r["size"],
                       "size_exact": bool(r["size_exact"]), "filename": r["filename"],
                       "error": r["error"], "checked": r["checked"]})
out = os.path.join(WORK, "reports", "catalogue.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as fh:
    json.dump(sorted(maps.values(), key=lambda d: d["norm"]), fh, indent=1)
print("%d maps -> %s (%.1f MB)" % (len(maps), out, os.path.getsize(out) / 2**20))
