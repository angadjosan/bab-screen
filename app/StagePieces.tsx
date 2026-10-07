"use client";

import { useMemo } from "react";
import type { StageBlock } from "@/lib/stage/state";
import { layoutDiagram, readDiagram, type DiagramLayout, type PlacedNode } from "@/lib/stage/diagram-layout";
import { stageFrameDocument } from "./stage-frame";
import styles from "./Stage.module.css";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/** Shown while a visual is still streaming in: its frame, breathing, so the space it will take is already held. */
function Drawing() {
  return <div className={styles.drawing} aria-hidden="true" />;
}

function edgePath(points: { x: number; y: number }[]) {
  return points.map((point, i) => `${i ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function DiagramNode({ node, index }: { node: PlacedNode; index: number }) {
  return (
    <g className={cx(styles.node, styles[`tone-${node.tone}`])} style={{ animationDelay: `${index * 90}ms` }}>
      <rect x={node.x} y={node.y} width={node.width} height={node.height} />
      <text x={node.x + node.width / 2} y={node.y + (node.note ? 34 : node.height / 2)} textAnchor="middle" dominantBaseline="middle" className={styles.nodeLabel}>{node.label}</text>
      {node.note && <text x={node.x + node.width / 2} y={node.y + 66} textAnchor="middle" dominantBaseline="middle" className={styles.nodeNote}>{node.note}</text>}
    </g>
  );
}

function DiagramView({ layout }: { layout: DiagramLayout }) {
  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className={styles.diagram} role="img" aria-label={layout.nodes.map((node) => node.label).join(", ")}>
      <defs>
        <marker id="stage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" className={styles.arrowHead} />
        </marker>
      </defs>
      {layout.groups.map((group) => (
        <g key={group.id} className={styles.group}>
          <rect x={group.x} y={group.y} width={group.width} height={group.height} />
          <text x={group.x} y={group.y - 14} className={styles.groupLabel}>{group.label}</text>
        </g>
      ))}
      {layout.edges.map((edge, i) => (
        <g key={i} className={styles.edge} style={{ animationDelay: `${layout.nodes.length * 90 + i * 70}ms` }}>
          <path d={edgePath(edge.points)} markerEnd="url(#stage-arrow)" />
          {edge.label && edge.labelAt && <text x={edge.labelAt.x} y={edge.labelAt.y} textAnchor="middle" dominantBaseline="middle" className={styles.edgeLabel}>{edge.label}</text>}
        </g>
      ))}
      {layout.nodes.map((node, i) => <DiagramNode key={node.id} node={node} index={i} />)}
    </svg>
  );
}

function DiagramPiece({ body }: { body: string }) {
  const layout = useMemo(() => {
    const spec = readDiagram(body);
    return spec ? layoutDiagram(spec) : null;
  }, [body]);
  return layout ? <DiagramView layout={layout} /> : null;
}

type ChartSpec = { type?: "line" | "bar"; title?: string; unit?: string; x?: string[]; series?: { name?: string; values?: number[] }[] };

const CHART = { width: 1000, height: 520, left: 96, right: 24, top: 64, bottom: 56 };
const SERIES_CLASSES = ["series0", "series1", "series2"] as const;

function chartScale(series: number[][]) {
  const values = series.flat().filter(Number.isFinite);
  const low = Math.min(...values, 0);
  const high = Math.max(...values);
  const span = high - low || 1;
  const y = (value: number) => CHART.top + (1 - (value - low) / span) * (CHART.height - CHART.top - CHART.bottom);
  const ticks = Array.from({ length: 5 }, (_, i) => low + (span * i) / 4);
  return { y, ticks };
}

function seriesShape(type: ChartSpec["type"], values: number[], slots: number, index: number, count: number, y: (value: number) => number) {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const slot = plotWidth / Math.max(slots, 1);
  if (type === "bar") {
    const barWidth = (slot * 0.7) / count;
    return values.map((value, i) => <rect key={i} x={CHART.left + i * slot + slot * 0.15 + index * barWidth} y={y(value)} width={barWidth} height={y(0) - y(value)} />);
  }
  const points = values.map((value, i) => `${(CHART.left + i * slot + slot / 2).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  return [<polyline key="line" points={points} />];
}

function ChartPiece({ body }: { body: string }) {
  const spec = parseJson<ChartSpec>(body);
  const series = (spec?.series ?? []).slice(0, 3).map((entry) => (entry.values ?? []).map(Number).slice(0, 40));
  if (!spec || !series.some((values) => values.length)) return null;
  const labels = (spec.x ?? []).slice(0, 40);
  const slots = Math.max(labels.length, ...series.map((values) => values.length));
  const { y, ticks } = chartScale(series);
  const every = Math.ceil(slots / 8);
  return (
    <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} className={styles.chart} role="img" aria-label={spec.title ?? "Chart"}>
      {spec.title && <text x={0} y={30} className={styles.chartTitle}>{spec.title}</text>}
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={CHART.left} x2={CHART.width - CHART.right} y1={y(tick)} y2={y(tick)} className={styles.chartRule} />
          <text x={CHART.left - 14} y={y(tick)} textAnchor="end" dominantBaseline="middle" className={styles.chartLabel}>{`${spec.unit === "$" ? "$" : ""}${Number(tick.toPrecision(3)).toLocaleString("en-US")}`}</text>
        </g>
      ))}
      {labels.map((label, i) => i % every === 0 && (
        <text key={i} x={CHART.left + ((CHART.width - CHART.left - CHART.right) / slots) * (i + 0.5)} y={CHART.height - 18} textAnchor="middle" className={styles.chartLabel}>{label}</text>
      ))}
      {series.map((values, i) => (
        <g key={i} className={cx(styles.series, styles[SERIES_CLASSES[i]], spec.type === "bar" && styles.bars)}>{seriesShape(spec.type, values, slots, i, series.length, y)}</g>
      ))}
    </svg>
  );
}

type TableSpec = { title?: string; columns?: string[]; rows?: unknown[][] };

function TablePiece({ body }: { body: string }) {
  const spec = parseJson<TableSpec>(body);
  if (!spec?.rows?.length) return null;
  return (
    <div className={styles.tableBox}>
      {spec.title && <p className={styles.tableTitle}>{spec.title}</p>}
      <table className={styles.table}>
        {spec.columns && <thead><tr>{spec.columns.slice(0, 5).map((column, i) => <th key={i}>{String(column)}</th>)}</tr></thead>}
        <tbody>
          {spec.rows.slice(0, 8).map((row, i) => (
            <tr key={i} style={{ animationDelay: `${i * 70}ms` }}>{row.slice(0, 5).map((cell, j) => <td key={j}>{String(cell ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Freeform markup, in a sandboxed frame that may load fonts and https images but can never run a script. */
function HtmlPiece({ body }: { body: string }) {
  return <iframe className={styles.frame} sandbox="" srcDoc={stageFrameDocument(body)} title="Worm's drawing" />;
}

const PIECES = { diagram: DiagramPiece, chart: ChartPiece, table: TablePiece, html: HtmlPiece } as const;

/** One visual block of the answer: drawn once its JSON or markup is whole, held as a breathing frame until then. */
export function Visual({ block }: { block: StageBlock }) {
  if (block.kind === "say") return null;
  const Piece = PIECES[block.kind];
  return <div className={styles.visual}>{block.done ? <Piece body={block.body} /> : <Drawing />}</div>;
}
