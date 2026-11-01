import type { StackCommandKey, StackProfile } from "../stack/profile";

interface EvalCriterionBase {
  readonly id: string;
  readonly description?: string;
  readonly weight: number;
}

export type EvalCriterion =
  | (EvalCriterionBase & {
      readonly type: "file_exists";
      readonly path: string;
    })
  | (EvalCriterionBase & {
      readonly type: "regex";
      readonly path: string;
      readonly pattern: string;
      readonly flags: string;
    })
  | (EvalCriterionBase & {
      readonly type: "stack_command";
      readonly key: StackCommandKey;
      readonly expectedExitCode: number;
      readonly timeoutMs: number;
    });

export interface EvalTask {
  readonly name: string;
  readonly directory: string;
  readonly fixtureDirectory: string;
  readonly taskText: string;
  readonly criteria: readonly EvalCriterion[];
}

export interface EvalCriteriaFile {
  readonly version: 1;
  readonly criteria: readonly EvalCriterion[];
}

export interface EvalModelPreset {
  readonly name: string;
  readonly hostModel?: string;
  readonly models?: Record<string, unknown>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CriterionResult {
  readonly id: string;
  readonly type: EvalCriterion["type"];
  readonly passed: boolean;
  readonly weight: number;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface EvalStackContext {
  readonly profile?: StackProfile;
  readonly projectDirectory: string;
}
