import { useState, type Dispatch, type SetStateAction } from 'react';
import { ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, MarkerType } from 'reactflow';
import type { Connection, Edge, Node } from '@reactflow/core';
import 'reactflow/dist/style.css';
import type { FlowNodeData } from './types';
import { StartNode } from './nodes/StartNode';
import { MessageNode } from './nodes/MessageNode';
import { ImageNode } from './nodes/ImageNode';
import { DocumentNode } from './nodes/DocumentNode';
import { VideoNode } from './nodes/VideoNode';
import { QuestionNode } from './nodes/QuestionNode';
import { EndNode } from './nodes/EndNode';

const nodeTypes = {
  start: StartNode,
  message: MessageNode,
  image: ImageNode,
  document: DocumentNode,
  video: VideoNode,
  question: QuestionNode,
  end: EndNode,
};

const defaultViewport = { x: 0, y: 0, zoom: 1 };

const initialNodes: Node<FlowNodeData>[] = [
  {
    id: 'start',
    type: 'start',
    position: { x: 50, y: 150 },
    data: {},
  },
  {
    id: 'message_1',
    type: 'message',
    position: { x: 250, y: 150 },
    data: { message: 'Welcome! How can I help you today?' },
  },
  {
    id: 'end',
    type: 'end',
    position: { x: 550, y: 150 },
    data: {},
  },
];

const initialEdges: Edge[] = [
  {
    id: 'e1',
    source: 'start',
    target: 'message_1',
    markerEnd: { type: MarkerType.ArrowClosed },
  },
  {
    id: 'e2',
    source: 'message_1',
    target: 'end',
    markerEnd: { type: MarkerType.ArrowClosed },
  },
];

