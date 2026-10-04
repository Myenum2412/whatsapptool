import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from './entities/campaign.entity';
import { CampaignRecipient } from './entities/campaign-recipient.entity';
import { CampaignAttachment } from './entities/campaign-attachment.entity';
import { Message } from '../message/entities/message.entity';
import { StorageModule } from '../../common/storage/storage.module';
import { CampaignService } from './campaign.service';
import { CampaignController } from './campaign.controller';
import { Session } from '../session/entities/session.entity';
import { MessageModule } from '../message/message.module';
import { SessionModule } from '../session/session.module';
import { TemplateModule } from '../template/template.module';
import { CampaignResponseModule } from './responses/campaign-response.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, CampaignRecipient, CampaignAttachment, Session, Message], 'data'),
    StorageModule,
    MessageModule,
    SessionModule,
    TemplateModule,
    CampaignResponseModule,
  ],
  controllers: [CampaignController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
