import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageService } from './message.service';
import { MessageSendService } from './message-send.service';
import { BulkMessageService } from './bulk-message.service';
import { MessageTypeBackfillService } from './message-type-backfill.service';
import { PendingMessageReaperService } from './pending-message-reaper.service';
import { MessageRetentionService } from './message-retention.service';
import { MessageController } from './message.controller';
import { SessionModule } from '../session/session.module';
import { TemplateModule } from '../template/template.module';
import { ChatMediaModule } from '../chat-media/chat-media.module';
import { StorageModule } from '../../common/storage/storage.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { UsageModule } from '../usage/usage.module';
import { Message } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { SendPacingService } from './send-pacing.service';
import { MessageBatch } from './entities/message-batch.entity';
import { PLUGIN_MESSAGE_PORT } from '../../core/plugins/plugin-host-ports';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message, MessageBatch, Session], 'data'),
    SessionModule,
    TemplateModule,
    ChatMediaModule,
    StorageModule,
    UsageModule,
    // Suppression is enforced on the send path, so MessageModule both consults the registry
    // (MessageSendService/BulkMessageService) and feeds it (via SessionModule's inbound projector).
    ComplianceModule,
  ],
  controllers: [MessageController],
  providers: [
    MessageService,
    MessageSendService,
    BulkMessageService,
    MessageTypeBackfillService,
    PendingMessageReaperService,
    // Daily purge of message history + its archived media, off unless MESSAGE_RETENTION_DAYS > 0.
    // Needs StorageService, which StorageModule already provides to this module's importers and
    // which ChatMediaModule imports, so no new module dependency is introduced here.
    MessageRetentionService,
    SendPacingService,
    // Binds the core-owned plugin capability port to this module's service. The plugin runtime
    // resolves the token lazily via ModuleRef (PluginHostServices), which keeps its provider cycle
    // broken; this adapter is how core reaches the service without importing it.
    // An alias, not a factory, so lifecycle hooks are not dispatched twice on the same instance.
    { provide: PLUGIN_MESSAGE_PORT, useExisting: MessageService },
  ],
  exports: [MessageService, BulkMessageService, SendPacingService],
})
export class MessageModule {}
