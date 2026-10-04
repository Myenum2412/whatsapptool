import {
  Validate,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { FLOW_LIMITS } from './flow-block-types';
import { MIND_MAP_LIMITS } from './mind-map-types';

/**
 * Shape validation for a plan's `mindmap` payload.
 *
 * Same scope as `flowBlockProblems`: structure, type and length, NOT cross-references. Whether an
 * edge names a block that exists is a question the dashboard answers as it reconciles the two views;
 * a layout that momentarily names a just-deleted block must still autosave rather than 422, or the
 * editor would deadlock on a value only the server could fix.
 */

/** Returns one problem per defect; an empty array means the payload is acceptable. */
export function mindMapProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['must be an object with positions and edges'];

  const problems: string[] = [];
  problems.push(...positionsProblems(value.positions));
  problems.push(...edgesProblems(value.edges));
  return problems;
}

function positionsProblems(positions: unknown): string[] {
  if (!isRecord(positions)) return ['positions must be an object keyed by block id'];

  const problems: string[] = [];
  for (const [id, position] of Object.entries(positions)) {
    if (id === '' || id.length > FLOW_LIMITS.id) {
      problems.push(`positions key must be a non-empty string of at most ${FLOW_LIMITS.id} characters`);
    }
    if (!isRecord(position)) {
      problems.push(`positions[${id}] must be an object with numeric x and y`);
      continue;
    }
    for (const axis of ['x', 'y'] as const) {
      const value = position[axis];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`positions[${id}].${axis} must be a finite number`);
      } else if (Math.abs(value) > MIND_MAP_LIMITS.coordinate) {
        problems.push(`positions[${id}].${axis} must be within ±${MIND_MAP_LIMITS.coordinate}`);
      }
    }
  }
  return problems;
}

function edgesProblems(edges: unknown): string[] {
  if (!Array.isArray(edges)) return ['edges must be an array'];
  if (edges.length > MIND_MAP_LIMITS.edges) return [`edges must hold at most ${MIND_MAP_LIMITS.edges} connections`];

  const problems: string[] = [];
  const seenIds = new Set<string>();

  edges.forEach((edge, index) => {
    const at = (field: string): string => `edges[${index}].${field}`;
    if (!isRecord(edge)) {
      problems.push(`edges[${index}] must be an object`);
      return;
    }

    problems.push(...idProblem(edge.id, at('id'), MIND_MAP_LIMITS.edgeId, seenIds));
    problems.push(...endpointProblem(edge.from, at('from')));
    problems.push(...endpointProblem(edge.to, at('to')));

    if (typeof edge.from === 'string' && edge.from === edge.to) {
      problems.push(`${at('to')} must differ from from (a block cannot connect to itself)`);
    }
  });

  return problems;
}

function idProblem(value: unknown, at: string, max: number, seen: Set<string>): string[] {
  if (typeof value !== 'string' || value === '') return [`${at} must be a non-empty string`];
  if (value.length > max) return [`${at} must be at most ${max} characters`];
  if (seen.has(value)) return [`${at} duplicates an earlier edge`];
  seen.add(value);
  return [];
}

function endpointProblem(value: unknown, at: string): string[] {
  if (typeof value !== 'string' || value === '') return [`${at} must be a non-empty block id`];
  return value.length > FLOW_LIMITS.id ? [`${at} must be at most ${FLOW_LIMITS.id} characters`] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@ValidatorConstraint({ name: 'isMindMap', async: false })
export class IsMindMapConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return mindMapProblems(value).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    const problems = mindMapProblems(args.value);
    return problems.length ? `mindmap is invalid: ${problems.join('; ')}` : 'mindmap must be a layout object';
  }
}

export function IsMindMap(validationOptions?: ValidationOptions): PropertyDecorator {
  return Validate(IsMindMapConstraint, validationOptions as ValidationOptions);
}
