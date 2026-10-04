import { Handle, Position } from 'reactflow';
import type { NodeProps } from '@reactflow/core';
import type { FlowNodeData } from '../types';

export function MessageNode({ data }: NodeProps<FlowNodeData>) {
  return (
    <div
      style={{
        padding: 12,
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        background: 'var(--bg-card)',
        minWidth: 220,
        maxWidth: 320,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Message</div>
      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{data.message || '...'}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
