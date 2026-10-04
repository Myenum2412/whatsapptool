import { IsMindMapConstraint, mindMapProblems } from './mind-map-validator';
import { MIND_MAP_LIMITS } from './mind-map-types';
import { FLOW_LIMITS } from './flow-block-types';

const VALID = {
  positions: { b1: { x: 0, y: 0 }, b2: { x: 320, y: 40 } },
  edges: [{ id: 'e1', from: 'b1', to: 'b2' }],
};

describe('mindMapProblems', () => {
  it('accepts a well-formed layout', () => {
    expect(mindMapProblems(VALID)).toEqual([]);
  });

  it('accepts an empty layout', () => {
    expect(mindMapProblems({ positions: {}, edges: [] })).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(mindMapProblems([])).toEqual(['must be an object with positions and edges']);
    expect(mindMapProblems(null)).toEqual(['must be an object with positions and edges']);
  });

  it('requires positions to be an object', () => {
    expect(mindMapProblems({ positions: [], edges: [] })).toEqual(['positions must be an object keyed by block id']);
  });

  it('rejects a non-numeric or non-finite coordinate', () => {
    expect(mindMapProblems({ positions: { b1: { x: '0', y: 0 } }, edges: [] })).toEqual([
      'positions[b1].x must be a finite number',
    ]);
    expect(mindMapProblems({ positions: { b1: { x: 0, y: Number.POSITIVE_INFINITY } }, edges: [] })).toEqual([
      'positions[b1].y must be a finite number',
    ]);
  });

  it('bounds a coordinate to the configured ceiling', () => {
    expect(mindMapProblems({ positions: { b1: { x: MIND_MAP_LIMITS.coordinate + 1, y: 0 } }, edges: [] })).toEqual([
      `positions[b1].x must be within ±${MIND_MAP_LIMITS.coordinate}`,
    ]);
  });

  it('rejects a position that is not an object', () => {
    expect(mindMapProblems({ positions: { b1: 5 }, edges: [] })).toEqual([
      'positions[b1] must be an object with numeric x and y',
    ]);
  });

  it('rejects a position key longer than a block id', () => {
    const key = 'k'.repeat(FLOW_LIMITS.id + 1);
    expect(mindMapProblems({ positions: { [key]: { x: 0, y: 0 } }, edges: [] })).toEqual([
      `positions key must be a non-empty string of at most ${FLOW_LIMITS.id} characters`,
    ]);
  });

  it('requires edges to be an array', () => {
    expect(mindMapProblems({ positions: {}, edges: {} })).toEqual(['edges must be an array']);
  });

  it('caps the edge count', () => {
    const edges = Array.from({ length: MIND_MAP_LIMITS.edges + 1 }, (_, i) => ({
      id: `e${i}`,
      from: 'a',
      to: 'b',
    }));
    expect(mindMapProblems({ positions: {}, edges })).toEqual([
      `edges must hold at most ${MIND_MAP_LIMITS.edges} connections`,
    ]);
  });

  it('rejects a duplicate edge id', () => {
    const problems = mindMapProblems({
      positions: {},
      edges: [
        { id: 'same', from: 'a', to: 'b' },
        { id: 'same', from: 'b', to: 'c' },
      ],
    });
    expect(problems).toContain('edges[1].id duplicates an earlier edge');
  });

  it('rejects a missing endpoint', () => {
    expect(mindMapProblems({ positions: {}, edges: [{ id: 'e1', from: '', to: 'b' }] })).toEqual([
      'edges[0].from must be a non-empty block id',
    ]);
  });

  it('rejects a self-connection', () => {
    expect(mindMapProblems({ positions: {}, edges: [{ id: 'e1', from: 'a', to: 'a' }] })).toEqual([
      'edges[0].to must differ from from (a block cannot connect to itself)',
    ]);
  });

  describe('cross-references are deliberately not checked (the editor reconciles as you type)', () => {
    it('accepts an edge naming a block that does not exist yet', () => {
      expect(
        mindMapProblems({ positions: { ghost: { x: 1, y: 2 } }, edges: [{ id: 'e1', from: 'ghost', to: 'gone' }] }),
      ).toEqual([]);
    });
  });
});

describe('IsMindMapConstraint', () => {
  const constraint = new IsMindMapConstraint();

  it('validates a well-formed layout', () => {
    expect(constraint.validate(VALID)).toBe(true);
  });

  it('rejects a malformed layout', () => {
    expect(constraint.validate({ positions: { b1: { x: 'nope', y: 0 } }, edges: [] })).toBe(false);
  });

  it('surfaces the concrete problems in the validation message', () => {
    const message = constraint.defaultMessage({ value: { positions: {}, edges: 'x' } } as never);
    expect(message).toContain('edges must be an array');
  });

  it('falls back to a shape message when the value reports no problems', () => {
    expect(constraint.defaultMessage({ value: VALID } as never)).toBe('mindmap must be a layout object');
  });
});
