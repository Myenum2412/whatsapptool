import { Handle, Position } from 'reactflow';

// No props are destructured: the end node renders the same shape regardless of node data, and an
// unused destructuring pattern trips `no-empty-pattern`.
export function EndNode() {
  return (
    <div
      style={{ padding: 12, border: '2px solid #ef4444', borderRadius: 8, background: 'var(--bg-card)', minWidth: 140 }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600 }}>END</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Conversation ends</div>
    </div>
  );
}
