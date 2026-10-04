import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenancyService } from './tenancy.service';
import { Organization } from './entities/organization.entity';
import { User } from './entities/user.entity';
import { Membership } from './entities/membership.entity';
import { Session } from '../session/entities/session.entity';
import { OrganizationSettingsController } from './organization-settings.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Organization, User, Membership], 'main'),
    // Only for the one-column `sessions.organizationId` lookup behind `settingsForSession`. `Session` is
    // a DATA-connection entity; registering it here does not move the table, it registers the repository
    // so this module can read one column of it.
    TypeOrmModule.forFeature([Session], 'data'),
  ],
  controllers: [OrganizationSettingsController],
  providers: [TenancyService],
  exports: [TenancyService],
})
export class TenancyModule {}
