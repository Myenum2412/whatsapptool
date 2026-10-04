// Baileys stopped decrypting poll votes itself (rc14 comments the call out), so the adapter does it.
// The risk is the key: it is derived from the creator's and voter's jids exactly as the VOTER's phone
// wrote them, and since lid addressing that can be a phone jid or a lid for either party. These tests
// seal votes with the real scheme — Baileys' key derivation and AES-256-GCM, ported verbatim to node
// crypto because jest cannot load the ESM-only library — so a wrong jid pair genuinely fails GCM
// authentication instead of being waved through by a stub. Only the protobuf wrapper is stood in for.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { WAMessage, WAMessageKey, proto } from '@whiskeysockets/baileys';
import { decodeBaileysPollVote, pollOptionNames, type PollVoteLib } from './baileys-poll-votes';

const hmac = (data: Buffer, key: Buffer): Buffer => createHmac('sha256', key).update(data).digest();
const sha256 = (text: string): Buffer => createHash('sha256').update(Buffer.from(text)).digest();

/** Baileys' derivation: decryptPollVote in Utils/process-message.js. */
function voteKey(pollEncKey: Buffer, pollMsgId: string, creator: string, voter: string): Buffer {
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(creator),
    Buffer.from(voter),
    Buffer.from('Poll Vote'),
    Buffer.from([1]),
  ]);
  return hmac(sign, hmac(pollEncKey, Buffer.alloc(32)));
}

/** What the voter's phone sends: the chosen options' SHA-256, sealed with AES-GCM (tag suffixed). */
function sealVote(
  options: string[],
  ctx: { pollEncKey: Buffer; pollMsgId: string; creator: string; voter: string },
): proto.Message.IPollEncValue {
  const encIv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', voteKey(ctx.pollEncKey, ctx.pollMsgId, ctx.creator, ctx.voter), encIv);
  cipher.setAAD(Buffer.from(`${ctx.pollMsgId}\u0000${ctx.voter}`));
  // Stand-in for PollVoteMessage.encode: the hashes, hex-joined.
  const plain = Buffer.from(options.map(o => sha256(o).toString('hex')).join(','));
  return { encPayload: Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]), encIv };
}

const lib: PollVoteLib = {
  jidNormalizedUser: (jid: string | undefined) => {
    if (!jid) return '';
    const [user, server] = jid.split('@');
    return `${user.split(':')[0]}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
  },
  decryptPollVote: ((
    { encPayload, encIv }: proto.Message.IPollEncValue,
    {
      pollCreatorJid,
      pollMsgId,
      pollEncKey,
      voterJid,
    }: { pollCreatorJid: string; pollMsgId: string; pollEncKey: Uint8Array; voterJid: string },
  ) => {
    const payload = Buffer.from(encPayload!);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      voteKey(Buffer.from(pollEncKey), pollMsgId, pollCreatorJid, voterJid),
      Buffer.from(encIv!),
    );
    decipher.setAAD(Buffer.from(`${pollMsgId}\u0000${voterJid}`));
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    const plain = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
    const text = plain.toString();
    return { selectedOptions: text ? text.split(',').map(h => Buffer.from(h, 'hex')) : [] };
  }) as unknown as PollVoteLib['decryptPollVote'],
};

const ME_PN = '919000000000@s.whatsapp.net';
const ME_LID = '11111111111@lid';
const pollEncKey = randomBytes(32);
const options = ['Interested', 'Not interested', 'Call me'];

const creation = (version: 'pollCreationMessage' | 'pollCreationMessageV3' = 'pollCreationMessage'): WAMessage => ({
  key: { id: 'POLL1', fromMe: true, remoteJid: '919876543210@s.whatsapp.net' },
  message: {
    messageContextInfo: { messageSecret: pollEncKey },
    [version]: { name: 'Are you interested?', options: options.map(optionName => ({ optionName })) },
  },
});

describe('decodeBaileysPollVote', () => {
  it('decodes a vote sealed with the phone jids, mapping hashes back to option names and positions', () => {
    const vote = sealVote(['Not interested'], {
      pollEncKey,
      pollMsgId: 'POLL1',
      creator: ME_PN,
      voter: '919876543210@s.whatsapp.net',
    });
    const decoded = decodeBaileysPollVote({
      lib,
      update: { vote },
      voteKey: { id: 'V1', fromMe: false, remoteJid: '919876543210@s.whatsapp.net' },
      creation: creation(),
      selfJids: [ME_PN, ME_LID],
    });
    expect(decoded).toEqual({ selectedOptions: ['Not interested'], selectedIndexes: [1] });
  });

  it('finds the key when the voter’s phone addressed both parties by lid', () => {
    const vote = sealVote(['Interested', 'Call me'], {
      pollEncKey,
      pollMsgId: 'POLL1',
      creator: ME_LID,
      voter: '22222222222@lid',
    });
    const key = {
      id: 'V2',
      fromMe: false,
      remoteJid: '919876543210@s.whatsapp.net',
      remoteJidAlt: '22222222222@lid',
    } as WAMessageKey;
    expect(
      decodeBaileysPollVote({
        lib,
        update: { vote },
        voteKey: key,
        creation: creation('pollCreationMessageV3'),
        selfJids: [ME_PN, ME_LID],
      }),
    ).toEqual({ selectedOptions: ['Interested', 'Call me'], selectedIndexes: [0, 2] });
  });

  it('reads a withdrawn vote as an empty selection', () => {
    const vote = sealVote([], { pollEncKey, pollMsgId: 'POLL1', creator: ME_PN, voter: '919876543210@s.whatsapp.net' });
    expect(
      decodeBaileysPollVote({
        lib,
        update: { vote },
        voteKey: { id: 'V3', remoteJid: '919876543210@s.whatsapp.net' },
        creation: creation(),
        selfJids: [ME_PN],
      }),
    ).toEqual({ selectedOptions: [], selectedIndexes: [] });
  });

  it('returns null rather than guessing when no identity pair authenticates or the poll has no secret', () => {
    const vote = sealVote(['Interested'], { pollEncKey, pollMsgId: 'POLL1', creator: ME_PN, voter: '33333333333@lid' });
    // The voter jid the phone used is not among the key's candidates.
    expect(
      decodeBaileysPollVote({
        lib,
        update: { vote },
        voteKey: { id: 'V4', remoteJid: '919876543210@s.whatsapp.net' },
        creation: creation(),
        selfJids: [ME_PN],
      }),
    ).toBeNull();
    const noSecret = { ...creation(), message: { pollCreationMessage: { name: 'x', options: [] } } } as WAMessage;
    expect(
      decodeBaileysPollVote({ lib, update: { vote }, voteKey: { id: 'V5' }, creation: noSecret, selfJids: [ME_PN] }),
    ).toBeNull();
  });

  it('reads option names from every poll creation version', () => {
    expect(pollOptionNames(creation('pollCreationMessageV3'))).toEqual(options);
  });
});
