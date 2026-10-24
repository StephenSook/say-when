'use client';

/**
 * The Suggested replies tree on a React Flow canvas (@xyflow/react 12.12.0, MIT; its attribution stays visible).
 * Client only: components/screens/Replies.tsx loads this file with next/dynamic and ssr off.
 *
 * Every node and edge comes from lib/tree/model.ts, a pure function of the rows, at fixed positions from
 * lib/tree/layout.ts. This file adds only motion, and only for real events:
 * - a node that appears after the page loaded grows out of its parent once;
 * - one dot travels an edge once for each new handoff the model names (keyed by the row that caused it);
 * - an edge whose next step is running now has a moving dash; nothing else moves, so an idle screen is still;
 * - the camera moves when the model's camera key changes: a pick, a confirm, a follow-up round.
 * Under reduced motion there are no dots, no growth and every camera move is instant.
 *
 * The canvas is a display, not an editor: dragging, panning, zooming and selecting are off, so a stray touch on the
 * trackpad cannot move the view in front of the judges.
 */
import '@xyflow/react/dist/base.css';
import {
  Background,
  BackgroundVariant,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { cx } from '@/lib/cx';
import { cameraFraming } from '@/lib/tree/camera';
import type { CameraTarget, EdgeTone, Handoff, ReplyTree, TreeEdge, TreeNode } from '@/lib/tree/model';
import { CardBody, cardClass } from './TreeCards';
import styles from './ReplyTree.module.css';

/** How long one handoff dot takes to cross its edge. */
const DOT_MS = 900;
/** The camera move on a pick, and on anything else. */
const PICK_MS = 900;
const MOVE_MS = 700;

interface FlowNodeData extends Record<string, unknown> {
  node: TreeNode;
  /** Grow in once: the node appeared after the page loaded. */
  enter: boolean;
}

interface FlowEdgeData extends Record<string, unknown> {
  shape: TreeEdge['shape'];
  tone: EdgeTone;
  running: boolean;
  dots: Handoff[];
}

type FlowNode = Node<FlowNodeData, 'tree'>;
type FlowEdge = Edge<FlowEdgeData, 'tree'>;

const STAGGER_MS: Partial<Record<TreeNode['kind'], number>> = { option: 120, child: 80, more: 80 };

const TreeFlowNode = memo(function TreeFlowNode({ data }: NodeProps<FlowNode>) {
  const { node, enter } = data;
  if (node.kind === 'region') return <div className={styles.region} aria-hidden="true" />;
  const style =
    enter && node.enterFrom
      ? ({
          '--dx': `${node.enterFrom.dx}px`,
          '--dy': `${node.enterFrom.dy}px`,
          '--delay': `${node.enterOrder * (STAGGER_MS[node.kind] ?? 0)}ms`,
        } as CSSProperties)
      : undefined;
  return (
    <>
      <Handle type="target" position={Position.Left} id="left" className={styles.handle} isConnectable={false} />
      <Handle type="target" position={Position.Top} id="top" className={styles.handle} isConnectable={false} />
      <Handle type="source" position={Position.Right} id="right" className={styles.handle} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={styles.handle} isConnectable={false} />
      {node.kind === 'hub' ? (
        <Handle type="source" position={Position.Bottom} id="kids" className={styles.handle} style={{ left: 28 }} isConnectable={false} />
      ) : null}
      <div className={cx(cardClass(node), enter && styles.entering)} style={style}>
        <CardBody node={node} />
      </div>
    </>
  );
});

/** One dot, once, along the edge's own path (SVG animateMotion), started the moment it mounts. */
function Dot({ path, tone }: { path: string; tone: Handoff['tone'] }) {
  const motion = useRef<SVGAnimateMotionElement>(null);
  useLayoutEffect(() => {
    motion.current?.beginElement();
  }, []);
  return (
    <circle r={9} className={cx(styles.dot, tone === 'picked' && styles.dotPicked)}>
      <animateMotion ref={motion} dur={`${DOT_MS}ms`} begin="indefinite" fill="freeze" path={path} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
    </circle>
  );
}

const TreeFlowEdge = memo(function TreeFlowEdge(props: EdgeProps<FlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  if (!data) return null;
  const [path] =
    data.shape === 'branch'
      ? getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 16, offset: 0 })
      : data.shape === 'straight'
        ? getStraightPath({ sourceX, sourceY, targetX, targetY })
        : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <path d={path} className={cx(styles.edge, styles[`edge_${data.tone}`], data.running && styles.edgeRunning)} />
      {data.dots.map((dot) => (
        <Dot key={dot.key} path={path} tone={dot.tone} />
      ))}
    </>
  );
});

