import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreatePlanDto, UpdatePlanDto } from './plan.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

const TEXT_BLOCK = { id: 'b1', type: 'text', text: 'Hi' };
const LAYOUT = { positions: { b1: { x: 0, y: 0 } }, edges: [{ id: 'e1', from: 'b1', to: 'b2' }] };

describe('plan DTOs', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);
  const throughCreate = (value: object): Promise<unknown> =>
    pipe.transform(value, { type: 'body', metatype: CreatePlanDto });
  const throughUpdate = (value: object): Promise<unknown> =>
    pipe.transform(value, { type: 'body', metatype: UpdatePlanDto });

  /** The detailed constraint messages live in the response body, not in `error.message`. */
  const problemsOf = async (run: Promise<unknown>): Promise<string[]> => {
    try {
      await run;
      throw new Error('expected the pipe to reject');
    } catch (err) {
      const response = (err as BadRequestException).getResponse() as { message?: string[] };
      return response?.message ?? [];
    }
  };

  describe('CreatePlanDto', () => {
    it('accepts a title-only body, so the form can create a plan before its flow exists', async () => {
      await expect(throughCreate({ title: 'Welcome flow' })).resolves.toMatchObject({ title: 'Welcome flow' });
    });

    it('accepts an optional description and flow', async () => {
      await expect(throughCreate({ title: 't', description: 'd', flow: [TEXT_BLOCK] })).resolves.toMatchObject({
        description: 'd',
      });
    });

    // Guards the `@Type(() => Object)` annotation: with enableImplicitConversion and a union-typed
    // element, class-transformer used to rewrite every block to {}, so this request validated and
    // then persisted an empty flow.
    it('preserves the block objects through the transform', async () => {
      const out = (await throughCreate({ title: 't', flow: [TEXT_BLOCK] })) as { flow: unknown[] };
      expect(out.flow).toEqual([TEXT_BLOCK]);
    });

    it('rejects a missing or empty title', async () => {
      await expect(throughCreate({})).rejects.toBeInstanceOf(BadRequestException);
      await expect(throughCreate({ title: '' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a malformed flow with a 400 naming the offending block', async () => {
      const problems = await problemsOf(throughCreate({ title: 't', flow: [{ id: 'b1', type: 'sticker' }] }));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('flow is invalid');
      expect(problems[0]).toContain('blocks[0].type must be one of text, image, video, file, poll, yesno');
    });

    // Same reason as the flow `@Type` above: the map is a nested union-shaped object.
    it('preserves the mindmap objects through the transform', async () => {
      const out = (await throughCreate({ title: 't', mindmap: LAYOUT })) as { mindmap: unknown };
      expect(out.mindmap).toEqual(LAYOUT);
    });

    it('rejects a malformed mindmap with a 400 naming the problem', async () => {
      const problems = await problemsOf(throughCreate({ title: 't', mindmap: { positions: {}, edges: 'x' } }));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('mindmap is invalid');
      expect(problems[0]).toContain('edges must be an array');
    });
  });

  describe('UpdatePlanDto', () => {
    // title is a NOT NULL column: an explicit null that passed validation reached save() and 500'd.
    it('rejects an explicit null title', async () => {
      await expect(throughUpdate({ title: null })).rejects.toBeInstanceOf(BadRequestException);
    });

    // description is nullable and @IsOptional skips null as well as undefined, so an explicit null
    // reaches update() and clears the stored value. Pin the behaviour so table and DTO cannot drift.
    it('accepts an explicit null description, which clears the stored value', async () => {
      await expect(throughUpdate({ description: null })).resolves.toEqual({ description: null });
    });

    it('accepts the flow-only body the dashboard autosave sends', async () => {
      await expect(throughUpdate({ flow: [TEXT_BLOCK] })).resolves.toMatchObject({ flow: [TEXT_BLOCK] });
    });

    it('accepts an empty flow, which is how a plan is cleared', async () => {
      await expect(throughUpdate({ flow: [] })).resolves.toEqual({ flow: [] });
    });

    it('rejects an explicit null flow', async () => {
      await expect(throughUpdate({ flow: null })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a flow holding an unknown block type', async () => {
      await expect(throughUpdate({ flow: [{ id: 'b1', type: 'audio', url: 'x' }] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('accepts the mindmap-only body the dashboard map autosave sends', async () => {
      await expect(throughUpdate({ mindmap: LAYOUT })).resolves.toMatchObject({ mindmap: LAYOUT });
    });

    it('accepts an empty mindmap, which is how the layout is cleared', async () => {
      await expect(throughUpdate({ mindmap: { positions: {}, edges: [] } })).resolves.toEqual({
        mindmap: { positions: {}, edges: [] },
      });
    });

    it('rejects an explicit null mindmap', async () => {
      await expect(throughUpdate({ mindmap: null })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
