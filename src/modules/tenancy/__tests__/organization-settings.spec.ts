import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { mergeOrganizationSettings, toSettingsResponse } from '../organization-settings';
import { UpdateOrganizationSettingsDto } from '../dto/organization-settings.dto';

/** Validate exactly as the global pipe does, so these assert the contract callers actually get. */
const PIPE_TRANSFORM = { enableImplicitConversion: true };
const parse = (payload: unknown): UpdateOrganizationSettingsDto =>
  plainToInstance(UpdateOrganizationSettingsDto, payload, PIPE_TRANSFORM);

const messages = (payload: unknown): string =>
  validateSync(parse(payload), { whitelist: true, forbidNonWhitelisted: true })
    // Children are where a nested rule lands: `quietHours`'s own constraints sit on
    // `children[0]`, so flattening only the top level reports nothing for any window field.
    .flatMap(e => [e, ...(e.children ?? [])])
    .flatMap(e => Object.values(e.constraints ?? {}))
    .join(' | ');

describe('mergeOrganizationSettings', () => {
  it('writes a window that was never set', () => {
    const merged = mergeOrganizationSettings(
      {},
      parse({ quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' } }),
    );

    expect(merged['quietHours']).toEqual({ start: '22:00', end: '07:00', timezone: 'UTC' });
  });

  it('accepts a null settings blob', () => {
    // The column is nullable, so this is the real first-write case rather than a defensive nicety.
    expect(
      mergeOrganizationSettings(null, parse({ quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' } })),
    ).toHaveProperty('quietHours');
  });

  describe('merges one level deep', () => {
    const stored = { quietHours: { start: '22:00', end: '07:00', timezone: 'Europe/Lisbon' } };

    it('keeps the times when only the flag is sent', () => {
      // The whole reason the merge is not a replace: turning quiet hours off and on again must not cost
      // the operator their window, and `{enabled: false}` carrying an empty window would.
      const merged = mergeOrganizationSettings(stored, parse({ quietHours: { enabled: false } }));

      expect(merged['quietHours']).toEqual({ start: '22:00', end: '07:00', timezone: 'Europe/Lisbon', enabled: false });
    });

    it('keeps the flag when only the times are sent', () => {
      const paused = { quietHours: { ...(stored.quietHours as object), enabled: false } };

      const merged = mergeOrganizationSettings(paused, parse({ quietHours: { start: '23:00' } }));

      expect(merged['quietHours']).toEqual(expect.objectContaining({ start: '23:00', end: '07:00', enabled: false }));
    });

    it('replaces a stored value rather than keeping both', () => {
      const merged = mergeOrganizationSettings(stored, parse({ quietHours: { timezone: 'Africa/Lagos' } }));

      expect(merged['quietHours']).toEqual(expect.objectContaining({ timezone: 'Africa/Lagos' }));
    });

    it('leaves the stored blob untouched', () => {
      // A merge that returns the same object reference would let the caller's PATCH mutate what the
      // caller believes it merely read.
      const stored = { quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' } };

      mergeOrganizationSettings(stored, parse({ quietHours: { start: '01:00' } }));

      expect(stored.quietHours.start).toBe('22:00');
    });
  });

  describe('preserves keys this API cannot name', () => {
    it('carries an unrelated top-level key through a write', () => {
      // `settings` is a blob shared with features that have not shipped. A typed replace would delete
      // the moment this DTO learned a key another feature already writes.
      const merged = mergeOrganizationSettings(
        { quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' }, retentionDays: 90 },
        parse({ quietHours: { enabled: true } }),
      );

      expect(merged['retentionDays']).toBe(90);
      expect(merged['quietHours']).toEqual(expect.objectContaining({ enabled: true }));
    });

    it('carries an unknown key inside the window too', () => {
      const merged = mergeOrganizationSettings(
        { quietHours: { start: '22:00', end: '07:00', timezone: 'UTC', futureFlag: 'keep' } },
        parse({ quietHours: { enabled: true } }),
      );

      expect(merged['quietHours']).toEqual(expect.objectContaining({ futureFlag: 'keep' }));
    });

    it('is a no-op for a patch naming nothing', () => {
      // Idempotent, like every other PATCH in the gateway: a form that submits an untouched form must
      // not need a special case.
      const stored = { quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' } };

      expect(mergeOrganizationSettings(stored, parse({}))).toEqual(stored);
    });
  });

  describe('validates the MERGED window, not the patch', () => {
    const stored = { quietHours: { start: '22:00', end: '07:00', timezone: 'Europe/Lisbon' } };

    it('accepts a patch carrying one field of a stored window', () => {
      // Rejected by a patch-level validator, and this is a form saving one field.
      expect(() => mergeOrganizationSettings(stored, parse({ quietHours: { start: '01:00' } }))).not.toThrow();
    });

    it('rejects a patch whose merge produces an equal-bound window', () => {
      // `start: '07:00'` against a stored `end: '07:00'` is the ambiguity `assertValidQuietHours` exists
      // to refuse: is that never, or always? Caught here rather than warned about on every send.
      expect(() => mergeOrganizationSettings(stored, parse({ quietHours: { start: '07:00' } }))).toThrow(/ambiguous/);
    });

    it('rejects a stored window left incomplete by the patch', () => {
      const partial = { quietHours: { start: '22:00' } };

      expect(() => mergeOrganizationSettings(partial, parse({ quietHours: { timezone: 'UTC' } }))).toThrow(
        /end must be HH:MM/,
      );
    });

    it('rejects a non-IANA zone', () => {
      // A fixed offset resolves fine in `Intl` and is silently wrong twice a year.
      expect(() => mergeOrganizationSettings(stored, parse({ quietHours: { timezone: '+01:00' } }))).toThrow(
        /IANA zone/,
      );
    });

    it('accepts 24:00 as an end of day', () => {
      const merged = mergeOrganizationSettings(stored, parse({ quietHours: { end: '24:00' } }));

      expect(merged['quietHours']).toEqual(expect.objectContaining({ end: '24:00' }));
    });

    it('rejects an out-of-range weekday', () => {
      expect(() => mergeOrganizationSettings(stored, parse({ quietHours: { weekdays: [0] } }))).toThrow(/integers 1-7/);
    });

    it('validates the window even while it is paused', () => {
      // The values are inert while disabled, so ignoring them looks harmless — until the operator turns
      // the window back on and it silently never applies, with only a warn-level line to explain it.
      const broken = { quietHours: { start: '22:00', end: 'nope', timezone: 'Europe/Lisbon', enabled: false } };

      expect(() => mergeOrganizationSettings(broken, parse({ quietHours: { enabled: false } }))).toThrow(
        /end must be HH:MM/,
      );
    });

    it('refuses a write on top of an already-broken stored window', () => {
      // Deliberate, and the alternative is worse: the write would answer "saved" and the audit row
      // would name it, while the policy the gateway enforces stays un-parseable and every send only
      // warns. Refusing here is the one moment an operator is actually looking at the value.
      const broken = { quietHours: { start: '99:99', end: '07:00', timezone: 'Europe/Lisbon' } };

      expect(() => mergeOrganizationSettings(broken, parse({ quietHours: { enabled: true } }))).toThrow(
        /start must be HH:MM/,
      );
    });

    it('surfaces the failure as a 400', () => {
      expect(() => mergeOrganizationSettings(stored, parse({ quietHours: { timezone: 'Mars/Olympus' } }))).toThrow(
        BadRequestException,
      );
    });
  });

  describe('input the pipe would otherwise coerce', () => {
    it('refuses a non-boolean word for enabled', () => {
      // `enableImplicitConversion` turns every non-empty string into `true`, so `"no"` would be stored
      // as "quiet hours ON" — the exact inverse of what the operator typed.
      expect(messages({ quietHours: { enabled: 'no' } })).not.toBe('');
    });

    it('still accepts the form-encoded spelling of a boolean', () => {
      // What the strict transform refuses is not the string, it is the lossy coercion. A form that posts
      // `"false"` means false, and `@ToStrictBoolean` exists to keep that working.
      expect(messages({ quietHours: { enabled: 'false' } })).toBe('');
      expect(parse({ quietHours: { enabled: 'false' } }).quietHours?.enabled).toBe(false);
    });

    it('refuses an unknown key', () => {
      expect(messages({ quietHours: { star: '22:00' } })).toMatch(/star/);
    });

    it('refuses a non-string exemption list entry', () => {
      expect(messages({ quietHours: { exemptChatIds: [42] } })).toMatch(/exemptChatIds/);
    });

    it('accepts a well-formed payload', () => {
      expect(
        messages({
          quietHours: {
            enabled: true,
            start: '22:00',
            end: '07:00',
            timezone: 'Europe/Lisbon',
            weekdays: [1, 2, 3],
            exemptChatIds: ['5511999999999@s.whatsapp.net'],
          },
        }),
      ).toBe('');
    });
  });
});

describe('toSettingsResponse', () => {
  it('names the organization it belongs to', () => {
    expect(toSettingsResponse('org-1', null)).toEqual({ organizationId: 'org-1' });
  });

  it('omits quietHours when none was ever configured', () => {
    // Absent is not `{enabled: false}`: the first says no policy was set, the second an operator paused
    // one that exists, and a form that cannot tell them apart offers to "save" a policy that is absent.
    expect(toSettingsResponse('org-1', { retentionDays: 90 })).toEqual({ organizationId: 'org-1' });
  });

  it('returns the stored window', () => {
    const window = { start: '22:00', end: '07:00', timezone: 'UTC' };

    expect(toSettingsResponse('org-1', { quietHours: window })).toEqual({
      organizationId: 'org-1',
      quietHours: window,
    });
  });

  it('omits a quietHours key that is not an object', () => {
    // A hand-edited row can hold anything. Echoing a string here would publish it as a "window" and
    // leave the form to render `undefined` into every field it thinks it owns.
    expect(toSettingsResponse('org-1', { quietHours: '22:00-07:00' })).toEqual({ organizationId: 'org-1' });
  });
});
