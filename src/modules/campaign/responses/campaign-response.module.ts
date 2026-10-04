import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from '../entities/campaign.entity';
import { CampaignRecipient } from '../entities/campaign-recipient.entity';
import { CampaignResponseService } from './campaign-response.service';

/**
 * Deliberately imports no feature module: SessionModule imports this one (the projector hands it
 * inbound replies and poll votes), and CampaignModule imports it too, so either importing anything
 * that leads back to SessionModule would make a cycle. Mirrors AutomationModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Campaign, CampaignRecipient], 'data')],
  providers: [CampaignResponseService],
  exports: [CampaignResponseService],
})
export class CampaignResponseModule {}
