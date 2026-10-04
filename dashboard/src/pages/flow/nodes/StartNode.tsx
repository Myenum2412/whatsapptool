import { Handle, Position } from 'reactflow';

// No props are destructured: the start node renders the same shape regardless of node data, and an
// unused destructuring pattern trips `no-empty-pattern`. `nodeTypes` in FlowBuilder.tsx is what ties
// this component to NodeProps<FlowNodeData>.
export function StartNode() {
  return (
    <div
      style={{ padding: 12, border: '2px solid #22c55e', borderRadius: 8, background: 'var(--bg-card)', minWidth: 160 }}
    >
      <Handle type="source" position={Position.Right} />
      <div style={{ fontWeight: 600 }}>START</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Conversation begins</div>
    </div>
  );
}
