import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCheck, FileText, Image as ImageIcon, ListChecks, Play, Video as VideoIcon } from 'lucide-react';
import { useResolvedMediaSrc } from './resolveFlowMedia';
import type { FlowBlock } from '../../types/plans';

/**
 * A WhatsApp-style preview of a single flow block.
 *
 * This is the ported WA UI look (WDS tokens, outgoing bubble, tail, read receipt) recreated as plain
 * scoped CSS rather than shadcn/Tailwind components, so the flow builder keeps its existing styling
 * architecture. It is a *preview*: the container is `aria-hidden` because the same content is already
 * exposed through the block's form fields, and the "buttons" below are non-interactive spans so they
 * never enter the accessibility tree or the tab order.
 */
export function WhatsAppPreview({ block }: { block: FlowBlock }) {
  const { t } = useTranslation();
  const untitled = <span className="wa-placeholder">{t('flow.map.untitled')}</span>;
  // Resolved once for every block type (the hook must run unconditionally); non-media blocks pass an
  // empty url and never trigger a fetch. Uploaded media is an authenticated path, an external link
  // passes through as-is.
  const mediaUrl = block.type === 'image' || block.type === 'video' || block.type === 'file' ? block.mediaUrl : '';
  const { src } = useResolvedMediaSrc(mediaUrl);

  let body: ReactNode;
  switch (block.type) {
    case 'text':
      body = <p className="wa-text">{block.text.trim() !== '' ? block.text : untitled}</p>;
      break;

    case 'image':
    case 'video': {
      const isVideo = block.type === 'video';
      const hasMedia = block.mediaUrl.trim() !== '';
      body = (
        <>
          <div className={`wa-media${isVideo ? ' wa-media-video' : ''}`}>
            {hasMedia && src && !isVideo && <img className="wa-media-el" src={src} alt="" loading="lazy" />}
            {hasMedia && src && isVideo && (
              <video className="wa-media-el" src={src} muted playsInline preload="metadata" />
            )}
            {(!hasMedia || !src) && (
              <span className="wa-media-placeholder">
                {isVideo ? <VideoIcon size={16} /> : <ImageIcon size={16} />}
              </span>
            )}
            {isVideo && (
              <span className="wa-media-play">
                <Play size={14} fill="currentColor" />
              </span>
            )}
          </div>
          {block.caption.trim() !== '' && <p className="wa-caption">{block.caption}</p>}
        </>
      );
      break;
    }

    case 'file':
      body = (
        <>
          <span className="wa-document">
            <FileText size={16} aria-hidden="true" />
            <span className="wa-document-name">{block.filename.trim() !== '' ? block.filename : untitled}</span>
          </span>
          {block.caption.trim() !== '' && <p className="wa-caption">{block.caption}</p>}
        </>
      );
      break;

    case 'poll':
      body = (
        <>
          <p className="wa-text">{block.question.trim() !== '' ? block.question : untitled}</p>
          <div className="wa-options">
            {block.options.map((option, index) => (
              <span className="wa-option" key={`${block.id}-option-${index}`}>
                <ListChecks size={14} aria-hidden="true" />
                <span className="wa-option-label">{option.trim() !== '' ? option : untitled}</span>
              </span>
            ))}
          </div>
        </>
      );
      break;

    case 'yesno':
      body = (
        <>
          <p className="wa-text">{block.question.trim() !== '' ? block.question : untitled}</p>
          <div className="wa-options">
            <span className="wa-option wa-option-btn">
              <span className="wa-option-label">{block.yesLabel.trim() !== '' ? block.yesLabel : untitled}</span>
            </span>
            <span className="wa-option wa-option-btn">
              <span className="wa-option-label">{block.noLabel.trim() !== '' ? block.noLabel : untitled}</span>
            </span>
          </div>
        </>
      );
      break;
  }

  return (
    <div className="wa-chat" aria-hidden="true">
      <div className="wa-bubble wa-bubble-outgoing">
        {body}
        <span className="wa-meta">
          <CheckCheck size={14} />
        </span>
        <svg className="wa-tail" viewBox="0 0 8 13" width="8" height="13" aria-hidden="true">
          <path
            opacity="0.13"
            className="wa-tail-shadow"
            d="M5.188 12H0V0.807l6.467 8.625C7.526 10.844 6.958 12 5.188 12z"
          />
          <path className="wa-tail-fill" d="M5.188 13H0V1.807l6.467 8.625C7.526 11.844 6.958 13 5.188 13z" />
        </svg>
      </div>
    </div>
  );
}
