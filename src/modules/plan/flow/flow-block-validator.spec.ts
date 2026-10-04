import { flowBlockProblems, IsFlowBlocksConstraint } from './flow-block-validator';
import { FLOW_LIMITS } from './flow-block-types';

const VALID = [
  { id: 'b1', type: 'text', text: 'Hi' },
  { id: 'b2', type: 'image', mediaUrl: 'https://x/y.png', caption: '' },
  { id: 'b3', type: 'video', mediaUrl: 'https://x/y.mp4', caption: 'clip' },
  { id: 'b4', type: 'poll', question: 'Pick', options: ['a', 'b'] },
  { id: 'b5', type: 'yesno', question: 'Proceed?', yesLabel: 'Yes', noLabel: 'No' },
];

describe('flowBlockProblems', () => {
  it('accepts one block of every type', () => {
    expect(flowBlockProblems(VALID)).toEqual([]);
  });

  it('accepts an empty flow', () => {
    expect(flowBlockProblems([])).toEqual([]);
  });

  it('rejects a non-array', () => {
    expect(flowBlockProblems({ nope: true })).toEqual(['must be an array of flow blocks']);
  });

  it('rejects a flow longer than the block ceiling', () => {
    const many = Array.from({ length: FLOW_LIMITS.blocks + 1 }, (_, i) => ({ id: `b${i}`, type: 'text', text: '' }));
    expect(flowBlockProblems(many)).toEqual([`must hold at most ${FLOW_LIMITS.blocks} blocks`]);
  });

  it('rejects an unknown block type and names the accepted set', () => {
    expect(flowBlockProblems([{ id: 'b1', type: 'sticker', text: 'x' }])).toEqual([
      'blocks[0].type must be one of text, image, video, file, poll, yesno',
    ]);
  });

  it('rejects a non-object block', () => {
    expect(flowBlockProblems(['nope'])).toEqual(['blocks[0] must be an object']);
  });

  it('rejects a missing or empty block id', () => {
    expect(flowBlockProblems([{ type: 'text', text: 'x' }])).toEqual(['blocks[0].id must be a non-empty string']);
    expect(flowBlockProblems([{ id: '', type: 'text', text: 'x' }])).toEqual([
      'blocks[0].id must be a non-empty string',
    ]);
  });

  it('rejects a duplicate block id, which would make the block unaddressable', () => {
    const problems = flowBlockProblems([
      { id: 'same', type: 'text', text: 'a' },
      { id: 'same', type: 'text', text: 'b' },
    ]);
    expect(problems).toContain('blocks[1].id duplicates an earlier block');
  });

  describe('incomplete content is allowed (the editor autosaves as you type)', () => {
    it('accepts a text block with an empty body', () => {
      expect(flowBlockProblems([{ id: 'b1', type: 'text', text: '' }])).toEqual([]);
    });

    it('accepts a poll whose options are still blank', () => {
      expect(flowBlockProblems([{ id: 'b1', type: 'poll', question: '', options: ['', ''] }])).toEqual([]);
    });

    it('accepts a yes/no block with blank labels', () => {
      expect(flowBlockProblems([{ id: 'b1', type: 'yesno', question: '', yesLabel: '', noLabel: '' }])).toEqual([]);
    });
  });

  describe('field types are still enforced', () => {
    it('rejects a numeric text body', () => {
      expect(flowBlockProblems([{ id: 'b1', type: 'text', text: 42 }])).toEqual(['blocks[0].text must be a string']);
    });

    it('rejects a missing mediaUrl on an image', () => {
      expect(flowBlockProblems([{ id: 'b1', type: 'image', caption: '' }])).toEqual([
        'blocks[0].mediaUrl must be a string',
      ]);
    });

    it('rejects non-array poll options', () => {
      expect(flowBlockProblems([{ id: 'b1', type: 'poll', question: 'q', options: 'a' }])).toEqual([
        'blocks[0].options must be an array of strings',
      ]);
    });

    it('rejects a non-string poll option and points at its index', () => {
      expect(flowBlockProblems([{ id: 'b1', type: 'poll', question: 'q', options: ['a', 7] }])).toEqual([
        `blocks[0].options[1] must be a string of at most ${FLOW_LIMITS.option} characters`,
      ]);
    });

    it('caps the option count', () => {
      const options = Array.from({ length: FLOW_LIMITS.options + 1 }, (_, i) => `o${i}`);
      expect(flowBlockProblems([{ id: 'b1', type: 'poll', question: 'q', options }])).toEqual([
        `blocks[0].options must hold at most ${FLOW_LIMITS.options} options`,
      ]);
    });

    it('caps each field length', () => {
      expect(flowBlockProblems([{ id: 'b1', type: 'text', text: 'x'.repeat(FLOW_LIMITS.text + 1) }])).toEqual([
        `blocks[0].text must be at most ${FLOW_LIMITS.text} characters`,
      ]);
      expect(
        flowBlockProblems([{ id: 'b1', type: 'yesno', question: 'q', yesLabel: 'y'.repeat(65), noLabel: 'n' }]),
      ).toEqual([`blocks[0].yesLabel must be at most ${FLOW_LIMITS.label} characters`]);
    });
  });
});

describe('IsFlowBlocksConstraint', () => {
  const constraint = new IsFlowBlocksConstraint();

  it('validates a well-formed flow', () => {
    expect(constraint.validate(VALID)).toBe(true);
  });

  it('rejects a malformed flow', () => {
    expect(constraint.validate([{ id: 'b1', type: 'text', text: 1 }])).toBe(false);
  });

  it('surfaces the concrete problems in the validation message', () => {
    const message = constraint.defaultMessage({ value: [{ id: '', type: 'text', text: '' }] } as never);
    expect(message).toContain('blocks[0].id must be a non-empty string');
  });

  it('falls back to a shape message when the value reports no problems', () => {
    expect(constraint.defaultMessage({ value: VALID } as never)).toBe('flow must be an array of flow blocks');
  });
});
