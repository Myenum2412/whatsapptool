import {
  matchReply,
  normalizeAnswer,
  replyOptionsBlock,
  resolveVote,
  validateResponseOptions,
} from './campaign-response-matching';

const yesNo = ['Interested', 'Not interested'];

describe('matchReply', () => {
  it.each([
    ['1', ['Interested']],
    ['2', ['Not interested']],
    [' #2. ', ['Not interested']],
    ['2️⃣', ['Not interested']],
    ['interested', ['Interested']],
    ['NOT INTERESTED!', ['Not interested']],
    ['"Not  interested"', ['Not interested']],
  ])('reads %p as an answer', (body, expected) => {
    expect(matchReply(body, yesNo, false)).toEqual(expected);
  });

  it.each(['3', '0', 'maybe later', 'I am interested', 'can you call me?', '1, 2', ''])(
    'leaves %p alone (not an answer)',
    body => {
      expect(matchReply(body, yesNo, false)).toBeNull();
    },
  );

  it('reads a list of numbers when several answers are allowed, and refuses one out of range', () => {
    const options = ['Email', 'Phone', 'WhatsApp'];
    expect(matchReply('1, 3', options, true)).toEqual(['Email', 'WhatsApp']);
    expect(matchReply('3 and 1', options, true)).toEqual(['WhatsApp', 'Email']);
    expect(matchReply('1 1', options, true)).toEqual(['Email']);
    expect(matchReply('1, 4', options, true)).toBeNull();
  });

  it('works for non-Latin options', () => {
    expect(matchReply('हाँ', ['हाँ', 'नहीं'], false)).toEqual(['हाँ']);
  });
});

describe('resolveVote', () => {
  it('prefers names, falls back to positions, and reads an empty selection as withdrawn', () => {
    expect(resolveVote({ selectedOptions: ['Not interested'], selectedIndexes: [1] }, yesNo)).toEqual([
      'Not interested',
    ]);
    expect(resolveVote({ selectedOptions: [], selectedIndexes: [0] }, yesNo)).toEqual(['Interested']);
    expect(resolveVote({ selectedOptions: [] }, yesNo)).toEqual([]);
  });
});

describe('replyOptionsBlock / validateResponseOptions', () => {
  it('numbers the options under the question', () => {
    expect(replyOptionsBlock('Reply with a number:', ['Yes', 'No', 'Maybe'])).toBe(
      'Reply with a number:\n1. Yes\n2. No\n3. Maybe',
    );
    expect(replyOptionsBlock(null, ['Yes', 'No'])).toBe('1. Yes\n2. No');
  });

  it('enforces counts per style, distinct options, and no bare numbers in a numbered list', () => {
    expect(validateResponseOptions('poll', [' Yes ', 'No'])).toEqual(['Yes', 'No']);
    expect(validateResponseOptions('poll', ['Only one'])).toMatch(/2 to 12/);
    expect(
      validateResponseOptions(
        'poll',
        Array.from({ length: 13 }, (_, i) => `o${i}`),
      ),
    ).toMatch(/2 to 12/);
    expect(
      validateResponseOptions(
        'reply',
        Array.from({ length: 13 }, (_, i) => `o${i}`),
      ),
    ).toHaveLength(13);
    expect(validateResponseOptions('poll', ['Yes', 'yes!'])).toMatch(/listed twice/);
    expect(validateResponseOptions('poll', ['Yes', ' '])).toMatch(/empty/);
    expect(validateResponseOptions('reply', ['10', '20'])).toMatch(/cannot be just a number/);
  });

  it('normalizes answers for comparison', () => {
    expect(normalizeAnswer('  ¡Sí!  ')).toBe('sí');
  });
});
