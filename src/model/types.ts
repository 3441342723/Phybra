export type Vec2 = { x: number; y: number };
/** null = 未知/未赋值。未知量保留为空，绝不默认成 0。 */
export type Num = number | null;

export type UnitKind = 'length' | 'time' | 'speed' | 'accel' | 'mass' | 'angle' | 'none';

export type Body = {
  id: string;
  kind: 'block' | 'projectile';
  name: string;
  /** 依附于支撑面时，位置用沿面弧长 s（自 a 端指向 b 端，米）表示 */
  attach: { support: string; s: Num } | null;
  pos: { x: Num; y: Num };
  vel: { x: Num; y: Num };
  mass: Num;
  /** 仅"匀变速直线"模板使用：外加已知加速度（沿 x）。null 表示由受力决定 */
  accel: Num;
};

export type Support = {
  id: string;
  name: string;
  kind: 'horizontal' | 'incline';
  /** a 为低端/左端，b 为另一端；angleDeg 为 a→b 与 +x 的夹角 */
  a: Vec2;
  length: Num;
  angleDeg: Num;
};

export type Contact = {
  id: string;
  body: string;
  support: string;
  mu_s: Num;
  mu_k: Num;
};

export type AskKind =
  | 'at_time'
  | 'at_height'
  | 'at_position'
  | 'at_velocity'
  | 'landing'
  | 'apex'
  | 'rest'
  | 'end_of_support'
  | 'friction_state';

export type Ask = {
  id: string;
  kind: AskKind;
  /** 视 kind 使用：at_time→t，at_height→y，at_position→x，at_velocity→v */
  t: Num;
  x: Num;
  y: Num;
  v: Num;
};

export type Param = {
  name: string;
  value: Num;
  unit: UnitKind;
  min: number;
  max: number;
  step: number;
  note?: string;
};

export type Scene = {
  version: 2;
  rev: number;
  title: string;
  gravity: Num;
  bodies: Body[];
  supports: Support[];
  contacts: Contact[];
  asks: Ask[];
  params: Param[];
  /** 对象属性路径 → 参数名，如 "supports.s1.angleDeg": "theta" */
  bindings: Record<string, string>;
};

export type Flag = 'insufficient' | 'conflict' | 'multi' | 'out_of_scope';

export type CheckIssue = {
  code: 'unit_invalid' | 'missing_required' | 'unsupported_combo' | 'constraint_conflict';
  path: string;
  message: string;
};

export type CheckReport = {
  blockers: CheckIssue[];
  pending: Array<{ path: string; label: string }>;
};

export type Answer = {
  id: string;
  label: string;
  value: Num;
  unit: string;
  /** 文字型结论（如摩擦状态） */
  text?: string;
  /** 多解时的其余解 */
  others?: Array<{ value: number; unit: string }>;
  note?: string;
};

export type DerivationStep = {
  title: string;
  formula: string;
  substitution?: string;
  note?: string;
};

export type Sample = { t: number; x: number; y: number; vx: number; vy: number; s: number; u?: number };

export type Stage = {
  label: string;
  t0: number;
  t1: number;
  note?: string;
};

export type Solution = {
  template: 'kinematics-1d' | 'projectile' | 'incline-friction';
  sceneRev: number;
  tEnd: number;
  stages: Stage[];
  answers: Answer[];
  steps: DerivationStep[];
  formulas: Array<{ label: string; latex: string }>;
  samples: Sample[];
  flags: Flag[];
  /** 解析求值：动画与曲线共用，禁止各自重算 */
  evalAt: (t: number) => Sample;
  events: Array<{ kind: string; t: number; label: string }>;
};

export type SolveResult =
  | { ok: true; solution: Solution }
  | { ok: false; report: CheckReport; flags: Flag[] };

export type DraftItem = { path: string; label: string; value: string; quote?: string; basis?: string };

export type SceneDraft = {
  source: { rawText?: string; imageName?: string; demo?: boolean };
  scene: Scene;
  known: DraftItem[];
  assumed: DraftItem[];
  unknown: Array<{ path: string; label: string }>;
  uncertain: string[];
  warnings: string[];
};
