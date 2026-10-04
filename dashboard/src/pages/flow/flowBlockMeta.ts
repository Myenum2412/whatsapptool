import {
  FileText,
  Image as ImageIcon,
  ListChecks,
  ToggleLeft,
  Type as TypeIcon,
  Video as VideoIcon,
} from 'lucide-react';
import type { FlowBlockType } from '../../types/plans';

/**
 * The block vocabulary shared by the list view and the mind-map's inline editor, kept out of the
 * component module so fast-refresh stays limited to components.
 */

export const BLOCK_TYPES: readonly FlowBlockType[] = ['text', 'image', 'video', 'file', 'poll', 'yesno'];

/** Drag payload type used when dragging a palette block onto the mind-map canvas. */
export const BLOCK_DRAG_MIME = 'application/x-mywhatsapp-flow-block';

// Literal key strings, not a computed `flow.blocks.type.${type}`: i18next would resolve those at
// runtime, but the locale parity checker only sees statically written keys.
export const BLOCK_TYPE_KEYS: Record<FlowBlockType, string> = {
  text: 'flow.blocks.type.text',
  image: 'flow.blocks.type.image',
  video: 'flow.blocks.type.video',
  file: 'flow.blocks.type.file',
  poll: 'flow.blocks.type.poll',
  yesno: 'flow.blocks.type.yesno',
};

export const BLOCK_ICONS: Record<FlowBlockType, typeof TypeIcon> = {
  text: TypeIcon,
  image: ImageIcon,
  video: VideoIcon,
  file: FileText,
  poll: ListChecks,
  yesno: ToggleLeft,
};
