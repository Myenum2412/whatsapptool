import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { isFlowBlockComplete } from '../../utils/plans';
import type { FlowBlock } from '../../types/plans';

/**
 * The one field a chart card edits in place, plus the one-line summary under it.
 *
 * A card is too small for a block's whole form — a poll has options, a document has a URL and a
 * caption — so exactly the field the block is *about* is editable on the card and the rest stays in
 * the side panel. Which field that is depends on the type: the message for a text block, the caption
 * for media, the file name for a document, the question for a poll or a yes/no. That keeps one rule
 * to learn instead of six, and every card still edits the thing it depicts.
 *
 * These are content edits, so they go out on the caller's debounced write; the structural actions
 * around them are immediate.
 */

/** The last path segment of a media URL, which is the stored file name on an uploaded plan file. */
function lastPathSegment(url: string): string {
  const trimmed = url.trim();
  const segment = trimmed.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
  return segment || trimmed;
}

export function NodeInlineField({ block, onChange }: { block: FlowBlock; onChange: (next: FlowBlock) => void }) {
  const { t } = useTranslation();
  const id = useId();
  // The node above is the drag surface, so a keystroke must not be read as the start of a drag.
  const swallow = (event: { stopPropagation: () => void }) => event.stopPropagation();

  switch (block.type) {
    case 'text':
      return (
        <textarea
          id={id}
          className="flow-map-node-input flow-map-node-input-text"
          aria-label={t('flow.blocks.field.text')}
          rows={2}
          value={block.text}
          placeholder={t('flow.blocks.field.textPlaceholder')}
          onPointerDown={swallow}
          onKeyDown={swallow}
          onChange={event => onChange({ ...block, text: event.target.value })}
        />
      );

    case 'image':
    case 'video':
      return (
        <input
          id={id}
          className="flow-map-node-input"
          type="text"
          aria-label={t('flow.blocks.field.caption')}
          value={block.caption}
          placeholder={t('flow.blocks.field.captionPlaceholder')}
          onPointerDown={swallow}
          onKeyDown={swallow}
          onChange={event => onChange({ ...block, caption: event.target.value })}
        />
      );

    case 'file':
      return (
        <input
          id={id}
          className="flow-map-node-input"
          type="text"
          aria-label={t('flow.blocks.field.filename')}
          value={block.filename}
          placeholder={t('flow.blocks.field.filenamePlaceholder')}
          onPointerDown={swallow}
          onKeyDown={swallow}
          onChange={event => onChange({ ...block, filename: event.target.value })}
        />
      );

    case 'poll':
    case 'yesno':
      return (
        <input
          id={id}
          className="flow-map-node-input"
          type="text"
          aria-label={t('flow.blocks.field.question')}
          value={block.question}
          placeholder={t('flow.blocks.field.questionPlaceholder')}
          onPointerDown={swallow}
          onKeyDown={swallow}
          onChange={event => onChange({ ...block, question: event.target.value })}
        />
      );
  }
}

/** What else the block carries, under the inline field: a file name, an option count, two labels. */
export function NodeSummary({ block }: { block: FlowBlock }) {
  const { t } = useTranslation();

  let summary = '';
  if (block.type === 'image' || block.type === 'video' || block.type === 'file') {
    summary = block.mediaUrl.trim() === '' ? '' : lastPathSegment(block.mediaUrl);
  } else if (block.type === 'poll') {
    summary = t('flow.map.optionCount', { count: block.options.filter(option => option.trim() !== '').length });
  } else if (block.type === 'yesno') {
    summary = [block.yesLabel, block.noLabel].filter(label => label.trim() !== '').join(' · ');
  }

  if (summary === '') {
    // An empty document or caption has nothing to add, so the line carries the one thing worth
    // knowing about the block instead: that it is not finished yet.
    return isFlowBlockComplete(block) ? null : (
      <span className="flow-map-node-summary flow-map-node-summary-incomplete">{t('flow.blocks.incomplete')}</span>
    );
  }
  return <span className="flow-map-node-summary">{summary}</span>;
}
