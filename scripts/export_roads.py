"""Export real OSM roads and POIs to Person A's RoadGraph schema.

Requires OSMnx 2.x. Run: python scripts/export_roads.py
Data source: OpenStreetMap contributors (ODbL), via OSMnx/Overpass.
No output is written unless all validation succeeds.
"""

import json
import math
from pathlib import Path
import sys
import argparse


CENTER = (37.7700, -122.4080)  # latitude, longitude
RADIUS_M = 1800
OUTPUT = Path(__file__).resolve().parents[1] / "public/data/soma_roads.json"
FIRE_FALLBACK = {"lat": 37.7794, "lng": -122.4041}
HOSPITAL_FALLBACK = {"lat": 37.7557, "lng": -122.4048}
MAX_ROUTE_DISTANCE_M = 300


def to_xy(lat, lng):
    """Match src/lib/sim.ts's local meter conversion exactly."""
    return (
        (lng - CENTER[1]) * 111320 * math.cos(math.radians(CENTER[0])),
        (lat - CENTER[0]) * 110540,
    )


def nearest_node(nodes, pos):
    """Match the simulator's nearest-node rule, with deterministic ties."""
    x, y = to_xy(pos["lat"], pos["lng"])
    return min(nodes, key=lambda n: ((n["x"] - x) ** 2 + (n["y"] - y) ** 2, n["id"]))["id"]


def read_pois(features):
    """Use actual OSM points or representative points inside OSM polygons."""
    groups = {"fire_station": [], "hospital": [], "parking": []}
    for osm_key, row in features.sort_index().iterrows():
        category = row.get("amenity")
        if category not in groups or row.geometry is None or row.geometry.is_empty:
            continue
        point = row.geometry.representative_point()
        pos = {"lat": float(point.y), "lng": float(point.x)}
        x, y = to_xy(pos["lat"], pos["lng"])
        if math.hypot(x, y) <= RADIUS_M:
            groups[category].append((str(osm_key), str(row.get("name", "unnamed")), pos))
    for category, candidates in groups.items():
        if category == "parking" and not candidates:
            raise ValueError(f"No real OSM POI found for {category} within {RADIUS_M} m")
    return groups


def select_poi(candidates, name_fragment, fallback):
    """Stable OSM identity order, with the brief's explicit fallback only."""
    return next((p for p in candidates if name_fragment.casefold() in p[1].casefold()),
                ("brief fallback", name_fragment, fallback))


def route_distance(nodes, path):
    """Distance to the node-to-node segments actually driven by the simulator."""
    by_id = {n["id"]: n for n in nodes}
    best = math.inf
    for u, v in zip(path, path[1:]):
        a, b = by_id[u], by_id[v]
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        t = max(0, min(1, -(a["x"] * dx + a["y"] * dy) / (dx * dx + dy * dy))) if dx or dy else 0
        best = min(best, math.hypot(a["x"] + t * dx, a["y"] + t * dy))
    return best


def validate(data, graph, nx):
    """Reject broken references, invalid numbers, or an unreachable ambulance route."""
    assert set(data) == {"center", "nodes", "edges", "pois"}
    assert set(data["pois"]) == {"fireStation", "hospital", "lots"}
    assert data["center"] == {"lat": CENTER[0], "lng": CENTER[1]}
    assert data["pois"]["lots"]
    for pos in [data["pois"]["fireStation"], data["pois"]["hospital"], *data["pois"]["lots"]]:
        assert set(pos) == {"lat", "lng"}
        assert math.isfinite(pos["lat"]) and math.isfinite(pos["lng"])
        assert -90 <= pos["lat"] <= 90 and -180 <= pos["lng"] <= 180
    nodes = data["nodes"]
    ids = {n["id"] for n in nodes}
    assert nodes and len(ids) == len(nodes)
    assert len(data["edges"]) == graph.number_of_edges()
    assert len({e["id"] for e in data["edges"]}) == len(data["edges"])
    assert nx.is_strongly_connected(graph)
    for n in nodes:
        assert set(n) == {"id", "lat", "lng", "x", "y"}
        assert abs(n["id"]) <= 2**53 - 1
        assert all(math.isfinite(n[k]) for k in ("lat", "lng", "x", "y"))
        assert -90 <= n["lat"] <= 90 and -180 <= n["lng"] <= 180
        assert (n["x"], n["y"]) == to_xy(n["lat"], n["lng"])
    for e in data["edges"]:
        assert set(e) == {"id", "from", "to", "lengthM", "oneway"}
        assert e["from"] in ids and e["to"] in ids
        assert e["oneway"] is True
        assert math.isfinite(e["lengthM"]) and e["lengthM"] > 0
    start = nearest_node(nodes, data["pois"]["fireStation"])
    end = nearest_node(nodes, data["pois"]["hospital"])
    assert start != end and nx.has_path(graph, start, end) and nx.has_path(graph, end, start)
    path = nx.dijkstra_path(graph, start, end, weight="length")
    distance = route_distance(nodes, path)
    print(f"Directed Dijkstra: {start} -> {end}; minimum center distance: {distance:.3f} m", flush=True)
    if distance > MAX_ROUTE_DISTANCE_M:
        raise ValueError(f"Shortest route misses 300 m requirement: minimum distance {distance:.3f} m; output unchanged")
    return start, end


