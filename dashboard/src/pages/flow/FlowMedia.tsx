import { FileText, Image as ImageIcon, Play, Video as VideoIcon } from 'lucide-react';
import { useResolvedMediaSrc } from './resolveFlowMedia';
import type { FlowBlock } from '../../types/plans';

/** The media hero of a card: a thumbnail for images/videos, a document chip for files. */
export function FlowMediaThumb({ block }: { block: Extract<FlowBlock, { type: 'image' | 'video' | 'file' }> }) {
  const { src, loading } = useResolvedMediaSrc(block.mediaUrl);

  if (block.type === 'file') {
    return (
      <span className="flow-media-file">
        <FileText size={16} aria-hidden="true" />
        <span className="flow-media-file-name">{block.filename.trim() !== '' ? block.filename : block.mediaUrl}</span>
      </span>
    );
  }

  const Placeholder = block.type === 'video' ? VideoIcon : ImageIcon;

  if (!src) {
    return (
      <span className="flow-media-placeholder">
        <Placeholder size={16} aria-hidden="true" />
        {loading && <span className="flow-media-loading" aria-hidden="true" />}
      </span>
    );
  }

  return block.type === 'video' ? (
    <>
      <video className="flow-media-el" src={src} muted playsInline preload="metadata" />
      <span className="flow-media-play" aria-hidden="true">
        <Play size={16} fill="currentColor" />
      </span>
    </>
  ) : (
    <img className="flow-media-el" src={src} alt="" loading="lazy" />
  );
}
