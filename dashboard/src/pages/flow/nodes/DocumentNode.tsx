import { Handle, Position } from 'reactflow';
import type { NodeProps } from '@reactflow/core';
import type { FlowNodeData } from '../types';

export function DocumentNode({ data }: NodeProps<FlowNodeData>) {
  return (
    <div
      style={{
        padding: 12,
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        background: 'var(--bg-card)',
        minWidth: 200,
        maxWidth: 280,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Document</div>
      <div style={{ fontSize: 13 }}>{data.mediaName || data.mediaUrl || 'Document'}</div>
      {data.mediaCaption && (
        <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
          {data.mediaCaption}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
