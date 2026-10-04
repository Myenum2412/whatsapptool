export type NodeType =
  | 'start'
  | 'message'
  | 'image'
  | 'document'
  | 'video'
  | 'question'
  | 'option'
  | 'condition'
  | 'aiIntent'
  | 'aiResponse'
  | 'input'
  | 'api'
  | 'database'
  | 'delay'
  | 'humanHandoff'
  | 'end';

export type VariableValue = string | number | boolean | null | undefined;

export interface ConversationVariable {
  [key: string]: VariableValue;
}

export interface MessageHistoryItem {
  role: 'assistant' | 'user' | 'system';
  message: string;
  timestamp?: string;
}

export interface ConversationState {
  conversationId: string;
  currentNodeId: string | null;
  variables: ConversationVariable;
  history: MessageHistoryItem;
  retries?: number;
  [key: string]: unknown;
}

export type ConditionOperator =
  | 'equals'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'intent'
  | 'aiClassification'
  | 'gt'
  | '>='
  | 'lt'
  | '<='
  | 'exists'
  | 'notEquals';

export interface EdgeCondition {
  type: 'intent' | 'variable' | 'exact' | 'ai' | 'always';
  value?: VariableValue;
  variable?: string;
  operator?: ConditionOperator;
}

export interface FlowNodeData {
  // common
  label?: string;
  // message
  message?: string;
  // media
  mediaUrl?: string;
  mediaCaption?: string;
  mediaMimeType?: string;
  mediaName?: string;
  // question
  question?: string;
  variable?: string;
  // option
  options?: Array<{ id: string; label: string; value?: string }>;
  // condition
  conditionExpr?: string;
  // aiIntent/aiResponse
  aiPrompt?: string;
  aiInstructions?: string;
  // input
  inputs?: Array<{ key: string; label: string; required?: boolean; type?: string }>;
  // api
  apiConfig?: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    url: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  };
  // delay
  delayMs?: number;
  // human
  handoffTo?: string;
  // fallback
  fallbackMessage?: string;
  maxRetries?: number;
}

export interface FlowEdgeData {
  condition?: EdgeCondition;
  label?: string;
}

/** A graph node as persisted by a flow definition. Distinct from React Flow's own `Node`. */
export interface FlowNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data?: FlowNodeData;
}

/** A graph edge as persisted by a flow definition. */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: FlowEdgeData;
}

export interface FlowDefinition {
  id: string;
  name: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings?: {
    maxRetries?: number;
    fallbackMessage?: string;
  };
  createdAt?: string;
  updatedAt?: string;
}
