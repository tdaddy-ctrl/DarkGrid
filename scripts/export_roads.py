"""Export real OSM roads and POIs to Person A's RoadGraph schema.

Requires OSMnx 2.x. Run: python scripts/export_roads.py
Data source: OpenStreetMap contributors (ODbL), via OSMnx/Overpass.
No output is written unless all validation succeeds.
"""

import json
import math
from pathlib import Path
import sys


CENTER = (37.7700, -122.4080)  # latitude, longitude
RADIUS_M = 1800
OUTPUT = Path(__file__).resolve().parents[1] / "public/data/soma_roads.json"


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
        if not candidates:
            raise ValueError(f"No real OSM POI found for {category} within {RADIUS_M} m")
    return groups


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
    return start, end


def export():
    import networkx as nx
    import osmnx as ox

    # Disable disk caches/logs to keep generated artifacts within the two assigned files.
    ox.settings.use_cache = False
    ox.settings.log_file = False
    ox.settings.requests_timeout = 60
    # Required point query: OSMnx uses a 1800 m bounding-box distance by default.
    print("Downloading OSM driving graph...", flush=True)
    graph = ox.graph_from_point(
        (37.7700, -122.4080), dist=1800, network_type="drive",
    )
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
    features = ox.features_from_point(
        CENTER, tags={"amenity": ["fire_station", "hospital", "parking"]}, dist=RADIUS_M,
    )
    groups = read_pois(features)
    # Stable OSM identity order; choose the first distinct, reachable station/hospital pair.
    pair = None
    for fire in groups["fire_station"]:
        start = nearest_node(nodes, fire[2])
        for hospital in groups["hospital"]:
            end = nearest_node(nodes, hospital[2])
            if start != end and nx.has_path(graph, start, end):
                pair = fire, hospital
                break
        if pair:
            break
    if pair is None:
        raise ValueError("No distinct, directed-reachable fire station/hospital pair found")
    fire, hospital = pair
    data = {
        "center": {"lat": CENTER[0], "lng": CENTER[1]}, "nodes": nodes, "edges": edges,
        "pois": {"fireStation": fire[2], "hospital": hospital[2],
                 "lots": [candidate[2] for candidate in groups["parking"]]},
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
        export()
    except Exception as error:
        print(f"Export failed; no fabricated data will be generated: {error}", file=sys.stderr)
        sys.exit(1)