const NODE_TYPES = { tree: TreeFlowNode };
const EDGE_TYPES = { tree: TreeFlowEdge };

/**
 * Frames the model's camera target whenever its key changes, or the canvas changes size. lib/tree/camera.ts picks the
 * view: the target whole, as close as allowed, with the screen's edges in the gaps between cards, so no card is ever
 * cut in half at the edge of the picture.
 */
function CameraDirector({ camera, nodes, reduced }: { camera: CameraTarget; nodes: readonly TreeNode[]; reduced: boolean }) {
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const last = useRef<{ key: string; size: string } | null>(null);

  useEffect(() => {
    if (width <= 0 || height <= 0) return;
    const size = `${width}x${height}`;
    const before = last.current;
    if (before && before.key === camera.key && before.size === size) return;
    last.current = { key: camera.key, size };
    // The first frame and a resize jump straight there; only a new row moves the camera smoothly.
    const instant = reduced || before === null || before.key === camera.key;
    const duration = instant ? 0 : camera.intent === 'pick' ? PICK_MS : MOVE_MS;
    void flow.setViewport(cameraFraming(camera, nodes, width, height), { duration, interpolate: 'smooth' });
  }, [camera, nodes, width, height, reduced, flow]);

  return null;
}

function Canvas({ tree, reduced }: { tree: ReplyTree; reduced: boolean }) {
  // Nodes on screen when the canvas first drew do not grow in: only rows that arrive later make motion.
  const firstIds = useRef<Set<string> | null>(null);
  if (firstIds.current === null) firstIds.current = new Set(tree.nodes.map((n) => n.id));

  // One dot per new handoff. The handoffs present at first draw are history, not news.
  const played = useRef<Set<string> | null>(null);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [dots, setDots] = useState<Handoff[]>([]);
  useEffect(() => {
    if (played.current === null) {
      played.current = new Set(tree.handoffs.map((h) => h.key));
      return;
    }
    const seen = played.current;
    const fresh = tree.handoffs.filter((h) => !seen.has(h.key));
    if (fresh.length === 0) return;
    for (const h of fresh) seen.add(h.key);
    if (reduced) return;
    setDots((current) => [...current, ...fresh]);
    const keys = new Set(fresh.map((h) => h.key));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setDots((current) => current.filter((dot) => !keys.has(dot.key)));
    }, DOT_MS + 120);
    timers.current.add(timer);
  }, [tree.handoffs, reduced]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const nodes = useMemo<FlowNode[]>(
    () =>
      tree.nodes.map((n) => ({
        id: n.id,
        type: 'tree',
        position: { x: n.rect.x, y: n.rect.y },
        width: n.rect.width,
        height: n.rect.height,
        data: { node: n, enter: !reduced && !firstIds.current!.has(n.id) },
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        deletable: false,
        zIndex: n.kind === 'region' ? -1 : n.kind === 'option' && n.state === 'picked' ? 3 : 1,
        ariaLabel: n.kind === 'region' ? undefined : n.ariaLabel,
      })),
    [tree.nodes, reduced],
  );

  const edges = useMemo<FlowEdge[]>(
    () =>
      tree.edges.map((e) => ({
        id: e.id,
        type: 'tree',
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        selectable: false,
        focusable: false,
        deletable: false,
        zIndex: e.tone === 'picked' ? 2 : 0,
        data: { shape: e.shape, tone: e.tone, running: e.running, dots: dots.filter((dot) => dot.edgeId === e.id) },
      })),
    [tree.edges, dots],
  );

  return (
    <ReactFlow<FlowNode, FlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      colorMode="dark"
      minZoom={0.2}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      panOnDrag={false}
      panOnScroll={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      autoPanOnNodeFocus={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      panActivationKeyCode={null}
      zoomActivationKeyCode={null}
    >
      <Background variant={BackgroundVariant.Dots} gap={48} size={2} color="rgba(255, 255, 255, 0.07)" />
      <CameraDirector camera={tree.camera} nodes={tree.nodes} reduced={reduced} />
    </ReactFlow>
  );
}

export function ReplyGraph({ tree, reduced }: { tree: ReplyTree; reduced: boolean }) {
  return (
    <div className={styles.flow} role="group" aria-label="Suggested replies, drawn as a tree from the question to the options">
      <ReactFlowProvider>
        <Canvas tree={tree} reduced={reduced} />
      </ReactFlowProvider>
    </div>
  );
}
