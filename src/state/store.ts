import type { CheckReport, Scene, SceneDraft, Solution, Vec2 } from '../model/types';
import type { SnapSettings } from '../model/snap';

export type ToolId = 'select' | 'pan' | 'block' | 'projectile' | 'horizontal' | 'incline' | 'velocity' | 'measure';
export type Camera = { scale: number; ox: number; oy: number };

export type SolveSlot = {
  status: 'none' | 'stale' | 'ready';
  solution: Solution | null;
  report: CheckReport | null;
  forRev: number;
};

export type Store = {
  past: Scene[];
  present: Scene;
  future: Scene[];
  gestureBase: Scene | null;
  tool: ToolId;
  selection: string | null;
  camera: Camera;
  snap: SnapSettings;
  measure: { a: Vec2 | null; b: Vec2 | null };
  playback: { mode: 'idle' | 'playing' | 'paused'; t: number };
  preview: SolveSlot;
  formal: SolveSlot;
  draft: SceneDraft | null;
  confirmDelete: string | null;
};

const emptySlot = (): SolveSlot => ({ status: 'none', solution: null, report: null, forRev: -1 });

export function initStore(scene: Scene, camera?: Camera, snap?: SnapSettings): Store {
  return {
    past: [], present: scene, future: [], gestureBase: null,
    tool: 'select', selection: null,
    camera: camera ?? { scale: 46, ox: 90, oy: 380 },
    snap: snap ?? { enabled: true, step: 0.5 },
    measure: { a: null, b: null },
    playback: { mode: 'idle', t: 0 },
    preview: emptySlot(), formal: emptySlot(), draft: null,
    confirmDelete: null,
  };
}

export type Action =
  | { type: 'tool'; tool: ToolId }
  | { type: 'select'; id: string | null }
  | { type: 'camera'; camera: Camera }
  | { type: 'snap'; snap: SnapSettings }
  | { type: 'measure'; point: Vec2 | null }
  | { type: 'beginGesture' }
  | { type: 'transient'; scene: Scene }
  | { type: 'endGesture' }
  | { type: 'apply'; scene: Scene }
  | { type: 'load'; scene: Scene }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'previewResult'; result: { solution: Solution | null; report: CheckReport | null }; rev: number }
  | { type: 'formalResult'; result: { solution: Solution | null; report: CheckReport | null }; rev: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'tick'; t: number; tEnd: number }
  | { type: 'scrub'; t: number }
  | { type: 'resetPlayback' }
  | { type: 'setDraft'; draft: SceneDraft | null }
  | { type: 'confirmDelete'; id: string | null };

function physicsChanged(state: Store, scene: Scene): Store {
  return {
    ...state,
    present: scene,
    playback: { mode: 'idle', t: 0 },
    formal: state.formal.status === 'none' ? state.formal : { ...state.formal, status: 'stale' },
  };
}

function commit(state: Store, scene: Scene): Store {
  return { ...physicsChanged(state, scene), past: [...state.past.slice(-99), state.present], future: [] };
}

export function reducer(state: Store, action: Action): Store {
  switch (action.type) {
    case 'tool':
      return { ...state, tool: action.tool, measure: action.tool === 'measure' ? state.measure : { a: null, b: null } };
    case 'select':
      return { ...state, selection: action.id };
    case 'camera':
      return { ...state, camera: action.camera };
    case 'snap':
      return { ...state, snap: action.snap };
    case 'measure': {
      if (!action.point) return { ...state, measure: { a: null, b: null } };
      const { a, b } = state.measure;
      if (!a || (a && b)) return { ...state, measure: { a: action.point, b: null } };
      return { ...state, measure: { a, b: action.point } };
    }
    case 'beginGesture':
      return { ...state, gestureBase: state.present };
    case 'transient':
      return physicsChanged(state, action.scene);
    case 'endGesture': {
      if (!state.gestureBase) return state;
      const changed = state.gestureBase !== state.present;
      return {
        ...state,
        gestureBase: null,
        past: changed ? [...state.past.slice(-99), state.gestureBase] : state.past,
        future: changed ? [] : state.future,
      };
    }
    case 'apply':
      return commit(state, action.scene);
    case 'load':
      return { ...physicsChanged(state, action.scene), past: [], future: [], gestureBase: null, selection: null };
    case 'undo': {
      if (!state.past.length) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ...physicsChanged(state, previous),
        past: state.past.slice(0, -1),
        future: [state.present, ...state.future],
        gestureBase: null,
      };
    }
    case 'redo': {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return {
        ...physicsChanged(state, next),
        past: [...state.past, state.present],
        future: rest,
        gestureBase: null,
      };
    }
    case 'previewResult':
      if (action.rev !== state.present.rev) return state;
      return {
        ...state,
        preview: { status: action.result.solution ? 'ready' : action.result.report ? 'stale' : 'none', solution: action.result.solution, report: action.result.report, forRev: action.rev },
      };
    case 'formalResult':
      return {
        ...state,
        formal: { status: action.result.solution ? 'ready' : 'stale', solution: action.result.solution, report: action.result.report, forRev: action.rev },
      };
    case 'play':
      return { ...state, playback: { ...state.playback, mode: 'playing' } };
    case 'pause':
      return { ...state, playback: { ...state.playback, mode: 'paused' } };
    case 'tick': {
      const t = Math.min(action.t, action.tEnd);
      return { ...state, playback: { t, mode: t >= action.tEnd ? 'paused' : 'playing' } };
    }
    case 'scrub':
      return { ...state, playback: { ...state.playback, t: action.t } };
    case 'resetPlayback':
      return { ...state, playback: { mode: 'idle', t: 0 } };
    case 'setDraft':
      return { ...state, draft: action.draft };
    case 'confirmDelete':
      return { ...state, confirmDelete: action.id };
    default:
      return state;
  }
}

/** 动画与曲线只读这里：优先实时预览，其次正式结果，绝不各自重算 */
export function activeSolution(state: Store): Solution | null {
  if (state.preview.solution && state.preview.forRev === state.present.rev) return state.preview.solution;
  if (state.formal.solution && state.formal.forRev === state.present.rev) return state.formal.solution;
  return null;
}
