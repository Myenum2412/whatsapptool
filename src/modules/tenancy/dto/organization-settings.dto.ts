import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

/**
 * The quiet-hours window an organization stores under `settings.quietHours`.
 *
 * This is the STORED shape, not the resolved one: `QuietHoursWindow` (minutes-of-day, compiled) is
 * derived from it at send time. Keeping the DTO on the stored shape is what lets an operator save
 * `22:00` as `22:00` instead of as `1320`, so the value in the database stays readable and reviewable.
 *
 * Deliberately thin validation. `start`, `end`, `timezone` and `weekdays` carry NO `@Is*`
 * constraint here even though they obviously have a format, because `assertValidQuietHours` is the
 * authority on those four and duplicating its rules as decorators would give two places to disagree
 * — most visibly on `24:00`, which is valid as a window end and would need a regex nobody would think
 * to write. Those four are validated on the MERGED window instead (see `mergeOrganizationSettings`),
 * which is the only place a complete window exists: a PATCH carrying `{start}` alone is not
 * independently valid or invalid.
 */
export class QuietHoursSettingsDto {
  @ApiPropertyOptional({
    description:
      'Whether the window is in force. Omit it and a complete window still applies — the field exists ' +
      'to turn one off without deleting it, so an operator can pause a policy and restore it exactly.',
    example: true,
    type: Boolean,
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Local time the quiet window opens, inclusive, `HH:MM`. `24:00` is accepted as end-of-day.',
    example: '22:00',
    type: String,
  })
  @IsOptional()
  start?: string;

  @ApiPropertyOptional({
    description: 'Local time the quiet window closes, exclusive, `HH:MM`. `24:00` is accepted as end-of-day.',
    example: '07:00',
    type: String,
  })
  @IsOptional()
  end?: string;

  @ApiPropertyOptional({
    description:
      'IANA zone the window is stated in, e.g. `Europe/Lisbon`. A fixed UTC offset is refused: it cannot ' +
      'follow DST, so the window would drift by an hour twice a year.',
    example: 'Europe/Lisbon',
    type: String,
  })
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({
    description:
      'ISO weekdays the window applies on, Monday = 1 … Sunday = 7. Omit for every day; send an empty ' +
      'array only to clear a stored list back to "every day".',
    example: [1, 2, 3, 4, 5],
    type: [Number],
  })
  @IsOptional()
  weekdays?: number[];

  @ApiPropertyOptional({
    description:
      'Chats exempt from the window entirely — an incident number, a personal line an operator is ' +
      'willing to reach at 03:00. Matched on the same address forms as suppression.',
    example: ['5511999999999@s.whatsapp.net'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  exemptChatIds?: string[];
}

/**
 * PATCH body for `/organizations/settings`.
 *
 * **Merge, not replace.** `Organization.settings` is a JSON blob shared with features that have not
 * shipped yet, and a typed PUT cannot express a key it does not know about — worse, the global
 * validation pipe runs with `forbidNonWhitelisted`, so a client holding such a key could not send it
 * back at all, and a replace would delete it server-side the moment a future field was added. Merging
 * means adding a key to this API cannot take any other one with it.
 *
 * The merge is one level deep for `quietHours`: sending `{enabled: false}` must not also erase the
 * window that field is a flag for, or turning quiet hours off and on again would cost the operator
 * their times.
 */
export class UpdateOrganizationSettingsDto {
  @ApiPropertyOptional({
    description:
      'Quiet-hours policy. Merged into the stored window key by key; an absent key is left unchanged. ' +
      'Send `{ enabled: false }` to pause a configured window without deleting it.',
    type: QuietHoursSettingsDto,
  })
  // @Type is what makes the nested rules exist at all: without it class-transformer leaves a plain
  // object and @ValidateNested finds no metadata on it, so `forbidNonWhitelisted` would not reach
  // INSIDE the window — `{"star": "22:00"}` would be accepted and then stored as an unknown key of a
  // compliance policy, which is precisely the kind of typo nobody notices until the window is wrong.
  @Type(() => QuietHoursSettingsDto)
  @ValidateNested()
  @IsOptional()
  quietHours?: QuietHoursSettingsDto;
}

/** What GET returns: the settings this gateway knows how to interpret, for the organization named. */
export class OrganizationSettingsResponseDto {
  @ApiProperty({
    description:
      'The organization these settings belong to. Equal to the seeded default on a single-tenant ' +
      'install, which is what every request resolves to while `MULTITENANCY_ENABLED` is off.',
    example: '00000000-0000-4000-8000-000000000001',
  })
  organizationId!: string;

  @ApiPropertyOptional({
    description:
      'The stored quiet-hours window, absent when no window has ever been configured. Absent is not the ' +
      'same as `{enabled: false}`: the first means no policy was ever set, the second an operator paused ' +
      'one that exists.',
    type: QuietHoursSettingsDto,
  })
  quietHours?: QuietHoursSettingsDto;
}
