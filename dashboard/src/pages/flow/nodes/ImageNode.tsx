import { Handle, Position } from 'reactflow';
import type { NodeProps } from '@reactflow/core';
import type { FlowNodeData } from '../types';

export function ImageNode({ data }: NodeProps<FlowNodeData>) {
  return (
    <div
      style={{
        padding: 12,
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        background: 'var(--bg-card)',
        minWidth: 200,
        maxWidth: 260,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Image</div>
      {data.mediaUrl ? (
        <img
          src={data.mediaUrl}
          alt={data.mediaCaption || 'image'}
          style={{ width: '100%', borderRadius: 6, display: 'block' }}
        />
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>No image URL set</div>
      )}
      {data.mediaCaption && (
        <div style={{ fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap' }}>{data.mediaCaption}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
