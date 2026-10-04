// Plans types for the /flow routes.
//
// The block union and `Plan` are NOT declared here: they live in `services/api.ts` next to the
// endpoints that return them, so the wire shape has exactly one definition. Re-exported rather than
// re-declared so the editor can keep importing `FlowBlock` from the domain path it always used.

export type {
  FileFlowBlock,
  FlowBlock,
  FlowBlockType,
  MediaFlowBlock,
  MindMapEdge,
  MindMapPosition,
  Plan,
  PlanMediaUpload,
  PlanMindMap,
  PollFlowBlock,
  TextFlowBlock,
  YesNoFlowBlock,
} from '../services/api';

/** The editable shape the form modal owns. A plan and a draft never share an object. */
export interface PlanDraft {
  title: string;
  description: string;
}
