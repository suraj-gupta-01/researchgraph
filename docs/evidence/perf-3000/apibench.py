"""API latency benchmark: signs in, resolves real ids, times each dashboard endpoint N times."""
import http.cookiejar
import json
import statistics
import sys
import time
import urllib.parse
import urllib.request

BASE = sys.argv[1]
ORIGIN = sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 10

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def get(path):
    t = time.perf_counter()
    with op.open(BASE + path, timeout=120) as r:
        body = r.read()
    return (time.perf_counter() - t) * 1000, json.loads(body), len(body)


req = urllib.request.Request(BASE + "/auth/login", data=json.dumps({"username": "admin", "password": "admin-demo"}).encode(),
                             headers={"Content-Type": "application/json", "X-Requested-With": "ResearchGraph", "Origin": ORIGIN})
op.open(req).read()

_, papers, _ = get("/search/papers?q=federated%20learning&sort=citations&limit=1")
pid = papers["items"][0]["paper_id"]
_, authors, _ = get("/authors?limit=1&sort=papers")
aid = authors["items"][0]["author_id"]
_, comms, _ = get("/communities?limit=1")
cid = comms["items"][0]["community_id"]
_, topics, _ = get("/topics?limit=2&q=federated")
tid = topics["items"][0]["topic_id"]
_, conv, _ = get("/topics/converging?limit=1")
ta, tb = conv["items"][0]["topic_a_id"], conv["items"][0]["topic_b_id"]
_, insts, _ = get("/institutions?limit=1")
iid = insts["items"][0]["institution_id"]

Q = urllib.parse.quote("federated learning")
ENDPOINTS = [
    ("F1 search overview", f"/search/overview?q={Q}"),
    ("F1 search papers (relevance)", f"/search/papers?q={Q}&limit=25"),
    ("F1 search papers (citations)", f"/search/papers?q={Q}&sort=citations&limit=25"),
    ("F1/F6 citation network", f"/search/citation-network?q={Q}"),
    ("paper page", f"/papers/{pid}"),
    ("paper cited-by", f"/papers/{pid}/citations?direction=cited_by&limit=25"),
    ("recursive citation chain d=5", f"/papers/{pid}/citation-chain?direction=cited_by&depth=5"),
    ("papers directory", "/papers?limit=25"),
    ("author page", f"/authors/{aid}"),
    ("author influence", f"/authors/{aid}/influence"),
    ("F2 communities (scoped)", f"/communities?q={Q}"),
    ("F2 community page", f"/communities/{cid}"),
    ("F2 community graph", f"/communities/graph?q={Q}"),
    ("F3 trending", "/topics/trending?direction=emerging&limit=25"),
    ("F3 topic trend", f"/topics/{tid}/trend"),
    ("F4 bridges (scoped)", f"/authors/bridges?q={Q}&limit=25"),
    ("F5 converging pairs", "/topics/converging?limit=25"),
    ("F5 pair trend", f"/topics/pairs/{ta}/{tb}/trend"),
    ("institution page", f"/institutions/{iid}"),
    ("institution network", "/institutions/network"),
    ("top institutions by country", "/institutions/countries"),
    ("methods & runs", "/meta/runs"),
    ("S9 topic authors 2023-2025", f"/queries/topic-authors?topic_id={tid}&year_from=2023&year_to=2025&limit=25"),
    ("S9 cross-community citations", "/queries/cross-community-citations?limit=25"),
    ("S9 topic-year counts", f"/queries/topic-year-counts?topic_id={tid}"),
    ("S9 institutions across 2 topics", f"/queries/institution-topic-collaboration?topic_a={ta}&topic_b={tb}&limit=25"),
]

out = []
for name, path in ENDPOINTS:
    times = []
    size = 0
    for _ in range(N):
        ms, _, size = get(path)
        times.append(ms)
    times.sort()
    out.append({"endpoint": name, "path": path.split("?")[0], "first_ms": round(times[0] if N == 1 else times[-1], 1),
                "median_ms": round(statistics.median(times), 1), "p95_ms": round(times[min(len(times) - 1, int(0.95 * len(times)))], 1),
                "bytes": size})
    print(f"{name:34s} median {statistics.median(times):7.1f} ms   max {times[-1]:7.1f} ms   {size/1024:7.1f} KiB")
json.dump(out, open(sys.argv[4], "w"), indent=1) if len(sys.argv) > 4 else None
