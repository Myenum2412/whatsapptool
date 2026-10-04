import {
  Validate,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { FLOW_BLOCK_TYPES, FLOW_LIMITS, PlanFlowBlock } from './flow-block-types';

/**
 * Shape validation for a plan's `flow` payload.
 *
 * SCOPE, deliberately: this checks structure, type and length - NOT completeness. A poll with one
 * blank option, or a text block with an empty body, is a legitimate payload here, because the
 * dashboard autosaves the flow as the operator types (the editor marks such a block "incomplete" as a
 * hint, and deliberately does not block saving). Enforcing completeness server-side would turn every
 * keystroke pause into a 422 and the editor into a form that can only be saved in a valid state.
 * Whether a flow is *sendable* is a separate question, answered when a plan is actually dispatched.
 *
 * The function is exported separately from the constraint so it can be unit-tested directly, and so
 * the service can reuse it if a future code path needs the same verdict outside the DTO layer.
 */

/** Returns one problem per defect; an empty array means the payload is acceptable. */
export function flowBlockProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return ['must be an array of flow blocks'];
  if (value.length > FLOW_LIMITS.blocks) return [`must hold at most ${FLOW_LIMITS.blocks} blocks`];

  const problems: string[] = [];
  const seenIds = new Set<string>();

  value.forEach((block, index) => {
    for (const problem of blockProblems(block, index)) problems.push(problem);

    // Duplicate ids would make a block unaddressable for the editor's autosave, so they are a
    // structural defect rather than a cosmetic one.
    if (isRecord(block) && typeof block.id === 'string') {
      if (seenIds.has(block.id)) problems.push(`blocks[${index}].id duplicates an earlier block`);
      seenIds.add(block.id);
    }
  });

  return problems;
}

function blockProblems(block: unknown, index: number): string[] {
  const at = (field: string): string => `blocks[${index}].${field}`;

  if (!isRecord(block)) return [`blocks[${index}] must be an object`];

  const problems: string[] = [];
  const { id, type } = block;

  if (typeof id !== 'string' || id === '') problems.push(`${at('id')} must be a non-empty string`);
  else if (id.length > FLOW_LIMITS.id) problems.push(`${at('id')} must be at most ${FLOW_LIMITS.id} characters`);

  if (typeof type !== 'string' || !isFlowBlockType(type)) {
    return [...problems, `${at('type')} must be one of ${FLOW_BLOCK_TYPES.join(', ')}`];
  }

  switch (type) {
    case 'text':
      problems.push(...stringProblems(block.text, at('text'), FLOW_LIMITS.text));
      break;
    case 'image':
    case 'video':
      problems.push(...stringProblems(block.mediaUrl, at('mediaUrl'), FLOW_LIMITS.mediaUrl));
      problems.push(...stringProblems(block.caption, at('caption'), FLOW_LIMITS.caption));
      break;
    case 'file':
      problems.push(...stringProblems(block.mediaUrl, at('mediaUrl'), FLOW_LIMITS.mediaUrl));
      problems.push(...stringProblems(block.filename, at('filename'), FLOW_LIMITS.filename));
      problems.push(...stringProblems(block.caption, at('caption'), FLOW_LIMITS.caption));
      break;
    case 'poll':
      problems.push(...stringProblems(block.question, at('question'), FLOW_LIMITS.question));
      problems.push(...pollOptionsProblems(block.options, at('options')));
      break;
    case 'yesno':
      problems.push(...stringProblems(block.question, at('question'), FLOW_LIMITS.question));
      problems.push(...stringProblems(block.yesLabel, at('yesLabel'), FLOW_LIMITS.label));
      problems.push(...stringProblems(block.noLabel, at('noLabel'), FLOW_LIMITS.label));
      break;
  }

  return problems;
}

function pollOptionsProblems(options: unknown, at: string): string[] {
  if (!Array.isArray(options)) return [`${at} must be an array of strings`];
  if (options.length > FLOW_LIMITS.options) return [`${at} must hold at most ${FLOW_LIMITS.options} options`];
  // Blank entries are allowed (an operator mid-typing), but a non-string is a real payload error.
  return options
    .map((option, index) =>
      typeof option === 'string' && option.length <= FLOW_LIMITS.option
        ? null
        : `${at}[${index}] must be a string of at most ${FLOW_LIMITS.option} characters`,
    )
    .filter((problem): problem is string => problem !== null);
}

/** Empty is accepted: the field has to exist and be a string, but may legitimately be blank. */
function stringProblems(value: unknown, at: string, max: number): string[] {
  if (typeof value !== 'string') return [`${at} must be a string`];
  return value.length > max ? [`${at} must be at most ${max} characters`] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFlowBlockType(value: string): value is PlanFlowBlock['type'] {
  return (FLOW_BLOCK_TYPES as readonly string[]).includes(value);
}

@ValidatorConstraint({ name: 'isFlowBlocks', async: false })
export class IsFlowBlocksConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return flowBlockProblems(value).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    const problems = flowBlockProblems(args.value);
    return problems.length ? `flow is invalid: ${problems.join('; ')}` : 'flow must be an array of flow blocks';
  }
}

/**
 * `@Validate` wrapped in a factory so the constraint does not have to be registered as a provider:
 * the global ValidationPipe instantiates the constraint class itself, and this keeps the DTO
 * decorator to a single token.
 */
export function IsFlowBlocks(validationOptions?: ValidationOptions): PropertyDecorator {
  return Validate(IsFlowBlocksConstraint, validationOptions as ValidationOptions);
}
