import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageService } from './usage.service';
import { UsageEvent } from './entities/usage-event.entity';
import { Session } from '../session/entities/session.entity';
import { TenancyModule } from '../tenancy/tenancy.module';

/**
 * Ledger writer plus the read helpers the quota work will need.
 *
 * Imports `Session` on the data connection because attribution reads `sessions.organizationId`. That
 * is a deliberate read of another module's entity rather than a repository import cycle: SessionModule
 * imports this module, so depending on SessionModule here would be circular. Reading the column is
 * also narrower than depending on the service — the meter needs the stored organization, not any of
 * SessionService's behaviour.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UsageEvent, Session], 'data'), TenancyModule],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
