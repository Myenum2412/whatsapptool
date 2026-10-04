import { createHash } from 'node:crypto';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WAMessage, WAMessageKey, proto } from '@whiskeysockets/baileys';

/** The two library functions vote decryption needs, injectable so the decoding is unit-testable. */
export type PollVoteLib = Pick<typeof BaileysLib, 'decryptPollVote' | 'jidNormalizedUser'>;

export interface DecodedPollVote {
  selectedOptions: string[];
  selectedIndexes: number[];
}

/** The option names of a stored poll creation message, in poll order (all three proto versions). */
export function pollOptionNames(creation: WAMessage): string[] {
  const m = creation.message;
  const poll = m?.pollCreationMessage ?? m?.pollCreationMessageV2 ?? m?.pollCreationMessageV3;
  return (poll?.options ?? []).map(option => option.optionName ?? '');
}

const unique = (values: Array<string | null | undefined>): string[] => [
  ...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0)),
];

/**
 * Decrypt one `pollUpdateMessage` against the poll it votes on.
 *
 * A vote is AES-GCM sealed under a key derived from the poll's `messageSecret` AND the creator's and
 * voter's jids exactly as the voter's phone wrote them — and since WhatsApp's move to lid addressing
 * that may be either a phone jid or a lid for each party. Baileys used to do this itself and now
 * leaves it to the app (the call is commented out in rc14's process-message). Every candidate pair
 * is tried; GCM authentication rejects a wrong key outright, so a wrong guess can never decode as a
 * different vote. The decrypted vote names options by the SHA-256 of their text.
 *
 * Returns null when the poll carries no secret or no candidate decrypts.
 */
export function decodeBaileysPollVote(params: {
  lib: PollVoteLib;
  update: proto.Message.IPollUpdateMessage;
  voteKey: WAMessageKey;
  creation: WAMessage;
  /** This account's own jids (phone and lid), used when the account created the poll or voted. */
  selfJids: string[];
}): DecodedPollVote | null {
  const { lib, update, voteKey, creation, selfJids } = params;
  const pollEncKey = creation.message?.messageContextInfo?.messageSecret;
  const pollMsgId = creation.key?.id;
  if (!pollEncKey || !pollMsgId || !update.vote) return null;

  const norm = (jid: string | null | undefined): string | undefined => (jid ? lib.jidNormalizedUser(jid) : undefined);
  const creators =
    creation.key?.fromMe === true
      ? unique(selfJids.map(norm))
      : unique([norm(creation.key?.participant), norm(creation.key?.remoteJid)]);
  const voters =
    voteKey.fromMe === true
      ? unique(selfJids.map(norm))
      : unique([
          norm(voteKey.participant),
          norm(voteKey.participantAlt),
          norm(voteKey.participant ? undefined : voteKey.remoteJid),
          norm(voteKey.participant ? undefined : voteKey.remoteJidAlt),
        ]);

  for (const pollCreatorJid of creators) {
    for (const voterJid of voters) {
      let decrypted: proto.Message.PollVoteMessage;
      try {
        decrypted = lib.decryptPollVote(update.vote, { pollEncKey, pollCreatorJid, pollMsgId, voterJid });
      } catch {
        continue; // wrong identity pair: GCM tag mismatch
      }
      const names = pollOptionNames(creation);
      const hashes = names.map(name => createHash('sha256').update(Buffer.from(name)).digest());
      const selectedIndexes: number[] = [];
      for (const chosen of decrypted.selectedOptions ?? []) {
        const index = hashes.findIndex(hash => hash.equals(Buffer.from(chosen)));
        if (index !== -1) selectedIndexes.push(index);
      }
      return { selectedIndexes, selectedOptions: selectedIndexes.map(i => names[i]) };
    }
  }
  return null;
}
