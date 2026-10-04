// Multipart sends every field as a string, so the response options reach the DTO as a JSON array in
// one field, as the field repeated, or (from a JSON client) as an array. All three must validate to
// the same string array, and booleans must not read "false" as true.
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCampaignDto } from './campaign.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

const parse = async (fields: Record<string, unknown>) => {
  const dto = plainToInstance(
    CreateCampaignDto,
    { name: 'x', body: 'Hi', phoneColumn: 'Phone', ...fields },
    {
      enableImplicitConversion: true,
    },
  );
  return { dto, errors: await validate(dto, GLOBAL_VALIDATION_OPTIONS) };
};

describe('CreateCampaignDto response fields', () => {
  it.each([
    ['a JSON array in one field', '["Interested","Not interested"]'],
    ['the field repeated', ['Interested', 'Not interested']],
  ])('accepts options as %s', async (_label, value) => {
    const { dto, errors } = await parse({ responseOptions: value, responseMultiple: 'false', responseStyle: 'poll' });
    expect(errors).toEqual([]);
    expect(dto.responseOptions).toEqual(['Interested', 'Not interested']);
    expect(dto.responseMultiple).toBe(false);
  });

  it('rejects an unknown style and an over-long option', async () => {
    expect((await parse({ responseStyle: 'buttons' })).errors.map(e => e.property)).toEqual(['responseStyle']);
    expect((await parse({ responseOptions: ['x'.repeat(101), 'y'] })).errors.map(e => e.property)).toEqual([
      'responseOptions',
    ]);
  });
});