export function FlowBuilder() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNode, setSelectedNode] = useState<Node<FlowNodeData> | null>(null);

  const onConnect = (connection: Connection) => {
    setEdges(eds =>
      addEdge(
        {
          ...connection,
          markerEnd: { type: MarkerType.ArrowClosed },
        },
        eds,
      ),
    );
  };

  const onNodeClick = (_event: React.MouseEvent, node: Node<FlowNodeData>) => {
    setSelectedNode(node);
  };

  const onPaneClick = () => {
    setSelectedNode(null);
  };

  const addNode = (type: string) => {
    const id = `${type}_${Date.now()}`;
    const position = { x: 250 + (nodes.length % 5) * 120, y: 100 + Math.floor(nodes.length / 5) * 100 };
    const newNode: Node<FlowNodeData> = {
      id,
      type,
      position,
      data: getDefaultData(type),
    };
    setNodes(nds => [...nds, newNode]);
  };

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%' }}>
      <div
        style={{
          width: 220,
          padding: 16,
          borderRight: '1px solid var(--border-color)',
          overflow: 'auto',
          background: 'var(--bg-secondary)',
        }}
      >
        <h4 style={{ margin: '0 0 12px 0' }}>Nodes</h4>
        {['message', 'image', 'document', 'video', 'question', 'end'].map(t => (
          <button
            key={t}
            onClick={() => addNode(t)}
            style={{
              width: '100%',
              marginBottom: 8,
              padding: '8px 10px',
              border: '1px solid var(--border-color)',
              background: 'var(--bg-card)',
              borderRadius: 6,
              cursor: 'pointer',
              textAlign: 'left',
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          defaultViewport={defaultViewport}
          fitView
          attributionPosition="bottom-left"
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      {selectedNode && (
        <div
          style={{
            width: 300,
            padding: 16,
            borderLeft: '1px solid var(--border-color)',
            overflow: 'auto',
            background: 'var(--bg-secondary)',
          }}
        >
          <h4 style={{ margin: '0 0 12px 0' }}>Inspector</h4>
          <div style={{ fontSize: 12, marginBottom: 8, color: 'var(--text-secondary)' }}>
            ID: {selectedNode.id} | Type: {selectedNode.type}
          </div>
          {renderInspector(selectedNode, setNodes)}
        </div>
      )}
    </div>
  );
}

function getDefaultData(type: string): FlowNodeData {
  switch (type) {
    case 'message':
      return { message: 'New message' };
    case 'question':
      return { question: 'Your question?', variable: 'response' };
    case 'image':
      return { mediaUrl: '' };
    case 'document':
      return { mediaUrl: '', mediaName: 'document.pdf' };
    case 'video':
      return { mediaUrl: '' };
    default:
      return {};
  }
}

function renderInspector(node: Node<FlowNodeData>, setNodes: Dispatch<SetStateAction<Node<FlowNodeData>[]>>) {
  const data = node.data || {};
  const updateData = (patch: Partial<FlowNodeData>) => {
    setNodes(nds => nds.map(n => (n.id === node.id ? { ...n, data: { ...n.data, ...patch } } : n)));
  };

  if (node.type === 'message') {
    return (
      <div>
        <label htmlFor="flow-inspector-message" style={{ display: 'block', marginBottom: 8 }}>
          Message
        </label>
        <textarea
          id="flow-inspector-message"
          value={data.message || ''}
          onChange={e => updateData({ message: e.target.value })}
          rows={6}
          style={{
            width: '100%',
            padding: 8,
            border: '1px solid var(--border-color)',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            borderRadius: 6,
          }}
        />
      </div>
    );
  }
  if (node.type === 'question') {
    return (
      <div>
        <label htmlFor="flow-inspector-question" style={{ display: 'block', marginBottom: 8 }}>
          Question
        </label>
        <textarea
          id="flow-inspector-question"
          value={data.question || ''}
          onChange={e => updateData({ question: e.target.value })}
          rows={4}
          style={{
            width: '100%',
            padding: 8,
            border: '1px solid var(--border-color)',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            borderRadius: 6,
          }}
        />
        <label htmlFor="flow-inspector-question-variable" style={{ display: 'block', marginTop: 12, marginBottom: 8 }}>
          Variable
        </label>
        <input
          id="flow-inspector-question-variable"
          value={data.variable || ''}
          onChange={e => updateData({ variable: e.target.value })}
          style={{
            width: '100%',
            padding: 8,
            border: '1px solid var(--border-color)',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            borderRadius: 6,
          }}
        />
      </div>
    );
  }
  if (node.type === 'image' || node.type === 'document' || node.type === 'video') {
    return (
      <div>
        <label htmlFor="flow-inspector-media-url" style={{ display: 'block', marginBottom: 8 }}>
          Media URL
        </label>
        <input
          id="flow-inspector-media-url"
          value={data.mediaUrl || ''}
          onChange={e => updateData({ mediaUrl: e.target.value })}
          style={{
            width: '100%',
            padding: 8,
            border: '1px solid var(--border-color)',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            borderRadius: 6,
          }}
        />
        {node.type === 'document' && (
          <div style={{ marginTop: 12 }}>
            <label htmlFor="flow-inspector-media-name" style={{ display: 'block', marginBottom: 8 }}>
              File Name
            </label>
            <input
              id="flow-inspector-media-name"
              value={data.mediaName || ''}
              onChange={e => updateData({ mediaName: e.target.value })}
              style={{
                width: '100%',
                padding: 8,
                border: '1px solid var(--border-color)',
                background: 'var(--bg-card)',
                color: 'var(--text-primary)',
                borderRadius: 6,
              }}
            />
          </div>
        )}
        <label htmlFor="flow-inspector-media-caption" style={{ display: 'block', marginTop: 12, marginBottom: 8 }}>
          Caption (optional)
        </label>
        <textarea
          id="flow-inspector-media-caption"
          value={data.mediaCaption || ''}
          onChange={e => updateData({ mediaCaption: e.target.value })}
          rows={3}
          style={{
            width: '100%',
            padding: 8,
            border: '1px solid var(--border-color)',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            borderRadius: 6,
          }}
        />
      </div>
    );
  }
  return <div>No inspector for {node.type}</div>;
}