def export(reuse_roads=False, brief_pois=False):
    import networkx as nx
    import osmnx as ox

    # Disable disk caches/logs to keep generated artifacts within the two assigned files.
    ox.settings.use_cache = False
    ox.settings.log_file = False
    ox.settings.requests_timeout = 60
    # Required point query: OSMnx uses a 1800 m bounding-box distance by default.
    if brief_pois and not reuse_roads:
        raise ValueError("--brief-pois requires --reuse-roads to preserve existing OSM parking")
    print("Reusing exported OSM driving graph..." if reuse_roads else "Downloading OSM driving graph...", flush=True)
    original = json.loads(OUTPUT.read_text(encoding="utf-8")) if reuse_roads else None
    graph = ox.graph_from_point(
        (37.7700, -122.4080), dist=1800, network_type="drive",
    ) if original is None else nx.MultiDiGraph()
    if original is not None:
        for n in original["nodes"]:
            graph.add_node(n["id"], x=n["lng"], y=n["lat"])
        for e in original["edges"]:
            assert e["oneway"] is True
            graph.add_edge(e["from"], e["to"], key=e["id"], length=e["lengthM"])
    # An induced MultiDiGraph preserves every directed/parallel edge in the SCC.
    # Break equal-size component ties by smallest OSM node ID.
    component = min(nx.strongly_connected_components(graph), key=lambda c: (-len(c), min(c)))
    graph = graph.subgraph(component).copy()
    print(f"Largest SCC: {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges", flush=True)
    nodes = []
    for node_id, attrs in sorted(graph.nodes(data=True)):
        lat, lng = float(attrs["y"]), float(attrs["x"])
        x, y = to_xy(lat, lng)
        nodes.append({"id": int(node_id), "lat": lat, "lng": lng, "x": x, "y": y})
    edges = [
        {"id": i, "from": int(u), "to": int(v), "lengthM": float(attrs["length"]), "oneway": True}
        for i, (u, v, key, attrs) in enumerate(sorted(
            graph.edges(keys=True, data=True), key=lambda edge: (edge[0], edge[1], edge[2]),
        ))
    ]
    if original is not None:
        # Preserve the existing extraction, parallel edges, IDs and parking exactly.
        nodes, edges = original["nodes"], original["edges"]
    if brief_pois:
        print("OSM POI lookup unavailable: explicitly using Austin's approximate coordinates", flush=True)
        groups = {"fire_station": [], "hospital": [], "parking": []}
    else:
        features = ox.features_from_point(
            CENTER, tags={"amenity": ["fire_station", "hospital", "parking"]}, dist=RADIUS_M,
        )
        groups = read_pois(features)
    fire = select_poi(groups["fire_station"], "Station 1", FIRE_FALLBACK)
    hospital = select_poi(groups["hospital"], "General", HOSPITAL_FALLBACK)
    print(f"Selected fire station: {fire}; hospital: {hospital}", flush=True)
    def snapped(candidate):
        node_id = nearest_node(nodes, candidate[2])
        n = next(n for n in nodes if n["id"] == node_id)
        print(f"Snap {candidate[1]} to road node {node_id}: ({n['lat']}, {n['lng']})", flush=True)
        return {"lat": n["lat"], "lng": n["lng"]}
    data = {
        "center": {"lat": CENTER[0], "lng": CENTER[1]}, "nodes": nodes, "edges": edges,
        "pois": {"fireStation": snapped(fire), "hospital": snapped(hospital),
                 "lots": original["pois"]["lots"] if original is not None else [candidate[2] for candidate in groups["parking"]]},
    }
    start, end = validate(data, graph, nx)
    payload = json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(payload, encoding="utf-8")
    print(f"Source: OpenStreetMap contributors (ODbL); OSMnx {ox.__version__}")
    print(f"Nodes: {len(nodes)}; directed edges (including parallel): {len(edges)}")
    for category, candidates in groups.items():
        print(f"POIs {category}: {len(candidates)}")
    print(f"Selected fire station: {fire}; hospital: {hospital}")
    print(f"Directed connectivity validated: {start} -> {end}")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    try:
        if not __debug__:
            raise RuntimeError("Run without -O: validation assertions must remain enabled")
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--reuse-roads", action="store_true", help="Refresh ambulance POIs while preserving existing roads and parking")
        parser.add_argument("--brief-pois", action="store_true", help="Use the brief's fallback coordinates when OSM lookup is unavailable; requires --reuse-roads")
        args = parser.parse_args()
        export(reuse_roads=args.reuse_roads, brief_pois=args.brief_pois)
    except Exception as error:
        print(f"Export failed; no fabricated data will be generated: {error}", file=sys.stderr)
        sys.exit(1)
