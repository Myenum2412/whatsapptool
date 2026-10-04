import { Handle, Position } from 'reactflow';
import type { NodeProps } from '@reactflow/core';
import type { FlowNodeData } from '../types';

export function VideoNode({ data }: NodeProps<FlowNodeData>) {
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
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Video</div>
      {data.mediaUrl ? (
        <video src={data.mediaUrl} controls style={{ width: '100%', borderRadius: 6 }} />
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>No video URL set</div>
      )}
      {data.mediaCaption && (
        <div style={{ fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap' }}>{data.mediaCaption}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
