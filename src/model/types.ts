export type Vec2 = { x: number; y: number };
export type Vec3 = Vec2 & { z: number };
export type SpatialVector = Vec2 & { z?: number };
/** null = 未知/未赋值。未知量保留为空，绝不默认成 0。 */
export type Num = number | null;

export type UnitKind = 'length' | 'time' | 'speed' | 'accel' | 'mass' | 'angle' | 'charge' | 'electric' | 'magnetic' | 'voltage'
  | 'gravity_gradient' | 'electric_gradient' | 'magnetic_gradient' | 'none';

export type Body = {
  id: string;
  kind: 'block' | 'ball' | 'projectile' | 'boat' | 'circular';
  name: string;
  /** 依附于支撑面时，位置用沿面弧长 s（自 a 端指向 b 端，米）表示 */
  attach: { support: string; s: Num } | null;
  /** block/projectile/boat 为物体位置；circular 为圆心 */
  pos: { x: Num; y: Num; z?: Num };
  /** boat 表示船相对水的速度；circular 不使用（由 omega/radius 推导） */
  vel: { x: Num; y: Num; z?: Num };
  mass: Num;
  charge?: Num;
  /** Missing in older scenes: infer from the charge value. Off preserves the input for later editing. */
  charged?: boolean;
  /** Physical radius used by the two-ball collision model, in metres. */
  collisionRadius?: Num;
  /** 仅"匀变速直线"模板使用：外加已知加速度（沿 x）。null 表示由受力决定 */
  accel: Num;
  /** 小船渡河：水流速度（米/秒） */
  flow?: { x: Num; y: Num };
  /** 小船渡河：河宽（沿 y 方向的渡河距离，米） */
  width?: Num;
  /** 匀速圆周运动：半径（米） */
  radius?: Num;
  /** 匀速圆周运动：角速度（弧度/秒，逆时针为正） */
  omega?: Num;
  /** 匀速圆周运动：初始相位（弧度，自 +x 轴逆时针） */
  phase?: Num;
};

export type FieldKind = 'uniform_gravity' | 'uniform_electric' | 'uniform_magnetic' | 'point_mass' | 'point_charge';
export type FieldShape =
  | { kind: 'global' }
  | { kind: 'rect'; center: Vec2; width: number; height: number }
  | { kind: 'circle'; center: Vec2; radius: number }
  | { kind: 'polygon'; vertices: Vec2[] };
export type Field = {
  id: string;
  name: string;
  kind: FieldKind;
  enabled: boolean;
  shape: FieldShape;
  position: SpatialVector;
  vector: SpatialVector;
  /** For a rectangular electric field: U = V(negative axis edge) - V(positive axis edge). */
  plates?: { axis: 'x' | 'y'; voltage: Num } | null;
  /** Linear spatial slopes measured from position. For g/E each component varies only along its own axis. */
  gradient?: { x: Num; y: Num; z?: Num } | null;
  bx?: number;
  by?: number;
  bz: number;
  sourceStrength: number;
  cutoffRadius: number;
};
export type Link = { id: string; name: string; kind: 'rope' | 'rod'; anchor: Vec2; bodyId: string | null; length: number };
export type FieldPlayback = {
  duration: number;
  exit: 'continue' | 'field' | 'union';
  fieldId: string | null;
  afterExit: number;
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
  | 'friction_state'
  | 'energy_at'
  | 'work_between'
  | 'field_exit'
  | 'field_entry'
  | 'collision';

export type EnergyEvent = 'initial' | 'apex' | 'landing' | 'end_of_support' | 'final_rest' | 'field_exit' | 'collision';
export type EnergyPoint = { kind: 'time'; t: Num } | { kind: 'event'; event: EnergyEvent };

export type Ask = {
  id: string;
  kind: AskKind;
  /** 视 kind 使用：at_time→t，at_height→y，at_position→x，at_velocity→v */
  t: Num;
  x: Num;
  y: Num;
  v: Num;
  /** A finite field for field_entry / field_exit. Empty exit uses the scene's exit strategy. */
  fieldId?: string | null;
  /** energy_at 使用 energyFrom；work_between 使用两端。 */
  energyFrom?: EnergyPoint;
  energyTo?: EnergyPoint;
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
  /** Older scenes are two dimensional. Three dimensional scenes use explicit placed fields. */
  dimension?: '2d' | '3d';
  rev: number;
  title: string;
  gravity: Num;
  bodies: Body[];
  supports: Support[];
  contacts: Contact[];
  fields?: Field[];
  links?: Link[];
  fieldPlayback?: FieldPlayback;
  collision?: { restitution: Num; afterCollision: Num };
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

export type Sample = { t: number; x: number; y: number; z?: number; vx: number; vy: number; vz?: number; s: number; u?: number; ax?: number; ay?: number; az?: number; fieldIds?: string[] };

export type Stage = {
  label: string;
  t0: number;
  t1: number;
  note?: string;
};

/** 能量与做功均以焦耳表示；null 表示模型无法确定。 */
export type EnergySample = { t: number; kinetic: number; potential: Num; mechanical: Num; dissipated: Num };
export type EnergyWork = {
  gravity: number;
  electric?: number;
  magnetic?: number;
  friction: Num;
  net: number;
  dissipated: Num;
  kineticChange: number;
  mechanicalChange: Num;
  balance: 'verified' | 'mismatch' | 'geometry_gap';
};
export type EnergyAnalysis =
  | { status: 'mass_required'; note: string }
  | {
      status: 'ready';
      samples: EnergySample[];
      evalAt: (t: number) => EnergySample | null;
      workBetween: (from: number, to: number) => EnergyWork | null;
      note?: string;
    };

export type Solution = {
  template: 'kinematics-1d' | 'projectile' | 'incline-friction' | 'composition' | 'circular' | 'field' | 'field-3d' | 'collision';
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
  bodyTracks?: Array<{ bodyId: string; name: string; samples: Sample[]; evalAt: (t: number) => Sample }>;
  events: Array<{ kind: string; t: number; label: string; fieldIds?: string[] }>;
  energy?: EnergyAnalysis;
  notice?: string;
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
