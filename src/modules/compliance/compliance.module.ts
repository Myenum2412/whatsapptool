import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SuppressedContact } from './entities/suppressed-contact.entity';
import { ContactConsent } from './entities/contact-consent.entity';
import { Session } from '../session/entities/session.entity';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SuppressionService } from './suppression.service';
import { ConsentLedgerService } from './consent-ledger.service';
import { QuietHoursService } from './quiet-hours.service';
import { OutboundGuardService } from './outbound-guard.service';

/**
 * The three compliance controls, and the rules that feed them:
 *
 * - `SuppressionService` — current state, "do not contact this chat" (the send-path gate).
 * - `ConsentLedgerService` — append-only history of every grant and withdrawal.
 * - `QuietHoursService` — the time-of-day policy.
 *
 * Imported by MessageModule for the send-path check, and by SessionModule for inbound opt-out
 * detection, so all three live in their own module rather than in whichever of those happens to boot
 * first — a registry that only exists because some other module imported it is a registry whose
 * absence is silent.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SuppressedContact, ContactConsent, Session], 'data'),
    // For the per-organization settings lookup that makes quiet hours reachable from the send path. The
    // data -> main direction is deliberate and one-way; see TenancyService.settingsForSession.
    TenancyModule,
  ],
  providers: [SuppressionService, ConsentLedgerService, QuietHoursService, OutboundGuardService],
  exports: [SuppressionService, ConsentLedgerService, QuietHoursService, OutboundGuardService, TypeOrmModule],
})
export class ComplianceModule {}
