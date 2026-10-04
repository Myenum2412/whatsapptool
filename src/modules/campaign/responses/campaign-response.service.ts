import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { CampaignRecipient, CampaignRecipientStatus } from '../entities/campaign-recipient.entity';
import { LidMappingStoreService } from '../../../engine/identity/lid-mapping-store.service';
import type { IncomingMessage, PollVoteEvent } from '../../../engine/interfaces/whatsapp-engine.interface';
import { matchReply, resolveVote } from './campaign-response-matching';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/** How long after a campaign message a typed reply can still count as an answer to it. */
export const REPLY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// A session with no campaign asking for responses skips the per-message lookup; the answer is
// re-checked this often, and CampaignService clears it the moment a campaign starts.
const ACTIVE_CACHE_TTL_MS = 60_000;

/**
 * Records recipients' answers to campaign response options: poll votes (matched on the poll's
 * message id) and typed replies that name an option (matched on the chat, against the latest
 * campaign message with options sent there). The latest answer wins.
 *
 * Fed by the session layer, so — like AutomationRulesService — this module imports no feature
 * module, and every path is fail-open: nothing here may break the receive path.
 */
@Injectable()
export class CampaignResponseService {
  private readonly logger = new Logger(CampaignResponseService.name);
  private readonly activeSessions = new Map<string, { active: boolean; at: number }>();

  constructor(
    @InjectRepository(Campaign, 'data')
    private readonly campaignRepository: Repository<Campaign>,
    @InjectRepository(CampaignRecipient, 'data')
    private readonly recipientRepository: Repository<CampaignRecipient>,
    @Optional()
    private readonly lidMappings?: LidMappingStoreService,
  ) {}

  /** Forget the cached "no campaign asks for responses here" for a session (a campaign just started). */
  invalidate(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  async recordPollVote(sessionId: string, vote: PollVoteEvent): Promise<boolean> {
    if (!vote.pollMessageId) return false;
    const row = await this.recipientRepository
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.campaign', 'c')
      .where('r.responseMessageId = :id', { id: vote.pollMessageId })
      .andWhere('c.sessionId = :sessionId', { sessionId })
      .andWhere('c.responseOptions IS NOT NULL')
      .getOne();
    if (!row?.campaign.responseOptions) return false;
    // The account's own vote on its own poll (from the linked phone) is not the recipient's answer.
    if (vote.voterId.endsWith('@c.us') && row.chatId?.endsWith('@c.us') && vote.voterId !== row.chatId) {
      return false;
    }
    const response = resolveVote(vote, row.campaign.responseOptions);
    await this.save(row.id, response.length > 0 ? response : null, 'poll', vote.timestamp);
    return true;
  }

  async recordReply(sessionId: string, message: IncomingMessage): Promise<boolean> {
    if (message.fromMe || message.isGroup || !message.body?.trim() || !message.chatId) return false;
    if (!(await this.sessionAsksForResponses(sessionId))) return false;

    const chatIds = await this.chatIdCandidates(message.chatId);
    const row = await this.recipientRepository
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.campaign', 'c')
      .where('c.sessionId = :sessionId', { sessionId })
      .andWhere('c.responseOptions IS NOT NULL')
      .andWhere('r.chatId IN (:...chatIds)', { chatIds })
      .andWhere('r.status = :sent', { sent: CampaignRecipientStatus.SENT })
      // Same serialisation the column is written with (ISO text on SQLite), so the comparison is like for like.
      .andWhere('r.sentAt >= :since', { since: DateTransformer.to(new Date(Date.now() - REPLY_WINDOW_MS)) as string })
      .orderBy('r.sentAt', 'DESC')
      .getOne();
    const options = row?.campaign.responseOptions;
    if (!row || !options) return false;
    const response = matchReply(message.body, options, row.campaign.responseMultiple);
    if (!response) return false;
    await this.save(row.id, response, 'reply', message.timestamp);
    return true;
  }

  private async save(id: string, response: string[] | null, via: 'poll' | 'reply', timestamp: number): Promise<void> {
    const at = timestamp > 0 ? new Date(timestamp * 1000) : new Date();
    await this.recipientRepository.update({ id }, { response, responseVia: via, respondedAt: at });
    this.logger.debug(`Campaign recipient ${id} answered via ${via}`);
  }

  private async sessionAsksForResponses(sessionId: string): Promise<boolean> {
    const cached = this.activeSessions.get(sessionId);
    if (cached && Date.now() - cached.at < ACTIVE_CACHE_TTL_MS) return cached.active;
    const active = await this.campaignRepository
      .createQueryBuilder('c')
      .where('c.sessionId = :sessionId', { sessionId })
      .andWhere('c.responseOptions IS NOT NULL')
      .andWhere('c.status != :draft', { draft: CampaignStatus.DRAFT })
      .getExists();
    this.activeSessions.set(sessionId, { active, at: Date.now() });
    return active;
  }

  /** The chat as stored on campaign rows (`<phone>@c.us`), also when the reply came from a lid. */
  private async chatIdCandidates(chatId: string): Promise<string[]> {
    const ids = [chatId];
    if (chatId.endsWith('@lid') && this.lidMappings) {
      const phone = await this.lidMappings.findPhoneForLid(chatId).catch(() => null);
      if (phone) ids.push(`${phone.replace(/@.*$/, '')}@c.us`);
    }
    return ids;
  }
}
