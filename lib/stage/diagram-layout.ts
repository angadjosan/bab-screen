// Turns the model's diagram spec into positions. The model only says what the boxes are and how they connect; dagre
// lays them out, so a diagram never has overlapping boxes or arrows that cross for no reason.

import dagre from "@dagrejs/dagre";

type Graph = InstanceType<typeof dagre.graphlib.Graph>;
type Box = { x: number; y: number; width: number; height: number };
/** A laid-out node or group: dagre gives centres, sizes are what was asked for. */
const boxOf = (graph: Graph, id: string) => graph.node(id) as Box | undefined;

export type DiagramSpec = {
  direction?: "LR" | "TB";
  nodes: { id: string; label: string; note?: string; tone?: "accent" | "muted" }[];
  edges?: { from: string; to: string; label?: string }[];
  groups?: { id: string; label: string; nodes: string[] }[];
};

export type PlacedNode = { id: string; label: string; note: string | null; tone: "accent" | "muted" | "plain"; x: number; y: number; width: number; height: number };
export type PlacedEdge = { points: { x: number; y: number }[]; label: string | null; labelAt: { x: number; y: number } | null };
/** A group's box; its name is drawn in the GROUP_LABEL_ROOM above it. */
export type PlacedGroup = { id: string; label: string; x: number; y: number; width: number; height: number };
export type DiagramLayout = { nodes: PlacedNode[]; edges: PlacedEdge[]; groups: PlacedGroup[]; width: number; height: number };

const MAX_NODES = 14;
const LABEL_CHAR_PX = 14.5;
const NODE_PAD_X = 44;
const NODE_HEIGHT = 64;
const NOTE_HEIGHT = 28;
const MIN_NODE_WIDTH = 150;
/** Room for a group's name above its box, kept clear by spacing the ranks' rows that far apart. */
const GROUP_LABEL_ROOM = 40;
const MARGIN = 24;

const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** The spec, checked: well-formed nodes only, edges between known nodes, groups of known nodes. Null if unusable. */
export function readDiagram(json: string): DiagramSpec | null {
  let raw: Partial<DiagramSpec>;
  try {
    raw = JSON.parse(json) as Partial<DiagramSpec>;
  } catch {
    return null;
  }
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).filter((node) => str(node?.id, 40) && str(node?.label, 40)).slice(0, MAX_NODES);
  if (!nodes.length) return null;
  const known = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).filter((edge) => known.has(edge?.from) && known.has(edge?.to));
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).filter((group) => str(group?.id, 40) && Array.isArray(group.nodes));
  return { direction: raw.direction === "TB" ? "TB" : "LR", nodes, edges, groups };
}

function nodeSize(node: DiagramSpec["nodes"][number]): { width: number; height: number } {
  const longest = Math.max(str(node.label, 40).length, str(node.note, 40).length * 0.8);
  return { width: Math.max(MIN_NODE_WIDTH, Math.round(longest * LABEL_CHAR_PX + NODE_PAD_X)), height: NODE_HEIGHT + (node.note ? NOTE_HEIGHT : 0) };
}

function buildGraph(spec: DiagramSpec): Graph {
  const graph = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  graph.setGraph({ rankdir: spec.direction ?? "LR", nodesep: GROUP_LABEL_ROOM + 44, ranksep: 90, edgesep: 20, marginx: MARGIN, marginy: MARGIN + GROUP_LABEL_ROOM });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of spec.nodes) graph.setNode(node.id, nodeSize(node));
  for (const group of spec.groups ?? []) {
    graph.setNode(`group:${group.id}`, { label: group.label });
    for (const member of group.nodes) if (graph.hasNode(member)) graph.setParent(member, `group:${group.id}`);
  }
  (spec.edges ?? []).forEach((edge, index) => {
    const label = str(edge.label, 30);
    graph.setEdge(edge.from, edge.to, label ? { label, width: label.length * 11 + 16, height: 28 } : {}, `e${index}`);
  });
  return graph;
}

function placedGroups(graph: Graph, spec: DiagramSpec): PlacedGroup[] {
  return (spec.groups ?? []).flatMap((group) => {
    const box = boxOf(graph, `group:${group.id}`);
    if (!box) return [];
    return [{ id: group.id, label: str(group.label, 40), x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width, height: box.height }];
  });
}

/** Where everything goes, in a box of `width` by `height` that the page scales to fit. */
export function layoutDiagram(spec: DiagramSpec): DiagramLayout {
  const graph = buildGraph(spec);
  dagre.layout(graph);
  const nodes = spec.nodes.map((node): PlacedNode => {
    const box = boxOf(graph, node.id) as Box;
    return { id: node.id, label: str(node.label, 40), note: str(node.note, 40) || null, tone: node.tone ?? "plain", x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width, height: box.height };
  });
  const edges = graph.edges().map((key: Parameters<Graph["edge"]>[0]): PlacedEdge => {
    const edge = graph.edge(key) as { points: { x: number; y: number }[]; label?: string; x?: number; y?: number };
    return { points: edge.points, label: edge.label ?? null, labelAt: edge.label && edge.x !== undefined && edge.y !== undefined ? { x: edge.x, y: edge.y } : null };
  });
  const size = graph.graph() as { width?: number; height?: number };
  return { nodes, edges, groups: placedGroups(graph, spec), width: (size.width ?? 0) + MARGIN, height: (size.height ?? 0) + MARGIN };
}
