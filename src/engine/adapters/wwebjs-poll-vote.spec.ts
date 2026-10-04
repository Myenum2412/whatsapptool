// whatsapp-web.js `vote_update` → neutral PollVoteEvent. The poll id must come out in the same
// serialized form the poll's send returned (`true_<chat>_<id>`), or a campaign cannot find the row
// the vote answers; and WA Web builds that renamed `_serialized` to `$1` (#747) must still map.
import { mapWwebjsPollVote } from './wwebjs-message-events';

describe('mapWwebjsPollVote', () => {
  it('maps the poll id, chat, voter, option names and positions', () => {
    expect(
      mapWwebjsPollVote({
        voter: { _serialized: '919876543210@c.us' },
        selectedOptions: [{ name: 'Not interested', localId: 1 }],
        interractedAtTs: 1_700_000_100_000,
        parentMsgKey: {
          _serialized: 'true_919876543210@c.us_3EB0ABC',
          remote: { _serialized: '919876543210@c.us' },
        },
      }),
    ).toEqual({
      pollMessageId: 'true_919876543210@c.us_3EB0ABC',
      chatId: '919876543210@c.us',
      voterId: '919876543210@c.us',
      selectedOptions: ['Not interested'],
      selectedIndexes: [1],
      timestamp: 1_700_000_100,
    });
  });

  it('reads `$1` ids and keeps positions when the poll left the page store and names are lost', () => {
    const event = mapWwebjsPollVote({
      voter: { $1: '11111111111@lid' },
      selectedOptions: [{ name: undefined, localId: 0 }],
      parentMsgKey: { $1: 'true_919876543210@c.us_3EB0DEF' },
    });
    expect(event).toMatchObject({
      pollMessageId: 'true_919876543210@c.us_3EB0DEF',
      chatId: '919876543210@c.us',
      voterId: '11111111111@lid',
      selectedOptions: [],
      selectedIndexes: [0],
    });
  });

  it('reports a withdrawn vote as an empty selection, and ignores a vote naming no poll', () => {
    expect(mapWwebjsPollVote({ selectedOptions: [], parentMsgKey: 'true_x@c.us_1' })).toMatchObject({
      selectedOptions: [],
      selectedIndexes: [],
    });
    expect(mapWwebjsPollVote({ selectedOptions: [] })).toBeNull();
  });
});
